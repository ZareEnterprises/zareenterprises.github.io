// AMBRA panel — invite-user Edge Function
//
// Called by the panel (as an authenticated admin) to invite a new teammate:
// creates their Supabase Auth account if it doesn't exist yet (Supabase sends
// them a real invite email with a one-time link — they set their own
// password there, nobody else ever sees it), then grants them access to one
// or more projects with the chosen role, status and permissions.
//
// This has to run here, not in the browser: creating another person's auth
// account requires the service_role key, which must never reach client-side
// code. Deploy with:
//   supabase functions deploy invite-user --project-ref <your-project-ref>
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the platform — no manual secret setup needed for those.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_PERMISSION_KEYS = ['setlist', 'lineup', 'band', 'members', 'rehearsals', 'sound', 'stage', 'lightning'];
const ALLOWED_PERMISSION_VALUES = ['view', 'edit', 'none'];

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

function isValidPermissions(perms) {
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return false;
  return Object.entries(perms).every(
    ([k, v]) => ALLOWED_PERMISSION_KEYS.includes(k) && ALLOWED_PERMISSION_VALUES.includes(v)
  );
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
  // caller is an admin, and only touches what this endpoint is meant to.
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

  const { email, full_name, project_ids, role, permissions, band_ids } = body;

  if (!email || typeof email !== 'string') return json({ error: 'email is required' }, 400);
  if (!Array.isArray(project_ids) || project_ids.length === 0) {
    return json({ error: 'project_ids must be a non-empty array' }, 400);
  }
  if (!role || typeof role !== 'string') return json({ error: 'role is required' }, 400);
  if (!isValidPermissions(permissions || {})) return json({ error: 'Invalid permissions payload' }, 400);

  // Reuse the existing account if this email already has one; otherwise send
  // a real Supabase invite — they'll set their own password via that email.
  let userId;
  const { data: existingProfile } = await adminClient
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existingProfile) {
    userId = existingProfile.id;
    if (full_name) await adminClient.from('profiles').update({ full_name }).eq('id', userId);
  } else {
    // redirectTo is set explicitly so the invite email always lands on the
    // real site's set-password screen — it must also be added to Supabase's
    // Auth "Redirect URLs" allow-list (Authentication > URL Configuration)
    // or Supabase silently falls back to the project's Site URL instead.
    const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: full_name || null },
      redirectTo: 'https://zareenterprises.github.io/ambra/',
    });
    if (inviteErr) return json({ error: `Invite failed: ${inviteErr.message}` }, 400);
    userId = invited.user.id;
  }

  const members = [];
  for (const project_id of project_ids) {
    const { data: member, error: memberErr } = await adminClient
      .from('project_members')
      .upsert(
        { project_id, user_id: userId, role, status: existingProfile ? 'active' : 'pending', permissions },
        { onConflict: 'project_id,user_id' }
      )
      .select()
      .single();
    if (memberErr) return json({ error: `Could not save membership: ${memberErr.message}` }, 400);
    members.push(member);

    if (Array.isArray(band_ids) && band_ids.length) {
      await adminClient.from('project_member_bands').delete().eq('project_member_id', member.id);
      await adminClient
        .from('project_member_bands')
        .insert(band_ids.map((band_id) => ({ project_member_id: member.id, band_id })));
    }
  }

  return json({ ok: true, user_id: userId, members });
});
