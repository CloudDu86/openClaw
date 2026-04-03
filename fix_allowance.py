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

    print("Attempting to fix CTF and USDC allowances...")
    try:
        # The CTF token contract address on Polygon
        CTF_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
        
        # In modern py_clob_client, we use set_token_allowance
        # Spender is the CLOB Exchange contract (0xC5d563A36AE78145C45a50134d48A1215220f80a)
        # However, set_token_allowance usually figures this out from the client's internal config.
        
        # Let's try the direct token allowance setter
        print("Setting allowance for CTF tokens...")
        resp = client.set_token_allowance(CTF_CONTRACT)
        print(f"CTF Success! Response: {resp}")
        
    except Exception as e:
        print(f"Failed to set CTF allowance: {str(e)}")
        print("Trying fallback: client.update_config()")
        try:
            # Fallback: update_config often triggers needed approvals
            client.update_config()
            print("Config updated (may have triggered approvals).")
        except Exception as e2:
            print(f"Fallback failed: {str(e2)}")

if __name__ == "__main__":
    main()
