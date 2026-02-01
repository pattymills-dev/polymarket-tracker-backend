# Polymarket Tracker Backend - Claude Memory

## Critical Knowledge

### Market Resolution Tracking

**The Problem:** Markets need `resolved` and `winning_outcome` columns to track whether a bet was a win or loss. Without this data, all trades show as "Pending" in the frontend.

**The Solution:**
1. The `markets` table must have these columns:
   - `resolved BOOLEAN DEFAULT FALSE` - whether the market has closed
   - `winning_outcome TEXT` - the winning outcome (e.g., "Yes", "No", "Over", "Under")
   - `slug TEXT` - full URL slug for proper market links

2. A Supabase edge function `sync-resolutions` must run periodically to:
   - Fetch market data from `https://gamma-api.polymarket.com/markets/{id}`
   - Check if `closed: true` in the response
   - Parse `outcomePrices` to determine winner (price > 0.9 indicates the winning outcome)
   - Update the markets table with resolution data

3. The `calculate_trader_performance` function must join trades with resolved markets to compute wins/losses.

**Migration File:** `supabase/migrations/20260201_add_market_resolution_columns.sql`

**Edge Function:** `supabase/functions/sync-resolutions/index.ts`

### Market Links

**The Problem:** Market links go to the sport category instead of the specific game.

**The Solution:** Store the full market `slug` from the Polymarket API, not just the market ID. The URL format is: `https://polymarket.com/event/{event-slug}` for events or `https://polymarket.com/market/{market-slug}` for direct markets.

### Polymarket API Structure

- Events API: `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50`
- Markets within events have: `id`, `slug`, `question`, `closed`, `outcomes`, `outcomePrices`
- Data API for trades: `https://data-api.polymarket.com/trades?limit=100`

### Database Schema

```sql
-- Required columns in markets table
markets (
  id VARCHAR(255) PRIMARY KEY,
  question TEXT,
  category VARCHAR(100),
  slug TEXT,                    -- Full URL slug
  resolved BOOLEAN DEFAULT FALSE,
  winning_outcome TEXT,
  end_date TIMESTAMP,
  volume DECIMAL(20, 2),
  liquidity DECIMAL(20, 2),
  created_at TIMESTAMP,
  updated_at TIMESTAMP
)
```

## Deployment Checklist

When deploying backend changes:
1. Run the SQL migration to add any new columns
2. Deploy the edge functions: `supabase functions deploy sync-resolutions`
3. Set up a cron job or scheduled function to run `sync-resolutions` periodically (every 10-30 minutes)
4. Verify the frontend's `calculate_trader_performance` RPC returns proper win/loss data

## Common Issues

1. **"Markets show as Pending"** → Run `sync-resolutions` function to update market resolution data
2. **"Win/loss not calculating"** → Check if `markets.resolved` and `markets.winning_outcome` are populated
3. **"Wrong market links"** → Ensure `slug` column is populated with full market slug, not just ID
