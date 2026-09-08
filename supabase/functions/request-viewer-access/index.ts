import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const normalize = (s:string) => s.trim().toLowerCase().replace(/[^a-z0-9._-]/g,'')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders})
  try {
    const { username } = await req.json()
    const clean = String(username||'').trim()
    const normalized = normalize(clean)
    if (clean.length < 3 || normalized.length < 3) throw new Error('User ID must contain at least 3 letters or numbers.')
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: existing } = await admin.from('viewer_requests').select('id').eq('username_normalized',normalized).eq('status','pending').maybeSingle()
    if (existing) return Response.json({error:'That User ID already has a pending request.'},{headers:corsHeaders})
    const { error } = await admin.from('viewer_requests').insert({username:clean,username_normalized:normalized})
    if (error) throw error
    return Response.json({ok:true},{headers:corsHeaders})
  } catch (e) { return Response.json({error:e.message||'Unable to request access.'},{status:400,headers:corsHeaders}) }
})
