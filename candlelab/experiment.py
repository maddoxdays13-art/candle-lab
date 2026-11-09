"""Daily champion-vs-challenger experiments.

Stages (each is a separate GitHub Actions job so no job gets near its limit):
    python -m candlelab.experiment plan                       # pick today's challengers + sample points
    python -m candlelab.experiment eval --split tuning --coin BTC-USD   # (one job per coin)
    python -m candlelab.experiment gate                       # who passed tuning on ALL coins?
    python -m candlelab.experiment eval --split holdout --coin BTC-USD  # only for those passers
    python -m candlelab.experiment decide                     # probation check, promotion, log
Locally, `python -m candlelab.experiment run-all` runs every stage in order.

Data is split by time (config/experiment.json):
    tuning   - a fresh random sample of candles is scored every day
    holdout  - a fixed sample, only scored for challengers that already passed tuning
    live     - the live logger's results, used only for probation/rollback
Every forecast uses only candles before the one being predicted.
"""
import argparse
import json
import math
import random
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from . import data, engine, signals
from .config import (CHAMPION_FILE, COINS, EXPERIMENT_DIR, EXPERIMENT_FILE, GRANULARITY, WORK_DIR,
                     inference_key, load_champion_state, load_json, save_json, settings_id)
from .stats import p_better, summarize, wilson

CACHE_DIR = WORK_DIR / "cache"
LOG_FILE = EXPERIMENT_DIR / "log.jsonl"


def today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def day_dir(date):
    return WORK_DIR / "experiments" / date


# ---------------------------------------------------------------- plan

def make_challengers(champ, cfg, date):
    rng = random.Random(f"challengers|{date}")
    lo, hi = cfg["challengers_per_day"]
    want = rng.randint(lo, hi)
    space = cfg["search_space"]
    champ = bare(champ)
    seen = {settings_id(champ)}
    out = []

    extra = cfg.get("extra_models") or []
    if extra:  # e.g. a fine-tuned model from the Kaggle notebook
        day_n = (datetime.fromisoformat(date) - datetime(2024, 1, 1)).days
        m = extra[day_n % len(extra)]
        s = dict(champ, model=m["model"], tokenizer=m["tokenizer"], max_context=m.get("max_context", 512))
        s["context_len"] = min(s["context_len"], s["max_context"])
        seen.add(settings_id(s))
        out.append({"name": "challenger-1", "settings": s, "changed": {"model": m["model"]}})

    tries = 0
    while len(out) < want and tries < 200:
        tries += 1
        s = dict(champ)
        changed = {}
        for field in rng.sample(sorted(space), rng.choice([1, 1, 2])):
            options = [v for v in space[field] if v != champ[field]]
            if field == "context_len":
                options = [v for v in options if v <= champ["max_context"]]
            if options:
                s[field] = rng.choice(options)
                changed[field] = s[field]
        sid = settings_id(s)
        if changed and sid not in seen:
            seen.add(sid)
            out.append({"name": f"challenger-{len(out) + 1}", "settings": s, "changed": changed})
    return out


def bare(settings):
    """Settings without bookkeeping keys (id, label)."""
    return {k: v for k, v in settings.items() if k not in ("id", "label")}


def sample_points(coin, start, end, n, seed):
    grid = np.arange(data.to_ts(start), data.to_ts(end) + 86400, GRANULARITY)
    rng = np.random.default_rng(abs(hash_int(f"{seed}|{coin}")))
    return sorted(int(t) for t in rng.choice(grid, size=min(n, len(grid)), replace=False))


def hash_int(s):
    import hashlib
    return int(hashlib.sha1(s.encode()).hexdigest()[:12], 16)


def plan(date, quick=None):
    cfg = load_json(EXPERIMENT_FILE)
    if quick:  # smoke test: fewer points (results are not meaningful)
        cfg["tuning_points_per_coin"] = cfg["holdout_points_per_coin"] = quick
    state = load_champion_state()
    champ = state["champion"]
    sp = cfg["splits"]
    p = {
        "date": date,
        "champion": champ,
        "challengers": make_challengers(champ, cfg, date),
        "tuning_ts": {c: sample_points(c, *sp["tuning"], cfg["tuning_points_per_coin"], f"tuning|{date}")
                      for c in COINS},
        # Fixed forever, so the holdout never drifts toward whatever tuning liked.
        "holdout_ts": {c: sample_points(c, *sp["holdout"], cfg["holdout_points_per_coin"], "holdout|fixed")
                       for c in COINS},
    }
    save_json(day_dir(date) / "plan.json", p)
    print(f"{date}: champion {champ['id']} vs {len(p['challengers'])} challengers")
    for ch in p["challengers"]:
        print(f"  {ch['name']}: {ch['changed']}")
    return p


