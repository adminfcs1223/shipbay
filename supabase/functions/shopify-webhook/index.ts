// Shopify webhook ingest: orders/create, orders/updated, orders/cancelled, orders/paid
// URL: https://dashboard.shipbay3pl.com/webhooks/shopify  (Netlify proxy → this function)
// Deploy: supabase functions deploy shopify-webhook --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';
import { upsertShopifyOrder } from '../_shared/shopify_orders.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function hmacValid(secret: string, raw: string, header: string | null) {
  if (!header) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return btoa(String.fromCharCode(...new Uint8Array(sig))) === header;
}

async function log(row: Record<string, unknown>) { try { await supabase.from('webhook_log').insert(row); } catch { /* never fail the webhook on logging */ } }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 });
  const raw = await req.text();
  const shop = req.headers.get('x-shopify-shop-domain') ?? '';
  const topic = req.headers.get('x-shopify-topic') ?? '';
  const base_log = { source: 'shopify', topic, shop_domain: shop };

  const { data: org } = await supabase.from('orgs').select('id').eq('shopify_domain', shop).maybeSingle();
  if (!org) { await log({ ...base_log, status: 'rejected', error: 'unknown shop' }); return new Response('unknown shop', { status: 404 }); }
  const { data: integ } = await supabase.from('org_integrations').select('shopify_webhook_secret').eq('org_id', org.id).maybeSingle();
  if (!integ?.shopify_webhook_secret || !(await hmacValid(integ.shopify_webhook_secret, raw, req.headers.get('x-shopify-hmac-sha256')))) {
    await log({ ...base_log, org_id: org.id, status: 'rejected', error: 'bad signature' });
    return new Response('bad signature', { status: 401 });
  }

  let o: any;
  try { o = JSON.parse(raw); } catch { await log({ ...base_log, org_id: org.id, status: 'error', error: 'invalid json' }); return new Response('bad json', { status: 400 }); }
  try {
    await upsertShopifyOrder(supabase, org.id, o, topic);
    await log({ ...base_log, org_id: org.id, external_id: String(o.id), status: 'ok' });
    return new Response('ok', { status: 200 });
  } catch (e) {
    await log({ ...base_log, org_id: org.id, external_id: String(o?.id), status: 'error', error: String(e?.message ?? e), payload: o });
    return new Response('error', { status: 500 });
  }
});
