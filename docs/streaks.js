/* Candle Lab: streaks.
   Question: after a coin closes N candles in a row in the same direction (default 5), what does the
   next candle do? Keep going, or snap back? Tested on real Coinbase candles fetched in the browser. */
const STK = {
  s: { coin: "BTC-USD", size: 900, days: 30, len: 5 },
  cache: {},          // coin|size|days -> candles
  KEY: "candlelab-streaks",
  gen: 0,
};
try { Object.assign(STK.s, JSON.parse(localStorage.getItem(STK.KEY) || "{}")); } catch {}
const stkSave = () => { try { localStorage.setItem(STK.KEY, JSON.stringify(STK.s)); } catch {} };

const STK_COINS = ["BTC-USD", "ETH-USD", "SOL-USD"];
const STK_SIZES = [{ g: 900, label: "15-min candles" }, { g: 3600, label: "1-hour candles" }];
const STK_DAYS = [7, 30, 90];
const STK_MAXLEN = 10;

/* ---------- data: Coinbase candles, 300 per request ---------- */
async function stkFetch(coin, g, days, onProgress) {
  const key = `${coin}|${g}|${days}`;
  if (STK.cache[key]) return STK.cache[key];
  const end = Math.floor(Date.now() / 1000 / g) * g;   // the forming candle starts here, so stop before it
  const start = end - days * 86400;
  const chunks = [];
  for (let a = start; a < end; a += 300 * g) chunks.push([a, Math.min(a + 300 * g, end)]);
  const bars = new Map();
  let done = 0, i = 0, failed = 0;
  async function worker() {
    while (i < chunks.length) {
      const [a, b] = chunks[i++];
      const url = `${CB}/products/${coin}/candles?granularity=${g}&start=${new Date(a * 1000).toISOString()}&end=${new Date((b - g) * 1000).toISOString()}`;
      let rows = null;
      for (let tries = 0; tries < 3 && !rows; tries++) {
        try { rows = await getJSON(url); }
        catch { await new Promise((r) => setTimeout(r, 600 * (tries + 1))); }
      }
      if (!rows) failed++;
      else rows.forEach((x) => { if (x[0] < end) bars.set(x[0], { t: x[0], o: +x[3], c: +x[4] }); });
      onProgress?.(++done, chunks.length);
    }
  }
  await Promise.all([worker(), worker(), worker()]);   // stay under Coinbase's public rate limit
  if (failed > chunks.length / 4) throw new Error("Coinbase didn't answer enough requests. Try again in a minute.");
  const candles = [...bars.values()].sort((a, b) => a.t - b.t);
  STK.cache[key] = candles;
  return candles;
}

/* ---------- scoring ---------- */
const stkSign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// Walk the candles once. A run breaks on a flat candle, a direction change, or a missing candle.
// A streak "event" fires the moment a run reaches exactly length L, so each run counts once per L.
function stkScore(candles, g, len) {
  const byLen = Array.from({ length: STK_MAXLEN + 1 }, () => ({ n: 0, cont: 0 }));
  const events = [];
  let run = 0, dir = 0, runStart = 0;
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i], d = stkSign(k.c - k.o);
    const gap = i > 0 && k.t - candles[i - 1].t !== g;
    if (!d) { run = 0; dir = 0; continue; }
    if (d === dir && !gap) run++;
    else { run = 1; dir = d; runStart = i; }
    const nx = candles[i + 1];
    if (!nx || nx.t - k.t !== g) continue;          // need the very next candle to score it
    const nd = stkSign(nx.c - nx.o);
    if (!nd) continue;                               // next candle closed flat: neither
    if (run <= STK_MAXLEN) { byLen[run].n++; if (nd === dir) byLen[run].cont++; }
    if (run === len) {
      const first = candles[runStart];
      const n3 = candles[i + 3] && candles[i + 3].t - k.t === 3 * g ? candles[i + 3] : null;
      events.push({
        t: k.t, dir, runMove: (k.c - first.o) / first.o * 100,
        next: (nx.c - nx.o) / nx.o * 100, cont: nd === dir,
        next3: n3 ? (n3.c - k.c) / k.c * 100 : null,
      });
    }
  }
  // Where the newest closed candle stands right now.
  let cur = 0, curDir = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = stkSign(candles[i].c - candles[i].o);
    if (!d || (curDir && d !== curDir) || (i < candles.length - 1 && candles[i + 1].t - candles[i].t !== g)) break;
    curDir = d; cur++;
  }
  const side = (dsel) => {
    const e = events.filter((x) => x.dir === dsel), n = e.length, c = e.filter((x) => x.cont).length;
    const [lo, hi] = r12Wilson(c, n);
    const avgNext = n ? e.reduce((a, x) => a + x.next * x.dir, 0) / n : null;   // + = kept going
    const e3 = e.filter((x) => x.next3 != null);
    const avg3 = e3.length ? e3.reduce((a, x) => a + x.next3 * x.dir, 0) / e3.length : null;
    return { n, c, rate: n ? c / n : null, lo, hi, avgNext, avg3 };
  };
  const all = events.length, allC = events.filter((x) => x.cont).length;
  const [lo, hi] = r12Wilson(allC, all);
  return { byLen, events, up: side(1), down: side(-1), n: all, c: allC, rate: all ? allC / all : null, lo, hi, cur, curDir };
}

