import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
Deno.serve(async (req) => {
 if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders})
 try {
  const auth=req.headers.get('Authorization')||''
  const token=auth.replace('Bearer ','')
  const url=Deno.env.get('SUPABASE_URL')!, anon=Deno.env.get('SUPABASE_ANON_KEY')!, service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}}})
  const {data:{user}}=await userClient.auth.getUser(token); if(!user) throw new Error('Not signed in.')
  const admin=createClient(url,service)
  const {data:parent}=await admin.from('profiles').select('role').eq('id',user.id).single(); if(parent?.role!=='parent') throw new Error('Parent access required.')
  const {request_id,pin}=await req.json(); if(!/^\d{6,}$/.test(String(pin||''))) throw new Error('PIN must be at least 6 digits.')
  const {data:reqRow,error:reqErr}=await admin.from('viewer_requests').select('*').eq('id',request_id).eq('status','pending').single(); if(reqErr) throw reqErr
  const email=`${reqRow.username_normalized}@family-viewer.example.com`
  const {data:created,error:createErr}=await admin.auth.admin.createUser({email,password:String(pin),email_confirm:true,user_metadata:{display_name:reqRow.username}})
  if(createErr) throw createErr
  const viewerId=created.user.id
  const {error:pErr}=await admin.from('profiles').update({role:'viewer',display_name:reqRow.username}).eq('id',viewerId); if(pErr) throw pErr
  const {error:rErr}=await admin.from('viewer_requests').update({status:'approved',approved_user_id:viewerId,decided_at:new Date().toISOString(),decided_by:user.id}).eq('id',request_id); if(rErr) throw rErr
  return Response.json({ok:true},{headers:corsHeaders})
 } catch(e){return Response.json({error:e.message||'Unable to approve viewer.'},{status:400,headers:corsHeaders})}
})
