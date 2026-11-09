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

Chart.defaults.color = "#a9b4c6";
Chart.defaults.borderColor = "#263247";
Chart.defaults.font.family = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

function lineChart(canvas, datasets, { yFmt = (v) => v + "%", refLine = null, xType = "time" } = {}) {
  const ann = refLine == null ? [] : [{
    label: refLine.label, data: datasets[0]?.data.map((p) => ({ x: p.x, y: refLine.y })) || [],
    borderColor: "#6f7c92", borderDash: [4, 4], borderWidth: 1, pointRadius: 0, pointHitRadius: 0,
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
        y: { ticks: { callback: yFmt }, grid: { color: "#1c2536" } },
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
  return `<span class="verdict meh">≈ NO PROVEN EDGE (p=${vs.p_value})</span>`;
}

function matchups(coinData) {
  const k = coinData.models.kronos.summary;
  const cards = [`<div class="card"><div class="label">Kronos hit rate</div>
      <div class="big">${pct(k.hit_rate)}</div>
      <div class="sub">95% range ${pct(k.ci_low)} – ${pct(k.ci_high)} · ${num(k.calls)} calls</div>
      ${!k.calls ? `<span class="verdict meh">NOT ENOUGH DATA</span>` : k.ci_low > 0.5 ? `<span class="verdict yes">✓ ABOVE 50%</span>` : k.ci_high < 0.5 ? `<span class="verdict no">✗ BELOW 50%</span>` : `<span class="verdict meh">COULD BE LUCK</span>`}</div>`];
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
    return `<tr><td><span class="swatch" style="background:${css(m.color)}"></span>${m.name}</td>
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
  html += `<h2>Matchups${pooled ? " · all coins pooled" : ""}</h2>${matchups(coinData)}`;
  html += `<p class="note">Edge = Kronos hit rate minus the baseline's, in percentage points. "Beats it" needs a one-sided p-value under 0.05; anything else could be luck.</p>`;
  html += `<h2>Scoreboard</h2>${scoreboard(coinData, pooled)}`;
  html += `<p class="note">Paper P&amp;L: buy when the call is "up", sit in cash otherwise, 0.1% fee on every buy and sell. Hold coin = buy once and hold over the same candles.</p>`;
  if (pooled) {
    html += `<p class="note">Pick a coin above to see charts and P&amp;L.</p>`;
  } else {
    html += `<div class="grid2"><div><h2>Rolling hit rate (last ${kind === "live" ? 96 : 960} calls)</h2><div class="chartbox"><canvas id="rollChart"></canvas></div></div>
      <div><h2>Paper P&amp;L vs holding</h2><div class="chartbox"><canvas id="pnlChart"></canvas></div></div></div>`;
  }
  return html;
}

function drawPerformanceCharts(d) {
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
      return `<tr><td>${fmtTime(x.t)}</td><td>${esc(x.coin.replace("-USD", ""))}</td><td>${num(x.last_close)}</td>
      <td>${x.pred_close == null ? "–" : num(+x.pred_close.toFixed(2))}</td><td>${dirPill(x.kronos)}</td>
      <td>${x.conf == null ? "–" : pct(x.conf, 0)}</td>
      <td>${x.actual_close == null ? "<span class='muted'>open</span>" : num(x.actual_close) + " " + (actualDir === "up" ? "▲" : "▼")}</td>
      <td>${x.kronos === "skip" ? "<span class='muted'>skipped</span>" : resultMark(x.kronos_correct)}</td>
      <td>${dirPill(x.momentum)} ${x.momentum_correct == null ? "" : x.momentum_correct ? "✓" : "✗"}</td>
      <td>${dirPill(x.coin_flip)} ${x.coin_flip_correct == null ? "" : x.coin_flip_correct ? "✓" : "✗"}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

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
  }
}

async function render() {
  destroyCharts();
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === state.tab));
  const main = $("#main");
  const d = await load(state.tab);
  try {
    if (state.tab === "live") { main.innerHTML = renderLive(d); if (d) drawPerformanceCharts(d); }
    if (state.tab === "backtest") { main.innerHTML = renderBacktest(d); if (d?.range?.first != null) drawPerformanceCharts(d); }
    if (state.tab === "experiments") { main.innerHTML = renderExperiments(d); drawExperimentChart(d); }
  } catch (e) {
    console.error(e);
    main.innerHTML = `<p class="pad muted">Could not render this tab: ${esc(e.message)}</p>`;
  }
  main.querySelectorAll("[data-coin]").forEach((b) => b.addEventListener("click", () => { state.coin = b.dataset.coin; save(); render(); }));
}

function save() { try { localStorage.setItem("candlelab", JSON.stringify({ tab: state.tab, coin: state.coin })); } catch {} }
try { Object.assign(state, JSON.parse(localStorage.getItem("candlelab") || "{}")); } catch {}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; save(); render(); }));
headerStatus();
render();
setInterval(() => { state.data = {}; headerStatus(); render(); }, 5 * 60 * 1000);
