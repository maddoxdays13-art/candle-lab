/* Candle Lab: candlestick cheat sheet. Every pattern is drawn from [open, high, low, close] numbers,
   with faded "trend" candles leading into it so you can see the context it appears in. */
const PATTERNS = [
  // ---------------------------------------------------------------- single candle
  { name: "Bullish candle", group: "Single candle", kind: "bull", ctx: null, c: [[30, 78, 24, 72]],
    means: "Price closed higher than it opened. Buyers won this period.",
    read: "A tall body means strong buying; a short one means a small win." },
  { name: "Bearish candle", group: "Single candle", kind: "bear", ctx: null, c: [[72, 78, 24, 30]],
    means: "Price closed lower than it opened. Sellers won this period.",
    read: "A tall body means strong selling; a short one means a small loss." },
  { name: "Bullish marubozu", group: "Single candle", kind: "bull", ctx: null, c: [[20, 82, 20, 82]],
    means: "A full body with no wicks: it opened at the low and closed at the high.",
    read: "Buyers were in control the entire time. Often starts or continues a move up." },
  { name: "Bearish marubozu", group: "Single candle", kind: "bear", ctx: null, c: [[82, 82, 20, 20]],
    means: "A full body with no wicks: it opened at the high and closed at the low.",
    read: "Sellers were in control the entire time. Often starts or continues a move down." },
  { name: "Spinning top", group: "Single candle", kind: "neutral", ctx: null, c: [[47, 82, 18, 54]],
    means: "Small body in the middle with wicks on both sides.",
    read: "Buyers and sellers both pushed, and nobody won. Indecision; the trend may be tiring." },
  { name: "Doji", group: "Single candle", kind: "neutral", ctx: null, c: [[50, 72, 28, 50.6]],
    means: "Open and close are (almost) the same price, so the body is just a line.",
    read: "Perfect indecision. After a strong move, it's a warning that momentum may be fading." },
  { name: "Long-legged doji", group: "Single candle", kind: "neutral", ctx: null, c: [[50, 94, 6, 50.6]],
    means: "A doji with very long wicks on both sides.",
    read: "Big swings both ways but ended where it started: heavy confusion in the market." },
  { name: "Dragonfly doji", group: "Single candle", kind: "bull", ctx: "down", c: [[80, 81, 18, 80.6]],
    means: "Open, high and close all at the top, with a long lower wick (a 'T').",
    read: "Sellers pushed price way down but buyers pushed it all the way back. After a drop, a possible bottom." },
  { name: "Gravestone doji", group: "Single candle", kind: "bear", ctx: "up", c: [[20, 82, 19, 20.6]],
    means: "Open, low and close all at the bottom, with a long upper wick (an upside-down 'T').",
    read: "Buyers pushed price way up but sellers slammed it back. After a rise, a possible top." },
  { name: "Four-price doji", group: "Single candle", kind: "neutral", ctx: null, c: [[50, 50.6, 49.4, 50]],
    means: "Open, high, low and close are all the same: a flat dash.",
    read: "Almost no trading happened. Common in very quiet markets; not a signal on its own." },
  { name: "Hammer", group: "Single candle", kind: "bull", ctx: "down", c: [[58, 67, 18, 66]],
    means: "Small body at the top, a long lower wick (at least 2× the body), little or no upper wick. Appears after a fall.",
    read: "Sellers tried to push lower and failed. A classic bullish reversal hint, which the next candle should confirm." },
  { name: "Hanging man", group: "Single candle", kind: "bear", ctx: "up", c: [[66, 67, 18, 58]],
    means: "Same shape as a hammer, but it appears after a rise.",
    read: "Sellers showed up hard during the candle. A bearish warning near a top, if the next candle confirms." },
  { name: "Inverted hammer", group: "Single candle", kind: "bull", ctx: "down", c: [[34, 82, 33, 42]],
    means: "Small body at the bottom, a long upper wick. Appears after a fall.",
    read: "Buyers tested higher prices. A possible bullish reversal if the next candle closes higher." },
  { name: "Shooting star", group: "Single candle", kind: "bear", ctx: "up", c: [[42, 82, 33, 34]],
    means: "Small body at the bottom, a long upper wick. Appears after a rise.",
    read: "Buyers spiked it up, then sellers took over. A bearish reversal warning at a top." },
  { name: "High wave", group: "Single candle", kind: "neutral", ctx: null, c: [[49, 96, 4, 53]],
    means: "Tiny body with extremely long upper and lower wicks.",
    read: "Wild volatility with no winner. Often shows up right before a big move either way." },

  // ---------------------------------------------------------------- two candles
  { name: "Bullish engulfing", group: "Two candles", kind: "bull", ctx: "down", c: [[56, 58, 40, 43], [38, 64, 36, 62]],
    means: "A small red candle followed by a bigger green candle whose body completely covers it.",
    read: "Buyers overpowered the sellers in one swing. One of the best-known bullish reversal patterns." },
  { name: "Bearish engulfing", group: "Two candles", kind: "bear", ctx: "up", c: [[44, 60, 42, 57], [62, 64, 36, 38]],
    means: "A small green candle followed by a bigger red candle whose body completely covers it.",
    read: "Sellers overpowered the buyers in one swing. A strong bearish reversal pattern at the top of a rise." },
  { name: "Bullish harami", group: "Two candles", kind: "bull", ctx: "down", c: [[72, 74, 26, 28], [40, 56, 38, 52]],
    means: "A big red candle, then a small green candle that fits inside its body ('harami' = pregnant).",
    read: "Selling suddenly slowed down. A possible bottom, weaker than an engulfing." },
  { name: "Bearish harami", group: "Two candles", kind: "bear", ctx: "up", c: [[28, 74, 26, 72], [60, 62, 44, 48]],
    means: "A big green candle, then a small red candle that fits inside its body.",
    read: "Buying suddenly slowed down. A possible top, weaker than an engulfing." },
  { name: "Harami cross", group: "Two candles", kind: "neutral", ctx: "down", c: [[72, 74, 26, 28], [48, 57, 41, 48.6]],
    means: "A harami where the second candle is a doji.",
    read: "The trend hit a wall of indecision. Points to a reversal in the opposite direction of the big candle." },
  { name: "Piercing line", group: "Two candles", kind: "bull", ctx: "down", c: [[72, 74, 40, 42], [34, 64, 32, 62]],
    means: "A red candle, then a green candle that opens below its low and closes above its midpoint.",
    read: "Buyers fought back after a gap down. Bullish reversal; stronger the higher it closes." },
  { name: "Dark cloud cover", group: "Two candles", kind: "bear", ctx: "up", c: [[40, 72, 38, 70], [76, 78, 48, 50]],
    means: "A green candle, then a red candle that opens above its high and closes below its midpoint.",
    read: "Sellers took over after a gap up. Bearish reversal; the mirror image of the piercing line." },
  { name: "Tweezer bottom", group: "Two candles", kind: "bull", ctx: "down", c: [[62, 64, 30, 36], [36, 60, 30, 56]],
    means: "Two candles with the same low, the first red and the second green.",
    read: "Price hit the same floor twice and bounced. Shows support; a bullish reversal hint." },
  { name: "Tweezer top", group: "Two candles", kind: "bear", ctx: "up", c: [[38, 70, 36, 64], [64, 70, 40, 44]],
    means: "Two candles with the same high, the first green and the second red.",
    read: "Price hit the same ceiling twice and fell back. Shows resistance; a bearish reversal hint." },
  { name: "Bullish kicker", group: "Two candles", kind: "bull", ctx: "down", c: [[62, 64, 40, 42], [68, 88, 67, 86]],
    means: "A red candle, then a green candle that gaps up above it and keeps going.",
    read: "A sudden, violent change of mood (often news). One of the strongest bullish signals." },
  { name: "Bearish kicker", group: "Two candles", kind: "bear", ctx: "up", c: [[38, 60, 36, 58], [32, 33, 12, 14]],
    means: "A green candle, then a red candle that gaps down below it and keeps falling.",
    read: "A sudden, violent change of mood (often news). One of the strongest bearish signals." },
  { name: "Rising window (gap up)", group: "Two candles", kind: "cont", ctx: "up", c: [[30, 52, 28, 50], [58, 74, 56, 72]],
    means: "The second candle's low is above the first candle's high, leaving an empty gap.",
    read: "Strong buying; the trend up is likely to continue. The gap often acts as support later." },
  { name: "Falling window (gap down)", group: "Two candles", kind: "cont", ctx: "down", c: [[70, 72, 48, 50], [42, 44, 26, 28]],
    means: "The second candle's high is below the first candle's low, leaving an empty gap.",
    read: "Strong selling; the trend down is likely to continue. The gap often acts as resistance later." },

  // ---------------------------------------------------------------- three candles
  { name: "Morning star", group: "Three candles", kind: "bull", ctx: "down", c: [[82, 84, 50, 52], [45, 49, 38, 42], [50, 80, 48, 78]],
    means: "Big red candle, a small candle lower down, then a big green candle closing well into the first.",
    read: "Selling, a pause, then buyers take over. A reliable bullish reversal at a bottom." },
  { name: "Evening star", group: "Three candles", kind: "bear", ctx: "up", c: [[18, 50, 16, 48], [54, 62, 51, 58], [50, 52, 20, 22]],
    means: "Big green candle, a small candle higher up, then a big red candle closing well into the first.",
    read: "Buying, a pause, then sellers take over. A reliable bearish reversal at a top." },
  { name: "Morning doji star", group: "Three candles", kind: "bull", ctx: "down", c: [[82, 84, 50, 52], [42, 47, 37, 42.6], [50, 80, 48, 78]],
    means: "A morning star where the middle candle is a doji.",
    read: "Even stronger indecision at the bottom before buyers win. Bullish reversal." },
  { name: "Evening doji star", group: "Three candles", kind: "bear", ctx: "up", c: [[18, 50, 16, 48], [58, 63, 53, 58.6], [50, 52, 20, 22]],
    means: "An evening star where the middle candle is a doji.",
    read: "Even stronger indecision at the top before sellers win. Bearish reversal." },
  { name: "Bullish abandoned baby", group: "Three candles", kind: "bull", ctx: "down", c: [[82, 84, 50, 52], [40, 42, 38, 40.6], [50, 80, 48, 78]],
    means: "A doji that gaps below the candles on both sides, like it was left alone.",
    read: "Rare but strong: sellers were exhausted and buyers jumped in. Bullish reversal." },
  { name: "Bearish abandoned baby", group: "Three candles", kind: "bear", ctx: "up", c: [[18, 50, 16, 48], [60, 62, 58, 60.6], [50, 52, 20, 22]],
    means: "A doji that gaps above the candles on both sides.",
    read: "Rare but strong: buyers were exhausted and sellers jumped in. Bearish reversal." },
  { name: "Three white soldiers", group: "Three candles", kind: "bull", ctx: "down", c: [[20, 42, 18, 40], [36, 60, 34, 58], [54, 80, 52, 78]],
    means: "Three tall green candles in a row, each opening inside the last and closing higher.",
    read: "Steady, determined buying. A strong bullish signal, especially after a decline." },
  { name: "Three black crows", group: "Three candles", kind: "bear", ctx: "up", c: [[80, 82, 58, 60], [64, 66, 40, 42], [46, 48, 20, 22]],
    means: "Three tall red candles in a row, each opening inside the last and closing lower.",
    read: "Steady, determined selling. A strong bearish signal, especially after a rise." },
  { name: "Three inside up", group: "Three candles", kind: "bull", ctx: "down", c: [[72, 74, 28, 30], [40, 56, 38, 54], [52, 78, 50, 76]],
    means: "A bullish harami followed by a green candle that closes above the first candle's open.",
    read: "A harami that got confirmed. More reliable than the harami alone." },
  { name: "Three inside down", group: "Three candles", kind: "bear", ctx: "up", c: [[28, 72, 26, 70], [60, 62, 44, 46], [48, 50, 22, 24]],
    means: "A bearish harami followed by a red candle that closes below the first candle's open.",
    read: "A harami that got confirmed. More reliable than the harami alone." },
  { name: "Three outside up", group: "Three candles", kind: "bull", ctx: "down", c: [[56, 58, 40, 43], [38, 64, 36, 62], [60, 82, 58, 80]],
    means: "A bullish engulfing followed by another green candle closing higher.",
    read: "An engulfing that got confirmed. Strong bullish reversal." },
  { name: "Three outside down", group: "Three candles", kind: "bear", ctx: "up", c: [[44, 60, 42, 57], [62, 64, 36, 38], [40, 42, 18, 20]],
    means: "A bearish engulfing followed by another red candle closing lower.",
    read: "An engulfing that got confirmed. Strong bearish reversal." },

  // ---------------------------------------------------------------- continuation (5 candles)
  { name: "Rising three methods", group: "Continuation", kind: "cont", ctx: "up",
    c: [[20, 52, 18, 50], [48, 50, 42, 44], [45, 47, 38, 40], [41, 44, 34, 37], [38, 74, 36, 72]],
    means: "A big green candle, three small red candles that stay inside its range, then another big green candle to a new high.",
    read: "A short rest in an uptrend, not a reversal. The trend up resumes." },
  { name: "Falling three methods", group: "Continuation", kind: "cont", ctx: "down",
    c: [[80, 82, 48, 50], [52, 58, 50, 56], [55, 62, 53, 60], [59, 66, 57, 63], [62, 64, 26, 28]],
    means: "A big red candle, three small green candles that stay inside its range, then another big red candle to a new low.",
    read: "A short bounce in a downtrend, not a reversal. The trend down resumes." },
];