# ---------------------------------------------------------------- eval

def cached_forecasts(coin, candles, settings, wanted_ts):
    """Kronos forecasts for wanted_ts, re-using anything computed on earlier days."""
    path = CACHE_DIR / coin / f"{inference_key(settings)}.csv"
    have = pd.read_csv(path) if path.exists() else pd.DataFrame(columns=["ts", "last_close", "pred_close", "p_up"])
    ts_all = candles["ts"].to_numpy()
    pos = {int(t): i for i, t in enumerate(ts_all)}
    L = settings["context_len"]
    done = set(have["ts"].astype(int))
    missing = [t for t in wanted_ts if t not in done and pos.get(t, -1) > L]
    if missing:
        print(f"    {inference_key(settings)}: forecasting {len(missing)} points", flush=True)
        f = engine.forecast(candles, [pos[t] for t in missing], settings, seed_tag=f"exp|{coin}")
        have = pd.concat([have, f], ignore_index=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        have.to_csv(path, index=False)
    return have[have["ts"].isin(wanted_ts)].drop_duplicates("ts").sort_values("ts")


def score_variant(settings, f, candles):
    """Per-variant summary on the forecast points (same metric code as the dashboard)."""
    pos = pd.Series(np.arange(len(candles)), index=candles["ts"].to_numpy())
    idx = pos.loc[f["ts"].to_numpy()].to_numpy()
    c = candles["close"].to_numpy()
    mom = signals.momentum_up(c[idx - 2], c[idx - 1])
    d, _ = signals.kronos_call(f["p_up"].to_numpy(), mom, settings)
    df = pd.DataFrame({"ts": f["ts"].to_numpy(), "direction": d,
                       "actual_dir": signals.actual_direction(c[idx - 1], c[idx]),
                       "ret": c[idx] / c[idx - 1] - 1,
                       "pct_error": (f["pred_close"].to_numpy() - c[idx]) / c[idx] * 100})
    return summarize(df)


def evaluate(date, split, coin):
    p = load_json(day_dir(date) / "plan.json")
    variants = {"champion": p["champion"]}
    if split == "tuning":
        variants.update({ch["name"]: ch["settings"] for ch in p["challengers"]})
    else:
        gate = load_json(day_dir(date) / "gate.json")
        variants.update({n: ch["settings"] for ch in p["challengers"]
                         for n in [ch["name"]] if n in gate["passed_tuning"]})
    points = p[f"{split}_ts"][coin]
    max_L = max(v["context_len"] for v in variants.values())
    candles = data.update_history(coin, min(points) - (max_L + 2) * GRANULARITY)
    print(f"{coin} {split}: {len(points)} points, {len(variants)} variants")
    out = {}
    for name, s in variants.items():
        f = cached_forecasts(coin, candles, s, points)
        out[name] = score_variant(s, f, candles)
        r = out[name]
        print(f"  {name:13s} hit {fmt(r['hit_rate'])} on {r['calls']} calls, pnl {r['pnl_pct']:+.2f}%")
    save_json(day_dir(date) / f"{split}-{coin}.json", out)
    return out


def fmt(x):
    return "  n/a" if x is None else f"{x * 100:5.1f}%"


# ---------------------------------------------------------------- gate / decide

def check(ch, champ, n_tests, crit):
    """Does challenger summary `ch` beat champion summary `champ` on one coin/split?"""
    alpha = crit["alpha"] / max(1, n_tests)  # Bonferroni: today's challengers are many tries
    reasons = []
    if ch["calls"] < crit["min_coverage"] * ch["candles"]:
        reasons.append(f"coverage {ch['calls']}/{ch['candles']} below {crit['min_coverage']:.0%}")
    if ch["hit_rate"] is None or champ["hit_rate"] is None:
        return False, reasons + ["no calls"], 1.0
    edge = ch["hit_rate"] - champ["hit_rate"]
    pval = p_better(ch["hits"], ch["calls"], champ["hits"], champ["calls"])
    if edge * 100 < crit["min_margin_pp"]:
        reasons.append(f"edge {edge * 100:+.2f}pp below {crit['min_margin_pp']}pp")
    if pval >= alpha:
        reasons.append(f"p={pval:.4f} not below {alpha:.4f}")
    if crit.get("require_pnl_not_worse") and ch["pnl_pct"] < champ["pnl_pct"]:
        reasons.append(f"P&L {ch['pnl_pct']:+.2f}% worse than champion {champ['pnl_pct']:+.2f}%")
    return not reasons, reasons, pval


def pooled(per_coin):
    hits = sum(v["hits"] for v in per_coin.values())
    calls = sum(v["calls"] for v in per_coin.values())
    lo, hi = wilson(hits, calls)
    return {"hits": hits, "calls": calls, "hit_rate": hits / calls if calls else None,
            "ci_low": lo, "ci_high": hi,
            "coverage": calls / max(1, sum(v["candles"] for v in per_coin.values()))}


def gate(date):
    p = load_json(day_dir(date) / "plan.json")
    crit = load_json(EXPERIMENT_FILE)["promotion"]
    res = {c: load_json(day_dir(date) / f"tuning-{c}.json") for c in COINS}
    passed, detail = [], {}
    for ch in p["challengers"]:
        n = ch["name"]
        detail[n] = {c: check(res[c][n], res[c]["champion"], len(p["challengers"]), crit) for c in COINS}
        if all(ok for ok, _, _ in detail[n].values()):
            passed.append(n)
    save_json(day_dir(date) / "gate.json", {"passed_tuning": passed,
                                            "detail": {n: {c: {"ok": ok, "why": why, "p": pv}
                                                           for c, (ok, why, pv) in d.items()}
                                                       for n, d in detail.items()}})
    print(f"passed tuning on all coins: {passed or 'none'}")
    return passed


def live_comparison(since_ts):
    from .live import load_live
    df = load_live()
    df = df[(df["candle_ts"] >= since_ts) & df["correct"].notna()]
    out = {}
    for m in ["kronos", "kronos_prev"]:
        g = df[df["model"] == m]
        out[m] = (int(g["correct"].sum()), int(len(g)))
    return out


def live_recent(days):
    """Champion's pooled live hit rate over the last `days` days (for the timeline chart)."""
    from .live import load_live
    df = load_live()
    since = datetime.now(timezone.utc).timestamp() - days * 86400
    g = df[(df["model"] == "kronos") & (df["candle_ts"] >= since) & df["correct"].notna()]
    n = len(g)
    return {"calls": n, "hit_rate": float(g["correct"].mean()) if n else None}


def probation_check(state, now, cfg):
    """Returns (event, details) and mutates state. event in {None, 'rolled_back', 'probation_passed'}."""
    prob = state.get("probation")
    if not prob:
        return None, None
    lc = live_comparison(prob["since_ts"])
    (ch, cn), (ph, pn) = lc["kronos"], lc["kronos_prev"]
    info = {"champion_hits": ch, "champion_calls": cn, "previous_hits": ph, "previous_calls": pn,
            "champion_hit": ch / cn if cn else None, "previous_hit": ph / pn if pn else None}
    ended = now >= datetime.fromisoformat(prob["until"])
    early_bad = pn >= cfg["probation_min_calls"] and p_better(ph, pn, ch, cn) < 0.05
    if early_bad or (ended and cn and pn and ch / cn < ph / pn):
        bad = state["champion"]
        state["champion"], state["previous"], state["probation"] = state["previous"], None, None
        state["history"].append({"date": now.strftime("%Y-%m-%d"), "event": "rolled_back",
                                 "id": state["champion"]["id"], "replaced": bad["id"], "live": info})
        return "rolled_back", info
    if ended:
        state["probation"] = None
        state["history"].append({"date": now.strftime("%Y-%m-%d"), "event": "probation_passed",
                                 "id": state["champion"]["id"], "live": info,
                                 "note": "" if cn and pn else "not enough live data to compare; kept"})
        return "probation_passed", info
    return None, info


def decide(date):
    cfg = load_json(EXPERIMENT_FILE)
    crit = cfg["promotion"]
    p = load_json(day_dir(date) / "plan.json")
    g = load_json(day_dir(date) / "gate.json")
    state = load_champion_state()
    now = datetime.now(timezone.utc)
    tuning = {c: load_json(day_dir(date) / f"tuning-{c}.json") for c in COINS}
    holdout = {c: load_json(day_dir(date) / f"holdout-{c}.json") for c in COINS} if g["passed_tuning"] else {}

    event, live_info = probation_check(state, now, cfg)
    n_tests = len(p["challengers"])
    record = {
        "date": date, "ran_at": now.isoformat(timespec="seconds"),
        "champion": {"id": p["champion"]["id"], "settings": p["champion"],
                     "tuning": {**{c: tuning[c]["champion"] for c in COINS},
                                "ALL": pooled({c: tuning[c]["champion"] for c in COINS})}},
        "probation_event": event, "live_check": live_info, "live_7d": live_recent(7),
        "alpha_per_test": crit["alpha"] / max(1, n_tests), "challengers": [], "promoted": None,
    }
    candidates = []
    for ch in p["challengers"]:
        n = ch["name"]
        entry = {"name": n, "id": settings_id(ch["settings"]), "changed": ch["changed"],
                 "settings": ch["settings"],
                 "tuning": {**{c: tuning[c][n] for c in COINS}, "ALL": pooled({c: tuning[c][n] for c in COINS})},
                 "tuning_checks": g["detail"][n], "passed_tuning": n in g["passed_tuning"],
                 "holdout": None, "passed_holdout": False, "promoted": False}
        if entry["passed_tuning"]:
            hc = {c: check(holdout[c][n], holdout[c]["champion"], n_tests, crit) for c in COINS}
            entry["holdout"] = {**{c: holdout[c][n] for c in COINS},
                                "ALL": pooled({c: holdout[c][n] for c in COINS}),
                                "champion_ALL": pooled({c: holdout[c]["champion"] for c in COINS})}
            entry["holdout_checks"] = {c: {"ok": ok, "why": why, "p": pv} for c, (ok, why, pv) in hc.items()}
            entry["passed_holdout"] = all(ok for ok, _, _ in hc.values())
            if entry["passed_holdout"]:
                candidates.append(entry)
        record["challengers"].append(entry)

    blocked = None
    if state["champion"]["id"] != p["champion"]["id"]:
        blocked = "champion changed since plan (rollback today)"
    elif state.get("probation"):
        blocked = "champion is on probation"
    if candidates and not blocked:
        best = max(candidates, key=lambda e: e["tuning"]["ALL"]["hit_rate"])
        best["promoted"] = True
        new = dict(best["settings"], id=best["id"], label=f"{date} {best['name']}")
        state["previous"] = state["champion"]
        state["champion"] = new
        until = now + timedelta(days=cfg["probation_days"])
        state["probation"] = {"since": now.isoformat(timespec="seconds"), "since_ts": int(now.timestamp()),
                              "until": until.isoformat(timespec="seconds")}
        state["history"].append({"date": date, "event": "promoted", "id": new["id"],
                                 "replaced": state["previous"]["id"], "changed": best["changed"]})
        record["promoted"] = best["id"]
        print(f"PROMOTED {best['name']} ({best['id']}); probation until {until:%Y-%m-%d}")
    else:
        print("no promotion" + (f" ({blocked})" if blocked and candidates else ""))
    record["blocked"] = blocked if candidates else None

    save_json(CHAMPION_FILE, state)
    EXPERIMENT_DIR.mkdir(parents=True, exist_ok=True)
    lines = [line for line in (LOG_FILE.read_text().splitlines() if LOG_FILE.exists() else [])
             if line.strip() and json.loads(line)["date"] != date]  # re-running a day replaces it
    lines.append(json.dumps(clean(record), default=str))
    LOG_FILE.write_text("\n".join(lines) + "\n")
    from . import site
    site.build_experiments()
    return record


def clean(o):
    from .stats import clean_nans
    return clean_nans(o)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["plan", "eval", "gate", "decide", "run-all"])
    ap.add_argument("--date", default=today())
    ap.add_argument("--split", choices=["tuning", "holdout"])
    ap.add_argument("--coin", choices=COINS)
    ap.add_argument("--quick", type=int, help="plan/run-all: use only N points per coin (smoke test)")
    a = ap.parse_args()
    if a.stage == "plan":
        plan(a.date, a.quick)
    elif a.stage == "eval":
        if not a.split or not a.coin:
            ap.error("eval needs --split and --coin")
        evaluate(a.date, a.split, a.coin)
    elif a.stage == "gate":
        gate(a.date)
    elif a.stage == "decide":
        decide(a.date)
    else:
        plan(a.date, a.quick)
        for c in COINS:
            evaluate(a.date, "tuning", c)
        if gate(a.date):
            for c in COINS:
                evaluate(a.date, "holdout", c)
        decide(a.date)


if __name__ == "__main__":
    main()
