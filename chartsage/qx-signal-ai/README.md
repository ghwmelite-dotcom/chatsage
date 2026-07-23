# ChartSage

Signal analyst for real markets on Cloudflare Workers (free tier). Two modes:

- **Live (primary)** — click Gold or EUR/USD; the Worker pulls real candles from
  Twelve Data, the 70B model estimates `prob_up` over the numbers plus computed levels
  (Asian range, PDH/PDL, price position), and the server builds a trade plan:
  entry, SL = 1.5×ATR, TP = 3×ATR (1:2 R:R). Outcomes are **auto-graded**
  by a cron that walks real 1m candles to see whether TP or SL was touched first.
- **Mechanical engines** — deterministic, LLM-free signals in documented windows:
  Gold Asian Range Breakout (07:00–12:00 UTC, first 15m body close beyond the
  00:00–07:00 range, SL opposite end, TP 1.5× width) and EUR/USD Overlap Momentum
  (first 12:00–13:00 hour sets direction, SL beyond the hour's range, TP 1.5× width).
  One engine signal per asset per day, tagged with its own `setup_type` in `/stats`.
- **Screenshot (API-only legacy)** — `POST /analyze` still works for real-feed chart
  screenshots, but the upload UI was removed; the landing page is live-analysis only.
  OTC pairs are **rejected** — they are broker-generated feeds with no public tape.

Direction is always derived server-side from the probability lean (≥60 LONG, ≤40 SHORT,
else NO_TRADE). Every signal and outcome is logged to D1 so the win rates judge the
system, not vibes.

## Stack
- Workers AI: `@cf/meta/llama-3.2-11b-vision-instruct` (chart reading) + `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (rulebook reasoning)
- Twelve Data `time_series` API for live XAU/USD + XAG/USD candles
- D1 for signal + outcome logging; cron trigger (`*/5 * * * *`) for auto-grading,
  plus auto-analysis of both metals every 30 min within 07:00–21:00 UTC
  (one open trade per asset; NO_TRADE runs stay silent)
- Single-file Worker serving the UI

## Deploy (PowerShell)

```powershell
# 1. Make sure wrangler is on the right account (account_id is pinned in wrangler.toml)
wrangler whoami

# 2. Create the database
wrangler d1 create chartsage-db
# Copy the returned database_id into wrangler.toml

# 3. Apply schema
wrangler d1 execute chartsage-db --remote --file=./schema.sql

# 4. Secrets
wrangler secret put API_KEY            # protects all API endpoints; UI prompts once
wrangler secret put TWELVE_DATA_KEY    # free key from twelvedata.com (800 req/day)
wrangler secret put TELEGRAM_BOT_TOKEN # optional: from @BotFather, for channel alerts
wrangler secret put TELEGRAM_CHAT_ID   # optional: channel id (-100...), bot must be admin

# 5. Deploy
wrangler deploy
```

## Endpoints (all require `x-api-key`)
- `POST /analyze-live` — `{ symbol: "XAUUSD"|"EURUSD"|"XAGUSD" }` → trade plan JSON
  (prob_up, direction, entry_price, sl, tp) from the live feed.
  XAGUSD needs a paid Twelve Data plan; XAUUSD + EURUSD auto-analyze every 30 min (07–21 UTC)
- `POST /analyze` — `{ image: base64, notes?: string }` → signal JSON (rejects OTC)
- `POST /outcome` — `{ id, outcome: win|loss|breakeven|skipped }` (screenshot mode; live signals self-grade)
- `GET /signals?limit=30` — recent log
- `GET /stats?payout=80` — win rate by asset class / session / setup / confidence bucket,
  with 95% Wilson CI, reliability flag (<30 resolved = dimmed), and the payout-adjusted
  breakeven win rate

## House rules baked in
- Direction derived from prob_up server-side; NO_TRADE when the lean < 60/40
- Live trade levels computed from ATR(14) — the model never invents prices
- NO_TRADE enforced when chart readability < 50 or trend is choppy
- Unknown assets capped at confidence 60 and flagged `low_context`
- Auto-grader: TP-first = win, SL-first = loss, both-in-one-candle = loss, 4h = breakeven
- Telegram: live LONG/SHORT signals and their graded outcomes post to your channel
  (NO_TRADE stays silent; notification failures never block analysis)
- Entry timing for screenshots computed server-side (never model-generated)
- Market-hours guard: no analysis when spot FX/metals are closed
  (Sat, Sun before 21:00 UTC, Fri after 21:00 UTC) — manual + cron both refuse
- Tier-1 news guard: FOMC/CPI/NFP calendar in code — engines and probabilistic
  analysis stand down ±45 min around releases; overlap momentum skips Tier-1 days
  entirely; same-day events inject a caution note into the prompt
  (update `NEWS_UTC` in `src/index.js` as new dates publish)
- Reasoning pass uses JSON mode with retry; truncated JSON salvaged by brace-closing
- Images downscaled to 1280px JPEG in the browser before upload
- Per-class rulebooks live in `RULEBOOKS` in `src/index.js` — edit them there

## Honest expectations
Structure and probability estimates are hypotheses, not prophecy. Short-horizon moves
are noise-dominated; let 200+ auto-graded outcomes in `/stats` decide whether any slice
(class × session × setup) clears the breakeven line. Demo account until the data earns
otherwise.

## Free-tier notes
Workers AI: 10k neurons/day covers dozens of analyses. Twelve Data free: 800 req/day —
each live analysis costs 2, each grading cycle costs 1 per open signal. D1 free tier is
far beyond what this needs.
