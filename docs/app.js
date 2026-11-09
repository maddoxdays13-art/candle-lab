/* Candle Lab dashboard. Reads data/live.json, data/backtest.json, data/experiments.json. */
const MODELS = [
  { key: "kronos", name: "Kronos", color: "--s-kronos" },
  { key: "momentum", name: "Momentum", color: "--s-momentum" },
  { key: "coin_flip", name: "Coin flip", color: "--s-coin" },
  { key: "always_up", name: "Always up", color: "--s-up" },
];
const COINS = ["ALL", "BTC-USD", "ETH-USD", "SOL-USD"];
const STALE_MINUTES = 60;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (x, d = 1) => (x == null ? "–" : (x * 100).toFixed(d) + "%");
const signed = (x, d = 2, unit = "%") => (x == null ? "–" : (x > 0 ? "+" : "") + x.toFixed(d) + unit);
const cls = (x) => (x == null ? "" : x > 0 ? "pos" : x < 0 ? "neg" : "");
const num = (x) => (x == null ? "–" : x.toLocaleString());
const fmtTime = (t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ago = (iso) => {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 1 ? "just now" : m < 60 ? `${Math.round(m)} min ago` : m < 2880 ? `${(m / 60).toFixed(1)} h ago` : `${Math.round(m / 1440)} days ago`;
};

const state = { tab: "live", coin: "ALL", data: {}, charts: [] };

async function load(name) {
  if (state.data[name] !== undefined) return state.data[name];
  try {
    const r = await fetch(`data/${name}.json?_=${Date.now()}`);
    state.data[name] = r.ok ? await r.json() : null;
  } catch { state.data[name] = null; }
  return state.data[name];
}

function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }

Chart.defaults.color = "#9A9DA4";
Chart.defaults.borderColor = "#2B2D32";
Chart.defaults.font.family = "Barlow, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

function lineChart(canvas, datasets, { yFmt = (v) => v + "%", refLine = null, xType = "time" } = {}) {
  const ann = refLine == null ? [] : [{
    label: refLine.label, data: datasets[0]?.data.map((p) => ({ x: p.x, y: refLine.y })) || [],
    borderColor: "#5c5f66", borderDash: [4, 4], borderWidth: 1, pointRadius: 0, pointHitRadius: 0,
  }];
  const ch = new Chart(canvas, {
    type: "line",
    data: { datasets: [...datasets.map((d) => ({ borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15, spanGaps: true, ...d })), ...ann] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "linear", ticks: { maxTicksLimit: 6, callback: (v) => xType === "date" ? new Date(v).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })
               : xType === "days" ? new Date(v * 1000).toLocaleDateString([], { year: "2-digit", month: "short", day: "numeric" }) : fmtTime(v) }, grid: { display: false } },
        y: { ticks: { callback: yFmt }, grid: { color: "#222428" } },
      },
      plugins: {
        legend: { labels: { boxWidth: 10, boxHeight: 10, usePointStyle: false } },
        tooltip: {
          callbacks: {
            title: (items) => items.length ? (xType === "date" ? new Date(items[0].parsed.x).toLocaleDateString([], { timeZone: "UTC" }) : fmtTime(items[0].parsed.x)) : "",
            label: (it) => `${it.dataset.label}: ${it.parsed.y == null ? "–" : yFmt(it.parsed.y)}`,
          },
        },
      },
    },
  });
  state.charts.push(ch);
  return ch;
}

/* ------------------------------------------------------------ shared section (Live & Backtest) */

function verdict(vs) {
  if (!vs || vs.edge_pp == null) return `<span class="verdict meh">NOT ENOUGH DATA</span>`;
  if (vs.p_value < 0.05 && vs.edge_pp > 0) return `<span class="verdict yes">✓ KRONOS BEATS IT (p=${vs.p_value})</span>`;
  if (vs.p_value > 0.95) return `<span class="verdict no">✗ KRONOS IS WORSE</span>`;
  return `<span class="verdict luck">≈ NO PROVEN EDGE (p=${vs.p_value})</span>`;
}

function matchups(coinData) {
  const k = coinData.models.kronos.summary;
  const cards = [`<div class="card"><div class="label">Kronos hit rate</div>
      <div class="big">${pct(k.hit_rate)}</div>
      <div class="sub">95% range ${pct(k.ci_low)} – ${pct(k.ci_high)} · ${num(k.calls)} calls</div>
      ${!k.calls ? `<span class="verdict meh">NOT ENOUGH DATA</span>` : k.ci_low > 0.5 ? `<span class="verdict yes">✓ ABOVE 50%</span>` : k.ci_high < 0.5 ? `<span class="verdict no">✗ BELOW 50%</span>` : `<span class="verdict luck">COULD BE LUCK</span>`}</div>`];
  for (const m of MODELS.slice(1)) {
    const vs = coinData.kronos_vs[m.key];
    const s = coinData.models[m.key].summary;
    cards.push(`<div class="card"><div class="label"><span class="swatch" style="background:${css(m.color)}"></span>Kronos vs ${m.name}</div>
      <div class="big ${cls(vs.edge_pp)}">${signed(vs.edge_pp, 1, " pp")}</div>
      <div class="sub">${pct(k.hit_rate)} vs ${pct(s.hit_rate)}</div>${verdict(vs)}</div>`);
  }
  return `<div class="cards">${cards.join("")}</div>`;
}

function ciBar(s) {
  if (s.ci_low == null) return "";
  // Bar spans 35%..65% so small differences are visible; the tick marks 50%.
  const lo = 0.35, hi = 0.65, f = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  return `<span class="ci" title="95% range ${pct(s.ci_low)}–${pct(s.ci_high)} (bar spans 35–65%, tick = 50%)"><span class="bar" style="left:${f(s.ci_low)}%;width:${f(s.ci_high) - f(s.ci_low)}%"></span><span class="mid"></span></span>`;
}

