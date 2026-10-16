// Shopify webhook ingest: orders/create, orders/updated, orders/cancelled, orders/paid
// URL: https://<project>.supabase.co/functions/v1/shopify-webhook
// Deploy: supabase functions deploy shopify-webhook --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function hmacValid(secret: string, raw: string, header: string | null) {
  if (!header) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return btoa(String.fromCharCode(...new Uint8Array(sig))) === header;
}

function statusFor(o: any, topic: string): string | null {
  if (topic === 'orders/cancelled' || o.cancelled_at) return 'cancelled';
  if (o.fulfillment_status === 'fulfilled') return 'shipped';
  if (o.financial_status && !['paid', 'partially_refunded', 'authorized'].includes(o.financial_status)) return 'on_hold';
  return null;
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
  const addr = o.shipping_address ?? {};
  const isIntl = !!addr.country_code && addr.country_code !== 'US';
  const physical = (o.line_items ?? []).filter((li: any) => li.requires_shipping !== false);
  const totalUnits = physical.reduce((s: number, li: any) => s + (li.fulfillable_quantity ?? li.quantity ?? 0), 0);

  const base: any = {
    org_id: org.id, shopify_order_id: o.id, order_number: o.name ?? `#${o.order_number}`, channel: 'shopify',
    customer_name: addr.name ?? [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' '),
    customer_email: o.email ?? o.contact_email, ship_to: addr, shipping_method: o.shipping_lines?.[0]?.title ?? null,
    is_international: isIntl, placed_at: o.created_at, total_units: totalUnits,
    tags: (o.tags ?? '').split(',').map((t: string) => t.trim()).filter(Boolean), notes: o.note ?? null, raw: o,
  };
  const st = statusFor(o, topic);

  try {
    const { data: existing } = await supabase.from('orders').select('id,status').eq('org_id', org.id).eq('shopify_order_id', o.id).maybeSingle();
    let orderId: string;
    if (existing) {
      const upd: any = { ...base }; delete upd.placed_at;
      if (st && existing.status !== 'shipped') upd.status = st;
      const { error } = await supabase.from('orders').update(upd).eq('id', existing.id); if (error) throw error;
      orderId = existing.id;
    } else {
      base.status = st ?? 'new'; base.received_at = new Date().toISOString();
      const { data, error } = await supabase.from('orders').insert(base).select('id').single(); if (error) throw error;
      orderId = data.id;
    }

    const { data: skus } = await supabase.from('skus').select('id, sku, shopify_variant_id').eq('org_id', org.id);
    const bySku = new Map((skus ?? []).map((s: any) => [s.sku, s.id]));
    const byVariant = new Map((skus ?? []).filter((s: any) => s.shopify_variant_id).map((s: any) => [String(s.shopify_variant_id), s.id]));
    const lines: any[] = [];
    for (const li of o.line_items ?? []) {
      let skuId = byVariant.get(String(li.variant_id)) ?? (li.sku ? bySku.get(li.sku) : undefined);
      if (!skuId && li.sku && li.requires_shipping !== false) {
        const { data: ns } = await supabase.from('skus').insert({ org_id: org.id, sku: li.sku, name: li.title, variant: li.variant_title, shopify_product_id: li.product_id, shopify_variant_id: li.variant_id, active: false }).select('id').single();
        skuId = ns?.id; if (skuId) bySku.set(li.sku, skuId);
      }
      lines.push({ order_id: orderId, sku_id: skuId ?? null, sku: li.sku ?? null, name: li.title + (li.variant_title ? ` — ${li.variant_title}` : ''), qty: li.quantity, shopify_line_id: li.id, is_physical: li.requires_shipping !== false });
    }
    // Replace line set via upsert on shopify_line_id; stale lines (removed in Shopify) are zeroed rather than deleted
    if (lines.length) {
      const { data: current } = await supabase.from('order_lines').select('id, shopify_line_id').eq('order_id', orderId);
      const keep = new Set(lines.map((l) => String(l.shopify_line_id)));
      for (const c of current ?? []) if (!keep.has(String(c.shopify_line_id))) await supabase.from('order_lines').update({ qty: 0 }).eq('id', c.id);
      for (const l of lines) {
        const ex = (current ?? []).find((c: any) => String(c.shopify_line_id) === String(l.shopify_line_id));
        if (ex) await supabase.from('order_lines').update(l).eq('id', ex.id); else await supabase.from('order_lines').insert(l);
      }
    }
    await log({ ...base_log, org_id: org.id, external_id: String(o.id), status: 'ok' });
    return new Response('ok', { status: 200 });
  } catch (e) {
    await log({ ...base_log, org_id: org.id, external_id: String(o?.id), status: 'error', error: String(e?.message ?? e), payload: o });
    return new Response('error', { status: 500 });
  }
});
