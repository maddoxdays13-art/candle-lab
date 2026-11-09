"""Walk-forward backtest:  python -m candlelab.backtest [--coin BTC-USD] [--max-minutes 60]

Every candle from config/backtest.json's `start` (after Kronos's training
cutoff) up to the latest closed candle is predicted using only the
`context_len` candles before it. Results go to results/backtest/<coin>/<month>.csv,
separate from live results.

Resumable: each run continues after the last candle already saved, so stopping
any time is safe. --max-minutes keeps one GitHub Actions job under its time limit.
"""
import argparse
import sys
import time

import numpy as np
import pandas as pd

from . import data, engine, signals
from .config import BACKTEST_DIR, BACKTEST_FILE, COINS, GRANULARITY, load_json, save_json, settings_id

BT_COLS = ["ts", "last_close", "prev_close", "close", "pred_close", "p_up",
           "kronos", "kronos_conf", "momentum", "coin_flip", "always_up"]
FLUSH_EVERY = 256  # predictions between saves


def load_coin(coin):
    files = sorted((BACKTEST_DIR / coin).glob("*.csv"))
    if not files:
        return pd.DataFrame(columns=BT_COLS)
    return pd.concat([pd.read_csv(f) for f in files], ignore_index=True)


def save_rows(coin, rows):
    """Append rows to their monthly files (rows are always newer than what is saved)."""
    d = BACKTEST_DIR / coin
    d.mkdir(parents=True, exist_ok=True)
    months = pd.to_datetime(rows["ts"], unit="s", utc=True).dt.strftime("%Y-%m")
    for month, part in rows.groupby(months):
        f = d / f"{month}.csv"
        part[BT_COLS].to_csv(f, mode="a", header=not f.exists(), index=False)


def check_meta(cfg, reset):
    meta_file = BACKTEST_DIR / "meta.json"
    meta = load_json(meta_file)
    sid = settings_id(cfg["settings"])
    if meta and (meta["settings_id"] != sid or meta["start"] != cfg["start"]):
        if not reset:
            sys.exit("config/backtest.json changed since the saved backtest started. "
                     "Re-run with --reset to delete results/backtest and start over.")
        meta = None
    if meta is None:
        if BACKTEST_DIR.exists():
            for f in BACKTEST_DIR.rglob("*.csv"):
                f.unlink()
        save_json(meta_file, {"settings_id": sid, "settings": cfg["settings"], "start": cfg["start"],
                              "note": cfg.get("note", "")})


def run_coin(coin, cfg, deadline):
    s = cfg["settings"]
    L = s["context_len"]
    start_ts = data.to_ts(cfg["start"])
    stride = int(cfg.get("stride", 1))
    candles = data.update_history(coin, start_ts - (L + 2) * GRANULARITY)
    done = load_coin(coin)
    first = start_ts if done.empty else int(done["ts"].max()) + stride * GRANULARITY
    ts = candles["ts"].to_numpy()
    targets = np.nonzero((ts >= first) & (np.arange(len(ts)) >= L + 1))[0][::stride]
    print(f"{coin}: {len(done)} done, {len(targets)} to go")
    c = candles["close"].to_numpy()
    for b0 in range(0, len(targets), FLUSH_EVERY):
        if time.time() > deadline:
            print(f"{coin}: time budget used; will resume next run")
            return False
        idx = targets[b0:b0 + FLUSH_EVERY]
        f = engine.forecast(candles, idx, s, seed_tag=coin)
        mom = signals.momentum_up(c[idx - 2], c[idx - 1])
        kd, kc = signals.kronos_call(f["p_up"], mom, s)
        rows = pd.DataFrame({"ts": ts[idx], "last_close": c[idx - 1], "prev_close": c[idx - 2],
                             "close": c[idx], "pred_close": f["pred_close"].round(6),
                             "p_up": f["p_up"].round(4), "kronos": kd, "kronos_conf": kc.round(4)})
        for name in signals.BASELINES:
            rows[name] = signals.baseline_calls(name, coin, ts[idx], c[idx - 2], c[idx - 1])[0]
        save_rows(coin, rows)
        print(f"  {coin}: saved through {pd.to_datetime(ts[idx[-1]], unit='s', utc=True)}"
              f" ({b0 + len(idx)}/{len(targets)})", flush=True)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--coin", choices=COINS, help="one coin (default: all)")
    ap.add_argument("--max-minutes", type=float, default=1e9, help="stop after this long")
    ap.add_argument("--reset", action="store_true", help="discard saved results if config changed")
    ap.add_argument("--no-site", action="store_true", help="skip rebuilding dashboard data")
    ap.add_argument("--prepare-only", action="store_true", help="only check/reset saved results")
    args = ap.parse_args()
    cfg = load_json(BACKTEST_FILE)
    check_meta(cfg, args.reset)
    if args.prepare_only:
        return
    deadline = time.time() + args.max_minutes * 60
    complete = all([run_coin(c, cfg, deadline) for c in ([args.coin] if args.coin else COINS)])
    # Tell the workflow whether another chunk is needed.
    (BACKTEST_DIR / f"status-{args.coin or 'all'}.txt").write_text("complete\n" if complete else "incomplete\n")
    if not args.no_site:
        from . import site
        site.build_backtest()


if __name__ == "__main__":
    main()