function scoreboard(coinData, pooled) {
  const rows = MODELS.map((m) => {
    const s = coinData.models[m.key].summary;
    return `<tr style="--sc:${css(m.color)}"><td><span class="swatch" style="background:${css(m.color)}"></span>${m.name}</td>
      <td>${num(s.calls)}</td><td><b>${pct(s.hit_rate)}</b></td>
      <td>${pct(s.ci_low)} – ${pct(s.ci_high)}${ciBar(s)}</td>
      <td>${pct(s.coverage, 0)}</td>
      ${pooled ? "" : `<td class="${cls(s.pnl_pct)}">${signed(s.pnl_pct)}</td><td class="${cls(s.hold_pct)}">${signed(s.hold_pct)}</td><td>${num(s.trades)}</td>`}
      <td>${s.mean_abs_pct_error == null ? "–" : s.mean_abs_pct_error.toFixed(3) + "%"}</td></tr>`;
  }).join("");
  return `<div class="tablewrap"><table><thead><tr><th>Model</th><th>Predictions</th><th>Hit rate</th><th>95% range</th><th>Coverage</th>
    ${pooled ? "" : "<th>Paper P&amp;L</th><th>Hold coin</th><th>Trades</th>"}<th>Avg abs error</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function coinChips() {
  return `<div class="chips" role="group" aria-label="Coin">${COINS.map((c) =>
    `<button class="chip" data-coin="${c}" aria-pressed="${state.coin === c}">${c === "ALL" ? "All coins" : c.replace("-USD", "")}</button>`).join("")}</div>`;
}

function performanceSection(d, kind) {
  const coinData = d.coins[state.coin];
  const pooled = state.coin === "ALL";
  let html = coinChips();
  if (kind === "live") html += priceSection();
  html += `<h2>Matchups${pooled ? " · all coins pooled" : ""}</h2>${matchups(coinData)}`;
  html += `<p class="note">Edge = Kronos hit rate minus the baseline's, in percentage points. "Beats it" needs a one-sided p-value under 0.05; anything else could be luck.</p>`;
  html += `<h2>Scoreboard</h2>${scoreboard(coinData, pooled)}`;
  html += `<p class="note">Paper P&amp;L: buy when the call is "up", sit in cash otherwise, 0.1% fee on every buy and sell. Hold coin = buy once and hold over the same candles.</p>`;
  html += calibrationSection(coinData, kind);
  if (pooled) {
    html += `<p class="note">Pick a coin above to see charts and P&amp;L.</p>`;
  } else {
    html += `<div class="grid2"><div><h2>Rolling hit rate (last ${kind === "live" ? 96 : 960} calls)</h2><div class="chartbox"><canvas id="rollChart"></canvas></div></div>
      <div><h2>Paper P&amp;L vs holding</h2><div class="chartbox"><canvas id="pnlChart"></canvas></div></div></div>`;
  }
  return html;
}

