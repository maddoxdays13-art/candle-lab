/* Candle Lab: Trials. "What would have happened if we changed some stuff?"
   Re-scores the saved backtest forecasts in the browser with different decision settings.
   Like LineDesk: history is split by time into "Choose" (first 2/3, where you tune) and "Check"
   (last 1/3, never used for choosing). Settings that only win on Choose were probably lucky. */
const TR = {
  data: {},
  s: { coin: "BTC-USD", tf: "15m", base: "kronos", rule: null, minConf: 0.5, blend: 0, minMove: 0, hold: false, invert: false },
  grid: null,
  KEY: "candlelab-trials",
};
try { Object.assign(TR.s, JSON.parse(localStorage.getItem(TR.KEY) || "{}")); } catch {}
const trSave = () => { try { localStorage.setItem(TR.KEY, JSON.stringify(TR.s)); } catch {} };

const TR_MOVE_MAX = { "15m": 50, "1h": 100, "6h": 200, "1d": 400 };  // slider max, basis points
const TR_PRESETS = [
  { name: "Kronos as-is", why: "the current champion's way: call every candle", s: { minConf: 0.5, blend: 0, minMove: 0, hold: false, invert: false } },
  { name: "Only when confident", why: "skip unless 70%+ of samples agree", s: { minConf: 0.7, blend: 0, minMove: 0, hold: false, invert: false } },
  { name: "Big moves only", why: "only call when Kronos expects a 0.15%+ move", s: { minConf: 0.5, blend: 0, minMove: 15, hold: false, invert: false } },
  { name: "Trade less", why: "hold a buy until Kronos says down (fewer fees)", s: { minConf: 0.6, blend: 0, minMove: 0, hold: true, invert: false } },
  { name: "Mix in momentum", why: "half Kronos, half 'same as last candle'", s: { minConf: 0.5, blend: 0.5, minMove: 0, hold: false, invert: false } },
  { name: "Do the opposite", why: "bet against every Kronos call", s: { minConf: 0.5, blend: 0, minMove: 0, hold: false, invert: true } },
];

async function trLoad(coin, tf = TR.s.tf) {
  const key = coin + "|" + tf;
  if (TR.data[key] !== undefined) return TR.data[key];
  try {
    const r = await fetch(`data/trials-${coin}${tf === "15m" ? "" : "-" + tf}.json?_=${Math.floor(Date.now() / 600000)}`);
    TR.data[key] = r.ok ? await r.json() : null;
  } catch { TR.data[key] = null; }
  return TR.data[key];
}

/* Score one setting on candles [a, b). Returns calls, hits, coverage, trading P&L (fee), $1-bet P&L (venue). */
/* Extra per-candle context, computed only from candles BEFORE each one (no lookahead):
   trend = direction of the previous 4 candles combined; vol = average size of the previous 16 moves. */
function trPrep(d) {
  if (d._prep) return d._prep;
  const n = d.r.length, trend = new Int8Array(n), vol = new Float32Array(n);
  let sum4 = 0, sum16 = 0;
  for (let i = 0; i < n; i++) {
    trend[i] = sum4 > 0 ? 1 : sum4 < 0 ? -1 : 0;
    vol[i] = i >= 16 ? sum16 / 16 : NaN;
    sum4 += d.r[i]; if (i >= 4) sum4 -= d.r[i - 4];
    sum16 += Math.abs(d.r[i]); if (i >= 16) sum16 -= Math.abs(d.r[i - 16]);
  }
  // "busy" vs "quiet": split at the median volatility of the Choose part only (never peeks at Check)
  const cut = Math.floor(n * 2 / 3), v = Array.from(vol.slice(16, cut)).sort((x, y) => x - y);
  d._prep = { trend, vol, volMed: v[Math.floor(v.length / 2)] || 0 };
  return d._prep;
}