/* ---------- render ---------- */
function renderStreaks() {
  const s = STK.s;
  const chip = (attr, val, label, on) => `<button class="chip" data-stk${attr}="${val}" aria-pressed="${on}">${label}</button>`;
  return `
  <div class="chips" role="group" aria-label="Coin">${STK_COINS.map((c) => chip("coin", c, c.replace("-USD", ""), s.coin === c)).join("")}</div>
  <div class="chips" role="group" aria-label="Candle size">${STK_SIZES.map((z) => chip("size", z.g, z.label, s.size === z.g)).join("")}</div>
  <div class="chips" role="group" aria-label="History">${STK_DAYS.map((d) => chip("days", d, `Last ${d} days`, s.days === d)).join("")}</div>
  <div class="r12-ctl">
    <label class="tr-sl"><span>Streak length <b id="stkv-len">${s.len} in a row</b></span>
      <input type="range" min="2" max="${STK_MAXLEN}" step="1" value="${s.len}" data-stks="len" aria-label="Streak length"></label>
  </div>
  <div id="stkout"><p class="pad muted">Loading Coinbase candles…</p></div>`;
}

function stkResults(candles, s) {
  const r = stkScore(candles, s.size, s.len);
  const unit = s.size === 900 ? "15-min" : "1-hour";
  const verdict = (lo, hi) => lo == null ? "" : lo > 0.5 ? `<span class="verdict yes">TENDS TO KEEP GOING</span>`
    : hi < 0.5 ? `<span class="verdict no">TENDS TO REVERSE</span>` : `<span class="verdict luck">COULD BE LUCK (≈ COIN FLIP)</span>`;
  const sideCard = (label, x, dsel) => `
    <div class="card"><div class="label">After ${s.len} ${dsel > 0 ? "green" : "red"} candles in a row, next one goes ${dsel > 0 ? "up" : "down"} again</div>
      <div class="big">${pct(x.rate)}</div>
      <div class="sub">${num(x.c)} of ${num(x.n)} streaks · 95% range ${pct(x.lo)} – ${pct(x.hi)}</div>
      <div class="sub">Next candle, avg: <span class="${cls(x.avgNext)}">${signed(x.avgNext, 3)}</span> in the streak's direction</div>
      <div class="sub">Next 3 candles, avg: <span class="${cls(x.avg3)}">${signed(x.avg3, 3)}</span></div>
      ${verdict(x.lo, x.hi)}</div>`;
  const from = new Date(candles[0].t * 1000), to = new Date((candles[candles.length - 1].t + s.size) * 1000);
  const fmtD = (d) => d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const nowTxt = r.cur ? `${r.cur} ${r.curDir > 0 ? "green ▲" : "red ▼"} in a row` : "no streak (last candle flat)";

  let html = `
  <div class="cards" style="margin-top:16px">
    <div class="card"><div class="label">Keeps going after ${s.len} in a row (up + down)</div>
      <div class="big">${pct(r.rate)}</div>
      <div class="sub">${num(r.c)} of ${num(r.n)} streaks · 95% range ${pct(r.lo)} – ${pct(r.hi)}</div>
      <div class="sub">50% = no pattern. Under 50% = it usually reverses.</div>
      ${verdict(r.lo, r.hi)}</div>
    ${sideCard("up", r.up, 1)}
    ${sideCard("down", r.down, -1)}
    <div class="card"><div class="label">${s.coin.replace("-USD", "")} right now</div>
      <div class="big ${r.curDir > 0 ? "pos" : r.curDir < 0 ? "neg" : ""}">${r.cur || "–"}</div>
      <div class="sub">${nowTxt} (last closed ${unit} candle)</div>
      ${r.cur >= s.len ? `<div class="sub" style="color:var(--warn)">On a ${s.len}+ streak now. History above says the next one keeps going ${pct(r.curDir > 0 ? r.up.rate : r.down.rate)} of the time.</div>` : ""}</div>
  </div>
  <p class="note">${fmtD(from)} → ${fmtD(to)}, ${num(candles.length)} ${unit} candles. A green candle closed above its open, red closed below.
    A flat candle or a gap in the data ends a streak. Each streak counts once, at the moment it reaches ${s.len}.</p>

  <h2>Chance the next candle keeps going, by streak length</h2>
  <div class="chartbox"><canvas id="stkLenChart"></canvas></div>
  <div class="tablewrap"><table><thead><tr><th>In a row</th><th>Times</th><th>Next one same way</th><th>95% range</th></tr></thead><tbody>
    ${r.byLen.slice(1).map((b, idx) => {
      const L = idx + 1, [lo, hi] = r12Wilson(b.cont, b.n);
      return `<tr${L === s.len ? ' style="background:var(--panel2,rgba(255,255,255,.04))"' : ""}><td style="text-align:left">${L}</td><td>${num(b.n)}</td>
        <td><b>${b.n ? pct(b.cont / b.n) : "–"}</b></td><td>${b.n ? pct(lo) + " – " + pct(hi) : "–"}</td></tr>`;
    }).join("")}
  </tbody></table></div>
  <p class="note">Each row counts every candle that was the Nth in a row, so long runs show up in several rows.
    Fewer streaks = wider range: long streaks are rare, so their numbers swing a lot.</p>

  <h2>Every ${s.len}-in-a-row streak <span class="muted" style="font-weight:500;font-size:13px">(${num(r.n)}, newest first)</span></h2>
  <div class="tablewrap r12-trades"><table><thead><tr><th>Streak ended (your time)</th><th>Direction</th><th>Streak move</th><th>Next candle</th><th>Result</th><th>Next 3 candles</th></tr></thead><tbody>
    ${r.events.slice().reverse().slice(0, 500).map((x) => `<tr>
      <td>${fmtTime(x.t + s.size)}</td><td>${dirPill(x.dir > 0 ? "up" : "down")}</td>
      <td class="${cls(x.runMove)}">${signed(x.runMove, 3)}</td><td class="${cls(x.next)}">${signed(x.next, 3)}</td>
      <td>${x.cont ? `<span class="res pos">KEPT GOING</span>` : `<span class="res neg">REVERSED</span>`}</td>
      <td class="${cls(x.next3)}">${signed(x.next3, 3)}</td></tr>`).join("")}
  </tbody></table></div>
  ${r.n > 500 ? `<p class="note">Showing the newest 500; all ${num(r.n)} count toward the totals.</p>` : ""}
  <p class="note">Paper only. Not a trading signal: fees on a single 15-minute trade usually eat more than these average moves.</p>`;
  return { html, r };
}

