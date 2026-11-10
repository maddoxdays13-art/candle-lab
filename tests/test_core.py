"""Fast tests (no network). Kronos itself is only loaded by test_no_lookahead."""
import numpy as np
import pandas as pd
import pytest

from candlelab import config, data, engine, experiment, live, signals, stats

SETTINGS = dict(model="NeoQuasar/Kronos-small", tokenizer="NeoQuasar/Kronos-Tokenizer-base",
                max_context=512, context_len=64, sample_count=4, T=1.0, top_p=0.9,
                use_volume=False, min_confidence=0.5, momentum_blend=0.0)


def synthetic(n, start=1_700_000_100 // 900 * 900, seed=0):
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.003, n)))
    ts = start + 900 * np.arange(n)
    return pd.DataFrame({"ts": ts, "open": close * 0.999, "high": close * 1.002,
                         "low": close * 0.997, "close": close, "volume": rng.uniform(1, 9, n)})


# ------------------------------------------------------------- data

def test_clean_fills_gaps_and_drops_unclosed():
    df = synthetic(10).drop(index=[3, 4])
    out = data.clean(df, end_ts=int(df["ts"].iloc[-2]))
    assert (np.diff(out["ts"]) == 900).all()
    assert len(out) == 9  # 10 rows, last one unclosed; the 2 missing slots are filled
    filled = out.iloc[3]
    assert filled["volume"] == 0 and filled["open"] == filled["close"] == out.iloc[2]["close"]


# ------------------------------------------------------------- no lookahead

@pytest.mark.slow
def test_no_lookahead():
    """Changing the target candle and everything after it must not change the forecast."""
    c = synthetic(200)
    a = engine.forecast(c, [150, 180], SETTINGS, seed_tag="t")
    c2 = c.copy()
    c2.loc[150:, ["open", "high", "low", "close"]] *= 3.0
    b = engine.forecast(c2, [150], SETTINGS, seed_tag="t")
    assert a["pred_close"].iloc[0] == pytest.approx(b["pred_close"].iloc[0])
    assert a["p_up"].iloc[0] == b["p_up"].iloc[0]
    assert a["last_close"].iloc[0] == pytest.approx(c["close"].iloc[149], rel=1e-6)


# ------------------------------------------------------------- signals

def test_kronos_call_threshold_and_blend():
    d, conf = signals.kronos_call([0.9, 0.55, 0.5, 0.2], [0, 0, 1, 1], dict(min_confidence=0.6))
    assert list(d) == [1, 0, 0, -1]
    assert conf[0] == pytest.approx(0.9)
    # 50/50 blend with momentum: 0.5*0.2 + 0.5*1 = 0.6 -> up
    d, _ = signals.kronos_call([0.2], [1], dict(momentum_blend=0.5))
    assert d[0] == 1


def test_baselines():
    d, _ = signals.baseline_calls("momentum", "BTC-USD", [1, 2], [10, 12], [11, 11])
    assert list(d) == [1, -1]
    f1 = signals.coin_flip("BTC-USD", np.arange(1000) * 900)
    assert 0.4 < (f1 == 1).mean() < 0.6
    assert (f1 == signals.coin_flip("BTC-USD", np.arange(1000) * 900)).all()  # reproducible


# ------------------------------------------------------------- stats

def test_wilson():
    lo, hi = stats.wilson(50, 100)
    assert lo == pytest.approx(0.4038, abs=1e-3) and hi == pytest.approx(0.5962, abs=1e-3)


def test_pnl_fees():
    strat, hold, trades = stats.paper_pnl([1, 1, -1, 0], [0.01, 0.01, 0.05, -0.02], fee=0.001)
    # buy (fee), +1%, +1%, sell (fee) and sit out the +5% and -2%
    assert trades == 2
    assert strat[-1] == pytest.approx(0.999 * 1.01 * 1.01 * 0.999)
    assert hold[-1] == pytest.approx(0.999 * 1.01 * 1.01 * 1.05 * 0.98)


def test_p_better():
    assert stats.p_better(60, 100, 50, 100) < 0.1
    assert stats.p_better(50, 100, 60, 100) > 0.9


# ------------------------------------------------------------- live logger

