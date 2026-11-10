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
        if r.coin in ks.index and pd.notna(ks.at[r.coin, "yes_bid"]):
            yb, ya = float(ks.at[r.coin, "yes_bid"]), float(ks.at[r.coin, "yes_ask"])
            lines.append(f"Kalshi crowd: Up {round(ya * 100)}¢ / Down {round((1 - yb) * 100)}¢")
        s = (bt.get("coins", {}).get(r.coin, {}).get("models", {}).get("strict", {}) or {}).get("summary")
        if s and s.get("calls"):
            lines.append(f"Strict mode backtest on {name}: right {s['hit_rate'] * 100:.1f}% of {s['calls']:,} picks")
        lines.append("Practice only. Not financial advice.")
        try:
            if _post(f"⚡ {name}: bet {side} (Strict signal)", "\n".join(lines),
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
