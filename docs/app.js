/* Candle Lab dashboard. Reads data/live.json, data/backtest.json, data/experiments.json. */
const MODELS = [
  { key: "kronos", name: "Kronos", color: "--s-kronos" },
  { key: "momentum", name: "Momentum", color: "--s-momentum" },
  { key: "coin_flip", name: "Coin flip", color: "--s-coin" },
  { key: "always_up", name: "Always up", color: "--s-up" },
  { key: "kronos_rev", name: "Kronos reversals", color: "--s-rev" },
  { key: "snapback", name: "Snap-back", color: "--s-snap" },
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

const state = { tab: "live", coin: "ALL", fee: "best", venue: "kalshi_taker", betsrc: "backtest", data: {}, charts: [] };
const VENUES = [
  { key: "kalshi_taker", name: "Kalshi (instant)", fee: "~1.75¢" },
  { key: "kalshi_maker", name: "Kalshi (limit)", fee: "~0.44¢" },
  { key: "robinhood", name: "Robinhood", fee: "~2¢" },
  { key: "polymarket", name: "Polymarket", fee: "~1.5¢" },
];
const venueInfo = () => VENUES.find((v) => v.key === state.venue) || VENUES[0];
const money = (x, d = 2) => (x == null ? "–" : (x < 0 ? "−$" : "+$") + Math.abs(x).toFixed(d));
const FEES = [
  { key: "best", name: "Best case", pct: "0.1%" },
  { key: "cb_maker", name: "Coinbase limit order", pct: "0.5%" },
  { key: "cb_taker", name: "Coinbase market order", pct: "0.9%" },
  { key: "robinhood", name: "Robinhood", pct: "~0.95%" },
];
const feeOf = (s, kind) => s?.[kind + "_by_fee"]?.[state.fee] ?? s?.[kind + "_pct"];
const feeInfo = () => FEES.find((f) => f.key === state.fee) || FEES[0];

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

const fmtP = (p) => (p == null ? "–" : p < 0.001 ? "p<0.001" : "p=" + (+p).toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));
function verdict(vs) {
  if (!vs || vs.edge_pp == null) return `<span class="verdict meh">NOT ENOUGH DATA</span>`;
  if (vs.p_value < 0.05 && vs.edge_pp > 0) return `<span class="verdict yes">✓ KRONOS BEATS IT (${fmtP(vs.p_value)})</span>`;
  if (vs.p_value > 0.95) return `<span class="verdict no">✗ KRONOS IS WORSE</span>`;
  return `<span class="verdict luck">≈ NO PROVEN EDGE (${fmtP(vs.p_value)})</span>`;
}

