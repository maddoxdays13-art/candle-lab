/* Candle Lab practice wallet: fake money only.
   - Claim a free $100 of practice money once a day (like a daily bonus).
   - Buy "Up" or "Down" contracts on the current 15-minute window for BTC, ETH or SOL.
     A contract pays $1 if right. You can sell it back early at the market's current price.
   - Prices come from a simulated market built on Coinbase's live price: the chance of "Up" is how far
     the price is above or below where the window opened, compared with how much it usually moves in
     the time left. 1¢ spread each side and Kalshi's fee (0.07 × price × (1 − price)) on every buy and sell.
   - Settles on Coinbase's 15-minute candle: "Up" wins if it closes at or above where it opened.
   - Or "Trade coins" like Robinhood/Coinbase: spend any part of the balance buying a coin at the live price,
     sell whenever you want. The venue's fee is charged on the buy and on the sell. Regular accounts can't
     profit from a drop (no shorting), so trading is buy-then-sell only.
   Everything is saved only in this browser. Nothing is real; nothing is sent anywhere. */
(() => {
  const KEY = "candlelab-wallet";
  const COINS_W = ["BTC-USD", "ETH-USD", "SOL-USD"];
  const API = "https://api.exchange.coinbase.com";
  const CUTOFF = 30;          // no new bets in the last 30 seconds of a window
  const SPREAD = 0.01;
  const fee = (q) => 0.07 * q * (1 - q);
  const today = () => new Date().toLocaleDateString("en-CA");  // YYYY-MM-DD, local
  const $$ = (s) => document.querySelector(s);
  const usd = (x) => (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);

  const TRADE_FEES = { robinhood: { name: "Robinhood", fee: 0.0095 }, coinbase: { name: "Coinbase", fee: 0.009 },
                       best: { name: "Best case", fee: 0.001 } };
  let W = { balance: 0, lastClaim: null, claims: 0, bets: [], positions: [] };
  try { W = { ...W, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch {}
  W.positions ||= [];
  const saveW = () => { try { localStorage.setItem(KEY, JSON.stringify(W)); } catch {} };

  const ui = { open: false, coin: "BTC-USD", side: "up", stake: 5, tab: "bet", mode: "predict", venue: "robinhood" };
  try { Object.assign(ui, JSON.parse(localStorage.getItem(KEY + "-ui") || "{}"), { open: false, tab: "bet" }); } catch {}
  const saveUi = () => { try { localStorage.setItem(KEY + "-ui", JSON.stringify({ mode: ui.mode, venue: ui.venue, coin: ui.coin, stake: ui.stake })); } catch {} };
  const mkt = {};  // coin -> {start, price, sigma, t, upBid, upAsk, updated}

  /* ---------- market model ---------- */
  const Phi = (z) => 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z * z * z)));  // normal CDF (close approx.)
  const windowStart = (s = Date.now() / 1000) => Math.floor(s / 900) * 900;

  async function getJ(u) { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); }

  async function refreshMarket(coin) {
    const w = windowStart();
    const m = (mkt[coin] ||= {});
    if (m.t !== w || !m.start || !m.sigma) {
      const iso = (t) => new Date(t * 1000).toISOString();
      const [c15, c1] = await Promise.all([
        getJ(`${API}/products/${coin}/candles?granularity=900&start=${iso(w)}&end=${iso(w)}`),
        getJ(`${API}/products/${coin}/candles?granularity=60&start=${iso(w - 3600)}&end=${iso(w)}`),
      ]);
      const cur = c15.find((x) => x[0] === w);
      if (!cur) throw new Error("window not open yet");
      m.start = +cur[3];
      const closes = c1.sort((a, b) => a[0] - b[0]).map((x) => +x[4]);
      const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
      const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
      const sdMin = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1)) || 0.0008;
      m.sigma = sdMin / Math.sqrt(60);  // per second
      m.t = w;
    }
    m.price = +(await getJ(`${API}/products/${coin}/ticker`)).price;
    const left = Math.max(1, w + 900 - Date.now() / 1000);
    const pUp = Math.min(0.99, Math.max(0.01, Phi(Math.log(m.price / m.start) / (m.sigma * Math.sqrt(left)))));
    m.pUp = pUp;
    m.upBid = Math.max(0.01, +(pUp - SPREAD).toFixed(2));
    m.upAsk = Math.min(0.99, +(pUp + SPREAD).toFixed(2));
    m.updated = Date.now();
    return m;
  }
  const askFor = (m, side) => side === "up" ? m.upAsk : +(1 - m.upBid).toFixed(2);
  const bidFor = (m, side) => side === "up" ? m.upBid : +(1 - m.upAsk).toFixed(2);

  /* ---------- actions ---------- */
  function claim() {
    if (W.lastClaim === today()) return;
    W.balance += 100; W.lastClaim = today(); W.claims += 1; saveW();
    toast("+$100 practice money added 🎉"); draw();
  }

  function kronosFor(coin, t) {
    const st = typeof state !== "undefined" ? state : null;  // the dashboard's data (app.js)
    const m = (st?.data?.live?.marks?.[coin] || []).find((x) => x.t === t);
    return m ? { dir: m.dir, conf: m.conf } : null;
  }

  async function placeBet() {
    const coin = ui.coin, side = ui.side, stake = Number(ui.stake);
    const m = await refreshMarket(coin);
    const left = m.t + 900 - Date.now() / 1000;
    if (left < CUTOFF) return toast("Betting is closed for this window. Next one opens soon.");
    const q = askFor(m, side), per = q + fee(q);
    const n = Math.floor(stake / per);
    if (n < 1) return toast(`Stake too small: one contract costs ${usd(per)} right now.`);
    const cost = +(n * per).toFixed(2);
    if (cost > W.balance + 1e-9) return toast("Not enough practice money. Claim your daily $100!");
    W.balance = +(W.balance - cost).toFixed(2);
    W.bets.unshift({ id: Date.now(), coin, side, t: m.t, n, price: q, cost, status: "open", start: m.start,
                     placedAt: Date.now(), kronos: kronosFor(coin, m.t) });
    saveW(); toast(`Bought ${n} × ${side.toUpperCase()} on ${coin.replace("-USD", "")} at ${Math.round(q * 100)}¢`); draw();
  }

  async function sellBet(id) {
    const b = W.bets.find((x) => x.id === id);
    if (!b || b.status !== "open") return;
    const m = await refreshMarket(b.coin);
    if (m.t !== b.t) return toast("This window has ended; it will settle automatically.");
    const q = bidFor(m, b.side), proceeds = +(b.n * (q - fee(q))).toFixed(2);
    W.balance = +(W.balance + proceeds).toFixed(2);
    Object.assign(b, { status: "sold", proceeds, exitPrice: q, settledAt: Date.now() });
    saveW(); toast(`Sold for ${usd(proceeds)} (${usd(proceeds - b.cost)})`); draw();
  }

  async function buyCoin() {
    const coin = ui.coin, amt = Number(ui.stake), v = TRADE_FEES[ui.venue];
    if (amt < 1) return toast("Minimum is $1.");
    if (amt > W.balance + 1e-9) return toast("Not enough practice money. Claim your daily $100!");
    const m = await refreshMarket(coin);
    const qty = (amt * (1 - v.fee)) / m.price;
    W.balance = +(W.balance - amt).toFixed(2);
    W.positions.unshift({ id: Date.now(), coin, qty, cost: amt, entry: m.price, venue: ui.venue, fee: v.fee, openedAt: Date.now(), status: "open",
                          kronos: kronosFor(coin, windowStart()) });
    saveW(); toast(`Bought ${qty.toPrecision(4)} ${coin.replace("-USD", "")} for ${usd(amt)} (${v.name} fee ${usd(amt * v.fee)})`); draw();
  }

  async function sellCoin(id) {
    const p = W.positions.find((x) => x.id === id);
    if (!p || p.status !== "open") return;
    const m = await refreshMarket(p.coin);
    const proceeds = +(p.qty * m.price * (1 - p.fee)).toFixed(2);
    W.balance = +(W.balance + proceeds).toFixed(2);
    Object.assign(p, { status: "closed", proceeds, exit: m.price, closedAt: Date.now() });
    saveW(); toast(`Sold ${p.coin.replace("-USD", "")} for ${usd(proceeds)} (${usd(proceeds - p.cost)})`); draw();
  }
  const posValue = (p) => (mkt[p.coin]?.price ? p.qty * mkt[p.coin].price * (1 - p.fee) : null);

  async function settle() {
    const now = Date.now() / 1000;
    let changed = false;
    for (const b of W.bets.filter((x) => x.status === "open" && now >= x.t + 900 + 20)) {
      try {
        const iso = new Date(b.t * 1000).toISOString();
        const c = (await getJ(`${API}/products/${b.coin}/candles?granularity=900&start=${iso}&end=${iso}`)).find((x) => x[0] === b.t);
        if (!c) continue;
        const up = +c[4] >= +c[3];
        const won = (b.side === "up") === up;
        const proceeds = won ? b.n : 0;
        W.balance = +(W.balance + proceeds).toFixed(2);
        Object.assign(b, { status: won ? "won" : "lost", proceeds, open: +c[3], close: +c[4], settledAt: Date.now() });
        changed = true;
        toast(`${b.coin.replace("-USD", "")} ${b.side.toUpperCase()} ${won ? "won ✓ +" + usd(proceeds - b.cost) : "lost ✗ " + usd(-b.cost)}`);
      } catch {}
    }
    if (changed) { W.bets = W.bets.slice(0, 200); saveW(); draw(); }
  }

  /* ---------- UI ---------- */
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "w-toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2600);
  }

  function stats() {
    const done = W.bets.filter((b) => b.status !== "open");
    const trades = W.positions.filter((p) => p.status === "closed");
    const net = done.reduce((a, b) => a + (b.proceeds - b.cost), 0);
    const staked = done.reduce((a, b) => a + b.cost, 0);
    const tnet = trades.reduce((a, p) => a + (p.proceeds - p.cost), 0), tcost = trades.reduce((a, p) => a + p.cost, 0);
    return { wins: done.filter((b) => b.status === "won").length, losses: done.filter((b) => b.status === "lost").length,
             sold: done.filter((b) => b.status === "sold").length, net, roi: staked ? net / staked : null,
             trades: trades.length, tnet, troi: tcost ? tnet / tcost : null };
  }

  function draw() {
    const canClaim = W.lastClaim !== today();
    const fab = $$("#w-fab");
    const held = W.positions.filter((x) => x.status === "open").reduce((a, x) => a + (posValue(x) ?? x.cost), 0);
    fab.innerHTML = `<span class="w-coin">🪙</span><b>${usd(W.balance + held)}</b>${canClaim ? '<span class="w-claimdot">FREE $100</span>' : ""}`;
    fab.classList.toggle("glow", canClaim);
    const p = $$("#w-panel");
    p.hidden = !ui.open;
    if (!ui.open) return;
    const m = mkt[ui.coin], left = m?.t ? Math.max(0, Math.round(m.t + 900 - Date.now() / 1000)) : null;
    const st = stats(), open = W.bets.filter((b) => b.status === "open"), done = W.bets.filter((b) => b.status !== "open");
    const k = m?.t ? kronosFor(ui.coin, m.t) : null;
    const ask = m?.upAsk ? askFor(m, ui.side) : null;
    const per = ask ? ask + fee(ask) : null, n = per ? Math.floor(ui.stake / per) : 0;
    p.innerHTML = `
      <div class="w-head"><div><div class="w-title">Practice wallet</div><div class="w-sub">Fake money · practice only</div></div>
        <div class="w-hbtns"><button class="w-x w-tr" data-wt="transfer" aria-label="Transfer wallet to another device" title="Transfer to another device">⇄</button>
        <button class="w-x" data-w="close" aria-label="Close">✕</button></div></div>
      <div class="w-bal"><div><div class="w-sub">Balance</div><div class="w-big">${usd(W.balance)}</div></div>
        <button class="w-claim" data-w="claim" ${canClaim ? "" : "disabled"}>${canClaim ? "🎁 Claim free $100" : "✓ Claimed today"}</button></div>
      <div class="w-tabs">${[["bet", "Bet"], ["open", `Open (${open.length + W.positions.filter((x) => x.status === "open").length})`], ["history", "History"], ["auto", "🌙 Auto"]].map(([k2, l]) =>
        `<button data-wt="${k2}" aria-pressed="${ui.tab === k2}">${l}</button>`).join("")}</div>
      ${ui.tab === "bet" ? modeToggle() + (ui.mode === "trade" ? tradeHTML() : `
        <div class="w-row">${COINS_W.map((c) => `<button class="chip" data-wc="${c}" aria-pressed="${ui.coin === c}">${c.replace("-USD", "")}</button>`).join("")}</div>
        <div class="w-mkt">${m?.price ? `<div class="w-sub">${ui.coin.replace("-USD", "")} now <b>$${fmtPrice(m.price)}</b> · opened window at $${fmtPrice(m.start)}
            · closes in <b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</b></div>` : `<div class="w-sub">Loading market…</div>`}
          <div class="w-sides">
            <button class="w-side up" data-ws="up" aria-pressed="${ui.side === "up"}">▲ UP<span>${m?.upAsk ? Math.round(m.upAsk * 100) + "¢" : "–"}</span></button>
            <button class="w-side down" data-ws="down" aria-pressed="${ui.side === "down"}">▼ DOWN<span>${m?.upBid ? Math.round((1 - m.upBid) * 100) + "¢" : "–"}</span></button>
          </div>
          ${k ? `<div class="w-sub">Kronos says <b class="${k.dir === "up" ? "pos" : k.dir === "down" ? "neg" : ""}">${k.dir.toUpperCase()}</b>${k.dir !== "skip" ? ` (${Math.round(k.conf * 100)}% of samples)` : ""}</div>` : ""}
        </div>
        <div class="w-row">${[1, 5, 10, 25].map((v) => `<button class="chip" data-wa="${v}" aria-pressed="${+ui.stake === v}">$${v}</button>`).join("")}
          <input class="w-amt" type="number" min="1" step="1" value="${ui.stake}" aria-label="Stake in dollars"></div>
        <div class="w-sub w-quote">${ask ? `${n} contract${n === 1 ? "" : "s"} × ${Math.round(ask * 100)}¢ + fee ${(fee(ask) * 100).toFixed(2)}¢ = <b>${usd(n * per)}</b> · pays <b>${usd(n)}</b> if ${ui.side.toUpperCase()} wins` : ""}</div>
        ${ask ? sizeHint(ask, left, ui.coin) : ""}
        <button class="w-place ${ui.side}" data-w="place" ${left != null && left < CUTOFF ? "disabled" : ""}>${left != null && left < CUTOFF ? "Window closing…" : `Buy ${ui.side.toUpperCase()}`}</button>
        <div class="w-fine">Simulated market from Coinbase's live price (real Kalshi/Robinhood prices differ). Settles on Coinbase's 15-minute candle: UP wins if it closes at or above the open. Kalshi-style fees on every buy and sell.</div>`)
      : ui.tab === "transfer" ? transferHTML()
      : ui.tab === "auto" ? autopilotHTML()
      : ui.tab === "open" ? positionsHTML() + (open.length ? open.map((b) => {
          const mm = mkt[b.coin], q = mm?.t === b.t ? bidFor(mm, b.side) : null, val = q != null ? b.n * (q - fee(q)) : null;
          return `<div class="w-bet"><div><b>${b.coin.replace("-USD", "")} ${b.side === "up" ? "▲ UP" : "▼ DOWN"}</b> · ${b.n} @ ${Math.round(b.price * 100)}¢
            <div class="w-sub">${hhmm(b.t * 1000)}–${hhmm((b.t + 900) * 1000)} · cost ${usd(b.cost)} · pays ${usd(b.n)}${val != null ? ` · worth now <b class="${val >= b.cost ? "pos" : "neg"}">${usd(val)}</b>` : " · settling…"}</div></div>
            ${val != null ? `<button class="w-sell" data-sell="${b.id}">Sell ${usd(val)}</button>` : ""}</div>`;
        }).join("") : W.positions.some((x) => x.status === "open") ? "" : `<div class="w-sub w-empty">Nothing open.</div>`)
      : `<div class="w-stats"><span>Predict <b>${st.wins}–${st.losses}</b>${st.sold ? ` (+${st.sold} sold)` : ""}</span>
          <span>Net <b class="${st.net >= 0 ? "pos" : "neg"}">${usd(st.net)}</b></span><span>ROI <b>${st.roi == null ? "–" : (st.roi * 100).toFixed(1) + "%"}</b></span></div>
        <div class="w-stats"><span>Trades <b>${st.trades}</b></span><span>Net <b class="${st.tnet >= 0 ? "pos" : "neg"}">${usd(st.tnet)}</b></span>
          <span>ROI <b>${st.troi == null ? "–" : (st.troi * 100).toFixed(1) + "%"}</b></span></div>
        ${W.positions.filter((x) => x.status === "closed").slice(0, 20).map((x) => `<div class="w-bet ${x.proceeds >= x.cost ? "won" : "lost"}"><div><b>${x.coin.replace("-USD", "")} trade</b> · ${TRADE_FEES[x.venue]?.name || ""}
          <div class="w-sub">bought $${fmtPrice(x.entry)} → sold $${fmtPrice(x.exit)} · ${new Date(x.closedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></div>
          <div class="w-res">${usd(x.cost)} in<br><b class="${x.proceeds - x.cost >= 0 ? "pos" : "neg"}">${usd(x.proceeds - x.cost)}</b></div></div>`).join("")}
        ${done.slice(0, 40).map((b) => `<div class="w-bet ${b.status}"><div><b>${b.coin.replace("-USD", "")} ${b.side === "up" ? "▲ UP" : "▼ DOWN"}</b> · ${b.n} @ ${Math.round(b.price * 100)}¢
          <div class="w-sub">${new Date(b.t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${b.kronos ? ` · Kronos said ${b.kronos.dir}` : ""}</div></div>
          <div class="w-res">${b.status === "won" ? "✓ WON" : b.status === "lost" ? "✗ LOST" : "SOLD"}<br><b class="${b.proceeds - b.cost >= 0 ? "pos" : "neg"}">${usd(b.proceeds - b.cost)}</b></div></div>`).join("") || (W.positions.some((x) => x.status === "closed") ? "" : `<div class="w-sub w-empty">Nothing finished yet.</div>`)}
        <button class="w-reset" data-w="reset">Reset wallet</button>`}`;
  }

  function modeToggle() {
    return `<div class="w-mode">${[["predict", "🎯 Predict Up/Down"], ["trade", "📈 Trade coins"]].map(([k, l]) =>
      `<button data-wm="${k}" aria-pressed="${ui.mode === k}">${l}</button>`).join("")}</div>`;
  }

  function tradeHTML() {
    const m = mkt[ui.coin], v = TRADE_FEES[ui.venue];
    const amt = Number(ui.stake), qty = m?.price ? (amt * (1 - v.fee)) / m.price : null;
    const be = (1 / ((1 - v.fee) ** 2) - 1) * 100;  // % rise needed to get your money back after both fees
    return `
      <div class="w-row">${COINS_W.map((c) => `<button class="chip" data-wc="${c}" aria-pressed="${ui.coin === c}">${c.replace("-USD", "")}</button>`).join("")}</div>
      <div class="w-row"><span class="w-sub">Fees like:</span>${Object.entries(TRADE_FEES).map(([k, f]) =>
        `<button class="chip" data-wv="${k}" aria-pressed="${ui.venue === k}">${f.name} ${(f.fee * 100).toFixed(f.fee < 0.005 ? 1 : 2)}%</button>`).join("")}</div>
      <div class="w-mkt"><div class="w-sub">${ui.coin.replace("-USD", "")} price</div>
        <div class="w-big">${m?.price ? "$" + fmtPrice(m.price) : "…"}</div>
        <div class="w-sub">You need about <b class="neg">+${be.toFixed(2)}%</b> just to break even after the ${v.name} fee to buy <i>and</i> to sell.</div></div>
      <div class="w-row">${[5, 10, 25, 50].map((x) => `<button class="chip" data-wa="${x}" aria-pressed="${+ui.stake === x}">$${x}</button>`).join("")}
        <button class="chip" data-wa="${Math.floor(W.balance)}">All</button>
        <input class="w-amt" type="number" min="1" step="1" value="${ui.stake}" aria-label="Amount in dollars"></div>
      <div class="w-sub w-quote">${qty ? `${usd(amt)} buys <b>${qty.toPrecision(4)} ${ui.coin.replace("-USD", "")}</b> after a ${usd(amt * v.fee)} fee` : ""}</div>
      <button class="w-place up" data-w="buy">Buy ${ui.coin.replace("-USD", "")}</button>
      <div class="w-fine">Buy now, sell any time from the Open tab at the live Coinbase price. ${v.name}'s fee (${(v.fee * 100).toFixed(2)}%) is taken on the buy and again on the sell.
        Regular Robinhood/Coinbase accounts can't profit from a price drop (no shorting); to bet on Down, use Predict.</div>`;
  }

  function positionsHTML() {
    const ps = W.positions.filter((x) => x.status === "open");
    return ps.map((x) => {
      const val = posValue(x), chg = mkt[x.coin]?.price ? (mkt[x.coin].price / x.entry - 1) * 100 : null;
      return `<div class="w-bet"><div><b>${x.coin.replace("-USD", "")} 📈 holding</b> · ${usd(x.cost)} in
        <div class="w-sub">bought at $${fmtPrice(x.entry)}${chg != null ? ` · price ${chg >= 0 ? "▲" : "▼"} ${Math.abs(chg).toFixed(2)}%` : ""} · ${TRADE_FEES[x.venue]?.name}
          ${val != null ? ` · worth after fee <b class="${val >= x.cost ? "pos" : "neg"}">${usd(val)}</b>` : ""}</div></div>
        ${val != null ? `<button class="w-sell" data-sellpos="${x.id}">Sell ${usd(val)}</button>` : ""}</div>`;
    }).join("");
  }

  /* ---------- Strict-rule bet sizing (same rule as the phone alerts) ---------- */
  function sizeAdvice(q, win) {
    const edge = win - q - fee(q);
    if (q > 0.55 || edge <= 0) return { mult: 0, label: "Skip: price too high for this signal", edge };
    if (q < 0.40) return { mult: 1, label: "1× (normal): unusually cheap, the move may already be against you", edge };
    if (edge >= 0.06) return { mult: 2, label: "2× your normal bet (max)", edge };
    if (edge >= 0.03) return { mult: 1.5, label: "1.5× your normal bet", edge };
    return { mult: 1, label: "1× (your normal bet)", edge };
  }
  function sizeHint(q, left, coin) {
    const st = typeof state !== "undefined" ? state : null;
    const s = st?.data?.backtest?.coins?.[coin]?.models?.strict?.summary;
    const win = s?.calls ? s.hit_rate : 0.54;
    if (left != null && left < 300) return `<div class="w-rule bad">⚠ Strict rule says skip: less than 5 minutes left</div>`;
    const a = sizeAdvice(q, win);
    return `<div class="w-rule ${a.mult ? "ok" : "bad"}">${a.mult ? "✓" : "⚠"} If this is a ⚡ Strict signal: <b>${a.label}</b>
      <span style="font-weight:600">· ${Math.round(q * 100)}¢ vs a ${Math.round(win * 100)}% win chance → edge ${a.edge >= 0 ? "+" : ""}${(a.edge * 100).toFixed(1)}¢ per contract</span></div>`;
  }

  /* ---------- night autopilot (runs on GitHub; read-only here) ---------- */
  function autopilotHTML() {
    const st = typeof state !== "undefined" ? state : null;
    const a = st?.data?.live?.autopilot;
    if (!a || a.error) return `<div class="w-sub w-empty">Autopilot data isn't available yet.</div>`;
    const c = a.config, h = (x) => (x % 12 || 12) + (x < 12 ? " am" : " pm");
    const et = (t) => new Date(t * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `<div class="w-sub" style="margin-bottom:8px">Bets <b>$${c.stake}</b> on every ⚡ Strict signal from <b>${h(c.start_hour_et)} to ${h(c.end_hour_et)} Eastern</b>
        at Kalshi's real price (only if ${Math.round(c.max_price * 100)}¢ or less), settled by Kalshi's real result. Runs on GitHub, so it works while you sleep.
        ${c.enabled ? "" : "<b>Currently turned off.</b>"} Shared: everyone who opens Candle Lab sees this same account.</div>
      <div class="w-bal"><div><div class="w-sub">Autopilot balance</div><div class="w-big">${usd(a.balance)}</div></div>
        <div class="w-sub" style="text-align:right">started with ${usd(c.start_balance)}<br>Record <b>${a.wins}–${a.losses}</b>${a.open ? ` · ${a.open} open` : ""}<br>
        Net <b class="${a.net >= 0 ? "pos" : "neg"}">${usd(a.net)}</b>${a.roi == null ? "" : ` · ROI ${(a.roi * 100).toFixed(1)}%`}</div></div>
      ${a.recent.length ? a.recent.map((b) => {
        const pl = b.status === "open" ? null : (b.proceeds || 0) - b.cost;
        return `<div class="w-bet ${b.status === "won" ? "won" : b.status === "lost" ? "lost" : ""}"><div><b>${b.coin.replace("-USD", "")} ${b.side === "up" ? "▲ UP" : "▼ DOWN"}</b> · ${b.contracts} @ ${Math.round(b.price * 100)}¢
          <div class="w-sub">${et(b.candle_ts)} ET window · cost ${usd(b.cost)}</div></div>
          <div class="w-res">${b.status === "open" ? "OPEN" : b.status === "won" ? "✓ WON" : "✗ LOST"}<br>${pl == null ? "" : `<b class="${pl >= 0 ? "pos" : "neg"}">${usd(pl)}</b>`}</div></div>`;
      }).join("") : `<div class="w-sub w-empty">No autopilot bets yet. The first ones come tonight, if a Strict signal fires between ${h(c.start_hour_et)} and ${h(c.end_hour_et)} Eastern.</div>`}`;
  }

  /* ---------- transfer between devices ---------- */
  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (str) => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  async function packWallet() {
    const slim = { ...W, bets: W.bets.slice(0, 100), positions: W.positions.slice(0, 100), v: 1 };
    const raw = new TextEncoder().encode(JSON.stringify(slim));
    if (typeof CompressionStream === "undefined") return "j" + b64u(raw);
    const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    let out = "";
    for (let i = 0; i < gz.length; i += 8192) out += String.fromCharCode(...gz.subarray(i, i + 8192));
    return "z" + btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function unpackWallet(code) {
    code = code.trim().replace(/^.*#wallet=/, "");
    const bytes = unb64u(code.slice(1));
    const raw = code[0] === "z"
      ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
      : bytes;
    const w = JSON.parse(new TextDecoder().decode(raw));
    if (typeof w.balance !== "number" || !Array.isArray(w.bets)) throw new Error("not a wallet");
    return { balance: w.balance, lastClaim: w.lastClaim || null, claims: w.claims || 0, bets: w.bets, positions: w.positions || [] };
  }
  const transferLink = (code) => location.origin + location.pathname + "#wallet=" + code;

  function transferHTML() {
    return `<div class="w-sub" style="margin-bottom:8px">Move this wallet (balance, open bets, history) to your other device.</div>
      <div class="w-tbox"><b>Send from this device</b>
        <div class="w-row"><button class="chip" data-w="tlink">📋 Copy transfer link</button>${navigator.share ? `<button class="chip" data-w="tshare">↗ Share…</button>` : ""}
          <button class="chip" data-w="tqr">▦ Show QR code</button></div>
        <div id="w-qr" class="w-qr"></div>
        <div class="w-sub">Text, email or AirDrop the link to yourself, or scan the QR with your phone's camera. Opening it on the other device asks before replacing that device's wallet.</div></div>
      <div class="w-tbox"><b>Receive on this device</b>
        <textarea class="w-code" placeholder="…or paste a transfer link or code here" aria-label="Transfer code"></textarea>
        <button class="chip" data-w="timport">⬇ Import</button></div>`;
  }

  async function importCode(code) {
    let w;
    try { w = await unpackWallet(code); } catch { return toast("That transfer code didn't work. Copy the whole link and try again."); }
    const ok = confirm(`Replace this device's practice wallet with the transferred one?\n\nTransferred: ${usd(w.balance)} cash, ${w.bets.length} bets, ${w.positions.length} trades.\nThis device now: ${usd(W.balance)} cash, ${W.bets.length} bets.`);
    if (!ok) return;
    W = w; saveW(); toast("Wallet transferred ✓"); ui.tab = "bet"; draw(); settle();
  }

  async function checkHashImport() {
    if (!location.hash.startsWith("#wallet=")) return;
    const code = location.hash.slice(8);
    history.replaceState(null, "", location.pathname + location.search);
    ui.open = true; draw();
    await importCode(code);
  }

  async function loadQR() {
    if (window.QRCode) return;
    await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  }

  async function transferAction(a) {
    const link = transferLink(await packWallet());
    if (a === "tlink") {
      try { await navigator.clipboard.writeText(link); toast("Transfer link copied: send it to your other device"); }
      catch { prompt("Copy this transfer link:", link); }
    } else if (a === "tshare") {
      try { await navigator.share({ title: "Candle Lab practice wallet", url: link }); } catch {}
    } else if (a === "tqr") {
      const el = $$("#w-qr");
      if (link.length > 2300) { el.innerHTML = `<div class="w-sub">Too much history for a QR code. Use "Copy transfer link" instead.</div>`; return; }
      try { await loadQR(); } catch { el.innerHTML = `<div class="w-sub">Couldn't load the QR maker. Use "Copy transfer link" instead.</div>`; return; }
      el.innerHTML = "";
      new QRCode(el, { text: link, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
    } else if (a === "timport") {
      const code = $$(".w-code")?.value || "";
      if (code.trim()) importCode(code);
    }
  }

  function bind() {
    document.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-w],[data-wt],[data-wc],[data-ws],[data-wa],[data-sell],[data-sellpos],[data-wm],[data-wv],#w-fab,[data-wbet]");
      if (!t) return;
      if (t.id === "w-fab") { ui.open = !ui.open; if (ui.open) tick(); draw(); return; }
      if (t.dataset.wbet) { const [coin, side] = t.dataset.wbet.split(":"); Object.assign(ui, { open: true, tab: "bet", mode: "predict", coin, side }); tick(); draw(); return; }
      if (t.dataset.wm) { ui.mode = t.dataset.wm; saveUi(); tick(); }
      if (t.dataset.wv) { ui.venue = t.dataset.wv; saveUi(); }
      if (t.dataset.sellpos) return sellCoin(+t.dataset.sellpos).catch(() => toast("Couldn't reach Coinbase; try again."));
      const a = t.dataset.w;
      if (a === "close") ui.open = false;
      if (a === "claim") return claim();
      if (a === "buy") return buyCoin().catch(() => toast("Couldn't reach Coinbase; try again."));
      if (a && a.startsWith("t") && ["tlink", "tshare", "tqr", "timport"].includes(a)) return transferAction(a);
      if (a === "place") return placeBet().catch(() => toast("Couldn't reach Coinbase; try again."));
      if (a === "reset" && confirm("Reset your practice wallet? This clears your balance and history.")) { W = { balance: 0, lastClaim: null, claims: 0, bets: [], positions: [] }; saveW(); }
      if (t.dataset.wt) ui.tab = t.dataset.wt;
      if (t.dataset.wc) { ui.coin = t.dataset.wc; saveUi(); tick(); }
      if (t.dataset.ws) ui.side = t.dataset.ws;
      if (t.dataset.wa) ui.stake = +t.dataset.wa;
      if (t.dataset.sell) return sellBet(+t.dataset.sell).catch(() => toast("Couldn't reach Coinbase; try again."));
      draw();
    });
    document.addEventListener("input", (e) => { if (e.target.classList?.contains("w-amt")) { ui.stake = Math.max(1, +e.target.value || 1); drawQuote(); } });
  }
  function drawQuote() {  // update only the quote line while typing, so the input keeps focus
    const m = mkt[ui.coin], el = $$(".w-quote");
    if (ui.mode === "trade" && ui.tab === "bet") {
      const v = TRADE_FEES[ui.venue];
      if (el && m?.price) el.innerHTML = `${usd(ui.stake)} buys <b>${((ui.stake * (1 - v.fee)) / m.price).toPrecision(4)} ${ui.coin.replace("-USD", "")}</b> after a ${usd(ui.stake * v.fee)} fee`;
      return;
    }
    if (!m?.upAsk || !el) return;
    const ask = askFor(m, ui.side), per = ask + fee(ask), n = Math.floor(ui.stake / per);
    el.innerHTML = `${n} contract${n === 1 ? "" : "s"} × ${Math.round(ask * 100)}¢ + fee ${(fee(ask) * 100).toFixed(2)}¢ = <b>${usd(n * per)}</b> · pays <b>${usd(n)}</b> if ${ui.side.toUpperCase()} wins`;
  }

  async function tick() {
    if (ui.open) {
      const coins = new Set([ui.coin, ...W.bets.filter((b) => b.status === "open").map((b) => b.coin),
                             ...W.positions.filter((x) => x.status === "open").map((x) => x.coin)]);
      await Promise.all([...coins].map((c) => refreshMarket(c).catch(() => {})));
      if (ui.tab === "transfer") return;
      if (!document.activeElement?.classList?.contains("w-amt")) draw(); else drawQuote();
    }
  }

  function init() {
    const fab = document.createElement("button");
    fab.id = "w-fab"; fab.setAttribute("aria-label", "Practice wallet");
    const panel = document.createElement("div");
    panel.id = "w-panel"; panel.hidden = true; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Practice wallet");
    document.body.append(fab, panel);
    bind(); draw(); settle(); checkHashImport();
    setInterval(tick, 3000);                       // live prices while the wallet is open
    setInterval(() => { settle(); if (!ui.open) draw(); }, 20000);
    setInterval(() => { if (ui.open && !["transfer", "auto"].includes(ui.tab) && !document.activeElement?.classList?.contains("w-amt")) draw(); }, 1000);  // countdown
  }
  window.CandleWallet = { claim, packWallet };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
