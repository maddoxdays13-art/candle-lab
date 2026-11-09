"""Free public candle data: Coinbase Exchange first, Kraken as a fallback.

Every function here returns only *closed* candles (the still-forming candle is
dropped) on a regular 15-minute grid, with timestamps as UTC epoch seconds of
each candle's open time.
"""
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests

from .config import CANDLE_DIR, GRANULARITY

COINBASE_URL = "https://api.exchange.coinbase.com/products/{product}/candles"
COINBASE_MAX = 300           # candles per request (API limit)
COINBASE_PAUSE = 0.35        # seconds between requests (public limit is ~10 req/s)
KRAKEN_URL = "https://api.kraken.com/0/public/OHLC"
KRAKEN_PAIRS = {"BTC-USD": "XBTUSD", "ETH-USD": "ETHUSD", "SOL-USD": "SOLUSD"}
HEADERS = {"User-Agent": "candle-lab/1.0 (paper-trading research)"}
COLS = ["ts", "open", "high", "low", "close", "volume"]


def now_ts():
    return int(time.time())


def last_closed_open_ts(now=None):
    """Open time of the most recent candle that has fully closed."""
    now = now_ts() if now is None else now
    return (now // GRANULARITY) * GRANULARITY - GRANULARITY


def _get(url, params, tries=5):
    delay = 1.0
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=20)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as e:
            if attempt == tries - 1:
                raise
            print(f"  request failed ({e}); retrying in {delay:.0f}s")
            time.sleep(delay)
            delay *= 2


def _iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_coinbase(product, start_ts, end_ts):
    """Candles with open time in [start_ts, end_ts], paging 300 at a time."""
    rows = []
    cursor = start_ts
    while cursor <= end_ts:
        chunk_end = min(cursor + (COINBASE_MAX - 1) * GRANULARITY, end_ts)
        data = _get(COINBASE_URL.format(product=product),
                    {"granularity": GRANULARITY, "start": _iso(cursor), "end": _iso(chunk_end)})
        if isinstance(data, dict):  # error payload, e.g. {"message": ...}
            raise RuntimeError(f"Coinbase error: {data}")
        # Coinbase rows: [time, low, high, open, close, volume], newest first
        rows.extend((r[0], r[3], r[2], r[1], r[4], r[5]) for r in data)
        cursor = chunk_end + GRANULARITY
        time.sleep(COINBASE_PAUSE)
    return pd.DataFrame(rows, columns=COLS)


def fetch_kraken(product):
    """Kraken only serves the most recent 720 candles, so it is a live-only fallback."""
    data = _get(KRAKEN_URL, {"pair": KRAKEN_PAIRS[product], "interval": GRANULARITY // 60})
    if data.get("error"):
        raise RuntimeError(f"Kraken error: {data['error']}")
    key = next(k for k in data["result"] if k != "last")
    # Kraken rows: [time, open, high, low, close, vwap, volume, count]
    rows = [(int(r[0]), r[1], r[2], r[3], r[4], r[6]) for r in data["result"][key]]
    return pd.DataFrame(rows, columns=COLS)


def clean(df, end_ts=None):
    """Sort, de-duplicate, drop unclosed candles and fill gaps on a regular grid.

    Coinbase omits candles with no trades; Kronos expects a regular series, so a
    missing slot becomes a flat candle at the previous close with zero volume.
    """
    end_ts = last_closed_open_ts() if end_ts is None else end_ts
    df = df.astype({"ts": "int64"})
    for c in COLS[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    df = (df.drop_duplicates("ts", keep="last").sort_values("ts"))
    df = df[df["ts"] <= end_ts]
    df = df[df["ts"] % GRANULARITY == 0]
    if df.empty:
        return df.reset_index(drop=True)
    grid = np.arange(df["ts"].iloc[0], df["ts"].iloc[-1] + GRANULARITY, GRANULARITY)
    df = df.set_index("ts").reindex(grid)
    df["close"] = df["close"].ffill()
    for c in ["open", "high", "low"]:
        df[c] = df[c].fillna(df["close"])
    df["volume"] = df["volume"].fillna(0.0)
    df.index.name = "ts"
    return df.reset_index()


def fetch_recent(product, n_candles):
    """The latest n closed candles. Coinbase first, Kraken if Coinbase fails."""
    end_ts = last_closed_open_ts()
    start_ts = end_ts - (n_candles - 1) * GRANULARITY
    try:
        df = clean(fetch_coinbase(product, start_ts, end_ts), end_ts)
        source = "coinbase"
        if df.empty or df["ts"].iloc[-1] < end_ts - 2 * GRANULARITY:
            raise RuntimeError("Coinbase data is stale")
    except Exception as e:  # noqa: BLE001 - any failure triggers the fallback
        print(f"  Coinbase failed for {product}: {e}; falling back to Kraken")
        df = clean(fetch_kraken(product), end_ts)
        source = "kraken"
    return df[df["ts"] >= start_ts].reset_index(drop=True), source


def history_path(product):
    return CANDLE_DIR / f"{product}.csv"


def load_history(product):
    path = history_path(product)
    if not path.exists():
        return pd.DataFrame(columns=COLS)
    return pd.read_csv(path)


def update_history(product, start_ts, end_ts=None):
    """Make sure data/candles/<product>.csv covers [start_ts, end_ts]; returns it.

    Only fetches what is missing, so repeated calls are cheap. Coinbase only;
    Kraken cannot serve history.
    """
    end_ts = last_closed_open_ts() if end_ts is None else end_ts
    df = load_history(product)
    parts = [df]
    if df.empty or df["ts"].iloc[0] > start_ts:
        first = df["ts"].iloc[0] - GRANULARITY if not df.empty else end_ts
        print(f"  {product}: downloading {_iso(start_ts)} .. {_iso(first)}")
        parts.append(fetch_coinbase(product, start_ts, first))
    last = df["ts"].iloc[-1] if not df.empty else None
    if last is not None and last < end_ts:
        print(f"  {product}: updating {_iso(last + GRANULARITY)} .. {_iso(end_ts)}")
        parts.append(fetch_coinbase(product, last + GRANULARITY, end_ts))
    if len(parts) > 1:
        df = clean(pd.concat([p for p in parts if not p.empty]), end_ts)
        CANDLE_DIR.mkdir(parents=True, exist_ok=True)
        df.to_csv(history_path(product), index=False)
    return df[(df["ts"] >= start_ts) & (df["ts"] <= end_ts)].reset_index(drop=True)


def to_ts(date_str):
    """'2024-07-01' -> epoch seconds (UTC midnight)."""
    return int(pd.Timestamp(date_str, tz="UTC").timestamp())