function matchups(coinData) {
  const k = coinData.models.kronos.summary;
  const cards = [`<div class="card"><div class="label">Kronos hit rate</div>
      <div class="big">${pct(k.hit_rate)}</div>
      <div class="sub">95% range ${pct(k.ci_low)} – ${pct(k.ci_high)} · ${num(k.calls)} calls</div>
      ${!k.calls ? `<span class="verdict meh">NOT ENOUGH DATA</span>` : k.ci_low > 0.5 ? `<span class="verdict yes">✓ ABOVE 50%</span>` : k.ci_high < 0.5 ? `<span class="verdict no">✗ BELOW 50%</span>` : `<span class="verdict luck">COULD BE LUCK</span>`}</div>`];
  for (const m of MODELS.filter((x) => !["kronos", "kronos_rev"].includes(x.key))) {
    const vs = coinData.kronos_vs[m.key];
    const s = coinData.models[m.key].summary;
    cards.push(`<div class="card"><div class="label"><span class="swatch" style="background:${css(m.color)}"></span>Kronos vs ${m.name}</div>
      <div class="big ${cls(vs.edge_pp)}">${signed(vs.edge_pp, 1, " pp")}</div>
      <div class="sub">${pct(k.hit_rate)} vs ${pct(s.hit_rate)}</div>${verdict(vs)}</div>`);
  }
  const rv = coinData.models.kronos_rev?.summary, sb = coinData.models.snapback?.summary;
  if (rv && rv.calls) {
    const edge = sb?.hit_rate != null ? (rv.hit_rate - sb.hit_rate) * 100 : null;
    const be = rv.bets?.[state.venue]?.breakeven;
    cards.push(`<div class="card"><div class="label"><span class="swatch" style="background:${css("--s-rev")}"></span>Kronos reversals only</div>
      <div class="big">${pct(rv.hit_rate)}</div>
      <div class="sub">95% range ${pct(rv.ci_low)} – ${pct(rv.ci_high)} · ${num(rv.calls)} calls · vs Snap-back ${signed(edge, 1, " pp")}</div>
      ${be && rv.ci_low > be ? `<span class="verdict yes">✓ ABOVE ${pct(be, 1)} BREAK-EVEN</span>` : be && rv.hit_rate > be ? `<span class="verdict luck">ABOVE BREAK-EVEN, NOT PROVEN</span>` : `<span class="verdict meh">BELOW ${be ? pct(be, 1) : "52%"} BREAK-EVEN</span>`}</div>`);
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
      ${pooled ? "" : `<td class="${cls(feeOf(s, "pnl"))}">${signed(feeOf(s, "pnl"))}</td><td class="${cls(feeOf(s, "hold"))}">${signed(feeOf(s, "hold"))}</td><td>${num(s.trades)}</td>`}
      <td>${s.mean_abs_pct_error == null ? "–" : s.mean_abs_pct_error.toFixed(3) + "%"}</td></tr>`;
  }).join("");
  return `<div class="tablewrap"><table><thead><tr><th>Model</th><th>Predictions</th><th>Hit rate</th><th>95% range</th><th>Coverage</th>
    ${pooled ? "" : "<th>Paper P&amp;L</th><th>Hold coin</th><th>Trades</th>"}<th>Avg abs error</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function feeChips() {
  return `<div class="chips feechips" role="group" aria-label="Trading fees"><span class="rangeinfo" style="margin:0 4px 0 0">Fees:</span>${FEES.map((f) =>
    `<button class="chip" data-fee="${f.key}" aria-pressed="${state.fee === f.key}">${f.name} <span class="muted">${f.pct}</span></button>`).join("")}</div>`;
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
  html += coinCompareSection(d.coin_compare);
  if (kind === "backtest") html += timeframesSection(d.timeframes);
  html += `<p class="note">Edge = Kronos hit rate minus the baseline's, in percentage points. "Beats it" needs a one-sided p-value under 0.05; anything else could be luck.</p>`;
  html += `<h2>Scoreboard</h2>${pooled ? "" : feeChips()}${scoreboard(coinData, pooled)}`;
  html += `<p class="note">Paper P&amp;L: buy when the call is "up", sit in cash otherwise, paying <b>${feeInfo().pct} on every buy and every sell</b> (${feeInfo().name}).
    Hold coin = buy once and hold over the same candles. Fee levels checked Nov 2026; your app's order preview shows your real cost.</p>`;
  html += calibrationSection(coinData, kind);
  if (pooled) {
    html += `<p class="note">Pick a coin above to see charts and P&amp;L.</p>`;
  } else {
    html += `<div class="grid2"><div><h2>Rolling hit rate (last ${kind === "live" ? 96 : 960} calls)</h2><div class="chartbox"><canvas id="rollChart"></canvas></div></div>
      <div><h2>Paper P&amp;L vs holding · ${feeInfo().name} fees</h2><div class="chartbox"><canvas id="pnlChart"></canvas></div></div></div>`;
  }
  return html;
}

/* ---------- Timeframes compared ---------- */
const TF = [["15m", "15 minutes"], ["1h", "1 hour"], ["6h", "6 hours"], ["1d", "1 day"]];
function timeframesSection(tf) {
  if (!tf || !Object.keys(tf).length) return "";
  const coin = state.coin, v = venueInfo();
  const rows = TF.filter(([h]) => tf[h]?.[coin]);
  if (!rows.length) return "";
  const p = tf[rows[0][0]][coin].p_differ;
  const feeRT = { best: 0.2, cb_maker: 1.0, cb_taker: 1.8, robinhood: 1.9 }[state.fee];
  const best = rows.reduce((a, [h]) => (tf[h][coin].kronos.hit_rate ?? 0) > (a ? tf[a][coin].kronos.hit_rate ?? 0 : -1) ? h : a, null);
  return `<h2>Timeframes compared${coin === "ALL" ? " · all coins" : " · " + coin.replace("-USD", "")}</h2>
    <div class="tablewrap"><table><thead><tr><th>Timeframe</th><th>Typical move</th><th>Big moves*</th><th>Kronos hit rate</th><th>95% range</th><th>vs Coin flip</th>
      <th>$1 bets (${esc(v.name)})</th><th>Trading P&amp;L (${feeInfo().pct})</th><th>Calls</th><th>Reversals only</th></tr></thead><tbody>
    ${rows.map(([h, label]) => {
      const e = tf[h][coin], k = e.kronos, mv = e.moves, b = k.bets?.[state.venue];
      return `<tr class="${h === best ? "bestrow" : ""}"><td><b>${label}</b>${h === "15m" ? ' <span class="muted">(main)</span>' : ""}${h === best ? ' <span class="pill up">TOP</span>' : ""}</td>
        <td>±${mv.avg.toFixed(2)}% <span class="muted">(1 in 10: ±${mv.p90.toFixed(1)}%+)</span></td>
        <td>${pct(mv.beats_fee?.[state.fee], 0)}</td>
        <td><b>${pct(k.hit_rate)}</b></td><td>${pct(k.ci_low)} – ${pct(k.ci_high)}${ciBar(k)}</td>
        <td class="${cls(e.kronos_vs?.coin_flip?.edge_pp)}">${signed(e.kronos_vs?.coin_flip?.edge_pp, 1, " pp")}</td>
        <td class="${cls(b?.pnl)}">${money(b?.pnl)} <span class="muted">(${b?.roi == null ? "–" : signed(b.roi * 100, 1)})</span></td>
        <td class="${cls(k.pnl_by_fee?.[state.fee])}">${coin === "ALL" ? "–" : signed(k.pnl_by_fee?.[state.fee])}</td>
        <td>${num(k.calls)}</td>
        <td>${e.kronos_rev ? `<b>${pct(e.kronos_rev.hit_rate)}</b> <span class="muted">(${pct(e.kronos_rev.ci_low)}–${pct(e.kronos_rev.ci_high)})</span>` : "–"}</td></tr>`;
    }).join("")}</tbody></table></div>
    <div class="note">${p == null ? "" : p < 0.05 ? `<span class="verdict yes">✓ TIMEFRAME MATTERS</span>` : `<span class="verdict luck">≈ DIFFERENCES COULD BE LUCK (p=${p.toFixed(2)})</span>`}
      Typical move = average size of one candle's up-or-down move. *Big moves = share of candles that moved more than the ${feeInfo().pct}×2 = ${feeRT}% round-trip trading cost.
      Up/Down bets cost about the same per bet on any timeframe (break-even ~52% at 50¢), so for betting only the hit rate matters; for trading coins, bigger moves make fees hurt less.
      Fewer candles on longer timeframes means wider 95% ranges.</div>`;
}

/* ---------- Which coin is Kronos best at? ---------- */
function coinCompareSection(cc) {
  if (!cc || !cc.rows?.length) return "";
  const rows = cc.rows;
  const verdict = cc.p_differ == null ? `<span class="verdict meh">NOT ENOUGH DATA</span>`
    : cc.p_differ < 0.05 ? `<span class="verdict yes">✓ REAL DIFFERENCE · BEST: ${esc(cc.best.replace("-USD", ""))}</span>`
    : `<span class="verdict luck">≈ DIFFERENCES COULD BE LUCK (p=${cc.p_differ.toFixed(2)})</span>`;
  return `<h2>Which coin is Kronos best at?</h2>
    <div class="tablewrap"><table><thead><tr><th>Coin</th><th>Calls</th><th>Kronos hit rate</th><th>95% range</th><th>vs Momentum</th><th>vs Coin flip</th><th>Paper P&amp;L (${feeInfo().pct} fees)</th><th>$1 bets (${venueInfo().name})</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.coin === cc.best && r.calls ? "bestrow" : ""}"><td><b>${esc(r.coin.replace("-USD", ""))}</b>${r.coin === cc.best && r.calls ? ' <span class="pill up">TOP</span>' : ""}</td>
      <td>${num(r.calls)}</td><td><b>${pct(r.hit_rate)}</b></td><td>${pct(r.ci_low)} – ${pct(r.ci_high)}${ciBar(r)}</td>
      <td class="${cls(r.vs_momentum?.edge_pp)}">${signed(r.vs_momentum?.edge_pp, 1, " pp")}</td>
      <td class="${cls(r.vs_coin_flip?.edge_pp)}">${signed(r.vs_coin_flip?.edge_pp, 1, " pp")}</td>
      <td class="${cls(r.pnl_by_fee?.[state.fee])}">${signed(r.pnl_by_fee?.[state.fee])}</td>
      <td class="${cls(r.bets?.[state.venue]?.pnl)}">${money(r.bets?.[state.venue]?.pnl)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="note">${verdict} <span style="margin-left:6px">A chi-square test checks whether the gap between coins is bigger than luck would produce. "TOP" is just the highest so far.</span></div>`;
}

/* ---------- Bets tab ---------- */
function venueChips() {
  return `<div class="chips feechips" role="group" aria-label="Betting venue"><span class="rangeinfo" style="margin:0 4px 0 0">Venue:</span>${VENUES.map((v) =>
    `<button class="chip" data-venue="${v.key}" aria-pressed="${state.venue === v.key}">${v.name} <span class="muted">${v.fee}</span></button>`).join("")}</div>`;
}

function renderBets(live, bt) {
  const src = state.betsrc === "live" ? live : bt;
  const v = venueInfo();
  let html = `<div class="card" style="margin-top:16px"><div class="label">How these bets work</div>
    <p class="sub" style="font-size:13.5px;line-height:1.55;margin:6px 0 0">Each 15-minute window has a contract like “BTC up in the next 15 mins?”. It pays <b>$1</b> if you're right and $0 if not.
    At an even price of <b>50¢</b> plus a ~2¢ fee you need to be right about <b>52%</b> of the time to break even, versus about 90% when buying and selling the coin.
    Paper only: nothing is bet.</p></div>`;
  html += `<div class="chips" role="group" aria-label="Data" style="margin-top:14px">${[["backtest", "Backtest history"], ["live", "Live"]].map(([k, l]) =>
    `<button class="chip" data-betsrc="${k}" aria-pressed="${state.betsrc === k}">${l}</button>`).join("")}</div>`;
  html += coinChips() + venueChips();

  // A) even-odds paper bets
  html += `<h2>Paper $1 bets on every call at even odds (50¢) · ${esc(v.name)} fees</h2>`;
  if (!src || !src.coins) {
    html += `<p class="muted">No ${state.betsrc} data yet.</p>`;
  } else {
    const cd = src.coins[state.coin];
    const be = cd.models.kronos.summary.bets?.[state.venue]?.breakeven;
    html += `<div class="tablewrap"><table><thead><tr><th>Strategy</th><th>Bets</th><th>Hit rate</th><th>Needed to break even</th><th>Profit / loss</th><th>Return per $ bet</th></tr></thead><tbody>
      ${MODELS.map((m) => {
        const sm = cd.models[m.key].summary, b = sm.bets?.[state.venue];
        return `<tr style="--sc:${css(m.color)}"><td><span class="swatch" style="background:${css(m.color)}"></span>Bet with ${m.name}</td><td>${num(sm.calls)}</td>
          <td><b class="${sm.hit_rate != null && b && sm.hit_rate > b.breakeven ? "pos" : ""}">${pct(sm.hit_rate)}</b></td><td>${b ? pct(b.breakeven) : "–"}</td>
          <td class="${cls(b?.pnl)}"><b>${money(b?.pnl)}</b></td><td class="${cls(b?.roi)}">${b?.roi == null ? "–" : signed(b.roi * 100, 1)}</td></tr>`;
      }).join("")}</tbody></table></div>
      <p class="note">One contract per call; Kronos skips unsure candles. Even odds is a simplification: real prices move with the crowd (see below). Break-even here: ${be ? pct(be) : "–"}.</p>`;
    if (state.coin !== "ALL") html += `<div class="chartbox" style="margin-top:10px"><canvas id="betChart"></canvas></div>`;
    else html += `<p class="note">Pick a coin to see the running total chart.</p>`;
  }

  // B) Kronos vs the Kalshi crowd
  const k = live?.kalshi;
  html += `<h2>Kronos vs the Kalshi crowd (live, real prices)</h2>`;
  if (!k || !k.settled) {
    html += `<div class="card"><p class="sub" style="font-size:13.5px;margin:0">Collecting: every 15 minutes the logger records Kalshi's prices for BTC, ETH and SOL right when Kronos makes its call,
      then Kalshi's official result. ${k ? num(k.windows) + " windows logged so far; waiting for results." : ""} The comparison appears here as windows settle.</p></div>`;
  } else {
    const a = k.coins[state.coin] || k.coins.ALL;
    const sharper = a.brier_kronos != null && a.brier_crowd != null ? (a.brier_kronos < a.brier_crowd ? "Kronos" : "The crowd") : null;
    html += `<div class="cards">
      <div class="card"><div class="label">Kronos right</div><div class="big">${pct(a.kronos_hit)}</div><div class="sub">${num(a.kronos_calls)} calls · 95% range ${pct(a.kronos_ci[0])}–${pct(a.kronos_ci[1])}</div></div>
      <div class="card"><div class="label">Crowd's favorite right</div><div class="big">${pct(a.crowd_hit)}</div><div class="sub">${num(a.crowd_calls)} windows · the side priced above 50¢</div></div>
      <div class="card"><div class="label">Whose odds are sharper?</div><div class="big" style="font-size:24px">${sharper ? esc(sharper) : "–"}</div>
        <div class="sub">Brier score (lower = better): Kronos ${a.brier_kronos?.toFixed(3) ?? "–"} vs crowd ${a.brier_crowd?.toFixed(3) ?? "–"}</div>
        ${sharper === "Kronos" ? `<span class="verdict yes">KRONOS KNOWS MORE</span>` : sharper ? `<span class="verdict no">CROWD KNOWS MORE</span>` : ""}</div>
      <div class="card"><div class="label">Bet every Kronos call at the real price</div><div class="big ${cls(a.follow[state.venue])}">${money(a.follow[state.venue])}</div>
        <div class="sub">avg price paid ${a.avg_price != null ? Math.round(a.avg_price * 100) + "¢" : "–"} · ${esc(v.name)} fees</div></div>
      <div class="card"><div class="label">Only Kronos reversal bets</div><div class="big ${cls(a.rev?.[state.venue])}">${money(a.rev?.[state.venue])}</div>
        <div class="sub">${num(a.rev_bets)} bets · ${a.rev_bets ? pct(a.rev_hits / a.rev_bets) : "–"} right · at the real price</div></div>
      <div class="card"><div class="label">Only “value” bets</div><div class="big ${cls(a.value[state.venue])}">${money(a.value[state.venue])}</div>
        <div class="sub">${num(a.value_bets)} bets where Kronos's chance beat the price + fee by 2+ points</div></div>
    </div>
    <div class="chartbox" style="margin-top:10px"><canvas id="crowdChart"></canvas></div>
    <h2>Recent windows</h2><div class="tablewrap"><table><thead><tr><th>Window (your time)</th><th>Coin</th><th>Kalshi “Up” price</th><th>Kronos</th><th>Result</th><th>Bet price</th><th>Bet P&amp;L (Kalshi instant)</th></tr></thead><tbody>
    ${k.recent.filter((r) => state.coin === "ALL" || r.coin === state.coin).slice(0, 40).map((r) => `<tr class="${r.pnl == null ? "" : r.pnl > 0 ? "hit" : "miss"}">
      <td>${fmtTime(r.t)}</td><td>${esc(r.coin.replace("-USD", ""))}</td><td>${Math.round(r.yes_bid * 100)}–${Math.round(r.yes_ask * 100)}¢</td>
      <td>${dirPill(r.dir)} <span class="muted">${r.dir && r.dir !== "skip" ? pct(r.dir === "up" ? r.p_up : 1 - r.p_up, 0) : ""}</span>${r.value_bet ? ' <span class="pill up">VALUE</span>' : ""}</td>
      <td>${r.result === "yes" ? '<span class="pos">▲ Up</span>' : '<span class="neg">▼ Down</span>'}</td>
      <td>${r.price == null ? "–" : Math.round(r.price * 100) + "¢"}</td><td class="${cls(r.pnl)}">${r.pnl == null ? "–" : money(r.pnl)}</td></tr>`).join("")}
    </tbody></table></div>`;
  }
  html += `<p class="note">Kalshi settles on the CF Benchmarks index (60-second averages), not Coinbase's candle, so results can differ slightly from the Live tab.
    Candle Lab records prices about 75 seconds into each window, so the odds may already have moved. Fees: Kalshi 0.07×price×(1−price) for instant fills, 0.0175× for limit orders;
    Robinhood ~2¢ per contract; Polymarket reported up to ~3% at 50/50 (unconfirmed for US). Real money carries real risk, and the tax treatment of these contracts is unsettled.</p>`;
  return html;
}

function drawBetCharts(live, bt) {
  const src = state.betsrc === "live" ? live : bt;
  if ($("#betChart") && src?.coins?.[state.coin]) {
    const cd = src.coins[state.coin].models, r = cd.kronos.rolling;
    lineChart($("#betChart"), MODELS.map((m) => ({
      label: "Bet with " + m.name, borderColor: css(m.color), backgroundColor: css(m.color),
      data: cd[m.key].rolling.map((p) => ({ x: p.t, y: p.bet_f?.[state.venue] ?? null })),
    })), { refLine: { y: 0, label: "Break-even" }, yFmt: (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(0),
      xType: r.length && r[r.length - 1].t - r[0].t > 3 * 86400 ? "days" : "time" });
  }
  const k = live?.kalshi;
  if ($("#crowdChart") && k?.curve?.length) {
    lineChart($("#crowdChart"), [
      { label: "Bet every Kronos call", borderColor: css("--s-kronos"), backgroundColor: css("--s-kronos"), data: k.curve.map((p) => ({ x: p.t, y: p["follow_" + state.venue] })) },
      { label: "Value bets only", borderColor: css("--warn"), backgroundColor: css("--warn"), data: k.curve.map((p) => ({ x: p.t, y: p["value_" + state.venue] })) },
      { label: "Reversal bets only", borderColor: css("--s-rev"), backgroundColor: css("--s-rev"), data: k.curve.map((p) => ({ x: p.t, y: p["rev_" + state.venue] ?? null })) },
    ], { refLine: { y: 0, label: "Break-even" }, yFmt: (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2) });
  }
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
    data: cd[m.key].rolling.map((p) => ({ x: p.t, y: p.pnl_f?.[state.fee] ?? p.pnl })),
  }));
  pnl.push({ label: "Hold coin", borderColor: css("--s-hold"), backgroundColor: css("--s-hold"), borderDash: [6, 3],
    data: cd.kronos.rolling.map((p) => ({ x: p.t, y: p.hold_f?.[state.fee] ?? p.hold })) });
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
  trials: ["Trials", "What would have happened if we changed some stuff? Re-run the backtest with different settings, instantly"],
  bets: ["Bets", "15-minute “up or down” prediction markets (Kalshi, Robinhood, Polymarket): paper bets on Kronos's calls, and Kronos vs the betting crowd"],
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
  const d = ["candlesticks", "trials"].includes(state.tab) ? null : state.tab === "bets" ? await load("live") : await load(state.tab);
  try {
    if (state.tab === "live") { main.innerHTML = pageHead("live") + renderLive(d); if (d) { drawPerformanceCharts(d); startPrices(); } }
    if (state.tab === "backtest") { main.innerHTML = pageHead("backtest") + renderBacktest(d); if (d?.range?.first != null) drawPerformanceCharts(d); }
    if (state.tab === "experiments") { main.innerHTML = pageHead("experiments") + renderExperiments(d); drawExperimentChart(d); }
    if (state.tab === "candlesticks") { main.innerHTML = pageHead("candlesticks") + renderCandles(); bindCandles(); }
    if (state.tab === "trials") { main.innerHTML = pageHead("trials") + renderTrials(); bindTrials(); drawTrials(); }
    if (state.tab === "bets") { const bt = await load("backtest"); main.innerHTML = pageHead("bets") + renderBets(d, bt); drawBetCharts(d, bt); }
  } catch (e) {
    console.error(e);
    main.innerHTML = `<p class="pad muted">Could not render this tab: ${esc(e.message)}</p>`;
  }
  main.querySelectorAll("[data-coin]").forEach((b) => b.addEventListener("click", () => { state.coin = b.dataset.coin; save(); render(); }));
  main.querySelectorAll("[data-venue]").forEach((b) => b.addEventListener("click", () => {
    state.venue = b.dataset.venue; save(); const y = window.scrollY; render().then(() => window.scrollTo(0, y));
  }));
  main.querySelectorAll("[data-betsrc]").forEach((b) => b.addEventListener("click", () => {
    state.betsrc = b.dataset.betsrc; save(); const y = window.scrollY; render().then(() => window.scrollTo(0, y));
  }));
  main.querySelectorAll("[data-fee]").forEach((b) => b.addEventListener("click", () => {
    state.fee = b.dataset.fee; save(); const y = window.scrollY; render().then(() => window.scrollTo(0, y));
  }));
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
      <div class="osub">Waiting for Kronos's next call · ${rec}</div>
      <div class="wbtns"><button class="wbtn up" data-wbet="${coin}:up">Practice: bet ▲ Up</button><button class="wbtn down" data-wbet="${coin}:down">Practice: bet ▼ Down</button></div>`;
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
    <div class="osub">${rec}</div>${crowdLine(coin, m)}${honesty(coin, m)}
    <div class="wbtns"><button class="wbtn up" data-wbet="${coin}:up">Practice: bet ▲ Up</button><button class="wbtn down" data-wbet="${coin}:down">Practice: bet ▼ Down</button></div>`;
}

