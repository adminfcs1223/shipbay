// Veeqo order → orders/order_lines mapping. Veeqo aggregates a brand's Shopify + marketplace orders, so for a client who
// keeps Shopify out of the picture (Steel Horse) this is the single order feed. Main Veeqo API: https://api.veeqo.com
// (x-api-key). Orders we care about are `awaiting_fulfillment`; `on_hold` lands in the hold tab.
import { MARKETPLACE_TAGS } from './shopify_orders.ts';

export const VEEQO_API = 'https://api.veeqo.com';

export async function veeqoGet(key: string, path: string) {
  const r = await fetch(`${VEEQO_API}${path}`, { headers: { 'x-api-key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(40000) });
  const text = await r.text(); let data: any = null; try { data = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `Veeqo rejected the API key (HTTP ${r.status}).` : `Veeqo HTTP ${r.status}: ${text.slice(0, 200)}`);
  return data;
}

function marketplaceFor(o: any): { marketplace: string | null; source: string } {
  const ch = String(o.channel?.name ?? '').toLowerCase();
  const type = String(o.channel?.type_code ?? '').toLowerCase();
  for (const [k, v] of Object.entries(MARKETPLACE_TAGS)) if (ch.includes(k)) return { marketplace: v, source: 'mirakl' };
  for (const t of o.tags ?? []) { const low = String(t.name ?? t).toLowerCase(); if (MARKETPLACE_TAGS[low]) return { marketplace: MARKETPLACE_TAGS[low], source: 'mirakl' }; }
  if (type.includes('amazon')) return { marketplace: 'Amazon', source: 'marketplace' };
  if (type.includes('ebay')) return { marketplace: 'eBay', source: 'marketplace' };
  if (type.includes('etsy')) return { marketplace: 'Etsy', source: 'marketplace' };
  if (type.includes('walmart')) return { marketplace: 'Walmart', source: 'marketplace' };
  if (type.includes('shopify')) return { marketplace: null, source: 'online_store' };
  return { marketplace: null, source: type || 'veeqo' };
}

export function statusForVeeqo(o: any): string {
  const s = String(o.status ?? '').toLowerCase();
  if (s === 'cancelled') return 'cancelled';
  if (s === 'shipped') return 'shipped';
  if (s === 'on_hold' || s === 'awaiting_payment') return 'on_hold';
  if (s === 'awaiting_stock') return 'backordered';
  return 'new';
}

export async function upsertVeeqoOrder(supabase: any, orgId: string, o: any): Promise<{ id: string; created: boolean }> {
  const d = o.deliver_to ?? {};
  const name = [d.first_name, d.last_name].filter(Boolean).join(' ') || d.company || o.customer?.full_name || 'Customer';
  const country = String(d.country ?? 'US').toUpperCase();
  const ship_to = { name, company: d.company || null, address1: d.address1, address2: d.address2 || null, city: d.city, province: d.state, province_code: d.state, zip: d.zip, country: country, country_code: country.length === 2 ? country : 'US', phone: d.phone || o.customer?.phone || null };
  const lines = (o.line_items ?? []).filter((li: any) => li.sellable);
  const totalUnits = lines.reduce((s: number, li: any) => s + Number(li.quantity ?? 0), 0);
  const { marketplace, source } = marketplaceFor(o);
  const tags = (o.tags ?? []).map((t: any) => String(t.name ?? t)).filter(Boolean);
  const due = o.due_date || o.deliver_by || null;
  const base: any = {
    org_id: orgId, veeqo_order_id: o.id, order_number: String(o.number ?? o.id), channel: 'veeqo', source, marketplace,
    ship_by: due ? String(due).slice(0, 10) : null, customer_name: name, customer_email: o.customer?.email ?? d.email ?? null, ship_to,
    shipping_method: o.delivery_method?.name ?? null, is_international: ship_to.country_code !== 'US', placed_at: o.created_at, total_units: totalUnits,
    tags: [o.channel?.name, ...tags].filter(Boolean), notes: o.customer_note || o.employee_notes?.map((n: any) => n.text).join(' · ') || null, raw: o,
  };
  const st = statusForVeeqo(o);
  const { data: existing } = await supabase.from('orders').select('id,status').eq('org_id', orgId).eq('veeqo_order_id', o.id).maybeSingle();
  let orderId: string; let created = false;
  if (existing) {
    const upd: any = { ...base }; delete upd.placed_at;
    // never regress a shipped order; keep the warehouse's picked/packed state unless Veeqo says cancelled or shipped elsewhere
    if (existing.status !== 'shipped' && existing.status !== 'cancelled') {
      if (st === 'cancelled' || st === 'shipped' || ['new', 'on_hold', 'backordered'].includes(existing.status)) upd.status = st;
    }
    const { error } = await supabase.from('orders').update(upd).eq('id', existing.id); if (error) throw error;
    orderId = existing.id;
  } else {
    base.status = st; base.received_at = new Date().toISOString();
    const { data, error } = await supabase.from('orders').insert(base).select('id').single(); if (error) throw error;
    orderId = data.id; created = true;
  }
  const { data: skus } = await supabase.from('skus').select('id, sku').eq('org_id', orgId);
  const bySku = new Map((skus ?? []).map((s: any) => [s.sku, s.id]));
  const rows: any[] = [];
  for (const li of lines) {
    const code = li.sellable?.sku_code ?? null;
    let skuId = code ? bySku.get(code) : undefined;
    if (!skuId && code) {
      const { data: ns } = await supabase.from('skus').insert({ org_id: orgId, sku: code, name: li.sellable?.product_title ?? code, variant: li.sellable?.title && li.sellable.title !== li.sellable.product_title ? li.sellable.title : null, barcode: li.sellable?.upc_code || null, weight_oz: li.sellable?.weight_grams ? Math.round((Number(li.sellable.weight_grams) / 28.3495) * 100) / 100 : null, active: true }).select('id').single();
      skuId = ns?.id; if (skuId) bySku.set(code, skuId);
    }
    rows.push({ order_id: orderId, sku_id: skuId ?? null, sku: code, name: [li.sellable?.product_title, li.sellable?.title && li.sellable.title !== li.sellable.product_title ? li.sellable.title : null].filter(Boolean).join(' — ') || code || 'Item', qty: Number(li.quantity ?? 1), veeqo_line_id: li.id, is_physical: true });
  }
  if (!created) {
    // keep verified counts: only touch lines when the set changed
    const { data: cur } = await supabase.from('order_lines').select('id, veeqo_line_id, qty').eq('order_id', orderId);
    const same = (cur ?? []).length === rows.length && rows.every((r) => (cur ?? []).some((c: any) => String(c.veeqo_line_id) === String(r.veeqo_line_id) && c.qty === r.qty));
    if (same) return { id: orderId, created };
    await supabase.from('order_lines').delete().eq('order_id', orderId);
  }
  if (rows.length) { const { error } = await supabase.from('order_lines').insert(rows); if (error) throw error; }
  return { id: orderId, created };
}

/** After we ship: tell Veeqo (which relays to Shopify / the marketplace). Never throws. */
export async function veeqoMarkShipped(key: string, raw: any, carrier: string, tracking: string, service?: string | null) {
  try {
    if (!raw?.id) return { skipped: 'no veeqo order' };
    const allocation = raw.allocations?.[0]?.id;
    if (!allocation) return { skipped: 'no allocation on the Veeqo order' };
    const carriers = await veeqoGet(key, '/carriers');
    const c = (carriers ?? []).find((x: any) => String(x.name ?? '').toLowerCase().includes(carrier.toLowerCase().split(' ')[0])) ?? (carriers ?? []).find((x: any) => /other|manual/i.test(x.name ?? ''));
    const body = { shipment: { order_id: raw.id, allocation_id: allocation, carrier_id: c?.id, notify_customer: true, update_remote_order: true, tracking_number_attributes: { tracking_number: tracking }, carrier_service: service ?? undefined } };
    const r = await fetch(`${VEEQO_API}/shipments`, { method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: JSON.stringify(j).slice(0, 300) };
    return { ok: true, shipment_id: j.id };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}
