// Pack & Ship backend (ShipBay staff only). Buys labels through Veeqo's Rate Shopping API using the client's connected
// Veeqo key (Systems → Shipping label access → Veeqo), or ShipBay's own VEEQO_API_KEY from platform_secrets as a fallback.
//
// POST actions:
//   rates      { order_id, parcel:{ weight_oz, length, width, height } }                      → { quotes, remote_shipment_id, request_token, expires_at }
//   buy        { order_id, remote_shipment_id, rate_id, request_token, options?, parcel, packaging?, label_format? }
//              → books, stores the 4×6 label in bucket `labels`, calls ship_order(), pushes tracking to Shopify → { shipment_id, tracking, label_url, ... }
//   manual     { order_id, carrier, service?, tracking, label_cost?, packaging?, weight_oz? }  → ship_order() + Shopify tracking (label bought elsewhere)
//   label_url  { shipment_id }                                                                → { label_url } (15-minute signed link)
// Deploy: supabase functions deploy labels
import { createClient } from 'npm:@supabase/supabase-js@2';
import { veeqoMarkShipped } from '../_shared/veeqo_orders.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const VEEQO = 'https://api.veeqo.com/shipping/api/v1';
const SHIPBAY_FROM = { name: 'ShipBay 3PL', company: 'ShipBay 3PL', phone: '+17327836604', email: 'derekh@shipbay3pl.com', line1: '115 Stryker Ln', line2: 'Unit 10', town: 'Hillsborough Township', postcode: '08844', country_code: 'US', county: 'NJ' };

const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });
const err = (m: string, status = 400) => json({ error: m }, status);
const phoneE164 = (p?: string | null) => { const d = String(p ?? '').replace(/\D/g, ''); return !d ? undefined : d.length === 10 ? `+1${d}` : `+${d}`; };

// Shopify shipping_address → Veeqo address
function toAddress(a: any) {
  return { name: a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Customer', company: a.company || undefined, phone: phoneE164(a.phone),
    line1: a.address1, line2: a.address2 || undefined, town: a.city, postcode: a.zip, country_code: a.country_code || 'US', county: a.province_code || a.province || undefined };
}
// orgs.ship_from_address (ClientSettings shape) → Veeqo address; falls back to the ShipBay warehouse
function fromAddress(org: any) {
  const s = org?.ship_from_address;
  if (!s?.line1 || !s?.city || !s?.zip) return SHIPBAY_FROM;
  return { name: s.name || org.name, company: s.company || org.name, phone: phoneE164(s.phone || org.contact_phone) || SHIPBAY_FROM.phone, email: org.contact_email || SHIPBAY_FROM.email,
    line1: s.line1, line2: s.line2 || undefined, town: s.city, postcode: s.zip, country_code: s.country || 'US', county: s.state || undefined };
}
const trackingUrl = (carrier: string, t: string) => {
  const c = carrier.toLowerCase();
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${t}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`;
  if (c.includes('amazon')) return `https://track.amazon.com/tracking/${t}`;
  return null;
};
const shopifyCompany = (carrier: string) => { const c = carrier.toLowerCase(); return c.includes('usps') ? 'USPS' : c.includes('ups') ? 'UPS' : c.includes('fedex') ? 'FedEx' : c.includes('dhl') ? 'DHL Express' : c.includes('amazon') ? 'Amazon Logistics' : carrier; };

