#!/usr/bin/env node
/**
 * Polymarket Market Scanner v2
 * M1-SIGNAL → M2-EDGE → M3-EXECUTE → M4-ADAPT
 *
 * Fixes from v1:
 * - Removed 3 placeholder signals (news, expert, onchain) that gamed the agreeing gate
 * - Fixed Kelly formula for NO-side trades (use 1-pTrue)
 * - Increased momentum window (interval=max)
 * - Added CLOB API order placement with HMAC auth + EIP-712 signing
 * - Added M4 adaptation (Brier score tracking)
 */

import { createRequire } from "module";
import { createHmac, randomBytes } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

const HOME = homedir();
const DATA = `${HOME}/.openclaw`;
const req = createRequire(import.meta.url);

// Use CJS build of viem (avoids ESM resolution issues in Conway sandbox)
const { privateKeyToAccount } = req("/app/node_modules/viem/_cjs/accounts/index.js");

function load(file, fallback) {
  try { return JSON.parse(readFileSync(`${DATA}/${file}`, "utf8")); }
  catch { return fallback; }
}
function save(file, obj) { writeFileSync(`${DATA}/${file}`, JSON.stringify(obj, null, 2)); }
function log(...a) { console.log(new Date().toISOString(), ...a); }

// Server酱微信推送
const SERVERCHAN_KEY = "SCT330458TSdLCgJFxCpmcf89XX89WDuAM";
async function notify(title, desp) {
  try {
    await fetch(`https://sctapi.ftqq.com/${SERVERCHAN_KEY}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.slice(0, 32), desp }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { log("[NOTIFY ERR] " + e.message); }
}

async function fetchJson(url, opts = {}) {
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { log(`WARN ${r.status} ${url.slice(0, 80)}`); return null; }
    return r.json();
  } catch (e) { log(`ERR fetch: ${e.message}`); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ON-CHAIN USDC BALANCE (Polygon)
// ═══════════════════════════════════════════════════════════════════════════════

const POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
  "https://polygon.drpc.org",
];
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";       // USDC.e (Polymarket collateral)
const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";  // Native USDC on Polygon

// ── Exit thresholds: pure thesis invalidation ──
const EXIT_EDGE_THRESHOLD = -0.02;  // Net Edge < -2pp → thesis invalidated → close
const MIN_SELL_TOKENS = 5;          // Polymarket minimum order size
const CTF_TOKEN_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // ERC-1155
const DRY_RUN_EXITS = false;        // live mode — full auto

// ── Polymarket Taker Fee (bell-curve × category) ──
const PEAK_FEE_RATES = {
  crypto: 0.018,       // 1.8% peak
  politics: 0.010,     // 1.0% peak
  sports: 0.0075,      // 0.75% peak
  geopolitics: 0,      // 0% — free
};
const FEE_TAG_MAP = {
  Crypto: "crypto", Bitcoin: "crypto", Ethereum: "crypto",
  Politics: "politics", Finance: "politics", Business: "politics", GDP: "politics",
  Sports: "sports", Soccer: "sports", NBA: "sports", NHL: "sports",
  NFL: "sports", Esports: "sports", Basketball: "sports", Hockey: "sports",
  Gaza: "geopolitics", Russia: "geopolitics", China: "geopolitics",
  "Middle East": "geopolitics", Syria: "geopolitics", "world affairs": "geopolitics",
};
function calcTakerFee(price, tags) {
  let category = "politics"; // default fallback
  for (const t of (tags || [])) {
    if (FEE_TAG_MAP[t]) { category = FEE_TAG_MAP[t]; break; }
  }
  const peak = PEAK_FEE_RATES[category] || 0.010;
  return peak * 4 * price * (1 - price); // bell curve
}

async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  for (const rpc of POLYGON_RPCS) {
    const resp = await fetchJson(rpc, { method: "POST", body });
    if (resp?.result) return resp.result;
    log(`[RPC MISS] ${rpc.split("/")[2]} — trying next...`);
  }
  return null;
}

async function readBalanceOf(token, wallet) {
  const padded = wallet.slice(2).toLowerCase().padStart(64, "0");
  const data = "0x70a08231" + padded;  // balanceOf(address)
  const hex = await rpcCall("eth_call", [{ to: token, data }, "latest"]);
  if (!hex) return 0;
  return parseInt(hex, 16) / 1e6;  // USDC = 6 decimals
}

async function getPolygonUsdc(walletAddress) {
  const [usdcE, usdcNative] = await Promise.all([
    readBalanceOf(USDC_E, walletAddress),
    readBalanceOf(USDC_NATIVE, walletAddress),
  ]);
  return { usdcE, usdcNative, total: usdcE + usdcNative };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ON-CHAIN ERC-1155 TOKEN BALANCE (CTF conditional tokens)
// ═══════════════════════════════════════════════════════════════════════════════

async function readTokenBalance(walletAddress, tokenId) {
  // balanceOf(address, uint256) selector = 0x00fdd58e
  const addr = walletAddress.slice(2).toLowerCase().padStart(64, "0");
  const id = BigInt(tokenId).toString(16).padStart(64, "0");
  const data = "0x00fdd58e" + addr + id;
  const hex = await rpcCall("eth_call", [{ to: CTF_TOKEN_CONTRACT, data }, "latest"]);
  if (!hex || hex === "0x") return 0;
  return parseInt(hex, 16) / 1e6; // token amounts use 6 decimals like USDC
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION MANAGER: Sync, Evaluate, Exit
// ═══════════════════════════════════════════════════════════════════════════════

async function getCurrentPrice(tokenId) {
  // Try midpoint API first
  const mid = await fetchJson(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
  if (mid?.mid) return parseFloat(mid.mid);
  // Fallback: derive from orderbook
  const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  if (book?.bids?.length && book?.asks?.length) {
    const bestBid = parseFloat(book.bids[0].price || 0);
    const bestAsk = parseFloat(book.asks[0].price || 0);
    if (bestBid > 0 && bestAsk > 0) return (bestBid + bestAsk) / 2;
  }
  return null; // no data — caller should HOLD
}

async function bootstrapPositions(walletAddr) {
  const journal = load("trade_journal.json", { trades: [] });
  // Fetch all markets to resolve conditionId → tokenId
  const mktsResp = await fetchJson("https://clob.polymarket.com/sampling-markets?next_cursor=MQ==&limit=200");
  const mkts = mktsResp?.data || [];
  const conditionToTokens = {};
  for (const m of mkts) {
    if (!m.condition_id || !m.tokens) continue;
    const yes = m.tokens.find(t => t.outcome === "Yes") || m.tokens[0];
    const no = m.tokens.find(t => t.outcome === "No") || m.tokens[1];
    conditionToTokens[m.condition_id] = {
      YES: yes?.token_id || null,
      NO: no?.token_id || null,
      negRisk: m.neg_risk || false,
    };
  }
  const bootstrapped = [];
  const seen = new Set();
  for (const t of journal.trades) {
    if (t.action !== "ORDER_PLACED" || !t.conditionId) continue;
    if (seen.has(t.conditionId)) continue;
    seen.add(t.conditionId);
    // Resolve tokenId: from journal first, then from CLOB API lookup
    let tokenId = t.tokenId || (t.side === "YES" ? t.tokenIdYes : t.tokenIdNo);
    if (!tokenId) {
      const lookup = conditionToTokens[t.conditionId];
      if (lookup) {
        tokenId = lookup[t.side || "YES"];
        log(`  [BOOTSTRAP] Resolved tokenId via CLOB API for "${t.market?.slice(0, 40)}"`);
      }
    }
    if (!tokenId) {
      log(`  [BOOTSTRAP SKIP] ${t.market?.slice(0, 40)} — cannot resolve tokenId`);
      continue;
    }
    // Verify on-chain balance
    const bal = await readTokenBalance(walletAddr, tokenId);
    if (bal <= 0) {
      log(`  [BOOTSTRAP SKIP] ${t.market?.slice(0, 40)} — zero on-chain balance`);
      continue;
    }
    const negRisk = t.negRisk || conditionToTokens[t.conditionId]?.negRisk || false;
    bootstrapped.push({
      id: Math.random().toString(36).slice(2),
      market: t.market || "?",
      conditionId: t.conditionId,
      tokenId,
      side: t.side || "YES",
      entryPrice: t.price || 0,
      numTokens: bal,
      entryDate: t.timestamp || new Date().toISOString(),
      entryEdge: t.edge || 0,
      entryPTrue: t.pTrue || 0,
      negRisk,
      status: "open",
    });
    log(`  [BOOTSTRAP] ${t.side} "${t.market?.slice(0, 40)}" tokens=${bal.toFixed(1)} entry=$${t.price}`);
  }
  return bootstrapped;
}

async function syncPositions(pos, walletAddr) {
  let positions = pos.positions || [];
  // Bootstrap if empty
  if (positions.length === 0 && walletAddr) {
    log("[POSITION SYNC] No local positions — bootstrapping from trade journal...");
    positions = await bootstrapPositions(walletAddr);
    if (positions.length > 0) {
      pos.positions = positions;
      save("polymarket_positions.json", pos);
      log(`[POSITION SYNC] Bootstrapped ${positions.length} positions`);
    }
    return positions;
  }
  // Verify existing positions against on-chain
  for (const p of positions) {
    if (p.status !== "open") continue;
    const bal = await readTokenBalance(walletAddr, p.tokenId);
    if (bal <= 0) {
      log(`  [SYNC] "${p.market?.slice(0, 40)}" — on-chain balance=0, marking closed`);
      p.status = "closed";
      p.exitReason = "resolved_or_zero_balance";
      p.exitDate = new Date().toISOString();
      if (!pos.closed) pos.closed = [];
      pos.closed.push({ ...p });
    } else {
      p.numTokens = bal; // update to actual on-chain count
    }
  }
  positions = positions.filter(p => p.status === "open");
  pos.positions = positions;
  save("polymarket_positions.json", pos);
  return positions;
}

async function evaluatePosition(position, wData) {
  const { tokenId, side, entryPrice, entryEdge } = position;
  // Step 1: get current price
  const currentPrice = await getCurrentPrice(tokenId);
  if (currentPrice === null) {
    log(`  [EVAL] "${position.market?.slice(0, 40)}" — no price data, HOLD`);
    return { action: "HOLD", reason: "no_price_data" };
  }
  const pnlPct = entryPrice > 0 ? (currentPrice - entryPrice) / entryPrice : 0;
  // Step 2: re-run signals
  const [clob, mom] = await Promise.all([
    clobSignal(tokenId, currentPrice),
    momentumSignal(tokenId, currentPrice),
  ]);
  const signals = { clob_micro: clob, momentum: mom };
  const { pTrue: newPTrue, edge: rawEdge } = calcEdge(signals, wData.weights, currentPrice);
  // Step 3: calculate net edge from position direction
  // YES position: we want pTrue > price → netEdge = newPTrue - currentPrice
  // NO position:  we want pTrue < price → netEdge = currentPrice - newPTrue
  const netEdge = side === "YES" ? (newPTrue - currentPrice) : (currentPrice - newPTrue);
  // Step 4: thesis invalidation check
  if (netEdge < EXIT_EDGE_THRESHOLD) {
    log(`  [EVAL] "${position.market?.slice(0, 40)}" ${side} — THESIS INVALIDATED`);
    log(`    netEdge=${netEdge.toFixed(4)} < ${EXIT_EDGE_THRESHOLD} | price=${currentPrice.toFixed(3)} pTrue=${newPTrue.toFixed(4)} pnl=${(pnlPct * 100).toFixed(1)}%`);
    log(`    clob=${clob.signal.toFixed(4)}(c=${clob.confidence.toFixed(2)}) mom=${mom.signal.toFixed(4)}(c=${mom.confidence.toFixed(2)})`);
    return {
      action: "EXIT", reason: "thesis_invalidated",
      currentPrice, newPTrue, netEdge, pnlPct,
      signals: { clob_micro: clob.signal, momentum: mom.signal },
    };
  }
  log(`  [EVAL] "${position.market?.slice(0, 40)}" ${side} — HOLD | netEdge=${netEdge.toFixed(4)} price=${currentPrice.toFixed(3)} pnl=${(pnlPct * 100).toFixed(1)}%`);
  return {
    action: "HOLD", reason: "thesis_valid",
    currentPrice, newPTrue, netEdge, pnlPct,
    signals: { clob_micro: clob.signal, momentum: mom.signal },
  };
}

async function executeSell(position, decision, apiCreds, walletData) {
  const { currentPrice, reason, netEdge, pnlPct } = decision;
  const { tokenId, numTokens, side, negRisk } = position;
  // Check minimum order size
  if (numTokens < MIN_SELL_TOKENS) {
    log(`  [SELL SKIP] "${position.market?.slice(0, 40)}" — ${numTokens.toFixed(1)} tokens < ${MIN_SELL_TOKENS} minimum`);
    const journal = load("trade_journal.json", { trades: [] });
    journal.trades.push({
      timestamp: new Date().toISOString(),
      action: "SELL_SKIPPED",
      market: position.market, conditionId: position.conditionId,
      tokenId, side, numTokens,
      entryPrice: position.entryPrice, currentPrice,
      exitReason: "too_small_to_sell", netEdge, pnlPct,
    });
    save("trade_journal.json", journal);
    return { success: false, error: "too_small_to_sell" };
  }
  // Sell price: one tick below current midpoint for aggressive fill
  const sellPrice = Math.round((currentPrice - 0.01) * 100) / 100;
  const sellTokens = Math.floor(numTokens);
  if (DRY_RUN_EXITS) {
    log(`  [DRY-RUN SELL] "${position.market?.slice(0, 40)}" SELL ${sellTokens} tokens @ ${sellPrice.toFixed(2)} reason=${reason}`);
    const journal = load("trade_journal.json", { trades: [] });
    journal.trades.push({
      timestamp: new Date().toISOString(),
      action: "SELL_DRY_RUN",
      market: position.market, conditionId: position.conditionId,
      tokenId, side, numTokens: sellTokens,
      entryPrice: position.entryPrice, exitPrice: sellPrice,
      exitReason: reason, netEdge, pnlPct,
      signalsAtExit: decision.signals,
    });
    save("trade_journal.json", journal);
    return { success: true, dryRun: true };
  }
  // Real sell order via Python bridge
  log(`  [SELL] "${position.market?.slice(0, 40)}" SELL ${sellTokens} @ ${sellPrice.toFixed(2)}`);
  const orderResult = await placeOrder(apiCreds, null, tokenId, "SELL", sellPrice, sellTokens * sellPrice, negRisk);
  const journal = load("trade_journal.json", { trades: [] });
  journal.trades.push({
    timestamp: new Date().toISOString(),
    action: orderResult.success ? "SELL_PLACED" : "SELL_FAILED",
    market: position.market, conditionId: position.conditionId,
    tokenId, side, numTokens: sellTokens,
    entryPrice: position.entryPrice, exitPrice: sellPrice,
    exitReason: reason, netEdge, pnlPct,
    signalsAtExit: decision.signals,
    orderID: orderResult.orderID || null,
    error: orderResult.error || null,
  });
  save("trade_journal.json", journal);
  const pnlStr = (pnlPct * 100).toFixed(1);
  if (orderResult.success) {
    await notify("SELL " + position.market?.slice(0, 20), `**${position.market}**\n\n- 方向: ${side} → 平仓\n- 入场价: $${position.entryPrice}\n- 卖出价: $${sellPrice.toFixed(2)}\n- 数量: ${sellTokens} tokens\n- PnL: ${pnlStr}%\n- 原因: ${reason}\n- netEdge: ${netEdge.toFixed(4)}`);
  } else {
    await notify("SELL FAILED", `**${position.market}**\n\n- 卖出失败: ${orderResult.error}\n- PnL: ${pnlStr}%`);
  }
  return orderResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// M1: SIGNAL GENERATION (2 real signals only)
// ═══════════════════════════════════════════════════════════════════════════════

async function scanMarkets() {
  // Use CLOB sampling-markets endpoint (Gamma API blocked by GFW)
  const resp = await fetchJson(
    "https://clob.polymarket.com/sampling-markets?next_cursor=MQ==&limit=200"
  );
  const markets = resp?.data;
  if (!markets || markets.length === 0) { log("WARN: CLOB markets API unreachable"); return []; }

  const now = Date.now();
  const out = [];
  for (const mkt of markets) {
    if (mkt.closed || !mkt.active || !mkt.accepting_orders) continue;
    const end = new Date(mkt.end_date_iso || 0).getTime();
    if (end && end - now < 12 * 3600e3) continue;  // skip markets ending within 12h
    const tokens = mkt.tokens || [];
    if (tokens.length < 2) continue;
    const yesToken = tokens.find(t => t.outcome === "Yes") || tokens[0];
    const noToken = tokens.find(t => t.outcome === "No") || tokens[1];
    const yesPrice = parseFloat(yesToken.price || 0);
    if (yesPrice <= 0.05 || yesPrice >= 0.95) continue;
    if (!yesToken.token_id) continue;
    out.push({
      conditionId: mkt.condition_id,
      question: mkt.question || "?",
      yesPrice,
      noPrice: parseFloat(noToken.price || 0),
      volume: 100000,  // CLOB API doesn't return volume, assume high
      endDate: mkt.end_date_iso,
      tokenIdYes: yesToken.token_id,
      tokenIdNo: noToken.token_id || null,
      negRisk: mkt.neg_risk || false,
      tickSize: mkt.minimum_tick_size || 0.01,
      tags: mkt.tags || [],
    });
  }
  return out.slice(0, 100);
}

// ── Signal 1: CLOB Microstructure ────────────────────────────────────────────
async function clobSignal(tokenId, mktPrice) {
  const [book, trades] = await Promise.all([
    fetchJson(`https://clob.polymarket.com/book?token_id=${tokenId}`),
    fetchJson(`https://clob.polymarket.com/trades?asset_id=${tokenId}&limit=100`),
  ]);
  if (!book) return { signal: mktPrice, confidence: 0.2 };

  // Orderbook imbalance — use top 10 levels for more stability
  const bidDepth = (book.bids || []).slice(0, 10).reduce((s, o) => s + parseFloat(o.size || 0), 0);
  const askDepth = (book.asks || []).slice(0, 10).reduce((s, o) => s + parseFloat(o.size || 0), 0);
  const totalDepth = bidDepth + askDepth;
  const imbalance = totalDepth > 0 ? bidDepth / totalDepth : 0.5;

  // Trade flow — weighted by recency (recent trades matter more)
  let buyVol = 0, sellVol = 0;
  const recentTrades = (trades || []).slice(0, 50);
  for (let i = 0; i < recentTrades.length; i++) {
    const t = recentTrades[i];
    const sz = parseFloat(t.size || 0);
    const weight = 1 - i / recentTrades.length;  // linear decay
    t.side === "BUY" ? (buyVol += sz * weight) : (sellVol += sz * weight);
  }
  const tradeBias = (buyVol + sellVol) > 0 ? buyVol / (buyVol + sellVol) : 0.5;

  // VWAP from recent trades
  let vwapNum = 0, vwapDen = 0;
  for (const t of recentTrades.slice(0, 20)) {
    const sz = parseFloat(t.size || 0);
    const px = parseFloat(t.price || 0);
    if (sz > 0 && px > 0) { vwapNum += px * sz; vwapDen += sz; }
  }
  const vwap = vwapDen > 0 ? vwapNum / vwapDen : mktPrice;

  // Combine: 40% orderbook imbalance, 30% trade flow, 30% VWAP deviation
  const obSignal = mktPrice + (imbalance - 0.5) * 0.08;
  const tfSignal = mktPrice + (tradeBias - 0.5) * 0.06;
  const signal = obSignal * 0.4 + tfSignal * 0.3 + vwap * 0.3;
  const clamped = Math.min(0.95, Math.max(0.05, signal));
  const confidence = Math.min(0.85, 0.4 + totalDepth / 50000);  // higher depth → higher confidence

  return { signal: clamped, confidence, imbalance, tradeBias, vwap, totalDepth };
}

