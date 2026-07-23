# ChartSage

Screenshot-in, signal-out chart analyst on Cloudflare Workers AI (free tier).
Vision pass reads the chart; a per-asset-class rulebook decides LONG / SHORT / NO_TRADE;
every signal and outcome is logged to D1 so the win rates judge the system, not vibes.

## Stack
- Workers AI: `@cf/meta/llama-3.2-11b-vision-instruct` (chart reading) + `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (rulebook reasoning)
- D1 for signal + outcome logging
- Single-file Worker serving the UI

## Deploy (PowerShell, from C:\Projects\chartsage)

```powershell
# 1. Make sure wrangler is on the ghwmelite account (account_id is pinned in wrangler.toml)
wrangler whoami

# 2. Create the database
wrangler d1 create chartsage-db
# Copy the returned database_id into wrangler.toml (uncomment the line)

# 3. Apply schema
wrangler d1 execute chartsage-db --remote --file=./schema.sql

# 4. Set the API key that protects /analyze, /outcome, /signals, /stats
wrangler secret put API_KEY
# The UI prompts for this key once and stores it in localStorage.

# 5. Deploy
wrangler deploy
```

Open the workers.dev URL, paste (Ctrl+V) a screenshot from Quotex or any platform, hit Analyze.

## Endpoints
- `POST /analyze` — `{ image: base64, notes?: string }` → signal JSON (requires `x-api-key`)
- `POST /outcome` — `{ id, outcome: win|loss|breakeven|skipped }` (requires `x-api-key`)
- `GET /signals?limit=30` — recent log (requires `x-api-key`)
- `GET /stats?payout=80` — win rate by asset class / session / setup / confidence bucket,
  with 95% Wilson CI, reliability flag (<30 resolved = dimmed), and the payout-adjusted
  breakeven win rate. `payout` is your broker's payout % (default 80).

## House rules baked in
- NO_TRADE is enforced server-side when chart readability < 50 or trend is choppy
- Unknown assets are capped at confidence 60 and flagged `low_context`
- OTC/synthetics skip session logic; forex/gold/stocks get UTC session context injected
- Entry timing is computed server-side from the chart timeframe (never model-generated)
- Reasoning pass uses JSON mode with one retry on parse failure
- Images are downscaled to 1280px JPEG in the browser before upload (cost/latency)
- Per-class rulebooks live in `RULEBOOKS` in `src/index.js` — edit them there

## Honest expectations
This reads structure; it does not predict 1-minute noise. Run it on demo, log 200+
outcomes, and let `/stats` tell you if any slice (class × session × setup) has an edge.
If nothing clears ~55% after fees/payout math, the data has spoken.

## Free-tier notes
Workers AI free allocation (10k neurons/day) comfortably covers dozens of analyses daily.
Each analyze = 1 vision call + 1 text call. D1 free tier is far beyond what this needs.
