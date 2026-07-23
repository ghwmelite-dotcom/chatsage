/**
 * ChartSage — screenshot-to-signal analyst on Cloudflare Workers AI (free tier).
 *
 * POST /analyze   { image: <base64 no prefix>, notes?: string } -> signal JSON (logged to D1)
 * POST /outcome   { id, outcome: "win"|"loss"|"breakeven"|"skipped" }
 * GET  /signals   ?limit=30 -> recent signals
 * GET  /stats     -> win-rate breakdowns by class / session / setup
 * GET  /          -> UI
 *
 * Models (both free-tier eligible on Workers AI):
 *   Vision:    @cf/meta/llama-3.2-11b-vision-instruct
 *   Reasoning: @cf/meta/llama-3.3-70b-instruct-fp8-fast
 */

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const REASON_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/* ------------------------------------------------------------------ */
/* Asset-class rulebooks                                               */
/* ------------------------------------------------------------------ */

const RULEBOOKS = {
  forex: {
    label: "Forex (real feed)",
    rules: `Trend-following bias. Only trade WITH the visible higher-timeframe structure.
- Valid LONG: higher lows + pullback to dynamic support (MA/structure) + bullish confirmation candle.
- Valid SHORT: mirror of the above.
- Session matters: during 'asian' or 'off_hours', raise the NO_TRADE bar sharply — only A+ setups.
- During 'overlap' (London/NY), momentum continuation setups are strongest.
- Avoid trading directly into obvious round-number or marked S/R levels.`,
  },
  crypto: {
    label: "Crypto",
    rules: `Momentum bias, 24/7 market.
- Valid LONG: breakout + retest holding, or strong impulse leg with shallow pullback.
- Valid SHORT: breakdown + failed reclaim.
- Crypto wicks hard: demand a closed confirmation candle, never enter mid-candle on a spike.
- If the chart shows chop/compression, NO_TRADE.`,
  },
  commodity: {
    label: "Metals (Gold/Silver)",
    rules: `Session-aware trend bias — gold respects the London/NY rhythm.
- Asian session gold is usually rangebound: raise the NO_TRADE bar; the tradable event is often the London break of the Asian range.
- Valid LONG: pullback to a prior breakout zone, or a sweep of the Asian/session low that reclaims the level.
- Valid SHORT: mirror — failed breaks of session highs are high-quality shorts.
- Previous day high/low (PDH/PDL) are magnets and reversal zones: do not enter directly into them.
- Never fade a strong impulse leg without a clear rejection structure (long wick, engulfing).
- Gold strengthens when DXY weakens and real yields fall; if the chart shows DXY-style risk-off panic candles, respect the momentum direction.
- News windows (NFP, CPI, FOMC) produce violent spikes: stand aside unless the setup formed BEFORE the release.`,
  },
  stock_index: {
    label: "Stock / Index",
    rules: `Market-hours aware.
- If 'off_hours' for the underlying market, this is a synthetic/OTC feed — apply mean-reversion rules and be stricter.
- Valid LONG: trend continuation after pullback to VWAP-like mean or visible MA.
- Valid SHORT: breakdown from distribution range.
- Gaps and open-drive candles: stand aside for the first visible impulse, trade the retest.`,
  },
  synthetic: {
    label: "Synthetic index",
    rules: `Pure statistical behavior, no fundamentals, no sessions.
- Trade only clean structure: well-defined ranges or clean trends with rhythmic pullbacks.
- Valid LONG: rejection at established range low OR pullback in clean uptrend.
- Valid SHORT: mirror.
- Spike-type instruments (Crash/Boom style): NEVER counter-trend against the drift direction.`,
  },
  unknown: {
    label: "Unknown asset",
    rules: `Asset could not be confidently identified. Apply the strictest generic filter:
- Only signal on unmistakable structure: clear multi-touch S/R with a strong rejection candle, or a clean trend with textbook pullback + confirmation.
- Default answer is NO_TRADE. Confidence must never exceed 60.`,
  },
};

/* ------------------------------------------------------------------ */
/* Session detection (UTC)                                             */
/* ------------------------------------------------------------------ */

function currentSession(assetClass, now = new Date()) {
  if (assetClass === "otc" || assetClass === "synthetic" || assetClass === "crypto") return "n/a";
  const h = now.getUTCHours();
  if (h >= 0 && h < 7) return "asian";
  if (h >= 7 && h < 12) return "london";
  if (h >= 12 && h < 16) return "overlap";
  if (h >= 16 && h < 21) return "newyork";
  return "off_hours";
}

function classifyAsset(name = "") {
  const n = name.toUpperCase();
  if (!n || n === "UNKNOWN") return "unknown";
  if (n.includes("OTC")) return "otc";  // detected only to be rejected — broker-generated, no public tape
  if (/(BTC|ETH|SOL|XRP|DOGE|ADA|BNB|LTC|CRYPTO)/.test(n)) return "crypto";
  if (/(XAU|GOLD|XAG|SILVER|OIL|BRENT|WTI|UKOIL|USOIL|NGAS)/.test(n)) return "commodity";
  if (/(VOLATILITY|CRASH|BOOM|STEP|JUMP|RANGE ?BREAK|VIX ?\d)/.test(n)) return "synthetic";
  if (/(AAPL|TSLA|MSFT|AMZN|META|GOOG|NVDA|INTC|NFLX|BA |MCD|PFE|SP ?500|S&P|NASDAQ|US ?30|US ?100|DOW|DAX|FTSE|NIKKEI|CAC)/.test(n)) return "stock_index";
  if (/^[A-Z]{3}\/?[A-Z]{3}/.test(n.replace(/\s/g, ""))) return "forex";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Live market data (Twelve Data) — metals trade plans                 */
/* ------------------------------------------------------------------ */

const LIVE_SYMBOLS = {
  XAUUSD: { td: "XAU/USD", label: "Gold", decimals: 2, auto: true, class: "commodity" },
  EURUSD: { td: "EUR/USD", label: "Euro / US Dollar", decimals: 5, auto: true, class: "forex" },
  // XAG/USD needs Twelve Data Grow plan — disabled in the auto-loop until upgraded.
  XAGUSD: { td: "XAG/USD", label: "Silver", decimals: 3, auto: false, class: "commodity" },
};

// Returns candles oldest-first: { t, o, h, l, c }
async function fetchCandles(env, tdSymbol, interval, size) {
  const url =
    "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(tdSymbol) +
    "&interval=" + interval + "&outputsize=" + size + "&apikey=" + env.TWELVE_DATA_KEY;
  const data = await (await fetch(url)).json();
  if (data.status === "error" || !data.values)
    throw new Error("Twelve Data: " + (data.message || "no candle data returned"));
  return data.values
    .map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
    .reverse();
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return sum / period;
}

function summarize(candles, n) {
  return candles
    .slice(-n)
    .map((c) => `[${c.o},${c.h},${c.l},${c.c}]`)
    .join("\n");
}

function livePrompt(symbol, session, c5, c15, atr5, ctx, newsToday) {
  const rb = RULEBOOKS[symbol.class] || RULEBOOKS.commodity;
  const nowIso = new Date().toISOString().slice(11, 19) + " GMT";
  const d = symbol.decimals;
  const levels = ctx
    ? `
KEY LEVELS (computed from real candles — treat as ground truth, do not re-derive):
- Day: ${ctx.dow}
- Asian range (00:00-07:00 UTC): ${ctx.asian ? `${ctx.asian.low.toFixed(d)} - ${ctx.asian.high.toFixed(d)} (width ${ctx.asian.width.toFixed(d)})` : "not formed yet today"}
- Current price vs Asian range: ${ctx.posVsAsian}
- Previous day high / low: ${ctx.pdh != null ? `${ctx.pdh.toFixed(d)} / ${ctx.pdl.toFixed(d)}` : "n/a"}`
    : "";
  const news = newsToday
    ? `\nTIER-1 EVENT TODAY (${newsToday}): expect volatility spikes around the release — demand stronger confluence before any lean away from 50.`
    : "";
  return `You are a disciplined ${symbol.label} (${symbol.td}) analyst producing a probability estimate for a short-horizon trade plan. You NEVER guess — 50 means coin flip and is a respected answer.

ASSET: ${symbol.label} — live ${symbol.td} feed
CURRENT SESSION: ${session} | TIME: ${nowIso}
ATR(14) on 5m: ${atr5.toFixed(symbol.decimals)}
${levels}${news}

LAST 30 x 5m CANDLES (oldest to newest, [open,high,low,close]):
${summarize(c5, 30)}

LAST 16 x 15m CANDLES (higher-timeframe context):
${summarize(c15, 16)}

RULEBOOK YOU MUST APPLY (no other strategies allowed):
${rb.rules}

Additional hard rules:
- prob_up is your honest probability (0-100) that price moves UP over the next 2-4 hours before moving equivalently down. 50 = no edge.
- A strong lean (>=65 or <=35) requires trend alignment on BOTH timeframes AND a level AND recent confirmation.
- Respect the session rules in the rulebook — Asian-session chops toward 50 unless the structure is exceptional.

Return ONLY a JSON object, no markdown fences, with exactly these keys:
{
 "prob_up": 0-100,
 "setup_type": "trend_continuation" | "sr_rejection" | "breakout_retest" | "mean_reversion" | "none",
 "reasoning": "3-5 sentences: which rules fired, what both timeframes agree on, what nearly disqualified it"
}`;
}

// Server computes the trade plan from real numbers — the model never invents levels.
function buildTradePlan(direction, entry, atr5, decimals) {
  if (direction === "NO_TRADE" || !atr5) return { entry_price: entry, sl: null, tp: null };
  const SL_MULT = 1.5, TP_MULT = 3.0; // 1:2 risk/reward (skill standard: min 1:1.5, ideal 1:2)
  const r = (x) => Number(x.toFixed(decimals));
  return direction === "LONG"
    ? { entry_price: r(entry), sl: r(entry - SL_MULT * atr5), tp: r(entry + TP_MULT * atr5) }
    : { entry_price: r(entry), sl: r(entry + SL_MULT * atr5), tp: r(entry - TP_MULT * atr5) };
}

/* ------------------------------------------------------------------ */
/* Market hours + Tier-1 news awareness                                */
/* ------------------------------------------------------------------ */

// Spot FX/metals week: opens Sunday 21:00 UTC, closes Friday 21:00 UTC.
function marketOpen(now = new Date()) {
  const d = now.getUTCDay(), h = now.getUTCHours();
  if (d === 6) return false; // Saturday
  if (d === 0 && h < 21) return false; // Sunday before open
  if (d === 5 && h >= 21) return false; // Friday after close
  return true;
}

// Tier-1 events (UTC). FOMC statement 14:00 ET, CPI/NFP 08:30 ET.
// H2 CPI dates are approximate — verify at bls.gov as they publish.
const NEWS_UTC = [
  ["FOMC", "2026-07-29 18:00"], ["FOMC", "2026-09-16 18:00"],
  ["FOMC", "2026-10-28 18:00"], ["FOMC", "2026-12-09 19:00"],
  ["CPI", "2026-08-12 12:30"], ["CPI", "2026-09-11 12:30"],
  ["CPI", "2026-10-13 12:30"], ["CPI", "2026-11-10 13:30"], ["CPI", "2026-12-10 13:30"],
];

// Returns { blackout: event name if within ±45 min (engines stand down),
//           today: event name if a Tier-1 event lands today (caution context) }.
function newsGuard(now = new Date()) {
  const ms = now.getTime();
  const events = NEWS_UTC.map(([name, s]) => ({ name, t: new Date(s.replace(" ", "T") + ":00Z").getTime() }));
  // NFP: first Friday of the month, 08:30 ET (use 13:00 UTC center for DST slack)
  if (now.getUTCDay() === 5 && now.getUTCDate() <= 7) {
    events.push({ name: "NFP", t: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 0) });
  }
  const todayStr = now.toISOString().slice(0, 10);
  let today = null;
  for (const e of events) {
    if (new Date(e.t).toISOString().slice(0, 10) === todayStr) today = today || e.name;
    if (Math.abs(ms - e.t) <= 45 * 60e3) return { blackout: e.name, today: today || e.name };
  }
  return { blackout: null, today };
}

