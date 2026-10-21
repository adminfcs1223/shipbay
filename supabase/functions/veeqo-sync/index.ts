// Pulls a client's open orders from Veeqo into the warehouse queue. Used when a client's order channel is Veeqo
// (Orders → brand → Order settings). Staff only.
// Body: { action: 'backfill', org_id }  → { imported, updated, total, closed }
// Deploy: supabase functions deploy veeqo-sync
import { createClient } from 'npm:@supabase/supabase-js@2';
import { veeqoGet, upsertVeeqoOrder } from '../_shared/veeqo_orders.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };

async function veeqoKey(orgId: string): Promise<string | null> {
  const { data: integ } = await admin.from('integrations').select('id').eq('org_id', orgId).eq('provider', 'veeqo').eq('status', 'connected').maybeSingle();
  if (integ) { const { data: s } = await admin.from('integration_secrets').select('secrets').eq('integration_id', integ.id).maybeSingle(); if (s?.secrets?.api_key) return s.secrets.api_key; }
  const { data: p } = await admin.from('platform_secrets').select('value').eq('key', 'VEEQO_API_KEY').maybeSingle();
  return p?.value || Deno.env.get('VEEQO_API_KEY') || null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: isStaff } = await userClient.rpc('is_shipbay');
  if (!isStaff) return Response.json({ error: 'not authorized' }, { status: 403, headers: cors });
  const b = await req.json().catch(() => ({}));
  if (b.action !== 'backfill' || !b.org_id) return Response.json({ error: 'unknown action' }, { status: 400, headers: cors });
  const key = await veeqoKey(b.org_id);
  if (!key) return Response.json({ error: 'Veeqo isn’t connected for this client — connect it under Onboarding → Systems → Shipping label access.' }, { status: 409, headers: cors });
  try {
    let imported = 0, updated = 0, total = 0;
    for (const status of ['awaiting_fulfillment', 'on_hold', 'awaiting_stock']) {
      for (let page = 1; page <= 20; page++) {
        const list = await veeqoGet(key, `/orders?status=${status}&page_size=100&page=${page}`);
        if (!Array.isArray(list) || !list.length) break;
        for (const o of list) { total++; const r = await upsertVeeqoOrder(admin, b.org_id, o); if (r.created) imported++; else updated++; }
        if (list.length < 100) break;
      }
    }
    // orders we hold open that Veeqo has since shipped or cancelled elsewhere
    const { data: open } = await admin.from('orders').select('id, veeqo_order_id').eq('org_id', b.org_id).eq('channel', 'veeqo').in('status', ['new', 'on_hold', 'backordered', 'picked', 'packed']).not('veeqo_order_id', 'is', null).limit(300);
    let closed = 0;
    for (const o of open ?? []) {
      try { const v = await veeqoGet(key, `/orders/${o.veeqo_order_id}`); if (v && ['shipped', 'cancelled'].includes(String(v.status))) { await upsertVeeqoOrder(admin, b.org_id, v); closed++; } } catch { /* leave it */ }
    }
    return Response.json({ imported, updated, total, closed }, { headers: cors });
  } catch (e) { return Response.json({ error: String(e?.message ?? e) }, { status: 502, headers: cors }); }
});
