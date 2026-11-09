"""Build the JSON files the dashboard (docs/) reads:  python -m candlelab.site"""
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import (BACKTEST_DIR, COINS, EXPERIMENT_DIR, EXPERIMENT_FILE, SITE_DATA_DIR,
                     load_champion_state, load_json, save_json)
from .stats import clean_nans, compare, rolling_series, summarize

MODELS = ["kronos", "momentum", "coin_flip", "always_up"]
DIR_NUM = {"up": 1, "down": -1, "skip": 0}


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def section(long_df, window):
    """long_df: coin, model, ts, direction, actual_dir, ret, pct_error (scored rows)."""
    out = {}
    groups = {c: long_df[long_df["coin"] == c] for c in COINS}
    groups["ALL"] = long_df
    for coin, g in groups.items():
        models = {}
        for m in MODELS:
            sub = g[g["model"] == m].sort_values("ts")
            if coin == "ALL":  # pooled stats; P&L/rolling don't make sense across coins
                s = summarize(sub)
                s.pop("pnl_pct"), s.pop("hold_pct"), s.pop("trades")
                models[m] = {"summary": s, "rolling": []}
            else:
                models[m] = {"summary": summarize(sub), "rolling": rolling_series(sub, window)}
        vs = {b: compare(models["kronos"]["summary"], models[b]["summary"])
              for b in MODELS if b != "kronos"}
        out[coin] = {"models": models, "kronos_vs": vs}
    return out


def build_live():
    from .live import load_live
    df = load_live()
    scored = df[df["actual_close"].notna()].copy()
    long_df = pd.DataFrame({
        "coin": scored["coin"], "model": scored["model"], "ts": scored["candle_ts"].astype(int),
        "direction": scored["direction"].map(DIR_NUM),
        "actual_dir": np.where(scored["actual_close"] > scored["last_close"], 1, -1),
        "ret": scored["actual_close"] / scored["last_close"] - 1,
        "pct_error": scored["pct_error"],
    })
    # Recent table: one row per (coin, candle) with every model's call side by side.
    recent = []
    if not df.empty:
        latest = df.sort_values("candle_ts").groupby("coin").tail(60 * 6)
        for (coin, ts), g in latest.groupby(["coin", "candle_ts"]):
            by = g.set_index("model")
            k = by.loc["kronos"] if "kronos" in by.index else None
            row = {"coin": coin, "t": int(ts), "last_close": float(g["last_close"].iloc[0]),
                   "actual_close": None if pd.isna(g["actual_close"].iloc[0]) else float(g["actual_close"].iloc[0])}
            if k is not None:
                row.update(pred_close=k["pred_close"], kronos=k["direction"], conf=k["confidence"],
                           kronos_correct=None if pd.isna(k["correct"]) else int(k["correct"]),
                           pct_error=k["pct_error"])
            for m in ["momentum", "coin_flip", "always_up"]:
                if m in by.index:
                    row[m] = by.loc[m, "direction"]
                    row[m + "_correct"] = None if pd.isna(by.loc[m, "correct"]) else int(by.loc[m, "correct"])
            recent.append(row)
        recent = sorted(recent, key=lambda r: (-r["t"], r["coin"]))[:90]
    state = load_champion_state()
    out = {
        "updated_at": _now(),
        "last_run_at": df["run_at"].max() if not df.empty else None,
        "total_rows": int(len(df)), "scored_rows": int(len(scored)),
        "champion": state["champion"], "probation": state.get("probation"),
        "coins": section(long_df, window=96),
        "recent": recent,
    }
    save_json(SITE_DATA_DIR / "live.json", clean_nans(out))


def build_backtest():
    from .backtest import load_coin
    parts = []
    for coin in COINS:
        bt = load_coin(coin)
        if bt.empty:
            continue
        actual = np.where(bt["close"] > bt["last_close"], 1, -1)
        for m in MODELS:
            parts.append(pd.DataFrame({
                "coin": coin, "model": m, "ts": bt["ts"].astype(int), "direction": bt[m].astype(int),
                "actual_dir": actual, "ret": bt["close"] / bt["last_close"] - 1,
                "pct_error": (bt["pred_close"] - bt["close"]) / bt["close"] * 100 if m == "kronos" else np.nan,
            }))
    long_df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(
        columns=["coin", "model", "ts", "direction", "actual_dir", "ret", "pct_error"])
    meta = load_json(BACKTEST_DIR / "meta.json", {})
    out = {
        "updated_at": _now(), "meta": meta,
        "range": {"first": int(long_df["ts"].min()) if len(long_df) else None,
                  "last": int(long_df["ts"].max()) if len(long_df) else None},
        "coins": section(long_df, window=960),
    }
    save_json(SITE_DATA_DIR / "backtest.json", clean_nans(out))


def build_experiments():
    log_file = EXPERIMENT_DIR / "log.jsonl"
    runs = []
    if log_file.exists():
        runs = [json.loads(line) for line in log_file.read_text().splitlines() if line.strip()]
    state = load_champion_state()
    cfg = load_json(EXPERIMENT_FILE)
    out = {"updated_at": _now(), "champion": state["champion"], "previous": state.get("previous"),
           "probation": state.get("probation"), "history": state.get("history", []),
           "splits": cfg["splits"], "promotion": cfg["promotion"], "probation_days": cfg["probation_days"],
           "runs": runs[-60:]}  # last 60 days in detail
    out["champion_timeline"] = [
        {"date": r["date"], "champion_id": r["champion"]["id"],
         "tuning_hit": r["champion"]["tuning"]["ALL"]["hit_rate"],
         "tuning_pnl": np.mean([r["champion"]["tuning"][c]["pnl_pct"] for c in COINS]),
         "live_hit": (r.get("live_7d") or {}).get("hit_rate")}
        for r in runs if r.get("champion", {}).get("tuning")]
    save_json(SITE_DATA_DIR / "experiments.json", clean_nans(out))


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", choices=["live", "backtest", "experiments"])
    a = ap.parse_args()
    for name, fn in [("live", build_live), ("backtest", build_backtest), ("experiments", build_experiments)]:
        if a.only in (None, name):
            fn()


if __name__ == "__main__":
    main()
