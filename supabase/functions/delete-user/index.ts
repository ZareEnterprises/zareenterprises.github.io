// AMBRA panel — delete-user Edge Function
//
// Called by the panel (as an authenticated admin) to permanently delete a
// teammate's account. Deleting the auth.users row cascades automatically to
// profiles, project_members and project_member_bands (all declared ON
// DELETE CASCADE in supabase/schema.sql), so this function only needs to
// delete the one row.
//
// Runs here, not in the browser, for the same reason invite-user does:
// deleting another person's account requires the service_role key.
// Deploy with:
//   supabase functions deploy delete-user --project-ref <your-project-ref> --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Missing Authorization header' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !caller) return json({ error: 'Invalid session' }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: callerProfile } = await adminClient
    .from('profiles')
    .select('is_admin')
    .eq('id', caller.id)
    .single();
  if (!callerProfile?.is_admin) return json({ error: 'Admins only' }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { user_id } = body;
  if (!user_id || typeof user_id !== 'string') return json({ error: 'user_id is required' }, 400);
  if (user_id === caller.id) return json({ error: "You can't delete your own account." }, 400);

  const { error: deleteErr } = await adminClient.auth.admin.deleteUser(user_id);
  if (deleteErr) return json({ error: `Delete failed: ${deleteErr.message}` }, 400);

  return json({ ok: true });
});