def test_live_dedup_and_scoring(tmp_path, monkeypatch):
    monkeypatch.setattr(live, "LIVE_DIR", tmp_path)
    c = synthetic(400)
    now = {"t": int(c["ts"].iloc[-1]) + 60}  # the last synthetic candle is still forming
    monkeypatch.setattr(data, "now_ts", lambda: now["t"])

    def fake_recent(coin, n):
        end = data.last_closed_open_ts()
        return c[c["ts"] <= end].tail(n).reset_index(drop=True), "test"
    monkeypatch.setattr(data, "fetch_recent", fake_recent)
    monkeypatch.setattr(engine, "forecast", lambda cd, idx, s, seed_tag="": pd.DataFrame(
        {"ts": [0], "last_close": [0], "pred_close": [cd["close"].iloc[idx[0] - 1] * 1.01], "p_up": [0.8]}))
    state = {"champion": dict(SETTINGS, id="x"), "previous": None, "probation": None}

    df = live.run(state)
    assert len(df) == 3 * 4 and df["actual_close"].isna().all()
    df = live.run(state)  # same candle again: nothing new
    assert len(df) == 12

    # The candle closes; the next run scores it and logs the following candle.
    now["t"] += 900
    df = live.run(state)
    assert len(df) == 24
    first = df[df["candle_ts"] == c["ts"].iloc[-1]]
    assert first["actual_close"].notna().all()
    k = first[first["model"] == "kronos"].iloc[0]
    actual_up = c["close"].iloc[-1] > c["close"].iloc[-2]
    assert k["correct"] == int(actual_up)  # kronos said "up"


def test_live_skips_stale_data(tmp_path, monkeypatch):
    monkeypatch.setattr(live, "LIVE_DIR", tmp_path)
    c = synthetic(400)
    monkeypatch.setattr(data, "now_ts", lambda: int(c["ts"].iloc[-1]) + 3 * 900 + 60)  # data 2 candles behind
    monkeypatch.setattr(data, "fetch_recent", lambda coin, n: (c.tail(n).reset_index(drop=True), "test"))
    state = {"champion": dict(SETTINGS, id="x"), "previous": None, "probation": None}
    df = live.run(state)
    assert len(df) == 0


# ------------------------------------------------------------- experiments

def test_challengers_are_new_and_deterministic():
    cfg = config.load_json(config.EXPERIMENT_FILE)
    champ = dict(SETTINGS, context_len=256, sample_count=10)
    a = experiment.make_challengers(champ, cfg, "2026-11-09")
    b = experiment.make_challengers(champ, cfg, "2026-11-09")
    assert [x["settings"] for x in a] == [x["settings"] for x in b]
    lo, hi = cfg["challengers_per_day"]
    assert lo <= len(a) <= hi
    ids = {config.settings_id(x["settings"]) for x in a}
    assert len(ids) == len(a) and config.settings_id(champ) not in ids


def _summ(hits, calls, candles=1000, pnl=0.0):
    return {"hits": hits, "calls": calls, "candles": candles, "hit_rate": hits / calls, "pnl_pct": pnl}


def test_promotion_check():
    crit = {"alpha": 0.05, "min_margin_pp": 1.0, "min_coverage": 0.25, "require_pnl_not_worse": True}
    champ = _summ(500, 1000)
    ok, why, _ = experiment.check(_summ(580, 1000, pnl=1), champ, 5, crit)
    assert ok, why
    ok, why, _ = experiment.check(_summ(530, 1000, pnl=1), champ, 5, crit)  # +3pp but not significant after Bonferroni
    assert not ok and any("p=" in w for w in why)
    ok, why, _ = experiment.check(_summ(150, 200, pnl=1), champ, 5, crit)  # great but only 20% coverage
    assert not ok and any("coverage" in w for w in why)
    ok, why, _ = experiment.check(_summ(580, 1000, pnl=-1), champ, 5, crit)
    assert not ok and any("P&L" in w for w in why)


def test_sample_points_stay_in_split():
    pts = experiment.sample_points("BTC-USD", "2026-01-01", "2026-01-31", 500, "x")
    assert len(pts) == 500 and len(set(pts)) == 500
    assert min(pts) >= data.to_ts("2026-01-01") and max(pts) < data.to_ts("2026-02-01")


def _state():
    return {"champion": dict(SETTINGS, id="new"), "previous": dict(SETTINGS, id="old", context_len=128),
            "probation": {"since": "2026-11-01T00:00:00+00:00", "since_ts": 0,
                          "until": "2026-11-15T00:00:00+00:00"}, "history": []}


