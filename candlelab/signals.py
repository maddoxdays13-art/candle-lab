"""Turn Kronos forecasts into calls, and the three baselines.

Direction convention used everywhere: the target candle is "up" when its close
is above the previous candle's close (the last price known at prediction time).
"""
import hashlib

import numpy as np

UP, DOWN, SKIP = 1, -1, 0
BASELINES = ["momentum", "coin_flip", "always_up"]


def kronos_call(p_up, momentum_up, settings):
    """Combine Kronos's share of 'up' samples with momentum, then apply the
    confidence threshold. Returns (direction, confidence) arrays.

    blended = (1 - w) * p_up + w * (1 if last candle was up else 0)
    confidence = max(blended, 1 - blended)   (0.5 = no agreement, 1.0 = unanimous)
    A call is skipped when confidence < min_confidence or blended is exactly 0.5.
    """
    w = float(settings.get("momentum_blend", 0.0))
    p = (1 - w) * np.asarray(p_up, float) + w * np.asarray(momentum_up, float)
    conf = np.maximum(p, 1 - p)
    direction = np.where(p > 0.5, UP, np.where(p < 0.5, DOWN, SKIP))
    direction = np.where(conf < float(settings.get("min_confidence", 0.5)), SKIP, direction)
    return direction.astype(int), conf


def momentum_up(prev_close, last_close):
    """1 if the last closed candle went up (close above the one before), else 0."""
    return (np.asarray(last_close) > np.asarray(prev_close)).astype(int)


def coin_flip(coin, ts):
    """Reproducible fair coin per (coin, candle)."""
    out = []
    for t in np.atleast_1d(ts):
        h = hashlib.sha1(f"{coin}|{int(t)}".encode()).digest()[0]
        out.append(UP if h & 1 else DOWN)
    return np.array(out, dtype=int)


def baseline_calls(name, coin, ts, prev_close, last_close):
    n = len(np.atleast_1d(ts))
    if name == "momentum":
        return np.where(momentum_up(prev_close, last_close) == 1, UP, DOWN), np.ones(n)
    if name == "coin_flip":
        return coin_flip(coin, ts), np.full(n, 0.5)
    if name == "always_up":
        return np.full(n, UP), np.ones(n)
    raise ValueError(name)


def actual_direction(last_close, close):
    return np.where(np.asarray(close) > np.asarray(last_close), UP, DOWN)


def dir_label(d):
    return {UP: "up", DOWN: "down", SKIP: "skip"}[int(d)]
