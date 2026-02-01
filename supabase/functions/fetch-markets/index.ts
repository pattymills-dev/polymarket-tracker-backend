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

    console.log('Fetching ACTIVE events from Polymarket...')

    // Fetch active, non-closed events
    const response = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50', {
      headers: {
        'Accept': 'application/json',
      }
    })

    console.log('Response status:', response.status)
    
    if (!response.ok) {
      throw new Error(`Polymarket API returned ${response.status}`)
    }

    const events = await response.json()
    console.log('Fetched events:', events.length)

    let stored = 0
    // Extract markets from events
    for (const event of events) {
      if (event.markets && Array.isArray(event.markets)) {
        for (const market of event.markets) {
          try {
            const { error } = await supabase.from('markets').upsert({
              id: market.id,
              question: market.question,
              category: market.category || event.category || 'other',
              end_date: market.endDate ? new Date(market.endDate) : null,
              volume: parseFloat(market.volume || 0),
              liquidity: parseFloat(market.liquidity || 0),
              updated_at: new Date().toISOString()
            })
            
            if (!error) stored++
            else console.error('Upsert error:', error)
          } catch (err) {
            console.error('Error storing market:', err)
          }
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, events: events.length, marketsStored: stored }),
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