const KIND = {
  bull: { label: "Bullish", cls: "k-bull", icon: "▲" },
  bear: { label: "Bearish", cls: "k-bear", icon: "▼" },
  neutral: { label: "Indecision", cls: "k-neutral", icon: "◆" },
  cont: { label: "Continuation", cls: "k-cont", icon: "➜" },
};
const cheat = { filter: "all", q: "" };

/* Draw candles as SVG. ctx adds 3 faded trend candles leading into the pattern. */
function candleSVG(p, opts = {}) {
  const pat = p.c.map((x) => ({ o: x[0], h: x[1], l: x[2], c: x[3], ctx: false }));
  let all = pat;
  if (p.ctx) {
    // Trend candles that walk into the pattern's first open (down: from above, up: from below).
    const span = Math.max(...pat.map((x) => x.h)) - Math.min(...pat.map((x) => x.l));
    const st = Math.max(8, span * 0.28), dir = p.ctx === "down" ? 1 : -1, o0 = pat[0].o, ctx = [];
    for (let k = 0; k < 3; k++) {
      const o = o0 + dir * (3 - k) * st, c = o0 + dir * ((2 - k) * st + st * 0.15);
      ctx.push({ o, c, h: Math.max(o, c) + st * 0.25, l: Math.min(o, c) - st * 0.25, ctx: true });
    }
    all = [...ctx, ...pat];
  }
  const hi = Math.max(...all.map((x) => x.h)), lo = Math.min(...all.map((x) => x.l));
  const W = opts.w || 30, bw = opts.bw || 16, H = opts.h || 130, pad = 10;
  const width = all.length * W + pad * 2;
  const y = (v) => pad + (hi - v) / (hi - lo || 1) * (H - pad * 2);
  const parts = all.map((k, i) => {
    const x = pad + i * W + W / 2;
    const up = k.c > k.o + 0.8, down = k.o > k.c + 0.8;
    const col = k.ctx ? (p.ctx === "down" ? "#8a3a3d" : "#357a2a") : up ? "#53D337" : down ? "#FF5C61" : "#C9CBD0";
    const yt = y(Math.max(k.o, k.c)), yb = y(Math.min(k.o, k.c));
    const bh = Math.max(2, yb - yt);
    return `<line x1="${x}" x2="${x}" y1="${y(k.h)}" y2="${y(k.l)}" stroke="${col}" stroke-width="2" stroke-linecap="round" opacity="${k.ctx ? 0.7 : 1}"/>
      <rect x="${x - bw / 2}" y="${bh === 2 ? (yt + yb) / 2 - 1 : yt}" width="${bw}" height="${bh}" rx="2" fill="${col}" opacity="${k.ctx ? 0.55 : 1}"
        ${k.ctx ? "" : 'filter="url(#cglow)"'}/>`;
  }).join("");
  const ctxW = p.ctx ? pad + 3 * W : 0;
  return `<svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img" aria-label="${p.name} candlestick diagram">
    <defs><filter id="cglow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000" flood-opacity=".6"/></filter></defs>
    ${p.ctx ? `<rect x="${ctxW - 2}" y="2" width="${width - ctxW}" height="${H - 4}" rx="6" fill="rgba(255,255,255,.035)" stroke="rgba(255,255,255,.08)"/>` : ""}
    ${parts}</svg>`;
}

