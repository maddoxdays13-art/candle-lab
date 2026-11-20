/* Candle Lab: the "12-minute rule".
   Claim: whatever the 15-minute candle is doing at minute 12 (above or below its open),
   it closes that way ~87% of the time, so "tail" it.
   This tab tests that on real Coinbase 1-minute candles, fetched in the browser, and shows
   paper P&L for $1 "Up/Down" contracts bought at a price you choose (like Kalshi / Polymarket). */
const R12 = {
  s: { coin: "BTC-USD", days: 7, minute: 12, price: 87, fee: 1.75, minMove: 0 },
  cache: {},          // coin|days -> parsed windows
  KEY: "candlelab-rule12",
  gen: 0,
};
try { Object.assign(R12.s, JSON.parse(localStorage.getItem(R12.KEY) || "{}")); } catch {}
const r12Save = () => { try { localStorage.setItem(R12.KEY, JSON.stringify(R12.s)); } catch {} };

const R12_COINS = ["BTC-USD", "ETH-USD", "SOL-USD"];
const R12_DAYS = [1, 3, 7, 14];
const R12_BUCKETS = [  // size of the move at the chosen minute, in % of the open
  { lo: 0, hi: 0.02, label: "tiny (under 0.02%)" },
  { lo: 0.02, hi: 0.05, label: "small (0.02–0.05%)" },
  { lo: 0.05, hi: 0.1, label: "medium (0.05–0.1%)" },
  { lo: 0.1, hi: 0.2, label: "big (0.1–0.2%)" },
  { lo: 0.2, hi: Infinity, label: "huge (0.2%+)" },
];
// If price were a pure random walk (no edge at all), the chance the sign at minute k matches the close.
const r12Theory = (k) => 0.5 + Math.asin(Math.sqrt(k / 15)) / Math.PI;
const r12Wilson = (h, n, z = 1.96) => {
  if (!n) return [null, null];
  const p = h / n, den = 1 + z * z / n, c = (p + z * z / (2 * n)) / den, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [c - half, c + half];
};

/* ---------- data: Coinbase 1-minute candles, 300 per request ---------- */
async function r12Fetch(coin, days, onProgress) {
  const key = coin + "|" + days;
  if (R12.cache[key]) return R12.cache[key];
  const nowS = Math.floor(Date.now() / 1000);
  const end = Math.floor(nowS / 900) * 900;           // last finished 15-minute window ends here
  const start = end - days * 86400;
  const chunks = [];
  for (let a = start; a < end; a += 300 * 60) chunks.push([a, Math.min(a + 300 * 60, end)]);
  const bars = new Map();
  let done = 0, i = 0, failed = 0;
  async function worker() {
    while (i < chunks.length) {
      const [a, b] = chunks[i++];
      const url = `${CB}/products/${coin}/candles?granularity=60&start=${new Date(a * 1000).toISOString()}&end=${new Date((b - 60) * 1000).toISOString()}`;
      let rows = null;
      for (let tries = 0; tries < 3 && !rows; tries++) {
        try { rows = await getJSON(url); }
        catch { await new Promise((r) => setTimeout(r, 600 * (tries + 1))); }
      }
      if (!rows) failed++;
      else rows.forEach((x) => bars.set(x[0], { o: +x[3], c: +x[4] }));
      onProgress?.(++done, chunks.length);
    }
  }
  await Promise.all([worker(), worker(), worker()]);   // stay under Coinbase's public rate limit
  if (failed > chunks.length / 4) throw new Error("Coinbase didn't answer enough requests. Try again in a minute.");

  // Build 15-minute windows: open, then the price after each of minutes 1..15 (fill-forward gaps).
  const wins = [];
  for (let w = start; w < end; w += 900) {
    const first = bars.get(w);
    if (!first) continue;
    const at = new Float64Array(16);
    at[0] = first.o;
    let last = null, missing = 0;
    for (let m = 0; m < 15; m++) {
      const b = bars.get(w + m * 60);
      if (b) last = b.c; else missing++;
      at[m + 1] = last;
    }
    if (missing > 5) continue;   // too thin to trust
    wins.push({ t: w, at });
  }
  R12.cache[key] = wins;
  return wins;
}

/* ---------- scoring ---------- */
const r12Sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