/* One candle's call under settings s: +1 up, -1 down, 0 skip. */
function trDecide(d, s, i) {
  const u = d.u[i] ? 1 : -1;
  if (s.base === "coin") return ((Math.imul(i + 1, 2654435761) >>> 0) >>> 15) & 1 ? 1 : -1;
  if (s.base === "always_up") return 1;
  if (s.base === "momentum") return u;
  if (s.base === "reverse_momentum") return -u;
  let p = d.p[i] / 100;
  if (s.blend) p = (1 - s.blend) * p + s.blend * d.u[i];
  const conf = Math.max(p, 1 - p), m = d.m[i];
  let dir = p > 0.5 ? 1 : p < 0.5 ? -1 : 0;
  if (conf < s.minConf) dir = 0;
  if (s.minMove && dir !== 0 && (dir === 1 ? m < s.minMove : m > -s.minMove)) dir = 0;
  if (dir !== 0 && s.rule) {
    const pr = trPrep(d);
    if (s.rule === "agree_mom" && dir !== u) dir = 0;
    else if (s.rule === "reversal" && dir === u) dir = 0;
    else if (s.rule === "up_only" && dir !== 1) dir = 0;
    else if (s.rule === "trend" && dir !== pr.trend[i]) dir = 0;
    else if (s.rule === "busy" && !(pr.vol[i] > pr.volMed)) dir = 0;
    else if (s.rule === "quiet" && !(pr.vol[i] <= pr.volMed)) dir = 0;
  }
  if (s.invert) dir = -dir;
  return dir;
}

const TR_RULES = { agree_mom: "only when Kronos agrees with the last candle", reversal: "only Kronos's reversal calls",
  up_only: "only Kronos's UP calls", trend: "only in the direction of the last 4 candles",
  busy: "only in busy (volatile) markets", quiet: "only in quiet markets" };

/* Lab trials: ideas worth testing, like LineDesk's study versions. "Big move" is a share of the
   timeframe's move slider (TR_MOVE_MAX), so it scales from 15 minutes to a day. */
const TR_LAB = [
  { name: "Kronos as-is", why: "the current champion: call every candle", s: {} },
  { name: "Coin flip", why: "pure luck, the bar everything must clear", s: { base: "coin" } },
  { name: "Always up", why: "crypto has mostly drifted up; does that beat Kronos?", s: { base: "always_up" } },
  { name: "Momentum", why: "same direction as the last candle", s: { base: "momentum" } },
  { name: "Reverse momentum", why: "opposite of the last candle (prices snap back)", s: { base: "reverse_momentum" } },
  { name: "Confident 70%+", why: "skip candles where Kronos's samples disagree", s: { minConf: 0.7 } },
  { name: "Very confident 90%+", why: "only near-unanimous calls", s: { minConf: 0.9 } },
  { name: "Big moves", why: "only when Kronos predicts a large move (fees matter less)", s: { moveFrac: 0.3 } },
  { name: "Confident + big move", why: "70%+ agreement and a large predicted move", s: { minConf: 0.7, moveFrac: 0.3 } },
  { name: "Kronos + momentum agree", why: "only when Kronos says the move continues", s: { rule: "agree_mom" } },
  { name: "Kronos reversals only", why: "its confident calls lean toward reversals; are those any good?", s: { rule: "reversal" } },
  { name: "Fade Kronos", why: "do the exact opposite of every call", s: { invert: true } },
  { name: "Fade its 90%+ calls", why: "bet against Kronos only when it's most sure", s: { minConf: 0.9, invert: true } },
  { name: "Kronos UP calls only", why: "take its bullish calls, skip the bearish ones", s: { rule: "up_only" } },
  { name: "With the trend", why: "only when Kronos agrees with the last 4 candles", s: { rule: "trend" } },
  { name: "Busy markets only", why: "only when recent moves have been big", s: { rule: "busy" } },
  { name: "Quiet markets only", why: "only when recent moves have been small", s: { rule: "quiet" } },
  { name: "Half momentum", why: "50/50 blend of Kronos and the last candle", s: { blend: 0.5 } },
  { name: "Trade less (60%+)", why: "fewer coin trades: hold through unsure candles (affects trading P&L)", s: { minConf: 0.6, hold: true } },
];
const trBase = { base: "kronos", minConf: 0.5, blend: 0, minMove: 0, hold: false, invert: false, rule: null };
function trLabSettings(t) {
  const s = { ...trBase, ...t.s };
  if (s.moveFrac != null) { s.minMove = Math.round((TR_MOVE_MAX[TR.s.tf] || 50) * s.moveFrac); delete s.moveFrac; }
  return s;
}

