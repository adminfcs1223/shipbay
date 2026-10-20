// Pulls open, unfulfilled orders from a connected Shopify store into the warehouse queue (same mapping as the webhook).
// Runs on connect and from the Orders page "Sync from Shopify" button. Staff only.
// Body: { action: 'backfill', org_id }   → { imported, updated, total }
// Deploy: supabase functions deploy shopify-sync
import { createClient } from 'npm:@supabase/supabase-js@2';
import { upsertShopifyOrder } from '../_shared/shopify_orders.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const API = '2025-07';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: isStaff } = await userClient.rpc('is_shipbay');
  if (!isStaff) return Response.json({ error: 'not authorized' }, { status: 403, headers: cors });

  const body = await req.json().catch(() => ({}));
  if (body.action !== 'backfill' || !body.org_id) return Response.json({ error: 'bad request' }, { status: 400, headers: cors });

  const { data: org } = await admin.from('orgs').select('id, shopify_domain').eq('id', body.org_id).single();
  const { data: integ } = await admin.from('org_integrations').select('shopify_access_token').eq('org_id', body.org_id).maybeSingle();
  if (!org?.shopify_domain || !integ?.shopify_access_token) return Response.json({ error: 'Shopify isn’t connected for this client yet.' }, { status: 409, headers: cors });

  const H = { 'X-Shopify-Access-Token': integ.shopify_access_token, 'Content-Type': 'application/json' };
  let url: string | null = `https://${org.shopify_domain}/admin/api/${API}/orders.json?status=open&fulfillment_status=unfulfilled&limit=250`;
  let imported = 0, updated = 0, total = 0; const errors: string[] = [];
  while (url) {
    const res = await fetch(url, { headers: H });
    if (!res.ok) return Response.json({ error: `Shopify returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }, { status: 502, headers: cors });
    const json = await res.json();
    for (const o of json.orders ?? []) {
      total++;
      try { const r = await upsertShopifyOrder(admin, org.id, o, 'orders/updated'); if (r.created) imported++; else updated++; }
      catch (e) { errors.push(`${o.name}: ${String(e?.message ?? e)}`); }
    }
    const link = res.headers.get('link') ?? '';
    const next = link.split(',').map((s) => s.trim()).find((s) => s.endsWith('rel="next"'));
    url = next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null;
  }
  await admin.from('webhook_log').insert({ source: 'shopify', topic: 'backfill', shop_domain: org.shopify_domain, org_id: org.id, status: errors.length ? 'error' : 'ok', error: errors.join('; ') || null }).then(() => {}, () => {});
  return Response.json({ imported, updated, total, errors }, { headers: cors });
});