/* ---------- Is Kronos's confidence honest? (calibration) ---------- */
function calibrationSection(coinData, kind) {
  const rows = coinData.calibration || [];
  const total = rows.reduce((a, r) => a + r.calls, 0);
  const csv = kind === "live" ? "results/live/calibration.csv" : "results/backtest/calibration.csv";
  const repo = "https://github.com/maddoxdays13-art/candle-lab/blob/main/" + csv;
  const tag = (r) => !r.verdict ? `<span class="verdict meh" style="margin:0">TOO FEW CALLS</span>`
    : r.verdict === "honest" ? `<span class="verdict yes" style="margin:0">✓ HONEST</span>`
    : r.verdict === "overconfident" ? `<span class="verdict no" style="margin:0">OVERCONFIDENT</span>`
    : `<span class="verdict luck" style="margin:0">BETTER THAN IT SAYS</span>`;
  return `<h2>Is Kronos's confidence honest?</h2>
    <div class="grid2"><div class="chartbox"><canvas id="calChart"></canvas></div>
    <div class="tablewrap"><table><thead><tr><th>When Kronos says</th><th>It was right</th><th>95% range</th><th>Calls</th><th>Verdict</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${r.bin}</b> <span class="muted">(avg ${pct(r.stated, 0)})</span></td>
      <td><b class="${r.actual == null ? "" : r.actual >= r.stated - 0.02 ? "pos" : "neg"}">${pct(r.actual)}</b></td>
      <td>${pct(r.ci_low)} – ${pct(r.ci_high)}</td><td>${num(r.calls)}</td><td>${tag(r)}</td></tr>`).join("")}
    </tbody></table></div></div>
    <p class="note">"Kronos says 80%" means 8 of its 10 sampled futures agreed on the direction. If that number were an honest probability, the dots would sit on the dashed line.
    Below the line = overconfident; above = better than it claims. ${num(total)} calls ${state.coin === "ALL" ? "across all coins" : "on " + state.coin.replace("-USD", "")}.
    Data file: <a href="${repo}">${csv}</a>.</p>`;
}

function drawCalibration(coinData) {
  const el = $("#calChart");
  if (!el) return;
  const rows = (coinData.calibration || []).filter((r) => r.calls > 0);
  const errBars = {
    id: "errbars",
    afterDatasetsDraw(chart) {
      const { ctx, scales: { x, y } } = chart;
      ctx.save(); ctx.strokeStyle = css("--s-kronos"); ctx.lineWidth = 2;
      rows.forEach((r) => {
        if (r.ci_low == null) return;
        const px = x.getPixelForValue(r.stated * 100);
        ctx.beginPath(); ctx.moveTo(px, y.getPixelForValue(r.ci_low * 100)); ctx.lineTo(px, y.getPixelForValue(r.ci_high * 100));
        ctx.moveTo(px - 5, y.getPixelForValue(r.ci_low * 100)); ctx.lineTo(px + 5, y.getPixelForValue(r.ci_low * 100));
        ctx.moveTo(px - 5, y.getPixelForValue(r.ci_high * 100)); ctx.lineTo(px + 5, y.getPixelForValue(r.ci_high * 100));
        ctx.stroke();
      });
      ctx.restore();
    },
  };
  const ch = new Chart(el, {
    type: "scatter",
    data: { datasets: [
      { label: "Perfectly honest", data: [{ x: 50, y: 50 }, { x: 100, y: 100 }], showLine: true, borderColor: "#5c5f66", borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 },
      { label: "Kronos actually right", data: rows.map((r) => ({ x: r.stated * 100, y: r.actual * 100, r })), showLine: true,
        borderColor: css("--s-kronos"), backgroundColor: css("--s-kronos"), borderWidth: 2,
        pointRadius: rows.map((r) => Math.max(4, Math.min(11, 3 + Math.log10(r.calls + 1) * 2))), pointHoverRadius: 9 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        x: { min: 50, max: 100, title: { display: true, text: "Kronos's stated confidence" }, ticks: { callback: (v) => v + "%" }, grid: { display: false } },
        y: { min: 30, max: 100, title: { display: true, text: "Actually right" }, ticks: { callback: (v) => v + "%" }, grid: { color: "#222428" } },
      },
      plugins: {
        legend: { labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: (it) => it.raw.r ? `Says ${it.raw.r.bin}: right ${pct(it.raw.r.actual)} of ${num(it.raw.r.calls)} calls` : "Perfectly honest" } },
      },
    },
    plugins: [errBars],
  });
  state.charts.push(ch);
}

function drawPerformanceCharts(d) {
  drawCalibration(d.coins[state.coin]);
  if (state.coin === "ALL") return;
  const cd = d.coins[state.coin].models;
  const pts = cd.kronos.rolling;
  if (!pts.length) {
    document.querySelectorAll(".chartbox").forEach((b) => { b.innerHTML = `<p class="muted pad">No scored predictions for this coin yet.</p>`; });
    return;
  }
  const xType = pts[pts.length - 1].t - pts[0].t > 3 * 86400 ? "days" : "time";
  lineChart($("#rollChart"), MODELS.map((m) => ({
    label: m.name, borderColor: css(m.color), backgroundColor: css(m.color),
    data: cd[m.key].rolling.map((p) => ({ x: p.t, y: p.hit == null ? null : +(p.hit * 100).toFixed(2) })),
  })), { refLine: { y: 50, label: "50% (luck)" }, xType });
  const pnl = MODELS.slice(0, 2).map((m) => ({
    label: m.name + " P&L", borderColor: css(m.color), backgroundColor: css(m.color),
    data: cd[m.key].rolling.map((p) => ({ x: p.t, y: p.pnl })),
  }));
  pnl.push({ label: "Hold coin", borderColor: css("--s-hold"), backgroundColor: css("--s-hold"), borderDash: [6, 3],
    data: cd.kronos.rolling.map((p) => ({ x: p.t, y: p.hold })) });
  lineChart($("#pnlChart"), pnl, { refLine: { y: 0, label: "Break-even" }, xType });
}

/* ------------------------------------------------------------ Live */

function dirPill(d) { return d ? `<span class="pill ${d}">${d === "up" ? "▲ UP" : d === "down" ? "▼ DOWN" : "SKIP"}</span>` : "–"; }
function resultMark(c) { return c == null ? `<span class="muted">pending</span>` : c ? `<span class="res pos">✓ HIT</span>` : `<span class="res neg">✗ MISS</span>`; }

function recentTable(rows) {
  const r = rows.filter((x) => state.coin === "ALL" || x.coin === state.coin).slice(0, 45);
  if (!r.length) return `<p class="muted">No predictions yet.</p>`;
  return `<div class="tablewrap"><table><thead><tr><th>Candle (your time)</th><th>Coin</th><th>Last close</th><th>Kronos pred</th>
    <th>Kronos call</th><th>Conf.</th><th>Actual close</th><th>Kronos result</th><th>Momentum</th><th>Coin flip</th></tr></thead><tbody>
    ${r.map((x) => {
      const actualDir = x.actual_close == null ? null : x.actual_close > x.last_close ? "up" : "down";
      const rc = x.kronos === "skip" || x.kronos_correct == null ? "" : x.kronos_correct ? "hit" : "miss";
      return `<tr class="${rc}"><td>${fmtTime(x.t)}</td><td>${esc(x.coin.replace("-USD", ""))}</td><td>${num(x.last_close)}</td>
      <td>${x.pred_close == null ? "–" : num(+x.pred_close.toFixed(2))}</td><td>${dirPill(x.kronos)}</td>
      <td>${x.conf == null ? "–" : pct(x.conf, 0)}</td>
      <td>${x.actual_close == null ? "<span class='muted'>open</span>" : num(x.actual_close) + " " + (actualDir === "up" ? "▲" : "▼")}</td>
      <td>${x.kronos === "skip" ? "<span class='muted'>skipped</span>" : resultMark(x.kronos_correct)}</td>
      <td>${dirPill(x.momentum)} ${x.momentum_correct == null ? "" : x.momentum_correct ? "✓" : "✗"}</td>
      <td>${dirPill(x.coin_flip)} ${x.coin_flip_correct == null ? "" : x.coin_flip_correct ? "✓" : "✗"}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

const HEADS = {
  live: ["Live", "Predicting the 15-minute candle forming right now, scored when it closes"],
  backtest: ["Backtest", "Walk-forward replay of history the model never trained on"],
  experiments: ["Experiments", "Champion vs challengers, tested every night"],
  candlesticks: ["Candlesticks", "A cheat sheet: what every common candlestick pattern looks like and what traders read into it"],
};
const pageHead = (t) => `<div class="page-head"><h1>${HEADS[t][0]}</h1><p>${HEADS[t][1]}</p></div>`;

function renderLive(d) {
  if (!d) return `<p class="pad muted">No live data yet. The logger writes data/live.json after its first run.</p>`;
  const ch = d.champion || {};
  let html = performanceSection(d, "live");
  html += `<h2>Most recent predictions</h2>${recentTable(d.recent || [])}`;
  html += `<p class="note">Champion settings: <span class="mono">${esc(ch.label)} · id ${esc(ch.id)} · context ${ch.context_len} · ${ch.sample_count} samples · T ${ch.T} · top_p ${ch.top_p} · min confidence ${ch.min_confidence} · momentum blend ${ch.momentum_blend}</span>
    ${d.probation ? ` · <b style="color:var(--warn)">on probation until ${esc(d.probation.until.slice(0, 10))}</b>` : ""}</p>`;
  return html;
}

/* ------------------------------------------------------------ Backtest */

function renderBacktest(d) {
  if (!d || !d.range || d.range.first == null) return `<p class="pad muted">No backtest results yet. Run the Backtest workflow (see README).</p>`;
  let html = `<p class="note" style="margin-top:16px">Walk-forward backtest from <b>${new Date(d.range.first * 1000).toISOString().slice(0, 10)}</b> to <b>${new Date(d.range.last * 1000).toISOString().slice(0, 10)}</b> (UTC).
    ${esc(d.meta?.note || "")} Kept separate from live results.</p>`;
  html += performanceSection(d, "backtest");
  return html;
}

/* ------------------------------------------------------------ Experiments */

function settingsKV(s) {
  const keys = ["model", "context_len", "sample_count", "T", "top_p", "min_confidence", "momentum_blend", "use_volume"];
  return `<div class="kv">${keys.map((k) => `<span>${k}</span><span class="mono">${esc(s?.[k])}</span>`).join("")}</div>`;
}

function renderExperiments(d) {
  if (!d) return `<p class="pad muted">No experiment data yet.</p>`;
  let html = `<div class="cards" style="margin-top:16px">
    <div class="card"><div class="label">Champion</div><div class="big mono" style="font-size:20px">${esc(d.champion.id)}</div>
      <div class="sub">${esc(d.champion.label || "")}</div>
      ${d.probation ? `<span class="verdict meh" style="color:var(--warn);border-color:var(--warn)">PROBATION UNTIL ${esc(d.probation.until.slice(0, 10))}</span>` : `<span class="verdict yes">ACTIVE</span>`}
      <div style="margin-top:10px">${settingsKV(d.champion)}</div></div>
    <div class="card"><div class="label">How a challenger gets promoted</div>
      <div class="sub" style="font-size:13px;line-height:1.5">Hit rate at least <b>${d.promotion.min_margin_pp} pp</b> above the champion's,
      one-sided p &lt; <b>${d.promotion.alpha}</b> ÷ (number of challengers that day), coverage ≥ <b>${d.promotion.min_coverage * 100}%</b>,
      P&amp;L not worse. It must pass on <b>every coin</b>, first on the tuning set (${esc(d.splits.tuning.join(" → "))}),
      then on the locked holdout set (${esc(d.splits.holdout.join(" → "))}). After promotion: ${d.probation_days}-day live probation with automatic rollback.</div></div>
  </div>`;
  html += `<h2>Champion performance over time</h2><div class="chartbox"><canvas id="champChart"></canvas></div>
    <p class="note">Tuning hit rate = champion on that day's random tuning sample (all coins pooled). Live = champion's last 7 days of live calls.</p>`;
  html += `<h2>Champion history</h2><div class="tablewrap"><table><thead><tr><th>Date</th><th>Event</th><th>Champion id</th><th>Details</th></tr></thead><tbody>
    ${[...(d.history || [])].reverse().map((h) => `<tr><td>${esc(h.date)}</td><td>${esc(h.event.replace("_", " "))}</td><td class="mono">${esc(h.id)}</td>
      <td style="text-align:left">${h.replaced ? "replaced " + esc(h.replaced) + " " : ""}${h.changed ? esc(JSON.stringify(h.changed)) : ""}${h.live ? " live: champ " + pct(h.live.champion_hit) + " vs prev " + pct(h.live.previous_hit) : ""}${esc(h.note || "")}</td></tr>`).join("")}
    </tbody></table></div>`;
  html += `<h2>Daily runs</h2>`;
  const runs = [...(d.runs || [])].reverse();
  if (!runs.length) html += `<p class="muted">No daily runs yet.</p>`;
  for (const [i, r] of runs.entries()) {
    const c = r.champion.tuning.ALL;
    html += `<details ${i === 0 ? "open" : ""}><summary><span>${esc(r.date)} · ${r.challengers.length} challengers</span>
      <span>${r.promoted ? `<span class="verdict yes" style="margin:0">PROMOTED ${esc(r.promoted)}</span>` : `<span class="muted">no promotion</span>`}
      ${r.probation_event ? `<span class="verdict meh" style="margin:0">${esc(r.probation_event.replace("_", " ").toUpperCase())}</span>` : ""}</span></summary><div>
      <div class="tablewrap"><table><thead><tr><th>Variant</th><th>Changed</th><th>Tuning hit (all coins)</th><th>95% range</th><th>Coverage</th>
      <th>P&amp;L BTC / ETH / SOL</th><th>Passed tuning</th><th>Holdout hit</th><th>Passed holdout</th></tr></thead><tbody>
      <tr><td><b>Champion</b> <span class="mono">${esc(r.champion.id)}</span></td><td>–</td><td><b>${pct(c.hit_rate)}</b></td><td>${pct(c.ci_low)} – ${pct(c.ci_high)}</td><td>${pct(c.coverage, 0)}</td>
        <td>${["BTC-USD", "ETH-USD", "SOL-USD"].map((k) => `<span class="${cls(r.champion.tuning[k].pnl_pct)}">${signed(r.champion.tuning[k].pnl_pct, 1)}</span>`).join(" / ")}</td><td>–</td><td>–</td><td>–</td></tr>
      ${r.challengers.map((x) => {
        const t = x.tuning.ALL;
        const why = Object.entries(x.tuning_checks).filter(([, v]) => !v.ok).map(([k, v]) => k.replace("-USD", "") + ": " + v.why.join("; ")).join(" | ");
        return `<tr><td>${esc(x.name)} <span class="mono">${esc(x.id)}</span></td><td class="mono" style="text-align:left">${esc(JSON.stringify(x.changed))}</td>
        <td><b>${pct(t.hit_rate)}</b> <span class="${cls(t.hit_rate - c.hit_rate)}">(${signed((t.hit_rate - c.hit_rate) * 100, 1, " pp")})</span></td>
        <td>${pct(t.ci_low)} – ${pct(t.ci_high)}</td><td>${pct(t.coverage, 0)}</td>
        <td>${["BTC-USD", "ETH-USD", "SOL-USD"].map((k) => `<span class="${cls(x.tuning[k].pnl_pct)}">${signed(x.tuning[k].pnl_pct, 1)}</span>`).join(" / ")}</td>
        <td title="${esc(why)}">${x.passed_tuning ? "✓" : "✗"}</td>
        <td>${x.holdout ? pct(x.holdout.ALL.hit_rate) + " vs " + pct(x.holdout.champion_ALL.hit_rate) : "<span class='muted'>not run</span>"}</td>
        <td>${x.holdout ? (x.passed_holdout ? "✓" : "✗") : "–"}</td></tr>`;
      }).join("")}</tbody></table></div>
      <p class="note">Significance threshold per test today: p &lt; ${r.alpha_per_test?.toFixed(4)} (Bonferroni). Hover ✗ for why a challenger failed.${r.blocked ? " Promotion blocked: " + esc(r.blocked) : ""}</p></div></details>`;
  }
  return html;
}

function drawExperimentChart(d) {
  const tl = d?.champion_timeline || [];
  if (!$("#champChart")) return;
  const t = (s) => new Date(s + "T00:00:00Z").getTime();
  lineChart($("#champChart"), [
    { label: "Champion tuning hit rate", borderColor: css("--s-kronos"), backgroundColor: css("--s-kronos"), pointRadius: 3,
      data: tl.map((p) => ({ x: t(p.date), y: p.tuning_hit == null ? null : +(p.tuning_hit * 100).toFixed(2) })) },
    { label: "Champion live hit rate (7d)", borderColor: css("--s-momentum"), backgroundColor: css("--s-momentum"), pointRadius: 3,
      data: tl.map((p) => ({ x: t(p.date), y: p.live_hit == null ? null : +(p.live_hit * 100).toFixed(2) })) },
  ], { refLine: { y: 50, label: "50% (luck)" }, xType: "date" });
}

/* ------------------------------------------------------------ shell */

async function headerStatus() {
  const live = await load("live");
  const el = $("#updated"), banner = $("#banner");
  if (!live || !live.last_run_at) { el.textContent = "Live logger has not run yet"; return; }
  const last = live.last_run_at.replace(" ", "T") + "Z";
  el.innerHTML = `Last logger run: <b>${new Date(last).toLocaleString()}</b> (${ago(last)})`;
  const mins = (Date.now() - new Date(last).getTime()) / 60000;
  if (mins > STALE_MINUTES) {
    banner.hidden = false;
    banner.textContent = `⚠ The live logger hasn't updated in ${ago(last).replace(" ago", "")}. Check the "Live logger" workflow on GitHub (Actions tab).`;
  } else {
    banner.hidden = true;
  }
}

async function render() {
  stopPrices();
  destroyCharts();
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === state.tab));
  const main = $("#main");
  const d = state.tab === "candlesticks" ? null : await load(state.tab);
  try {
    if (state.tab === "live") { main.innerHTML = pageHead("live") + renderLive(d); if (d) { drawPerformanceCharts(d); startPrices(); } }
    if (state.tab === "backtest") { main.innerHTML = pageHead("backtest") + renderBacktest(d); if (d?.range?.first != null) drawPerformanceCharts(d); }
    if (state.tab === "experiments") { main.innerHTML = pageHead("experiments") + renderExperiments(d); drawExperimentChart(d); }
    if (state.tab === "candlesticks") { main.innerHTML = pageHead("candlesticks") + renderCandles(); bindCandles(); }
  } catch (e) {
    console.error(e);
    main.innerHTML = `<p class="pad muted">Could not render this tab: ${esc(e.message)}</p>`;
  }
  main.querySelectorAll("[data-coin]").forEach((b) => b.addEventListener("click", () => { state.coin = b.dataset.coin; save(); render(); }));
}

