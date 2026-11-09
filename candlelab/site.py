"""Build the JSON files the dashboard (docs/) reads:  python -m candlelab.site"""
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import (BACKTEST_DIR, LIVE_DIR, COINS, EXPERIMENT_DIR, EXPERIMENT_FILE, SITE_DATA_DIR,
                     load_champion_state, load_json, save_json)
from .stats import (bet_fee, bet_pnl, calibration, clean_nans, coins_differ, compare, rolling_series,
                    summarize, wilson)
from .config import BET_VENUES, FEE_PRESETS

MODELS = ["kronos", "momentum", "coin_flip", "always_up", "kronos_rev", "snapback"]
# kronos_rev: only Kronos's reversal calls (it calls the opposite of the last candle); otherwise skip.
# snapback:   always bet the last candle reverses (the simple rule Kronos's reversals have to beat).


def add_derived(bt):
    """Derived strategies from the logged Kronos and momentum calls (momentum = last candle's direction)."""
    bt = bt.copy()
    bt["kronos_rev"] = np.where((bt["kronos"] != 0) & (bt["kronos"] != bt["momentum"]), bt["kronos"], 0)
    bt["snapback"] = -bt["momentum"]
    return bt


def derived_live_rows(long_df):
    """Same two strategies for the live log (built from the kronos and momentum rows of each candle)."""
    k = long_df[long_df["model"] == "kronos"]
    m = long_df[long_df["model"] == "momentum"][["coin", "ts", "direction"]].rename(columns={"direction": "mom"})
    j = k.merge(m, on=["coin", "ts"])
    rev = j.assign(model="kronos_rev", direction=np.where((j["direction"] != 0) & (j["direction"] != j["mom"]), j["direction"], 0),
                   pct_error=np.nan, conf=np.nan).drop(columns="mom")
    snap = j.assign(model="snapback", direction=-j["mom"], pct_error=np.nan, conf=np.nan).drop(columns="mom")
    return pd.concat([long_df, rev, snap], ignore_index=True)
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
                for k in ("pnl_pct", "hold_pct", "trades", "pnl_by_fee", "hold_by_fee"):
                    s.pop(k)
                models[m] = {"summary": s, "rolling": []}
            else:
                models[m] = {"summary": summarize(sub), "rolling": rolling_series(sub, window)}
        vs = {b: compare(models["kronos"]["summary"], models[b]["summary"])
              for b in MODELS if b != "kronos"}
        cal = calibration(g[g["model"] == "kronos"]) if "conf" in g else []
        out[coin] = {"models": models, "kronos_vs": vs, "calibration": cal}
    return out


def coin_compare(sec):
    """Kronos side by side on each coin, plus: do the coins really differ, or is it luck?"""
    rows = []
    for coin in COINS:
        if coin not in sec:
            continue
        k = sec[coin]["models"]["kronos"]["summary"]
        rows.append({"coin": coin, "calls": k["calls"], "hit_rate": k["hit_rate"], "ci_low": k["ci_low"], "ci_high": k["ci_high"],
                     "p_vs_50": k["p_vs_50"], "vs_momentum": sec[coin]["kronos_vs"]["momentum"],
                     "vs_coin_flip": sec[coin]["kronos_vs"]["coin_flip"], "pnl_by_fee": k.get("pnl_by_fee"),
                     "bets": k.get("bets")})
    p = coins_differ({r["coin"]: (sec[r["coin"]]["models"]["kronos"]["summary"]["hits"], r["calls"]) for r in rows})
    best = max((r for r in rows if r["calls"]), key=lambda r: r["hit_rate"], default=None)
    return {"rows": rows, "p_differ": p, "best": best["coin"] if best else None}