async function veeqoKey(orgId: string): Promise<string | null> {
  const { data: integ } = await admin.from('integrations').select('id').eq('org_id', orgId).eq('provider', 'veeqo').eq('status', 'connected').maybeSingle();
  if (integ) { const { data: s } = await admin.from('integration_secrets').select('secrets').eq('integration_id', integ.id).maybeSingle(); if (s?.secrets?.api_key) return s.secrets.api_key; }
  const { data: p } = await admin.from('platform_secrets').select('value').eq('key', 'VEEQO_API_KEY').maybeSingle();
  return p?.value || Deno.env.get('VEEQO_API_KEY') || null;
}
async function veeqo(key: string, path: string, body: unknown) {
  const r = await fetch(`${VEEQO}${path}`, { method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  const text = await r.text(); let data: any = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, data, text };
}
const veeqoErr = (r: { status: number; data: any; text: string }) =>
  r.status === 401 || r.status === 403 ? `Veeqo rejected the API key (HTTP ${r.status}). Reconnect Veeqo under Systems with a fresh key from Settings → Users.` :
  (r.data?.error_messages?.join(' ') || r.data?.error || `Veeqo returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);

async function loadOrder(orderId: string) {
  const { data: o } = await admin.from('orders').select('*, lines:order_lines(*)').eq('id', orderId).single();
  if (!o) throw new Error('order not found');
  const { data: org } = await admin.from('orgs').select('id, name, contact_phone, contact_email, ship_from_address, shopify_domain').eq('id', o.org_id).single();
  return { o, org };
}

// Push tracking to Shopify (so Mirakl Connect relays it to the marketplace). Never fails the ship.
async function shopifyFulfill(shipmentId: string) {
  try {
    const { data: sh } = await admin.from('shipments').select('id, org_id, carrier, tracking, tracking_url, order:orders(id, shopify_order_id)').eq('id', shipmentId).single();
    if (!sh?.order?.shopify_order_id) return { skipped: 'not a shopify order' };
    const { data: org } = await admin.from('orgs').select('shopify_domain').eq('id', sh.org_id).single();
    const { data: integ } = await admin.from('org_integrations').select('shopify_access_token').eq('org_id', sh.org_id).maybeSingle();
    if (!org?.shopify_domain || !integ?.shopify_access_token) return { skipped: 'shopify not connected' };
    const H = { 'X-Shopify-Access-Token': integ.shopify_access_token, 'Content-Type': 'application/json' };
    const base = `https://${org.shopify_domain}/admin/api/2025-07`;
    const fo = await fetch(`${base}/orders/${sh.order.shopify_order_id}/fulfillment_orders.json`, { headers: H }).then((r) => r.json());
    const open = (fo.fulfillment_orders ?? []).filter((f: any) => ['open', 'in_progress', 'scheduled'].includes(f.status));
    if (!open.length) return { skipped: 'no open fulfillment orders' };
    const body = { fulfillment: { line_items_by_fulfillment_order: open.map((f: any) => ({ fulfillment_order_id: f.id })),
      tracking_info: { number: sh.tracking, company: shopifyCompany(sh.carrier || ''), url: sh.tracking_url || undefined }, notify_customer: true } };
    const res = await fetch(`${base}/fulfillments.json`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) return { error: JSON.stringify(j.errors ?? j).slice(0, 300) };
    await admin.from('shipments').update({ shopify_fulfillment_id: j.fulfillment?.id }).eq('id', sh.id);
    return { ok: true, fulfillment_id: j.fulfillment?.id };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

// Push tracking back to wherever the order came from (Shopify webhook/token path, or Veeqo). Never fails the ship.
async function channelUpdate(shipId: string, o: any, key: string | null, carrier: string, tracking: string, service?: string | null) {
  if (o.channel === 'veeqo' && o.veeqo_order_id) { const r = key ? await veeqoMarkShipped(key, o.raw, carrier, tracking, service) : { skipped: 'no veeqo key' }; return { channel: 'veeqo', ...r }; }
  if (o.shopify_order_id) { const r = await shopifyFulfill(shipId); return { channel: 'shopify', ...r }; }
  return { channel: o.channel || 'manual', skipped: 'manual order — nothing to update' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') ?? '';
  const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: isStaff } = await user.rpc('is_shipbay');
  if (!isStaff) return err('not authorized', 403);
  const b = await req.json().catch(() => ({}));

  try {
    if (b.action === 'label_url') {
      const { data: sh } = await admin.from('shipments').select('label_path').eq('id', b.shipment_id).single();
      if (!sh?.label_path) return err('No label stored for this shipment.', 404);
      const { data } = await admin.storage.from('labels').createSignedUrl(sh.label_path, 900);
      return json({ label_url: data?.signedUrl });
    }

    const { o, org } = await loadOrder(b.order_id);
    if (['shipped', 'cancelled'].includes(o.status)) return err(`This order is already ${o.status}.`, 409);
    if (!o.ship_to?.address1) return err('This order has no shipping address.');

    if (b.action === 'manual') {
      if (!b.carrier || !b.tracking) return err('Carrier and tracking number are required.');
      const { data: shipId, error } = await user.rpc('ship_order', { p_order_id: o.id, p_carrier: b.carrier, p_service: b.service || null, p_tracking: String(b.tracking).trim(), p_label_source: 'manual', p_label_cost: b.label_cost ?? null, p_packaging: b.packaging || null, p_weight_oz: b.weight_oz ?? null });
      if (error) return err(error.message, 500);
      await admin.from('shipments').update({ provider: 'manual', tracking_url: trackingUrl(b.carrier, String(b.tracking).trim()) }).eq('id', shipId);
      const shopify = await channelUpdate(shipId, o, await veeqoKey(o.org_id), b.carrier, String(b.tracking).trim(), b.service || null);
      return json({ shipment_id: shipId, tracking: String(b.tracking).trim(), shopify });
    }

    const key = await veeqoKey(o.org_id);
    if (!key) return err('Veeqo isn’t connected for this client. Connect it under Onboarding → Systems → Shipping label access (Veeqo API key), or add VEEQO_API_KEY on the Integrations page.', 409);
    const p = b.parcel ?? {};
    const weightOz = Number(p.weight_oz);
    if (!(weightOz > 0)) return err('Enter the packed weight first.');
    const parcel: any = { weight: Math.round(weightOz * 100) / 100, weight_unit: 'oz', dimension_unit: 'in' };
    if (p.length && p.width && p.height) Object.assign(parcel, { length: Number(p.length), width: Number(p.width), height: Number(p.height) });

    if (b.action === 'rates') {
      const intl = !!o.is_international;
      const lines = (o.lines ?? []).filter((l: any) => l.is_physical && l.qty > 0);
      const rawLines: any[] = o.raw?.line_items ?? [];
      const req_: any = {
        to_address: toAddress(o.ship_to), from_address: fromAddress(org), parcels: [parcel],
        customer_reference: o.order_number, seller_display_name: org.name, contents: 'Merchandise', currency_code: 'USD', include_unavailable_quotes: false,
      };
      if (o.ship_by) req_.due_date = `${o.ship_by}T23:59:59Z`;
      const value = rawLines.reduce((s, li) => s + Number(li.price ?? li.price_per_unit ?? 0) * Number(li.quantity ?? 0), 0);
      if (value > 0) req_.estimated_value = value.toFixed(2);
      if (intl) req_.channel_items = lines.map((l: any) => { const rl = rawLines.find((x) => String(x.id) === String(l.shopify_line_id ?? l.veeqo_line_id)); return { description: String(l.name).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 40) || 'Merchandise', quantity: l.qty, value: rl ? Number(rl.price ?? rl.price_per_unit ?? 0).toFixed(2) : undefined, currency_code: 'USD' }; });
      const r = await veeqo(key, '/rates', req_);
      if (!r.ok) return err(veeqoErr(r), 502);
      const quotes = (r.data.quotes ?? []).map((q: any) => ({ rate_id: q.rate_id, carrier: q.carrier_id || q.carrier_nice_name || q.service_carrier || q.carrier, service_name: q.service_name, service_id: q.service_id,
        total_charge: Number(q.total_charge), delivery_date: q.delivery_estimate || q.delivery_date || null, meets_promise: q.meets_delivery_promise ?? null, options: q.shipping_service_options ?? [] }))
        .sort((a: any, b2: any) => a.total_charge - b2.total_charge);
      return json({ quotes, remote_shipment_id: r.data.remote_shipment_id, request_token: r.data.request_token, expires_at: r.data.expires_at, from: req_.from_address, to: req_.to_address });
    }

    if (b.action === 'buy') {
      if (!b.remote_shipment_id || !b.rate_id) return err('Pick a rate first.');
      const fmt = (b.label_format || 'PDF').toUpperCase();
      const shipment: any = { remote_shipment_id: b.remote_shipment_id, rate_id: b.rate_id, ...(b.options ?? {}) };
      const r = await veeqo(key, '/shipments', { label_format: fmt, request_token: b.request_token, shipments: [shipment] });
      if (!r.ok) return err(veeqoErr(r), 502);
      const ok = r.data?.successful?.[b.remote_shipment_id] ?? Object.values(r.data?.successful ?? {})[0] as any;
      if (!ok) { const f = r.data?.failed?.[b.remote_shipment_id] ?? Object.values(r.data?.failed ?? {})[0] as any; return err((f?.error_messages ?? f?.errors ?? ['Veeqo could not book that rate.']).join(' '), 502); }

      const carrier = ok.carrier_id || ok.service_carrier || 'carrier';
      const tracking = ok.tracking_number;
      const cost = ok.total_charge?.value ?? null;
      const { data: shipId, error } = await user.rpc('ship_order', { p_order_id: o.id, p_carrier: carrier, p_service: ok.service_name || null, p_tracking: tracking, p_label_source: 'veeqo', p_label_cost: cost, p_packaging: b.packaging || null, p_weight_oz: weightOz });
      if (error) return json({ error: `Label was bought (tracking ${tracking}) but the order could not be marked shipped: ${error.message}`, tracking }, 500);

      // store the label (base64 → bytes) in the private labels bucket
      let label_path: string | null = null;
      if (ok.label_content) {
        const bytes = Uint8Array.from(atob(ok.label_content), (c) => c.charCodeAt(0));
        const ext = fmt === 'ZPL' ? 'zpl' : fmt === 'PNG' ? 'png' : fmt === 'JPEG' ? 'jpg' : 'pdf';
        label_path = `${o.org_id}/${o.id}/${tracking}.${ext}`;
        const { error: upErr } = await admin.storage.from('labels').upload(label_path, bytes, { contentType: ext === 'pdf' ? 'application/pdf' : ext === 'zpl' ? 'text/plain' : `image/${ext === 'jpg' ? 'jpeg' : ext}`, upsert: true });
        if (upErr) label_path = null;
        for (const d of ok.documents ?? []) { try { await admin.storage.from('labels').upload(`${o.org_id}/${o.id}/${tracking}-${String(d.type).toLowerCase()}.pdf`, Uint8Array.from(atob(d.content), (c) => c.charCodeAt(0)), { contentType: 'application/pdf', upsert: true }); } catch { /* optional docs */ } }
      }
      await admin.from('shipments').update({ provider: 'veeqo', provider_ref: ok.external_shipment_id || b.remote_shipment_id, label_path, tracking_url: trackingUrl(carrier, tracking),
        rate: { rate_id: b.rate_id, service_id: ok.service_id, service_name: ok.service_name, carrier, total_charge: ok.total_charge, charges: ok.charges, signature_type: ok.signature_type, label_format: fmt } }).eq('id', shipId);
      const shopify = await channelUpdate(shipId, o, key, carrier, tracking, ok.service_name || null);
      let label_url: string | null = null;
      if (label_path) { const { data } = await admin.storage.from('labels').createSignedUrl(label_path, 900); label_url = data?.signedUrl ?? null; }
      return json({ shipment_id: shipId, tracking, carrier, service: ok.service_name, cost, label_url, label_format: fmt, shopify });
    }
    return err('unknown action');
  } catch (e) { return err(String(e?.message ?? e), 500); }
});