/* ------------------------------------------------------------ live candlestick charts
   Candles come straight from Coinbase's free public API, and Coinbase's real-time feed
   updates the forming candle on every trade. Charts: TradingView Lightweight Charts. */
const PRICE_COINS = ["BTC-USD", "ETH-USD", "SOL-USD"];
// g = candle size in seconds. LIVE builds 1-second candles from the trade stream.
const RANGES = {
  LIVE: { g: 1, live: true, label: "1-second candles" },
  "1m": { g: 60, label: "1-minute candles" },
  "5m": { g: 300, label: "5-minute candles" },
  "15m": { g: 900, label: "15-minute candles (Kronos's)" },
  "1h": { g: 3600, label: "1-hour candles" },
};
const SHOW_BARS = 70;   // start zoomed in on the latest ~70 candles; scroll or pinch to zoom
const CB = "https://api.exchange.coinbase.com";
const price = { range: "15m", gen: 0, timers: [], charts: {}, series: {}, bars: {}, lines: {}, last: {}, ws: null, wsCoins: "" };
try { price.range = localStorage.getItem("candlelab-range2") || "15m"; } catch {}
if (!RANGES[price.range]) price.range = "15m";

const fmtPrice = (p) => p.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hhmmss = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

function priceSection() {
  const coins = state.coin === "ALL" ? PRICE_COINS : [state.coin];
  return `<h2>Live candles</h2>
  <div class="chips range" role="group" aria-label="Candle size">${Object.keys(RANGES).map((r) =>
    `<button class="chip${r === "LIVE" ? " livechip" : ""}" data-range="${r}" aria-pressed="${price.range === r}">${r === "LIVE" ? '<span class="dotlive"></span>LIVE' : r}</button>`).join("")}
    <span class="rangeinfo" id="rangeinfo"></span></div>
  <div class="pgrid${coins.length === 1 ? " one" : ""}">${coins.map((c) => `
    <div class="pcard" id="p-${c}">
      <div class="ph">
        <div><div class="label">${c.replace("-USD", "")}</div>
          <div class="pbig" data-f="price">–</div><div class="pchg" data-f="chg">&nbsp;</div></div>
      </div>
      <div class="odds" data-f="odds"></div>
      <div class="pchart" data-f="chart"></div>
    </div>`).join("")}</div>
  <p class="note">Scroll or pinch on a chart to zoom, drag to move back in time, double-click to snap back to now.
  Prices come straight from Coinbase's free public feed (Robinhood's can differ by a few dollars).
  Arrows are Kronos's calls on each 15-minute candle (<span class="pos">green = right</span>, <span class="neg">red = wrong</span>, blue = still open);
  the dashed blue line is the price Kronos expects the current 15-minute candle to close at.
  The Up/Down chances are the share of Kronos's samples pointing each way, not a guarantee.</p>`;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------- data ---------- */
async function loadBars(coin, rangeKey = price.range) {
  const R = RANGES[rangeKey];
  if (R.live) {  // seed 1-second candles from the latest trades
    const trades = await getJSON(`${CB}/products/${coin}/trades?limit=1000`);
    const bars = new Map();
    trades.slice().reverse().forEach((t) => tickInto(bars, 1, Math.floor(Date.parse(t.time) / 1000), +t.price));
    bars.g = R.g;
    return bars;
  } else {
    const rows = await getJSON(`${CB}/products/${coin}/candles?granularity=${R.g}`);  // latest 300 candles
    const bars = new Map();
    rows.sort((a, b) => a[0] - b[0]).forEach((x) => bars.set(x[0], { time: x[0], low: +x[1], high: +x[2], open: +x[3], close: +x[4] }));
    // keep whatever the live feed has already added to the forming candle
    const old = price.bars[coin];
    if (old && old.g === R.g) {
      const lastT = rows.length ? rows[rows.length - 1][0] : 0;
      for (const [t, b] of old) {
        if (t > lastT) bars.set(t, b);
        else if (t === lastT) bars.set(t, mergeBar(bars.get(t), b));
      }
    }
    bars.g = R.g;
    return bars;
  }
}
function mergeBar(a, b) {
  if (!a) return b;
  return { time: a.time, open: a.open, high: Math.max(a.high, b.high), low: Math.min(a.low, b.low), close: b.close };
}
function tickInto(bars, g, sec, p) {
  const t = Math.floor(sec / g) * g;
  const b = bars.get(t);
  if (b) { b.high = Math.max(b.high, p); b.low = Math.min(b.low, p); b.close = p; }
  else {
    const prev = [...bars.values()].pop();
    bars.set(t, { time: t, open: prev ? prev.close : p, high: Math.max(p, prev ? prev.close : p), low: Math.min(p, prev ? prev.close : p), close: p });
    if (g === 1) for (const k of bars.keys()) { if (k < t - 900) bars.delete(k); else break; }  // keep 15 min of 1s candles
  }
  return bars.get(t);
}

/* ---------- real-time feed (all candle sizes) ---------- */
function openStream(coins) {
  const key = coins.join(",");
  if (price.ws && price.wsCoins === key && price.ws.readyState <= 1) return;
  closeStream();
  const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
  price.ws = ws; price.wsCoins = key;
  ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", product_ids: coins, channels: ["ticker"] }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== "ticker" || !m.price) return;
    const coin = m.product_id, bars = price.bars[coin];
    if (!bars) return;
    const p = +m.price, sec = Math.floor((m.time ? Date.parse(m.time) : Date.now()) / 1000);
    price.last[coin] = p;
    const bar = tickInto(bars, bars.g, sec, p);
    try { price.series[coin]?.update({ ...bar }); } catch {}
    updateHeader(coin);
  };
  ws.onclose = () => { if (price.ws === ws) setTimeout(() => price.ws === ws && (price.ws = null, openStream(coins)), 3000); };
}
function closeStream() { const ws = price.ws; price.ws = null; price.wsCoins = ""; if (ws) try { ws.close(); } catch {} }