def kalshi_section(pred):
    """Kronos vs the Kalshi crowd on the same 15-minute windows (live only)."""
    from . import kalshi
    k = kalshi.load()
    out = {"windows": int(len(k)), "settled": 0, "coins": {}, "recent": [], "curve": [], "now": {}}
    if k.empty:
        return out
    kr = pred[pred["model"] == "kronos"][["coin", "candle_ts", "direction", "confidence", "pred_close"]]
    mo = pred[pred["model"] == "momentum"][["coin", "candle_ts", "direction"]].rename(columns={"direction": "mom"})
    m = k.merge(kr, on=["coin", "candle_ts"], how="left").merge(mo, on=["coin", "candle_ts"], how="left")
    m["p_up"] = np.where(m["direction"] == "up", m["confidence"], np.where(m["direction"] == "down", 1 - m["confidence"], 0.5))
    for c in ["yes_bid", "yes_ask", "no_bid", "no_ask"]:
        m[c] = pd.to_numeric(m[c], errors="coerce")
    m["mid"] = ((m["yes_bid"] + m["yes_ask"]) / 2).clip(0.01, 0.99)
    # odds right now (latest window per coin) for the Live page
    latest = m.sort_values("candle_ts").groupby("coin").tail(1)
    out["now"] = {r.coin: {"t": int(r.candle_ts), "yes_bid": r.yes_bid, "yes_ask": r.yes_ask, "secs": r.secs_into_window}
                  for r in latest.itertuples()}

    s = m[m["result"].isin(["yes", "no"]) & m["yes_ask"].between(0.01, 0.99) & m["no_ask"].between(0.01, 0.99)].copy()
    out["settled"] = int(len(s))
    if s.empty:
        return out
    s["up"] = (s["result"] == "yes").astype(int)
    s["call"] = s["direction"].isin(["up", "down"])
    s["k_won"] = ((s["direction"] == "up") == (s["up"] == 1)) & s["call"]
    s["price"] = np.where(s["direction"] == "up", s["yes_ask"], s["no_ask"])   # buy Kronos's side at the ask
    s["k_prob"] = np.where(s["direction"] == "up", s["p_up"], 1 - s["p_up"])
    for v in BET_VENUES:
        s[f"follow_{v}"] = np.where(s["call"], bet_pnl(s["k_won"], s["price"], v), 0.0)
        # value bet: only when Kronos's own chance beats the price + fee by 2 points
        s[f"value_{v}"] = np.where(s["call"] & (s["k_prob"] > s["price"] + bet_fee(v, s["price"]) + 0.02),
                                   s[f"follow_{v}"], 0.0)
    s["value_bet"] = s["call"] & (s["k_prob"] > s["price"] + bet_fee("kalshi_taker", s["price"]) + 0.02)
    s["rev"] = s["call"] & s["mom"].isin(["up", "down"]) & (s["direction"] != s["mom"])
    for v in BET_VENUES:
        s[f"rev_{v}"] = np.where(s["rev"], s[f"follow_{v}"], 0.0)

    def stats_for(g):
        calls = g[g["call"]]
        kh, kn = int(calls["k_won"].sum()), len(calls)
        fav = (g["mid"] > 0.5).astype(int) == g["up"]
        fh, fn = int(fav[g["mid"] != 0.5].sum()), int((g["mid"] != 0.5).sum())
        has_p = g["direction"].notna()
        lo, hi = wilson(kh, kn)
        return {
            "windows": int(len(g)), "kronos_calls": kn, "kronos_hits": kh, "kronos_hit": kh / kn if kn else None,
            "kronos_ci": [lo, hi], "crowd_calls": fn, "crowd_hit": fh / fn if fn else None,
            "brier_kronos": float(((g.loc[has_p, "p_up"] - g.loc[has_p, "up"]) ** 2).mean()) if has_p.any() else None,
            "brier_crowd": float(((g.loc[has_p, "mid"] - g.loc[has_p, "up"]) ** 2).mean()) if has_p.any() else None,
            "follow": {v: float(g[f"follow_{v}"].sum()) for v in BET_VENUES},
            "value": {v: float(g[f"value_{v}"].sum()) for v in BET_VENUES},
            "value_bets": int(g["value_bet"].sum()),
            "rev": {v: float(g[f"rev_{v}"].sum()) for v in BET_VENUES},
            "rev_bets": int(g["rev"].sum()), "rev_hits": int((g["rev"] & g["k_won"]).sum()),
            "avg_price": float(calls["price"].mean()) if kn else None,
        }

    out["coins"] = {c: stats_for(g) for c, g in s.groupby("coin")}
    out["coins"]["ALL"] = stats_for(s)
    s = s.sort_values("candle_ts")
    cum = s[[f"follow_{v}" for v in BET_VENUES] + [f"value_{v}" for v in BET_VENUES] + [f"rev_{v}" for v in BET_VENUES]].cumsum()
    step = max(1, len(s) // 300)
    out["curve"] = [{"t": int(t), **{c: round(float(cum.iloc[i][c]), 2) for c in cum.columns}}
                    for i, t in enumerate(s["candle_ts"]) if i % step == 0 or i == len(s) - 1]
    out["recent"] = [{"t": int(r.candle_ts), "coin": r.coin, "yes_bid": r.yes_bid, "yes_ask": r.yes_ask,
                      "mid": r.mid, "dir": r.direction if isinstance(r.direction, str) else None,
                      "p_up": r.p_up, "result": r.result, "price": r.price if r.call else None,
                      "pnl": round(float(getattr(r, "follow_kalshi_taker")), 3) if r.call else None,
                      "value_bet": bool(r.value_bet)}
                     for r in s.tail(60).iloc[::-1].itertuples()]
    return out


def write_calibration_csv(sec, path):
    """The calibration numbers as a plain CSV data file (one row per coin x confidence bin)."""
    rows = [{"coin": coin, **{k: r[k] for k in ["bin", "stated", "calls", "hits", "actual", "ci_low", "ci_high", "verdict"]}}
            for coin, d in sec.items() for r in d["calibration"]]
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).round(4).to_csv(path, index=False)


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
        "conf": scored["confidence"].where(scored["model"] == "kronos"),
    })
    long_df = derived_live_rows(long_df)
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
    # Kronos's calls for the price charts: last 3 days per coin.
    marks = {}
    k = df[df["model"] == "kronos"].sort_values("candle_ts")
    for coin, g in k.groupby("coin"):
        g = g.tail(300)
        marks[coin] = [{"t": int(r.candle_ts), "dir": r.direction, "conf": r.confidence,
                        "last": r.last_close, "pred": r.pred_close,
                        "actual": None if pd.isna(r.actual_close) else r.actual_close,
                        "ok": None if pd.isna(r.correct) else int(r.correct)} for r in g.itertuples()]
    state = load_champion_state()
    out = {
        "updated_at": _now(),
        "marks": marks,
        "last_run_at": df["run_at"].max() if not df.empty else None,
        "total_rows": int(len(df)), "scored_rows": int(len(scored)),
        "champion": state["champion"], "probation": state.get("probation"),
        "coins": section(long_df, window=96),
        "recent": recent,
        "kalshi": kalshi_section(df),
    }
    out["coin_compare"] = coin_compare(out["coins"])
    write_calibration_csv(out["coins"], LIVE_DIR / "calibration.csv")
    save_json(SITE_DATA_DIR / "live.json", clean_nans(out))