function r12Score(wins, s) {
  const k = s.minute, cost = (s.price + s.fee) / 100;
  const byMin = [];
  for (let m = 1; m <= 14; m++) {
    let n = 0, h = 0;
    for (const w of wins) {
      const d = r12Sign(w.at[m] - w.at[0]), f = r12Sign(w.at[15] - w.at[0]);
      if (!d || !f) continue;
      n++; if (d === f) h++;
    }
    byMin.push({ m, n, h, rate: n ? h / n : null });
  }
  const buckets = R12_BUCKETS.map((b) => ({ ...b, n: 0, h: 0 }));
  const trades = [];
  let flatAtK = 0, flatClose = 0, filtered = 0, eq = 0, peak = 0, maxDD = 0;
  for (const w of wins) {
    const o = w.at[0], pk = w.at[k], cl = w.at[15];
    const d = r12Sign(pk - o), f = r12Sign(cl - o);
    if (!d) { flatAtK++; continue; }
    const movePct = Math.abs(pk - o) / o * 100;
    if (!f) { flatClose++; continue; }
    const b = buckets.find((x) => movePct >= x.lo && movePct < x.hi);
    b.n++; if (d === f) b.h++;
    if (movePct * 100 < s.minMove) { filtered++; continue; }   // minMove is in basis points
    const win = d === f;
    const pnl = win ? 1 - cost : -cost;
    eq += pnl; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
    trades.push({ t: w.t, o, pk, cl, side: d, movePct, win, pnl, eq });
  }
  const n = trades.length, h = trades.filter((x) => x.win).length;
  const [lo, hi] = r12Wilson(h, n);
  const wins_ = trades.filter((x) => x.win), losses = trades.filter((x) => !x.win);
  return {
    byMin, buckets, trades, n, h, rate: n ? h / n : null, lo, hi, cost,
    pnl: eq, perTrade: n ? eq / n : null, maxDD, flatAtK, flatClose, filtered,
    grossWin: wins_.reduce((a, x) => a + x.pnl, 0), grossLoss: -losses.reduce((a, x) => a + x.pnl, 0),
    theory: r12Theory(k),
  };
}

/* ---------- render ---------- */
function renderRule12() {
  const s = R12.s;
  const chip = (attr, val, label, on) => `<button class="chip" data-r12${attr}="${val}" aria-pressed="${on}">${label}</button>`;
  const slider = (key, label, min, max, step, fmt) => `<label class="tr-sl"><span>${label} <b id="r12v-${key}">${fmt(s[key])}</b></span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-r12s="${key}" aria-label="${label}"></label>`;
  return `
  <div class="chips" role="group" aria-label="Coin">${R12_COINS.map((c) => chip("coin", c, c.replace("-USD", ""), s.coin === c)).join("")}</div>
  <div class="chips" role="group" aria-label="History">${R12_DAYS.map((d) => chip("days", d, d === 1 ? "Last 24h" : `Last ${d} days`, s.days === d)).join("")}</div>
  <div class="r12-ctl">
    ${slider("minute", "Check at minute", 1, 14, 1, (v) => v)}
    ${slider("price", "Price you pay per $1 contract", 50, 99, 1, (v) => v + "¢")}
    ${slider("fee", "Fee per contract", 0, 3, 0.25, (v) => (+v).toFixed(2) + "¢")}
    ${slider("minMove", "Only tail moves of at least", 0, 30, 1, (v) => (v / 100).toFixed(2) + "%")}
  </div>
  <div id="r12out"><p class="pad muted">Loading Coinbase 1-minute candles…</p></div>`;
}