/* ---------- Kronos ---------- */
function openCall(coin) {
  const now = Date.now() / 1000;
  return (state.data.live?.marks?.[coin] || []).find((m) => m.actual == null && m.t <= now && m.t + 900 > now);
}
function pUp(m) { return m.dir === "up" ? m.conf : m.dir === "down" ? 1 - m.conf : 0.5; }

function renderOdds(coin) {
  const el = document.querySelector(`#p-${coin} [data-f=odds]`);
  if (!el) return;
  const marks = state.data.live?.marks?.[coin] || [];
  const done = marks.filter((m) => m.ok != null);
  const rec = done.length ? `Kronos's live record on ${coin.replace("-USD", "")}: <b>${done.filter((m) => m.ok).length} of ${done.length}</b> right` : "No scored calls yet";
  const m = openCall(coin);
  if (!m) {
    el.innerHTML = `<div class="olabel">Next 15-minute candle</div>
      <div class="obar off"><div class="oup" style="width:50%">▲ UP –</div><div class="odown" style="width:50%">– DOWN ▼</div></div>
      <div class="osub">Waiting for Kronos's next call · ${rec}</div>`;
    return;
  }
  const up = pUp(m), left = Math.max(0, Math.round(m.t + 900 - Date.now() / 1000));
  const now = price.last[coin];
  const move = now && m.last ? (now / m.last - 1) * 100 : null;
  const onTrack = move == null || m.dir === "skip" ? "" : (move > 0) === (m.dir === "up")
    ? `<span class="pos">✓ on track</span>` : `<span class="neg">✗ going against it</span>`;
  el.innerHTML = `<div class="olabel">Next close · ${hhmm(m.t * 1000)}–${hhmm((m.t + 900) * 1000)} candle · closes in <b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</b></div>
    <div class="obar"><div class="oup${up >= 0.5 ? " lead" : ""}" style="width:${Math.max(up * 100, 14)}%">▲ UP ${Math.round(up * 100)}%</div>
      <div class="odown${up < 0.5 ? " lead" : ""}" style="width:${Math.max((1 - up) * 100, 14)}%">${Math.round((1 - up) * 100)}% DOWN ▼</div></div>
    <div class="osub">Kronos ${m.dir === "skip" ? "is too unsure to call it" : "calls <b>" + m.dir.toUpperCase() + "</b>"}${m.pred != null ? ` · expects close <b>$${fmtPrice(m.pred)}</b>` : ""}
      ${move != null ? ` · since the call: <span class="${move >= 0 ? "pos" : "neg"}">${move >= 0 ? "▲" : "▼"} ${signed(move, Math.abs(move) < 0.1 ? 3 : 2)}</span> ${onTrack}` : ""}</div>
    <div class="osub">${rec}</div>${honesty(coin, m)}`;
}

