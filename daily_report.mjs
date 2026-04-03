import { readFileSync } from "fs";
import { homedir } from "os";

// We can just use the built-in fetch of Node v22
const DATA = "/root/.openclaw";
const SERVERCHAN_KEY = "SCT330458TSdLCgJFxCpmcf89XX89WDuAM";

function load(file, fallback) {
  try { return JSON.parse(readFileSync(`${DATA}/${file}`, "utf8")); }
  catch { return fallback; }
}

async function notify(title, desp) {
  try {
    const res = await fetch(`https://sctapi.ftqq.com/${SERVERCHAN_KEY}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.slice(0, 32), desp }),
      signal: AbortSignal.timeout(10000),
    });
    console.log("Push notice sent", res.status);
  } catch (e) { console.error("[NOTIFY ERR]", e.message); }
}

// Reuse the RPC logic to get accurate cash balance directly from chain
const POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
  "https://polygon.drpc.org",
];
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";       // USDC.e
const CTF_TOKEN_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // ERC-1155

async function fetchJson(url, opts = {}) {
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    return r.json();
  } catch (e) { return null; }
}

async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  for (const rpc of POLYGON_RPCS) {
    const resp = await fetchJson(rpc, { method: "POST", body });
    if (resp?.result) return resp.result;
  }
  return null;
}

async function readBalanceOf(token, wallet) {
  const padded = wallet.slice(2).toLowerCase().padStart(64, "0");
  const data = "0x70a08231" + padded;
  const hex = await rpcCall("eth_call", [{ to: token, data }, "latest"]);
  if (!hex || hex === "0x") return 0;
  return parseInt(hex, 16) / 1e6;
}

async function readTokenBalance(walletAddress, tokenId) {
  const addr = walletAddress.slice(2).toLowerCase().padStart(64, "0");
  const id = BigInt(tokenId).toString(16).padStart(64, "0");
  const data = "0x00fdd58e" + addr + id;
  const hex = await rpcCall("eth_call", [{ to: CTF_TOKEN_CONTRACT, data }, "latest"]);
  if (!hex || hex === "0x") return 0;
  return parseInt(hex, 16) / 1e6;
}

async function generateReport() {
  const walletData = load("wallet.json", {});
  const walletAddr = walletData.address || "0xf6FD118F3b3e8eCCE273933f053456A38cA99e72";
  const posData = load("polymarket_positions.json", { positions: [], closed: [] });
  const journalData = load("trade_journal.json", { trades: [] });
  
  // 1. Get USDC Balance
  const usdcBal = await readBalanceOf(USDC_E, walletAddr);
  
  // 2. Refresh open positions and sum up value loosely based on entry price
  // (Using entryPrice gives book value; exact market value requires CLOB fetch, which might timeout)
  let openPositionsMarkup = "";
  let portfolioPositionValue = 0;
  
  if (posData.positions && posData.positions.length > 0) {
    for (const p of posData.positions) {
      // Sync exact balance on-chain just in case
      let qty = await readTokenBalance(walletAddr, p.tokenId);
      if (qty === null) qty = p.numTokens; // fallback
      if (qty > 0.01) {
        const value = qty * p.entryPrice;
        portfolioPositionValue += value;
        const condition = p.market.slice(0, 40) + "...";
        openPositionsMarkup += `- **${p.side}** | qty: ${qty.toFixed(2)} | costs: $${value.toFixed(2)} | [${condition}]\n`;
      }
    }
  }
  
  if (!openPositionsMarkup) openPositionsMarkup = "> *当前轻仓，无隔夜单*\n";
  
  // 3. Summarize today's trades (last 24h)
  const now = Date.now();
  let todayTradesMarkup = "";
  let tradesCount = 0;
  let todayPnl = 0;
  
  for (const t of journalData.trades) {
    const ts = new Date(t.timestamp).getTime();
    if (now - ts < 24 * 3600 * 1000) {
      if (t.action && (t.action.includes("PLACED") || t.action === "SELL_PLACED")) {
        tradesCount++;
        const pnlStr = t.pnlPct !== undefined ? ` | PnL: ${(t.pnlPct*100).toFixed(1)}%` : "";
        if (t.pnlPct) todayPnl += t.pnlPct; // very rough average metric
        const actionBase1 = t.action.split("_")[0];
        
        let tokensQty = t.numTokens;
        if (!tokensQty && t.size && t.price) tokensQty = t.size / t.price;
        const qtyStr = tokensQty ? tokensQty.toFixed(1) + "份" : "$" + (t.size||0).toFixed(2);
        
        todayTradesMarkup += `- [${actionBase1}] ${t.side} | ${qtyStr} | [${t.market?.slice(0,25)}...]${pnlStr}\n`;
      }
    }
  }
  
  if (!todayTradesMarkup) todayTradesMarkup = "> *今日无实际成交记录*\n";

  // 4. M4 Weights 
  const wData = load("signal_weights.json", { weights: { clob_micro: 0.5, momentum: 0.5 } });

  // 5. Build Markdown content
  const totalEquity = usdcBal + portfolioPositionValue;
  
  const desp = `
## 📊 账户概览 (Daily Report)
- **总净值估算**: $${totalEquity.toFixed(2)}
- 现金储备 (USDC): $${usdcBal.toFixed(2)}
- 仓单成本总计: $${portfolioPositionValue.toFixed(2)}
- M4 引擎参数: CLOB=${wData.weights.clob_micro?.toFixed(2)} | MOM=${wData.weights.momentum?.toFixed(2)}

## 💼 当前持仓 (${posData.positions?.length || 0}/5)
${openPositionsMarkup}

## ⚡ 今日成交 (过去24小时)
共计 ${tradesCount} 笔执行单
${todayTradesMarkup}
`;

  console.log("Generating report:\n", desp);
  
  const todayStr = new Date().toLocaleDateString("zh-CN");
  await notify(`早安！您的 OpenClaw 交易日报摘要 (${todayStr})`, desp);
}

generateReport().catch(e => console.error("Report generation failed:", e));
