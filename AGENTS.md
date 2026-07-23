# ChartSage — Project Memory

## What this is
Signal analyst for real markets (primary: XAU/USD + XAG/USD) on Cloudflare Workers.
Live feed → probability estimate → server-computed ATR trade plan → auto-graded outcomes
→ Telegram channel alerts. Screenshot/vision mode exists as a fallback for real-feed
charts; OTC pairs are rejected by design (broker-generated, no public tape).

## Live deployment
- Worker: `chartsage` → https://chartsage.ghwmelite.workers.dev
- Repo: https://github.com/ghwmelite-dotcom/chatsage (worker code in `chartsage/qx-signal-ai/`)
- D1: `chartsage-db` (id 18871b09-cd6d-4527-a3f5-cfad12be4908, WEUR)
- Cron: `*/5 * * * *` — grades open signals; auto-analyzes XAU/USD + EUR/USD at :00/:30, 07–21 UTC
  (XAG/USD disabled: paywalled on Twelve Data free tier)
- Telegram channel: "XAU-XAG Signals" (@xau_xag_signals)

## Secrets (set via `wrangler secret put`, never in repo)
- `API_KEY` — protects all API endpoints (x-api-key header)
- `TWELVE_DATA_KEY` — live candles (free tier 800 req/day)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — channel alerts

## Architecture invariants (do not break)
- Direction is DERIVED server-side from prob_up (>=60 LONG, <=40 SHORT, else NO_TRADE)
- Trade levels computed from ATR(14) on 5m: SL 1.5x, TP 3x (1:2 R:R) — model never sets prices
- Auto-grader: walks real 1m candles; TP-first win, SL-first loss, both-in-candle = loss, 4h = breakeven
- One open trade per asset; NO_TRADE never notifies Telegram
- llama-3.2-11b-vision takes `prompt` + `image` (byte array), NOT chat messages
- Notifications are fire-and-forget (ctx.waitUntil); failures must not affect analysis
- Stats: payout-adjusted breakeven, Wilson 95% CI, min-N=30 reliability, calibration buckets

## Verification workflow
- `node --check src/index.js` after every edit
- Client <script> is inside a template literal: escape backticks/${} with backslash;
  verify with a vm.Script parse after evaluating the outer template
- D1 inspect: `npx wrangler d1 execute chartsage-db --remote --command "<SQL>"`
- Deploy: `npx wrangler deploy` from `chartsage/qx-signal-ai/`

## Cost notes
- Live analysis ≈ 60 neurons/call; 30-min cadence ≈ 3.4k neurons/day (within 10k free)
- Twelve Data: ~180 calls/day at current cadence (800/day free tier)