/* ------------------------------------------------------------------ */
/* Layer 1: computed market context (ground truth for prompts)         */
/* ------------------------------------------------------------------ */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayContext(c5, now = new Date()) {
  const day = (d) => d.toISOString().slice(0, 10);
  const rows = c5.map((c) => ({ ...c, d: new Date(c.t.replace(" ", "T") + "Z") }));
  const today = day(now);
  const asian = rows.filter((r) => day(r.d) === today && r.d.getUTCHours() < 7);
  // Previous TRADING day (walk back up to 3 days — Monday needs Friday)
  let pd = [];
  for (let back = 1; back <= 3 && pd.length < 100; back++) {
    const ds = day(new Date(now.getTime() - back * 86400e3));
    pd = rows.filter((r) => day(r.d) === ds);
  }
  const last = rows[rows.length - 1];
  const ctx = { dow: DAYS[now.getUTCDay()], asian: null, pdh: null, pdl: null, posVsAsian: "n/a" };
  if (asian.length >= 10) {
    const high = Math.max(...asian.map((r) => r.h));
    const low = Math.min(...asian.map((r) => r.l));
    ctx.asian = { high, low, width: high - low };
    ctx.posVsAsian = last.c > high ? "above" : last.c < low ? "below" : "inside";
  }
  if (pd.length >= 100) {
    ctx.pdh = Math.max(...pd.map((r) => r.h));
    ctx.pdl = Math.min(...pd.map((r) => r.l));
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Layer 2: mechanical strategy engines (deterministic, LLM-free)      */
/* ------------------------------------------------------------------ */

// Gold: Asian Range Breakout — first 15m body close beyond the 00:00-07:00 UTC
// range, traded 07:00-12:00 UTC. Documented WR 55-65%, PF 1.3-1.6.
function detectAsianRangeBreakout(ctx, c15, now = new Date()) {
  const h = now.getUTCHours();
  if (h < 7 || h >= 12 || !ctx.asian) return null;
  if (now.getUTCDay() === 1) return null; // Mondays set the weekly range — skip
  const w = ctx.asian.width;
  if (w < 8 || w > 35) return null; // <$8 too quiet, >$35 already moved
  const today = now.toISOString().slice(0, 10);
  const breaks = c15
    .map((c) => ({ ...c, d: new Date(c.t.replace(" ", "T") + "Z") }))
    .filter(
      (c) =>
        c.t.startsWith(today) &&
        c.d.getUTCHours() >= 7 &&
        (c.c > ctx.asian.high || c.c < ctx.asian.low)
    );
  if (!breaks.length) return null;
  const first = breaks[0];
  if (now - first.d > 40 * 60e3) return null; // only a fresh first break is tradable
  const dir = first.c > ctx.asian.high ? "LONG" : "SHORT";
  return {
    direction: dir,
    entry: first.c,
    sl: dir === "LONG" ? ctx.asian.low : ctx.asian.high, // opposite range end
    tp: dir === "LONG" ? first.c + 1.5 * w : first.c - 1.5 * w, // 1.5x range width
    note: `first 15m body close ${dir === "LONG" ? "above" : "below"} Asian range ` +
      `${ctx.asian.low.toFixed(2)}-${ctx.asian.high.toFixed(2)} (width $${w.toFixed(2)})`,
  };
}

// EUR/USD: Overlap Momentum — first overlap hour (12:00-13:00 UTC) sets direction;
// trade it at 13:00 with SL beyond the hour's range. EUR/USD ranges ~70% of the
// time; momentum follow-through is only trusted inside the overlap.
function detectOverlapMomentum(c5, now = new Date()) {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins < 13 * 60 || mins > 13 * 60 + 35) return null; // signal window 13:00-13:35
  if (now.getUTCDay() === 5 && now.getUTCDate() <= 7) return null; // NFP first Friday
  const today = now.toISOString().slice(0, 10);
  const hour1 = c5
    .map((c) => ({ ...c, d: new Date(c.t.replace(" ", "T") + "Z") }))
    .filter((c) => c.t.startsWith(today) && c.d.getUTCHours() === 12);
  if (hour1.length < 10) return null; // need the full first hour
  const open = hour1[0].o, close = hour1[hour1.length - 1].c;
  const high = Math.max(...hour1.map((c) => c.h));
  const low = Math.min(...hour1.map((c) => c.l));
  const body = close - open, width = high - low;
  if (Math.abs(body) < 0.0015) return null; // <15 pip body = doji, no momentum
  if (width < 0.0008 || width > 0.0060) return null; // no range / already moved
  const dir = body > 0 ? "LONG" : "SHORT";
  const buf = 0.0002; // 2-pip buffer beyond the hour's extreme
  return {
    direction: dir,
    entry: close,
    sl: dir === "LONG" ? low - buf : high + buf,
    tp: dir === "LONG" ? close + 1.5 * width : close - 1.5 * width,
    note: `first overlap hour body ${(body * 10000).toFixed(0)} pips ${dir === "LONG" ? "up" : "down"}, ` +
      `range ${(width * 10000).toFixed(0)} pips`,
  };
}

/* ------------------------------------------------------------------ */
/* Shared persistence                                                  */
/* ------------------------------------------------------------------ */

async function persistLiveSignal(env, sym, session, signal, extra = {}, tf = "M5") {
  if (!env.DB) return null;
  const r = await env.DB.prepare(
    `INSERT INTO signals (asset, asset_class, session, chart_timeframe, direction, setup_type,
      entry_timing, expiry_minutes, prob_up, confidence, reasoning, chart_read, low_context,
      mode, entry_price, sl, tp)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      sym.td, sym.class, session, tf,
      signal.direction, signal.setup_type || "none",
      signal.entry_timing || "", signal.expiry_minutes || 1,
      signal.prob_up, signal.confidence, signal.reasoning || "",
      JSON.stringify(extra), 0, "live",
      signal.entry_price ?? null, signal.sl ?? null, signal.tp ?? null
    )
    .run();
  const id = r.meta.last_row_id;

  // Strategy arena: every actionable signal spawns shadow variants — same
  // entry and stop, different TP multiples. Silent (no Telegram), graded by
  // the same machinery, scored in /stats.arena. The geometry question
  // ("scalp 1R vs let it run 2.5R") gets answered by evidence.
  if (signal.direction !== "NO_TRADE" && signal.sl != null && signal.entry_price != null) {
    const risk = Math.abs(signal.entry_price - signal.sl);
    const mkShadow = (suffix, rr) => {
      const tp = signal.direction === "LONG"
        ? signal.entry_price + rr * risk
        : signal.entry_price - rr * risk;
      return env.DB.prepare(
        `INSERT INTO signals (asset, asset_class, session, chart_timeframe, direction, setup_type,
          entry_timing, expiry_minutes, prob_up, confidence, reasoning, chart_read, low_context,
          mode, entry_price, sl, tp, parent_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        sym.td, sym.class, session, tf,
        signal.direction, (signal.setup_type || "none") + ":" + suffix,
        "arena shadow", signal.expiry_minutes || 1,
        signal.prob_up, signal.confidence, `Arena shadow (${suffix}) of #${id}`,
        "{}", 0, "shadow",
        signal.entry_price, signal.sl, tp, id
      ).run();
    };
    await Promise.all([mkShadow("tp1r", 1.0), mkShadow("tp25r", 2.5)]);
  }
  return id;
}


// Layer 2 runner: mechanical engines, each in its documented UTC window.
// Deterministic — no LLM call, geometry straight from the strategy rules.
async function runEngines(env, now, news) {
  const today = now.toISOString().slice(0, 10);
  for (const key of Object.keys(LIVE_SYMBOLS)) {
    const sym = LIVE_SYMBOLS[key];
    if (!sym.auto) continue;
    const h = now.getUTCHours();
    const isGold = key === "XAUUSD", isEur = key === "EURUSD";
    if (!((isGold && h >= 7 && h < 12) || (isEur && h >= 12 && h < 16))) continue;
    // Overlap momentum is untradeable on Tier-1 days — the first hour IS the spike.
    if (isEur && news.today) continue;
    const setupType = isGold ? "asian_range_breakout" : "overlap_momentum";
    try {
      // One engine signal per asset per day, and never while a trade is open.
      const { results: dup } = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM signals WHERE mode='live' AND asset=? AND setup_type=? AND created_at >= ?`
      ).bind(sym.td, setupType, today + " 00:00:00").all();
      if (dup[0].n > 0) continue;
      const { results: open } = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM signals WHERE mode='live' AND asset=? AND outcome IS NULL AND direction != 'NO_TRADE'`
      ).bind(sym.td).all();
      if (open[0].n > 0) continue;

      const [c5, c15] = await Promise.all([
        fetchCandles(env, sym.td, "5min", 600),
        fetchCandles(env, sym.td, "15min", 96),
      ]);
      const ctx = dayContext(c5, now);
      const det = isGold ? detectAsianRangeBreakout(ctx, c15, now) : detectOverlapMomentum(c5, now);
      if (!det) continue;

      const session = currentSession(sym.class);
      const signal = {
        direction: det.direction,
        setup_type: setupType,
        prob_up: det.direction === "LONG" ? 62 : 38, // documented 55-65% WR band
        confidence: 62,
        expiry_minutes: 1,
        entry_timing: "market (live feed)",
        entry_price: Number(det.entry.toFixed(sym.decimals)),
        sl: Number(det.sl.toFixed(sym.decimals)),
        tp: Number(det.tp.toFixed(sym.decimals)),
        reasoning: `Mechanical ${setupType.replace(/_/g, " ")}: ${det.note}. ` +
          `SL/TP from range geometry per documented strategy rules.`,
      };
      await persistLiveSignal(env, sym, session, signal, { engine: setupType, asian: ctx.asian, pdh: ctx.pdh, pdl: ctx.pdl });
      await notifySignal(env, signalMessage({ asset: sym.td, session, ...signal }));
    } catch (e) {
      console.error("engine failed for " + key + ": " + (e.message || e));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Crypto confluence engine (deterministic, LLM-free)                  */
/* Ported from crypto-signal-engine: 4h bias + 1h location/trigger,    */
/* hard vetoes, six-pillar 0-100 score, Grade A >= 80 / B >= 65.       */
/* Data: Binance USDT-M futures public API (no key).                   */
/* ------------------------------------------------------------------ */

const CRYPTO = {
  TOP: 15,
  DEDUPE_HOURS: 6,
  FUNDING_VETO: 0.0005, // 0.05% / 8h
  OI_DROP_VETO: -3.0, // % over last 4h
  ATR_PCT_MIN: 0.0015,
  ATR_PCT_MAX: 0.025,
  GRADE_A: 80,
  GRADE_B: 65,
  BINANCE: "https://fapi.binance.com",
  BYBIT: "https://api.bybit.com",
  STABLE_BASES: new Set(["USDC", "TUSD", "FDUSD", "USDP", "DAI", "EUR", "GBP", "BUSD", "AEUR"]),
};

async function bnJson(path) {
  const res = await fetch(CRYPTO.BINANCE + path);
  if (!res.ok) throw new Error("Binance " + res.status + " for " + path);
  return res.json();
}

/* ---- Bybit v5 linear (fallback — Binance blocks CF egress IPs) ---- */

const BYBIT_INTERVAL = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

async function byJson(path) {
  const res = await fetch(CRYPTO.BYBIT + path);
  if (!res.ok) throw new Error("Bybit HTTP " + res.status + " for " + path);
  const d = await res.json();
  if (d.retCode !== 0) throw new Error("Bybit " + d.retCode + ": " + d.retMsg);
  return d.result;
}

async function byUniverse(top) {
  const r = await byJson("/v5/market/tickers?category=linear");
  return r.list
    .filter((d) => d.symbol.endsWith("USDT") && !CRYPTO.STABLE_BASES.has(d.symbol.slice(0, -4)))
    .map((d) => ({ symbol: d.symbol, qv: parseFloat(d.turnover24h) }))
    .sort((a, b) => b.qv - a.qv)
    .slice(0, top)
    .map((d) => d.symbol);
}

async function byKlines(symbol, interval, limit) {
  const r = await byJson(
    `/v5/market/kline?category=linear&symbol=${symbol}&interval=${BYBIT_INTERVAL[interval]}&limit=${limit}`
  );
  return r.list
    .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
    .reverse(); // bybit returns newest-first
}

async function byFunding(symbol) {
  const r = await byJson(`/v5/market/tickers?category=linear&symbol=${symbol}`);
  return parseFloat(r.list[0].fundingRate) || 0;
}

async function byOiPct(symbol) {
  const r = await byJson(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=48`);
  if (!r.list || r.list.length < 2) return null;
  const first = parseFloat(r.list[r.list.length - 1].openInterest);
  const last = parseFloat(r.list[0].openInterest);
  return first > 0 ? ((last - first) / first) * 100 : null;
}

/* ---- provider-fallback wrappers (skill design: Binance primary, Bybit fallback) ---- */

async function withFallback(bnFn, byFn) {
  try {
    return await bnFn();
  } catch {
    return byFn();
  }
}

async function cryptoUniverse(top) {
  return withFallback(
    async () => {
      const data = await bnJson("/fapi/v1/ticker/24hr");
      return data
        .filter((d) => d.symbol.endsWith("USDT") && !CRYPTO.STABLE_BASES.has(d.symbol.slice(0, -4)))
        .map((d) => ({ symbol: d.symbol, qv: parseFloat(d.quoteVolume) }))
        .sort((a, b) => b.qv - a.qv)
        .slice(0, top)
        .map((d) => d.symbol);
    },
    () => byUniverse(top)
  );
}

// Klines oldest-first with ms open time: { t, o, h, l, c, v }
async function bnKlines(symbol, interval, limit) {
  return withFallback(
    async () => {
      const data = await bnJson(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      return data.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    },
    () => byKlines(symbol, interval, limit)
  );
}

async function bnFunding(symbol) {
  return withFallback(
    async () => {
      const d = await bnJson(`/fapi/v1/premiumIndex?symbol=${symbol}`);
      return parseFloat(d.lastFundingRate) || 0;
    },
    () => byFunding(symbol)
  );
}

async function bnOiPct(symbol) {
  try {
    return await withFallback(
      async () => {
        const d = await bnJson(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=48`);
        if (!Array.isArray(d) || d.length < 2) return null;
        const first = parseFloat(d[0].sumOpenInterest);
        const last = parseFloat(d[d.length - 1].sumOpenInterest);
        return first > 0 ? ((last - first) / first) * 100 : null;
      },
      () => byOiPct(symbol)
    );
  } catch {
    return null; // OI endpoints blocked in some regions — degrade to neutral
  }
}

