"""Kronos wrapper that forecasts the NEXT candle for many windows at once.

Kronos's own KronosPredictor averages its samples before returning them, so it
cannot report how much the samples agree. This module re-implements the
one-step case of `auto_regressive_inference` (vendor/kronos/kronos.py) and
keeps every sample so we can compute p_up = share of samples that predict a
higher close. Normalisation, clipping, time features and sampling are the
same as upstream. Two shortcuts give identical results: the input is tokenised
once per window, not once per sample, and the first-stage logits are computed
once per window because they don't depend on the sample.
"""
import hashlib
import sys

import numpy as np
import pandas as pd
import torch

from .config import ROOT

sys.path.insert(0, str(ROOT))
from vendor.kronos.kronos import Kronos, KronosTokenizer, top_k_top_p_filtering  # noqa: E402

CLIP = 5.0
_CACHE = {}


def _resolve(name):
    """A Hugging Face id like 'NeoQuasar/Kronos-small', or a folder in this repo
    such as 'models/kronos-crypto-ft' (from the Kaggle notebook)."""
    local = ROOT / name
    return str(local) if local.is_dir() else name


def load(model_id, tokenizer_id):
    key = (model_id, tokenizer_id)
    if key not in _CACHE:
        tok = KronosTokenizer.from_pretrained(_resolve(tokenizer_id)).float().eval()
        model = Kronos.from_pretrained(_resolve(model_id)).float().eval()
        _CACHE[key] = (tok, model)
    return _CACHE[key]


def time_features(ts):
    """Kronos time features [minute, hour, weekday, day, month] from epoch seconds (UTC)."""
    dt = pd.to_datetime(np.asarray(ts).ravel(), unit="s", utc=True)
    feats = np.stack([dt.minute, dt.hour, dt.day_of_week, dt.day, dt.month], axis=-1)
    return feats.reshape(*np.asarray(ts).shape, 5).astype(np.float32)


def _seed(*parts):
    return int(hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:8], 16)


def _sample(logits, T, top_p, u):
    """Same as upstream sample_from_logits (temperature, then top-p, then a
    draw from the softmax) but the draw uses the given uniforms `u`, so each
    candle's samples don't depend on what else is in the batch."""
    logits = top_k_top_p_filtering(logits / T, top_k=0, top_p=top_p) if top_p < 1.0 else logits / T
    cdf = torch.cumsum(torch.softmax(logits, dim=-1), dim=-1)
    idx = torch.searchsorted(cdf, (u * cdf[:, -1]).unsqueeze(-1).contiguous())
    return idx.clamp_(max=logits.size(-1) - 1)


def forecast(candles, target_idx, settings, seed_tag="", batch_size=32):
    """Forecast candle `target_idx[j]` of `candles` using only the
    `context_len` candles strictly before it (no lookahead).

    candles: DataFrame with ts, open, high, low, close, volume (regular grid).
    Returns DataFrame with ts (target), last_close, pred_close, p_up.
    """
    tok, model = load(settings["model"], settings["tokenizer"])
    L = int(settings["context_len"])
    S = int(settings["sample_count"])
    T, top_p = float(settings["T"]), float(settings["top_p"])
    max_ctx = int(settings["max_context"])
    if L > max_ctx:
        raise ValueError(f"context_len {L} exceeds max_context {max_ctx}")

    o, h, lo, c = (candles[k].to_numpy(np.float32) for k in ["open", "high", "low", "close"])
    if settings.get("use_volume"):
        vol = candles["volume"].to_numpy(np.float32)
        amt = vol * (o + h + lo + c) / 4
    else:  # the Kronos paper drops volume/amount for crypto
        vol = amt = np.zeros_like(c)
    feats = np.stack([o, h, lo, c, vol, amt], axis=-1)
    ts = candles["ts"].to_numpy(np.int64)

    target_idx = np.asarray(target_idx, dtype=np.int64)
    if (target_idx < L).any():
        raise ValueError("not enough history before some targets")

    out_pred, out_pup = [], []
    for b0 in range(0, len(target_idx), batch_size):
        idx = target_idx[b0:b0 + batch_size]
        win = np.stack([feats[i - L:i] for i in idx])                   # (B, L, 6)
        mean = win.mean(axis=1, keepdims=True)
        std = win.std(axis=1, keepdims=True)
        x = np.clip((win - mean) / (std + 1e-5), -CLIP, CLIP)
        x_stamp = time_features(np.stack([ts[i - L:i] for i in idx]))  # (B, L, 5)
        y_stamp = time_features(ts[idx][:, None])                       # (B, 1, 5)

        # Two uniforms per sample (one per sub-token), seeded by candle + settings.
        u = torch.stack([torch.rand(2, S, generator=torch.Generator().manual_seed(
            _seed(seed_tag, settings["model"], T, top_p, S, int(ts[i])))) for i in idx])  # (B, 2, S)
        u1, u2 = u[:, 0].reshape(-1), u[:, 1].reshape(-1)
        with torch.no_grad():
            xt = torch.from_numpy(x.astype(np.float32))
            s1, s2 = tok.encode(xt, half=True)                          # (B, L) each
            stamp = torch.from_numpy(np.concatenate([x_stamp, y_stamp], 1))
            s1_logits, context = model.decode_s1(s1, s2, stamp[:, :L])
            s1_logits = s1_logits[:, -1, :].repeat_interleave(S, 0)     # (B*S, V)
            context = context.repeat_interleave(S, 0)
            new_s1 = _sample(s1_logits, T, top_p, u1)
            s2_logits = model.decode_s2(context, new_s1)[:, -1, :]
            new_s2 = _sample(s2_logits, T, top_p, u2)

            full_s1 = torch.cat([s1.repeat_interleave(S, 0), new_s1], 1)[:, -max_ctx:]
            full_s2 = torch.cat([s2.repeat_interleave(S, 0), new_s2], 1)[:, -max_ctx:]
            z = tok.decode([full_s1, full_s2], half=True)[:, -1, :].numpy()  # (B*S, 6)

        z = z.reshape(len(idx), S, 6)
        close_samples = z[:, :, 3] * (std[:, 0, 3:4] + 1e-5) + mean[:, 0, 3:4]  # (B, S)
        last_close = c[idx - 1][:, None]
        out_pred.append(close_samples.mean(axis=1))
        out_pup.append((close_samples > last_close).mean(axis=1))

    return pd.DataFrame({
        "ts": ts[target_idx],
        "last_close": c[target_idx - 1].astype(np.float64),
        "pred_close": np.concatenate(out_pred).astype(np.float64) if out_pred else [],
        "p_up": np.concatenate(out_pup).astype(np.float64) if out_pup else [],
    })
