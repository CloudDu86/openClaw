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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";

import { resolve } from "path";
const DATA = existsSync(resolve(process.cwd(), "data")) ? resolve(process.cwd(), "data") : `${homedir()}/.openclaw`;
const req = createRequire(import.meta.url);

let privateKeyToAccount;
try {
  // Docker Sandbox (Conway)
  privateKeyToAccount = req("/app/node_modules/viem/_cjs/accounts/index.js").privateKeyToAccount;
} catch (e) {
  try {
    // Windows local host
    const viemAccounts = await import("viem/accounts");
    privateKeyToAccount = viemAccounts.privateKeyToAccount;
  } catch (e2) {
    // Dummy fallback if viem is totally missing
    privateKeyToAccount = (pk) => ({ address: "0x0000000000000000000000000000000000000000" });
  }
}

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
      signal: AbortSignal.timeout(20000),  // 20s 超时（原 15s）
    });
    if (!r.ok) {
      if (r.status !== 401) log(`WARN ${r.status} ${url.slice(0, 80)}`);
      return null;
    }
    return r.json();
  } catch (e) { return null; }  // 任何错误（包括超时）都安静返回 null
}

async function fetchClob(url, method = "GET") {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const apiCreds = load("polymarket_api_key.json", null);
    let headers = {};
    if (apiCreds) {
      headers = hmacAuth(
        apiCreds.apiKey,
        apiCreds.secret,
        apiCreds.passphrase,
        apiCreds.address,
        method,
        path
      );
    }
    return fetchJson(url, { method, headers });
  } catch (e) { return null; }
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
// ── Time-Decay Exit (P1) ──
const TIME_DECAY_RATIO     = 0.10;  // patience = 10% of time-to-expiry
const TIME_DECAY_MIN_HOURS = 4;     // floor: never exit before 4h (short-term arb window)
const TIME_DECAY_MAX_HOURS = 168;   // cap: never wait more than 7 days
const MIN_SELL_TOKENS = 5;          // Polymarket minimum order size
const CTF_TOKEN_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // ERC-1155
const SIMULATE_TRADING = true;      // TRUE = paper trading (no real orders)
const DRY_RUN_EXITS = false;        // live mode — full auto
const TRADING_ENABLED = true;       // system will trade automatically when conditions met

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
  if (!hex) return null; // [FIX] If RPC fails, return null instead of 0
  if (hex === "0x") return 0;
  return parseInt(hex, 16) / 1e6;  // USDC = 6 decimals
}