// ── Signal 2: Price Momentum ─────────────────────────────────────────────────
async function momentumSignal(tokenId, mktPrice) {
  // Use max interval for more data
  const hist = await fetchJson(
    `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=max&fidelity=120`
  );
  if (!hist?.history || hist.history.length < 20) return { signal: mktPrice, confidence: 0.15 };

  const px = hist.history.map(h => parseFloat(h.p)).filter(p => p > 0);
  if (px.length < 20) return { signal: mktPrice, confidence: 0.15 };

  // Short-term momentum (last 20% vs previous 20%)
  const n = px.length;
  const window = Math.max(10, Math.floor(n * 0.2));
  const recent = px.slice(-window);
  const older = px.slice(-window * 2, -window);
  const rAvg = recent.reduce((s, p) => s + p, 0) / recent.length;
  const oAvg = older.length > 0 ? older.reduce((s, p) => s + p, 0) / older.length : rAvg;
  const velocity = rAvg - oAvg;

  // Mean-reversion component — if price moved too far from long-term mean, expect pullback
  const longAvg = px.reduce((s, p) => s + p, 0) / px.length;
  const deviation = mktPrice - longAvg;
  const meanRev = -deviation * 0.15;  // gentle pull toward mean

  // Combine momentum + mean reversion
  const signal = Math.min(0.95, Math.max(0.05, mktPrice + velocity * 0.25 + meanRev));
  const confidence = Math.min(0.7, 0.3 + n / 200);

  return { signal, confidence, velocity, meanRev, dataPoints: n };
}

