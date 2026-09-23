// AMBRA panel — google-calendar-connect Edge Function
//
// Kicks off the one-time OAuth handshake that connects AMBRA to a single
// shared Google account (ambraliproductions@gmail.com), used from then on
// as the organizer for every pushed calendar event — this is NOT per-user
// Google login, just one admin authorizing one shared calendar once.
//
// This has to be a plain GET the browser can navigate to directly
// (window.location.href = ...), because the next step is Google's own
// consent screen redirecting back to google-calendar-callback — a fetch()
// call can't follow that hop. That also means the caller's session can't
// be sent as an Authorization header (browser navigations can't set custom
// headers), so it's read from a query param instead and verified the same
// way every other admin-only function verifies its Authorization header.
// Deploy with:
//   supabase functions deploy google-calendar-connect --project-ref <your-project-ref> --no-verify-jwt
// (--no-verify-jwt because Supabase's platform-level JWT check only looks
// at the Authorization header, which this endpoint intentionally doesn't
// receive — the access_token query param is verified manually below instead.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(req.url);
  const accessToken = url.searchParams.get('access_token');
  if (!accessToken) return json({ error: 'Missing access_token' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
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

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  if (!clientId) return json({ error: 'Google Calendar is not configured yet — set GOOGLE_CLIENT_ID.' }, 500);

  const redirectUri = `${supabaseUrl}/functions/v1/google-calendar-callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.events');
  authUrl.searchParams.set('access_type', 'offline');
  // Forces Google to hand back a refresh_token every time — without this,
  // reconnecting the same Google account a second time silently omits it.
  authUrl.searchParams.set('prompt', 'consent');
  // Fixed on purpose: there's only ever one connection, so there's nothing
  // per-request worth round-tripping through Google here.
  authUrl.searchParams.set('state', 'ambra-google-calendar-connect');

  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: authUrl.toString() } });
});
