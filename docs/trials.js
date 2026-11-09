/* Candle Lab: Trials. "What would have happened if we changed some stuff?"
   Re-scores the saved backtest forecasts in the browser with different decision settings.
   Like LineDesk: history is split by time into "Choose" (first 2/3, where you tune) and "Check"
   (last 1/3, never used for choosing). Settings that only win on Choose were probably lucky. */
const TR = {
  data: {},
  s: { coin: "BTC-USD", minConf: 0.5, blend: 0, minMove: 0, hold: false, invert: false },
  grid: null,
  KEY: "candlelab-trials",
};
try { Object.assign(TR.s, JSON.parse(localStorage.getItem(TR.KEY) || "{}")); } catch {}
const trSave = () => { try { localStorage.setItem(TR.KEY, JSON.stringify(TR.s)); } catch {} };

const TR_PRESETS = [
  { name: "Kronos as-is", why: "the current champion's way: call every candle", s: { minConf: 0.5, blend: 0, minMove: 0, hold: false, invert: false } },
  { name: "Only when confident", why: "skip unless 70%+ of samples agree", s: { minConf: 0.7, blend: 0, minMove: 0, hold: false, invert: false } },
  { name: "Big moves only", why: "only call when Kronos expects a 0.15%+ move", s: { minConf: 0.5, blend: 0, minMove: 15, hold: false, invert: false } },
  { name: "Trade less", why: "hold a buy until Kronos says down (fewer fees)", s: { minConf: 0.6, blend: 0, minMove: 0, hold: true, invert: false } },
  { name: "Mix in momentum", why: "half Kronos, half 'same as last candle'", s: { minConf: 0.5, blend: 0.5, minMove: 0, hold: false, invert: false } },
  { name: "Do the opposite", why: "bet against every Kronos call", s: { minConf: 0.5, blend: 0, minMove: 0, hold: false, invert: true } },
];

async function trLoad(coin) {
  if (TR.data[coin] !== undefined) return TR.data[coin];
  try {
    const r = await fetch(`data/trials-${coin}.json?_=${Math.floor(Date.now() / 600000)}`);
    TR.data[coin] = r.ok ? await r.json() : null;
  } catch { TR.data[coin] = null; }
  return TR.data[coin];
}

/* Score one setting on candles [a, b). Returns calls, hits, coverage, trading P&L (fee), $1-bet P&L (venue). */
function trRun(d, s, a, b, fee, venue) {
  let calls = 0, hits = 0, pos = 0, eq = 1, hold = 1, trades = 0, bet = 0, n = b - a;
  const vfee = { kalshi_taker: 0.07 * 0.25, kalshi_maker: 0.0175 * 0.25, robinhood: 0.02, polymarket: 0.12 * 0.125 }[venue] ?? 0.0175;
  const curve = [], every = Math.max(1, Math.floor(n / 240));
  for (let i = a; i < b; i++) {
    let p = d.p[i] / 100;
    if (s.blend) p = (1 - s.blend) * p + s.blend * d.u[i];
    const conf = Math.max(p, 1 - p), m = d.m[i];
    let dir = p > 0.5 ? 1 : p < 0.5 ? -1 : 0;
    if (conf < s.minConf) dir = 0;
    if (s.minMove && dir !== 0 && (dir === 1 ? m < s.minMove : m > -s.minMove)) dir = 0;
    if (s.invert) dir = -dir;
    const ret = d.r[i] / 1e4, actual = ret > 0 ? 1 : -1;
    if (dir !== 0) { calls++; if (dir === actual) hits++; bet += (dir === actual ? 1 : 0) - 0.5 - vfee; }
    // paper trading, long/flat: buy on "up"; sell on "down" (and on "skip" unless holding)
    const want = dir === 1 ? 1 : dir === -1 ? 0 : s.hold ? pos : 0;
    if (want !== pos) { eq *= 1 - fee; trades++; pos = want; }
    eq *= 1 + pos * ret;
    hold *= 1 + ret;
    if ((i - a) % every === 0 || i === b - 1) curve.push({ i, eq: (eq - 1) * 100, hold: (hold * (1 - fee) - 1) * 100, bet });
  }
  const [lo, hi] = wilson(hits, calls);
  return { n, calls, hits, hit: calls ? hits / calls : null, lo, hi, coverage: n ? calls / n : 0,
           pnl: (eq - 1) * 100, holdPnl: (hold * (1 - fee) - 1) * 100, trades, bet, betRoi: calls ? bet / (calls * (0.5 + vfee)) : null,
           breakeven: 0.5 + vfee, curve };
}