// "When Kronos has said this much before, it was right X%": from the backtest's calibration.
function honesty(coin, m) {
  if (m.dir === "skip") return "";
  const rows = state.data.backtest?.coins?.[coin]?.calibration || [];
  const r = rows.find((x) => m.conf >= x.lo && (m.conf < x.hi || x.hi >= 1));
  if (!r || r.calls < 30) return "";
  return `<div class="osub honesty">Reality check: in the backtest, when Kronos said <b>${r.bin}</b> it was right
    <b class="${r.actual >= r.stated - 0.02 ? "pos" : "neg"}">${pct(r.actual)}</b> of the time (${num(r.calls)} calls).</div>`;
}

function kronosOverlay(coin) {
  const s = price.series[coin], R = RANGES[price.range];
  if (!s) return;
  const bars = price.bars[coin];
  const first = bars && bars.size ? [...bars.keys()][0] : 0;
  const marks = (state.data.live?.marks?.[coin] || [])
    .filter((m) => m.dir !== "skip" && m.t >= first && !R.live && R.g <= 900)
    .map((m) => {
      const t = Math.floor(m.t / R.g) * R.g;
      const col = m.ok == null ? css("--s-kronos") : m.ok ? css("--good") : css("--bad");
      return m.dir === "up"
        ? { time: t, position: "belowBar", shape: "arrowUp", color: col, text: m.ok == null ? "Kronos" : m.ok ? "✓" : "✗" }
        : { time: t, position: "aboveBar", shape: "arrowDown", color: col, text: m.ok == null ? "Kronos" : m.ok ? "✓" : "✗" };
    });
  try { s.setMarkers(marks); } catch {}
  if (price.lines[coin]) { try { s.removePriceLine(price.lines[coin]); } catch {} price.lines[coin] = null; }
  const m = openCall(coin);
  if (m && m.pred != null) {
    price.lines[coin] = s.createPriceLine({ price: m.pred, color: css("--s-kronos"), lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `Kronos ${hhmm((m.t + 900) * 1000)}` });
  }
}