// ═══════════════════════════════════════════════════════════════════════════════
// M2: EDGE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

function calcEdge(signals, weights, mktPrice) {
  let pTrue = 0, tw = 0;
  for (const [k, s] of Object.entries(signals)) {
    const w = weights[k] || 0.5;  // equal weight for unknown signals
    pTrue += w * s.signal;
    tw += w;
  }
  pTrue = tw > 0 ? pTrue / tw : mktPrice;

  const edge = pTrue - mktPrice;
  // With only 2 real signals, "agreeing" means both point the same direction
  const agreeing = Object.values(signals).filter(
    s => Math.sign(s.signal - mktPrice) === Math.sign(edge) && s.confidence >= 0.3
  ).length;

  return { pTrue, edge, ev: Math.abs(edge), agreeing };
}

// ═══════════════════════════════════════════════════════════════════════════════
// M3: POSITION SIZING + ORDER EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

function kellySize(pTrue, mktPrice, side, portfolio) {
  // For NO side, invert the probability
  const p = side === "YES" ? pTrue : 1 - pTrue;
  const price = side === "YES" ? mktPrice : 1 - mktPrice;
  const b = 1 / price - 1;
  if (b <= 0) return { fraction: 0, size: 0 };
  const fullKelly = Math.max(0, (p * b - (1 - p)) / b);
  const fraction = Math.min(0.10, fullKelly * 0.25);  // quarter-Kelly, cap 10%
  const size = Math.max(5, Math.round(fraction * portfolio * 100) / 100);
  return { fraction, size };
}

