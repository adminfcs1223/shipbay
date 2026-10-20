// Called by the portal (ShipBay staff only) after ship_order(): pushes a fulfillment with tracking to Shopify.
// Body: { shipment_id }
// Deploy: supabase functions deploy shopify-fulfill
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: isStaff } = await userClient.rpc('is_shipbay');
  if (!isStaff) return Response.json({ error: 'not authorized' }, { status: 403, headers: cors });

  const { shipment_id } = await req.json();
  const { data: sh } = await admin.from('shipments').select('id, org_id, carrier, service, tracking, order:orders(id, shopify_order_id)').eq('id', shipment_id).single();
  if (!sh?.order?.shopify_order_id) return Response.json({ skipped: 'not a shopify order' }, { headers: cors });
  const { data: org } = await admin.from('orgs').select('shopify_domain').eq('id', sh.org_id).single();
  const { data: integ } = await admin.from('org_integrations').select('shopify_access_token').eq('org_id', sh.org_id).single();
  if (!org?.shopify_domain || !integ?.shopify_access_token) return Response.json({ skipped: 'shopify not connected' }, { headers: cors });

  const H = { 'X-Shopify-Access-Token': integ.shopify_access_token, 'Content-Type': 'application/json' };
  const base = `https://${org.shopify_domain}/admin/api/2025-07`;
  const fo = await fetch(`${base}/orders/${sh.order.shopify_order_id}/fulfillment_orders.json`, { headers: H }).then(r => r.json());
  const open = (fo.fulfillment_orders ?? []).filter((f: any) => ['open', 'in_progress'].includes(f.status));
  if (!open.length) return Response.json({ skipped: 'no open fulfillment orders' }, { headers: cors });

  const body = { fulfillment: {
    line_items_by_fulfillment_order: open.map((f: any) => ({ fulfillment_order_id: f.id })),
    tracking_info: { number: sh.tracking, company: sh.carrier },
    notify_customer: true,
  } };
  const res = await fetch(`${base}/fulfillments.json`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) return Response.json({ error: json }, { status: 502, headers: cors });
  await admin.from('shipments').update({ shopify_fulfillment_id: json.fulfillment?.id }).eq('id', sh.id);
  return Response.json({ ok: true, fulfillment_id: json.fulfillment?.id }, { headers: cors });
});