/* ---------- chart ---------- */
function updateHeader(coin) {
  const card = document.getElementById("p-" + coin);
  const bars = price.bars[coin];
  if (!card || !bars || !bars.size) return;
  const arr = [...bars.values()], last = arr[arr.length - 1].close, first = arr[0].open;
  const up = last >= first, chg = last - first;
  card.querySelector("[data-f=price]").textContent = "$" + fmtPrice(last);
  const span = arr[arr.length - 1].time - arr[0].time + bars.g;
  const spanTxt = span >= 86400 ? `${(span / 86400).toFixed(span >= 172800 ? 0 : 1)} days` : span >= 3600 ? `${(span / 3600).toFixed(span >= 7200 ? 0 : 1)} hours` : `${Math.round(span / 60)} min`;
  card.querySelector("[data-f=chg]").innerHTML = `<span class="${up ? "pos" : "neg"}">${up ? "▲" : "▼"} $${fmtPrice(Math.abs(chg))} (${signed((chg / first) * 100)})</span> <span class="muted">past ${spanTxt}</span>`;
  card.style.setProperty("--pc", css(up ? "--good" : "--bad"));
}

function buildChart(coin) {
  const card = document.getElementById("p-" + coin);
  if (!card || typeof LightweightCharts === "undefined") return;
  const R = RANGES[price.range];
  const el = card.querySelector("[data-f=chart]");
  el.innerHTML = "";
  const fmtTick = (t) => R.g >= 3600 ? new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hhmm(t * 1000)
    : R.g === 1 ? hhmmss(t * 1000) : hhmm(t * 1000);
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: "#9A9DA4", fontFamily: "Barlow, system-ui, sans-serif", fontSize: 12 },
    grid: { vertLines: { color: "rgba(255,255,255,.04)" }, horzLines: { color: "rgba(255,255,255,.06)" } },
    rightPriceScale: { borderColor: "#2B2D32", scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderColor: "#2B2D32", rightOffset: 4, barSpacing: 9, minBarSpacing: 2, timeVisible: true, secondsVisible: R.g === 1,
      tickMarkFormatter: (t) => fmtTick(t) },
    localization: { timeFormatter: (t) => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", second: R.g === 1 ? "2-digit" : undefined }),
      priceFormatter: (p) => "$" + fmtPrice(p) },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "rgba(255,255,255,.25)", labelBackgroundColor: "#202226" }, horzLine: { color: "rgba(255,255,255,.25)", labelBackgroundColor: "#202226" } },
  });
  const series = chart.addCandlestickSeries({
    upColor: "#53D337", downColor: "#FF5C61", borderUpColor: "#53D337", borderDownColor: "#FF5C61",
    wickUpColor: "#53D337", wickDownColor: "#FF5C61", priceLineColor: "#F2F3F5", priceLineStyle: LightweightCharts.LineStyle.Dotted,
  });
  price.charts[coin] = chart; price.series[coin] = series; price.lines[coin] = null;
  const data = [...(price.bars[coin]?.values() || [])].map((b) => ({ ...b }));
  series.setData(data);
  const show = Math.max(30, Math.min(SHOW_BARS, Math.floor(el.clientWidth / 11)));  // closer on phones
  if (data.length > show) chart.timeScale().setVisibleLogicalRange({ from: data.length - show, to: data.length + 3 });
  el.addEventListener("dblclick", () => chart.timeScale().scrollToRealTime());
  kronosOverlay(coin);
  updateHeader(coin);
}

