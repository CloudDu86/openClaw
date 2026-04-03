import sys
import json
import os
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds

def cleanup_and_check():
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

    print("--- STEP 1: Cancelling ALL open orders ---")
    try:
        res = client.cancel_all()
        print(f"Cancel All Result: {res}")
    except Exception as e:
        print(f"Cancel error: {e}")

    print("\n--- STEP 2: Checking for ANY token balances ---")
    # We'll use a known list of common asset IDs or just use the simplified markets to find tokens
    # But more reliably, we check the open positions recorded in the bot
    try:
        # Check collateral balance via allowance endpoint which usually returns it
        collateral = client.get_balance_allowance(params={"asset_type": "collateral"})
        print(f"Collateral Details: {collateral}")
    except:
        pass

if __name__ == "__main__":
    cleanup_and_check()
