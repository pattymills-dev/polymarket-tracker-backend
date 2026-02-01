import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Try the events endpoint for current markets
    const response = await fetch('https://gamma-api.polymarket.com/events?limit=10&active=true&closed=false')
    const events = await response.json()
    
    // Flatten markets from events
    const markets = events.flatMap(event => event.markets || [])
      .filter(m => m && !m.closed)
      .slice(0, 20)
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        markets,
        count: markets.length 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})