"""Paths, constants and small JSON helpers shared by every Candle Lab script."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COINS = ["BTC-USD", "ETH-USD", "SOL-USD"]
GRANULARITY = 900  # 15-minute candles, in seconds
FEE = 0.001  # 0.1% per trade (charged on every position change); used by the experiments
# Fee levels the dashboard can switch between (cost per buy and per sell). Checked Nov 2026; they change often.
FEE_PRESETS = {
    "best": 0.001,       # best case / very high-volume exchange accounts
    "cb_maker": 0.005,   # Coinbase Advanced, entry tier, limit order that waits ("maker")
    "cb_taker": 0.009,   # Coinbase Advanced, entry tier, order that fills right away ("taker")
    "robinhood": 0.0095, # Robinhood app: ~$0.95 per $100, built into the spread
}
# Prediction-market venues for 15-minute "up or down" bets (fee per $1-payout contract at price q).
# Checked Nov 2026 from public reporting; Polymarket's exact US fee is unconfirmed.
BET_VENUES = {
    "kalshi_taker": "Kalshi, instant fill: 0.07 x q x (1-q)  (~1.75c at 50c)",
    "kalshi_maker": "Kalshi, limit order: 0.0175 x q x (1-q)  (~0.44c at 50c)",
    "robinhood": "Robinhood Prediction Markets: ~2c per contract",
    "polymarket": "Polymarket 15-min crypto: reported up to ~3% of stake at 50/50",
}

CANDLE_DIR = ROOT / "data" / "candles"          # not committed; cached in Actions
LIVE_DIR = ROOT / "results" / "live"
BACKTEST_DIR = ROOT / "results" / "backtest"
EXPERIMENT_DIR = ROOT / "results" / "experiments"
WORK_DIR = ROOT / "work"                         # scratch for chunked jobs
SITE_DATA_DIR = ROOT / "docs" / "data"
CONFIG_DIR = ROOT / "config"
CHAMPION_FILE = CONFIG_DIR / "champion.json"
EXPERIMENT_FILE = CONFIG_DIR / "experiment.json"
BACKTEST_FILE = CONFIG_DIR / "backtest.json"

# Fields that change what Kronos itself outputs (cache key). min_confidence and
# momentum_blend are applied afterwards, so variants differing only in those
# reuse the same Kronos forecasts.
INFERENCE_FIELDS = ["model", "tokenizer", "max_context", "context_len",
                    "sample_count", "T", "top_p", "use_volume"]
DECISION_FIELDS = ["min_confidence", "momentum_blend"]


def load_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    with open(path) as f:
        return json.load(f)


def save_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2, default=str)
        f.write("\n")
    os.replace(tmp, path)


def _hash(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:10]


def inference_key(settings):
    return _hash({k: settings[k] for k in INFERENCE_FIELDS})


def settings_id(settings):
    d = {k: settings[k] for k in INFERENCE_FIELDS + DECISION_FIELDS}
    if settings.get("reversal_only"):  # only added when on, so existing ids stay the same
        d["reversal_only"] = True
    return _hash(d)


def load_champion_state():
    """config/champion.json. The id is always recomputed, so hand edits are safe."""
    state = load_json(CHAMPION_FILE)
    for key in ("champion", "previous"):
        if state.get(key):
            state[key]["id"] = settings_id(state[key])
    state.setdefault("history", [])
    return state
