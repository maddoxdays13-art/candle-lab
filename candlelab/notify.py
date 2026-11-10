"""Phone alerts for Strict-mode signals, through ntfy (free app, no account: https://ntfy.sh).

The live logger calls send_strict_alerts() right after it makes its calls for a new 15-minute window.
Each (coin, window) is alerted at most once (logged in results/live/alerts-YYYY-MM.csv).
The channel name comes from the NTFY_TOPIC environment variable (a GitHub secret), so it isn't public.

    python -m candlelab.notify --test     send a test notification
"""
import argparse
import os
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import requests

from .config import LIVE_DIR

SITE = "https://maddoxdays13-art.github.io/candle-lab/"
TZ = ZoneInfo("America/New_York")
ALERT_COLS = ["sent_at", "coin", "candle_ts", "direction", "kalshi_yes_bid", "kalshi_yes_ask"]


def _post(title, body, tags="zap", priority="high"):
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        print("  alerts: NTFY_TOPIC not set; skipping")
        return False
    prio = {"default": 3, "high": 4, "urgent": 5}.get(priority, 3)
    r = requests.post("https://ntfy.sh/", json={"topic": topic, "title": title, "message": body,
                                                "tags": tags.split(","), "priority": prio, "click": SITE}, timeout=15)
    r.raise_for_status()
    return True


def _alerts_log():
    files = sorted(LIVE_DIR.glob("alerts-*.csv"))
    return pd.concat([pd.read_csv(f) for f in files], ignore_index=True) if files else pd.DataFrame(columns=ALERT_COLS)


def _local(ts):
    return datetime.fromtimestamp(int(ts), tz=TZ).strftime("%-I:%M %p")


LIVE_MIN = 100  # live Strict picks needed before sizing trusts the live record over the backtest


def win_rate_for(backtest_summary, live_summary):
    """Win rate used for bet sizing, plus a one-line note saying where it came from."""
    bt_rate = backtest_summary["hit_rate"] if backtest_summary and backtest_summary.get("calls") else 0.54
    n, hits = int(live_summary.get("calls") or 0), int(live_summary.get("hits") or 0)
    if n >= LIVE_MIN:
        return hits / n, (f"Sizes use the LIVE record: {hits} of {n} right ({hits / n:.0%}). "
                          f"Backtest was {bt_rate:.0%}.")
    live = f"{hits} of {n} right so far" if n else "no picks scored yet"
    return bt_rate, (f"Sizes use the backtest win rate ({bt_rate:.0%}); live: {live}. "
                     f"After {LIVE_MIN} live picks they switch to the live record, so if it ends up lower, sizes shrink automatically.")


def size_advice(price, win_rate):
    """How much to bet on a Strict signal, as a multiple of your normal bet.
    edge = win chance - price - Kalshi fee (dollars per $1-payout contract).
    Returns (label, multiplier, edge); multiplier 0 means skip."""
    fee = 0.07 * price * (1 - price)
    edge = win_rate - price - fee
    if price > 0.55 or edge <= 0:
        return "SKIP: price too high for this signal", 0, edge
    if price < 0.40:
        return "1x (normal): unusually cheap, the move may already be against you; don't size up", 1, edge
    if edge >= 0.06:
        return "2x (max)", 2, edge
    if edge >= 0.03:
        return "1.5x", 1.5, edge
    return "1x (normal)", 1, edge


def _autopilot_bet(coin, window_ts):
    try:
        from . import autopilot
        df = autopilot.load()
        hit = df[(df["coin"] == coin) & (df["candle_ts"].astype(int) == window_ts)]
        return None if hit.empty else hit.iloc[0].to_dict()
    except Exception:  # noqa: BLE001
        return None


