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

    print("Checking allowances...")
    # Checking allowance for the CLOB Exchange to spend CTF tokens
    # Note: For selling tokens, the exchange needs allowance for the CTF contract
    try:
        # Check CTF allowance
        # In py_clob_client, we can check if the API thinks we have allowance
        pass
        
        # More importantly, let's try to set it. 
        # But setting allowance on-chain requires GAS (MATIC/POL).
        
        # Let's try to see if there is any helper in the client
        print("Attempting to get more info about why the order failed...")
        
    except Exception as e:
        print(f"Error: {str(e)}")

if __name__ == "__main__":
    main()