/* ---- indicators (pandas ewm parity: adjust=False, Wilder alpha=1/n) ---- */

function emaArr(vals, n) {
  const k = 2 / (n + 1);
  const out = new Array(vals.length).fill(null);
  let e = null;
  for (let i = 0; i < vals.length; i++) {
    e = e === null ? vals[i] : vals[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function wilderArr(vals, n) {
  const k = 1 / n;
  const out = new Array(vals.length).fill(null);
  let e = null;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === null || !Number.isFinite(vals[i])) continue;
    e = e === null ? vals[i] : vals[i] * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
  }
  return out;
}

function smaArr(vals, n) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function addIndicators(cs) {
  const close = cs.map((c) => c.c), high = cs.map((c) => c.h), low = cs.map((c) => c.l), vol = cs.map((c) => c.v);
  const ema20 = emaArr(close, 20), ema50 = emaArr(close, 50), ema200 = emaArr(close, 200);
  const delta = close.map((c, i) => (i ? c - close[i - 1] : 0));
  const gain = delta.map((d) => Math.max(d, 0)), loss = delta.map((d) => Math.max(-d, 0));
  const wGain = wilderArr(gain, 14), wLoss = wilderArr(loss, 14);
  const rsi = close.map((_, i) => {
    if (wGain[i] === null || wLoss[i] === null) return null;
    if (wLoss[i] === 0) return null;
    return 100 - 100 / (1 + wGain[i] / wLoss[i]);
  });
  const ema12 = emaArr(close, 12), ema26 = emaArr(close, 26);
  const macd = close.map((_, i) => ema12[i] - ema26[i]);
  const tr = close.map((_, i) =>
    i ? Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])) : high[i] - low[i]
  );
  const atr = wilderArr(tr, 14);
  const up = high.map((h, i) => (i ? h - high[i - 1] : 0));
  const down = low.map((l, i) => (i ? low[i - 1] - l : 0));
  const plusDM = up.map((u, i) => (u > down[i] && u > 0 ? u : 0));
  const minusDM = down.map((d, i) => (d > up[i] && d > 0 ? d : 0));
  const wPlus = wilderArr(plusDM, 14), wMinus = wilderArr(minusDM, 14);
  const plusDI = wPlus.map((w, i) => (w === null || !atr[i] ? null : (100 * w) / atr[i]));
  const minusDI = wMinus.map((w, i) => (w === null || !atr[i] ? null : (100 * w) / atr[i]));
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p === null || m === null || p + m === 0) return null;
    return (100 * Math.abs(p - m)) / (p + m);
  });
  const adx = wilderArr(dx, 14);
  const volSma = smaArr(vol, 20);
  return cs.map((c, i) => ({
    ...c,
    ema20: ema20[i], ema50: ema50[i], ema200: ema200[i],
    rsi: rsi[i], macd: macd[i], atr: atr[i], adx: adx[i], volSma20: volSma[i],
  }));
}

function dropUnclosed(cs, intervalMs) {
  if (cs.length && Date.now() - cs[cs.length - 1].t < intervalMs) return cs.slice(0, -1);
  return cs;
}

function swingLevels(cs, left = 2, right = 2) {
  const highs = [], lows = [];
  for (let i = left; i < cs.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (cs[j].h > cs[i].h) isHigh = false;
      if (cs[j].l < cs[i].l) isLow = false;
    }
    if (isHigh) highs.push(cs[i].h);
    if (isLow) lows.push(cs[i].l);
  }
  return { highs, lows };
}

/* ---- evaluation (faithful port of analyze.py evaluate_direction) ---- */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fin = Number.isFinite;

function evaluateDirection(data, direction, funding, oiPct) {
  const long = direction === "LONG";
  const d4 = data.d4, d1 = data.d1;
  const c4 = d4[d4.length - 1], c1 = d1[d1.length - 1];
  const price = c1.c, atr1 = c1.atr;
  if (!fin(atr1) || atr1 <= 0) return null;

  // hard veto: volatility regime
  const atrPct = atr1 / price;
  if (atrPct < CRYPTO.ATR_PCT_MIN || atrPct > CRYPTO.ATR_PCT_MAX) return null;

  // hard vetoes: derivatives
  if (long && funding > CRYPTO.FUNDING_VETO) return null;
  if (!long && funding < -CRYPTO.FUNDING_VETO) return null;
  const price4hAgo = d1.length >= 5 ? d1[d1.length - 5].c : d1[0].c;
  const priceChg4h = ((price - price4hAgo) / price4hAgo) * 100;
  if (oiPct !== null) {
    if (long && oiPct < CRYPTO.OI_DROP_VETO && priceChg4h > 0) return null;
    if (!long && oiPct < CRYPTO.OI_DROP_VETO && priceChg4h < 0) return null;
  }

  // bias (4h)
  const ema50_4 = c4.ema50, ema20_4 = c4.ema20, ema200_4 = c4.ema200, adx4 = c4.adx;
  const ema50Prev = d4.length >= 11 ? d4[d4.length - 11].ema50 : null;
  if (![ema50_4, ema20_4, adx4, ema50Prev].every(fin)) return null;
  const biasOk = long
    ? price > ema50_4 && ema50_4 > ema50Prev && adx4 >= 18
    : price < ema50_4 && ema50_4 < ema50Prev && adx4 >= 18;
  if (!biasOk) return null;

  // location (1h)
  const ema20_1 = c1.ema20, ema50_1 = c1.ema50, rsiNow = c1.rsi;
  if (![ema20_1, ema50_1, rsiNow].every(fin)) return null;
  const zoneLo = Math.min(ema20_1, ema50_1), zoneHi = Math.max(ema20_1, ema50_1);
  const pullback = long ? c1.l <= zoneHi && c1.c > ema50_1 : c1.h >= zoneLo && c1.c < ema50_1;

  // retest of a 1h swing level broken within the last 30 bars
  let retest = false;
  const look = d1.slice(Math.max(0, d1.length - 31), d1.length - 1);
  if (look.length >= 10) {
    if (long) {
      const lvl = look.length > 3 ? Math.max(...look.slice(0, -3).map((c) => c.h)) : null;
      if (fin(lvl) && lvl < price) {
        const broke = d1.slice(-30).some((c) => c.c > lvl);
        const cameBack = Math.abs(c1.l - lvl) <= 0.5 * atr1 || c1.l <= lvl;
        retest = broke && cameBack;
      }
    } else {
      const lvl = look.length > 3 ? Math.min(...look.slice(0, -3).map((c) => c.l)) : null;
      if (fin(lvl) && lvl > price) {
        const broke = d1.slice(-30).some((c) => c.c < lvl);
        const cameBack = Math.abs(c1.h - lvl) <= 0.5 * atr1 || c1.h >= lvl;
        retest = broke && cameBack;
      }
    }
  }

  const recentRsi = d1.slice(Math.max(0, d1.length - 7), d1.length - 1).map((c) => c.rsi);
  const rsiDip = long
    ? recentRsi.some((r) => fin(r) && r >= 40 && r <= 50) && rsiNow > 50
    : recentRsi.some((r) => fin(r) && r >= 50 && r <= 60) && rsiNow < 50;
  const locationZone = pullback || retest;
  if (!(locationZone && rsiDip)) return null;

  // trigger (1h last closed candle)
  const rng = c1.h - c1.l;
  const body = long ? c1.c - c1.o : c1.o - c1.c;
  const volMult = c1.volSma20 && fin(c1.volSma20) && c1.volSma20 > 0 ? c1.v / c1.volSma20 : 0;
  if (rng <= 0) return null;
  const closePos = long ? (c1.c - c1.l) / rng : (c1.h - c1.c) / rng;
  if (!(body > 0 && body >= 0.4 * atr1 && closePos >= 0.6 && volMult >= 1.5)) return null;

  // structure: SL / TP / headroom
  const swingRef = long
    ? Math.min(...d1.slice(-8).map((c) => c.l))
    : Math.max(...d1.slice(-8).map((c) => c.h));
  const sl = long ? swingRef - 0.5 * atr1 : swingRef + 0.5 * atr1;
  const risk = long ? price - sl : sl - price;
  if (risk <= 0) return null;

  const { highs: sh4, lows: sl4 } = swingLevels(d4);
  const opposing = long ? sh4.filter((x) => x > price) : sl4.filter((x) => x < price);
  const nearest = opposing.length
    ? long ? Math.min(...opposing) : Math.max(...opposing)
    : null;
  let headroomR;
  if (nearest !== null) {
    headroomR = long ? (nearest - price) / risk : (price - nearest) / risk;
    if (headroomR < 1.5) return null; // hard veto: no level room
  } else {
    headroomR = 3.0;
  }

  const tp1 = long ? price + 1.5 * risk : price - 1.5 * risk;
  let tp2Dist;
  if (nearest !== null) {
    tp2Dist = Math.min(Math.abs(nearest - price), 3.0 * risk);
    tp2Dist = Math.max(tp2Dist, 2.0 * risk);
  } else {
    tp2Dist = 3.0 * risk;
  }
  const tp2 = long ? price + tp2Dist : price - tp2Dist;
  const rr = Math.round((Math.abs(tp1 - price) / risk) * 100) / 100;

  // scoring (no veto fired)
  const tags = [];
  let align;
  if (long) {
    if (price > ema50_4 && ema20_4 > ema50_4 && fin(ema200_4) && ema50_4 > ema200_4) { align = 10; tags.push("4h full EMA alignment"); }
    else if (price > ema50_4 && ema20_4 > ema50_4) { align = 7; tags.push("4h uptrend"); }
    else { align = 4; tags.push("4h above EMA50"); }
  } else {
    if (price < ema50_4 && ema20_4 < ema50_4 && fin(ema200_4) && ema50_4 < ema200_4) { align = 10; tags.push("4h full EMA alignment (down)"); }
    else if (price < ema50_4 && ema20_4 < ema50_4) { align = 7; tags.push("4h downtrend"); }
    else { align = 4; tags.push("4h below EMA50"); }
  }
  const slopeRel = Math.abs(ema50_4 - ema50Prev) / ema50_4;
  const slopePts = Math.round(clamp(slopeRel / 0.01, 0, 1) * 8);
  const adxPts = Math.round(clamp((adx4 - 18) / 12, 0, 1) * 7);
  const biasPts = align + slopePts + adxPts;

  let locPts = 0;
  if (pullback) { locPts += 12; tags.push("EMA20-50 pullback"); }
  else if (retest) { locPts += 12; tags.push("broken-swing retest"); }
  if (rsiDip) { locPts += 8; tags.push(long ? "RSI reset 40-50" : "RSI reset 50-60"); }

  const candlePts = Math.round(
    clamp((body / atr1 - 0.4) / 0.6, 0, 1) * 5 + clamp((closePos - 0.6) / 0.3, 0, 1) * 5
  );
  const volPts = Math.round(clamp((volMult - 1.5) / 1.0, 0, 1) * 10);
  const trigPts = candlePts + volPts;
  tags.push("volume " + volMult.toFixed(1) + "x");

  const fundPts = (long && funding <= 0) || (!long && funding >= 0) ? 8 : 5;
  if (Math.abs(funding) <= CRYPTO.FUNDING_VETO) tags.push("funding neutral");
  let oiPts = 0;
  if (oiPct !== null) {
    if (oiPct > 0) { oiPts = 7; tags.push("OI rising " + oiPct.toFixed(1) + "%"); }
    else { oiPts = 3; tags.push("OI flat/" + oiPct.toFixed(1) + "%"); }
  }
  const derivPts = fundPts + oiPts;

  let volRegimePts;
  if (atrPct >= 0.003 && atrPct <= 0.012) volRegimePts = 10;
  else if (atrPct < 0.003) volRegimePts = Math.round(clamp((atrPct - CRYPTO.ATR_PCT_MIN) / 0.0015, 0, 1) * 10);
  else volRegimePts = Math.round(clamp((CRYPTO.ATR_PCT_MAX - atrPct) / (CRYPTO.ATR_PCT_MAX - 0.012), 0, 1) * 10);

  const levelPts = Math.round(clamp((headroomR - 1.5) / 1.0, 0, 1) * 10);
  tags.push(nearest !== null ? "headroom " + headroomR.toFixed(1) + "R to 4h level" : "no nearby 4h level");

  const score = biasPts + locPts + trigPts + derivPts + volRegimePts + levelPts;
  if (score < CRYPTO.GRADE_B) return null;
  const grade = score >= CRYPTO.GRADE_A ? "A" : "B";

  const fmt = (x) => (x >= 1 ? x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Number(x.toPrecision(6)).toString());
  const invalidation = long
    ? `1h close below ${fmt(sl)} or funding flips > +0.05%`
    : `1h close above ${fmt(sl)} or funding flips < -0.05%`;

  return {
    symbol: data.symbol, direction, grade, score,
    entry: price, sl, tp1, tp2, rr_to_tp1: rr,
    confluence_tags: tags, invalidation,
    funding_rate: funding,
    oi_change_4h_pct: oiPct !== null ? Math.round(oiPct * 1000) / 1000 : null,
  };
}

