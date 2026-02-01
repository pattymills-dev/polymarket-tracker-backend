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
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )

    const url = new URL(req.url)
    const endpoint = url.pathname.split('/').pop()

    // Large bets
    if (endpoint === 'large-bets') {
      const minAmount = url.searchParams.get('minAmount') || '10000'
      const category = url.searchParams.get('category')
      const limit = url.searchParams.get('limit') || '50'

      let query = supabase
        .from('trades')
        .select('*, markets!inner(question, category)')
        .gte('amount', minAmount)
        .order('timestamp', { ascending: false })
        .limit(parseInt(limit))

      if (category && category !== 'all') {
        query = query.eq('markets.category', category)
      }

      const { data, error } = await query
      
      if (error) throw error
      
      return new Response(
        JSON.stringify(data),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Top traders
    if (endpoint === 'top-traders') {
      const limit = url.searchParams.get('limit') || '20'

      const { data, error } = await supabase
        .from('traders')
        .select('*')
        .gte('total_bets', 5)
        .order('profit_loss', { ascending: false })
        .limit(parseInt(limit))

      if (error) throw error

      return new Response(
        JSON.stringify(data),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Market stats
    if (endpoint === 'market-stats') {
      const { data, error } = await supabase.rpc('get_market_stats')

      if (error) throw error

      return new Response(
        JSON.stringify(data),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Alerts
    if (endpoint === 'alerts') {
      const limit = url.searchParams.get('limit') || '50'

      const { data, error } = await supabase
        .from('alerts')
        .select('*, markets(question)')
        .order('created_at', { ascending: false })
        .limit(parseInt(limit))

      if (error) throw error

      return new Response(
        JSON.stringify(data),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ error: 'Invalid endpoint' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})