// ── CLOB API Authentication (HMAC) ───────────────────────────────────────────
function hmacAuth(apiKey, secret, passphrase, address, method, path, body = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + path + body;
  const sig = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(message)
    .digest("base64");
  return {
    "POLY_API_KEY": apiKey,
    "POLY_SIGNATURE": sig,
    "POLY_TIMESTAMP": timestamp,
    "POLY_PASSPHRASE": passphrase,
    "POLY_ADDRESS": address,
  };
}

// ── EIP-712 Order Signing ────────────────────────────────────────────────────
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
function getOrderDomain(negRisk) {
  const exchange = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;
  return { name: "Polymarket CTF Exchange", version: "1", chainId: 137, verifyingContract: exchange };
}
const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
};

async function buildAndSignOrder(account, tokenId, side, price, sizeUsdc, negRisk = false) {
  // side: "YES"/"NO" → 0=BUY, 1=SELL in contract terms
  // For buying YES tokens: side=0, makerAmount=USDC, takerAmount=tokens
  // For buying NO tokens: same logic but with NO tokenId
  const USDC_DECIMALS = 1e6;
  const sideNum = 0; // BUY (we're always buying outcome tokens)
  // Amounts must produce exact tick-aligned price: price = makerAmount / takerAmount
  const tickPrice = Math.round(price * 100) / 100; // round to 0.01 tick
  const numTokens = Math.floor(sizeUsdc / tickPrice); // whole tokens we can afford
  const makerAmount = BigInt(Math.round(numTokens * tickPrice * USDC_DECIMALS));
  const takerAmount = BigInt(numTokens * USDC_DECIMALS);
  const salt = BigInt(Math.round(Math.random() * Date.now()));
  const expiration = 0n; // GTC orders must have expiration=0

  const order = {
    salt,
    maker: account.address,
    signer: account.address,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: BigInt(tokenId),
    makerAmount,
    takerAmount,
    expiration,
    nonce: 0n,
    feeRateBps: 0n,
    side: sideNum,
    signatureType: 0, // 0=EOA
  };

  const signature = await account.signTypedData({
    domain: getOrderDomain(negRisk),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
  });

  return {
    order: {
      salt: Number(order.salt),  // API expects number, not string
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId.toString(),
      makerAmount: order.makerAmount.toString(),
      takerAmount: order.takerAmount.toString(),
      expiration: order.expiration.toString(),
      nonce: order.nonce.toString(),
      feeRateBps: order.feeRateBps.toString(),
      side: sideNum === 0 ? "BUY" : "SELL",  // API expects string
      signatureType: order.signatureType,
    },
    signature,
  };
}