function cryptoEvaluate(data) {
  if (data.d4.length < 60 || data.d1.length < 60) return null;
  const results = (["LONG", "SHORT"])
    .map((dir) => evaluateDirection(data, dir, data.funding, data.oiPct))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return results[0] || null;
}

/* ---- scan orchestration ---- */

async function loadSymbolData(symbol) {
  const [d4raw, d1raw, funding, oiPct] = await Promise.all([
    bnKlines(symbol, "4h", 250),
    bnKlines(symbol, "1h", 250),
    bnFunding(symbol),
    bnOiPct(symbol),
  ]);
  return {
    symbol,
    d4: addIndicators(dropUnclosed(d4raw, 4 * 3600e3)),
    d1: addIndicators(dropUnclosed(d1raw, 3600e3)),
    funding,
    oiPct,
  };
}

function cryptoSignalMessage(s) {
  const icon = s.direction === "LONG" ? "🟢" : "🔴";
  const fmt = (x) => (x >= 1 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : Number(x.toPrecision(6)).toString());
  return [
    `${icon} <b>SIGNAL — ${s.symbol} ${s.direction} (Grade ${s.grade}, ${s.score}/100)</b>`,
    `Entry: ${fmt(s.entry)} | SL: ${fmt(s.sl)} | TP1: ${fmt(s.tp1)} | TP2: ${fmt(s.tp2)} | R:R ${s.rr_to_tp1}`,
    `Confluence: ${s.confluence_tags.join(" + ")}`,
    `<i>${s.invalidation}</i>`,
  ].join("\n");
}

