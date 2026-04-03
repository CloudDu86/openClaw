"""
01_import_local_data.py
-----------------------
Scans data/raw_csv/ for all *_1d.csv files, extracts the symbol list
dynamically, then processes 1d / 4h / 1h CSV files for each symbol and
saves them as Parquet under data/raw/{symbol}/{tf}.parquet.

Expected CSV column headers (MetaTrader / HistData style):
  <DTYYYYMMDD>, <TIME>, <OPEN>, <HIGH>, <LOW>, <CLOSE>, <VOL>
"""

import glob
import os
import warnings

import pandas as pd

# ── paths ────────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_CSV_DIR = os.environ.get(
    "RAW_CSV_DIR",
    os.path.join(BASE_DIR, "data", "raw_csv"),
)
OUT_DIR = os.environ.get(
    "RAW_OUT_DIR",
    os.path.join(BASE_DIR, "data", "raw"),
)

TIMEFRAMES = ["1d", "4h", "1h"]


# ── helpers ──────────────────────────────────────────────────────────────────
def discover_symbols() -> list[str]:
    """Return sorted list of symbols found in data/raw_csv/ via *_1d.csv."""
    pattern = os.path.join(RAW_CSV_DIR, "*_1d.csv")
    files = glob.glob(pattern)
    if not files:
        print(f"[WARN] No *_1d.csv files found in {RAW_CSV_DIR}")
        return []
    symbols = sorted(
        os.path.basename(f).replace("_1d.csv", "").upper() for f in files
    )
    print(f"[INFO] Discovered {len(symbols)} symbol(s): {', '.join(symbols)}")
    return symbols


def load_csv(path: str) -> pd.DataFrame:
    """
    Read a MetaTrader-style CSV and return a clean DataFrame with a
    DatetimeIndex and columns: Open, High, Low, Close, Volume.
    """
    df = pd.read_csv(
        path,
        dtype={"<DTYYYYMMDD>": str, "<TIME>": str},
    )

    # Normalise column names (strip whitespace / angle brackets)
    df.columns = [c.strip() for c in df.columns]

    # Accept both <TIME> styles: "0000" / "000000" / bare int
    time_col = df["<TIME>"].str.zfill(4).str[:4]   # keep only HHMM

    dt_series = pd.to_datetime(
        df["<DTYYYYMMDD>"] + time_col, format="%Y%m%d%H%M"
    )

    out = pd.DataFrame(
        {
            "Open":   pd.to_numeric(df["<OPEN>"],  errors="coerce"),
            "High":   pd.to_numeric(df["<HIGH>"],  errors="coerce"),
            "Low":    pd.to_numeric(df["<LOW>"],   errors="coerce"),
            "Close":  pd.to_numeric(df["<CLOSE>"], errors="coerce"),
            "Volume": pd.to_numeric(df.get("<VOL>", df.get("<TICKVOL>", 0)),
                                    errors="coerce").fillna(0),
        },
        index=dt_series,
    )
    out.index.name = "Datetime"
    out.sort_index(inplace=True)
    return out


def process_symbol(symbol: str) -> None:
    """Process all available timeframes for one symbol."""
    print(f"\n[INFO] ── Processing {symbol} ──")
    found_any = False

    for tf in TIMEFRAMES:
        csv_path = os.path.join(RAW_CSV_DIR, f"{symbol.upper()}_{tf}.csv")

        if not os.path.exists(csv_path):
            # Also try lowercase symbol name
            csv_path_lower = os.path.join(
                RAW_CSV_DIR, f"{symbol.lower()}_{tf}.csv"
            )
            if os.path.exists(csv_path_lower):
                csv_path = csv_path_lower
            else:
                print(f"  [WARN] {symbol} {tf}: file not found, skipping.")
                continue

        try:
            df = load_csv(csv_path)
            out_dir = os.path.join(OUT_DIR, symbol.upper())
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, f"{tf}.parquet")
            df.to_parquet(out_path)
            print(
                f"  [OK]   {symbol} {tf}: {len(df):,} rows → {out_path}"
            )
            found_any = True
        except Exception as exc:
            print(f"  [ERROR] {symbol} {tf}: {exc}")

    if not found_any:
        print(f"  [WARN] No data processed for {symbol}.")


# ── main ─────────────────────────────────────────────────────────────────────
def main() -> None:
    warnings.filterwarnings("ignore", category=pd.errors.DtypeWarning)

    symbols = discover_symbols()
    if not symbols:
        print("[ERROR] Nothing to process. Add CSV files to data/raw_csv/ and retry.")
        return

    for symbol in symbols:
        process_symbol(symbol)

    print("\n[DONE] Import complete.")


if __name__ == "__main__":
    main()
