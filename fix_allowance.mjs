import { createWalletClient, http, parseAbi } from "/app/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "/app/node_modules/viem/_esm/accounts/index.js";
import { polygon } from "/app/node_modules/viem/_esm/chains/index.js";
import { readFileSync } from "fs";
import { homedir } from "os";

const DATA = `${homedir()}/.openclaw`;
const wallet = JSON.parse(readFileSync(`${DATA}/wallet.json`, "utf8"));
const CTF_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const SPENDERS = [
  "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"
];

const abi = parseAbi([
  "function setApprovalForAll(address operator, bool approved) external"
]);

async function main() {
  const account = privateKeyToAccount(wallet.privateKey);
  const client = createWalletClient({
    account,
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com")
  });

  console.log(`Address: ${account.address}`);
  
  for (const spender of SPENDERS) {
    try {
      console.log(`Sending setApprovalForAll to ${spender}...`);
      const hash = await client.writeContract({
        address: CTF_CONTRACT,
        abi,
        functionName: "setApprovalForAll",
        args: [spender, true],
      });
      console.log(`Sent! Hash: ${hash}`);
    } catch (e) {
      console.error(`Failed for ${spender}:`, e.message);
    }
  }
  console.log("All authorizations sent.");
}

main();