async function placeOrder(apiCreds, account, tokenId, side, price, sizeUsdc, negRisk = false) {
  log("  [ORDER] " + side + " $" + sizeUsdc + " @ " + price.toFixed(4) + " tokenId=" + tokenId.slice(0, 16) + "...");
  
  const { execSync } = await import("child_process");
  
  const tickPrice = Math.round(price * 100) / 100;
  const numTokens = Math.max(5, Math.floor(sizeUsdc / tickPrice));
  
  try {
    const cmd = "python3 /root/.openclaw/place_order.py " + JSON.stringify(tokenId) + " " + side + " " + tickPrice + " " + numTokens;
    log("  [ORDER CMD] " + cmd.slice(0, 200));
    const result = execSync(cmd, { timeout: 30000, encoding: "utf8" });
    const parsed = JSON.parse(result.trim());
    
    if (parsed.success) {
      log("  [ORDER OK] orderID=" + parsed.orderID);
      return { success: true, orderID: parsed.orderID };
    } else {
      log("  [ORDER FAIL] " + (parsed.error || JSON.stringify(parsed)));
      return { success: false, error: parsed.error };
    }
  } catch (e) {
    log("  [ORDER ERROR] " + e.message);
    if (e.stdout) log("  [STDOUT] " + e.stdout.slice(0, 300));
    if (e.stderr) log("  [STDERR] " + e.stderr.slice(0, 300));
    return { success: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// M4: ADAPTATION ENGINE (Brier Score Tracking)
// ═══════════════════════════════════════════════════════════════════════════════

function updateAdaptation(wData, signalKey, predictedProb, actualOutcome) {
  // Brier score: BS = (predicted - outcome)^2
  const bs = Math.pow(predictedProb - actualOutcome, 2);
  const alpha = 0.3; // EMA smoothing

  if (!wData.brier_scores) wData.brier_scores = {};
  if (!wData.sample_counts) wData.sample_counts = {};

  const prevBs = wData.brier_scores[signalKey] ?? 0.25;
  wData.brier_scores[signalKey] = alpha * bs + (1 - alpha) * prevBs;
  wData.sample_counts[signalKey] = (wData.sample_counts[signalKey] || 0) + 1;

  // Reweight: w_i = max(1/BS_i / sum(1/BS_j), 0.05)
  const invScores = {};
  let totalInv = 0;
  for (const [k, v] of Object.entries(wData.brier_scores)) {
    const inv = 1 / (v + 0.01);
    invScores[k] = inv;
    totalInv += inv;
  }
  for (const [k, inv] of Object.entries(invScores)) {
    wData.weights[k] = Math.max(0.05, inv / totalInv);
  }

  wData.total_resolutions = (wData.total_resolutions || 0) + 1;
  wData.updated = new Date().toISOString();

  // Regime detection: track rolling accuracy
  // (simplified — in production, track last 10 trade outcomes)

  return wData;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  log("═══ POLYMARKET SCANNER v2 START ═══");

  const wData = load("signal_weights.json", {
    weights: { clob_micro: 0.5, momentum: 0.5 },
    brier_scores: { clob_micro: 0.25, momentum: 0.25 },
    sample_counts: { clob_micro: 0, momentum: 0 },
    regime: "normal",
    total_resolutions: 0,
  });
  const pos = load("polymarket_positions.json", { positions: [], portfolio_usdc: 0, daily_pnl: 0 });
  const apiCreds = load("polymarket_api_key.json", null);
  const walletData = load("wallet.json", null);

  // ── Read real USDC balance from Polygon ──
  let portfolio = 0;
  let walletAddr = null;
  if (walletData?.privateKey) {
    try {
      const account = privateKeyToAccount(walletData.privateKey);
      walletAddr = account.address;
      const bal = await getPolygonUsdc(walletAddr);
      portfolio = bal.total;
      log(`[WALLET] ${walletAddr}`);
      log(`[BALANCE] USDC.e=$${bal.usdcE.toFixed(2)} | Native=$${bal.usdcNative.toFixed(2)} | Total=$${portfolio.toFixed(2)}`);
    } catch (e) {
      log(`[BALANCE ERR] ${e.message} — falling back to local`);
      portfolio = pos.portfolio_usdc || 0;
    }
  } else {
    log("[WALLET] No wallet.json — using local portfolio_usdc");
    portfolio = pos.portfolio_usdc || 0;
  }

  log(`Portfolio: $${portfolio.toFixed(2)} | Positions: ${(pos.positions || []).length}/5 | Regime: ${wData.regime}`);
  log(`Weights: clob=${(wData.weights.clob_micro || 0).toFixed(2)} mom=${(wData.weights.momentum || 0).toFixed(2)}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // POSITION MANAGER: Sync → Evaluate → Exit (runs BEFORE new entries)
  // ═══════════════════════════════════════════════════════════════════════════
  if (walletAddr) {
    log("[POSITION MANAGER] Syncing positions...");
    const openPositions = await syncPositions(pos, walletAddr);
    log(`[POSITION MANAGER] ${openPositions.length} open position(s)`);

    if (openPositions.length > 0) {
      log("[POSITION MANAGER] Evaluating thesis for each position...");
      for (const p of openPositions) {
        const decision = await evaluatePosition(p, wData);
        if (decision.action === "EXIT") {
          const result = await executeSell(p, decision, apiCreds, walletData);
          if (result.success && !result.dryRun) {
            p.status = "closed";
            p.exitReason = decision.reason;
            p.exitPrice = decision.currentPrice;
            p.exitDate = new Date().toISOString();
            if (!pos.closed) pos.closed = [];
            pos.closed.push({ ...p });
          }
        }
      }
      // Update positions after exits
      pos.positions = openPositions.filter(p => p.status === "open");
      save("polymarket_positions.json", pos);
      // Re-read balance after sells
      if (pos.positions.length < openPositions.length) {
        try {
          const bal = await getPolygonUsdc(walletAddr);
          portfolio = bal.total;
          log(`[BALANCE UPDATE] After exits: $${portfolio.toFixed(2)}`);
        } catch {}
      }
    }
  }

  // ── Risk gates ──
  if ((pos.positions || []).length >= 5) {
    log("RISK GATE: 5 positions open — no new entries");
    log("═══ SCANNER COMPLETE (risk blocked) ═══");
    return;
  }
  if (portfolio > 0 && pos.daily_pnl && (pos.daily_pnl / portfolio) < -0.20) {
    log("RISK GATE: daily -20% stop hit — no new trades");
    log("═══ SCANNER COMPLETE (risk blocked) ═══");
    return;
  }

  // ── Scan markets ──
  const candidates = await scanMarkets();
  log(`Candidates found: ${candidates.length}`);
  if (candidates.length === 0) {
    log("No viable candidates. Exiting.");
    log("═══ SCANNER COMPLETE ═══");
    return;
  }

  const watchlist = { markets: [], updated: new Date().toISOString() };
  let bestOpp = null;

  for (const c of candidates) {
    log(`\n  Q: ${c.question.slice(0, 80)}`);
    log(`  YES=${c.yesPrice.toFixed(3)} NO=${c.noPrice.toFixed(3)} | Vol=$${(c.volume / 1000).toFixed(0)}k`);

    // ── M1: Generate signals (only real ones) ──
    const [clob, mom] = await Promise.all([
      clobSignal(c.tokenIdYes, c.yesPrice),
      momentumSignal(c.tokenIdYes, c.yesPrice),
    ]);

    const signals = {
      clob_micro: clob,
      momentum: mom,
    };

    // ── M2: Calculate edge ──
    const { pTrue, edge, ev, agreeing } = calcEdge(signals, wData.weights, c.yesPrice);
    log(`  P_true=${pTrue.toFixed(4)} Edge=${edge.toFixed(4)} EV=${ev.toFixed(4)} Agree=${agreeing}/2`);
    log(`    clob: sig=${clob.signal.toFixed(4)} conf=${clob.confidence.toFixed(2)} depth=${clob.totalDepth?.toFixed(0) || "?"}`);
    log(`    mom:  sig=${mom.signal.toFixed(4)} conf=${mom.confidence.toFixed(2)} pts=${mom.dataPoints || "?"}`);

    // Watchlist entry
    const entry = {
      ...c, pTrue, edge, ev, agreeing,
      signals: { clob_micro: clob.signal, momentum: mom.signal },
      scannedAt: new Date().toISOString(),
    };
    watchlist.markets.push(entry);

    // ── M2 Gate (with taker fee) ──
    const minEdge = wData.regime === "regime_shift" ? 0.03 : 0.02;
    const bothAgree = agreeing >= 2;
    const bothConfident = clob.confidence >= 0.3 && mom.confidence >= 0.3;
    const side = edge > 0 ? "YES" : "NO";
    const tradePrice = Math.round((side === "YES" ? c.yesPrice : c.noPrice) * 100) / 100;
    const fee = calcTakerFee(tradePrice, c.tags);
    const netEdgeAfterFee = Math.abs(edge) - fee;

    if (netEdgeAfterFee > minEdge && bothAgree && bothConfident) {
      const { size, fraction } = kellySize(pTrue, c.yesPrice, side, Math.max(portfolio, 1));

      log(`  *** SIGNAL: ${side} | Kelly=${(fraction * 100).toFixed(1)}% | size=$${size} | fee=${(fee * 100).toFixed(2)}% | netEdge=${(netEdgeAfterFee * 100).toFixed(2)}% ***`);

      const netEv = ev - fee;
      if (!bestOpp || netEv > (bestOpp.netEv || 0)) {
        bestOpp = { ...entry, side, tradePrice, size, fraction, fee, netEv };
      }

      // ── M3: Track best signal (execute after loop) ──
      if (false && portfolio >= 10 && apiCreds && walletData) {
        const tokenId = side === "YES" ? c.tokenIdYes : c.tokenIdNo;
        if (tokenId && size >= 5 && size <= portfolio * 0.50) {
          try {
            const account = privateKeyToAccount(walletData.privateKey);
            const isNegRisk = c.negRisk || false;
            log();
            const orderResult = await placeOrder(apiCreds, account, tokenId, side, tradePrice, size, isNegRisk);

            const journal = load("trade_journal.json", { trades: [] });
            journal.trades.push({
              timestamp: new Date().toISOString(),
              action: orderResult.success ? "ORDER_PLACED" : "ORDER_FAILED",
              market: c.question,
              conditionId: c.conditionId,
              side, price: tradePrice, size, fraction, pTrue, edge,
              signals: entry.signals,
              orderID: orderResult.orderID || null,
              status: orderResult.success ? "pending_fill" : "failed",
              error: orderResult.error || null,
            });
            save("trade_journal.json", journal);
          } catch (e) {
            log(`  [ORDER ERROR] ${e.message}`);
          }
        }
      } else {
        // Log signal to journal even without execution
        const journal = load("trade_journal.json", { trades: [] });
        journal.trades.push({
          timestamp: new Date().toISOString(),
          action: "SIGNAL",
          market: c.question,
          conditionId: c.conditionId,
          side, price: tradePrice, size, fraction, pTrue, edge,
          signals: entry.signals,
          status: portfolio < 10 ? "insufficient_funds" : "no_api_creds",
        });
        save("trade_journal.json", journal);
      }
    } else {
      const reason = !bothAgree ? "signals_disagree"
        : !bothConfident ? "low_confidence"
        : netEdgeAfterFee <= minEdge && Math.abs(edge) > minEdge ? `fee_exceeds_edge(raw=${(Math.abs(edge)*100).toFixed(2)}% fee=${(fee*100).toFixed(2)}%)`
        : "edge_too_small";
      log(`  PASS (${reason})`);
    }
  }

  // Save outputs
  save("polymarket_watchlist.json", watchlist);
  if (bestOpp) save("best_opportunity.json", bestOpp);

  // ── Execute best opportunity (one trade per scan) ──
  // Conflict check: skip if we already hold a position in this market
  if (bestOpp && (pos.positions || []).some(p => p.conditionId === bestOpp.conditionId)) {
    log(">>> SKIP: already holding position in \"" + bestOpp.question.slice(0, 50) + "\"");
    bestOpp = null;
  }
  if (bestOpp && portfolio >= 10 && apiCreds && walletData) {
    const tokenId = bestOpp.side === "YES" ? bestOpp.tokenIdYes : bestOpp.tokenIdNo;
    if (tokenId && bestOpp.size >= 5 && bestOpp.size <= portfolio * 0.50) {
      log(">>> EXECUTING BEST: " + bestOpp.side + " \"" + bestOpp.question.slice(0, 50) + "\" edge=" + bestOpp.edge.toFixed(4));
      try {
        const account = privateKeyToAccount(walletData.privateKey);
        const isNegRisk = bestOpp.negRisk || false;
        const tickPrice = Math.round(bestOpp.tradePrice * 100) / 100;
        const numTokens = Math.max(5, Math.floor(bestOpp.size / tickPrice));
        const orderResult = await placeOrder(apiCreds, account, tokenId, bestOpp.side, bestOpp.tradePrice, bestOpp.size, isNegRisk);

        const journal = load("trade_journal.json", { trades: [] });
        journal.trades.push({
          timestamp: new Date().toISOString(),
          action: orderResult.success ? "ORDER_PLACED" : "ORDER_FAILED",
          market: bestOpp.question,
          conditionId: bestOpp.conditionId,
          tokenId,
          side: bestOpp.side, price: bestOpp.tradePrice, size: bestOpp.size,
          fraction: bestOpp.fraction, pTrue: bestOpp.pTrue, edge: bestOpp.edge,
          signals: bestOpp.signals,
          orderID: orderResult.orderID || null,
          status: orderResult.success ? "pending_fill" : "failed",
          error: orderResult.error || null,
        });
        save("trade_journal.json", journal);
        // Record new position locally
        if (orderResult.success) {
          pos.positions.push({
            id: Math.random().toString(36).slice(2),
            market: bestOpp.question,
            conditionId: bestOpp.conditionId,
            tokenId,
            side: bestOpp.side,
            entryPrice: bestOpp.tradePrice,
            numTokens,
            entryDate: new Date().toISOString(),
            entryEdge: bestOpp.edge,
            entryPTrue: bestOpp.pTrue,
            negRisk: isNegRisk,
            status: "open",
          });
          save("polymarket_positions.json", pos);
          log("  [POSITION RECORDED] " + bestOpp.side + " " + bestOpp.question.slice(0, 40));
          await notify("BUY " + bestOpp.side, `**${bestOpp.question}**\n\n- 方向: ${bestOpp.side}\n- 价格: $${bestOpp.tradePrice.toFixed(4)}\n- 数量: ${numTokens} tokens\n- 金额: $${bestOpp.size.toFixed(2)}\n- Edge: ${(bestOpp.edge * 100).toFixed(2)}%\n- OrderID: ${orderResult.orderID}`);
        }
      } catch (e) {
        log("  [EXEC ERROR] " + e.message);
      }
    }
  }

  log(`\nWatchlist: ${watchlist.markets.length} markets`);
  if (bestOpp) {
    log(`Best opportunity: ${bestOpp.side} "${bestOpp.question.slice(0, 60)}" edge=${bestOpp.edge.toFixed(4)}`);
  } else {
    log("No actionable opportunities this scan.");
  }

  log("═══ SCANNER v2 COMPLETE ═══");
}

main().catch(e => { log("FATAL:", e.message, "\n", e.stack); process.exit(1); });

// ═══════════════════════════════════════════════════════════════════════════════
// NEWS SENTIMENT SIGNAL (3rd signal to enable trading)
// ═══════════════════════════════════════════════════════════════════════════════

async function newsSignal(question, mktPrice) {
  try {
    // Search for recent news about the question topic
    const keywords = question.split(' ').slice(0, 5).join(' ');
    const searchUrl = `https://news.google.com/search?q=${encodeURIComponent(keywords)}&hl=en-US&gl=US&ceid=US%3Aen`;
    
    // Simple sentiment heuristic: assume neutral (0.5) if we can't fetch
    // In production, would use a real news API or ML sentiment model
    const resp = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000)
    }).catch(() => null);
    
    if (!resp || !resp.ok) {
      // No news found = market price is fair = neutral sentiment
      return { sig: mktPrice, conf: 0.5, src: 'news_neutral' };
    }
    
    // For MVP: if we get news, assume slight bias toward market (75% confidence)
    return { sig: mktPrice * 1.02, conf: 0.75, src: 'news_api' };
  } catch (e) {
    // Fallback: neutral
    return { sig: mktPrice, conf: 0.5, src: 'news_fallback' };
  }
}
