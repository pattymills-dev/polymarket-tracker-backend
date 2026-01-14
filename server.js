// server.js - Node.js Backend for Polymarket Tracker
// Install dependencies: npm install express cors axios ws pg node-cron dotenv
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const cron = require('node-cron');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DB_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Polymarket API endpoints
const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/polymarket/polymarket';

// ==================== DATABASE SETUP ====================
const initDatabase = async () => {
  try {
    // Markets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id VARCHAR(255) PRIMARY KEY,
        question TEXT NOT NULL,
        category VARCHAR(100),
        end_date TIMESTAMP,
        volume DECIMAL(20, 2),
        liquidity DECIMAL(20, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Trades table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        tx_hash VARCHAR(255) UNIQUE,
        market_id VARCHAR(255) REFERENCES markets(id),
        trader_address VARCHAR(255) NOT NULL,
        outcome VARCHAR(10),
        amount DECIMAL(20, 2),
        price DECIMAL(10, 4),
        timestamp TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Traders table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS traders (
        address VARCHAR(255) PRIMARY KEY,
        total_volume DECIMAL(20, 2) DEFAULT 0,
        total_bets INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        profit_loss DECIMAL(20, 2) DEFAULT 0,
        last_activity TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Trader positions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trader_positions (
        id SERIAL PRIMARY KEY,
        trader_address VARCHAR(255) REFERENCES traders(address),
        market_id VARCHAR(255) REFERENCES markets(id),
        outcome VARCHAR(10),
        shares DECIMAL(20, 4),
        avg_price DECIMAL(10, 4),
        status VARCHAR(20) DEFAULT 'open',
        resolved BOOLEAN DEFAULT FALSE,
        profit_loss DECIMAL(20, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Alerts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50),
        trader_address VARCHAR(255),
        market_id VARCHAR(255),
        amount DECIMAL(20, 2),
        message TEXT,
        sent BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Indexes for performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_trader ON trades(trader_address);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_amount ON trades(amount DESC);
      CREATE INDEX IF NOT EXISTS idx_positions_trader ON trader_positions(trader_address);
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
};

// ==================== POLYMARKET API FUNCTIONS ====================

// Fetch all active markets
const fetchMarkets = async () => {
  try {
    const response = await axios.get(`${POLYMARKET_API}/markets`, {
      params: {
        active: true,
        limit: 100
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    return [];
  }
};

// Fetch market details
const fetchMarketDetails = async (marketId) => {
  try {
    const response = await axios.get(`${POLYMARKET_API}/markets/${marketId}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching market details:', error.message);
    return null;
  }
};

// Fetch trades from subgraph
const fetchTradesFromSubgraph = async (limit = 100) => {
  const query = `
    query {
      trades(
        first: ${limit}
        orderBy: timestamp
        orderDirection: desc
      ) {
        id
        market {
          id
          question
        }
        trader {
          id
        }
        outcome
        amount
        price
        timestamp
      }
    }
  `;

  try {
    const response = await axios.post(SUBGRAPH_URL, { query });
    return response.data.data.trades;
  } catch (error) {
    console.error('Error fetching trades from subgraph:', error.message);
    return [];
  }
};

// ==================== DATA PROCESSING ====================

// Store market in database
const storeMarket = async (market) => {
  try {
    await pool.query(
      `INSERT INTO markets (id, question, category, end_date, volume, liquidity, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         volume = $5,
         liquidity = $6,
         updated_at = CURRENT_TIMESTAMP`,
      [
        market.id,
        market.question,
        market.category || 'other',
        market.endDate ? new Date(market.endDate) : null,
        market.volume || 0,
        market.liquidity || 0
      ]
    );
  } catch (error) {
    console.error('Error storing market:', error.message);
  }
};

// Store trade in database
const storeTrade = async (trade) => {
  try {
    // Store trade
    await pool.query(
      `INSERT INTO trades (tx_hash, market_id, trader_address, outcome, amount, price, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        trade.id,
        trade.market.id,
        trade.trader.id,
        trade.outcome,
        parseFloat(trade.amount),
        parseFloat(trade.price),
        new Date(parseInt(trade.timestamp) * 1000)
      ]
    );

    // Update trader stats
    await pool.query(
      `INSERT INTO traders (address, total_volume, total_bets, last_activity)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (address) DO UPDATE SET
         total_volume = traders.total_volume + $2,
         total_bets = traders.total_bets + 1,
         last_activity = $3,
         updated_at = CURRENT_TIMESTAMP`,
      [
        trade.trader.id,
        parseFloat(trade.amount),
        new Date(parseInt(trade.timestamp) * 1000)
      ]
    );

    // Update trader position
    await updateTraderPosition(trade);

    // Check for alerts
    await checkForAlerts(trade);
  } catch (error) {
    console.error('Error storing trade:', error.message);
  }
};

// Update trader position
const updateTraderPosition = async (trade) => {
  try {
    const result = await pool.query(
      `SELECT * FROM trader_positions 
       WHERE trader_address = $1 AND market_id = $2 AND outcome = $3 AND status = 'open'`,
      [trade.trader.id, trade.market.id, trade.outcome]
    );

    const amount = parseFloat(trade.amount);
    const price = parseFloat(trade.price);
    const shares = amount / price;

    if (result.rows.length > 0) {
      // Update existing position
      const position = result.rows[0];
      const newShares = parseFloat(position.shares) + shares;
      const newAvgPrice = ((parseFloat(position.shares) * parseFloat(position.avg_price)) + (shares * price)) / newShares;

      await pool.query(
        `UPDATE trader_positions 
         SET shares = $1, avg_price = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [newShares, newAvgPrice, position.id]
      );
    } else {
      // Create new position
      await pool.query(
        `INSERT INTO trader_positions (trader_address, market_id, outcome, shares, avg_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [trade.trader.id, trade.market.id, trade.outcome, shares, price]
      );
    }
  } catch (error) {
    console.error('Error updating position:', error.message);
  }
};

// Check for alert conditions
const checkForAlerts = async (trade) => {
  const amount = parseFloat(trade.amount);
  const WHALE_THRESHOLD = 10000;
  const MEGA_WHALE_THRESHOLD = 50000;

  try {
    if (amount >= MEGA_WHALE_THRESHOLD) {
      await pool.query(
        `INSERT INTO alerts (type, trader_address, market_id, amount, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'mega_whale',
          trade.trader.id,
          trade.market.id,
          amount,
          `🐋 MEGA WHALE ALERT: ${trade.trader.id} bet $${amount.toFixed(0)} on ${trade.market.question}`
        ]
      );
    } else if (amount >= WHALE_THRESHOLD) {
      await pool.query(
        `INSERT INTO alerts (type, trader_address, market_id, amount, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'whale',
          trade.trader.id,
          trade.market.id,
          amount,
          `🐳 Whale Alert: ${trade.trader.id} bet $${amount.toFixed(0)} on ${trade.market.question}`
        ]
      );
    }
  } catch (error) {
    console.error('Error creating alert:', error.message);
  }
};

// Calculate trader win rate
const calculateTraderStats = async (address) => {
  try {
    // Get all resolved positions
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_positions,
        SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN profit_loss < 0 THEN 1 ELSE 0 END) as losses,
        SUM(profit_loss) as total_profit_loss
       FROM trader_positions
       WHERE trader_address = $1 AND resolved = TRUE`,
      [address]
    );

    if (result.rows[0].total_positions > 0) {
      const stats = result.rows[0];
      await pool.query(
        `UPDATE traders SET
          wins = $1,
          losses = $2,
          profit_loss = $3,
          updated_at = CURRENT_TIMESTAMP
         WHERE address = $4`,
        [
          parseInt(stats.wins),
          parseInt(stats.losses),
          parseFloat(stats.total_profit_loss),
          address
        ]
      );
    }
  } catch (error) {
    console.error('Error calculating trader stats:', error.message);
  }
};

// ==================== API ENDPOINTS ====================

// Get large bets
app.get('/api/large-bets', async (req, res) => {
  try {
    const { minAmount = 10000, category, limit = 50 } = req.query;
    
    let query = `
      SELECT t.*, m.question, m.category
      FROM trades t
      JOIN markets m ON t.market_id = m.id
      WHERE t.amount >= $1
    `;
    const params = [minAmount];

    if (category && category !== 'all') {
      query += ` AND m.category = $2`;
      params.push(category);
    }

    query += ` ORDER BY t.timestamp DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching large bets:', error);
    res.status(500).json({ error: 'Failed to fetch large bets' });
  }
});

// Get top traders
app.get('/api/top-traders', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const result = await pool.query(
      `SELECT 
        address,
        total_volume,
        total_bets,
        wins,
        losses,
        profit_loss,
        last_activity,
        CASE 
          WHEN (wins + losses) > 0 THEN CAST(wins AS FLOAT) / (wins + losses)
          ELSE 0
        END as win_rate
       FROM traders
       WHERE total_bets > 5
       ORDER BY profit_loss DESC
       LIMIT $1`,
      [limit]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching top traders:', error);
    res.status(500).json({ error: 'Failed to fetch top traders' });
  }
});

// Get trader details
app.get('/api/trader/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    // Get trader info
    const traderResult = await pool.query(
      `SELECT * FROM traders WHERE address = $1`,
      [address]
    );
    
    if (traderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trader not found' });
    }
    
    // Get recent trades
    const tradesResult = await pool.query(
      `SELECT t.*, m.question, m.category
       FROM trades t
       JOIN markets m ON t.market_id = m.id
       WHERE t.trader_address = $1
       ORDER BY t.timestamp DESC
       LIMIT 20`,
      [address]
    );
    
    // Get open positions
    const positionsResult = await pool.query(
      `SELECT p.*, m.question
       FROM trader_positions p
       JOIN markets m ON p.market_id = m.id
       WHERE p.trader_address = $1 AND p.status = 'open'`,
      [address]
    );
    
    res.json({
      trader: traderResult.rows[0],
      recentTrades: tradesResult.rows,
      openPositions: positionsResult.rows
    });
  } catch (error) {
    console.error('Error fetching trader details:', error);
    res.status(500).json({ error: 'Failed to fetch trader details' });
  }
});

// Get alerts
app.get('/api/alerts', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    
    const result = await pool.query(
      `SELECT a.*, m.question
       FROM alerts a
       LEFT JOIN markets m ON a.market_id = m.id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Get market statistics
app.get('/api/market-stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(DISTINCT t.market_id) as active_markets,
        COUNT(*) as total_trades_24h,
        SUM(t.amount) as total_volume_24h,
        COUNT(DISTINCT t.trader_address) as unique_traders_24h
      FROM trades t
      WHERE t.timestamp >= NOW() - INTERVAL '24 hours'
    `);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching market stats:', error);
    res.status(500).json({ error: 'Failed to fetch market stats' });
  }
});

// ==================== BACKGROUND JOBS ====================

// Sync markets every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  console.log('🔄 Syncing markets...');
  const markets = await fetchMarkets();
  for (const market of markets) {
    await storeMarket(market);
  }
  console.log(`✅ Synced ${markets.length} markets`);
});

// Sync trades every minute
cron.schedule('* * * * *', async () => {
  console.log('🔄 Syncing trades...');
  const trades = await fetchTradesFromSubgraph(100);
  for (const trade of trades) {
    await storeTrade(trade);
  }
  console.log(`✅ Synced ${trades.length} trades`);
});

// Update trader stats every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  console.log('🔄 Updating trader stats...');
  const result = await pool.query('SELECT DISTINCT address FROM traders');
  for (const row of result.rows) {
    await calculateTraderStats(row.address);
  }
  console.log('✅ Updated trader stats');
});

// ==================== SERVER STARTUP ====================

const PORT = process.env.PORT || 3001;

const startServer = async () => {
  await initDatabase();
  
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 API endpoints available at http://localhost:${PORT}/api`);
  });
  
  // Initial data sync
  console.log('🔄 Performing initial data sync...');
  const markets = await fetchMarkets();
  for (const market of markets) {
    await storeMarket(market);
  }
  const trades = await fetchTradesFromSubgraph(100);
  for (const trade of trades) {
    await storeTrade(trade);
  }
  console.log('✅ Initial sync complete');
};
startServer();