def build_backtest():
    from .backtest import load_coin
    parts = []
    for coin in COINS:
        bt = load_coin(coin)
        if bt.empty:
            continue
        bt = add_derived(bt)
        actual = np.where(bt["close"] > bt["last_close"], 1, -1)
        for m in MODELS:
            parts.append(pd.DataFrame({
                "coin": coin, "model": m, "ts": bt["ts"].astype(int), "direction": bt[m].astype(int),
                "actual_dir": actual, "ret": bt["close"] / bt["last_close"] - 1,
                "pct_error": (bt["pred_close"] - bt["close"]) / bt["close"] * 100 if m == "kronos" else np.nan,
                "conf": bt["kronos_conf"] if m == "kronos" else np.nan,
            }))
    long_df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(
        columns=["coin", "model", "ts", "direction", "actual_dir", "ret", "pct_error", "conf"])
    meta = load_json(BACKTEST_DIR / "meta.json", {})
    out = {
        "updated_at": _now(), "meta": meta,
        "range": {"first": int(long_df["ts"].min()) if len(long_df) else None,
                  "last": int(long_df["ts"].max()) if len(long_df) else None},
        "coins": section(long_df, window=960),
    }
    out["coin_compare"] = coin_compare(out["coins"])
    out["timeframes"] = build_timeframes()
    write_calibration_csv(out["coins"], BACKTEST_DIR / "calibration.csv")
    save_json(SITE_DATA_DIR / "backtest.json", clean_nans(out))
    build_trials()


def _long_from_bt(bt, coin):
    actual = np.where(bt["close"] > bt["last_close"], 1, -1)
    parts = []
    for m in MODELS:
        parts.append(pd.DataFrame({
            "coin": coin, "model": m, "ts": bt["ts"].astype(int), "direction": bt[m].astype(int), "actual_dir": actual,
            "ret": bt["close"] / bt["last_close"] - 1,
            "pct_error": (bt["pred_close"] - bt["close"]) / bt["close"] * 100 if m == "kronos" else np.nan,
            "conf": bt["kronos_conf"] if m == "kronos" else np.nan}))
    return pd.concat(parts, ignore_index=True)


