// EMN — invite-student Edge Function
//
// Called by /alumnos (as an authenticated Admin) to invite a new person:
// creates their Supabase Auth account if it doesn't exist yet (Supabase
// sends them a real invite email with a one-time link — they set their own
// password there, nobody else ever sees it), then creates their `students`
// row with the chosen role.
//
// This has to run here, not in the browser: creating another person's auth
// account requires the service_role key, which must never reach client-side
// code. Deploy from inside supabase-emn/ (see this repo's
// supabase-emn/DEPLOY.md for the full first-time walkthrough):
//   supabase functions deploy invite-student --project-ref gpoddvcrsdkpgfmyniqu
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the platform — no manual secret setup needed for those.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ROLES = ['admin', 'professor', 'student'];

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

  // Scoped to the caller's own JWT — only used to find out who's calling.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !caller) return json({ error: 'Invalid session' }, 401);

  // service_role client — bypasses RLS. Only used after confirming the
  // caller is an Admin, and only touches what this endpoint is meant to.
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: callerRow } = await adminClient.from('students').select('role').eq('id', caller.id).maybeSingle();
  if (callerRow?.role !== 'admin') return json({ error: 'Admins only' }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { email, full_name, role } = body;
  if (!email || typeof email !== 'string') return json({ error: 'email is required' }, 400);
  if (!ALLOWED_ROLES.includes(role)) return json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` }, 400);

  // Reuse the existing account if this email already has one (e.g. just
  // changing their role); otherwise send a real Supabase invite.
  const { data: existing } = await adminClient.from('students').select('id').eq('email', email).maybeSingle();

  let userId;
  if (existing) {
    userId = existing.id;
    await adminClient.from('students').update({ role, full_name: full_name || null }).eq('id', userId);
  } else {
    // redirectTo must also be added to this project's Auth > URL
    // Configuration > Redirect URLs allow-list, or Supabase silently falls
    // back to the project's Site URL instead.
    const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: full_name || null },
      redirectTo: 'https://zareenterprises.github.io/emn-login',
    });
    if (inviteErr) return json({ error: `Invite failed: ${inviteErr.message}` }, 400);
    userId = invited.user.id;

    const { error: insertErr } = await adminClient.from('students').insert({
      id: userId, email, full_name: full_name || null, role, status: 'pending',
    });
    if (insertErr) return json({ error: `Could not save student row: ${insertErr.message}` }, 400);
  }

  return json({ ok: true, user_id: userId });
});
