// AMBRA panel — google-calendar-callback Edge Function
//
// Google redirects the admin's browser here directly after the consent
// screen (see google-calendar-connect) — there's no Supabase session on
// this request at all, just Google's ?code=... in the query string, so this
// runs entirely with the service_role key instead of the usual caller/admin
// check. Deploy with:
//   supabase functions deploy google-calendar-callback --project-ref <your-project-ref> --no-verify-jwt
// (--no-verify-jwt because Google's redirect carries no Supabase auth at all.)
// This function's own URL must be registered in the Google Cloud Console
// OAuth client's "Authorized redirect URIs" — it has to match exactly what
// google-calendar-connect sent as redirect_uri.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function page(title, message, ok) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1115; color: #e8e8ea; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { max-width: 420px; text-align: center; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 12px; color: ${ok ? '#7bd88f' : '#e07a7a'}; }
  p { font-size: 14px; line-height: 1.6; color: #b8b8bd; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');

  if (oauthError) return html(page('Connection failed', `Google returned an error: ${oauthError}`, false), 400);
  if (!code) return html(page('Connection failed', 'No authorization code was returned by Google.', false), 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  const redirectUri = `${supabaseUrl}/functions/v1/google-calendar-callback`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    return html(page('Connection failed', `Google token exchange failed: ${tokens.error_description || tokens.error || tokenRes.status}`, false), 400);
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Fetch the connected account's own email just so the panel can show
  // "Connected as ..." later — not required for pushing events.
  let connectedEmail = null;
  try {
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (infoRes.ok) connectedEmail = (await infoRes.json()).email || null;
  } catch {
    // Non-fatal — the connection still works without a display email.
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Single-row table by convention: clear it out, then insert the fresh
  // connection, rather than juggling upsert/conflict-key semantics for a
  // table that's never meant to hold more than one row.
  await adminClient.from('google_calendar_connection').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  const { error: insertErr } = await adminClient.from('google_calendar_connection').insert({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || null,
    expires_at: expiresAt,
    connected_email: connectedEmail,
  });
  if (insertErr) return html(page('Connection failed', `Could not save the connection: ${insertErr.message}`, false), 500);

  return html(page('Connected!', `AMBRA is now connected to Google Calendar${connectedEmail ? ` as <strong>${connectedEmail}</strong>` : ''}. You can close this tab and return to AMBRA.`, true));
});