function refreshData(coin) {  // re-sync candles from the REST API without moving the user's zoom
  const s = price.series[coin];
  if (!s) return;
  s.setData([...price.bars[coin].values()].map((b) => ({ ...b })));
  kronosOverlay(coin);
  updateHeader(coin);
}

function stopPrices() {
  price.timers.forEach(clearInterval); price.timers = [];
  closeStream();
  Object.values(price.charts).forEach((c) => { try { c.remove(); } catch {} });
  price.charts = {}; price.series = {}; price.lines = {};
}

async function startPrices() {
  load("backtest");  // for the Up/Down "reality check" line
  const coins = state.coin === "ALL" ? PRICE_COINS : [state.coin];
  const all = async (fn) => Promise.all(coins.map((c) => fn(c).catch((e) => console.warn(c, e))));
  const info = (t) => { const el = $("#rangeinfo"); if (el) el.textContent = t; };

  async function startRange() {
    const gen = ++price.gen, key = price.range;   // a newer click makes this run stand down
    const current = () => gen === price.gen;
    const install = (c, bars) => {
      price.bars[c] = bars;
      const arr = [...bars.values()];
      if (arr.length) price.last[c] = arr[arr.length - 1].close;
    };
    price.timers.forEach(clearInterval); price.timers = [];
    Object.values(price.charts).forEach((c) => { try { c.remove(); } catch {} });
    price.charts = {}; price.series = {};
    const R = RANGES[price.range];
    info(R.live ? "connecting to live trades…" : R.label);
    price.bars = {};
    await all(async (c) => { const b = await loadBars(c, key); if (!current()) return; install(c, b); buildChart(c); renderOdds(c); });
    if (!current()) return;
    openStream(coins);
    info(R.live ? "1-second candles · streaming every trade" : R.label + " · updating live");
    if (!R.live) price.timers.push(setInterval(() => all(async (c) => {
      const b = await loadBars(c, key);
      if (current()) { install(c, b); refreshData(c); }
    }), R.g <= 60 ? 30000 : 60000));
    price.timers.push(setInterval(() => coins.forEach(renderOdds), 1000));
  }

  document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
    if (price.range === b.dataset.range) return;
    price.range = b.dataset.range;
    try { localStorage.setItem("candlelab-range2", price.range); } catch {}
    document.querySelectorAll("[data-range]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    startRange();
  }));
  await startRange();
}

/* ------------------------------------------------------------ start */
function save() { try { localStorage.setItem("candlelab", JSON.stringify({ tab: state.tab, coin: state.coin })); } catch {} }
try { Object.assign(state, JSON.parse(localStorage.getItem("candlelab") || "{}")); } catch {}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; save(); render(); }));
headerStatus();
render();
// Check for new results every minute; redraw only when the logger has published something new.
async function fetchFresh(name) {
  const r = await fetch(`data/${name}.json?_=${Date.now()}`);
  return r.ok ? r.json() : null;
}
setInterval(async () => {
  try {
    const names = [...new Set(["live", state.tab])].filter((n) => n !== "candlesticks");
    const fresh = await Promise.all(names.map(fetchFresh));
    let changed = false;
    names.forEach((n, i) => {
      if (fresh[i] && fresh[i].updated_at !== state.data[n]?.updated_at) {
        state.data[n] = fresh[i];
        if (n === state.tab) changed = true;
      }
    });
    await headerStatus();
    if (changed) { const y = window.scrollY; await render(); window.scrollTo(0, y); }
  } catch {}
}, 60 * 1000);
