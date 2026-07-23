# ChartSage — Project Memory

## What this is
Signal analyst for real markets (XAU/USD + EUR/USD live; XAG/USD disabled — paywalled
on Twelve Data free tier) on Cloudflare Workers.
Live feed → probability estimate → server-computed ATR trade plan → auto-graded outcomes
→ Telegram channel alerts. Landing page is live-analysis only (Gold + EUR/USD buttons);
the screenshot endpoint `/analyze` remains for API use but has no UI. OTC rejected by design.

## Strategy engines (deterministic, LLM-free, `setup_type` separates them in /stats)
- `asian_range_breakout` (XAU/USD, 07:00–12:00 UTC): first fresh 15m body close beyond
  the 00:00–07:00 range; SL opposite end, TP 1.5× width; skip Mondays, range <$8 or >$35
- `overlap_momentum` (EUR/USD, 12:00–16:00 UTC): first overlap hour sets direction
  (≥15-pip body); SL beyond range + 2-pip buffer, TP 1.5× width; skips Tier-1 news days
- `confluence_a` / `confluence_b` (crypto top-15, hourly at :00): six-pillar stack
  (4h bias / 1h location / 1h trigger / derivatives / volatility / levels), hard vetoes
  (funding >0.05%, OI −3%/4h divergence, ATR% outside [0.0015, 0.025], headroom <1.5R);
  Grade A ≥80 → Telegram, B ≥65 → silent log; graded vs TP1 (1.5R)
- Engines: one signal per asset per day (crypto: 6h dedupe), checked every 15 min in-window
- Symbols/config live in `LIVE_SYMBOLS` in src/index.js (per-symbol rulebook class,
  decimals, auto flag); crypto config in `CRYPTO`
- Crypto data: Binance fapi primary, Bybit v5 auto-fallback (Binance 403s CF egress IPs)

## Live deployment
- Worker: `chartsage` → https://chartsage.ghwmelite.workers.dev
- Repo: https://github.com/ghwmelite-dotcom/chatsage (worker code in `chartsage/qx-signal-ai/`)
- D1: `chartsage-db` (id 18871b09-cd6d-4527-a3f5-cfad12be4908, WEUR)
- Cron: `*/5 * * * *` — grades open signals; mechanical engines every 15 min in their
  windows (XAU Asian Range Breakout 07–12, EUR/USD Overlap Momentum 12–16);
  probabilistic auto-analysis at :00/:30, 07–21 UTC
  (XAG/USD disabled: paywalled on Twelve Data free tier)
- Telegram channel: "XAU-XAG Signals" (@xau_xag_signals)

## Secrets (set via `wrangler secret put`, never in repo)
- `API_KEY` — protects all API endpoints (x-api-key header)
- `TWELVE_DATA_KEY` — live candles (free tier 800 req/day)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — channel alerts

## Architecture invariants (do not break)
- Direction is DERIVED server-side from prob_up (>=60 LONG, <=40 SHORT, else NO_TRADE)
- Trade levels computed from ATR(14) on 5m: SL 1.5x, TP 3x (1:2 R:R) — model never sets prices
- Auto-grader: walks real 1m candles; TP-first win, SL-first loss, both-in-candle = loss, 4h = breakeven;
  records mfe_r/mae_r (R-multiples) per trade — geometry diagnostics surface in /stats.excursion
- Correlation guard: BTCUSDT/ETHUSDT are drivers; same-direction alts suppressed when a
  driver fires; concurrent same-direction crypto capped at 3
- Calibration loop: nightly 22:05 UTC — realized WR per lean bucket (/stats.calibration);
  edge_override in settings table retunes finalizeSignal's threshold once n>=50
- Risk governor: settings.governor_lock — 4 consecutive losses or −5R/7d locks
  signal sends to PAPER (notifySignal wrapper); +3R paper recovery releases;
  tradeR = +rr win / −1 loss / 0 breakeven
- /backtest: replays deterministic engines (confluence needs symbol; arb/om capped at 17d
  by Twelve Data fetch depth); replay is an upper bound (no slippage/fees, funding=0)
- Daily digest 21:05 UTC to Telegram
- One open trade per asset; NO_TRADE never notifies Telegram
- marketOpen(): Sun 21:00–Fri 21:00 UTC only; newsGuard(): ±45 min blackout around
  FOMC/CPI/NFP (NEWS_UTC list in code — H2 CPI dates approximate, verify at bls.gov)
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
- Live analysis ≈ 60 neurons/call; ~3.4k neurons/day at current cadence (within 10k free)
- Twelve Data: ~400 calls/day (probabilistic :00/:30 + engine ticks + grading);
  800/day free tier — halve engine cadence if quota pressure appears
