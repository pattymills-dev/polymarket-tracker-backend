-- Add resolution tracking columns to markets table
-- This migration adds the ability to track whether a market has resolved and what the winning outcome was

-- Add resolved column (boolean, defaults to false)
ALTER TABLE markets
ADD COLUMN IF NOT EXISTS resolved BOOLEAN DEFAULT FALSE;

-- Add winning_outcome column (stores the outcome string like "Yes", "No", "Over", "Under", etc.)
ALTER TABLE markets
ADD COLUMN IF NOT EXISTS winning_outcome TEXT;

-- Add slug column for proper market links (the full URL slug for polymarket.com/market/{slug})
ALTER TABLE markets
ADD COLUMN IF NOT EXISTS slug TEXT;

-- Create index for faster resolution status queries
CREATE INDEX IF NOT EXISTS idx_markets_resolved ON markets(resolved);

-- Update the calculate_trader_performance function to use the new columns
CREATE OR REPLACE FUNCTION calculate_trader_performance(min_resolved_markets INTEGER DEFAULT 3)
RETURNS TABLE (
  address TEXT,
  total_volume NUMERIC,
  total_bets INTEGER,
  wins INTEGER,
  losses INTEGER,
  total_pl NUMERIC,
  win_rate NUMERIC,
  profitability_rate NUMERIC,
  last_activity TIMESTAMP,
  current_streak INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH trader_market_results AS (
    -- Get each trader's outcome for each resolved market
    SELECT
      t.trader_address,
      t.market_id,
      t.outcome AS bet_outcome,
      m.winning_outcome,
      m.resolved,
      SUM(t.amount) AS total_wagered,
      -- Calculate P/L: if winning outcome matches bet, profit = shares * (1 - avg_price), else loss = -amount
      SUM(
        CASE
          WHEN m.winning_outcome = t.outcome THEN t.amount * (1 / NULLIF(t.price, 0) - 1)
          WHEN m.resolved AND m.winning_outcome IS NOT NULL THEN -t.amount
          ELSE 0
        END
      ) AS market_pl
    FROM trades t
    JOIN markets m ON t.market_id = m.id
    WHERE m.resolved = TRUE AND m.winning_outcome IS NOT NULL
    GROUP BY t.trader_address, t.market_id, t.outcome, m.winning_outcome, m.resolved
  ),
  trader_stats AS (
    SELECT
      tmr.trader_address,
      COUNT(DISTINCT tmr.market_id) AS resolved_markets,
      SUM(CASE WHEN tmr.bet_outcome = tmr.winning_outcome THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN tmr.bet_outcome != tmr.winning_outcome THEN 1 ELSE 0 END) AS losses,
      SUM(tmr.market_pl) AS total_pl,
      SUM(tmr.total_wagered) AS total_wagered
    FROM trader_market_results tmr
    GROUP BY tmr.trader_address
    HAVING COUNT(DISTINCT tmr.market_id) >= min_resolved_markets
  )
  SELECT
    tr.address::TEXT,
    tr.total_volume,
    tr.total_bets::INTEGER,
    COALESCE(ts.wins, 0)::INTEGER AS wins,
    COALESCE(ts.losses, 0)::INTEGER AS losses,
    COALESCE(ts.total_pl, 0) AS total_pl,
    CASE
      WHEN COALESCE(ts.wins, 0) + COALESCE(ts.losses, 0) > 0
      THEN COALESCE(ts.wins, 0)::NUMERIC / (COALESCE(ts.wins, 0) + COALESCE(ts.losses, 0))
      ELSE 0
    END AS win_rate,
    CASE
      WHEN COALESCE(ts.total_wagered, 0) > 0
      THEN COALESCE(ts.total_pl, 0) / ts.total_wagered
      ELSE 0
    END AS profitability_rate,
    tr.last_activity,
    0::INTEGER AS current_streak  -- TODO: Calculate actual streak
  FROM traders tr
  LEFT JOIN trader_stats ts ON tr.address = ts.trader_address
  WHERE ts.trader_address IS NOT NULL
  ORDER BY ts.total_pl DESC NULLS LAST
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- Comment explaining the resolution sync process
COMMENT ON COLUMN markets.resolved IS 'Whether the market has been resolved (closed with a winning outcome)';
COMMENT ON COLUMN markets.winning_outcome IS 'The winning outcome string (e.g., Yes, No, Over, Under)';
COMMENT ON COLUMN markets.slug IS 'Full URL slug for polymarket.com/market/{slug}';
