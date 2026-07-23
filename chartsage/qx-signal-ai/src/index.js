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

function livePrompt(symbol, session, c5, c15, atr5) {
  const rb = RULEBOOKS[symbol.class] || RULEBOOKS.commodity;
  const nowIso = new Date().toISOString().slice(11, 19) + " GMT";
  return `You are a disciplined ${symbol.label} (${symbol.td}) analyst producing a probability estimate for a short-horizon trade plan. You NEVER guess — 50 means coin flip and is a respected answer.

ASSET: ${symbol.label} — live ${symbol.td} feed
CURRENT SESSION: ${session} | TIME: ${nowIso}
ATR(14) on 5m: ${atr5.toFixed(symbol.decimals)}

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

  // 1. Real candles: 5m for setup, 15m for higher-timeframe context
  const [c5, c15] = await Promise.all([
    fetchCandles(env, sym.td, "5min", 60),
    fetchCandles(env, sym.td, "15min", 30),
  ]);
  const atr5 = atr(c5);
  if (!atr5) throw new Error("Not enough candle history for ATR");

  // 2. Probability estimate from the reasoning model over real numbers
  const session = currentSession(sym.class);
  const signal = await runJson(
    env,
    REASON_MODEL,
    {
      messages: [{ role: "user", content: livePrompt(sym, session, c5, c15, atr5) }],
      max_tokens: 1000,
    },
    { jsonMode: true }
  );
  finalizeSignal(signal);

  // 3. Trade plan computed server-side from ATR (model never invents levels)
  const plan = buildTradePlan(signal.direction, c5[c5.length - 1].c, atr5, sym.decimals);
  signal.entry_timing = signal.direction === "NO_TRADE" ? "" : "market (live feed)";

  let id = null;
  if (env.DB) {
    const r = await env.DB.prepare(
      `INSERT INTO signals (asset, asset_class, session, chart_timeframe, direction, setup_type,
        entry_timing, expiry_minutes, prob_up, confidence, reasoning, chart_read, low_context,
        mode, entry_price, sl, tp)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        sym.td, sym.class, session, "M5",
        signal.direction, signal.setup_type || "none",
        signal.entry_timing, signal.expiry_minutes,
        signal.prob_up, signal.confidence, signal.reasoning || "",
        JSON.stringify({ atr5, last_close: plan.entry_price, candles_5m: c5.length }),
        0, "live", plan.entry_price, plan.sl, plan.tp
      )
      .run();
    id = r.meta.last_row_id;
  }

  return { id, asset: sym.td, asset_class: sym.class, session, ...signal, ...plan };
}