// Scan the universe (or one symbol); persist + notify. Deterministic — no LLM.
async function cryptoScan(env, { symbol = null, notify = true } = {}) {
  const universe = symbol ? [symbol.toUpperCase()] : await cryptoUniverse(CRYPTO.TOP);
  const candidates = [];
  const errors = [];

  // 1. Evaluate everything concurrently
  const queue = [...universe];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const sym = queue.shift();
        try {
          const data = await loadSymbolData(sym);
          const sig = cryptoEvaluate(data);
          if (sig) candidates.push(sig);
        } catch (e) {
          errors.push(sym + ": " + (e.message || e));
        }
      }
    })
  );

  // 2. Correlation guard — BTC/ETH drive the alt complex. A same-direction
  // driver signal suppresses same-direction alts this scan (one bet, not eight).
  candidates.sort((a, b) => b.score - a.score);
  const DRIVERS = new Set(["BTCUSDT", "ETHUSDT"]);
  const driverDirs = new Set(candidates.filter((c) => DRIVERS.has(c.symbol)).map((c) => c.direction));
  const filtered = candidates.filter((c) => DRIVERS.has(c.symbol) || !driverDirs.has(c.direction));
  const suppressed = candidates.length - filtered.length;

  // 3. Cap concurrent same-direction crypto exposure at 3 (open + this scan)
  const { results: openRows } = await env.DB.prepare(
    `SELECT direction, COUNT(*) AS n FROM signals
     WHERE mode='live' AND asset_class='crypto' AND outcome IS NULL AND direction != 'NO_TRADE'
     GROUP BY direction`
  ).all();
  const openCount = { LONG: 0, SHORT: 0 };
  for (const r of openRows) openCount[r.direction] = r.n;

  const emitted = [];
  const since = new Date(Date.now() - CRYPTO.DEDUPE_HOURS * 3600e3).toISOString().slice(0, 19).replace("T", " ");

  for (const sig of filtered) {
    if (openCount[sig.direction] >= 3) continue;

    // dedupe: same symbol+direction within 6h
    const { results: dup } = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signals WHERE mode='live' AND asset=? AND direction=? AND created_at >= ?`
    ).bind(sig.symbol, sig.direction, since).all();
    if (dup[0].n > 0) continue;

    const signal = {
      direction: sig.direction,
      setup_type: "confluence_" + sig.grade.toLowerCase(),
      prob_up: sig.direction === "LONG" ? sig.score : 100 - sig.score,
      confidence: sig.score,
      expiry_minutes: 1,
      entry_timing: "market (live feed)",
      entry_price: sig.entry,
      sl: sig.sl,
      tp: sig.tp1, // graded against TP1; TP2 kept in chart_read
      reasoning: `Grade ${sig.grade} confluence (${sig.score}/100): ${sig.confluence_tags.join(" + ")}. ${sig.invalidation}`,
    };
    const id = await persistLiveSignal(
      env,
      { td: sig.symbol, class: "crypto" },
      "n/a",
      signal,
      { engine: "confluence", grade: sig.grade, score: sig.score, tp1: sig.tp1, tp2: sig.tp2, rr: sig.rr_to_tp1, funding: sig.funding_rate, oi_pct: sig.oi_change_4h_pct, tags: sig.confluence_tags },
      "H1"
    );
    emitted.push({ id, ...sig });
    openCount[sig.direction]++;
    if (notify && sig.grade === "A") await notifySignal(env, cryptoSignalMessage(sig));
  }
  if (emitted.length) await refreshPriceWatcher(env); // DO starts watching instantly
  return { scanned: universe.length, emitted, errors, suppressed };
}

/* ------------------------------------------------------------------ */
/* Backtest — replay deterministic engines over historical candles     */
/* No slippage/fees/funding in replay: results are an upper bound.     */
/* ------------------------------------------------------------------ */

function summarizeTrades(trades, note) {
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const breakevens = trades.length - wins - losses;
  const decided = wins + losses;
  return {
    trades: trades.length,
    wins, losses, breakevens,
    win_rate: decided ? Math.round((1000 * wins) / decided) / 10 : null,
    expectancy_r: trades.length
      ? Math.round(((wins * 1.5 - losses) / trades.length) * 100) / 100
      : null,
    profit_factor_r: losses ? Math.round(((wins * 1.5) / losses) * 100) / 100 : wins ? Infinity : null,
    by_grade: {
      A: trades.filter((t) => t.grade === "A").length,
      B: trades.filter((t) => t.grade === "B").length,
    },
    note,
    sample: trades.slice(-10),
  };
}

// Crypto confluence replay on one symbol, hourly evaluations, 1h-forward grading.
async function backtestConfluence(symbol, days) {
  const h1 = await bnKlines(symbol, "1h", Math.min(1000, days * 24 + 300));
  const h4 = await bnKlines(symbol, "4h", Math.min(1000, days * 6 + 300));
  const d1full = addIndicators(h1);
  const d4full = addIndicators(h4);
  const start = Math.max(300, d1full.length - days * 24);
  const trades = [];
  const nextAllowed = { LONG: 0, SHORT: 0 };
  let d4i = 0;

  for (let i = start; i < d1full.length - 1; i++) {
    const tClose = d1full[i].t + 3600e3;
    while (d4i < d4full.length - 1 && d4full[d4i + 1].t + 4 * 3600e3 <= tClose) d4i++;
    if (d4i < 60) continue;
    const data = { symbol, d4: d4full.slice(0, d4i + 1), d1: d1full.slice(0, i + 1), funding: 0, oiPct: null };
    for (const dir of ["LONG", "SHORT"]) {
      if (i < nextAllowed[dir]) continue;
      const sig = evaluateDirection(data, dir, 0, null);
      if (!sig) continue;
      let outcome = "breakeven";
      for (let j = i + 1; j <= Math.min(i + 4, d1full.length - 1); j++) {
        const c = d1full[j];
        const hitSL = dir === "LONG" ? c.l <= sig.sl : c.h >= sig.sl;
        const hitTP = dir === "LONG" ? c.h >= sig.tp1 : c.l <= sig.tp1;
        if (hitSL) { outcome = "loss"; break; }
        if (hitTP) { outcome = "win"; break; }
      }
      trades.push({ t: new Date(d1full[i].t).toISOString(), dir, grade: sig.grade, score: sig.score, outcome });
      nextAllowed[dir] = i + 6; // 6h dedupe, same as live
      break; // one direction per bar (live picks the best)
    }
  }
  return {
    engine: "confluence", asset: symbol, days,
    ...summarizeTrades(trades, "Replay with funding=0 and OI neutral (no history); no slippage/fees — upper bound."),
  };
}

// Gold Asian Range Breakout replay, day by day (mirrors the live detector,
// minus the live-only freshness gate). Graded on the day's 5m candles.
async function backtestArb(env, days) {
  const sym = LIVE_SYMBOLS.XAUUSD;
  const c5 = await fetchCandles(env, sym.td, "5min", Math.min(5000, days * 288 + 100));
  const c15 = await fetchCandles(env, sym.td, "15min", Math.min(5000, days * 96 + 100));
  const dates = [...new Set(c5.map((c) => c.t.slice(0, 10)))];
  const trades = [];

  for (const date of dates) {
    const noon = new Date(date + "T12:00:00Z");
    if (noon.getUTCDay() === 1) continue; // Mondays skipped, per strategy
    const ctx = dayContext(c5.filter((c) => c.t <= date + " 12:00:00"), noon);
    if (!ctx.asian || ctx.asian.width < 8 || ctx.asian.width > 35) continue;
    const dayC15 = c15.filter((c) => c.t.startsWith(date) && new Date(c.t.replace(" ", "T") + "Z").getUTCHours() >= 7);
    const brk = dayC15.find((c) => c.c > ctx.asian.high || c.c < ctx.asian.low);
    if (!brk) continue;
    const dir = brk.c > ctx.asian.high ? "LONG" : "SHORT";
    const entry = brk.c;
    const sl = dir === "LONG" ? ctx.asian.low : ctx.asian.high;
    const tp = dir === "LONG" ? entry + 1.5 * ctx.asian.width : entry - 1.5 * ctx.asian.width;
    const brkMs = new Date(brk.t.replace(" ", "T") + "Z").getTime();
    let outcome = "breakeven";
    for (const c of c5) {
      const tMs = new Date(c.t.replace(" ", "T") + "Z").getTime();
      if (tMs <= brkMs) continue;
      if (!c.t.startsWith(date) || new Date(c.t.replace(" ", "T") + "Z").getUTCHours() >= 16) break; // close-all 16:00
      const hitSL = dir === "LONG" ? c.l <= sl : c.h >= sl;
      const hitTP = dir === "LONG" ? c.h >= tp : c.l <= tp;
      if (hitSL) { outcome = "loss"; break; }
      if (hitTP) { outcome = "win"; break; }
    }
    trades.push({ t: date, dir, grade: "A", score: null, outcome });
  }
  return {
    engine: "asian_range_breakout", asset: sym.td, days,
    ...summarizeTrades(trades, "Replay; no slippage/spread — upper bound. Strategy close-all at 16:00 UTC honored."),
  };
}

// EUR/USD Overlap Momentum replay, day by day. Graded to 20:00 UTC hard exit.
async function backtestOm(env, days) {
  const sym = LIVE_SYMBOLS.EURUSD;
  const c5 = await fetchCandles(env, sym.td, "5min", Math.min(5000, days * 288 + 100));
  const dates = [...new Set(c5.map((c) => c.t.slice(0, 10)))];
  const trades = [];

  for (const date of dates) {
    const noon = new Date(date + "T12:00:00Z");
    if (noon.getUTCDay() === 5 && noon.getUTCDate() <= 7) continue; // NFP
    const hour1 = c5.filter((c) => c.t.startsWith(date) && new Date(c.t.replace(" ", "T") + "Z").getUTCHours() === 12);
    if (hour1.length < 10) continue;
    const open = hour1[0].o, close = hour1[hour1.length - 1].c;
    const high = Math.max(...hour1.map((c) => c.h)), low = Math.min(...hour1.map((c) => c.l));
    const body = close - open, width = high - low;
    if (Math.abs(body) < 0.0015 || width < 0.0008 || width > 0.0060) continue;
    const dir = body > 0 ? "LONG" : "SHORT";
    const buf = 0.0002;
    const sl = dir === "LONG" ? low - buf : high + buf;
    const tp = dir === "LONG" ? close + 1.5 * width : close - 1.5 * width;
    const entryMs = new Date(date + "T13:00:00Z").getTime();
    let outcome = "breakeven";
    for (const c of c5) {
      const tMs = new Date(c.t.replace(" ", "T") + "Z").getTime();
      if (tMs <= entryMs) continue;
      if (!c.t.startsWith(date) || new Date(c.t.replace(" ", "T") + "Z").getUTCHours() >= 20) break; // hard exit 20:00
      const hitSL = dir === "LONG" ? c.l <= sl : c.h >= sl;
      const hitTP = dir === "LONG" ? c.h >= tp : c.l <= tp;
      if (hitSL) { outcome = "loss"; break; }
      if (hitTP) { outcome = "win"; break; }
    }
    trades.push({ t: date, dir, grade: "A", score: null, outcome });
  }
  return {
    engine: "overlap_momentum", asset: sym.td, days,
    ...summarizeTrades(trades, "Replay; no slippage/spread — upper bound. Hard exit 20:00 UTC honored."),
  };
}

/* ------------------------------------------------------------------ */
/* Risk governor — self-preservation. Locks signal sends to PAPER when  */
/* the system is bleeding (4 consecutive losses or −5R in 7 days),      */
/* releases after +3R of paper recovery. Signals always keep generating */
/* and grading — only the "trade this" endorsement pauses.              */
/* ------------------------------------------------------------------ */

function tradeR(s) {
  const risk = Math.abs(s.entry_price - s.sl);
  if (!risk) return 0;
  if (s.outcome === "win") return Math.abs(s.tp - s.entry_price) / risk;
  if (s.outcome === "loss") return -1;
  return 0;
}

async function governorState(env) {
  if (!env.DB) return { locked: false, since: null };
  try {
    const { results } = await env.DB.prepare(`SELECT value FROM settings WHERE key='governor_lock'`).all();
    return { locked: Boolean(results[0]?.value), since: results[0]?.value || null };
  } catch {
    return { locked: false, since: null };
  }
}

// Signal sends route through here — lockout relabels them as paper.
async function notifySignal(env, text) {
  const g = await governorState(env);
  await notifyTelegram(env, g.locked ? "📄 <b>PAPER — drawdown lockout</b>\n" + text : text);
}

// Runs after each grading cycle. Engages, recovers, and reports.
async function updateGovernor(env) {
  if (!env.DB) return null;
  const { results: rows } = await env.DB.prepare(
    `SELECT outcome, entry_price, sl, tp, outcome_noted_at FROM signals
     WHERE mode='live' AND outcome IN ('win','loss','breakeven')
     ORDER BY id DESC LIMIT 100`
  ).all();

  let consec = 0;
  for (const r of rows) {
    if (r.outcome === "loss") consec++;
    else break;
  }
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 19).replace("T", " ");
  const weekR = rows
    .filter((r) => (r.outcome_noted_at || "") >= weekAgo)
    .reduce((a, r) => a + tradeR(r), 0);

  const state = await governorState(env);
  if (!state.locked && (consec >= 4 || weekR <= -5)) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('governor_lock', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).bind(new Date().toISOString()).run();
    await notifyTelegram(
      env,
      `🔒 <b>Risk governor engaged</b> — ${consec} consecutive losses, ${weekR.toFixed(1)}R over 7 days. ` +
      `Signals continue as PAPER until +3R recovery.`
    );
    return { locked: true, consec, weekR };
  }
  if (state.locked) {
    const since = state.since.slice(0, 19).replace("T", " ");
    const recoveryR = rows
      .filter((r) => (r.outcome_noted_at || "") >= since)
      .reduce((a, r) => a + tradeR(r), 0);
    if (recoveryR >= 3) {
      await env.DB.prepare(`DELETE FROM settings WHERE key='governor_lock'`).run();
      await notifyTelegram(
        env,
        `🔓 <b>Risk governor released</b> — +${recoveryR.toFixed(1)}R paper recovery. Live signals resumed.`
      );
      return { locked: false, consec, weekR, recoveryR };
    }
    return { locked: true, consec, weekR, recoveryR };
  }
  return { locked: false, consec, weekR };
}

// Daily 21:05 UTC digest: today's flow, grades, and running engine scoreboard.
async function dailyDigest(env) {
  if (!env.DB) return;
  const today = new Date().toISOString().slice(0, 10);
  const [sig, graded, engines] = await Promise.all([
    env.DB.prepare(
      `SELECT direction, COUNT(*) AS n FROM signals WHERE mode='live' AND created_at >= ? GROUP BY direction`
    ).bind(today + " 00:00:00").all(),
    env.DB.prepare(
      `SELECT outcome, COUNT(*) AS n FROM signals WHERE mode='live' AND outcome_noted_at >= ? GROUP BY outcome`
    ).bind(today + " 00:00:00").all(),
    env.DB.prepare(
      `SELECT setup_type, SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS w,
              SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) AS l
       FROM signals WHERE mode='live' AND outcome IN ('win','loss') GROUP BY setup_type ORDER BY (w+l) DESC`
    ).all(),
  ]);
  const count = (rows, key) => rows.results.find((r) => r.direction === key || r.outcome === key)?.n || 0;
  const lines = [
    `📊 <b>ChartSage daily — ${today}</b>`,
    `Signals today: ${sig.results.reduce((a, r) => a + r.n, 0)} ` +
      `(${count(sig.results, "LONG")} LONG · ${count(sig.results, "SHORT")} SHORT · ${count(sig.results, "NO_TRADE")} NO_TRADE)`,
    `Graded today: ✅ ${count(graded.results, "win")} · ❌ ${count(graded.results, "loss")} · ➖ ${count(graded.results, "breakeven")}`,
  ];
  if (engines.results.length) {
    lines.push("All-time by engine:");
    for (const e of engines.results) {
      const n = e.w + e.l;
      lines.push(`• ${(e.setup_type || "?").replace(/_/g, " ")}: ${e.w}/${n} (${Math.round((100 * e.w) / n)}%)`);
    }
  } else {
    lines.push("No graded outcomes yet — engines warming up.");
  }
  const tmr = newsGuard(new Date(Date.now() + 86400e3));
  if (tmr.today) lines.push(`⚠️ Tomorrow: ${tmr.today} — blackout windows apply`);
  await notifyTelegram(env, lines.join("\n"));
}

// Telegram channel notifications — fire-and-forget, never breaks a request.

async function notifyTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch { /* notification failure must not affect trading logic */ }
}

function signalMessage(s) {
  const icon = s.direction === "LONG" ? "🟢" : "🔴";
  const lines = [
    `${icon} <b>${s.direction} ${s.asset}</b> @ ${s.entry_price}`,
    `P(up): ${s.prob_up}% · lean ${s.confidence}/100`,
    `SL: ${s.sl} · TP: ${s.tp} (1:2 R:R)`,
    `Setup: ${s.setup_type} · Session: ${s.session}`,
    `<i>${(s.reasoning || "").slice(0, 400)}</i>`,
  ];
  return lines.join("\n");
}

function gradeMessage(s, outcome) {
  const icon = outcome === "win" ? "✅" : outcome === "loss" ? "❌" : "➖";
  const label = outcome.toUpperCase();
  const detail = outcome === "win" ? `hit TP ${s.tp}` : outcome === "loss" ? `hit SL ${s.sl}` : "time-stopped at 4h";
  return `${icon} <b>${label}</b> — ${s.direction} ${s.asset} @ ${s.entry_price} ${detail}`;
}

// Shared live-analysis core — used by the /analyze-live endpoint and the
// auto-analysis cron. Returns the full signal + trade plan object.
async function runLiveAnalysis(env, symKey) {
  const sym = LIVE_SYMBOLS[symKey];

  // 1. Real candles: 5m (~83h so Monday still sees Friday for PDH/PDL), 15m context
  const [c5, c15] = await Promise.all([
    fetchCandles(env, sym.td, "5min", 1000),
    fetchCandles(env, sym.td, "15min", 30),
  ]);
  const atr5 = atr(c5);
  if (!atr5) throw new Error("Not enough candle history for ATR");
  const ctx = dayContext(c5);
  const news = newsGuard();

  // 2. Probability estimate from the reasoning model over real numbers
  const session = currentSession(sym.class);
  const signal = await runJson(
    env,
    REASON_MODEL,
    {
      messages: [{ role: "user", content: livePrompt(sym, session, c5, c15, atr5, ctx, news.today) }],
      max_tokens: 1000,
    },
    { jsonMode: true }
  );
  finalizeSignal(signal, { edge: await getEdge(env) });

  // 3. Trade plan computed server-side from ATR (model never invents levels)
  const plan = buildTradePlan(signal.direction, c5[c5.length - 1].c, atr5, sym.decimals);
  signal.entry_timing = signal.direction === "NO_TRADE" ? "" : "market (live feed)";

  const id = await persistLiveSignal(env, sym, session, { ...signal, ...plan }, {
    atr5, last_close: plan.entry_price, candles_5m: c5.length,
    asian: ctx.asian, pdh: ctx.pdh, pdl: ctx.pdl,
  });

  return { id, asset: sym.td, asset_class: sym.class, session, ...signal, ...plan };
}

// Grading candles normalized to ms timestamps. Crypto (…USDT) grades from
// Binance 1m; everything else from Twelve Data 1m.
async function fetchGradingCandles(env, asset) {
  if (asset.endsWith("USDT")) {
    const cs = await bnKlines(asset, "1m", 240);
    return cs.map((c) => ({ tMs: c.t, h: c.h, l: c.l }));
  }
  const cs = await fetchCandles(env, asset, "1min", 240);
  return cs.map((c) => ({ tMs: new Date(c.t.replace(" ", "T") + "Z").getTime(), h: c.h, l: c.l }));
}

// Walk 1m candles since entry: first TP touch = win, first SL touch = loss
// (if both inside one candle, count it a loss — conservative). While walking,
// record max favorable/adverse excursion in R-multiples — this is what tells
// us whether SL/TP geometry is right, not just whether the call was right.
async function gradeOpenSignals(env) {
  if (!env.DB) return;
  const { results: open } = await env.DB.prepare(
    `SELECT id, asset, direction, entry_price, sl, tp, created_at, mode FROM signals
     WHERE mode IN ('live','shadow') AND outcome IS NULL AND direction != 'NO_TRADE' AND sl IS NOT NULL`
  ).all();

  const now = Date.now();
  let resolvedAny = false;
  for (const s of open) {
    const entryMs = new Date(s.created_at.replace(" ", "T") + "Z").getTime();
    const timedOut = now - entryMs > 4 * 3600e3;
    try {
      const candles = await fetchGradingCandles(env, s.asset);
      const risk = Math.abs(s.entry_price - s.sl);
      let mfe = 0, mae = 0, resolved = null;
      for (const c of candles) {
        if (c.tMs <= entryMs) continue;
        const fav = s.direction === "LONG" ? c.h - s.entry_price : s.entry_price - c.l;
        const adv = s.direction === "LONG" ? s.entry_price - c.l : c.h - s.entry_price;
        if (fav > mfe) mfe = fav;
        if (adv > mae) mae = adv;
        const hitSL = s.direction === "LONG" ? c.l <= s.sl : c.h >= s.sl;
        const hitTP = s.direction === "LONG" ? c.h >= s.tp : c.l <= s.tp;
        if (hitSL || hitTP) {
          resolved = hitSL ? "loss" : "win";
          break;
        }
      }
      if (!resolved && timedOut) resolved = "breakeven";
      if (resolved) {
        const mfe_r = risk > 0 ? Math.round((mfe / risk) * 1000) / 1000 : null;
        const mae_r = risk > 0 ? Math.round((mae / risk) * 1000) / 1000 : null;
        await env.DB.prepare(
          `UPDATE signals SET outcome=?, outcome_noted_at=datetime('now'), mfe_r=?, mae_r=? WHERE id=?`
        ).bind(resolved, mfe_r, mae_r, s.id).run();
        if (s.mode === "live") await notifyTelegram(env, gradeMessage(s, resolved)); // shadows grade silently
        resolvedAny = true;
      }
    } catch (e) {
      console.error("grading failed for #" + s.id + " " + s.asset + ": " + (e.message || e));
    }
  }
  // Every grade moves the R ledger — let the governor judge the system.
  if (resolvedAny) await updateGovernor(env);
}

/* ------------------------------------------------------------------ */
/* AI pipeline                                                         */
/* ------------------------------------------------------------------ */

const VISION_PROMPT = `Look at this trading-platform screenshot. Your ENTIRE response must be one JSON object: first character { and last character }. No prose, no markdown, no explanation before or after. Exactly these keys:
{
 "asset": "asset name as shown in the chart header, or 'unknown'",
 "timeframe": "candle timeframe shown, e.g. 'M1', 'M5', or 'unknown'",
 "trend": "one of: strong_uptrend, uptrend, range, downtrend, strong_downtrend, choppy",
 "recent_candles": "1-2 sentence description of the last 5-10 candles (size, wicks, direction)",
 "key_levels": "visible support/resistance zones or 'none clear'",
 "indicators": "any visible indicators and their state, or 'none'",
 "price_position": "where current price sits relative to the structure (e.g. 'at range high', 'mid-pullback in uptrend')",
 "readability": 0-100 how clearly the chart could be read
}`;

// Used when the vision model answers in prose despite the prompt —
// the reasoning model structures the description instead of failing the request.
const STRUCTURE_PROMPT = `Convert this trading-chart description into a JSON object with exactly these keys:
asset (string, 'unknown' if not stated), timeframe (string, 'unknown' if not stated),
trend (one of: strong_uptrend, uptrend, range, downtrend, strong_downtrend, choppy),
recent_candles (string), key_levels (string), indicators (string), price_position (string),
readability (number 0-100, infer from how specific the description is).
Infer conservatively; never invent an asset name. DESCRIPTION:
`;

function reasonPrompt(chartRead, assetClass, session, notes) {
  const rb = RULEBOOKS[assetClass] || RULEBOOKS.unknown;
  const nowIso = new Date().toISOString().slice(11, 19) + " GMT";
  return `You are a disciplined binary-options signal analyst. You NEVER guess. "NO_TRADE" is a respected, frequent answer — choppy, unclear, or rule-violating charts get NO_TRADE.

CHART READ (from vision engine):
${JSON.stringify(chartRead, null, 2)}

