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

    let updated = 0
    let checked = 0

    // Step 1: Get unresolved markets from our database
    const { data: unresolvedMarkets, error: fetchError } = await supabase
      .from('markets')
      .select('id, question, slug')
      .or('resolved.is.null,resolved.eq.false')
      .limit(200)

    if (fetchError) {
      console.error('Error fetching unresolved markets:', fetchError)
    }

    console.log(`Found ${unresolvedMarkets?.length || 0} unresolved markets in database`)

    // Step 2: For each unresolved market, try to look it up on Polymarket by conditionId
    for (const market of unresolvedMarkets || []) {
      checked++

      try {
        // Try lookup by conditionId (our market.id)
        const response = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${market.id}`, {
          headers: { 'Accept': 'application/json' }
        })

        if (response.ok) {
          const markets = await response.json()
          if (markets && markets.length > 0) {
            const pmMarket = markets[0]

            if (pmMarket.closed) {
              let winningOutcome = null

              if (pmMarket.outcomePrices) {
                try {
                  const prices = JSON.parse(pmMarket.outcomePrices)
                  const outcomes = JSON.parse(pmMarket.outcomes || '["Yes", "No"]')

                  let maxPrice = 0
                  let maxIdx = 0
                  for (let i = 0; i < prices.length; i++) {
                    const price = parseFloat(prices[i])
                    if (price > maxPrice) {
                      maxPrice = price
                      maxIdx = i
                    }
                  }

                  if (maxPrice > 0.9) {
                    winningOutcome = outcomes[maxIdx]
                  }
                } catch (e) {
                  console.error('Error parsing outcomes:', e)
                }
              }

              const { error: updateError } = await supabase
                .from('markets')
                .update({
                  resolved: true,
                  winning_outcome: winningOutcome,
                  slug: pmMarket.slug,
                  updated_at: new Date().toISOString()
                })
                .eq('id', market.id)

              if (!updateError) {
                updated++
                console.log(`Updated ${market.id}: ${winningOutcome}`)
              }
            }
          }
        }
      } catch (err) {
        // Silently continue on individual errors
      }

      // Rate limit
      if (checked % 20 === 0) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }

    // Step 3: Also fetch recently closed events from Polymarket to catch any new ones
    const closedResponse = await fetch('https://gamma-api.polymarket.com/events?closed=true&limit=50&order=updatedAt&ascending=false', {
      headers: { 'Accept': 'application/json' }
    })

    if (closedResponse.ok) {
      const events = await closedResponse.json()
      console.log(`Fetched ${events.length} recently closed events`)

      for (const event of events) {
        if (!event.markets || !Array.isArray(event.markets)) continue

        for (const market of event.markets) {
          if (!market.closed) continue
          checked++

          let winningOutcome = null
          if (market.outcomePrices) {
            try {
              const prices = JSON.parse(market.outcomePrices)
              const outcomes = JSON.parse(market.outcomes || '["Yes", "No"]')

              let maxPrice = 0
              let maxIdx = 0
              for (let i = 0; i < prices.length; i++) {
                const price = parseFloat(prices[i])
                if (price > maxPrice) {
                  maxPrice = price
                  maxIdx = i
                }
              }

              if (maxPrice > 0.9) {
                winningOutcome = outcomes[maxIdx]
              }
            } catch (e) {}
          }

          // Update by conditionId
          const { error } = await supabase
            .from('markets')
            .update({
              resolved: true,
              winning_outcome: winningOutcome,
              slug: market.slug,
              updated_at: new Date().toISOString()
            })
            .eq('id', market.conditionId)

          if (!error) {
            updated++
          }
        }
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
