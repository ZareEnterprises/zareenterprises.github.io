// AMBRA panel — google-calendar-push-event Edge Function
//
// Called right after the panel saves a calendar_events row that has specific
// people linked to it (calendar_event_users) — creates the matching event on
// the one shared Google account's calendar (connected once via
// google-calendar-connect) with those people as attendees, so Google's own
// invite emails + their own Google Calendars handle the rest. This never
// runs for events with nobody linked — there's no one to invite.
// Deploy with:
//   supabase functions deploy google-calendar-push-event --project-ref <your-project-ref>

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

// Best-effort only: turns things like "5:00pm" or "17:00" into an
// {hour, minute} clock time. Anything it can't confidently parse falls back
// to an all-day event in the caller, which is a legitimate, unambiguous
// Google Calendar event shape rather than a guess.
function parseClockTime(text) {
  if (!text) return null;
  const match = String(text).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function nextDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
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

  const { title, description, date, time, attendeeEmails } = body;
  if (!title || typeof title !== 'string') return json({ error: 'title is required' }, 400);
  if (!date || typeof date !== 'string') return json({ error: 'date is required' }, 400);
  if (!Array.isArray(attendeeEmails) || attendeeEmails.length === 0) {
    return json({ error: 'attendeeEmails must be a non-empty array' }, 400);
  }

  const { data: connection, error: connErr } = await adminClient
    .from('google_calendar_connection')
    .select('*')
    .maybeSingle();
  if (connErr) return json({ error: `Could not read Google connection: ${connErr.message}` }, 500);
  if (!connection) return json({ error: 'Google Calendar is not connected yet.' }, 400);

  let accessToken = connection.access_token;

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');

  const expiresAt = connection.expires_at ? new Date(connection.expires_at).getTime() : 0;
  if (expiresAt - Date.now() < 60000) {
    if (!connection.refresh_token) {
      return json({ error: 'Google Calendar connection has expired — reconnect it from Settings.' }, 400);
    }
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: connection.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const refreshed = await refreshRes.json();
    if (!refreshRes.ok) {
      return json({ error: `Could not refresh Google token: ${refreshed.error_description || refreshed.error || refreshRes.status}` }, 400);
    }
    accessToken = refreshed.access_token;
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await adminClient
      .from('google_calendar_connection')
      .update({
        access_token: accessToken,
        expires_at: newExpiresAt,
        // Google usually only reissues a refresh_token the very first time —
        // keep the existing one unless a new one actually came back.
        refresh_token: refreshed.refresh_token || connection.refresh_token,
        updated_at: new Date().toISOString(),
      })
      .eq('id', connection.id);
  }

  const clockTime = parseClockTime(time);
  const eventBody = {
    summary: title,
    description: description || undefined,
    attendees: attendeeEmails.map((email) => ({ email })),
  };
  if (clockTime) {
    const start = new Date(`${date}T00:00:00`);
    start.setHours(clockTime.hour, clockTime.minute, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // default 1-hour block
    eventBody.start = { dateTime: start.toISOString() };
    eventBody.end = { dateTime: end.toISOString() };
  } else {
    eventBody.start = { date };
    eventBody.end = { date: nextDate(date) };
  }

  const gcalRes = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventBody),
    }
  );
  const gcalResult = await gcalRes.json();
  if (!gcalRes.ok) {
    return json({ error: `Google Calendar error: ${gcalResult.error?.message || gcalRes.status}` }, 400);
  }

  return json({ ok: true, id: gcalResult.id, htmlLink: gcalResult.htmlLink });
});