ASSET CLASS: ${assetClass} (${rb.label})
CURRENT SESSION: ${session}
CURRENT TIME: ${nowIso}
${notes ? `TRADER NOTES: ${notes}` : ""}

RULEBOOK YOU MUST APPLY (no other strategies allowed):
${rb.rules}

Additional hard rules:
- prob_up is your honest estimated probability (0-100) that the NEXT candle closes higher than it opens, given the chart read and rulebook. 50 = coin flip. Do not inflate it.
- If readability < 50 or trend is "choppy", set prob_up near 50 (no edge claimed).
- A strong lean (prob_up >= 65 or <= 35) requires trend alignment AND a level AND a confirmation candle all present in the chart read.
- expiry_minutes: 1 for M1 momentum entries, 2-3 for range-extreme fades, 5 for M5 charts.

Return ONLY a JSON object, no markdown fences, with exactly these keys:
{
 "prob_up": 0-100,
 "setup_type": "trend_continuation" | "sr_rejection" | "breakout_retest" | "mean_reversion" | "none",
 "expiry_minutes": number,
 "reasoning": "3-5 sentences: which rules fired, what the probability lean is, which nearly disqualified it"
}`;
}

function extractJson(text) {
  if (!text) throw new Error("Empty model response");
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1)
    throw new Error("No JSON object in model response: " + cleaned.slice(0, 300));
  // Take the first balanced {...} object — models sometimes append a second
  // object or trailing commentary; first-{ to last-} slicing breaks on those.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  // Model hit max_tokens mid-object: salvage by closing the open string/braces.
  const remainder = cleaned.slice(start);
  for (const suffix of ['"}', '"}}', "}", "}}", '"}]}', "]}"]) {
    try {
      return JSON.parse(remainder + suffix);
    } catch { /* try next */ }
  }
  throw new Error("Unbalanced JSON in model response: " + cleaned.slice(0, 300));
}

// Call a model expecting JSON back; retry once on parse failure.
// jsonMode uses Workers AI response_format where the model supports it.
async function runJson(env, model, payload, { jsonMode = false } = {}) {
  if (jsonMode) payload.response_format = { type: "json_object" };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await env.AI.run(model, payload);
      const raw = res.response ?? res.description ?? "";
      return extractJson(typeof raw === "string" ? raw : JSON.stringify(raw));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Entry timing is computed here, never by the model — LLMs are bad at clock math.
function nextCandleOpen(timeframe, now = new Date()) {
  const m = /^M(\d+)$/i.exec(timeframe || "");
  const h = /^H(\d+)$/i.exec(timeframe || "");
  let mins = m ? Number(m[1]) : h ? Number(h[1]) * 60 : 1;
  if (!Number.isFinite(mins) || mins < 1 || mins > 240) mins = 1;
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  const curMin = t.getUTCHours() * 60 + t.getUTCMinutes();
  const nextMin = (Math.floor(curMin / mins) + 1) * mins;
  t.setUTCHours(0, nextMin, 0, 0);
  return { time: t, mins };
}

async function analyze(env, imageBase64, notes) {
  // 1. Vision pass — this model's schema is prompt + image (no chat messages).
  //    Low temperature keeps it terse; if it still answers in prose, the
  //    reasoning model structures the description as a fallback.
  const bytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
  const visionRes = await env.AI.run(VISION_MODEL, {
    prompt: VISION_PROMPT,
    image: [...bytes],
    max_tokens: 700,
    temperature: 0.2,
  });
  const visionRaw = visionRes.response ?? visionRes.description ?? "";
  const visionText = typeof visionRaw === "string" ? visionRaw : JSON.stringify(visionRaw);

  let chartRead;
  try {
    chartRead = extractJson(visionText);
  } catch {
    chartRead = await runJson(
      env,
      REASON_MODEL,
      {
        messages: [{ role: "user", content: STRUCTURE_PROMPT + visionText.slice(0, 3000) }],
        max_tokens: 800,
      },
      { jsonMode: true }
    );
  }

  // 2. Classify + session
  const assetClass = classifyAsset(chartRead.asset);
  const session = currentSession(assetClass);

  // 3. Reasoning pass (JSON mode supported on llama-3.3-70b)
  const signal = await runJson(
    env,
    REASON_MODEL,
    {
      messages: [{ role: "user", content: reasonPrompt(chartRead, assetClass, session, notes) }],
      max_tokens: 1000,
    },
    { jsonMode: true }
  );

  // 4. Hard server-side guards (never trust the model alone)
  const readability = Number(chartRead.readability) || 0;
  let force = "";
  if (readability < 50) force = `Chart readability ${readability}/100 — below threshold. `;
  else if (chartRead.trend === "choppy" && Math.abs((Number(signal.prob_up) || 50) - 50) > 10)
    force = "Choppy trend — probability lean clamped to no-edge. ";
  finalizeSignal(signal, {
    forceNoTradeReason: force,
    capConfidence: assetClass === "unknown" ? 60 : 100,
    edge: await getEdge(env),
  });

  // 5. Entry timing computed server-side from the chart timeframe
  const tf = /^[MH]\d+$/i.test(chartRead.timeframe || "") ? chartRead.timeframe.toUpperCase() : "M1";
  const { time } = nextCandleOpen(tf);
  const hhmmss = time.toISOString().slice(11, 19);
  signal.entry_timing =
    signal.direction === "NO_TRADE" ? "" : `open of next ${tf} candle (${hhmmss} GMT)`;

  return { chartRead, assetClass, session, signal };
}

// Shared probability->direction derivation. Direction is DERIVED from the
// lean, never model-chosen. The edge threshold clears the ~55.6% breakeven
// at 80% payout with margin — and is auto-tuned by the calibration loop
// once enough graded outcomes exist (see calibrate()).
function finalizeSignal(signal, { forceNoTradeReason = "", capConfidence = 100, edge = 60 } = {}) {
  const probUp = Math.max(0, Math.min(100, Number(signal.prob_up) || 50));
  signal.prob_up = probUp;
  signal.direction = probUp >= edge ? "LONG" : probUp <= 100 - edge ? "SHORT" : "NO_TRADE";
  // Confidence = strength of the lean (50 = coin flip, 100 = maximal conviction).
  signal.confidence = Math.min(capConfidence, Math.round(Math.max(probUp, 100 - probUp)));
  if (forceNoTradeReason) {
    signal.direction = "NO_TRADE";
    signal.reasoning = forceNoTradeReason + (signal.reasoning || "");
  }
  signal.expiry_minutes = Math.max(1, Math.min(15, Number(signal.expiry_minutes) || 1));
  return signal;
}

// The calibration loop's tunable: current edge threshold (default 60).
async function getEdge(env) {
  if (!env.DB) return 60;
  try {
    const { results } = await env.DB.prepare(`SELECT value FROM settings WHERE key='edge_override'`).all();
    const v = Number(results[0]?.value);
    return Number.isFinite(v) && v >= 55 && v <= 75 ? v : 60;
  } catch {
    return 60;
  }
}

// Nightly calibration: bucket predicted lean vs realized outcomes, then
// retune the edge — but conservatively, and only on real data volume.
async function calibrate(env, payout = 80) {
  if (!env.DB) return;
  const breakeven = 100 / (1 + payout / 100);
  const { results: rows } = await env.DB.prepare(
    `SELECT confidence, SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS w,
            SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) AS l
     FROM signals
     WHERE mode='live' AND direction != 'NO_TRADE' AND outcome IN ('win','loss') AND confidence IS NOT NULL
     GROUP BY confidence`
  ).all();

  // Realized win rate per lean bucket (always fresh in /stats too)
  const buckets = { "50-59": [0, 0], "60-69": [0, 0], "70-79": [0, 0], "80+": [0, 0] };
  let total = 0;
  for (const r of rows) {
    const b = r.confidence < 60 ? "50-59" : r.confidence < 70 ? "60-69" : r.confidence < 80 ? "70-79" : "80+";
    buckets[b][0] += r.w;
    buckets[b][1] += r.l;
    total += r.w + r.l;
  }

  // Pick the lowest edge whose realized WR clears breakeven + 5 margin on n >= 20.
  let recommended = null;
  for (const edge of [55, 60, 65, 70]) {
    const n = rows.filter((r) => r.confidence >= edge).reduce((a, r) => a + r.w + r.l, 0);
    const w = rows.filter((r) => r.confidence >= edge).reduce((a, r) => a + r.w, 0);
    if (n >= 20 && (100 * w) / n >= breakeven + 5) {
      recommended = edge;
      break;
    }
  }

  const current = await getEdge(env);
  if (recommended !== null && recommended !== current && total >= 50) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('edge_override', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).bind(String(recommended)).run();
    await notifyTelegram(
      env,
      `🧠 <b>Calibration update</b> — edge threshold ${current} → ${recommended} ` +
      `(n=${total} graded; realized WR clears breakeven at this lean).`
    );
  }
  return { buckets, recommended, total };
}

/* ------------------------------------------------------------------ */
/* PriceWatcher Durable Object — real-time crypto grading.              */
/* Holds a WebSocket to Bybit's linear ticker stream and resolves TP/SL */
/* on the tick that touches them. The cron candle-walk remains as the   */
/* backstop (and the only grader for gold/EUR — Bybit is crypto-only).  */
/* Cost note: an always-on DO ≈ 330k GB-s/month, within the free 400k.  */
/* ------------------------------------------------------------------ */

export class PriceWatcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.signals = new Map(); // symbol -> Map(id -> tracked signal)
  }

  async fetch() {
    await this.refresh();
    return new Response("ok");
  }

  async refresh() {
    const { results } = await this.env.DB.prepare(
      `SELECT id, asset, direction, entry_price, sl, tp, mode FROM signals
       WHERE mode IN ('live','shadow') AND asset_class='crypto' AND outcome IS NULL
         AND direction != 'NO_TRADE' AND sl IS NOT NULL`
    ).all();
    const next = new Map();
    for (const s of results) {
      if (!next.has(s.asset)) next.set(s.asset, new Map());
      const prev = this.signals.get(s.asset)?.get(s.id);
      next.get(s.asset).set(s.id, {
        ...s,
        mfe: prev?.mfe || 0,
        mae: prev?.mae || 0,
        risk: Math.abs(s.entry_price - s.sl),
      });
    }
    this.signals = next;
    this.ensureSocket();
    if (!(await this.state.storage.getAlarm())) {
      await this.state.storage.setAlarm(Date.now() + 20000);
    }
  }

  ensureSocket() {
    if (this.ws && this.ws.readyState === 1) return;
    try { this.ws?.close(); } catch { /* already dead */ }
    const ws = new WebSocket("wss://stream.bybit.com/v5/public/linear");
    this.ws = ws;
    ws.addEventListener("open", () => {
      const symbols = [...this.signals.keys()];
      if (symbols.length) {
        ws.send(JSON.stringify({ op: "subscribe", args: symbols.map((s) => `tickers.${s}`) }));
      }
    });
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    const drop = () => { if (this.ws === ws) this.ws = null; };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }

  async onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const topic = msg.topic || "";
    if (!topic.startsWith("tickers.")) return;
    const sym = topic.slice(8);
    const price = parseFloat(msg.data?.lastPrice);
    if (!Number.isFinite(price)) return;
    const group = this.signals.get(sym);
    if (!group) return;
    for (const [id, s] of group) {
      const fav = s.direction === "LONG" ? price - s.entry_price : s.entry_price - price;
      if (fav > s.mfe) s.mfe = fav;
      if (-fav > s.mae) s.mae = -fav;
      const hitSL = s.direction === "LONG" ? price <= s.sl : price >= s.sl;
      const hitTP = s.direction === "LONG" ? price >= s.tp : price <= s.tp;
      if (hitSL || hitTP) {
        await this.resolve(sym, id, s, hitSL ? "loss" : "win");
      }
    }
  }

  async resolve(sym, id, s, outcome) {
    this.signals.get(sym)?.delete(id);
    if (this.signals.get(sym)?.size === 0) this.signals.delete(sym);
    const mfe_r = s.risk > 0 ? Math.round((s.mfe / s.risk) * 1000) / 1000 : null;
    const mae_r = s.risk > 0 ? Math.round((s.mae / s.risk) * 1000) / 1000 : null;
    // outcome IS NULL guard: if the cron walk got there first, stay silent
    const r = await this.env.DB.prepare(
      `UPDATE signals SET outcome=?, outcome_noted_at=datetime('now'), mfe_r=?, mae_r=?
       WHERE id=? AND outcome IS NULL`
    ).bind(outcome, mfe_r, mae_r, id).run();
    if (r.meta.changes > 0) {
      if (s.mode === "live") {
        await notifyTelegram(this.env, gradeMessage(s, outcome));
        await updateGovernor(this.env);
      }
    }
  }

  async alarm() {
    try {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ op: "ping" }));
      }
      await this.refresh();
    } catch (e) {
      console.error("PriceWatcher alarm: " + (e.message || e));
      this.ws = null; // force reconnect next refresh
    } finally {
      this.state.storage.setAlarm(Date.now() + 20000);
    }
  }
}

async function refreshPriceWatcher(env) {
  if (!env.PRICE_WATCHER) return;
  try {
    await env.PRICE_WATCHER.get(env.PRICE_WATCHER.idFromName("global")).fetch("https://do/refresh");
  } catch (e) {
    console.error("price watcher refresh: " + (e.message || e));
  }
}

// Compact data pack for the /ask analyst — the user's own ledger, no generics.
async function buildDataPack(env) {
  const [totals, bySetup, arena, excursion, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS signals,
              SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN outcome='breakeven' THEN 1 ELSE 0 END) AS breakevens
       FROM signals WHERE mode='live' AND direction != 'NO_TRADE'`
    ).all(),
    env.DB.prepare(
      `SELECT asset_class, setup_type,
              COUNT(*) AS n,
              SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS w,
              SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) AS l
       FROM signals WHERE mode='live' AND outcome IN ('win','loss')
       GROUP BY asset_class, setup_type ORDER BY n DESC LIMIT 12`
    ).all(),
    env.DB.prepare(
      `SELECT SUBSTR(setup_type, INSTR(setup_type, ':') + 1) AS variant,
              COUNT(*) AS n,
              SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS w,
              SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) AS l
       FROM signals WHERE mode='shadow' AND outcome IN ('win','loss') GROUP BY variant`
    ).all(),
    env.DB.prepare(
      `SELECT setup_type, ROUND(AVG(CASE WHEN outcome='loss' THEN mfe_r END), 2) AS mfe_loss,
              ROUND(AVG(CASE WHEN outcome='win' THEN mae_r END), 2) AS mae_win
       FROM signals WHERE mode='live' AND outcome IN ('win','loss') AND mfe_r IS NOT NULL
       GROUP BY setup_type`
    ).all(),
    env.DB.prepare(
      `SELECT id, created_at, asset, setup_type, direction, confidence, outcome
       FROM signals WHERE mode='live' ORDER BY id DESC LIMIT 8`
    ).all(),
  ]);
  return {
    totals: totals.results[0],
    win_loss_by_class_setup: bySetup.results,
    arena_variants: arena.results,
    excursion_r: excursion.results,
    governor: await governorState(env),
    edge_threshold: await getEdge(env),
    recent_signals: recent.results,
    note: "win rates need n>=30 to mean anything; R multiples: win=+RR, loss=-1R",
  };
}

