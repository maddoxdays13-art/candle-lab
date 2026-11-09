"""Research: does the reversal edge survive Kalshi's settlement rule?

Coinbase 15-minute candles close on the LAST TRADE price, which bounces between buyers and sellers.
That bounce alone can make "the last candle reverses" look predictive. Kalshi's 15-minute markets settle
differently: "Up" wins if the average price over the last 60 seconds of the window is at least the
average over the 60 seconds before it opened.

This re-scores recent backtest windows with a Kalshi-style rule built from 1-minute candles (the minute
before each boundary, averaged as (open + high + low + close) / 4) and compares the strategies under both
rules on the same windows.

    python -m candlelab.kalshi_rescore [--days 90]
Writes results/research/kalshi_style.json and docs/data/kalshi_style.json.
"""
import argparse
import json

import numpy as np
import pandas as pd

from . import data
from .backtest import load_coin
from .config import COINS, ROOT, SITE_DATA_DIR
from .stats import wilson

OUT = ROOT / "results" / "research" / "kalshi_style.json"


def minute_avgs(coin, start, end):
    """Approximate 60-second average price for each minute: (o+h+l+c)/4 of 1-minute candles."""
    df = data.update_history(coin, start, end, g=60)
    return pd.Series(((df["open"] + df["high"] + df["low"] + df["close"]) / 4).to_numpy(), index=df["ts"].to_numpy())


def score(name, dirs, actual, sel):
    m = sel & (dirs != 0)
    h, n = int((dirs[m] == actual[m]).sum()), int(m.sum())
    lo, hi = wilson(h, n)
    return {"strategy": name, "calls": n, "hits": h, "hit_rate": h / n if n else None, "ci_low": lo, "ci_high": hi}


def run(days):
    report = {"days": days, "coins": {}, "pooled": {}}
    pooled = {}
    for coin in COINS:
        bt = load_coin(coin).sort_values("ts").drop_duplicates("ts")
        if bt.empty:
            continue
        end = int(bt["ts"].max())
        bt = bt[bt["ts"] >= end - days * 86400].reset_index(drop=True)
        print(f"{coin}: {len(bt)} windows, downloading 1-minute candles…", flush=True)
        avg = minute_avgs(coin, int(bt["ts"].min()) - 120, end + 900)
        t = bt["ts"].to_numpy()
        # Kalshi-style: average of the minute before the window opens vs the minute before it closes
        a_open = avg.reindex(t - 60).to_numpy()
        a_close = avg.reindex(t + 900 - 60).to_numpy()
        a_prev_open = avg.reindex(t - 900 - 60).to_numpy()
        ok = ~np.isnan(a_open) & ~np.isnan(a_close) & ~np.isnan(a_prev_open)

        actual_cb = np.where(bt["close"] > bt["last_close"], 1, -1)            # Coinbase last-trade rule
        actual_k = np.where(a_close >= a_open, 1, -1)                          # Kalshi-style rule
        prev_cb = np.where(bt["last_close"] > bt["prev_close"], 1, -1)          # last candle, last-trade
        prev_k = np.where(a_open >= a_prev_open, 1, -1)                         # last window, Kalshi-style
        k = bt["kronos"].to_numpy()
        strategies = [
            ("Kronos (all calls)", k, ok),
            ("Kronos reversals", np.where(k != prev_cb, k, 0), ok),
            ("Kronos continuations", np.where(k == prev_cb, k, 0), ok),
            ("Snap-back (reverse last candle)", -prev_cb, ok),
            ("Snap-back, Kalshi-style last window", -prev_k, ok),
            ("Coin flip", np.where(np.arange(len(t)) % 2 == 0, 1, -1), ok),
        ]
        rows = {}
        for name, dirs, sel in strategies:
            rows[name] = {"coinbase_rule": score(name, dirs, actual_cb, sel), "kalshi_rule": score(name, dirs, actual_k, sel)}
            for rule in ("coinbase_rule", "kalshi_rule"):
                p = pooled.setdefault(name, {}).setdefault(rule, [0, 0])
                p[0] += rows[name][rule]["hits"]; p[1] += rows[name][rule]["calls"]
        agree = float((actual_cb[ok] == actual_k[ok]).mean())
        report["coins"][coin] = {"windows": int(ok.sum()), "from": int(t[0]), "to": int(t[-1]), "rules_agree": agree, "strategies": rows}
        print(f"  rules agree on {agree:.1%} of windows")
        for name, r in rows.items():
            print(f"  {name:40s} coinbase {r['coinbase_rule']['hit_rate']:.2%}   kalshi-style {r['kalshi_rule']['hit_rate']:.2%}   n={r['kalshi_rule']['calls']}")
    for name, rules in pooled.items():
        report["pooled"][name] = {}
        for rule, (h, n) in rules.items():
            lo, hi = wilson(h, n)
            report["pooled"][name][rule] = {"calls": n, "hits": h, "hit_rate": h / n if n else None, "ci_low": lo, "ci_high": hi}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=1))
    (SITE_DATA_DIR / "kalshi_style.json").write_text(json.dumps(report))
    print("\nPooled:")
    for name, r in report["pooled"].items():
        c, k2 = r["coinbase_rule"], r["kalshi_rule"]
        print(f"  {name:40s} coinbase {c['hit_rate']:.2%} ({c['ci_low']:.1%}-{c['ci_high']:.1%})   "
              f"kalshi-style {k2['hit_rate']:.2%} ({k2['ci_low']:.1%}-{k2['ci_high']:.1%})   n={k2['calls']}")
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=90)
    run(ap.parse_args().days)


if __name__ == "__main__":
    main()
