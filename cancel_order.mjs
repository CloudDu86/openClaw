import { readFileSync } from "fs";
import { createHmac } from "crypto";
import { homedir } from "os";

const DATA = `${homedir()}/.openclaw`;
const apiCreds = JSON.parse(readFileSync(`${DATA}/polymarket_api_key.json`, "utf8"));

function hmacAuth(apiKey, secret, passphrase, address, method, path, body = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + path + body;
  const sig = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(message)
    .digest("base64");
  // Polymarket Standard Headers (using hyphens)
  return {
    "POLY-API-KEY": apiKey,
    "POLY-SIGNATURE": sig,
    "POLY-TIMESTAMP": timestamp,
    "POLY-PASSPHRASE": passphrase,
    "POLY-ADDRESS": address,
  };
}

async function run() {
  // Step 1: List all open orders
  console.log("Fetching open orders...");
  const authHeaders = hmacAuth(apiCreds.apiKey, apiCreds.secret, apiCreds.passphrase, apiCreds.address, "GET", "/orders");
  const r = await fetch("https://clob.polymarket.com/orders", {
    headers: authHeaders
  });
  const orders = await r.json();
  console.log("Open Orders:", JSON.stringify(orders, null, 2));

  // Step 2: Cancel the specific order if found or all if needed
  const targetId = "0xbfa9f53df08dee903c5c3614c3d00a49e14d65096c3961037bbfbfe3510f63ba";
  
  if (Array.isArray(orders) && orders.length > 0) {
    for (const o of orders) {
      const oid = o.orderID;
      console.log(`Cancelling order: ${oid}`);
      const body = JSON.stringify({ orderID: oid });
      const cancelHeaders = hmacAuth(apiCreds.apiKey, apiCreds.secret, apiCreds.passphrase, apiCreds.address, "DELETE", "/order", body);
      const cr = await fetch("https://clob.polymarket.com/order", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...cancelHeaders },
        body
      });
      console.log(`Result for ${oid}:`, await cr.text());
    }
  } else {
    console.log("No orders to cancel according to API.");
  }
}

run();
