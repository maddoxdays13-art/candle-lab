"""Hit rates, confidence ranges, significance tests and paper P&L."""
import math

import numpy as np
import pandas as pd

from .config import FEE, FEE_PRESETS


def wilson(hits, n, z=1.96):
    """95% Wilson score interval for a hit rate. Returns (low, high)."""
    if n == 0:
        return (None, None)
    p = hits / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (centre - half, centre + half)


def _norm_sf(z):
    return 0.5 * math.erfc(z / math.sqrt(2))


def p_better(h1, n1, h2, n2, margin=0.0):
    """One-sided p-value that rate1 - rate2 > margin (two-proportion z-test)."""
    if n1 == 0 or n2 == 0:
        return 1.0
    p1, p2 = h1 / n1, h2 / n2
    se = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
    if se == 0:
        return 0.0 if p1 - p2 > margin else 1.0
    return _norm_sf((p1 - p2 - margin) / se)


def p_vs_half(hits, n):
    """One-sided p-value that a hit rate is above 50% (normal approximation)."""
    if n == 0:
        return 1.0
    return _norm_sf((hits - 0.5 * n) / math.sqrt(0.25 * n))


def paper_pnl(direction, ret, fee=FEE):
    """Long/flat paper trading: hold the coin for the candle when the call is
    'up', sit in cash otherwise. `fee` is charged on every buy and every sell.

    Returns (strategy_equity, hold_equity, n_trades) as arrays starting at 1.0
    (hold pays one buy fee up front).
    """
    direction = np.asarray(direction)
    ret = np.asarray(ret, float)
    pos = (direction == 1).astype(float)
    prev = np.concatenate([[0.0], pos[:-1]])
    trades = np.abs(pos - prev)
    strat = np.cumprod((1 + pos * ret) * (1 - fee * trades))
    hold = (1 - fee) * np.cumprod(1 + ret)
    return strat, hold, int(trades.sum())


def summarize(df):
    """Summary for one coin+model. df needs ts, direction, actual_dir, ret,
    pct_error (rows already scored), sorted by ts."""
    called = df[df["direction"] != 0]
    n = len(called)
    hits = int((called["direction"] == called["actual_dir"]).sum())
    lo, hi = wilson(hits, n)
    strat, hold, trades = paper_pnl(df["direction"].to_numpy(), df["ret"].to_numpy())
    by_fee, hold_by_fee = {}, {}
    for k, f in FEE_PRESETS.items():
        s_, h_, _ = paper_pnl(df["direction"].to_numpy(), df["ret"].to_numpy(), fee=f)
        by_fee[k] = float((s_[-1] - 1) * 100) if len(df) else 0.0
        hold_by_fee[k] = float((h_[-1] - 1) * 100) if len(df) else 0.0
    return {
        "candles": int(len(df)),
        "calls": n,
        "hits": hits,
        "hit_rate": hits / n if n else None,
        "ci_low": lo,
        "ci_high": hi,
        "coverage": n / len(df) if len(df) else None,
        "p_vs_50": p_vs_half(hits, n),
        "mean_abs_pct_error": float(df["pct_error"].abs().mean()) if "pct_error" in df and df["pct_error"].notna().any() else None,
        "pnl_pct": float((strat[-1] - 1) * 100) if len(df) else 0.0,
        "hold_pct": float((hold[-1] - 1) * 100) if len(df) else 0.0,
        "trades": trades,
        "pnl_by_fee": by_fee,
        "hold_by_fee": hold_by_fee,
    }


def rolling_series(df, window, max_points=300):
    """Rolling hit rate over the last `window` calls, plus equity curves,
    thinned to at most max_points points for the dashboard."""
    if df.empty:
        return []
    called = df["direction"] != 0
    hit = (df["direction"] == df["actual_dir"]) & called
    roll_hits = hit.astype(float).rolling(window, min_periods=1).sum()
    roll_calls = called.astype(float).rolling(window, min_periods=1).sum()
    # Hide the rolling rate until there are enough calls for it to mean anything.
    rate = (roll_hits / roll_calls.where(roll_calls >= max(10, window // 4))).to_numpy()
    d, r = df["direction"].to_numpy(), df["ret"].to_numpy()
    curves = {k: paper_pnl(d, r, fee=f) for k, f in FEE_PRESETS.items()}
    strat, hold = curves["best"][0], curves["best"][1]
    step = max(1, len(df) // max_points)
    idx = list(range(0, len(df), step))
    if idx and idx[-1] != len(df) - 1:
        idx.append(len(df) - 1)
    ts = df["ts"].to_numpy()
    return [{"t": int(ts[i]),
             "hit": None if np.isnan(rate[i]) else round(float(rate[i]), 4),
             "pnl": round(float(strat[i] - 1) * 100, 3),
             "hold": round(float(hold[i] - 1) * 100, 3),
             "pnl_f": {k: round(float(c[0][i] - 1) * 100, 3) for k, c in curves.items()},
             "hold_f": {k: round(float(c[1][i] - 1) * 100, 3) for k, c in curves.items()}} for i in idx]


CAL_BINS = [(0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.0001)]


def calibration(df):
    """Is Kronos's confidence honest? Groups calls by stated confidence (share of
    samples agreeing) and compares with how often those calls were right.
    df needs conf, direction, actual_dir. Skipped candles are left out."""
    called = df[(df["direction"] != 0) & df["conf"].notna()]
    rows = []
    for lo, hi in CAL_BINS:
        g = called[(called["conf"] >= lo) & (called["conf"] < hi)]
        n = len(g)
        hits = int((g["direction"] == g["actual_dir"]).sum())
        stated = float(g["conf"].mean()) if n else (lo + min(hi, 1.0)) / 2
        ci_lo, ci_hi = wilson(hits, n)
        verdict = None
        if n >= 30:
            verdict = "overconfident" if stated > ci_hi else "underconfident" if stated < ci_lo else "honest"
        rows.append({"bin": f"{round(lo * 100)}-{round(min(hi, 1.0) * 100)}%", "lo": lo, "hi": min(hi, 1.0),
                     "stated": stated, "calls": n, "hits": hits, "actual": hits / n if n else None,
                     "ci_low": ci_lo, "ci_high": ci_hi, "verdict": verdict})
    return rows


def compare(a, b):
    """Kronos (a) vs baseline (b) summaries -> edge in percentage points and p-value."""
    if not a["calls"] or not b["calls"]:
        return {"edge_pp": None, "p_value": None}
    return {"edge_pp": round((a["hit_rate"] - b["hit_rate"]) * 100, 2),
            "p_value": round(p_better(a["hits"], a["calls"], b["hits"], b["calls"]), 4)}


def clean_nans(obj):
    """JSON-safe: NaN/inf -> None, numpy scalars -> python."""
    if isinstance(obj, dict):
        return {k: clean_nans(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean_nans(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return None if math.isnan(f) or math.isinf(f) else round(f, 6)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    return obj
