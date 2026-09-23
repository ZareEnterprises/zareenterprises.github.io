// AMBRA panel — airtable-directory Edge Function
//
// Live-reads AMBRA's Airtable base ("Live Show Coordination") — Musicians
// Database and Client tables — so the panel's Directory can show that data
// without ever storing a copy of it: every call hits Airtable fresh, right
// then, and just relays the answer back. That also means Photo attachment
// URLs (which Airtable's API only gives out as short-lived signed links)
// are always current, since nothing here ever caches them.
//
// This has to run here, not in the browser: the Airtable token would be
// exposed to anyone who opened dev tools if it lived in client-side code —
// same reasoning as invite-user's service_role key. Deploy with:
//   supabase functions deploy airtable-directory --project-ref <your-project-ref>
// Then set the token once (never put it in a file that gets committed):
//   supabase secrets set AIRTABLE_TOKEN=pat_xxx --project-ref <your-project-ref>
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically by the
// platform — no manual secret setup needed for those.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const AIRTABLE_BASE_ID = 'appUfIcRf0ylNuO8V';
const MUSICIANS_TABLE_ID = 'tbl7VNgU72EqLveWX';
const CLIENTS_TABLE_ID = 'tblwWPv7UFy2YDJET';

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
  const type = url.searchParams.get('type');
  if (type !== 'musicians' && type !== 'clients') {
    return json({ error: 'type must be "musicians" or "clients"' }, 400);
  }

  // Clients (contact info, addresses) stay admin-only — a signed-in AMBRA
  // user is required, same as every privileged action in this app. Musicians
  // is the one case that also needs to work with NO session at all: the
  // public, no-login showcase page for a client calls it with just the
  // project's anon key, and only ever gets back the handful of public-safe
  // fields mapped below (never contact info, never a full Airtable row).
  if (type === 'clients') {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Missing Authorization header' }, 401);
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return json({ error: 'Invalid session' }, 401);
  }

  const token = Deno.env.get('AIRTABLE_TOKEN');
  if (!token) return json({ error: 'Airtable is not configured yet — set the AIRTABLE_TOKEN secret.' }, 500);

  const tableId = type === 'musicians' ? MUSICIANS_TABLE_ID : CLIENTS_TABLE_ID;
  let allRecords = [];
  let offset;
  do {
    const pageUrl = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`);
    if (offset) pageUrl.searchParams.set('offset', offset);
    const airtableRes = await fetch(pageUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!airtableRes.ok) return json({ error: `Airtable error: ${await airtableRes.text()}` }, 502);
    const page = await airtableRes.json();
    allRecords = allRecords.concat(page.records || []);
    offset = page.offset;
  } while (offset);

  // Only the fields the panel actually displays get relayed — this keeps
  // the rest of each Airtable row (cost/hour, payment details, etc.) from
  // ever reaching the browser in the first place.
  const records = allRecords.map((r) => {
    const f = r.fields || {};
    if (type === 'musicians') {
      const fullName = (f['Resource Name'] || '').trim();
      // "Socials/Videos" mixes Instagram and YouTube links in the same
      // field — the public showcase only ever wants the YouTube ones, so
      // contact/social info never reaches a client viewing that page.
      const socialsRaw = String(f['Socials/Videos'] || '');
      const youtubeLinks = (socialsRaw.match(/https?:\/\/\S+/g) || [])
        .filter((u) => /youtube\.com|youtu\.be/i.test(u));
      // Matches the audio file naming convention: "Ursula Eyzaguirre" ->
      // ursula-eyzaguirre.mp3, uploaded straight into the repo by hand.
      const slug = fullName.normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return {
        id: r.id,
        firstName: fullName.split(/\s+/)[0] || fullName,
        slug,
        bio: f['Bio (3 achievements)'] || '',
        photoUrl: f['Photo']?.[0]?.url || null,
        youtubeLinks,
      };
    }
    return {
      id: r.id,
      name: f['Name'] || '',
      email: f['Email'] || '',
      company: f['Company'] || '',
      cellNumber: f['Cell Number'] || '',
      address: f['Company Address'] || '',
      city: f['City'] || '',
      state: f['State'] || '',
      zip: f['Zip Code'] || '',
      country: f['Country'] || '',
    };
  });

  return json({ records });
});
