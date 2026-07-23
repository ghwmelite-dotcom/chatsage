# ChartSage

Signal analyst for real markets on Cloudflare Workers (free tier). Two modes:

- **Live metals (primary)** — click Gold or Silver; the Worker pulls real candles from
  Twelve Data, the 70B model estimates `prob_up` over the numbers, and the server builds
  a trade plan: entry, SL = 1.5×ATR, TP = 3×ATR (1:2 R:R). Outcomes are **auto-graded**
  by a cron that walks real 1m candles to see whether TP or SL was touched first.
- **Screenshot (fallback)** — paste a chart screenshot; a vision pass reads it, a
  per-asset-class rulebook estimates `prob_up`. OTC pairs are **rejected** — they are
  broker-generated feeds with no public tape.

Direction is always derived server-side from the probability lean (≥60 LONG, ≤40 SHORT,
else NO_TRADE). Every signal and outcome is logged to D1 so the win rates judge the
system, not vibes.

## Stack
- Workers AI: `@cf/meta/llama-3.2-11b-vision-instruct` (chart reading) + `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (rulebook reasoning)
- Twelve Data `time_series` API for live XAU/USD + XAG/USD candles
- D1 for signal + outcome logging; cron trigger (`*/5 * * * *`) for auto-grading
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
- `POST /analyze-live` — `{ symbol: "XAUUSD"|"XAGUSD" }` → trade plan JSON
  (prob_up, direction, entry_price, sl, tp) from the live feed
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
