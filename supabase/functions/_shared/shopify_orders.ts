// Shared Shopify order → orders/order_lines mapping. Used by the live webhook (shopify-webhook) and the open-order
// backfill (shopify-sync) so both paths write identical rows.
//
// Marketplace orders relayed by Mirakl Connect land in Shopify as ordinary orders tagged with the marketplace name and a
// "Ship by YYYY-MM-DD" tag; we lift both onto the order so the warehouse queue can sort by deadline.

export const MARKETPLACE_TAGS: Record<string, string> = {
  'nordstrom': 'Nordstrom', "kohl's": "Kohl's", 'kohls': "Kohl's", 'jcpenney': 'JCPenney', 'best buy': 'Best Buy', 'bestbuy': 'Best Buy',
  'target plus': 'Target Plus', 'target': 'Target Plus', 'walmart': 'Walmart', 'walmart usa': 'Walmart', 'the knot': 'The Knot',
  'debenhams': 'Debenhams', 'freelea': 'Freelea', 'enbasis': 'Enbasis', 'lebeaux': 'Lebeaux', 'stripe agentic': 'Stripe Agentic',
  'royal caribbean': 'Royal Caribbean', 'faire': 'Faire', 'amazon': 'Amazon', 'ebay': 'eBay', 'etsy': 'Etsy', 'tiktok': 'TikTok Shop',
};

export function parseTags(tagString: string | null | undefined) {
  const tags = String(tagString ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  let ship_by: string | null = null; let marketplace: string | null = null; let viaMirakl = false;
  for (const t of tags) {
    const low = t.toLowerCase();
    const m = low.match(/^ship\s*by\s*:?\s*(\d{4}-\d{2}-\d{2})/); if (m) ship_by = m[1];
    if (low === 'mirakl' || low.startsWith('mirakl')) viaMirakl = true;
    if (!marketplace && MARKETPLACE_TAGS[low]) marketplace = MARKETPLACE_TAGS[low];
  }
  return { tags, ship_by, marketplace, viaMirakl };
}

export function sourceFor(o: any, viaMirakl: boolean, marketplace: string | null) {
  if (viaMirakl || marketplace) return 'mirakl';
  const s = String(o.source_name ?? '').toLowerCase();
  if (s === 'web') return 'online_store';
  if (s === 'shopify_draft_order' || s === 'draft_order') return 'draft';
  if (s.includes('shop')) return s;
  return s || 'shopify';
}

export function statusFor(o: any, topic: string): string | null {
  if (topic === 'orders/cancelled' || o.cancelled_at) return 'cancelled';
  if (o.fulfillment_status === 'fulfilled') return 'shipped';
  if (o.financial_status && !['paid', 'partially_refunded', 'authorized'].includes(o.financial_status)) return 'on_hold';
  return null;
}

// Writes one Shopify order (webhook payload or REST shape — identical) into orders + order_lines. Returns the order id.
export async function upsertShopifyOrder(supabase: any, orgId: string, o: any, topic = 'orders/updated'): Promise<{ id: string; created: boolean }> {
  const addr = o.shipping_address ?? {};
  const isIntl = !!addr.country_code && addr.country_code !== 'US';
  const physical = (o.line_items ?? []).filter((li: any) => li.requires_shipping !== false);
  const totalUnits = physical.reduce((s: number, li: any) => s + (li.fulfillable_quantity ?? li.quantity ?? 0), 0);
  const { tags, ship_by, marketplace, viaMirakl } = parseTags(o.tags);

  const base: any = {
    org_id: orgId, shopify_order_id: o.id, order_number: o.name ?? `#${o.order_number}`, channel: 'shopify',
    source: sourceFor(o, viaMirakl, marketplace), marketplace, ship_by,
    customer_name: addr.name ?? [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' '),
    customer_email: o.email ?? o.contact_email, ship_to: addr, shipping_method: o.shipping_lines?.[0]?.title ?? null,
    is_international: isIntl, placed_at: o.created_at, total_units: totalUnits, tags, notes: o.note ?? null, raw: o,
  };
  const st = statusFor(o, topic);

  const { data: existing } = await supabase.from('orders').select('id,status').eq('org_id', orgId).eq('shopify_order_id', o.id).maybeSingle();
  let orderId: string; let created = false;
  if (existing) {
    const upd: any = { ...base }; delete upd.placed_at;
    if (st && existing.status !== 'shipped') upd.status = st;
    const { error } = await supabase.from('orders').update(upd).eq('id', existing.id); if (error) throw error;
    orderId = existing.id;
  } else {
    base.status = st ?? 'new'; base.received_at = new Date().toISOString();
    const { data, error } = await supabase.from('orders').insert(base).select('id').single(); if (error) throw error;
    orderId = data.id; created = true;
  }

  const { data: skus } = await supabase.from('skus').select('id, sku, shopify_variant_id').eq('org_id', orgId);
  const bySku = new Map((skus ?? []).map((s: any) => [s.sku, s.id]));
  const byVariant = new Map((skus ?? []).filter((s: any) => s.shopify_variant_id).map((s: any) => [String(s.shopify_variant_id), s.id]));
  const lines: any[] = [];
  for (const li of o.line_items ?? []) {
    let skuId = byVariant.get(String(li.variant_id)) ?? (li.sku ? bySku.get(li.sku) : undefined);
    if (!skuId && li.sku && li.requires_shipping !== false) {
      const { data: ns } = await supabase.from('skus').insert({ org_id: orgId, sku: li.sku, name: li.title, variant: li.variant_title, shopify_product_id: li.product_id, shopify_variant_id: li.variant_id, active: true }).select('id').single();
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
  return { id: orderId, created };
}
