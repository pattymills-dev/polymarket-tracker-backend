import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    console.log('Fetching trades from Polymarket Data API...')

    // Fetch recent trades (last 100)
    const response = await fetch('https://data-api.polymarket.com/trades?limit=100')
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`)
    }

    const trades = await response.json()
    console.log(`Fetched ${trades.length} trades`)

    // Add this line to see the first trade's raw timestamp:
console.log('First trade timestamp:', trades[0]?.timestamp)

    let stored = 0
    const WHALE_THRESHOLD = 10000

    for (const trade of trades) {
      try {
        const amount = parseFloat(trade.size) * parseFloat(trade.price)
        
        // Skip tiny trades
        if (amount < 100) continue

        // Store trade
        const { error: tradeError } = await supabase.from('trades').upsert({
          tx_hash: trade.transactionHash,
          market_id: trade.slug,
          trader_address: trade.proxyWallet,
          outcome: trade.outcome,
          amount: amount,
          price: parseFloat(trade.price),
          timestamp: new Date(trade.timestamp * 1000).toISOString()
        }, { onConflict: 'tx_hash' })

        if (!tradeError) {
          stored++
          
          // Update trader stats
          await supabase.from('traders').upsert({
            address: trade.proxyWallet,
            total_volume: amount,
            total_bets: 1,
            last_activity: new Date(trade.timestamp * 1000).toISOString()
          }, { 
            onConflict: 'address',
            ignoreDuplicates: false 
          })

          // Create alert for whale trades
          if (amount >= WHALE_THRESHOLD) {
            await supabase.from('alerts').insert({
              type: amount >= 50000 ? 'mega_whale' : 'whale',
              trader_address: trade.proxyWallet,
              market_id: trade.slug,
              amount: amount,
              message: `🐋 ${amount >= 50000 ? 'MEGA ' : ''}WHALE: $${amount.toFixed(0)} bet on ${trade.title}`
            })
          }
        }
      } catch (err) {
        console.error('Error storing trade:', err)
      }
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        fetched: trades.length, 
        stored 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Function error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})