async function getPolygonUsdc(walletAddress) {
  const [usdcE, usdcNative] = await Promise.all([
    readBalanceOf(USDC_E, walletAddress),
    readBalanceOf(USDC_NATIVE, walletAddress),
  ]);
  const e = usdcE || 0;
  const n = usdcNative || 0;
  return { usdcE: e, usdcNative: n, total: e + n };
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
  if (!hex) return null; // [FIX] Network/RPC error must not return 0
  if (hex === "0x") return 0;
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

async function syncPositions(pos, walletAddr, forceFull = false) {
  let positions = pos.positions || [];
  
  // Decide if we need a full discovery (e.g., every 20 scans, but NOT on the very first run unless forced)
  const scanCount = parseInt(process.env.SCAN_COUNT || "0");
  const shouldDiscover = forceFull || (scanCount > 0 && scanCount % 20 === 0);

  if (shouldDiscover) {
    log(`  [SYNC] Periodic full discovery: checking top active markets...`);
  } else {
    log(`  [SYNC] Lightweight: checking balances for ${positions.length} known positions...`);
  }

  // ── Step 1: Update existing local positions (Always do this, very fast) ──
  for (const p of positions) {
    let bal = p.numTokens;
    if (!SIMULATE_TRADING) {
      const onchainBal = await readTokenBalance(walletAddr, p.tokenId);
      if (onchainBal === null) {
        log(`  [SYNC] "${p.market?.slice(0, 40)}" — RPC read failed, keeping old balance`);
        continue;
      }
      bal = onchainBal;
    }

    if (bal <= 0.1) {
      log(`  [SYNC] "${p.market?.slice(0, 40)}" — balance=0, closing`);
      p.status = "closed";
      p.exitDate = new Date().toISOString();
      if (!pos.closed) pos.closed = [];
      pos.closed.push({ ...p }); // [FIX] Explicitly append to closed list before filter
    } else {
      p.numTokens = bal;
    }
  }

  // ── Step 2: Proactive discovery (Only occasionally) ──
  if (shouldDiscover) {
    const mktsResp = await fetchJson("https://clob.polymarket.com/sampling-markets?next_cursor=MQ==&limit=30");
    const mkts = mktsResp?.data || [];
    const localTokenIds = new Set(positions.filter(p => p.status === "open").map(p => p.tokenId));

    for (const m of mkts) {
      if (!m.tokens) continue;
      for (const t of m.tokens) {
        if (!t.token_id || localTokenIds.has(t.token_id)) continue;
        const bal = await readTokenBalance(walletAddr, t.token_id);
        if (bal > 0.1) {
          log(`  [SYNC DISCOVERY] Found unrecorded: ${t.outcome} "${m.question.slice(0, 40)}"`);
          positions.push({
            id: "sync_" + Math.random().toString(36).slice(2),
            market: m.question,
            conditionId: m.condition_id,
            tokenId: t.token_id,
            side: t.outcome?.toUpperCase() || "YES",
            entryPrice: 0,
            numTokens: bal,
            entryDate: new Date().toISOString(),
            negRisk: m.neg_risk || false,
            status: "open",
          });
          localTokenIds.add(t.token_id);
        }
      }
    }
  }

  pos.positions = positions.filter(p => p.status !== "closed" && p.status !== "abandoned");
  save("polymarket_positions.json", pos);
  return pos.positions.filter(p => p.status === "open"); // evaluatePosition 只评估 open 仓位
}

// Returns the patience window (hours) proportional to time-to-expiry.
function calcDecayThreshold(endDate) {
  if (!endDate) return TIME_DECAY_MAX_HOURS; // no expiry info → max patience
  const tteHours = (new Date(endDate).getTime() - Date.now()) / 3_600_000;
  if (tteHours <= 0) return TIME_DECAY_MIN_HOURS; // already expired → min patience
  const raw = tteHours * TIME_DECAY_RATIO;
  return Math.max(TIME_DECAY_MIN_HOURS, Math.min(raw, TIME_DECAY_MAX_HOURS));
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
  // Step 3: calculate net edge (Expectation - Market)
  const netEdge = newPTrue - currentPrice;
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

  // Step 5: Edge Exhaustion (Profit Taking)
  // When netEdge < takerFee * 0.5, our mathematical edge is effectively exhausted.
  // Since we prefer Maker sell orders (0 fee), we don't strictly require full takerFee coverage to exit.
  const takerFee = calcTakerFee(currentPrice, position.tags || []);
  const exhaustionThreshold = Math.max(takerFee, 0.005) * 0.5; // floor 0.5% for 0-fee categories (e.g. geopolitics)
  if (netEdge < exhaustionThreshold && pnlPct > 0) {
    log(`  [EVAL] "${position.market?.slice(0, 40)}" ${side} — EDGE EXHAUSTED (PROFIT TAKING)`);
    log(`    netEdge=${netEdge.toFixed(4)} < limit(${exhaustionThreshold.toFixed(4)}) | price=${currentPrice.toFixed(3)} pTrue=${newPTrue.toFixed(4)} pnl=${(pnlPct * 100).toFixed(1)}%`);
    return {
      action: "EXIT", reason: "edge_exhaustion",
      currentPrice, newPTrue, netEdge, pnlPct,
      signals: { clob_micro: clob.signal, momentum: mom.signal },
    };
  }
  // Step 6: Time-Decay Exit
  // Trigger only when ALL three are true:
  //   (1) held longer than the dynamic patience window
  //   (2) position is not profitable (price hasn't moved in our favour)
  //   (3) underlying thesis has weakened (netEdge decayed, not just consumed by PnL)
  const holdHours = (Date.now() - new Date(position.entryDate).getTime()) / 3_600_000;
  const decayThreshold = calcDecayThreshold(position.endDate);
  const isTimeDecayed    = holdHours > decayThreshold;
  const isNotProfitable  = pnlPct <= 0;
  const isThesisWeakened = netEdge < (position.entryEdge || 0) - 0.005;
  if (isTimeDecayed && isNotProfitable && isThesisWeakened) {
    log(`  [EVAL] "${position.market?.slice(0, 40)}" ${side} — TIME DECAY EXIT`);
    log(`    held=${holdHours.toFixed(1)}h > threshold=${decayThreshold.toFixed(1)}h | pnl=${(pnlPct * 100).toFixed(1)}% | netEdge=${netEdge.toFixed(4)} entryEdge=${(position.entryEdge || 0).toFixed(4)}`);
    return {
      action: "EXIT", reason: "time_decay",
      currentPrice, newPTrue, netEdge, pnlPct,
      signals: { clob_micro: clob.signal, momentum: mom.signal },
    };
  }
  log(`  [EVAL] "${position.market?.slice(0, 40)}" ${side} — HOLD | netEdge=${netEdge.toFixed(4)} price=${currentPrice.toFixed(3)} pnl=${(pnlPct * 100).toFixed(1)}% held=${holdHours.toFixed(1)}h/${decayThreshold.toFixed(1)}h`);
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
  // --- MAKER / TAKER PRICING ---
  // Maker sell at midpoint to test market. If 0.99, limit it.
  const makerPrice = Math.max(0.01, Math.min(0.99, Math.round((currentPrice) * 100) / 100));
  // Taker sell fallback limits down to 0.01
  const takerPrice = Math.max(0.01, Math.min(0.99, Math.round((currentPrice - 0.05) * 100) / 100)); // allow generous slippage on taker

  const sellTokens = Math.floor(numTokens);
  
  if (DRY_RUN_EXITS) {
    log(`  [DRY-RUN SELL] "${position.market?.slice(0, 40)}" SELL ${sellTokens} tokens @ ${makerPrice.toFixed(2)} reason=${reason}`);
    const journal = load("trade_journal.json", { trades: [] });
    journal.trades.push({
      timestamp: new Date().toISOString(),
      action: "SELL_DRY_RUN",
      market: position.market, conditionId: position.conditionId,
      tokenId, side, numTokens: sellTokens,
      entryPrice: position.entryPrice, exitPrice: makerPrice,
      exitReason: reason, netEdge, pnlPct,
      signalsAtExit: decision.signals,
    });
    save("trade_journal.json", journal);
    return { success: true, dryRun: true };
  }
  
  log(`  [MAKER SELL] "${position.market?.slice(0, 40)}" SELL ${sellTokens} @ ${makerPrice.toFixed(2)} (Fallback: ${takerPrice})`);
  const orderResult = await placeOrder(apiCreds, null, tokenId, "SELL", makerPrice, sellTokens * makerPrice, negRisk);
  
  const journal = load("trade_journal.json", { trades: [] });
  journal.trades.push({
    timestamp: new Date().toISOString(),
    action: orderResult.success ? "MAKER_SELL_PLACED" : "SELL_FAILED",
    market: position.market, conditionId: position.conditionId,
    tokenId, side, numTokens: sellTokens,
    entryPrice: position.entryPrice, exitPrice: makerPrice,
    exitReason: reason, netEdge, pnlPct,
    signalsAtExit: decision.signals,
    orderID: orderResult.orderID || null,
    error: orderResult.error || null,
  });
  save("trade_journal.json", journal);
  
  const pnlStr = (pnlPct * 100).toFixed(1);
  if (orderResult.success) {
     orderResult.makerPrice = makerPrice;
     orderResult.takerPrice = takerPrice;
  } else {
    // notify disabled: individual trade alerts suppressed, daily report only
    // await notify("SELL FAILED", `**${position.market}**\n\n- 卖出失败: ${orderResult.error}\n- PnL: ${pnlStr}%`);
  }
  return orderResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// M1: SIGNAL GENERATION (2 real signals only)
// ═══════════════════════════════════════════════════════════════════════════════

async function scanMarkets() {
  // Use Gamma API (provides real volume, we bypass block with User-Agent)
  const resp = await fetch(`https://gamma-api.polymarket.com/markets?limit=300&active=true&closed=false&order=volumeNum&ascending=false`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(20000)
  }).then(r => r.json()).catch(() => null);

  const markets = resp;
  if (!markets || markets.length === 0) { log("WARN: Gamma markets API unreachable"); return []; }

  const now = Date.now();
  const out = [];

  for (const mkt of markets) {
    if (mkt.closed || !mkt.active || !mkt.acceptingOrders) continue;
    const end = new Date(mkt.endDateIso || mkt.endDate || 0).getTime();
    if (end && end - now < 12 * 3600e3) continue;  // skip markets ending within 12h
    
    let tokens = [];
    try { tokens = JSON.parse(mkt.clobTokenIds || "[]"); } catch { continue; }
    let outcomes = [];
    try { outcomes = JSON.parse(mkt.outcomes || "[]"); } catch { continue; }
    let prices = [];
    try { prices = JSON.parse(mkt.outcomePrices || "[]"); } catch { continue; }
    
    if (tokens.length < 2 || outcomes.length < 2) continue;
    
    // Find exact Yes/No indexes (markets are often standard binary)
    const yesIdx = outcomes.findIndex(o => o === "Yes");
    const noIdx = outcomes.findIndex(o => o === "No");
    if (yesIdx === -1 || noIdx === -1) continue;

    const yesPrice = parseFloat(prices[yesIdx] || 0);
    const noPrice = parseFloat(prices[noIdx] || 0);
    
    if (yesPrice <= 0.05 || yesPrice >= 0.95) continue;
    if (!tokens[yesIdx]) continue;

    out.push({
      conditionId: mkt.conditionId,
      question: mkt.question || "?",
      yesPrice,
      noPrice,
      volume: parseFloat(mkt.volume || 0),
      endDate: mkt.endDateIso || mkt.endDate,
      tokenIdYes: tokens[yesIdx],
      tokenIdNo: tokens[noIdx],
      negRisk: mkt.negRisk || false,
      tickSize: mkt.orderPriceMinTickSize || 0.01,
      tags: mkt.tags ? (typeof mkt.tags === "string" ? JSON.parse(mkt.tags) : mkt.tags) : [],
    });
  }
  return out;
}

// ── Signal 1: CLOB Microstructure ────────────────────────────────────────────
async function clobSignal(tokenId, mktPrice) {
  const [book, trades] = await Promise.all([
    fetchJson(`https://clob.polymarket.com/book?token_id=${tokenId}`),
    fetchClob(`https://clob.polymarket.com/trades?asset_id=${tokenId}&limit=100`),
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
  // 【精准狙击模式】半 Kelly，上限 60%（原为 四分之一 Kelly 上限 10%）
  // 弱信号 (fullKelly≈0.05) → fraction≈2.5%  → size≈$5（兜底）
  // 中信号 (fullKelly≈0.15) → fraction≈7.5%  → size≈$9（适中）
  // 强信号 (fullKelly≈0.30) → fraction≈15%   → size≈$16（进攻）
  // 超强   (fullKelly≥1.20) → fraction=60%   → size≈$14（上限）
  const fraction = Math.min(0.60, fullKelly * 0.5);
  const rawSize = Math.round(fraction * portfolio * 100) / 100;
  // 【小账户保底】无论如何最低下单限制应满足交易所最低要求 $5
  const minFloor = 5; 
  const size = Math.min(portfolio * 0.95, Math.max(minFloor, rawSize));
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

  if (SIMULATE_TRADING) {
    log("  [ORDER SIMULATED] Paper trading enabled, skipping python invocation.");
    return { success: true, orderID: "sim_" + Math.random().toString(36).slice(2) };
  }

  const { execSync } = await import("child_process");

  const tickPrice = Math.round(price * 100) / 100;
  // Fix floating point bug (e.g. 4.68 / 0.78 = 5.99999 -> 6)
  let numTokens = Math.round(sizeUsdc / tickPrice);
  
  // Only enforce 5 token minimum for BUY orders. SELL orders must be able to close dust.
  if (side === "BUY" && numTokens < 5) numTokens = 5;

  try {
    const orderSide = (side === "SELL") ? "SELL" : "BUY";
    const cmd = "python3 /root/.openclaw/place_order.py " + JSON.stringify(tokenId) + " " + orderSide + " " + tickPrice + " " + numTokens;
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
// MAKER-TAKER FALLBACK ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

// Sim-only: check if a Maker order would fill based on real CLOB book depth.
// isBuy=true  → Maker BUY  @ limitPrice: needs asks ≤ limitPrice with enough size
// isBuy=false → Maker SELL @ limitPrice: needs bids ≥ limitPrice with enough size
async function checkMakerFillSim(tokenId, isBuy, limitPrice, requiredTokens) {
  const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  if (!book) {
    log(`    [SIM FILL] book fetch failed, falling back to random`);
    return Math.random() > 0.5 ? "FILLED" : "LIVE";
  }
  let availableSize = 0;
  if (isBuy) {
    for (const ask of (book.asks || [])) {
      if (parseFloat(ask.price) <= limitPrice) availableSize += parseFloat(ask.size || 0);
    }
  } else {
    for (const bid of (book.bids || [])) {
      if (parseFloat(bid.price) >= limitPrice) availableSize += parseFloat(bid.size || 0);
    }
  }
  const filled = availableSize >= requiredTokens;
  log(`    [SIM FILL] ${isBuy ? "BUY" : "SELL"} @ ${limitPrice} | need=${requiredTokens.toFixed(1)} avail=${availableSize.toFixed(1)} → ${filled ? "FILLED" : "LIVE"}`);
  return filled ? "FILLED" : "LIVE";
}

async function checkOrder(orderID) {
  if (SIMULATE_TRADING) {
    // Sim path is handled per-position in processPendingOrders via checkMakerFillSim
    return { success: true, status: "LIVE", size_matched: 0 };
  }
  try {
    const { execSync } = await import("child_process");
    const cmd = `python3 /root/.openclaw/get_order.py "${orderID}"`;
    const result = execSync(cmd, { timeout: 15000, encoding: "utf8" });
    return JSON.parse(result.trim());
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function cancelOrder(orderID) {
  if (SIMULATE_TRADING) return { success: true };
  try {
    const { execSync } = await import("child_process");
    const cmd = `python3 /root/.openclaw/cancel_order.py "${orderID}"`;
    const result = execSync(cmd, { timeout: 15000, encoding: "utf8" });
    return JSON.parse(result.trim());
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function processPendingOrders(pos, apiCreds) {
  const pending = (pos.positions || []).filter(p => ["pending_maker_buy", "pending_maker_sell"].includes(p.status));
  if (pending.length === 0) return;
  
  log(`[MAKER ENGINE] Processing ${pending.length} pending maker orders...`);
  let changed = false;

  for (const p of pending) {
    log(`  [CHECK] orderID=${p.orderID} for ${p.market?.slice(0,40)}`);
    let fillStatus;
    if (SIMULATE_TRADING) {
      const isBuy = p.status === "pending_maker_buy";
      const limitPrice = isBuy ? p.entryPrice : p.exitPriceMaker;
      const requiredTokens = isBuy ? p.numTokens : Math.floor(p.numTokens);
      if (limitPrice && requiredTokens) {
        fillStatus = await checkMakerFillSim(p.tokenId, isBuy, limitPrice, requiredTokens);
      } else {
        fillStatus = "LIVE"; // missing price/size info → treat as unfilled
      }
    } else {
      const check = await checkOrder(p.orderID);
      if (!check.success) {
        log(`    -> query failed: ${check.error}`);
        continue;
      }
      fillStatus = check.status;
    }
    
    if (fillStatus === "FILLED" || fillStatus === "CANCELED" || fillStatus === "EXPIRED") {
      changed = true;
      if (fillStatus === "FILLED") {
         log(`    -> FILLED! 0% Maker fee secured.`);
         if (p.status === "pending_maker_buy") p.status = "open";
         else if (p.status === "pending_maker_sell") {
            p.status = "closed";
            pos.closed = pos.closed || [];
            pos.closed.push({...p});
            if (SIMULATE_TRADING) pos.portfolio_usdc = (pos.portfolio_usdc || 0) + (Math.floor(p.numTokens) * p.exitPriceMaker);
            // await notify("MAKER SELL FILLED", `**${p.market}**\n\n- 卖单以 Maker (${p.exitPriceMaker}) 成功填单！`);
         }
      } else {
         log(`    -> ${fillStatus}. Order removed externally.`);
         if (p.status === "pending_maker_buy") {
             if (SIMULATE_TRADING) pos.portfolio_usdc = (pos.portfolio_usdc || 0) + p.entrySizeUsdc; // refund SIM money
             p.status = "abandoned";
         } else {
             p.status = "open"; // back to holding, maybe try again
         }
      }
    } else if (fillStatus === "LIVE") {
      changed = true;
      log(`    -> LIVE after 3 mins. Canceling to fallback to TAKER...`);
      await cancelOrder(p.orderID);
      
      const takerParams = p.takerParams || {};
      if (p.status === "pending_maker_buy") {
         const netEdgeAfterFee = p.entryEdge - (takerParams.fee || 0);
         const minE = takerParams.minEdge || 0.02;
         
         if (netEdgeAfterFee > minE) {
            const orderResult = await placeOrder(apiCreds, null, p.tokenId, "BUY", takerParams.buyLimit, takerParams.size, p.negRisk);
            if (orderResult.success) {
               log(`      [TAKER BUY] limit=${takerParams.buyLimit} -> status=open`);
               p.status = "open";
               p.entryPrice = takerParams.buyLimit; // record worst-case entry
            } else {
               log(`      [TAKER BUY] Failed. Abandoning.`);
               if (SIMULATE_TRADING) pos.portfolio_usdc += p.entrySizeUsdc;
               p.status = "abandoned";
            }
         } else {
            log(`      [TAKER BUY ABORTED] Taker fee degrades netEdge (${(netEdgeAfterFee*100).toFixed(2)}%) <= ${minE*100}%. Abandoning to save fees.`);
            if (SIMULATE_TRADING) pos.portfolio_usdc += p.entrySizeUsdc; // refund
            p.status = "abandoned";
         }
      } else if (p.status === "pending_maker_sell") {
         const numTkns = Math.floor(p.numTokens);
         const orderResult = await placeOrder(apiCreds, null, p.tokenId, "SELL", takerParams.sellPrice, numTkns * takerParams.sellPrice, p.negRisk);
         if (orderResult.success) {
            log(`      [TAKER SELL] price=${takerParams.sellPrice} -> status=closed`);
            p.status = "closed";
            p.exitPrice = takerParams.sellPrice;
            pos.closed = pos.closed || [];
            pos.closed.push({...p});
            if (SIMULATE_TRADING) pos.portfolio_usdc += (numTkns * p.exitPrice);
            // await notify("TAKER SELL EXECUTED", `**${p.market}**\n\n- Maker 未命中，已降级为 Taker (${p.exitPrice}) 卖出离场。`);
         } else {
            log(`      [TAKER SELL] Failed. Keep holding.`);
            p.status = "open"; 
         }
      }
    }
  }
  
  if (changed) {
    pos.positions = pos.positions.filter(p => !["abandoned", "closed"].includes(p.status));
    save("polymarket_positions.json", pos);
  }
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
  
  if (SIMULATE_TRADING) {
    portfolio = pos.portfolio_usdc || 30.0;
    log(`[SIMULATION] Virtual Portfolio: $${portfolio.toFixed(2)}`);
  } else if (walletData?.privateKey) {
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

  const freeCash = pos.portfolio_usdc || 0;
  const openOnly = (pos.positions || []).filter(p => p.status === "open");
  const positionsValue = openOnly.reduce((sum, p) => sum + (p.numTokens || 0) * (p.entryPrice || 0), 0);
  const totalEquity = freeCash + positionsValue;
  log(`Portfolio: $${totalEquity.toFixed(2)} (Free: $${freeCash.toFixed(2)} + Positions: $${positionsValue.toFixed(2)}) | Open: ${openOnly.length}/8 | Regime: ${wData.regime}`);
  log(`Weights: clob=${(wData.weights.clob_micro || 0).toFixed(2)} mom=${(wData.weights.momentum || 0).toFixed(2)}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // MAKER-TAKER ENGINE (Runs 1st to resolve stuck orders)
  // ═══════════════════════════════════════════════════════════════════════════
  if (walletAddr || SIMULATE_TRADING) {
    await processPendingOrders(pos, apiCreds);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POSITION MANAGER: Sync → Evaluate → Exit (runs BEFORE new entries)
  // ═══════════════════════════════════════════════════════════════════════════
  if (walletAddr || SIMULATE_TRADING) {
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
            // Maker Order successfully placed
            p.status = "pending_maker_sell";
            p.orderID = result.orderID;
            p.exitPriceMaker = result.makerPrice;
            p.takerParams = { sellPrice: result.takerPrice };
            
            // Wait 3 mins for resolution
            save("polymarket_positions.json", pos);

            // ── M4: 用退出时的市场价格作为「实际结果」反馈给 Brier Score ──
            // 逻辑：exitPrice 是市场当前对真实胜率的最新估计，
            // 我们用它来衡量入场时各信号的预测准不准。
            if (p.entrySignals) {
              const outcome = decision.currentPrice; // 市场最新价作为 proxy outcome
              for (const [sigKey, sigVal] of Object.entries(p.entrySignals)) {
                if (typeof sigVal === "number") {
                  updateAdaptation(wData, sigKey, sigVal, outcome);
                  log(`  [M4] ${sigKey}: predicted=${sigVal.toFixed(4)} outcome=${outcome.toFixed(4)} → new weight=${(wData.weights[sigKey]||0.5).toFixed(3)}`);
                }
              }
            } else {
              log(`  [M4] 跳过（此仓位无 entrySignals 记录，旧数据）`);
            }
          }
        }
      }
      // Update positions after exits
      pos.positions = openPositions.filter(p => p.status !== "closed" && p.status !== "abandoned");
      save("polymarket_positions.json", pos);
      // Re-read balance after sells (Only if NOT simulating)
      if (!SIMULATE_TRADING && pos.positions.length < openPositions.length) {
        try {
          const bal = await getPolygonUsdc(walletAddr);
          portfolio = bal.total;
          log(`[BALANCE UPDATE] After exits: $${portfolio.toFixed(2)}`);
        } catch { }
      }
    }
  }

  // ── Risk gates ──
  if ((pos.positions || []).length >= 8) {
    log("RISK GATE: 8 positions open — no new entries");
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

  const allKnownConditions = new Set([
    ...(pos.positions || []).map(p => p.conditionId), // 只屏蔽当前持仓（open/pending），不屏蔽历史已平仓
  ]);

  for (const c of candidates) {
    log(`\n  Q: ${c.question.slice(0, 80)}`);
    log(`  YES=${c.yesPrice.toFixed(3)} NO=${c.noPrice.toFixed(3)} | Vol=$${(c.volume / 1000).toFixed(0)}k`);

    if (allKnownConditions.has(c.conditionId)) {
      log("  PASS (already_in_portfolio)");
      continue;
    }

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
    const { pTrue, edge: rawEdgeYes, ev, agreeing } = calcEdge(signals, wData.weights, c.yesPrice);
    const side = rawEdgeYes > 0 ? "YES" : "NO";
    const tradePrice = Math.round((side === "YES" ? c.yesPrice : c.noPrice) * 100) / 100;
    
    // Calculate edge relative to the side we are taking
    const edge = side === "YES" ? rawEdgeYes : (c.yesPrice - pTrue); 
    
    log(`  P_true(YES)=${pTrue.toFixed(4)} Edge(${side})=${edge.toFixed(4)} EV=${ev.toFixed(4)} Agree=${agreeing}/2`);
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
    const minEdge = wData.regime === "regime_shift" ? 0.02 : 0.01;
    const bothAgree = agreeing >= 2;
    const bothConfident = clob.confidence >= 0.3 && mom.confidence >= 0.3;
    const fee = calcTakerFee(tradePrice, c.tags);
    // [NEW LOGIC] Maker doesn't pay taker fee
    const makerEdge = edge;
    const netEdgeAfterFee = edge - fee;

    const edgeIsPositiveForSide = edge > 0;
    
    // Maker order only requires raw edge > minEdge
    if (makerEdge > minEdge && bothAgree && bothConfident && edgeIsPositiveForSide) {
      const { size, fraction } = kellySize(pTrue, c.yesPrice, side, Math.max(portfolio, 1));

      log(`  *** SIGNAL (Maker): ${side} | Kelly=${(fraction * 100).toFixed(1)}% | size=$${size} | makerEdge=${(makerEdge * 100).toFixed(2)}% | takerEdge=${(netEdgeAfterFee * 100).toFixed(2)}% ***`);

      const netEv = ev - fee;
      // We rank candidates using raw Make EV (ev), since we will try Maker first
      if (!bestOpp || ev > (bestOpp.ev || 0)) {
        bestOpp = { ...entry, side, tradePrice, size, fraction, fee, netEv, ev, minEdge };
      }

      const journal = load("trade_journal.json", { trades: [] });
      journal.trades.push({
        timestamp: new Date().toISOString(),
        action: "SIGNAL",
        market: c.question,
        conditionId: c.conditionId,
        side, price: tradePrice, size, fraction, pTrue, edge,
        signals: entry.signals,
        status: "pending_best_opp_selection",
      });
      save("trade_journal.json", journal);
    } else {
      const reason = !bothAgree ? "signals_disagree"
        : !bothConfident ? "low_confidence"
          : netEdgeAfterFee <= minEdge && Math.abs(edge) > minEdge ? `fee_exceeds_edge(raw=${(Math.abs(edge) * 100).toFixed(2)}% fee=${(fee * 100).toFixed(2)}%)`
            : "edge_too_small";
      log(`  PASS (${reason})`);
    }
  }

  // Save outputs
  save("polymarket_watchlist.json", watchlist);
  if (bestOpp) {
    save("best_opportunity.json", bestOpp);
    // Append to history log
    const histLine = JSON.stringify({ timestamp: new Date().toISOString(), ...bestOpp }) + "\n";
    try {
      const fs = req("fs");
      fs.appendFileSync(`${DATA}/best_opportunities_history.jsonl`, histLine);
    } catch (e) { log("[HISTORY ERR] " + e.message); }
  }

  // ── Execute best opportunity (one trade per scan) ──
  if (!TRADING_ENABLED) {
    log(">>> TRADING DISABLED: skipping execution phase");
  } else {
    if (bestOpp && portfolio >= 3 && apiCreds && walletData) {
      const tokenId = bestOpp.side === "YES" ? bestOpp.tokenIdYes : bestOpp.tokenIdNo;
      if (tokenId && bestOpp.size >= 3) {
        log(">>> EXECUTING BEST (Maker): " + bestOpp.side + " \"" + bestOpp.question.slice(0, 50) + "\" edge=" + bestOpp.edge.toFixed(4));
        
        try {
          const account = privateKeyToAccount(walletData.privateKey);
          const isNegRisk = bestOpp.negRisk || false;
          
          // --- MAKER / TAKER BUY PRICING ---
          const makerBuyLimit = bestOpp.tradePrice; 
          const takerBuyLimit = 0.99; // Fallback to market execution ceiling
          const sizeUsdc = bestOpp.size;

          const orderResult = await placeOrder(apiCreds, account, tokenId, "BUY", makerBuyLimit, sizeUsdc, isNegRisk);
          
          const journal = load("trade_journal.json", { trades: [] });
          journal.trades.push({
            timestamp: new Date().toISOString(),
            action: orderResult.success ? "MAKER_BUY_PLACED" : "ORDER_FAILED",
            market: bestOpp.question,
            conditionId: bestOpp.conditionId,
            tokenId,
            side: bestOpp.side, price: makerBuyLimit, size: sizeUsdc,
            fraction: bestOpp.fraction, pTrue: bestOpp.pTrue, edge: bestOpp.edge,
            signals: bestOpp.signals,
            orderID: orderResult.orderID || null,
            status: orderResult.success ? "pending_maker" : "failed",
            error: orderResult.error || null,
          });
          save("trade_journal.json", journal);

          // Record new pending maker position locally
          if (orderResult.success) {
            const numTokens = sizeUsdc / makerBuyLimit;
            pos.positions.push({
              id: Math.random().toString(36).slice(2),
              market: bestOpp.question,
              conditionId: bestOpp.conditionId,
              tokenId,
              side: bestOpp.side,
              entryPrice: makerBuyLimit, 
              entrySizeUsdc: sizeUsdc,
              numTokens,
              entryDate: new Date().toISOString(),
              entryEdge: bestOpp.edge,
              entryPTrue: bestOpp.pTrue,
              entrySignals: bestOpp.signals,
              negRisk: isNegRisk,
              status: "pending_maker_buy",
              orderID: orderResult.orderID,
              tags: bestOpp.tags || [],
              endDate: bestOpp.endDate || null,
              takerParams: { buyLimit: takerBuyLimit, size: sizeUsdc, fee: bestOpp.fee, minEdge: bestOpp.minEdge }
            });
            pos.portfolio_usdc = (pos.portfolio_usdc || 0) - sizeUsdc;
            save("polymarket_positions.json", pos);
            if (SIMULATE_TRADING) log(`  [SIM BALANCE] -$${sizeUsdc.toFixed(2)} -> Total $${pos.portfolio_usdc.toFixed(2)}`);
            
            log("  [PENDING MAKER RECORDED] " + bestOpp.side + " " + bestOpp.question.slice(0, 40));
            // await notify("MAKER BUY " + bestOpp.side, `**${bestOpp.question}**\n\n- 发起 Maker 买入: $${makerBuyLimit.toFixed(4)}\n- 金额: $${sizeUsdc.toFixed(2)}\n- 若3分钟未成交将转 Taker`);
          }
        } catch (e) {
          log("  [EXEC ERROR] " + e.message);
        }
      }
    }
  }

  log(`\nWatchlist: ${watchlist.markets.length} markets`);
  if (bestOpp) {
    log(`Best opportunity: ${bestOpp.side} "${bestOpp.question.slice(0, 60)}" edge=${bestOpp.edge.toFixed(4)}`);
  } else {
    log("No actionable opportunities this scan.");
  }

  // ── M4: 每轮扫描结束后持久化权重（无论是否有新交易都保存）──
  save("signal_weights.json", wData);
  log(`[M4] Weights saved → clob=${(wData.weights.clob_micro||0.5).toFixed(3)} mom=${(wData.weights.momentum||0.5).toFixed(3)} resolutions=${wData.total_resolutions||0}`);

  const openPos = (pos.positions || []).filter(p => p.status === "open");
  const pendingPos = (pos.positions || []).filter(p => p.status === "pending_maker_buy" || p.status === "pending_maker_sell");
  const latestFreeCash = pos.portfolio_usdc ?? portfolio;
  const latestPosValue = openPos.reduce((sum, p) => sum + (p.numTokens || 0) * (p.entryPrice || 0), 0);
  const latestTotal = latestFreeCash + latestPosValue;
  log("─────────────────────────────────────────────");
  log(`Balance  : $${latestTotal.toFixed(2)} total (Free: $${latestFreeCash.toFixed(2)} + Positions: $${latestPosValue.toFixed(2)})`);
  log(`Positions: ${openPos.length} open | ${pendingPos.length} pending | ${(pos.closed || []).length} closed all-time`);
  if (openPos.length > 0) {
    for (const p of openPos) {
      const heldH = ((Date.now() - new Date(p.entryDate).getTime()) / 3_600_000).toFixed(1);
      log(`  [${p.side}] "${p.market.slice(0, 45)}" entry=${p.entryPrice} held=${heldH}h`);
    }
  }
  if (pendingPos.length > 0) {
    for (const p of pendingPos) {
      log(`  [${p.status}] "${p.market.slice(0, 45)}"`);
    }
  }
  log(`Regime   : ${wData.regime} | clob_w=${(wData.weights.clob_micro||0.5).toFixed(3)} mom_w=${(wData.weights.momentum||0.5).toFixed(3)}`);
  log("─────────────────────────────────────────────");
  log("═══ SCANNER v2 COMPLETE ═══");
}

// ── 崩溃防护层（严禁进程被意外错误杀死）──
process.on("uncaughtException",   e => log("[UNCAUGHT]  " + e.message));
process.on("unhandledRejection",  e => log("[UNHANDLED] " + (e?.message || e)));

// ── 5 分钟经印止讯（防止某个失败的网络请求把整个进程卡住）──
const HARD_TIMEOUT = 5 * 60 * 1000; // 5 min
const timer = setTimeout(() => {
  log("[WATCHDOG] 扫描超时5分钟，强制退出（cron 会在 3 分钟内重启）");
  process.exit(0);
}, HARD_TIMEOUT);
timer.unref(); // 不阻止正常退出

main()
  .then(() => {
    clearTimeout(timer);
    process.exit(0);
  })
  .catch(e => {
    clearTimeout(timer);
    log("FATAL: " + e.message + "\n" + (e.stack || ""));
    process.exit(1);
  });

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