@pytest.mark.parametrize("now,champ,prev,expect", [
    ("2026-11-05", (520, 1000), (500, 1000), None),                 # mid-probation, fine
    ("2026-11-05", (400, 1000), (520, 1000), "rolled_back"),        # clearly worse early -> roll back
    ("2026-11-16", (495, 1000), (500, 1000), "rolled_back"),        # ended, slightly worse -> roll back
    ("2026-11-16", (505, 1000), (500, 1000), "probation_passed"),   # ended, not worse -> keep
])
def test_probation(monkeypatch, now, champ, prev, expect):
    from datetime import datetime, timezone
    monkeypatch.setattr(experiment, "live_comparison", lambda since: {"kronos": champ, "kronos_prev": prev})
    st = _state()
    event, _ = experiment.probation_check(st, datetime.fromisoformat(now).replace(tzinfo=timezone.utc),
                                          {"probation_min_calls": 150})
    assert event == expect
    if expect == "rolled_back":
        assert st["champion"]["id"] == "old" and st["probation"] is None
    if expect == "probation_passed":
        assert st["champion"]["id"] == "new" and st["probation"] is None


def test_calibration():
    df = pd.DataFrame({"conf": [0.6] * 100 + [0.9] * 100, "direction": [1] * 200,
                       "actual_dir": [1] * 60 + [-1] * 40 + [1] * 60 + [-1] * 40})
    rows = {r["bin"]: r for r in stats.calibration(df)}
    assert rows["60-70%"]["actual"] == pytest.approx(0.6) and rows["60-70%"]["verdict"] == "honest"
    assert rows["90-100%"]["actual"] == pytest.approx(0.6) and rows["90-100%"]["verdict"] == "overconfident"
    assert rows["50-60%"]["calls"] == 0 and rows["50-60%"]["verdict"] is None


def test_pnl_by_fee():
    df = pd.DataFrame({"ts": range(4), "direction": [1, -1, 1, -1], "actual_dir": [1, -1, 1, -1],
                       "ret": [0.002, -0.002, 0.002, -0.002], "pct_error": [0.0] * 4})
    s = stats.summarize(df)
    assert s["pnl_by_fee"]["best"] > s["pnl_by_fee"]["cb_maker"] > s["pnl_by_fee"]["robinhood"]
    assert s["pnl_by_fee"]["best"] == pytest.approx(s["pnl_pct"])
    assert s["pnl_by_fee"]["robinhood"] < 0  # 4 trades x 0.95% wipes out +0.4%


def test_kalshi_section(monkeypatch):
    from candlelab import kalshi, site
    k = pd.DataFrame({"coin": ["BTC-USD", "BTC-USD", "ETH-USD"], "candle_ts": [900, 1800, 900], "ticker": ["a", "b", "c"],
                      "logged_at": [""] * 3, "secs_into_window": [75] * 3,
                      "yes_bid": [0.53, 0.40, 0.49], "yes_ask": [0.55, 0.42, 0.51], "no_bid": [0.45, 0.58, 0.49],
                      "no_ask": [0.47, 0.60, 0.51], "last": [0.54, 0.41, 0.5], "strike": [1, 1, 1],
                      "result": ["yes", "yes", "no"], "final_value": [1, 1, 1]})
    monkeypatch.setattr(kalshi, "load", lambda: k)
    pred = pd.DataFrame({"model": ["kronos"] * 3, "coin": ["BTC-USD", "BTC-USD", "ETH-USD"], "candle_ts": [900, 1800, 900],
                         "direction": ["up", "down", "skip"], "confidence": [0.8, 0.7, 0.5], "pred_close": [1, 1, 1]})
    out = site.kalshi_section(pred)
    b = out["coins"]["BTC-USD"]
    assert b["kronos_calls"] == 2 and b["kronos_hits"] == 1
    # won window 1 buying Yes at 0.55; lost window 2 buying No at 0.60; Kalshi taker fees on both
    expect = (1 - 0.55 - 0.07 * 0.55 * 0.45) + (0 - 0.60 - 0.07 * 0.60 * 0.40)
    assert b["follow"]["kalshi_taker"] == pytest.approx(expect)
    assert out["coins"]["ETH-USD"]["kronos_calls"] == 0  # skipped
    assert out["coins"]["ALL"]["crowd_hit"] == pytest.approx(0.5)  # favored Yes (right), No (wrong); 50/50 tie left out


def test_coins_differ():
    assert stats.coins_differ({"a": (500, 1000), "b": (505, 1000)}) > 0.5
    assert stats.coins_differ({"a": (500, 1000), "b": (600, 1000), "c": (510, 1000)}) < 0.001


def test_reversal_only():
    # last candle up (momentum_up=1): an UP call is a continuation -> skipped; a DOWN call is a reversal -> kept
    d, _ = signals.kronos_call([0.8, 0.2, 0.8, 0.2], [1, 1, 0, 0], dict(reversal_only=True))
    assert list(d) == [0, -1, 1, 0]
    base = dict(SETTINGS)
    assert config.settings_id(base) == config.settings_id(dict(base, reversal_only=False))
    assert config.settings_id(base) != config.settings_id(dict(base, reversal_only=True))


