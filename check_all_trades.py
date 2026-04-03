import sys
import json
import os
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds

def check_all_trades():
    data_dir = os.path.expanduser("~/.openclaw")
    wallet_path = os.path.join(data_dir, "wallet.json")
    creds_path = os.path.join(data_dir, "polymarket_api_key.json")

    with open(wallet_path, "r") as f:
        wallet = json.load(f)
    with open(creds_path, "r") as f:
        api_creds_raw = json.load(f)

    creds = ApiCreds(
        api_key=api_creds_raw["apiKey"],
        api_secret=api_creds_raw["secret"],
        api_passphrase=api_creds_raw["passphrase"],
    )

    client = ClobClient(
        host="https://clob.polymarket.com",
        key=wallet["privateKey"],
        chain_id=137,
        creds=creds,
    )

    print("Fetching last 15 exact trades...")
    try:
        trades = client.get_trades()
        if not trades:
            return
        
        for t in trades[:15]:
            side = t.get("side")
            size = float(t.get("size", 0))
            price = float(t.get("price", 0))
            market = t.get("asset_id")
            timestamp = t.get("timestamp")
            print(f"{timestamp} | {side}: {size} tokens @ ${price} | Market: {market}")

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_all_trades()