function anatomySVG() {
  const g = "#53D337", r = "#FF5C61", t = "#B9BCC2", m = "#6f7378";
  const lbl = (x, y, s, anchor = "start") => `<text x="${x}" y="${y}" fill="${t}" font-size="12" font-family="Barlow, sans-serif" text-anchor="${anchor}" dominant-baseline="middle">${s}</text>`;
  const tick = (x1, x2, y) => `<line x1="${x1}" x2="${x2}" y1="${y}" y2="${y}" stroke="${m}" stroke-dasharray="3 3"/>`;
  return `<svg viewBox="0 0 600 275" width="100%" style="max-width:600px" role="img" aria-label="Parts of a candlestick">
    <!-- green -->
    <line x1="150" x2="150" y1="20" y2="230" stroke="${g}" stroke-width="3" stroke-linecap="round"/>
    <rect x="128" y="70" width="44" height="110" rx="4" fill="${g}"/>
    ${tick(172, 196, 20)}${lbl(200, 20, "High")}
    ${tick(172, 196, 70)}${lbl(200, 70, "Close")}
    ${tick(172, 196, 180)}${lbl(200, 180, "Open")}
    ${tick(172, 196, 230)}${lbl(200, 230, "Low")}
    ${lbl(118, 45, "Upper wick", "end")}${lbl(118, 125, "Body", "end")}${lbl(118, 205, "Lower wick", "end")}
    ${lbl(150, 262, "Green: opens low, closes high", "middle")}
    <!-- red -->
    <line x1="430" x2="430" y1="20" y2="230" stroke="${r}" stroke-width="3" stroke-linecap="round"/>
    <rect x="408" y="70" width="44" height="110" rx="4" fill="${r}"/>
    ${tick(452, 476, 20)}${lbl(480, 20, "High")}
    ${tick(452, 476, 70)}${lbl(480, 70, "Open")}
    ${tick(452, 476, 180)}${lbl(480, 180, "Close")}
    ${tick(452, 476, 230)}${lbl(480, 230, "Low")}
    ${lbl(430, 262, "Red: opens high, closes low", "middle")}
  </svg>`;
}

