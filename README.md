# 🕯️ Candle Lab

A **free, paper-only** test of whether [Kronos](https://github.com/shiyu-coder/Kronos), an open-source
candlestick forecasting model, can call the direction of the next **15-minute candle** for BTC, ETH
and SOL better than simple baselines.

* **No real trading.** No exchange accounts, no API keys, no money. Prices come from Coinbase's free public
  API, with Kraken as a fallback.
* **Runs itself for free** on GitHub Actions (unlimited minutes for public repos) and shows a dashboard on
  GitHub Pages.
* **Honest scoring.** Every model is compared against three baselines, with 95% confidence ranges, so you can
  tell luck from a real edge.

| What runs | When | Where the results go |
|---|---|---|
| **Live keeper**: predicts the candle forming right now and scores the ones that closed | every 15 min | `results/live/` |
| **Backtest**: walk-forward replay of history since July 2024 | when you start it | `results/backtest/` |
| **Daily experiment**: champion vs 3–5 challenger settings | every night | `results/experiments/`, `config/champion.json` |
| **Dashboard** | always on | `docs/` → `https://<you>.github.io/<repo>/` |

---

## Setup (about 15 minutes, no coding)

### 1. Create the repository
1. Make a free account at [github.com](https://github.com) if you don't have one.
2. Click **+** (top right) → **New repository**. Name it, for example, `candle-lab`.
3. Choose **Public**. This matters: Actions minutes are unlimited only for public repos. Click **Create repository**.
4. Upload this project. The easiest way, from a terminal in this folder:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/candle-lab.git
   ```
   ```bash
   git push -u origin main
   ```
   (Without a terminal: on the new repo page, click **uploading an existing file** and drag in *everything* in
   this folder, including the hidden `.github` folder. On a Mac, press **Cmd+Shift+.** in Finder to show hidden files.)

### 2. Let Actions save results
1. In your repo: **Settings → Actions → General**.
2. Under **Workflow permissions**, choose **Read and write permissions**, then click **Save**.
3. Open the **Actions** tab. If you see a green button saying workflows are disabled, click **I understand…, enable them**.

### 3. Turn on the dashboard (GitHub Pages)
1. **Settings → Pages**.
2. **Source:** *Deploy from a branch*. **Branch:** `main`, folder **`/docs`**. Click **Save**.
3. After a minute or two the page shows your link, `https://YOUR-USERNAME.github.io/candle-lab/`. Bookmark it.

### 4. Start the live logger
1. **Actions** tab → **Live logger** (left list) → **Run workflow** → **Run workflow**.
2. The first run takes about 3 minutes because it installs PyTorch and downloads Kronos (about 100 MB). Both are
   cached, so later runs take about 40 seconds.
3. After that it runs by itself every 15 minutes. The first predictions are scored 15 minutes later.

> GitHub's own scheduler is "best effort": on new repos it can stay silent for hours, and later it's often late.
> So the logging is done by the **Live keeper** workflow, which runs the logger 75 seconds after every 15-minute
> candle closes, restarts itself every ~5¾ hours, and also starts the nightly experiment. The "Live logger"
> schedule is only a watchdog that restarts the keeper if it ever stops. To pause logging, cancel the running
> "Live keeper" run in the Actions tab (it won't restart itself when cancelled; the watchdog will restart it at
> its next run unless you also disable "Live logger"). The logger never logs the same candle twice and never
> predicts a candle that has already closed. The dashboard shows a warning banner if nothing has updated for over an hour.

### 5. Run the first backtest
1. **Actions → Backtest → Run workflow**. Leave the defaults and click **Run workflow**.
2. It runs BTC, ETH and SOL in parallel, about 82,000 candles each. Each job works for up to 5 hours,
   saves its progress, and **starts the next chunk by itself** until it has caught up. Expect about
   **1–2 chunks (5–10 hours)** in total. You can watch the dashboard's **Backtest** tab fill in as each chunk finishes.
3. It's safe to cancel: the next run continues where it stopped.

### 6. The daily experiment
Nothing to do. It runs every night at 07:17 UTC. To try it right away: **Actions → Daily experiment → Run
workflow**. Type `100` in the *quick* box for a fast smoke test (about 10 minutes); the results won't be meaningful.

---

## Reading the dashboard

* **Hit rate**: share of calls (up/down) that were right. Kronos can also **skip** a candle when its samples
  disagree; **coverage** is the share of candles it made a call on.
* **95% range**: the Wilson confidence interval. **If the range includes 50%, the hit rate could be luck.**
  With 1,000 calls the range is about ±3 points, and with 10,000 calls about ±1 point. Real edges on 15-minute
  candles, if they exist, are usually small, so expect to need thousands of predictions.
* **Matchups**: Kronos minus each baseline, in percentage points, with a one-sided p-value. "Beats it" means p < 0.05.
  * **Momentum**: same direction as the last candle.
  * **Coin flip**: a fair random call (reproducible).
  * **Always up**: says "up" every time. It does well in bull markets, so it's a useful reality check.
* **Is Kronos's confidence honest?** Groups Kronos's calls by how many of its samples agreed (60%, 70%, 80%, …)
  and shows how often each group was actually right. Dots on the dashed line = honest; below = overconfident.
  The same numbers are saved as plain data files: `results/backtest/calibration.csv` and `results/live/calibration.csv`.
* **Live candles** (Live tab): zoomable candlestick charts straight from Coinbase (LIVE 1-second, 1m, 5m, 15m, 1h)
  with Kronos's calls marked, and an Up/Down chances bar for the candle forming now.
* **Candlesticks tab**: a cheat sheet of 42 candlestick patterns, drawn, with what each one means.
* **Which coin is Kronos best at?** BTC, ETH and SOL side by side, with a chi-square test of whether the
  difference between coins is real or luck.
* **Bets tab**: 15-minute "up or down" prediction markets (Kalshi, Robinhood, Polymarket). (1) Paper $1 bets on every
  call at even odds with each venue's fees. (2) **Kronos vs the Kalshi crowd**: every 15 minutes the logger also saves
  Kalshi's public market prices for the same window (read-only, no account) and later its official result
  (`results/live/kalshi-*.csv`), then compares accuracy, Brier score, and the P&L of betting Kronos's calls at the
  real prices.
* **Practice wallet** (corner button): claim a free $100 of fake money once a day and practice buying Up/Down
  contracts on the current 15-minute window, or selling early. Prices come from a simulated market built on Coinbase's
  live price (Kalshi doesn't allow browsers to read its prices directly), with Kalshi-style spread and fees, and bets
  settle on Coinbase's 15-minute candle. Saved only in your browser.
* **Paper P&L**: buy when the call is "up", hold cash otherwise, and pay **0.1% on every buy and every sell**.
  Compared against simply holding the coin. Fees matter a lot at 15-minute frequency, because a strategy that
  flips often pays them dozens of times a day.

---

## How it avoids fooling itself

* **Training cutoff.** The Kronos paper ([arXiv 2508.02739](https://arxiv.org/abs/2508.02739)) states that its
  pre-training data "extends up to June 2024" and tests from July 2024. So the backtest **only scores candles from
  2024-07-01 on**. Caveat: that date is stated for the paper's models (small/base/large). The Hugging Face model
  cards don't give a cutoff, and we assume the released Kronos-small weights are the paper's.
  **Kronos-mini** has no documented cutoff, which is one reason this project uses **Kronos-small**
  (24.7M parameters, paired with `Kronos-Tokenizer-base`, max context 512).
* **No lookahead.** Every prediction uses only candles that had closed before the predicted candle opened. A test
  (`tests/test_core.py::test_no_lookahead`) changes the future and checks the forecast doesn't move.
* **Reproducible randomness.** Kronos samples several possible next candles. Each candle's samples come from its
  own seed, so the same candle gets the same forecast in the live logger, the backtest and the experiments.
* **Separate books.** Live, backtest and experiment results live in different folders and are never mixed.

## The champion/challenger system

* `config/champion.json` holds the **champion's settings**. Only the champion makes live predictions.
* Every night the experiment creates **3–5 challengers** by changing one or two settings: context length, number of
  samples, temperature (`T`), `top_p`, a **confidence threshold** (skip candles where fewer than X% of the samples
  agree), and a **momentum blend** (mix Kronos's vote with the momentum baseline).
* Time is split three ways (`config/experiment.json`):

  | Split | Dates | Used for |
  |---|---|---|
  | Tuning | 2024-07-01 → 2025-12-31 | a fresh random sample of 1,000 candles per coin, every day |
  | Holdout (locked) | 2026-01-01 → 2026-10-31 | only checked for challengers that already passed tuning |
  | Live | 2026-11-01 → | the live logger, used for probation |

* A challenger is **promoted only if, on every coin, on both tuning and holdout**:
  * its hit rate is at least **1 percentage point** higher than the champion's,
  * a one-sided test gives p < 0.05 **divided by the number of challengers that day** (a Bonferroni correction,
    so testing five variants doesn't create five chances to get lucky),
  * it makes a call on at least **25%** of candles,
  * and its paper P&L after fees is no worse.
* After a promotion the new champion is on **probation for 14 days**. The previous champion keeps running in the
  background as a shadow (`kronos_prev`). If the new champion's live hit rate ends up below the old one's, or is
  clearly worse earlier, it is **rolled back automatically**. No other promotions happen during probation.
* Everything is logged to `results/experiments/log.jsonl`: date, settings, every result, pass/fail reasons, and promotions.

**Expect promotions to be rare.** With 1,000 candles per coin, a challenger needs roughly a 5-point real
improvement to clear these bars. That's deliberate: on noisy 15-minute data most "improvements" are luck.
The holdout is only a fixed set of candles, so many months of daily tries can still slowly overfit to it.
The live probation is the final safeguard.

## Fine-tuning (optional, on Kaggle's free GPU)
`notebooks/kronos_finetune_kaggle.ipynb` fine-tunes Kronos-small on BTC → ETH → SOL candles with Kronos's own
`finetune_csv` code. Step-by-step instructions are at the top of the notebook. In short: import it on Kaggle,
turn on a GPU and Internet, click **Run All**, download `kronos-crypto-ft.zip`, unzip it into
`models/kronos-crypto-ft/` in this repo, and add it to `extra_models` in `config/experiment.json`.
From then on, one challenger each day uses it.

---

## Running things on your own computer (optional)

Needs Python 3.10 or newer (Kronos needs 3.10+).
```bash
python3 -m venv .venv && .venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu && .venv/bin/pip install -r requirements.txt
```
Then:
```bash
.venv/bin/python -m candlelab.live
```
```bash
.venv/bin/python -m candlelab.backtest --max-minutes 60
```
```bash
.venv/bin/python -m candlelab.experiment run-all --quick 100
```
```bash
.venv/bin/python -m pytest -q
```
```bash
.venv/bin/python -m http.server 8000 --directory docs
```
The last command serves the dashboard at http://localhost:8000. Results you create locally can be committed and
pushed like any other change, but avoid doing so while a GitHub backtest is running.

The backtest has `--coin BTC-USD` to run one coin, and `--reset` to start over after editing `config/backtest.json`.
Set `"stride": 4` in that file to score every 4th candle (4× faster, fewer predictions).

## Project layout
```
candlelab/         Python package
  data.py          Coinbase (paged, rate-limited) + Kraken fallback, gap filling
  engine.py        Kronos wrapper: next-candle forecast, keeps every sample
  signals.py       Kronos call (confidence threshold, momentum blend) + baselines
  stats.py         hit rate, Wilson range, significance tests, paper P&L
  live.py          15-minute logger            backtest.py   resumable walk-forward backtest
  experiment.py    champion vs challengers     site.py       builds docs/data/*.json
config/            champion.json, experiment.json, backtest.json
results/           live/, backtest/, experiments/ (committed CSV/JSON)
docs/              the dashboard (GitHub Pages)
vendor/kronos/     Kronos model code (MIT license), unmodified except its import lines
notebooks/         Kaggle fine-tuning notebook
.github/workflows/ live.yml, backtest.yml, experiment.yml, tests.yml
```

## Troubleshooting
* **The dashboard says the logger hasn't updated.** Open **Actions → Live logger** and click the latest run to see the
  error. A red ✗ on "Commit results" usually means step 2 (read and write permissions) was skipped.
* **The dashboard didn't change after a run.** Pages takes 1–2 minutes to redeploy, and your browser may cache. Reload.
* **Scheduled runs stopped.** GitHub pauses schedules in repos with no activity for 60 days. This project commits
  every 15 minutes, so that shouldn't happen. If it does, re-enable the workflows from the Actions tab.
* **Coinbase is down.** The live logger switches to Kraken automatically. Kraken only serves recent candles, so the
  backtest and experiments wait for Coinbase.

*Not financial advice. This is an experiment about forecasting, not a trading system.*
