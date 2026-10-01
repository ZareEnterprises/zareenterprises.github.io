// Gig-It — syncs the `musicians` roster from Airtable's "Musicians Database"
// table. Airtable is the editing interface (the admin already knows it from
// the Musician Showcase); this just mirrors the fields Gig-It actually needs
// into Supabase, where the real invite/push/slot-claim logic lives (Airtable
// has no RLS or atomic transactions, so it can't be the system of record for
// those). Re-running this is safe — it upserts on `airtable_record_id`,
// never creating duplicates.
//
// Deploy: supabase functions deploy gigit-sync-musicians --project-ref lnodvezexfsmeasfndys
// Reuses the AIRTABLE_TOKEN secret already set for airtable-directory.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const AIRTABLE_BASE_ID = 'appUfIcRf0ylNuO8V';
const AIRTABLE_TABLE_ID = 'tbl7VNgU72EqLveWX'; // "Musicians Database"

const FIELDS = [
  'Musicians Name',
  'Role',
  'Type',
  'Country',
  'Main Genres (3 max)',
  'Email (NO BERKLEE EMAIL)',
  'Cellphone',
  'Payment',
];

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

// Airtable's real REST API returns singleSelect/multipleSelects as plain
// strings (just the option name) — handle an {id,name,color} object too in
// case that ever changes, but plain strings are the actual live format.
function selectName(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'name' in (v as Record<string, unknown>)) {
    return (v as { name: string }).name;
  }
  return null;
}
function multiSelectNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(selectName).filter((n): n is string => !!n);
  return [];
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

    // Pull every row from Airtable, following pagination (max 100/page).
    const records: any[] = [];
    let offset: string | undefined;
    do {
      const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`);
      FIELDS.forEach((f) => url.searchParams.append('fields[]', f));
      url.searchParams.set('pageSize', '100');
      if (offset) url.searchParams.set('offset', offset);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${airtableToken}` } });
      if (!res.ok) return json({ error: `Airtable error: ${await res.text()}` }, 502);
      const page = await res.json();
      records.push(...page.records);
      offset = page.offset;
    } while (offset);

    const rows = records
      .map((r) => {
        const f = r.fields;
        const full_name = f['Musicians Name']?.trim();
        if (!full_name) return null; // skip rows with no name — nothing usable to invite
        return {
          airtable_record_id: r.id,
          full_name,
          instruments: multiSelectNames(f['Role']),
          type: selectName(f['Type']),
          country: f['Country'] || null,
          main_genres: f['Main Genres (3 max)'] || null,
          email: f['Email (NO BERKLEE EMAIL)'] || null,
          phone: f['Cellphone'] || null,
          payment: f['Payment'] || null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const { error: upsertErr } = await adminClient
      .from('musicians')
      .upsert(rows, { onConflict: 'airtable_record_id' });
    if (upsertErr) return json({ error: upsertErr.message }, 500);

    return json({ ok: true, synced: rows.length });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