function stkDraw(r, s) {
  const c = $("#stkLenChart");
  if (!c) return;
  const pts = r.byLen.slice(1).map((b, i) => ({ x: i + 1, y: b.n ? +(b.cont / b.n * 100).toFixed(2) : null, n: b.n }));
  state.charts.push(new Chart(c, {
    type: "line",
    data: { datasets: [
      { label: "Next candle same way", data: pts, borderColor: css("--s-kronos"), backgroundColor: css("--s-kronos"), borderWidth: 2,
        pointRadius: (ctx) => (ctx.raw?.x === s.len ? 6 : 3), tension: 0.15, spanGaps: true },
      { label: "50% (no pattern)", data: [{ x: 1, y: 50 }, { x: STK_MAXLEN, y: 50 }], borderColor: "#5c5f66", borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: { x: { type: "linear", min: 1, max: STK_MAXLEN, ticks: { stepSize: 1, callback: (v) => v + " in a row" }, grid: { display: false } },
        y: { suggestedMin: 30, suggestedMax: 70, ticks: { callback: (v) => v + "%" }, grid: { color: "#222428" } } },
      plugins: { tooltip: { callbacks: { title: (it) => it.length ? `${it[0].parsed.x} in a row` : "",
        label: (it) => it.datasetIndex === 0 ? `Kept going: ${it.parsed.y}% (${num(it.raw.n)} times)` : it.dataset.label } } },
    },
  }));
}

async function stkUpdate() {
  const out = $("#stkout");
  if (!out) return;
  const gen = ++STK.gen, s = { ...STK.s };
  let candles;
  try {
    candles = await stkFetch(s.coin, s.size, s.days, (d, t) => {
      if (gen === STK.gen && $("#stkout")) $("#stkout").innerHTML = `<p class="pad muted">Loading Coinbase candles… ${Math.round(d / t * 100)}%</p>`;
    });
  } catch (e) {
    if (gen === STK.gen && $("#stkout")) $("#stkout").innerHTML = `<p class="pad muted">${esc(e.message)}</p>`;
    return;
  }
  if (gen !== STK.gen || state.tab !== "streaks" || !$("#stkout")) return;
  destroyCharts();
  if (candles.length < 20) { $("#stkout").innerHTML = `<p class="pad muted">Not enough candles came back from Coinbase.</p>`; return; }
  const res = stkResults(candles, s);
  $("#stkout").innerHTML = res.html;
  stkDraw(res.r, s);
}

function bindStreaks() {
  const main = $("#main");
  const group = (attr, key, cast) => main.querySelectorAll(`[data-stk${attr}]`).forEach((b) => b.addEventListener("click", () => {
    STK.s[key] = cast(b.dataset["stk" + attr]); stkSave();
    main.querySelectorAll(`[data-stk${attr}]`).forEach((x) => x.setAttribute("aria-pressed", x === b));
    stkUpdate();
  }));
  group("coin", "coin", String);
  group("size", "size", Number);
  group("days", "days", Number);
  let t = null;
  main.querySelectorAll("[data-stks]").forEach((inp) => inp.addEventListener("input", () => {
    STK.s.len = +inp.value; stkSave();
    $("#stkv-len").textContent = inp.value + " in a row";
    clearTimeout(t); t = setTimeout(stkUpdate, 120);   // cached data, so this is instant after the first load
  }));
  stkUpdate();
}