// Walk 1m candles since entry: first TP touch = win, first SL touch = loss
// (if both inside one candle, count it a loss — conservative).
async function gradeOpenSignals(env) {
  if (!env.TWELVE_DATA_KEY || !env.DB) return;
  const { results: open } = await env.DB.prepare(
    `SELECT id, asset, direction, entry_price, sl, tp, created_at FROM signals
     WHERE mode = 'live' AND outcome IS NULL AND direction != 'NO_TRADE' AND sl IS NOT NULL`
  ).all();

  const now = Date.now();
  for (const s of open) {
    const entryMs = new Date(s.created_at.replace(" ", "T") + "Z").getTime();
    if (now - entryMs > 4 * 3600e3) {
      await env.DB.prepare(`UPDATE signals SET outcome='breakeven', outcome_noted_at=datetime('now') WHERE id=?`)
        .bind(s.id).run();
      await notifyTelegram(env, gradeMessage(s, "breakeven"));
      continue;
    }
    const candles = await fetchCandles(env, s.asset, "1min", 240);
    for (const c of candles) {
      if (new Date(c.t.replace(" ", "T") + "Z").getTime() <= entryMs) continue;
      const hitSL = s.direction === "LONG" ? c.l <= s.sl : c.h >= s.sl;
      const hitTP = s.direction === "LONG" ? c.h >= s.tp : c.l <= s.tp;
      if (hitSL || hitTP) {
        const outcome = hitSL ? "loss" : "win";
        await env.DB.prepare(`UPDATE signals SET outcome=?, outcome_noted_at=datetime('now') WHERE id=?`)
          .bind(outcome, s.id).run();
        await notifyTelegram(env, gradeMessage(s, outcome));
        break;
      }
    }
  }
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
// lean, never model-chosen. 60% threshold clears the ~55.6% breakeven at
// 80% payout with margin for estimation error.
function finalizeSignal(signal, { forceNoTradeReason = "", capConfidence = 100 } = {}) {
  const probUp = Math.max(0, Math.min(100, Number(signal.prob_up) || 50));
  signal.prob_up = probUp;
  const EDGE = 60;
  signal.direction = probUp >= EDGE ? "LONG" : probUp <= 100 - EDGE ? "SHORT" : "NO_TRADE";
  // Confidence = strength of the lean (50 = coin flip, 100 = maximal conviction).
  signal.confidence = Math.min(capConfidence, Math.round(Math.max(probUp, 100 - probUp)));
  if (forceNoTradeReason) {
    signal.direction = "NO_TRADE";
    signal.reasoning = forceNoTradeReason + (signal.reasoning || "");
  }
  signal.expiry_minutes = Math.max(1, Math.min(15, Number(signal.expiry_minutes) || 1));
  return signal;
}

/* ------------------------------------------------------------------ */
/* HTTP handlers                                                       */
/* ------------------------------------------------------------------ */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const PROTECTED_PATHS = new Set(["/analyze", "/analyze-live", "/outcome", "/signals", "/stats"]);

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
        const { symbol } = await request.json();
        const key = String(symbol || "").toUpperCase();
        if (!LIVE_SYMBOLS[key])
          return json({ error: "symbol must be one of: " + Object.keys(LIVE_SYMBOLS).join(", ") }, 400);

        const result = await runLiveAnalysis(env, key);

        // Notify the channel on actionable signals only (NO_TRADE stays silent).
        if (result.direction !== "NO_TRADE") ctx.waitUntil(notifyTelegram(env, signalMessage(result)));

        return json(result);
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
             WHERE direction != 'NO_TRADE'
             GROUP BY ${groupCol} ORDER BY signals DESC`
          ).all();
        const confBucket = `CASE WHEN confidence < 60 THEN '<60' WHEN confidence < 75 THEN '60-74' ELSE '75+' END`;
        const [byClass, bySession, bySetup, byConfidence] = await Promise.all([
          q("asset_class"),
          q("session"),
          q("setup_type"),
          q(confBucket),
        ]);

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

  // Cron (every 5 min): auto-grade open live signals by walking real 1m candles.
  // Every 30 min within 07-21 UTC: auto-analyze both metals (one open trade per asset).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await gradeOpenSignals(env);

        const t = new Date(event.scheduledTime || Date.now());
        const h = t.getUTCHours(), m = t.getUTCMinutes();
        if (h < 7 || h >= 21 || m % 30 >= 5) return; // :00 and :30 only, active hours

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
            if (r.direction !== "NO_TRADE") await notifyTelegram(env, signalMessage(r));
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
<title>ChartSage — screenshot in, signal out</title>
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
.drop{border:2px dashed var(--line);border-radius:8px;padding:34px 16px;text-align:center;color:var(--dim);cursor:pointer;transition:border-color .15s}
.drop:hover,.drop.over{border-color:var(--gold);color:var(--text)}
.drop img{max-width:100%;max-height:280px;border-radius:6px}
textarea{width:100%;margin-top:12px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--text);padding:10px;font-family:inherit;font-size:14px;resize:vertical;min-height:44px}
button{font-family:inherit;font-weight:500;border:none;border-radius:6px;cursor:pointer;font-size:14px}
.primary{width:100%;margin-top:12px;padding:13px;background:var(--gold);color:#141414;font-weight:700;font-size:15px}
.primary:disabled{background:var(--flat);color:#222;cursor:wait}
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
.outcome{display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--line);flex-wrap:wrap;align-items:center}
.outcome span{font-size:12px;color:var(--dim);margin-right:4px}
.outcome button{padding:7px 14px;background:var(--panel2);border:1px solid var(--line);color:var(--text)}
.outcome button:hover{border-color:var(--gold)}
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
  <p class="mono">screenshot in · signal out · every call logged</p>
</header>

<div class="wrap">
  <div class="card"><div class="kente"></div><div class="body">
    <div class="liverow">
      <button class="live" data-sym="XAUUSD">Gold (XAU/USD) — live analysis</button>
      <button class="live" data-sym="EURUSD">EUR/USD — live analysis</button>
      <button class="live" data-sym="XAGUSD">Silver (XAG/USD) — live analysis</button>
    </div>
    <div class="err" id="live-err"></div>
  </div></div>

  <div class="card"><div class="kente"></div><div class="body">
    <div class="drop" id="drop">Paste (Ctrl+V), drop, or click to upload a chart screenshot</div>
    <input type="file" id="file" accept="image/*" hidden>
    <textarea id="notes" placeholder="Optional notes for the analyst (e.g. 'news just dropped', 'third touch of this level')"></textarea>
    <button class="primary" id="go" disabled>Analyze chart</button>
    <div class="err" id="err"></div>
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
let imgB64 = null, lastId = null;
const $ = (s) => document.querySelector(s);
const drop = $("#drop"), go = $("#go"), err = $("#err");

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

// Downscale to max 1280px JPEG — full-res screenshots are multi-MB payloads
// that slow the vision call and burn neurons for zero readability gain.
function setImage(file){
  const r = new FileReader();
  r.onload = () => {
    const im = new Image();
    im.onload = () => {
      const MAX = 1280;
      const scale = Math.min(1, MAX / Math.max(im.width, im.height));
      const c = document.createElement("canvas");
      c.width = Math.round(im.width * scale);
      c.height = Math.round(im.height * scale);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.85);
      imgB64 = url.split(",")[1];
      drop.innerHTML = "";
      const prev = new Image(); prev.src = url; drop.appendChild(prev);
      go.disabled = false; err.textContent = "";
    };
    im.src = r.result;
  };
  r.readAsDataURL(file);
}
drop.onclick = () => $("#file").click();
$("#file").onchange = (e) => e.target.files[0] && setImage(e.target.files[0]);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files[0] && setImage(e.dataTransfer.files[0]); };
window.addEventListener("paste", (e) => {
  for (const it of e.clipboardData.items) if (it.type.startsWith("image/")) setImage(it.getAsFile());
});

go.onclick = async () => {
  go.disabled = true; go.textContent = "Reading chart…"; err.textContent = "";
  try {
    const res = await api("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imgB64, notes: $("#notes").value })
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    lastId = d.id;
    render(d);
    if (d.direction !== "NO_TRADE") startCountdown(d.expiry_minutes);
    loadLog(); loadStats();
  } catch (ex) { err.textContent = ex.message; }
  go.disabled = false; go.textContent = "Analyze chart";
};

let cdTimer = null;
function startCountdown(mins){
  clearInterval(cdTimer);
  let left = Math.max(1, Number(mins) || 1) * 60;
  cdTimer = setInterval(() => {
    const node = $("#cd");
    if (!node) return clearInterval(cdTimer);
    left--;
    if (left <= 0) {
      node.textContent = "expired — log the result below";
      node.style.color = "var(--gold)";
      return clearInterval(cdTimer);
    }
    node.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  }, 1000);
}

function render(d){
  const dirWord = d.direction === "LONG" ? "▲ LONG (CALL)" : d.direction === "SHORT" ? "▼ SHORT (PUT)" : "— NO TRADE";
  $("#result").innerHTML = \`
  <div class="card"><div class="kente"></div>
    <div class="sig-head">
      <div class="dir \${d.direction}">\${dirWord}</div>
      <div class="conf mono">P(up) \${d.prob_up}% · lean \${d.confidence}/100</div>
    </div>
    <div class="grid">
      <div class="cell"><div class="k">Asset</div><div class="v">\${d.asset || "unknown"}</div></div>
      <div class="cell"><div class="k">Class / Session</div><div class="v">\${d.asset_class} · \${d.session}</div></div>
      <div class="cell"><div class="k">Setup</div><div class="v">\${d.setup_type || "—"}</div></div>
      <div class="cell"><div class="k">Entry</div><div class="v mono">\${d.entry_timing || "—"}</div></div>
      <div class="cell"><div class="k">Expiry</div><div class="v mono">\${d.expiry_minutes} min</div></div>
      \${d.direction !== "NO_TRADE" ? \`<div class="cell"><div class="k">Expires in</div><div class="v mono" id="cd">\${d.expiry_minutes}:00</div></div>\` : ""}
      <div class="cell"><div class="k">Chart TF</div><div class="v mono">\${d.chart_read?.timeframe || "?"}</div></div>
    </div>
    <div class="reason">\${d.reasoning || ""}</div>
    \${d.direction !== "NO_TRADE" ? \`
    <div class="outcome"><span>Log the result:</span>
      <button onclick="mark('win')">Win</button>
      <button onclick="mark('loss')">Loss</button>
      <button onclick="mark('breakeven')">Breakeven</button>
      <button onclick="mark('skipped')">Skipped</button>
    </div>\` : ""}
  </div>\`;
}

async function mark(outcome){
  if (!lastId) return;
  await api("/outcome", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ id: lastId, outcome }) });
  loadLog(); loadStats();
}

// Live metals analysis — no screenshot, the worker pulls real candles.
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
}

loadLog(); loadStats();
</script>
</body>
</html>`;
