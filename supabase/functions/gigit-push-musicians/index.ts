// Gig-It — the reverse of gigit-sync-musicians: pushes musicians that were
// added locally (e.g. "Import from Band") UP into Airtable's "Musicians
// Database" table, so Airtable stays the one place that has everyone.
// Optional by design — the admin only calls this when they've connected
// Airtable as their data source (see the toggle in gig-it.html); nothing
// about the rest of Gig-It depends on it.
//
// Deploy: supabase functions deploy gigit-push-musicians --project-ref lnodvezexfsmeasfndys --no-verify-jwt=false
// Reuses the AIRTABLE_TOKEN secret already set for gigit-sync-musicians.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const AIRTABLE_BASE_ID = 'appUfIcRf0ylNuO8V';
const AIRTABLE_TABLE_ID = 'tbl7VNgU72EqLveWX'; // "Musicians Database"

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
    const authHeader = req.headers.get('Authorization') || '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const airtableToken = Deno.env.get('AIRTABLE_TOKEN');
    if (!airtableToken) return json({ error: 'Airtable is not configured — set the AIRTABLE_TOKEN secret.' }, 500);

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return json({ error: 'Invalid session' }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await adminClient.from('profiles').select('is_admin').eq('id', caller.id).maybeSingle();
    if (!profile?.is_admin) return json({ error: 'Admins only' }, 403);

    const { musicians } = await req.json();
    if (!Array.isArray(musicians) || musicians.length === 0) {
      return json({ error: 'No musicians provided' }, 400);
    }

    // Airtable accepts at most 10 records per create call.
    const created: { full_name: string; airtable_record_id: string }[] = [];
    for (let i = 0; i < musicians.length; i += 10) {
      const batch = musicians.slice(i, i + 10);
      const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${airtableToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: batch.map((m: any) => ({
            fields: {
              'Musicians Name': m.full_name,
              ...(m.instrument ? { Role: [m.instrument] } : {}),
              ...(m.phone ? { Cellphone: m.phone } : {}),
              ...(m.email ? { 'Email (NO BERKLEE EMAIL)': m.email } : {}),
            },
          })),
        }),
      });
      if (!res.ok) return json({ error: `Airtable error: ${await res.text()}` }, 502);
      const result = await res.json();
      for (const r of result.records) {
        created.push({ full_name: r.fields['Musicians Name'], airtable_record_id: r.id });
      }
    }

    // Stamp the matching local rows with their new airtable_record_id so a
    // future "Sync from Airtable" upserts onto them instead of duplicating.
    for (const c of created) {
      await adminClient.from('musicians').update({ airtable_record_id: c.airtable_record_id }).eq('full_name', c.full_name).is('airtable_record_id', null);
    }

    return json({ ok: true, pushed: created.length });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