def move_stats(ret):
    """How much the price typically moves over one candle of this timeframe (in %)."""
    a = np.abs(np.asarray(ret, float)) * 100
    if not len(a):
        return None
    return {"avg": float(a.mean()), "median": float(np.median(a)), "p90": float(np.percentile(a, 90)),
            "up_share": float((np.asarray(ret) > 0).mean()),
            # share of candles that moved more than each round-trip trading cost
            "beats_fee": {k: float((a > 2 * f * 100).mean()) for k, f in FEE_PRESETS.items()}}


def build_timeframes():
    """Kronos on 15-minute, 1-hour, 6-hour and daily candles, side by side."""
    from .backtest import HORIZONS, horizon_dir, load_coin
    out = {}
    for h in HORIZONS:
        per = {}
        longs = []
        for coin in COINS:
            bt = load_coin(coin, horizon_dir(h))
            if bt.empty:
                continue
            bt = add_derived(bt.sort_values("ts").drop_duplicates("ts"))
            lg = _long_from_bt(bt, coin)
            longs.append(lg)
            per[coin] = _tf_entry(lg, bt["close"] / bt["last_close"] - 1, bt)
        if longs:
            lg = pd.concat(longs, ignore_index=True)
            per["ALL"] = _tf_entry(lg, lg[lg["model"] == "kronos"]["ret"], None)
            out[h] = per
    # Does the timeframe matter for Kronos, or could the differences be luck?
    for coin in COINS + ["ALL"]:
        hits = {h: (out[h][coin]["kronos"]["hits"], out[h][coin]["kronos"]["calls"]) for h in out if coin in out[h]}
        p = coins_differ(hits)
        for h in out:
            if coin in out[h]:
                out[h][coin]["p_differ"] = p
    return out


def _tf_entry(lg, ret, bt):
    e = {"moves": move_stats(ret)}
    for m in MODELS:
        sub = lg[lg["model"] == m].sort_values("ts")
        sm = summarize(sub)
        e[m] = {k: sm.get(k) for k in ["calls", "hits", "hit_rate", "ci_low", "ci_high", "coverage", "p_vs_50", "bets", "pnl_by_fee", "hold_by_fee", "trades", "candles"]}
    e["kronos_vs"] = {b: compare(e["kronos"], e[b]) for b in ["momentum", "coin_flip", "always_up", "snapback"]}
    e["rev_vs_snapback"] = compare(e["kronos_rev"], e["snapback"])
    if bt is not None:
        e["first"], e["last"] = int(bt["ts"].iloc[0]), int(bt["ts"].iloc[-1])
    return e


def build_trials():
    """Compact per-candle backtest forecasts for the Trials page (re-scored in the browser).
    One file per coin: start time + parallel integer arrays, one entry per 15-minute candle:
      p   Kronos's share of 'up' samples x 100
      m   Kronos's predicted move, basis points (0.01%)
      r   what actually happened, basis points
      u   1 if the previous candle went up (momentum)"""
    from .backtest import HORIZONS, horizon_dir, load_coin
    for (h, g), coin in [(hg, c) for hg in HORIZONS.items() for c in COINS]:
        bt = load_coin(coin, horizon_dir(h))
        if bt.empty:
            continue
        bt = bt.sort_values("ts").drop_duplicates("ts")
        out = {"coin": coin, "horizon": h, "t0": int(bt["ts"].iloc[0]), "step": g, "ts": None,
               "p": (bt["p_up"] * 100).round().astype(int).tolist(),
               "m": ((bt["pred_close"] / bt["last_close"] - 1) * 1e4).round().clip(-30000, 30000).astype(int).tolist(),
               "r": ((bt["close"] / bt["last_close"] - 1) * 1e4).round(1).clip(-30000, 30000).tolist(),
               "u": (bt["last_close"] > bt["prev_close"]).astype(int).tolist()}
        gaps = (np.diff(bt["ts"].to_numpy()) != g).any()
        if gaps:  # only send timestamps when the series isn't perfectly regular
            out["ts"] = bt["ts"].astype(int).tolist()
        path = SITE_DATA_DIR / (f"trials-{coin}.json" if h == "15m" else f"trials-{coin}-{h}.json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, separators=(",", ":")))


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
    ap.add_argument("--only", choices=["live", "backtest", "experiments", "trials"])
    a = ap.parse_args()
    for name, fn in [("live", build_live), ("backtest", build_backtest), ("experiments", build_experiments),
                     ("trials", build_trials)]:
        if a.only in (None, name):
            fn()


if __name__ == "__main__":
    main()
