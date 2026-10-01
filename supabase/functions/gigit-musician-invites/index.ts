// Gig-It — returns one musician's profile + their invites, identified by
// their access_token (no Supabase Auth session involved — see the
// "frictionless login" note in musicians' table comment). Public endpoint:
// anyone can call it, but only with a real token, which only exists in the
// personal link each musician was sent.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { token } = await req.json();
    if (!token) return json({ error: 'Missing token' }, 400);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: musician, error: musErr } = await adminClient
      .from('musicians')
      .select('id, full_name')
      .eq('access_token', token)
      .maybeSingle();
    if (musErr || !musician) return json({ error: 'Invalid link' }, 404);

    const { data: invites, error: invErr } = await adminClient
      .from('event_invites')
      .select('id, response, responded_at, events(title, event_date, start_time, pay, location, music_style, notes), event_roles(instrument)')
      .eq('musician_id', musician.id)
      .order('created_at', { ascending: false });
    if (invErr) return json({ error: invErr.message }, 500);

    return json({ musician, invites });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
