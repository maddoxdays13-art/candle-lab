/* Candle Lab: Strict signals on every coin Kalshi has a 15-minute market for.
   Reads data/strict.json (rebuilt by the live logger every 15 minutes). */

function stVerdict(hit, lo, hi, be, n, min = 30) {
  if (!n) return `<span class="verdict meh">NO BETS YET</span>`;
  if (n < min) return `<span class="verdict meh">TOO EARLY TO JUDGE (${n} of ${min} bets)</span>`;
  if (lo > be) return `<span class="verdict yes">✓ PROFITABLE, BEYOND LUCK</span>`;
  if (hi < be) return `<span class="verdict no">✗ LOSING MONEY</span>`;
  return `<span class="verdict luck">${hit > be ? "AHEAD" : "BEHIND"}, BUT COULD BE LUCK</span>`;
}

function renderStrict(d) {
  if (!d) return `<p class="pad muted">No Strict data yet. The live logger writes data/strict.json on its next run.</p>`;
  const v = state.venue, vi = venueInfo(), A = d.coins.ALL, K = A.kalshi, B = A.backtest?.check;
  const be = K.breakeven?.[v], btBe = B?.bets?.[v]?.breakeven;
  const name = (c) => c.replace("-USD", "");
  const waiting = d.coin_list.filter((c) => d.coins[c].cutoff == null);
  const rangeTxt = (x) => x?.calls ? `${pct(x.ci_low)} – ${pct(x.ci_high)}` : "–";

  let html = venueChips() + `
  <div class="cards" style="margin-top:12px">
    <div class="card"><div class="label">Real Kalshi prices: P&amp;L, $1 contract per signal (${esc(vi.name)})</div>
      <div class="big ${cls(K.pnl?.[v])}">${money(K.pnl?.[v])}</div>
      <div class="sub">${num(K.bets)} settled bets · won ${num(K.hits)} (${pct(K.hit_rate)}) · 95% range ${K.bets ? pct(K.ci_low) + " – " + pct(K.ci_high) : "–"}</div>
      <div class="sub">Avg price paid ${K.avg_price == null ? "–" : Math.round(K.avg_price * 100) + "¢"} · need ${pct(be)} to break even with fees</div>
      ${stVerdict(K.hit_rate, K.ci_low, K.ci_high, be, K.bets)}</div>
    <div class="card"><div class="label">Live hit rate (Coinbase close)</div>
      <div class="big">${pct(A.live.hit_rate)}</div>
      <div class="sub">${num(A.live.hits)} of ${num(A.live.calls)} right · 95% range ${rangeTxt(A.live)}</div>
      <div class="sub">${num(A.signals)} Strict signals so far across ${d.coin_list.length - waiting.length} coins</div></div>
    <div class="card"><div class="label">Backtest check (data never used to tune it)</div>
      <div class="big">${pct(B?.hit_rate)}</div>
      <div class="sub">${num(B?.hits)} of ${num(B?.calls)} right · 95% range ${rangeTxt(B)}</div>
      <div class="sub">At an even 50¢: ${money(B?.bets?.[v]?.pnl)} (break-even ${pct(btBe)})</div>
      ${B ? stVerdict(B.hit_rate, B.ci_low, B.ci_high, btBe, B.calls) : ""}</div>
  </div>
  <p class="note"><b>How to judge it:</b> it's profitable only if the win rate beats the break-even line, which is the price you pay plus the fee.
    The real-price card is the honest one, because it uses the exact Kalshi price at the moment of each signal. Wait for the 95% range to sit entirely above break-even
    (the green "beyond luck" badge) before trusting it. With fewer than ~100 bets, a hot or cold streak can easily fool you.</p>
  ${waiting.length ? `<p class="note" style="color:var(--warn)">Warming up: ${waiting.map(name).join(", ")}. These coins need a finished backtest to set their Strict cutoff
    (same rule as BTC/ETH/SOL), so they won't fire signals until it's done (usually a few hours to a day).</p>` : ""}

  <h2>Running P&amp;L at real Kalshi prices</h2>
  ${d.curve.length ? `<div class="chartbox"><canvas id="stCurve"></canvas></div>` : `<p class="pad muted">No settled bets yet.</p>`}

  <h2>By coin</h2>
  <div class="tablewrap"><table><thead><tr><th>Coin</th><th>Signals</th><th>Live right</th>
    <th>Kalshi bets</th><th>Won</th><th>Avg price</th><th>Break-even</th><th>P&amp;L</th><th>Verdict</th>
    <th>Backtest check</th><th>Cutoff</th></tr></thead><tbody>
    ${[...d.coin_list, "ALL"].map((c) => {
      const x = d.coins[c], k = x.kalshi, bc = x.backtest?.check;
      const off = c !== "ALL" && x.cutoff == null;
      return `<tr${c === "ALL" ? ' class="allrow"' : ""}><td style="text-align:left"><b>${c === "ALL" ? "All coins" : name(c)}</b></td>
        <td>${num(x.signals)}</td><td>${x.live.calls ? `${pct(x.live.hit_rate)} <span class="muted">of ${num(x.live.calls)}</span>` : "–"}</td>
        <td>${num(k.bets)}</td><td>${pct(k.hit_rate)}</td><td>${k.avg_price == null ? "–" : Math.round(k.avg_price * 100) + "¢"}</td>
        <td>${pct(k.breakeven?.[v])}</td><td class="${cls(k.pnl?.[v])}">${k.bets ? money(k.pnl[v]) : "–"}</td>
        <td>${off ? `<span class="muted">warming up</span>` : stVerdict(k.hit_rate, k.ci_low, k.ci_high, k.breakeven?.[v], k.bets)}</td>
        <td>${bc?.calls ? `${pct(bc.hit_rate)} <span class="muted">of ${num(bc.calls)}</span>` : `<span class="muted">${x.backtest ? "running" : "–"}</span>`}</td>
        <td class="mono">${c === "ALL" ? "" : x.cutoff == null ? "–" : x.cutoff.toFixed(3) + "%"}</td></tr>`;
    }).join("")}
  </tbody></table></div>
  <p class="note">Signals = every Strict call logged. Live right = scored on Coinbase's close. Kalshi bets = signals where Kalshi had a market and it has settled,
    bought at the ask the moment the signal fired (about 75 seconds into the window). Cutoff = the smallest predicted move that counts as a Strict signal.</p>

  <h2>Recent signals <span class="muted" style="font-weight:500;font-size:13px">(newest first)</span></h2>
  <div class="tablewrap r12-trades"><table><thead><tr><th>Window (your time)</th><th>Coin</th><th>Call</th><th>Predicted move</th>
    <th>Kalshi price</th><th>Result</th><th>P&amp;L</th></tr></thead><tbody>
    ${d.recent.map((r) => `<tr><td>${fmtTime(r.t)}</td><td>${name(r.coin)}</td><td>${dirPill(r.dir)}</td>
      <td>${r.move == null ? "–" : r.move.toFixed(3) + "%"}</td><td>${r.price == null ? "–" : Math.round(r.price * 100) + "¢"}</td>
      <td>${r.result === "won" ? `<span class="res pos">✓ WON</span>` : r.result === "lost" ? `<span class="res neg">✗ LOST</span>`
        : r.ok == null ? `<span class="muted">open</span>` : `<span class="muted">${r.ok ? "✓ right" : "✗ wrong"} (no Kalshi price)</span>`}</td>
      <td class="${cls(r[v])}">${r[v] == null ? "–" : money(r[v])}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">No signals yet.</td></tr>`}
  </tbody></table></div>
  <p class="note">Paper only, not financial advice. Kalshi settles on the CF Benchmarks 60-second average, so it can disagree with Coinbase's close on very tight calls.</p>`;
  return html;
}

function drawStrict(d) {
  const c = $("#stCurve");
  if (!c || !d?.curve.length) return;
  const v = state.venue, last = d.curve[d.curve.length - 1][v];
  lineChart(c, [{ label: `P&L, ${venueInfo().name} ($)`, borderColor: css(last >= 0 ? "--good" : "--bad"), backgroundColor: css(last >= 0 ? "--good" : "--bad"),
    data: d.curve.map((p) => ({ x: p.t, y: p[v] })) }], { yFmt: (y) => "$" + y, refLine: { y: 0, label: "$0" } });
}
