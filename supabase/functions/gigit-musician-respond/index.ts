// Gig-It — a musician answers (or changes) YES/NO on one of their invites,
// identified by their access_token. Routes through claim_gig_slot /
// release_gig_slot (service_role, so it bypasses RLS) so the broadcast-mode
// slot count stays atomic no matter how many people tap YES at once.

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
    const { token, invite_id, response } = await req.json();
    if (!token || !invite_id || !['yes', 'no'].includes(response)) {
      return json({ error: 'Missing or invalid token/invite_id/response' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: musician } = await adminClient.from('musicians').select('id').eq('access_token', token).maybeSingle();
    if (!musician) return json({ error: 'Invalid link' }, 404);

    // Make sure this invite actually belongs to this musician — the token
    // proves who's calling, but doesn't limit which invite_id they could
    // otherwise pass in.
    const { data: invite } = await adminClient.from('event_invites').select('id, response').eq('id', invite_id).eq('musician_id', musician.id).maybeSingle();
    if (!invite) return json({ error: 'Invite not found' }, 404);

    if (invite.response === 'filled' && response === 'yes') {
      return json({ error: 'This position has already been filled.' }, 409);
    }

    if (response === 'yes') {
      const { data: result, error } = await adminClient.rpc('claim_gig_slot', { p_invite_id: invite_id });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, response: result });
    } else {
      const { error } = await adminClient.rpc('release_gig_slot', { p_invite_id: invite_id });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, response: 'no' });
    }
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
