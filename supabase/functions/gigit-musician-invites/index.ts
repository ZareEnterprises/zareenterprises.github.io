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

    // Querying from `events` (not `event_invites`) so the date filter drops
    // the whole event — filtering on a joined column from event_invites
    // only hides the nested row, not the parent, which would leave past
    // events showing up empty instead of disappearing.
    const todayStr = new Date().toISOString().slice(0, 10);
    const { data: eventsData, error: invErr } = await adminClient
      .from('events')
      .select('title, event_date, start_time, pay, location, music_style, notes, event_invites!inner(id, response, responded_at, musician_id, event_roles(instrument))')
      .eq('event_invites.musician_id', musician.id)
      .gte('event_date', todayStr)
      .order('event_date', { ascending: true });
    if (invErr) return json({ error: invErr.message }, 500);

    // Flatten back to the shape the app already expects: one row per invite.
    const invites = (eventsData || []).flatMap((ev: any) =>
      (ev.event_invites || []).map((inv: any) => ({
        id: inv.id,
        response: inv.response,
        responded_at: inv.responded_at,
        events: {
          title: ev.title, event_date: ev.event_date, start_time: ev.start_time,
          pay: ev.pay, location: ev.location, music_style: ev.music_style, notes: ev.notes,
        },
        event_roles: inv.event_roles,
      }))
    );

    return json({ musician, invites });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