def send_strict_alerts(window_ts):
    """Alert for every coin whose call for the window opening at window_ts is a Strict signal."""
    from . import kalshi, site
    from .live import load_live
    df = load_live()
    w = df[df["candle_ts"] == window_ts]
    k, m = w[w["model"] == "kronos"], w[w["model"] == "momentum"][["coin", "direction"]].rename(columns={"direction": "mom"})
    if k.empty:
        return 0
    j = k.merge(m, on="coin")
    sent = _alerts_log()
    done = set(zip(sent["coin"], sent["candle_ts"]))
    try:
        ks = kalshi.load()
        ks = ks[ks["candle_ts"] == window_ts].set_index("coin")
    except Exception:  # noqa: BLE001
        ks = pd.DataFrame()
    bt = site.load_json(site.SITE_DATA_DIR / "backtest.json", {})
    live = site.load_json(site.SITE_DATA_DIR / "live.json", {})
    rows = []
    for r in j.itertuples():
        mv = abs(r.pred_close / r.last_close - 1) * 100
        is_strict = site.strict_mask([site.DIR_NUM[r.direction]], [r.confidence], [site.DIR_NUM.get(r.mom, 0)], [mv], r.coin)[0]
        if not is_strict or (r.coin, window_ts) in done:
            continue
        left = int(window_ts + 900 - time.time())
        name, side = r.coin.replace("-USD", ""), r.direction.upper()
        lines = [f"Window {_local(window_ts)}–{_local(window_ts + 900)} ET · closes in {left // 60}:{left % 60:02d}"]
        yb = ya = None
        size = ""
        s = (bt.get("coins", {}).get(r.coin, {}).get("models", {}).get("strict", {}) or {}).get("summary")
        lv = (live.get("coins", {}).get(r.coin, {}).get("models", {}).get("strict", {}) or {}).get("summary") or {}
        win, basis = win_rate_for(s, lv)
        if r.coin in ks.index and pd.notna(ks.at[r.coin, "yes_bid"]):
            yb, ya = float(ks.at[r.coin, "yes_bid"]), float(ks.at[r.coin, "yes_ask"])
            na = ks.at[r.coin, "no_ask"] if "no_ask" in ks.columns else None
            q = ya if r.direction == "up" else (float(na) if pd.notna(na) else 1 - yb)
            label, mult, edge = size_advice(q, win)
            size = " · SKIP" if mult == 0 else f" · {mult:g}x"
            lines.append(f"Your side ({side}) costs {round(q * 100)}¢ on Kalshi")
            lines.append(f"Bet size: {label}" + ("" if mult == 0 else f" (edge ≈ +{edge * 100:.0f}¢ per $1 contract)"))
        if s and s.get("calls"):
            lines.append(f"Strict mode backtest on {name}: right {s['hit_rate'] * 100:.1f}% of {s['calls']:,} picks")
        ap = _autopilot_bet(r.coin, window_ts)
        if ap is not None:
            lines.append(f"🌙 Autopilot bet ${ap['cost']:.2f} {ap['side'].upper()} at {round(ap['price'] * 100)}¢ (practice)")
        lines.append(basis)
        lines.append("Seeing this late? Re-check the price: still 55¢ or less with 5+ min left, or skip. Never more than 2x.")
        lines.append("Practice only. Not financial advice.")
        try:
            if _post(f"⚡ {name}: bet {side}{size} (Strict signal)", "\n".join(lines),
                     tags="zap," + ("chart_with_upwards_trend" if side == "UP" else "chart_with_downwards_trend")):
                rows.append({"sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), "coin": r.coin,
                             "candle_ts": window_ts, "direction": r.direction, "kalshi_yes_bid": yb, "kalshi_yes_ask": ya})
                print(f"  alert sent: {name} {side}")
        except Exception as e:  # noqa: BLE001 - an alert failing must never stop the logger
            print(f"  alert failed for {name}: {e}")
    if rows:
        new = pd.concat([sent, pd.DataFrame(rows)], ignore_index=True)
        month = datetime.fromtimestamp(window_ts, tz=timezone.utc).strftime("%Y-%m")
        part = new[new["candle_ts"].map(lambda t: datetime.fromtimestamp(int(t), tz=timezone.utc).strftime("%Y-%m")) == month]
        LIVE_DIR.mkdir(parents=True, exist_ok=True)
        part[ALERT_COLS].to_csv(LIVE_DIR / f"alerts-{month}.csv", index=False)
    return len(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--test", action="store_true", help="send a test notification")
    a = ap.parse_args()
    if a.test:
        ok = _post("✅ Candle Lab alerts are working",
                   "You'll get a notification like this whenever Strict mode fires (about 7 a day across BTC, ETH and SOL).\n"
                   "Practice only. Not financial advice.", tags="white_check_mark", priority="default")
        print("sent" if ok else "not sent (set NTFY_TOPIC)")


if __name__ == "__main__":
    main()
