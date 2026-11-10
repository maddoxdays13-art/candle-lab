"""Live paper logger. Run every 15 minutes:  python -m candlelab.live

1. Score earlier predictions whose candle has now closed.
2. For each coin, predict the candle that is forming right now, using only
   closed candles. Kronos (the champion) plus the three baselines; during a
   probation period the previous champion is also logged as `kronos_prev`
   (a shadow used only to decide on a rollback).

Safe to run late, twice, or after skipped runs: each (coin, model, candle) is
logged at most once, and a candle that has already closed is never predicted.
"""
import argparse
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import data, engine, signals
from .config import COINS, GRANULARITY, LIVE_DIR, load_champion_state, settings_id

LIVE_COLS = ["run_at", "coin", "model", "settings_id", "candle_ts", "candle_time",
             "last_close", "pred_close", "direction", "confidence", "source",
             "actual_close", "correct", "pct_error", "scored_at"]


def iso(ts):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def month_of(ts):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m")


def load_live():
    files = sorted(LIVE_DIR.glob("predictions-*.csv"))
    if not files:
        return pd.DataFrame(columns=LIVE_COLS)
    return pd.concat([pd.read_csv(f, dtype={"settings_id": str, "scored_at": str}) for f in files],
                     ignore_index=True)


def save_live(df):
    LIVE_DIR.mkdir(parents=True, exist_ok=True)
    df = df.sort_values(["candle_ts", "coin", "model"])
    for month, part in df.groupby(df["candle_ts"].map(month_of)):
        part[LIVE_COLS].to_csv(LIVE_DIR / f"predictions-{month}.csv", index=False)


def score(df, closes):
    """Fill in actual_close / correct / pct_error for candles that have closed."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    todo = df["actual_close"].isna() & df["candle_ts"].isin(closes.index)
    for i in df.index[todo]:
        actual = closes[df.at[i, "candle_ts"]]
        df.at[i, "actual_close"] = actual
        d = df.at[i, "direction"]
        if d in ("up", "down"):
            actual_dir = "up" if actual > df.at[i, "last_close"] else "down"
            df.at[i, "correct"] = int(d == actual_dir)
        if pd.notna(df.at[i, "pred_close"]):
            df.at[i, "pct_error"] = round((df.at[i, "pred_close"] - actual) / actual * 100, 5)
        df.at[i, "scored_at"] = now
    return int(todo.sum())


def run(state=None):
    state = state or load_champion_state()
    champ = state["champion"]
    models = {"kronos": champ}
    if state.get("probation") and state.get("previous"):
        models["kronos_prev"] = state["previous"]
    need = max(s["context_len"] for s in models.values()) + 2

    df = load_live()
    for c in ["actual_close", "correct", "pct_error", "pred_close", "confidence"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["scored_at"] = df["scored_at"].astype("object")
    existing = set(zip(df["coin"], df["model"], df["candle_ts"]))
    run_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    expected_target = data.last_closed_open_ts() + GRANULARITY
    new_rows = []

    for coin in COINS:
        print(f"{coin}:")
        try:
            candles, source = data.fetch_recent(coin, max(need, 300))
        except Exception as e:  # noqa: BLE001 - one coin failing must not stop the others
            print(f"  no data ({e}); skipping")
            continue

        # Score anything that has closed, including older unscored rows.
        closes = candles.set_index("ts")["close"]
        pending = df[(df["coin"] == coin) & df["actual_close"].isna()]
        if not pending.empty and pending["candle_ts"].min() < candles["ts"].iloc[0]:
            try:
                old = data.clean(data.fetch_coinbase(coin, int(pending["candle_ts"].min()),
                                                     int(candles["ts"].iloc[0])))
                closes = pd.concat([old.set_index("ts")["close"], closes])
                closes = closes[~closes.index.duplicated(keep="last")]
            except Exception as e:  # noqa: BLE001
                print(f"  could not fetch old candles for scoring: {e}")
        sub = df[df["coin"] == coin].copy()
        n_scored = score(sub, closes)
        df.loc[sub.index] = sub
        print(f"  scored {n_scored} earlier predictions")

        target = int(candles["ts"].iloc[-1]) + GRANULARITY
        if target != expected_target:
            print(f"  latest candle is stale ({iso(candles['ts'].iloc[-1])}); not predicting")
            continue
        if len(candles) < need:
            print(f"  only {len(candles)} candles, need {need}; not predicting")
            continue

        last_close = float(candles["close"].iloc[-1])
        prev_close = float(candles["close"].iloc[-2])
        mom_up = signals.momentum_up(prev_close, last_close)
        target_idx = len(candles)  # one past the end = the forming candle
        ext = pd.concat([candles, pd.DataFrame({"ts": [target], "open": [np.nan], "high": [np.nan],
                                                "low": [np.nan], "close": [np.nan], "volume": [np.nan]})],
                        ignore_index=True)

        def add(model, sid, direction, conf, pred=np.nan):
            if (coin, model, target) in existing:
                print(f"  {model}: already logged for {iso(target)}")
                return
            new_rows.append({"run_at": run_at, "coin": coin, "model": model, "settings_id": sid,
                             "candle_ts": target, "candle_time": iso(target), "last_close": last_close,
                             "pred_close": pred, "direction": signals.dir_label(direction),
                             "confidence": round(float(conf), 4), "source": source})
            print(f"  {model}: {signals.dir_label(direction)} (conf {conf:.2f})")

        for name, settings in models.items():
            if (coin, name, target) in existing:
                print(f"  {name}: already logged for {iso(target)}")
                continue
            f = engine.forecast(ext, [target_idx], settings, seed_tag=coin)
            d, conf = signals.kronos_call(f["p_up"], [mom_up], settings)
            add(name, settings_id(settings), d[0], conf[0], round(float(f["pred_close"][0]), 6))
        for name in signals.BASELINES:
            d, conf = signals.baseline_calls(name, coin, [target], [prev_close], [last_close])
            add(name, "", d[0], conf[0])

    if new_rows:
        df = pd.concat([df, pd.DataFrame(new_rows)], ignore_index=True)
    save_live(df)
    print(f"logged {len(new_rows)} new predictions; total rows {len(df)}")
    return df


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    run()
    # The Kalshi crowd's odds for this window (read-only public data); never fatal.
    try:
        from . import kalshi
        print("Kalshi:")
        kalshi.update(data.last_closed_open_ts() + GRANULARITY)
    except Exception as e:  # noqa: BLE001
        print(f"Kalshi logging skipped: {e}")
    # Night autopilot: practice bets on Strict signals overnight (fake money); never fatal.
    try:
        from . import autopilot
        print("Autopilot:")
        autopilot.run(data.last_closed_open_ts() + GRANULARITY)
    except Exception as e:  # noqa: BLE001
        print(f"Autopilot skipped: {e}")
    # Phone alerts for Strict-mode signals (needs the NTFY_TOPIC secret); never fatal.
    try:
        from . import notify
        print("Alerts:")
        notify.send_strict_alerts(data.last_closed_open_ts() + GRANULARITY)
    except Exception as e:  # noqa: BLE001
        print(f"Alerts skipped: {e}")
    from . import site
    site.build_live()


if __name__ == "__main__":
    main()