function wilson(h, n, z = 1.96) {
  if (!n) return [null, null];
  const p = h / n, den = 1 + z * z / n, c = (p + z * z / (2 * n)) / den, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [c - half, c + half];
}

function trSplit(d) { const n = d.p.length, cut = Math.floor(n * 2 / 3); return { n, cut }; }
const trTime = (d, i) => (d.ts ? d.ts[i] : d.t0 + i * d.step);
const trDate = (d, i) => new Date(trTime(d, i) * 1000).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });

function trCell(r) {
  if (!r) return "<td>–</td><td>–</td><td>–</td><td>–</td><td>–</td>";
  return `<td><b class="${r.hit != null && r.hit > 0.5 ? "pos" : ""}">${pct(r.hit)}</b> <span class="muted">(${pct(r.lo)}–${pct(r.hi)})</span></td>
    <td>${pct(r.coverage, 0)}</td><td class="${cls(r.pnl)}">${signed(r.pnl, 1)}</td><td class="${cls(r.bet)}">${money(r.bet)}</td><td>${num(r.calls)}</td>`;
}

function renderTrials() {
  const s = TR.s;
  const slider = (key, label, min, max, step, fmt) => `<label class="tr-sl"><span>${label}<b id="trv-${key}">${fmt(s[key])}</b></span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-trs="${key}" aria-label="${label}"></label>`;
  return `<div class="card" style="margin-top:16px"><div class="label">What would have happened if…</div>
      <p class="sub" style="font-size:13.5px;line-height:1.55;margin:6px 0 0">Change how Kronos's saved backtest forecasts are turned into calls and see the result instantly.
      History is split by time: <b>Choose</b> (first ⅔) is where you tune, <b>Check</b> (last ⅓) is the honest test. If something only wins on Choose, it was probably luck.
      Settings that need Kronos itself re-run (context length, samples, temperature) are tested by the nightly <b>Experiments</b> instead.</p></div>
    <div class="chips" role="group" aria-label="Coin" style="margin-top:14px">${["BTC-USD", "ETH-USD", "SOL-USD"].map((c) =>
      `<button class="chip" data-trc="${c}" aria-pressed="${s.coin === c}">${c.replace("-USD", "")}</button>`).join("")}</div>
    ${feeChips()}${venueChips()}
    <h2>Quick ideas</h2><div class="chips">${TR_PRESETS.map((p, i) => `<button class="chip" data-trp="${i}" title="${esc(p.why)}">${esc(p.name)}</button>`).join("")}</div>
    <h2>Your settings</h2>
    <div class="card tr-controls">
      ${slider("minConf", "Only call when samples agree at least ", 0.5, 1, 0.05, (v) => Math.round(v * 100) + "%")}
      ${slider("minMove", "Only call when the predicted move is at least ", 0, 50, 1, (v) => (v / 100).toFixed(2) + "%")}
      ${slider("blend", "Mix in momentum ", 0, 0.5, 0.05, (v) => Math.round(v * 100) + "%")}
      <label class="tr-ck"><input type="checkbox" data-trs="hold" ${s.hold ? "checked" : ""}> Trade less: keep holding through "unsure" candles; sell only on a "down" call</label>
      <label class="tr-ck"><input type="checkbox" data-trs="invert" ${s.invert ? "checked" : ""}> Do the opposite of Kronos</label>
    </div>
    <div id="tr-out"><p class="muted pad">Loading backtest forecasts…</p></div>
    <h2>Find the best settings</h2>
    <div class="card"><p class="sub" style="margin:0 0 10px">Tries ${5 * 6 * 4 * 2} combinations on <b>Choose</b>, ranks them by $1-bet profit, then shows how each did on <b>Check</b>, the part they never saw.</p>
      <button class="chip tr-go" data-trgrid="1">▶ Run the search</button><div id="tr-grid"></div></div>`;
}

