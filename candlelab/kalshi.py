"""Kalshi 15-minute "up or down" markets: log the crowd's odds next to Kronos.

Read-only use of Kalshi's free public market data (no account, no key, no trading).
Each 15-minute window is one market per coin, e.g. "BTC price up in next 15 mins?",
which settles Yes if the CF Benchmarks index average over the last 60 seconds of the
window is at least the average over the 60 seconds before it opened. Windows line up
with Candle Lab's 15-minute candles.

Every live-logger run records each coin's current market prices (the crowd's odds at
about the moment Kronos makes its call) and fills in the official result once Kalshi
settles the market.
"""
import time
from datetime import datetime, timezone

import pandas as pd
import requests

from .config import LIVE_DIR

API = "https://api.elections.kalshi.com/trade-api/v2"
SERIES = {"BTC-USD": "KXBTC15M", "ETH-USD": "KXETH15M", "SOL-USD": "KXSOL15M"}
COLS = ["coin", "candle_ts", "ticker", "logged_at", "secs_into_window", "yes_bid", "yes_ask",
        "no_bid", "no_ask", "last", "strike", "result", "final_value"]
HEADERS = {"User-Agent": "candle-lab/1.0 (paper research; read-only)"}


def _get(path, params=None):
    for attempt in range(3):
        try:
            r = requests.get(API + path, params=params, headers=HEADERS, timeout=15)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _ts(iso):
    return int(pd.Timestamp(iso).timestamp())


def fetch_window(coin, window_ts):
    """The market for the 15-minute window opening at window_ts, or None."""
    data = _get("/markets", {"series_ticker": SERIES[coin], "status": "open", "limit": 10})
    for m in data.get("markets", []):
        if _ts(m["open_time"]) == window_ts:
            return m
    return None


def month_of(ts):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m")


def load():
    files = sorted(LIVE_DIR.glob("kalshi-*.csv"))
    if not files:
        return pd.DataFrame(columns=COLS)
    return pd.concat([pd.read_csv(f, dtype={"result": str, "ticker": str, "logged_at": str}) for f in files],
                     ignore_index=True)


def save(df):
    LIVE_DIR.mkdir(parents=True, exist_ok=True)
    df = df.sort_values(["candle_ts", "coin"])
    for month, part in df.groupby(df["candle_ts"].map(month_of)):
        part[COLS].to_csv(LIVE_DIR / f"kalshi-{month}.csv", index=False)


def update(window_ts, coins=tuple(SERIES)):
    """Log the crowd's odds for the window that just opened, and settle finished windows."""
    df = load()
    df["result"] = df["result"].astype("object")
    now = int(time.time())
    have = set(zip(df["coin"], df["candle_ts"]))
    rows = []
    for coin in coins:
        if (coin, window_ts) in have:
            continue
        try:
            m = fetch_window(coin, window_ts)
        except Exception as e:  # noqa: BLE001 - Kalshi being down must never stop the logger
            print(f"  kalshi {coin}: {e}")
            continue
        if not m:
            print(f"  kalshi {coin}: no open market for this window")
            continue
        rows.append({"coin": coin, "candle_ts": window_ts, "ticker": m["ticker"],
                     "logged_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                     "secs_into_window": now - window_ts,
                     "yes_bid": _f(m.get("yes_bid_dollars")), "yes_ask": _f(m.get("yes_ask_dollars")),
                     "no_bid": _f(m.get("no_bid_dollars")), "no_ask": _f(m.get("no_ask_dollars")),
                     "last": _f(m.get("last_price_dollars")), "strike": _f(m.get("floor_strike")),
                     "result": None, "final_value": None})
        print(f"  kalshi {coin}: Up {rows[-1]['yes_bid']}/{rows[-1]['yes_ask']}  ({m['ticker']})")
    if rows:
        df = pd.concat([df, pd.DataFrame(rows)], ignore_index=True)

    # Settle windows that have closed (Kalshi finalizes a few minutes after the close).
    pending = df[(df["result"].isna() | (df["result"] == "")) & (df["candle_ts"] + 900 + 60 <= now)]
    for i in pending.index[-60:]:
        try:
            m = _get(f"/markets/{df.at[i, 'ticker']}")["market"]
        except Exception as e:  # noqa: BLE001
            print(f"  kalshi settle {df.at[i, 'ticker']}: {e}")
            continue
        if m.get("result") in ("yes", "no"):
            df.at[i, "result"] = m["result"]
            df.at[i, "final_value"] = _f(m.get("expiration_value"))
    if rows or len(pending):
        save(df)
    return df