// Kalshi's betting crowd for the same window, as logged at Kronos's call.
function crowdLine(coin, m) {
  const k = state.data.live?.kalshi?.now?.[coin];
  if (!k || k.t !== m.t || k.yes_bid == null) return "";
  const up = (k.yes_bid + k.yes_ask) / 2;
  return `<div class="osub">Kalshi crowd: <b class="pos">▲ Up ${Math.round(k.yes_bid * 100)}–${Math.round(k.yes_ask * 100)}¢</b>
    (≈${Math.round(up * 100)}% chance) at ${Math.round(k.secs)}s into the window · Kronos says ${Math.round(pUp(m) * 100)}%</div>`;
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
function save() { try { localStorage.setItem("candlelab", JSON.stringify({ tab: state.tab, coin: state.coin, fee: state.fee, venue: state.venue, betsrc: state.betsrc })); } catch {} }
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
    const names = [...new Set(["live", state.tab === "bets" ? "backtest" : state.tab])].filter((n) => n !== "candlesticks" && n !== "trials");
    const fresh = await Promise.all(names.map(fetchFresh));
    let changed = false;
    names.forEach((n, i) => {
      if (fresh[i] && fresh[i].updated_at !== state.data[n]?.updated_at) {
        state.data[n] = fresh[i];
        if (n === state.tab || state.tab === "bets") changed = true;
      }
    });
    await headerStatus();
    if (changed) { const y = window.scrollY; await render(); window.scrollTo(0, y); }
  } catch {}
}, 60 * 1000);
