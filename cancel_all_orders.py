#!/usr/bin/env python3
import sys
import json
import os
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds

def main():
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

    print("Fetching and cancelling all open orders...")
    # cancel_all() is a convenience method in py_clob_client
    result = client.cancel_all()
    print(f"Result: {result}")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {str(e)}")
