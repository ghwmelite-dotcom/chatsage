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
  prob_up INTEGER,             -- model-estimated P(next candle closes up), 0-100
  confidence INTEGER,          -- 50-100 strength of the lean (max(prob_up, 100-prob_up))
  reasoning TEXT,              -- model's audit trail
  chart_read TEXT,             -- raw vision-model chart description (JSON)
  low_context INTEGER DEFAULT 0, -- 1 if asset could not be identified
  outcome TEXT,                -- win | loss | breakeven | skipped | NULL (pending)
  outcome_noted_at TEXT,
  mode TEXT DEFAULT 'screenshot', -- screenshot | live
  entry_price REAL,            -- live mode: entry at signal time
  sl REAL,                     -- live mode: stop-loss (1.5x ATR against)
  tp REAL,                     -- live mode: take-profit (3x ATR with, 1:2 R:R)
  mfe_r REAL,                  -- max favorable excursion in R (vs SL distance)
  mae_r REAL                   -- max adverse excursion in R
);

CREATE INDEX IF NOT EXISTS idx_signals_asset_class ON signals(asset_class);
CREATE INDEX IF NOT EXISTS idx_signals_session ON signals(session);
CREATE INDEX IF NOT EXISTS idx_signals_outcome ON signals(outcome);

-- Calibration loop state (edge_override etc.)
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