function renderCandles() {
  const groups = ["Single candle", "Two candles", "Three candles", "Continuation"];
  const shown = PATTERNS.filter((p) => (cheat.filter === "all" || p.kind === cheat.filter) &&
    (!cheat.q || (p.name + " " + p.means + " " + p.read).toLowerCase().includes(cheat.q.toLowerCase())));
  let html = `<div class="cheat-intro card">
      <div class="anat">${anatomySVG()}</div>
      <div class="anat-text">
        <h3>How to read one candle</h3>
        <p>Each candle is one slice of time (on the Live page: 1 second, 1 minute, 5, 15 minutes or 1 hour).
        The <b>body</b> runs from where the price <b>opened</b> to where it <b>closed</b>; the thin <b>wicks</b> show the highest and lowest prices reached in between.</p>
        <p><span class="pos"><b>Green</b></span> = closed higher than it opened (buyers won). <span class="neg"><b>Red</b></span> = closed lower (sellers won).
        Long wicks mean price went somewhere and got pushed back: a sign of a fight.</p>
        <p>In the drawings below, <b>gray candles show the trend leading in</b>; the highlighted box is the pattern itself. Most reversal patterns only mean something <i>after</i> a clear trend.</p>
      </div></div>
    <div class="cheat-bar">
      <div class="chips" role="group" aria-label="Filter patterns" style="margin:0">
        ${[["all", "All"], ["bull", "▲ Bullish"], ["bear", "▼ Bearish"], ["neutral", "◆ Indecision"], ["cont", "➜ Continuation"]].map(([k, l]) =>
          `<button class="chip" data-cf="${k}" aria-pressed="${cheat.filter === k}">${l}</button>`).join("")}
      </div>
      <input class="cheat-search" type="search" placeholder="Search patterns (e.g. hammer, engulfing)" value="${esc(cheat.q)}" aria-label="Search patterns">
    </div>`;
  for (const g of groups) {
    const ps = shown.filter((p) => p.group === g);
    if (!ps.length) continue;
    html += `<h2>${g} patterns <span class="muted">(${ps.length})</span></h2><div class="cheat-grid">${ps.map((p) => {
      const k = KIND[p.kind];
      return `<div class="ccard ${k.cls}">
        <div class="ccard-h"><b>${p.name}</b><span class="ktag ${k.cls}">${k.icon} ${k.label}</span></div>
        <div class="cfig">${candleSVG(p)}</div>
        ${p.ctx ? `<div class="cctx">Appears after a ${p.ctx === "down" ? "▼ downtrend" : "▲ uptrend"}</div>` : ""}
        <p class="cmeans"><b>What it looks like:</b> ${p.means}</p>
        <p class="cread"><b>What it means:</b> ${p.read}</p>
      </div>`;
    }).join("")}</div>`;
  }
  if (!shown.length) html += `<p class="muted pad">No patterns match that search.</p>`;
  html += `<div class="card cheat-warn"><h3>⚠ Before you trade on patterns</h3>
    <p>Candlestick patterns are rules of thumb, not guarantees. On short timeframes like 1–15 minutes in crypto, most studies find they predict the next move only slightly better than a coin flip, if at all,
    and fees eat small edges (see the P&amp;L numbers on the Live and Backtest tabs). Patterns work best as one clue among several: the trend, volume, and key price levels.
    Wait for the next candle to <b>confirm</b> a pattern before acting on it.</p></div>`;
  return html;
}

function bindCandles() {
  document.querySelectorAll("[data-cf]").forEach((b) => b.addEventListener("click", () => { cheat.filter = b.dataset.cf; render(); }));
  const s = document.querySelector(".cheat-search");
  if (s) s.addEventListener("input", () => {
    cheat.q = s.value;
    const pos = s.selectionStart;
    render().then(() => { const n = document.querySelector(".cheat-search"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } });
  });
}
