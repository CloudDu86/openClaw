import { createPublicClient, http, parseAbi } from "/app/node_modules/viem/_esm/index.js";
import { polygon } from "/app/node_modules/viem/_esm/chains/index.js";

const client = createPublicClient({ chain: polygon, transport: http("https://polygon-bor-rpc.publicnode.com") });
const wallet = "0xf6FD118F3b3e8eCCE273933f053456A38cA99e72";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

// YES token for Cason Wallace steals
const TARGET_TOKEN_ID = 84884699629367789095443724476286452650462915564872413037843706067311201766410n;
const NO_TOKEN_ID = 61488633297158770686151637343438287429072971357702443027322412474637848904810n;

const abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)"
]);

async function check() {
  const usdcBal = await client.readContract({ address: USDC_E, abi, functionName: "balanceOf", args: [wallet] });
  const tokenBal = await client.readContract({ address: CTF_CONTRACT, abi, functionName: "balanceOf", args: [wallet, TARGET_TOKEN_ID] });
  const noTokenBal = await client.readContract({ address: CTF_CONTRACT, abi, functionName: "balanceOf", args: [wallet, NO_TOKEN_ID] });
  
  print(JSON.stringify({
    usdc_e: Number(usdcBal) / 1e6,
    cason_wallace_yes_tokens: Number(tokenBal) / 1e6,
    cason_wallace_no_tokens: Number(noTokenBal) / 1e6
  }, null, 2));
}

function print(s) { console.log(s); }
check();