def test_strict_alerts(tmp_path, monkeypatch):
    from candlelab import kalshi, notify
    monkeypatch.setattr(notify, "LIVE_DIR", tmp_path)
    w = 1_800_000_000 // 900 * 900
    rows = []
    for coin, kdir, conf, pred, mom in [("BTC-USD", "down", 1.0, 99.0, "up"),     # strict: unanimous reversal, -1% move
                                         ("ETH-USD", "down", 0.9, 99.0, "up"),     # not unanimous
                                         ("SOL-USD", "up", 1.0, 101.0, "up")]:     # same direction as last candle
        rows += [{"coin": coin, "model": "kronos", "candle_ts": w, "direction": kdir, "confidence": conf,
                  "pred_close": pred, "last_close": 100.0},
                 {"coin": coin, "model": "momentum", "candle_ts": w, "direction": mom, "confidence": 1.0,
                  "pred_close": None, "last_close": 100.0}]
    monkeypatch.setattr("candlelab.live.load_live", lambda: pd.DataFrame(rows))
    monkeypatch.setattr(kalshi, "load", lambda: pd.DataFrame(columns=kalshi.COLS))
    sent = []
    monkeypatch.setattr(notify, "_post", lambda title, body, **k: sent.append((title, body)) or True)
    assert notify.send_strict_alerts(w) == 1
    assert "BTC: bet DOWN" in sent[0][0]
    assert notify.send_strict_alerts(w) == 0  # never twice for the same window


def test_autopilot(tmp_path, monkeypatch):
    from candlelab import autopilot, kalshi
    monkeypatch.setattr(autopilot, "LEDGER", tmp_path / "autopilot.csv")
    monkeypatch.setattr(autopilot, "LIVE_DIR", tmp_path)
    w = 1_800_000_000 // 900 * 900
    # pretend it's night and BTC has a DOWN strict signal; ETH an UP signal that's too expensive
    monkeypatch.setattr(autopilot, "in_hours", lambda t, c: True)
    monkeypatch.setattr(autopilot, "strict_signals", lambda t: [("BTC-USD", "down"), ("ETH-USD", "up")])
    ks = pd.DataFrame({"coin": ["BTC-USD", "ETH-USD"], "candle_ts": [w, w], "ticker": ["a", "b"], "logged_at": "", "secs_into_window": 80,
                       "yes_bid": [0.51, 0.60], "yes_ask": [0.53, 0.62], "no_bid": [0.47, 0.38], "no_ask": [0.49, 0.40],
                       "last": 0.5, "strike": 1.0, "result": [None, None], "final_value": None})
    monkeypatch.setattr(kalshi, "load", lambda: ks)
    placed = autopilot.run(w)
    assert list(placed) == ["BTC-USD"]                       # ETH: 'up' costs 62c > 55c -> skipped
    b = placed["BTC-USD"]
    assert b["price"] == 0.49 and b["contracts"] == 9       # $5 / (0.49 + fee) -> 9 contracts
    assert autopilot.balance(autopilot.load()) == pytest.approx(100 - b["cost"])
    ks.loc[0, "result"] = "no"                              # BTC went down -> DOWN wins
    autopilot.run(w + 900)
    df = autopilot.load()
    assert df.iloc[0]["status"] == "won"
    assert autopilot.balance(df) == pytest.approx(100 - b["cost"] + 9)


def test_size_advice():
    from candlelab.notify import size_advice
    assert size_advice(0.43, 0.546)[1] == 2        # 43c for a 54.6% signal: ~+10c edge -> max size
    assert size_advice(0.49, 0.546)[1] == 1.5      # ~+3.9c edge
    assert size_advice(0.52, 0.546)[1] == 1        # ~+0.9c edge
    assert size_advice(0.56, 0.546)[1] == 0        # above 55c -> skip
    assert size_advice(0.35, 0.546)[1] == 1        # suspiciously cheap -> don't size up


def test_win_rate_for():
    from candlelab.notify import win_rate_for
    w, note = win_rate_for({"hit_rate": 0.56, "calls": 2000}, {"calls": 4, "hits": 3})
    assert w == 0.56 and "backtest" in note and "3 of 4" in note
    w, note = win_rate_for({"hit_rate": 0.56, "calls": 2000}, {"calls": 120, "hits": 60})
    assert w == 0.5 and "LIVE" in note
