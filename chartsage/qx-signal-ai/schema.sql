-- ChartSage D1 schema
-- Run: wrangler d1 execute chartsage-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  asset TEXT,
  asset_class TEXT,            -- forex | otc | crypto | commodity | stock_index | synthetic | unknown
  session TEXT,                -- asian | london | overlap | newyork | off_hours | n/a
  chart_timeframe TEXT,        -- what the screenshot showed, e.g. M1
  direction TEXT NOT NULL,     -- LONG | SHORT | NO_TRADE
  setup_type TEXT,             -- e.g. trend_continuation | sr_rejection | breakout | mean_reversion
  entry_timing TEXT,           -- e.g. "open of next M1 candle (14:32:00 GMT)"
  expiry_minutes INTEGER,      -- suggested expiry, e.g. 1, 2, 5
  confidence INTEGER,          -- 0-100 model self-score
  reasoning TEXT,              -- model's audit trail
  chart_read TEXT,             -- raw vision-model chart description (JSON)
  low_context INTEGER DEFAULT 0, -- 1 if asset could not be identified
  outcome TEXT,                -- win | loss | breakeven | skipped | NULL (pending)
  outcome_noted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_signals_asset_class ON signals(asset_class);
CREATE INDEX IF NOT EXISTS idx_signals_session ON signals(session);
CREATE INDEX IF NOT EXISTS idx_signals_outcome ON signals(outcome);