function trRun(d, s, a, b, fee, venue) {
  let calls = 0, hits = 0, pos = 0, eq = 1, hold = 1, trades = 0, bet = 0, n = b - a;
  const vfee = { kalshi_taker: 0.07 * 0.25, kalshi_maker: 0.0175 * 0.25, robinhood: 0.02, polymarket: 0.12 * 0.125 }[venue] ?? 0.0175;
  const curve = [], every = Math.max(1, Math.floor(n / 240));
  for (let i = a; i < b; i++) {
    let dir = trDecide(d, s, i);
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
    <div class="chips feechips" role="group" aria-label="Timeframe"><span class="rangeinfo" style="margin:0 4px 0 0">Timeframe:</span>${[["15m", "15 min"], ["1h", "1 hour"], ["6h", "6 hours"], ["1d", "1 day"]].map(([k, l]) =>
      `<button class="chip" data-trtf="${k}" aria-pressed="${s.tf === k}">${l}</button>`).join("")}</div>
    ${feeChips()}${venueChips()}
    <h2>Quick ideas</h2><div class="chips">${TR_PRESETS.map((p, i) => `<button class="chip" data-trp="${i}" title="${esc(p.why)}">${esc(p.name)}</button>`).join("")}</div>
    <h2>Lab trials</h2>
    <div class="card"><p class="sub" style="margin:0 0 8px">Ideas worth testing, each run on <b>Choose</b> and <b>Check</b> for the coin and timeframe above, ranked by $1-bet profit on Choose.
      A trial only counts if it also holds up on <b>Check</b> and beats the coin flip there.</p>
      <div id="tr-lab"><p class="muted">Running…</p></div></div>
    <h2>Your settings</h2>
    ${s.rule || (s.base && s.base !== "kronos") ? `<div class="chips" style="margin:-4px 0 8px"><span class="pill up">+ ${esc(s.base && s.base !== "kronos" ? s.base.replace("_", " ") : TR_RULES[s.rule])}</span>
      <button class="chip" data-trclear="1">✕ clear extra rule</button></div>` : ""}
    <div class="card tr-controls">
      ${slider("minConf", "Only call when samples agree at least ", 0.5, 1, 0.05, (v) => Math.round(v * 100) + "%")}
      ${slider("minMove", "Only call when the predicted move is at least ", 0, TR_MOVE_MAX[s.tf] || 50, (TR_MOVE_MAX[s.tf] || 50) / 50, (v) => (v / 100).toFixed(2) + "%")}
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
  if (!d || !d.p.length) { out.innerHTML = `<p class="muted pad">No ${TR.s.tf} backtest forecasts for ${TR.s.coin} yet. They appear as the backtest runs.</p>`; return; }
  const { n, cut } = trSplit(d), fee = FEE_RATE(), venue = state.venue;
  const base = { ...trBase };
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
    <p class="note">The dotted line marks where Choose ends and Check begins. ${num(n)} ${TR.s.tf} candles of ${TR.s.coin.replace("-USD", "")} history.
      The "big move" slider is in % of price; on longer timeframes moves are bigger, so try higher values.</p>`;
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
  if (TR.grid && TR.grid.coin === TR.s.coin && TR.grid.tf === TR.s.tf) drawGrid();
  drawLab(d, n, cut, fee, venue);
}

function drawLab(d, n, cut, fee, venue) {
  const el = $("#tr-lab");
  if (!el) return;
  const rows = TR_LAB.map((t, i) => {
    const s = trLabSettings(t);
    return { i, t, a: trRun(d, s, 0, cut, fee, venue), b: trRun(d, s, cut, n, fee, venue) };
  });
  const flip = rows.find((r) => r.t.s.base === "coin");
  rows.sort((x, y) => y.a.bet - x.a.bet);
  const cell = (r) => `${pct(r.hit)} <span class="muted">· ${pct(r.coverage, 0)} called</span><br><b class="${cls(r.bet)}">${money(r.bet)}</b> <span class="muted">${r.betRoi == null ? "" : signed(r.betRoi * 100, 1)}</span>`;
  el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>Trial</th><th>Choose: hit · $1 bets</th><th>Check: hit · $1 bets</th><th>Verdict</th><th></th></tr></thead><tbody>
    ${rows.map((r) => {
      const few = r.b.calls < 50;
      const holds = !few && r.a.bet > 0 && r.b.bet > 0;
      const beatsFlip = !few && r.b.lo != null && r.b.lo > Math.max(0.5, flip?.b.hit ?? 0.5);
      const v = few ? `<span class="verdict meh" style="margin:0">TOO FEW CALLS</span>`
        : holds && beatsFlip ? `<span class="verdict yes" style="margin:0">✓ HOLDS UP</span>`
        : holds ? `<span class="verdict luck" style="margin:0">PROFIT, COULD BE LUCK</span>`
        : r.a.bet > 0 ? `<span class="verdict no" style="margin:0">✗ FADED ON CHECK</span>` : `<span class="verdict meh" style="margin:0">NO EDGE</span>`;
      const ref = r.t.s.base && r.t.s.base !== "kronos";
      return `<tr><td style="text-align:left;white-space:normal;min-width:200px"><b>${esc(r.t.name)}</b>${ref ? ' <span class="muted">(reference)</span>' : ""}
          <div class="muted" style="font-size:12px">${esc(r.t.why)}</div></td>
        <td>${cell(r.a)}</td><td>${cell(r.b)}</td><td>${v}</td>
        <td><button class="chip" data-trlab="${r.i}">Try it</button></td></tr>`;
    }).join("")}</tbody></table></div>
    <p class="note">✓ HOLDS UP = profitable on both parts and, on Check, the bottom of its 95% range is above 50% (and above the coin flip). Bets use ${esc(venueInfo().name)} fees at even 50¢ odds.
      "Trade less" only changes trading P&amp;L, not bets.</p>`;
}

async function runGrid() {
  const el = $("#tr-grid");
  const d = await trLoad(TR.s.coin);
  if (!d || !el) return;
  el.innerHTML = `<p class="muted">Searching…</p>`;
  await new Promise((r) => setTimeout(r, 30));
  const { n, cut } = trSplit(d), fee = FEE_RATE(), venue = state.venue, rows = [];
  for (const minConf of [0.5, 0.6, 0.7, 0.8, 0.9])
    for (const minMove of [0, 5, 10, 15, 25, 40].map((x) => x * (TR_MOVE_MAX[TR.s.tf] || 50) / 50))
      for (const blend of [0, 0.2, 0.35, 0.5])
        for (const hold of [false, true]) {
          const s = { minConf, minMove, blend, hold, invert: false };
          const a = trRun(d, s, 0, cut, fee, venue);
          if (a.calls < 100) continue;  // too few calls to mean anything
          rows.push({ s, a, b: trRun(d, s, cut, n, fee, venue) });
        }
  rows.sort((x, y) => y.a.bet - x.a.bet);
  TR.grid = { coin: TR.s.coin, tf: TR.s.tf, rows: rows.slice(0, 12), tried: rows.length };
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
  document.querySelectorAll("[data-trtf]").forEach((b) => b.addEventListener("click", () => { TR.s.tf = b.dataset.trtf; TR.grid = null; trSave(); render(); }));
  document.querySelectorAll("[data-trp]").forEach((b) => b.addEventListener("click", () => { Object.assign(TR.s, { rule: null, base: "kronos" }, TR_PRESETS[+b.dataset.trp].s); trSave(); render(); }));
  document.querySelectorAll("[data-trgrid]").forEach((b) => b.addEventListener("click", runGrid));
  document.querySelectorAll("[data-trclear]").forEach((b) => b.addEventListener("click", () => { TR.s.rule = null; TR.s.base = "kronos"; trSave(); render(); }));
  if (TR.bound) return;
  TR.bound = true;
  document.addEventListener("click", (e) => {
    const lab = e.target.closest("[data-trlab]");
    if (lab) { Object.assign(TR.s, trLabSettings(TR_LAB[+lab.dataset.trlab])); trSave(); render(); return; }
    const b = e.target.closest("[data-trapply]");
    if (!b || !TR.grid) return;
    Object.assign(TR.s, { rule: null, base: "kronos" }, TR.grid.rows[+b.dataset.trapply].s); trSave(); render();
  });
}