/* ------------------------------------------------------------------ */
/* HTTP handlers                                                       */
/* ------------------------------------------------------------------ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const PROTECTED_PATHS = new Set(["/analyze", "/analyze-live", "/analyze-crypto", "/backtest", "/ask", "/outcome", "/signals", "/stats"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Shared-secret guard (set with: wrangler secret put API_KEY).
    // If API_KEY is not configured the worker runs open (local dev).
    if (PROTECTED_PATHS.has(url.pathname) && env.API_KEY) {
      if (request.headers.get("x-api-key") !== env.API_KEY) {
        return json({ error: "Unauthorized — send the x-api-key header" }, 401);
      }
    }

    try {
      if (url.pathname === "/analyze" && request.method === "POST") {
        const body = await request.json();
        if (!body.image) return json({ error: "Missing 'image' (base64, no data: prefix)" }, 400);

        const { chartRead, assetClass, session, signal } = await analyze(env, body.image, body.notes || "");

        // OTC feeds are broker-generated with no public tape — refuse them.
        if (assetClass === "otc")
          return json({
            error: "OTC pairs are broker-generated, not a market — ChartSage doesn't analyze them. " +
              "Use a real-feed chart (gold, forex, crypto) or the live Gold/Silver analyzer.",
          }, 400);

        let id = null;
        if (env.DB) {
          const r = await env.DB.prepare(
            `INSERT INTO signals (asset, asset_class, session, chart_timeframe, direction, setup_type,
              entry_timing, expiry_minutes, prob_up, confidence, reasoning, chart_read, low_context)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
            .bind(
              chartRead.asset || "unknown",
              assetClass,
              session,
              chartRead.timeframe || "unknown",
              signal.direction,
              signal.setup_type || "none",
              signal.entry_timing || "",
              signal.expiry_minutes,
              signal.prob_up,
              signal.confidence,
              signal.reasoning || "",
              JSON.stringify(chartRead),
              assetClass === "unknown" ? 1 : 0
            )
            .run();
          id = r.meta.last_row_id;
        }

        return json({ id, asset: chartRead.asset, asset_class: assetClass, session, chart_read: chartRead, ...signal });
      }

      if (url.pathname === "/analyze-live" && request.method === "POST") {
        if (!env.TWELVE_DATA_KEY)
          return json({ error: "Live feed not configured (TWELVE_DATA_KEY secret missing)" }, 503);
        if (!marketOpen())
          return json({ error: "Market is closed (spot FX/metals run Sun 21:00 – Fri 21:00 UTC)" }, 400);
        const { symbol } = await request.json();
        const key = String(symbol || "").toUpperCase();
        if (!LIVE_SYMBOLS[key])
          return json({ error: "symbol must be one of: " + Object.keys(LIVE_SYMBOLS).join(", ") }, 400);

        const result = await runLiveAnalysis(env, key);

        // Notify the channel on actionable signals only (NO_TRADE stays silent).
        if (result.direction !== "NO_TRADE") ctx.waitUntil(notifySignal(env, signalMessage(result)));

        return json(result);
      }

      if (url.pathname === "/analyze-crypto" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const result = await cryptoScan(env, { symbol: body.symbol || null, notify: true });
        return json(result);
      }

      if (url.pathname === "/backtest" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const engine = String(body.engine || "");
        const days = Math.min(30, Math.max(3, Number(body.days) || 14));
        if (engine === "confluence") {
          const symbol = String(body.symbol || "BTCUSDT").toUpperCase();
          if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return json({ error: "symbol must look like BTCUSDT" }, 400);
          return json(await backtestConfluence(symbol, days));
        }
        if (engine === "arb") {
          if (!env.TWELVE_DATA_KEY) return json({ error: "TWELVE_DATA_KEY not configured" }, 503);
          return json(await backtestArb(env, Math.min(days, 17))); // 5m fetch depth cap
        }
        if (engine === "om") {
          if (!env.TWELVE_DATA_KEY) return json({ error: "TWELVE_DATA_KEY not configured" }, 503);
          return json(await backtestOm(env, Math.min(days, 17)));
        }
        return json({ error: "engine must be one of: confluence | arb | om" }, 400);
      }

      if (url.pathname === "/ask" && request.method === "POST") {
        const { question } = await request.json().catch(() => ({}));
        if (!question || typeof question !== "string")
          return json({ error: "Missing 'question' (string)" }, 400);
        const pack = await buildDataPack(env);
        const res = await env.AI.run(REASON_MODEL, {
          messages: [
            {
              role: "user",
              content: `You are ChartSage's trading-data analyst. Answer ONLY from the JSON data below — the user's own logged signals, outcomes, and engine statistics. If the data is insufficient, say so plainly and state what would be needed. Be concise (under 150 words), concrete, and cite the actual numbers. Never invent figures.

DATA:
${JSON.stringify(pack, null, 1)}

QUESTION: ${question.slice(0, 500)}`,
            },
          ],
          max_tokens: 450,
        });
        return json({ answer: res.response || "" });
      }

      if (url.pathname === "/outcome" && request.method === "POST") {
        const { id, outcome } = await request.json();
        if (!id || !["win", "loss", "breakeven", "skipped"].includes(outcome))
          return json({ error: "Need id and outcome: win|loss|breakeven|skipped" }, 400);
        await env.DB.prepare(
          `UPDATE signals SET outcome = ?, outcome_noted_at = datetime('now') WHERE id = ?`
        ).bind(outcome, id).run();
        return json({ ok: true });
      }

      if (url.pathname === "/signals" && request.method === "GET") {
        const limit = Math.min(100, Number(url.searchParams.get("limit")) || 30);
        const { results } = await env.DB.prepare(
          `SELECT id, created_at, asset, asset_class, session, direction, setup_type,
                  expiry_minutes, confidence, outcome
           FROM signals ORDER BY id DESC LIMIT ?`
        ).bind(limit).all();
        return json(results);
      }

      if (url.pathname === "/stats" && request.method === "GET") {
        // Payout-adjusted breakeven: at p% payout you must win 100/(1+p/100)% to break even.
        const payout = Math.min(100, Math.max(50, Number(url.searchParams.get("payout")) || 80));
        const breakeven = 100 / (1 + payout / 100);

        const q = (groupCol) =>
          env.DB.prepare(
            `SELECT ${groupCol} AS bucket,
                    COUNT(*) AS signals,
                    SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) AS losses
             FROM signals
             WHERE direction != 'NO_TRADE' AND mode = 'live'
             GROUP BY ${groupCol} ORDER BY signals DESC`
          ).all();
        const arenaQ = env.DB.prepare(
          `SELECT SUBSTR(setup_type, INSTR(setup_type, ':') + 1) AS bucket,
                  COUNT(*) AS signals,
                  SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS wins,
                  SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) AS losses
           FROM signals
           WHERE mode = 'shadow' AND direction != 'NO_TRADE'
           GROUP BY bucket ORDER BY signals DESC`
        ).all();
        const confBucket = `CASE WHEN confidence < 60 THEN '<60' WHEN confidence < 75 THEN '60-74' ELSE '75+' END`;
        const [byClass, bySession, bySetup, byConfidence, excursion, arena] = await Promise.all([
          q("asset_class"),
          q("session"),
          q("setup_type"),
          q(confBucket),
          // Geometry diagnostics: are stops/targets placed well per strategy?
          env.DB.prepare(
            `SELECT setup_type AS bucket,
                    COUNT(*) AS resolved,
                    ROUND(AVG(CASE WHEN outcome='loss' THEN mfe_r END), 2) AS avg_mfe_before_loss,
                    ROUND(AVG(CASE WHEN outcome='win' THEN mae_r END), 2) AS avg_mae_before_win,
                    ROUND(AVG(CASE WHEN outcome='win' THEN mfe_r END), 2) AS avg_mfe_win
             FROM signals
             WHERE mode='live' AND outcome IN ('win','loss') AND mfe_r IS NOT NULL
             GROUP BY setup_type`
          ).all(),
          arenaQ,
        ]);
        const calibration = await env.DB.prepare(
          `SELECT CASE WHEN confidence < 60 THEN '50-59' WHEN confidence < 70 THEN '60-69'
                       WHEN confidence < 80 THEN '70-79' ELSE '80+' END AS bucket,
                  COUNT(*) AS n,
                  SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS w
           FROM signals
           WHERE mode='live' AND direction != 'NO_TRADE' AND outcome IN ('win','loss')
           GROUP BY bucket ORDER BY bucket`
        ).all();

        // Wilson 95% interval — honest uncertainty at small sample sizes.
        const wilson = (w, n, z = 1.96) => {
          const p = w / n, z2 = z * z, denom = 1 + z2 / n;
          const center = (p + z2 / (2 * n)) / denom;
          const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
          return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
        };
        const MIN_N = 30;
        const rate = (rows) =>
          rows.results.map((r) => {
            const n = r.wins + r.losses;
            if (n === 0) return { ...r, win_rate: null, ci_lo: null, ci_hi: null, reliable: false };
            const ci = wilson(r.wins, n);
            const wr = r.wins / n;
            return {
              ...r,
              win_rate: Math.round(100 * wr),
              ci_lo: Math.round(100 * ci.lo),
              ci_hi: Math.round(100 * ci.hi),
              reliable: n >= MIN_N,
              // Beats breakeven only if the CI lower bound clears it — conservative by design.
              beats_breakeven: ci.lo > breakeven,
            };
          });
        return json({
          payout_pct: payout,
          breakeven_win_rate: Math.round(10 * breakeven) / 10,
          min_sample: MIN_N,
          by_class: rate(byClass),
          by_session: rate(bySession),
          by_setup: rate(bySetup),
          by_confidence: rate(byConfidence),
          // Geometry read: high avg_mfe_before_loss = TP too far; high
          // avg_mae_before_win = SL too wide. >=10 resolved to mean anything.
          excursion: excursion.results,
          // Calibration: realized win rate per predicted-lean bucket.
          calibration: calibration.results.map((r) => ({
            bucket: r.bucket,
            resolved: r.n,
            realized_win_rate: r.n ? Math.round((1000 * r.w) / r.n) / 10 : null,
          })),
          edge: await getEdge(env),
          governor: await governorState(env),
          // Arena verdict: which TP multiple wins across all engines (R-adjusted:
          // tp1r scores 1R per win, tp25r 2.5R — expectancy is what matters).
          arena: rate(arena).map((r) => ({
            ...r,
            expectancy_r: r.wins + r.losses > 0
              ? Math.round(((r.wins * (r.bucket === "tp25r" ? 2.5 : 1.0) - r.losses) / r.signals) * 100) / 100
              : null,
          })),
        });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },

  // Cron (every 5 min): grade open signals; mechanical engines every 15 min
  // inside their windows; probabilistic auto-analysis at :00/:30 (07-21 UTC);
  // crypto confluence scan hourly at :00 (24/7 market, news blackout respected).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await gradeOpenSignals(env);
        await refreshPriceWatcher(env); // keep the real-time grader in sync

        const t = new Date(event.scheduledTime || Date.now());
        const h = t.getUTCHours(), m = t.getUTCMinutes();
        const news = newsGuard(t);

        // Crypto scan: hourly, 24/7, skipped only inside a Tier-1 release
        if (m < 5 && !news.blackout) {
          try {
            await cryptoScan(env, { notify: true });
          } catch (e) {
            console.error("crypto scan failed: " + (e.message || e));
          }
        }

        // Daily digest at 21:05 UTC
        if (h === 21 && m >= 5 && m < 10) {
          try {
            await dailyDigest(env);
          } catch (e) {
            console.error("digest failed: " + (e.message || e));
          }
        }

        // Nightly calibration at 22:05 UTC: retune the edge from graded data
        if (h === 22 && m >= 5 && m < 10) {
          try {
            await calibrate(env);
          } catch (e) {
            console.error("calibration failed: " + (e.message || e));
          }
        }

        if (!marketOpen(t)) return; // weekend / Friday close — no analysis on stale data
        if (h < 7 || h >= 21) return;

        if (m % 15 < 5 && !news.blackout) await runEngines(env, t, news);

        if (m % 30 >= 5 || news.blackout) return; // probabilistic analysis at :00/:30, never inside a release
        for (const key of Object.keys(LIVE_SYMBOLS)) {
          if (!LIVE_SYMBOLS[key].auto) continue; // e.g. XAG/USD needs a paid Twelve Data plan
          try {
            // One open trade per asset — no fresh signal while one is unresolved.
            const { results } = await env.DB.prepare(
              `SELECT COUNT(*) AS n FROM signals
               WHERE mode = 'live' AND asset = ? AND outcome IS NULL AND direction != 'NO_TRADE'`
            ).bind(LIVE_SYMBOLS[key].td).all();
            if (results[0].n > 0) continue;

            const r = await runLiveAnalysis(env, key);
            if (r.direction !== "NO_TRADE") await notifySignal(env, signalMessage(r));
          } catch (e) {
            console.error("auto-analyze failed for " + key + ": " + (e.message || e));
          }
        }
      })()
    );
  },
};

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChartSage — live feed in, signal out</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#0d1117; --panel:#151b23; --panel2:#1b232e; --line:#2a3441;
  --text:#e8edf3; --dim:#8a97a6;
  --gold:#e3b341; --long:#2ea06b; --short:#d5544a; --flat:#5b6774;
  --kente:repeating-linear-gradient(90deg,#e3b341 0 14px,#0d1117 14px 18px,#2ea06b 18px 30px,#0d1117 30px 34px,#d5544a 34px 46px,#0d1117 46px 50px);
}
*{box-sizing:border-box;margin:0}
body{background:var(--ink);color:var(--text);font-family:'Space Grotesk',sans-serif;min-height:100vh}
.mono{font-family:'IBM Plex Mono',monospace}
header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
header h1{font-size:20px;font-weight:700;letter-spacing:.5px}
header h1 span{color:var(--gold)}
header p{color:var(--dim);font-size:13px}
.wrap{max-width:920px;margin:0 auto;padding:24px 16px;display:grid;gap:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.card .body{padding:18px}
.kente{height:5px;background:var(--kente)}
button{font-family:inherit;font-weight:500;border:none;border-radius:6px;cursor:pointer;font-size:14px}
.liverow{display:flex;gap:10px;flex-wrap:wrap}
.live{flex:1;min-width:180px;padding:12px;background:var(--panel2);border:1px solid var(--line);color:var(--text);font-weight:600}
.live:hover{border-color:var(--gold)}
.live:disabled{opacity:.5;cursor:wait}
.sig-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid var(--line)}
.dir{font-size:26px;font-weight:700;letter-spacing:1px}
.dir.LONG{color:var(--long)} .dir.SHORT{color:var(--short)} .dir.NO_TRADE{color:var(--flat)}
.conf{font-size:13px;color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line)}
.cell{background:var(--panel);padding:12px 14px}
.cell .k{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim)}
.cell .v{font-size:14px;margin-top:4px}
.reason{padding:14px 18px;font-size:13.5px;line-height:1.55;color:#c4cdd8;border-top:1px solid var(--line)}
.err{color:var(--short);font-size:13px;padding:8px 0;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500;text-transform:uppercase;font-size:10.5px;letter-spacing:.7px}
.tag{padding:2px 7px;border-radius:4px;font-size:11px}
.tag.LONG{background:#173527;color:var(--long)}.tag.SHORT{background:#3a1f1c;color:var(--short)}.tag.NO_TRADE{background:#222a33;color:var(--flat)}
.notice{font-size:12px;color:var(--dim);line-height:1.5;padding:0 4px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);padding:0 4px}
#stats .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;padding:14px}
</style>
</head>
<body>
<header>
  <h1>Chart<span>Sage</span></h1>
  <p class="mono">live feed in · signal out · every call graded</p>
</header>

<div class="wrap">
  <div class="card"><div class="kente"></div><div class="body">
    <div class="liverow">
      <button class="live" data-sym="XAUUSD">Gold (XAU/USD) — live analysis</button>
      <button class="live" data-sym="EURUSD">EUR/USD — live analysis</button>
      <button class="live" id="crypto-btn">Crypto top-15 — confluence scan</button>
    </div>
    <div class="err" id="live-err"></div>
  </div></div>

  <div id="result"></div>

  <h2>Recent signals</h2>
  <div class="card"><div class="body" style="padding:0;overflow-x:auto">
    <table id="log"><thead><tr><th>#</th><th>Time (UTC)</th><th>Asset</th><th>Class</th><th>Dir</th><th>Conf</th><th>Outcome</th></tr></thead><tbody></tbody></table>
  </div></div>

  <h2>Performance</h2>
  <div class="card" id="stats"><div class="cols"></div></div>
  <p class="notice" id="stats-note"></p>

  <p class="notice">ChartSage reads structure — it does not see the future. Short-expiry outcomes are noise-dominated; treat every signal as a hypothesis and let the logged win rates be the judge. Demo account until the data earns otherwise.</p>
</div>

<script>
const $ = (s) => document.querySelector(s);

// API key stored locally; prompted for on first 401.
let apiKey = localStorage.getItem("cs_key") || "";
async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), "x-api-key": apiKey };
  let res = await fetch(path, opts);
  if (res.status === 401) {
    apiKey = prompt("ChartSage API key:") || "";
    localStorage.setItem("cs_key", apiKey);
    opts.headers["x-api-key"] = apiKey;
    res = await fetch(path, opts);
  }
  return res;
}

// Live analysis — the worker pulls real candles, no upload needed.
document.querySelectorAll(".live").forEach((btn) => (btn.onclick = async () => {
  const liveErr = $("#live-err");
  const label = btn.textContent;
  document.querySelectorAll(".live").forEach((b) => (b.disabled = true));
  btn.textContent = "Analyzing live feed…"; liveErr.textContent = "";
  try {
    const res = await api("/analyze-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: btn.dataset.sym })
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    lastId = d.id;
    renderLive(d);
    loadLog(); loadStats();
  } catch (ex) { liveErr.textContent = ex.message; }
  document.querySelectorAll(".live").forEach((b) => (b.disabled = false));
  btn.textContent = label;
}));

function renderLive(d){
  const dirWord = d.direction === "LONG" ? "▲ LONG" : d.direction === "SHORT" ? "▼ SHORT" : "— NO TRADE";
  $("#result").innerHTML = \`
  <div class="card"><div class="kente"></div>
    <div class="sig-head">
      <div class="dir \${d.direction}">\${dirWord}</div>
      <div class="conf mono">P(up) \${d.prob_up}% · lean \${d.confidence}/100</div>
    </div>
    <div class="grid">
      <div class="cell"><div class="k">Asset</div><div class="v">\${d.asset}</div></div>
      <div class="cell"><div class="k">Session</div><div class="v">\${d.session}</div></div>
      <div class="cell"><div class="k">Setup</div><div class="v">\${d.setup_type || "—"}</div></div>
      <div class="cell"><div class="k">Entry</div><div class="v mono">\${d.entry_price ?? "—"}</div></div>
      <div class="cell"><div class="k">Stop-loss</div><div class="v mono">\${d.sl ?? "—"}</div></div>
      <div class="cell"><div class="k">Take-profit</div><div class="v mono">\${d.tp ?? "—"}</div></div>
      <div class="cell"><div class="k">R : R</div><div class="v mono">\${d.sl && d.tp ? "1 : 2" : "—"}</div></div>
    </div>
    <div class="reason">\${d.reasoning || ""}</div>
    \${d.direction !== "NO_TRADE" ? \`<div class="reason" style="border-top:none;color:var(--dim)">Outcome auto-grades from the live feed when TP or SL is hit — checked every 5 min, 4h time-stop to breakeven.</div>\` : ""}
  </div>\`;
}

// Crypto confluence scan — deterministic six-pillar engine over the top-15 universe.
$("#crypto-btn").onclick = async (e) => {
  const btn = e.currentTarget, liveErr = $("#live-err");
  const label = btn.textContent;
  document.querySelectorAll(".live").forEach((b) => (b.disabled = true));
  btn.textContent = "Scanning top-15…"; liveErr.textContent = "";
  try {
    const res = await api("/analyze-crypto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    renderCrypto(d);
    loadLog(); loadStats();
  } catch (ex) { liveErr.textContent = ex.message; }
  document.querySelectorAll(".live").forEach((b) => (b.disabled = false));
  btn.textContent = label;
};

function renderCrypto(d){
  const fmt = (x) => (x >= 1 ? Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 }) : Number(x).toPrecision(6));
  let html = '<div class="card"><div class="kente"></div><div class="sig-head"><div class="dir">CRYPTO SCAN</div>' +
    '<div class="conf mono">' + d.scanned + " scanned · " + d.emitted.length + " emitted</div></div>";
  if (!d.emitted.length) {
    html += '<div class="reason">No A/B-grade confluence setups this scan — the six-pillar stack stayed silent. That is the filter working, not a bug.</div>';
  }
  for (const s of d.emitted) {
    html += '<div class="reason" style="border-top:1px solid var(--line)">' +
      '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">' +
      '<span class="dir ' + s.direction + '" style="font-size:16px">' + s.symbol + " " + s.direction + "</span>" +
      '<span class="mono" style="color:var(--gold)">Grade ' + s.grade + " · " + s.score + "/100</span></div>" +
      '<div class="mono" style="margin-top:6px;color:#c4cdd8">Entry ' + fmt(s.entry) + " · SL " + fmt(s.sl) + " · TP1 " + fmt(s.tp1) + " · TP2 " + fmt(s.tp2) + " · R:R " + s.rr_to_tp1 + "</div>" +
      '<div style="margin-top:4px">' + s.confluence_tags.join(" + ") + "</div>" +
      '<div style="margin-top:4px;color:var(--dim)">' + s.invalidation + "</div></div>";
  }
  $("#result").innerHTML = html + "</div>";
}

async function loadLog(){
  const rows = await (await api("/signals?limit=25")).json();
  if (rows.error) return;
  $("#log tbody").innerHTML = rows.map(r => \`<tr class="mono">
    <td>\${r.id}</td><td>\${(r.created_at||"").slice(5,16)}</td><td>\${r.asset||"?"}</td>
    <td>\${r.asset_class}</td><td><span class="tag \${r.direction}">\${r.direction}</span></td>
    <td>\${r.confidence}</td><td>\${r.outcome || "…"}</td></tr>\`).join("");
}

async function loadStats(){
  const s = await (await api("/stats")).json();
  if (s.error) return;
  const row = (r) => {
    const dim = r.reliable ? "" : " style='opacity:.45'";
    const ci = r.ci_lo != null ? " [" + r.ci_lo + "–" + r.ci_hi + "]" : "";
    const edge = r.beats_breakeven ? " ▲" : "";
    return "<tr class='mono'" + dim + "><td>" + (r.bucket||"?") + "</td><td>" + r.signals +
      "</td><td>" + r.wins + "/" + r.losses + "</td><td>" + (r.win_rate ?? "—") + ci + edge + "</td></tr>";
  };
  const block = (title, rows) => \`<div><table><thead><tr><th>\${title}</th><th>N</th><th>W/L</th><th>Win% [95% CI]</th></tr></thead><tbody>
    \${rows.map(row).join("")}
  </tbody></table></div>\`;
  $("#stats .cols").innerHTML = block("Asset class", s.by_class) + block("Session", s.by_session) +
    block("Setup", s.by_setup) + block("Confidence", s.by_confidence);
  $("#stats-note").textContent = "Breakeven at " + s.payout_pct + "% payout = " + s.breakeven_win_rate +
    "% win rate. ▲ = 95% CI clears breakeven. Dimmed rows have < " + s.min_sample + " resolved outcomes — noise, not signal.";
  if (s.excursion && s.excursion.length) {
    $("#stats-note").textContent += " Geometry (R): " + s.excursion.map((e) =>
      (e.bucket || "?").replace(/_/g, " ") + " — MFE→loss " + (e.avg_mfe_before_loss ?? "—") +
      ", MAE→win " + (e.avg_mae_before_win ?? "—")
    ).join(" · ") + ". High MFE→loss = TP too far; high MAE→win = SL too wide.";
  }
}

loadLog(); loadStats();
</script>
</body>
</html>`;