function r12Results(wins, s) {
  const r = r12Score(wins, s);
  if (!r.n) return `<p class="pad muted">No trades match these settings. Lower the minimum move.</p>`;
  const be = r.cost;
  const verdict = r.lo > be ? `<span class="verdict yes">BEATS THIS PRICE</span>`
    : r.hi < be ? `<span class="verdict no">LOSES AT THIS PRICE</span>`
    : `<span class="verdict luck">COULD BE LUCK</span>`;
  const pf = r.grossLoss ? (r.grossWin / r.grossLoss).toFixed(2) : "∞";
  const from = new Date(wins[0].t * 1000), to = new Date((wins[wins.length - 1].t + 900) * 1000);
  const d$ = (x) => money(x);

  let html = `
  <div class="cards" style="margin-top:16px">
    <div class="card"><div class="label">Tail-the-candle hit rate (minute ${s.minute})</div>
      <div class="big">${pct(r.rate)}</div>
      <div class="sub">${num(r.h)} of ${num(r.n)} · 95% range ${pct(r.lo)} – ${pct(r.hi)}</div>
      <div class="sub">Pure coin-flip price movement would give ${pct(r.theory)}</div></div>
    <div class="card"><div class="label">Paper P&amp;L, ${num(r.n)} × $1 contracts</div>
      <div class="big ${cls(r.pnl)}">${d$(r.pnl)}</div>
      <div class="sub">${d$(r.perTrade)} per trade · bought at ${s.price}¢ + ${(+s.fee).toFixed(2)}¢ fee</div>
      ${verdict}
      ${s.minMove ? `<div class="sub" style="color:var(--warn);margin-top:6px">Careful: with the minimum-move filter on, real markets charge more than ${s.price}¢ for these. Check the "max price" table below.</div>` : ""}</div>
    <div class="card"><div class="label">Break-even</div>
      <div class="big">${(be * 100).toFixed(1)}%</div>
      <div class="sub">hit rate needed at ${s.price}¢ + fee</div>
      <div class="sub">Win +${((1 - be) * 100).toFixed(1)}¢ · lose −${(be * 100).toFixed(1)}¢</div></div>
    <div class="card"><div class="label">Risk</div>
      <div class="big neg">${d$(-r.maxDD)}</div>
      <div class="sub">worst drop from a high (max drawdown)</div>
      <div class="sub">Profit factor ${pf} · ${num(r.n - r.h)} losses</div></div>
  </div>
  <p class="note">${from.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} → ${to.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })},
    ${num(wins.length)} candles. Skipped ${num(r.flatAtK)} flat at minute ${s.minute}, ${num(r.flatClose)} that closed exactly at the open${s.minMove ? `, ${num(r.filtered)} below your minimum move` : ""}.</p>

  <h2>Hit rate by the minute you check</h2>
  <div class="chartbox"><canvas id="r12MinChart"></canvas></div>
  <p class="note">The dashed line is what you'd get if price moved completely at random. If the real line sits on top of it,
    the "rule" is just math: late in a candle there isn't enough time left for it to flip, so it's not a signal about where price goes next.</p>

  <h2>Equity curve</h2>
  <div class="chartbox"><canvas id="r12EqChart"></canvas></div>

  <h2>The price you could afford, by move size</h2>
  <div class="tablewrap"><table><thead><tr><th>Move at minute ${s.minute}</th><th>Candles</th><th>Hit rate</th><th>95% range</th><th>Max price to break even*</th></tr></thead><tbody>
    ${r.buckets.map((b) => {
      const [lo, hi] = r12Wilson(b.h, b.n);
      const maxP = b.n ? Math.max(0, b.h / b.n * 100 - s.fee) : null;
      return `<tr><td style="text-align:left">${b.label}</td><td>${num(b.n)}</td><td><b>${b.n ? pct(b.h / b.n) : "–"}</b></td><td>${b.n ? pct(lo) + " – " + pct(hi) : "–"}</td>
        <td>${maxP == null ? "–" : maxP.toFixed(0) + "¢"}</td></tr>`;
    }).join("")}
  </tbody></table></div>
  <p class="note">*After your ${(+s.fee).toFixed(2)}¢ fee. Bigger moves hold more often, but the market knows that too and charges more for them.
    The real test: watch Kalshi's price at minute ${s.minute} and see if it's ever below this column. If it's at or above, there's no edge.</p>

  <h2>All trades <span class="muted" style="font-weight:500;font-size:13px">(${num(r.n)}, newest first)</span></h2>
  <div class="tablewrap r12-trades"><table><thead><tr><th>Candle (your time)</th><th>Open</th><th>At min ${s.minute}</th><th>Tail</th><th>Close</th><th>Result</th><th>P&amp;L</th><th>Running</th></tr></thead><tbody>
    ${r.trades.slice().reverse().slice(0, 500).map((x) => `<tr>
      <td>${fmtTime(x.t)}</td><td class="mono">${fmtPrice(x.o)}</td>
      <td class="mono">${fmtPrice(x.pk)} <span class="${x.side > 0 ? "pos" : "neg"}">(${x.side > 0 ? "+" : "−"}${x.movePct.toFixed(3)}%)</span></td>
      <td>${dirPill(x.side > 0 ? "up" : "down")}</td><td class="mono">${fmtPrice(x.cl)}</td>
      <td>${x.win ? `<span class="res pos">✓ HIT</span>` : `<span class="res neg">✗ MISS</span>`}</td>
      <td class="${cls(x.pnl)}">${d$(x.pnl)}</td><td class="${cls(x.eq)}">${d$(x.eq)}</td></tr>`).join("")}
  </tbody></table></div>
  ${r.n > 500 ? `<p class="note">Showing the newest 500 trades; all ${num(r.n)} count toward the totals.</p>` : ""}
  <p class="note">Paper only. Uses Coinbase's last-trade price; Kalshi settles on CF Benchmarks' 60-second average, so a few close calls can go the other way there.
    One flat price for every trade is a simplification: real minute-${s.minute} prices are higher when the candle is further from its open.</p>`;
  return { html, r };
}