async function drawTrials() {
  const out = $("#tr-out");
  const d = await trLoad(TR.s.coin);
  if (!out) return;
  if (!d || !d.p.length) { out.innerHTML = `<p class="muted pad">No backtest forecasts for ${TR.s.coin} yet. They appear as the backtest runs.</p>`; return; }
  const { n, cut } = trSplit(d), fee = FEE_RATE(), venue = state.venue;
  const base = { minConf: 0.5, blend: 0, minMove: 0, hold: false, invert: false };
  const mine = [trRun(d, TR.s, 0, cut, fee, venue), trRun(d, TR.s, cut, n, fee, venue)];
  const ref = [trRun(d, base, 0, cut, fee, venue), trRun(d, base, cut, n, fee, venue)];
  const coinflip = (r) => r ? `<td class="muted">${pct(r.breakeven)}</td>` : "";
  const warn = mine[0].bet > 0 && mine[1].bet <= 0 ? `<div class="banner" style="margin:10px 0 0">⚠ Wins on Choose but not on Check: probably luck, not a real edge.</div>`
    : mine[0].bet > 0 && mine[1].bet > 0 ? `<div class="note"><span class="verdict yes">✓ PROFITABLE ON BOTH PARTS</span> Still check the 95% ranges before trusting it.</div>` : "";
  out.innerHTML = `<div class="tablewrap"><table><thead><tr><th></th><th>Hit rate (95% range)</th><th>Makes a call</th><th>Trading P&amp;L (${feeInfo().pct})</th><th>$1 bets (${venueInfo().name})</th><th>Calls</th><th>Bet break-even</th></tr></thead><tbody>
      <tr style="--sc:${css("--accent")}"><td><b>Your settings · Choose</b><div class="muted" style="font-size:12px">${trDate(d, 0)} – ${trDate(d, cut - 1)}</div></td>${trCell(mine[0])}${coinflip(mine[0])}</tr>
      <tr style="--sc:${css("--warn")}"><td><b>Your settings · Check</b><div class="muted" style="font-size:12px">${trDate(d, cut)} – ${trDate(d, n - 1)}</div></td>${trCell(mine[1])}${coinflip(mine[1])}</tr>
      <tr style="--sc:${css("--s-kronos")}"><td>Kronos as-is · Choose</td>${trCell(ref[0])}${coinflip(ref[0])}</tr>
      <tr style="--sc:${css("--s-kronos")}"><td>Kronos as-is · Check</td>${trCell(ref[1])}${coinflip(ref[1])}</tr>
    </tbody></table></div>${warn}
    <div class="grid2" style="margin-top:10px"><div><h2>$1 bets, running total</h2><div class="chartbox"><canvas id="trBet"></canvas></div></div>
      <div><h2>Paper trading vs holding</h2><div class="chartbox"><canvas id="trPnl"></canvas></div></div></div>
    <p class="note">The shaded line marks where Choose ends and Check begins. ${num(n)} candles of ${TR.s.coin.replace("-USD", "")} history.</p>`;
  // continue Check from where Choose ended so each line is one continuous history
  const join = (rs, key) => {
    const a = rs[0].curve.map((p) => ({ x: trTime(d, p.i), y: p[key] }));
    const off = a.length ? a[a.length - 1].y : 0;
    const b = rs[1].curve.map((p) => ({ x: trTime(d, p.i), y: key === "bet" ? p[key] + off : p[key] }));
    return [...a, ...b].map((p) => ({ x: p.x, y: +p.y.toFixed(2) }));
  };
  const split = { x: trTime(d, cut) };
  const mark = (ys) => [{ x: split.x, y: Math.min(...ys) }, { x: split.x, y: Math.max(...ys) }];
  const betMine = join(mine, "bet"), betRef = join(ref, "bet");
  lineChart($("#trBet"), [
    { label: "Your settings", borderColor: css("--accent"), backgroundColor: css("--accent"), data: betMine },
    { label: "Kronos as-is", borderColor: css("--s-kronos"), backgroundColor: css("--s-kronos"), data: betRef },
    { label: "Choose | Check", borderColor: "#5c5f66", borderDash: [2, 3], borderWidth: 1, pointRadius: 0, data: mark([...betMine, ...betRef].map((p) => p.y)) },
  ], { refLine: { y: 0, label: "Break-even" }, yFmt: (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(0), xType: "days" });
  // trading P&L restarts at each part, so show each part on its own scale
  const eq = [...mine[0].curve.map((p) => ({ x: trTime(d, p.i), y: +p.eq.toFixed(2) })), ...mine[1].curve.map((p) => ({ x: trTime(d, p.i), y: +p.eq.toFixed(2) }))];
  const hd = [...mine[0].curve.map((p) => ({ x: trTime(d, p.i), y: +p.hold.toFixed(2) })), ...mine[1].curve.map((p) => ({ x: trTime(d, p.i), y: +p.hold.toFixed(2) }))];
  lineChart($("#trPnl"), [
    { label: "Your settings", borderColor: css("--accent"), backgroundColor: css("--accent"), data: eq },
    { label: "Hold coin", borderColor: css("--s-hold"), backgroundColor: css("--s-hold"), borderDash: [6, 3], data: hd },
    { label: "Choose | Check", borderColor: "#5c5f66", borderDash: [2, 3], borderWidth: 1, pointRadius: 0, data: mark([...eq, ...hd].map((p) => p.y)) },
  ], { refLine: { y: 0, label: "Break-even" }, xType: "days" });
  if (TR.grid && TR.grid.coin === TR.s.coin) drawGrid();
}

async function runGrid() {
  const el = $("#tr-grid");
  const d = await trLoad(TR.s.coin);
  if (!d || !el) return;
  el.innerHTML = `<p class="muted">Searching…</p>`;
  await new Promise((r) => setTimeout(r, 30));
  const { n, cut } = trSplit(d), fee = FEE_RATE(), venue = state.venue, rows = [];
  for (const minConf of [0.5, 0.6, 0.7, 0.8, 0.9])
    for (const minMove of [0, 5, 10, 15, 25, 40])
      for (const blend of [0, 0.2, 0.35, 0.5])
        for (const hold of [false, true]) {
          const s = { minConf, minMove, blend, hold, invert: false };
          const a = trRun(d, s, 0, cut, fee, venue);
          if (a.calls < 100) continue;  // too few calls to mean anything
          rows.push({ s, a, b: trRun(d, s, cut, n, fee, venue) });
        }
  rows.sort((x, y) => y.a.bet - x.a.bet);
  TR.grid = { coin: TR.s.coin, rows: rows.slice(0, 12), tried: rows.length };
  drawGrid();
}

function drawGrid() {
  const el = $("#tr-grid"), g = TR.grid;
  if (!el || !g) return;
  const held = g.rows.filter((r) => r.b.bet > 0).length;
  el.innerHTML = `<p class="note" style="margin-top:10px">Tried ${g.tried} settings with 100+ calls. Top ${g.rows.length} on Choose:
    <b class="${held ? "pos" : "neg"}">${held} of ${g.rows.length}</b> were still profitable on Check.</p>
    <div class="tablewrap"><table><thead><tr><th>Settings</th><th>Choose: hit · $1 bets</th><th>Check: hit · $1 bets</th><th></th></tr></thead><tbody>
    ${g.rows.map((r, i) => `<tr class="${r.b.bet > 0 ? "hit" : "miss"}"><td style="text-align:left">#${i + 1} · agree ≥${Math.round(r.s.minConf * 100)}% · move ≥${(r.s.minMove / 100).toFixed(2)}% · momentum ${Math.round(r.s.blend * 100)}%${r.s.hold ? " · trade less" : ""}
      <div class="muted" style="font-size:12px">calls on ${pct(r.a.coverage, 0)} of candles</div></td>
      <td>${pct(r.a.hit)} · <b class="${cls(r.a.bet)}">${money(r.a.bet)}</b></td><td>${pct(r.b.hit)} · <b class="${cls(r.b.bet)}">${money(r.b.bet)}</b></td>
      <td><button class="chip" data-trapply="${i}">Try it</button></td></tr>`).join("")}
    </tbody></table></div>
    <p class="note">If the winners on Choose mostly lose on Check, the "best" settings were luck. That is the most common result with short-term crypto.</p>`;
}

const FEE_RATE = () => ({ best: 0.001, cb_maker: 0.005, cb_taker: 0.009, robinhood: 0.0095 })[state.fee] ?? 0.001;

function bindTrials() {
  const rerun = () => { trSave(); destroyCharts(); drawTrials(); };
  document.querySelectorAll("[data-trs]").forEach((el) => el.addEventListener("input", () => {
    const k = el.dataset.trs;
    TR.s[k] = el.type === "checkbox" ? el.checked : +el.value;
    const lab = $("#trv-" + k);
    if (lab) lab.textContent = k === "minConf" || k === "blend" ? Math.round(TR.s[k] * 100) + "%" : (TR.s[k] / 100).toFixed(2) + "%";
    clearTimeout(TR._t); TR._t = setTimeout(rerun, 120);
  }));
  document.querySelectorAll("[data-trc]").forEach((b) => b.addEventListener("click", () => { TR.s.coin = b.dataset.trc; TR.grid = null; trSave(); render(); }));
  document.querySelectorAll("[data-trp]").forEach((b) => b.addEventListener("click", () => { Object.assign(TR.s, TR_PRESETS[+b.dataset.trp].s); trSave(); render(); }));
  document.querySelectorAll("[data-trgrid]").forEach((b) => b.addEventListener("click", runGrid));
  if (TR.bound) return;
  TR.bound = true;
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-trapply]");
    if (!b || !TR.grid) return;
    Object.assign(TR.s, TR.grid.rows[+b.dataset.trapply].s); trSave(); render();
  });
}
