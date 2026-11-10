"""Night autopilot: a practice account (fake money) that bets Strict-mode signals while you sleep.

Runs on GitHub with the live logger. During the hours in config/autopilot.json (default 12am-8am
Eastern) it places a paper bet on every Strict signal at Kalshi's REAL price for that window (logged a
minute or so after the window opens), only if that side costs no more than max_price, paying Kalshi's
instant-fill fee. Bets settle on Kalshi's official result. Starts with start_balance of fake money.

Ledger: results/live/autopilot.csv (one row per bet).
"""
import math
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from .config import CONFIG_DIR, LIVE_DIR, load_json

LEDGER = LIVE_DIR / "autopilot.csv"
COLS = ["placed_at", "coin", "candle_ts", "side", "price", "fee", "contracts", "cost", "status", "proceeds", "settled_at"]
DEFAULTS = {"enabled": True, "start_hour_et": 0, "end_hour_et": 8, "stake": 5.0, "start_balance": 100.0, "max_price": 0.55}
TZ = ZoneInfo("America/New_York")


def cfg():
    return {**DEFAULTS, **load_json(CONFIG_DIR / "autopilot.json", {})}


def kalshi_fee(q):
    return 0.07 * q * (1 - q)


def load():
    if not LEDGER.exists():
        return pd.DataFrame(columns=COLS)
    return pd.read_csv(LEDGER, dtype={"status": str, "side": str, "settled_at": "object", "placed_at": "object", "coin": str})


def save(df):
    LIVE_DIR.mkdir(parents=True, exist_ok=True)
    df.sort_values(["candle_ts", "coin"])[COLS].to_csv(LEDGER, index=False)


def balance(df, c=None):
    c = c or cfg()
    if df.empty:
        return float(c["start_balance"])
    return float(c["start_balance"] - df["cost"].sum() + pd.to_numeric(df["proceeds"], errors="coerce").fillna(0).sum())


def in_hours(window_ts, c):
    h = datetime.fromtimestamp(window_ts, tz=TZ).hour
    a, b = int(c["start_hour_et"]), int(c["end_hour_et"])
    return a <= h < b if a < b else (h >= a or h < b)


def strict_signals(window_ts):
    """[(coin, 'up'|'down')] for Strict signals in the window opening at window_ts."""
    from . import site
    from .live import load_live
    df = load_live()
    w = df[df["candle_ts"] == window_ts]
    k = w[w["model"] == "kronos"]
    m = w[w["model"] == "momentum"][["coin", "direction"]].rename(columns={"direction": "mom"})
    out = []
    for r in k.merge(m, on="coin").itertuples():
        if r.direction not in ("up", "down"):
            continue
        mv = abs(r.pred_close / r.last_close - 1) * 100
        if site.strict_mask([site.DIR_NUM[r.direction]], [r.confidence], [site.DIR_NUM.get(r.mom, 0)], [mv], r.coin)[0]:
            out.append((r.coin, r.direction))
    return out


def run(window_ts):
    """Place tonight's bets for this window and settle finished ones. Returns {coin: bet row} placed now."""
    from . import kalshi
    c = cfg()
    df = load()
    ks = kalshi.load()
    placed = {}

    # settle open bets with Kalshi's official result
    res = ks.set_index(["coin", "candle_ts"])["result"] if not ks.empty else pd.Series(dtype=str)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    for i in df.index[df["status"] == "open"]:
        key = (df.at[i, "coin"], int(df.at[i, "candle_ts"]))
        r = res.get(key) if key in res.index else None
        if isinstance(r, str) and r in ("yes", "no"):
            won = (r == "yes") == (df.at[i, "side"] == "up")
            df.at[i, "status"] = "won" if won else "lost"
            df.at[i, "proceeds"] = float(df.at[i, "contracts"]) if won else 0.0
            df.at[i, "settled_at"] = now

    if c["enabled"] and in_hours(window_ts, c):
        have = set(zip(df["coin"], df["candle_ts"].astype(int)))
        prices = ks[ks["candle_ts"] == window_ts].set_index("coin") if not ks.empty else pd.DataFrame()
        for coin, side in strict_signals(window_ts):
            if (coin, window_ts) in have or coin not in prices.index:
                continue
            p = prices.loc[coin]
            q = float(p["yes_ask"] if side == "up" else p["no_ask"])
            if not (0 < q <= float(c["max_price"])):
                print(f"  autopilot: skip {coin} {side} at {q:.2f} (above {c['max_price']:.2f})")
                continue
            per = q + kalshi_fee(q)
            n = math.floor(float(c["stake"]) / per)
            if n < 1 or n * per > balance(df, c):
                print(f"  autopilot: skip {coin} (not enough practice money)")
                continue
            row = {"placed_at": now, "coin": coin, "candle_ts": window_ts, "side": side, "price": q,
                   "fee": round(kalshi_fee(q) * n, 4), "contracts": n, "cost": round(n * per, 4),
                   "status": "open", "proceeds": np.nan, "settled_at": None}
            df = pd.concat([df, pd.DataFrame([row])], ignore_index=True)
            placed[coin] = row
            print(f"  autopilot: bet {n} x {side.upper()} {coin} at {q:.2f}")
    if placed or (df["status"] != "open").any() or LEDGER.exists():
        save(df)
    return placed


def summary():
    c = cfg()
    df = load()
    done = df[df["status"].isin(["won", "lost"])]
    wins = int((done["status"] == "won").sum())
    net = float(pd.to_numeric(done["proceeds"], errors="coerce").fillna(0).sum() - done["cost"].sum())
    return {"config": c, "balance": balance(df, c), "bets": int(len(df)), "open": int((df["status"] == "open").sum()),
            "wins": wins, "losses": int(len(done)) - wins, "net": net,
            "roi": net / float(done["cost"].sum()) if len(done) else None,
            "recent": df.sort_values("candle_ts", ascending=False).head(60).replace({np.nan: None}).to_dict("records")}