function r12Draw(r, s) {
  const mc = $("#r12MinChart"), ec = $("#r12EqChart");
  if (mc) {
    state.charts.push(new Chart(mc, {
      type: "line",
      data: { datasets: [
        { label: "Real hit rate", data: r.byMin.map((p) => ({ x: p.m, y: p.rate == null ? null : +(p.rate * 100).toFixed(2) })),
          borderColor: css("--s-kronos"), backgroundColor: css("--s-kronos"), borderWidth: 2, pointRadius: (c) => (c.raw?.x === s.minute ? 6 : 2), tension: 0.15 },
        { label: "Random walk (no edge)", data: r.byMin.map((p) => ({ x: p.m, y: +(r12Theory(p.m) * 100).toFixed(2) })),
          borderColor: "#5c5f66", borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
        { label: `Break-even at ${s.price}¢`, data: [{ x: 1, y: r.cost * 100 }, { x: 14, y: r.cost * 100 }],
          borderColor: css("--warn"), borderWidth: 1, pointRadius: 0 },
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: { x: { type: "linear", min: 1, max: 14, ticks: { stepSize: 1, callback: (v) => "min " + v }, grid: { display: false } },
          y: { min: 50, max: 100, ticks: { callback: (v) => v + "%" }, grid: { color: "#222428" } } },
        plugins: { tooltip: { callbacks: { title: (it) => it.length ? `Minute ${it[0].parsed.x}` : "", label: (it) => `${it.dataset.label}: ${it.parsed.y}%` } } },
      },
    }));
  }
  if (ec && r.trades.length) {
    lineChart(ec, [{ label: "Running P&L ($)", borderColor: css(r.pnl >= 0 ? "--good" : "--bad"), backgroundColor: css(r.pnl >= 0 ? "--good" : "--bad"),
      data: r.trades.map((x) => ({ x: x.t, y: +x.eq.toFixed(2) })) }], { yFmt: (v) => "$" + v, refLine: { y: 0, label: "$0" } });
  }
}

async function r12Update() {
  const out = $("#r12out");
  if (!out) return;
  const gen = ++R12.gen, s = { ...R12.s };
  let wins;
  try {
    wins = await r12Fetch(s.coin, s.days, (d, t) => {
      if (gen === R12.gen && $("#r12out")) $("#r12out").innerHTML = `<p class="pad muted">Loading Coinbase 1-minute candles… ${Math.round(d / t * 100)}%</p>`;
    });
  } catch (e) {
    if (gen === R12.gen && $("#r12out")) $("#r12out").innerHTML = `<p class="pad muted">${esc(e.message)}</p>`;
    return;
  }
  if (gen !== R12.gen || state.tab !== "rule12" || !$("#r12out")) return;
  destroyCharts();
  if (!wins.length) { $("#r12out").innerHTML = `<p class="pad muted">No candles came back from Coinbase.</p>`; return; }
  const res = r12Results(wins, s);
  if (typeof res === "string") { $("#r12out").innerHTML = res; return; }
  $("#r12out").innerHTML = res.html;
  r12Draw(res.r, s);
}

function bindRule12() {
  const main = $("#main");
  main.querySelectorAll("[data-r12coin]").forEach((b) => b.addEventListener("click", () => {
    R12.s.coin = b.dataset.r12coin; r12Save();
    main.querySelectorAll("[data-r12coin]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    r12Update();
  }));
  main.querySelectorAll("[data-r12days]").forEach((b) => b.addEventListener("click", () => {
    R12.s.days = +b.dataset.r12days; r12Save();
    main.querySelectorAll("[data-r12days]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    r12Update();
  }));
  let t = null;
  main.querySelectorAll("[data-r12s]").forEach((inp) => inp.addEventListener("input", () => {
    const k = inp.dataset.r12s, v = +inp.value;
    R12.s[k] = v; r12Save();
    const lab = $("#r12v-" + k);
    if (lab) lab.textContent = k === "price" ? v + "¢" : k === "fee" ? v.toFixed(2) + "¢" : k === "minMove" ? (v / 100).toFixed(2) + "%" : v;
    clearTimeout(t); t = setTimeout(r12Update, 120);   // cached data, so this is instant after the first load
  }));
  r12Update();
}
