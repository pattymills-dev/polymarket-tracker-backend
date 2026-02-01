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

    console.log('Syncing market resolutions...')

    // Get all unique market IDs from trades that don't have resolution data yet
    const { data: unresolvedMarkets, error: fetchError } = await supabase
      .from('markets')
      .select('id')
      .or('resolved.is.null,resolved.eq.false')
      .limit(100)

    if (fetchError) {
      console.error('Error fetching unresolved markets:', fetchError)
      throw fetchError
    }

    console.log(`Found ${unresolvedMarkets?.length || 0} markets to check`)

    let updated = 0
    let checked = 0

    for (const market of unresolvedMarkets || []) {
      checked++
      try {
        // Fetch market details from Polymarket API
        // Try the slug-based endpoint first
        const response = await fetch(`https://gamma-api.polymarket.com/markets/${market.id}`, {
          headers: { 'Accept': 'application/json' }
        })

        if (!response.ok) {
          console.log(`Market ${market.id} not found via direct lookup`)
          continue
        }

        const marketData = await response.json()

        // Check if market is closed (resolved)
        if (marketData.closed) {
          // Parse outcome prices to determine winner
          let winningOutcome = null

          if (marketData.outcomePrices) {
            try {
              const prices = JSON.parse(marketData.outcomePrices)
              const outcomes = JSON.parse(marketData.outcomes || '["Yes", "No"]')

              // The outcome with price closest to 1 is the winner
              const maxPriceIndex = prices.reduce((maxIdx: number, price: string, idx: number) => {
                return parseFloat(price) > parseFloat(prices[maxIdx]) ? idx : maxIdx
              }, 0)

              // Only mark as resolved if there's a clear winner (price > 0.9)
              if (parseFloat(prices[maxPriceIndex]) > 0.9) {
                winningOutcome = outcomes[maxPriceIndex]
              }
            } catch (parseErr) {
              console.error(`Error parsing outcomes for ${market.id}:`, parseErr)
            }
          }

          // Update the market with resolution data
          const { error: updateError } = await supabase
            .from('markets')
            .update({
              resolved: true,
              winning_outcome: winningOutcome,
              updated_at: new Date().toISOString()
            })
            .eq('id', market.id)

          if (!updateError) {
            updated++
            console.log(`Updated market ${market.id}: resolved=true, winning_outcome=${winningOutcome}`)
          } else {
            console.error(`Error updating market ${market.id}:`, updateError)
          }
        }
      } catch (err) {
        console.error(`Error checking market ${market.id}:`, err)
      }

      // Rate limit to avoid hammering the API
      if (checked % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        checked,
        updated,
        message: `Checked ${checked} markets, updated ${updated} with resolution data`
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
