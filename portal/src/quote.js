// Quote math — pure functions, no React. A quote = model (what kind of business) + inputs (the prospect's profile)
// + rates (what we charge) + costs (what it costs ShipBay) + services (value-added extras switched on for this quote).
// compute() returns one period at a given volume and phase ('waived' = founding rates + waivers, 'intro' = founding
// rates only, 'standard' = the card), with the client's bill line by line and ShipBay's labor, cost and contribution.
// Monthly models bill a month; 'launch' and 'project' bill once (a project total), so phases don't apply to them.

/* ---------- quote models ---------- */
export const MODELS = [
  { key: 'dtc', label: 'DTC e-commerce', short: 'DTC', volume: 'Orders / month', unit: 'orders', desc: 'Shopify, Veeqo or marketplace orders shipped one at a time to consumers. Per-order pick & pack plus storage and receiving.' },
  { key: 'subscription', label: 'Subscription / batch drop', short: 'Batch drop', volume: 'Boxes / month (all drops)', unit: 'boxes', desc: 'One or more drops a month that all ship inside a short window. Per-box assembly plus pick & pack, with a staffing plan for each drop.' },
  { key: 'hybrid', label: 'DTC + wholesale', short: 'Hybrid', volume: 'DTC orders / month', unit: 'orders', desc: 'Consumer orders plus retailer or wholesale orders, with pallet builds and routing-guide compliance priced separately.' },
  { key: 'b2b', label: 'Wholesale / B2B', short: 'B2B', volume: 'Wholesale orders / month', unit: 'orders', desc: 'Case and pallet orders to retailers and distributors. Per-order plus per-unit handling, pallet builds, compliance labels.' },
  { key: 'fba', label: 'Amazon FBA / marketplace prep', short: 'FBA prep', volume: 'Units prepped / month', unit: 'units', desc: 'Receive, prep, label and forward inventory to Amazon or other marketplaces. Per-unit prep plus carton and pallet handling.' },
  { key: 'launch', label: 'Launch / crowdfunding', short: 'Launch', volume: 'Packages to ship (total)', unit: 'packages', desc: 'A one-time wave of rewards or pre-orders shipped inside a window. Quoted as a project total, not a monthly bill.' },
  { key: 'storage', label: 'Storage & overflow', short: 'Storage', volume: 'Pallets stored', unit: 'pallets', desc: 'Pallet, shelf or bin storage with in-and-out handling and no order fulfillment.' },
  { key: 'project', label: 'Kitting / project work', short: 'Project', volume: 'Labor hours (estimate)', unit: 'hours', desc: 'Assembly, relabeling, rework or inspection billed by the hour or per kit. Quoted as a one-time project.' },
];
export const MODEL = Object.fromEntries(MODELS.map((m) => [m.key, m]));
export const modelOf = (q) => (MODEL[q?.model] ? q.model : 'dtc');
export const isOneTime = (model) => model === 'launch' || model === 'project';
const PARCEL = ['dtc', 'hybrid', 'subscription', 'launch'];

export const DEFAULT_INPUTS = {
  orders: 500, units_per_order: 1.2, pallets: 4, shelves: 10, bins: 0, inbound_pallets: 2, inbound_cartons: 10, returns: 10, intl_share: 0.02,
  packaging: 'shipbay', box_share: 0.2, avg_postage: 7.5, current_cost: null,
  b2b_orders: 0, b2b_units_per_order: 24, pallets_out: 0, cartons_out: 0, pallet_moves: 0,
  batch_share: 0, batch_days: 0, drops_per_month: 1, storage_months: 1, kits: 0, materials: 0,
};
export const DEFAULT_COSTS = {
  labor_rate: 22.40, min_per_order: 3.5, min_per_addl_unit: 0.5, min_per_pallet_in: 30, min_per_carton_in: 3, min_per_return: 6,
  min_per_b2b_order: 12, min_per_b2b_unit: 0.15, min_assembly_per_box: 1.5, min_per_pallet_build: 20, min_per_fba_unit: 0.6, min_per_carton_out: 4, min_per_pallet_move: 10, min_per_kit: 3,
  pack_cost_mailer: 0.12, pack_cost_box_single: 0.62, pack_cost_box_double: 0.90, dunnage_per_order: 0.06, pallet_wrap_cost: 2.5, fba_material: 0.06,
  space_cost_pallet: 26, space_cost_shelf: 5, space_cost_bin: 1.25, overhead_per_month: 60, postage_cost_avg: 7.5,
};

/** Rates from a rate_cards row (standard card) for a given monthly volume: picks the tier and copies the line items. */
export function ratesFromCard(card, orders) {
  const tiers = Array.isArray(card.tiers) && card.tiers.length ? card.tiers : [{ label: 'Standard', max_orders: null, pick_first: Number(card.pick_pack_first), pick_addl: Number(card.pick_pack_addl) }];
  const t = tiers.find((x) => x.max_orders == null || orders <= x.max_orders) || tiers[tiers.length - 1];
  const ex = card.extras || {};
  return {
    tier: t.label, pick_first: Number(t.pick_first), pick_addl: Number(t.pick_addl),
    mailer: ex.mailer_included ? 0 : Number(card.packaging_mailer ?? 0.20), box_single: Number(card.packaging_box_single), box_double: Number(card.packaging_box_double),
    storage_pallet: Number(card.storage_pallet), storage_shelf: Number(card.storage_shelf), storage_bin: Number(card.storage_bin), storage_waived_months: Number(card.storage_waived_months ?? 0),
    receiving_pallet: Number(card.receiving_pallet), receiving_carton: Number(card.receiving_carton), receiving_waived_months: 0,
    returns: Number(card.returns_fee), returns_addl: Number(ex.returns_addl ?? 0.5), intl: Number(card.intl_surcharge),
    minimum: Number(card.monthly_minimum), minimum_waived_months: Number(card.minimum_waived_months ?? 2), postage_markup_pct: Number(card.postage_markup_pct ?? 0), postage_guarantee_avg: card.postage_guarantee_avg ? Number(card.postage_guarantee_avg) : null,
    b2b_order: Number(ex.b2b_order ?? 5.5), b2b_unit: Number(ex.b2b_unit ?? 0.4), pallet_build: Number(ex.pallet_build ?? 18),
    assembly: Number(ex.assembly ?? 1.25), fba_prep: Number(ex.fba_prep ?? 0.6), fba_carton: Number(ex.fba_carton ?? 2.5), pallet_move: Number(ex.pallet_move ?? 12),
    project_hr: Number(ex.kitting_hr ?? 40), kit_rate: Number(ex.kit_rate ?? 1.5), setup: Number(ex.setup ?? 0),
    intro: { months: 0 },
  };
}

/* ---------- value-added services catalog ----------
 * basis decides the quantity: 'order' / 'unit' / 'return' / 'b2b_order' / 'pallet' scale with the quote (× share),
 * 'month' is a flat monthly fee, 'each' is a quantity you type, 'once' is a one-time fee shown outside the monthly bill.
 * price = what the client pays per unit of basis; min = our labor minutes per unit; mat = our material cost per unit. */
export const VAS_GROUPS = [['pack', 'Packing & unboxing'], ['prep', 'Prep, labeling & QC'], ['returns', 'Returns'], ['b2b', 'Wholesale & freight'], ['speed', 'Speed & coverage'], ['account', 'Account & projects']];
export const VAS = [
  { key: 'kitting', group: 'pack', label: 'Kitting & bundle assembly', desc: 'We build multi-item kits or bundles ahead of time so they pick as one SKU.', basis: 'unit', unit: 'per kit', price: 1.25, min: 1.5, mat: 0 },
  { key: 'insert', group: 'pack', label: 'Marketing insert in every order', desc: 'A card, flyer or sample dropped into each package. You supply the inserts.', basis: 'order', unit: 'per order', price: 0.15, min: 0.15, mat: 0 },
  { key: 'gift_note', group: 'pack', label: 'Printed gift note', desc: 'Your customer’s message printed on your notecard stock and tucked in the order.', basis: 'order', unit: 'per order', price: 0.75, min: 1, mat: 0.05, share: 0.1 },
  { key: 'tissue', group: 'pack', label: 'Tissue wrap & branded sticker', desc: 'Items wrapped in your tissue and sealed with your sticker before they go in the box.', basis: 'order', unit: 'per order', price: 0.45, min: 0.75, mat: 0.03 },
  { key: 'branded_pack', group: 'pack', label: 'Custom branded packaging handling', desc: 'We pack in your custom boxes, mailers or crinkle paper instead of our standard kit. You supply the materials; we store them free.', basis: 'order', unit: 'per order', price: 0.25, min: 0.4, mat: 0 },
  { key: 'gift_wrap', group: 'pack', label: 'Gift wrapping', desc: 'Full gift wrap with ribbon on request, flagged from your store.', basis: 'order', unit: 'per order', price: 3.50, min: 4, mat: 0.60, share: 0.05 },
  { key: 'photo_proof', group: 'pack', label: 'Photo of every packed order', desc: 'A photo of the open box before it’s sealed, attached to the order in your portal.', basis: 'order', unit: 'per order', price: 0.25, min: 0.3, mat: 0 },
  { key: 'hazmat', group: 'pack', label: 'Limited-quantity hazmat handling', desc: 'ORM-D / limited-quantity labeling and carrier paperwork for aerosols, perfume, batteries.', basis: 'order', unit: 'per order', price: 0.60, min: 0.5, mat: 0.04, share: 0.2 },
  { key: 'fba_prep', group: 'prep', label: 'FBA / marketplace prep', desc: 'Poly bag, suffocation warning and FNSKU label per unit to Amazon’s prep standard.', basis: 'unit', unit: 'per unit', price: 0.60, min: 0.6, mat: 0.06 },
  { key: 'relabel', group: 'prep', label: 'Relabeling / barcode application', desc: 'Apply or cover barcodes, price tickets or compliance labels.', basis: 'unit', unit: 'per unit', price: 0.30, min: 0.3, mat: 0.02 },
  { key: 'qc', group: 'prep', label: 'Inbound quality inspection', desc: 'Every unit checked against your spec on receipt — defects photographed and reported before they reach a customer.', basis: 'unit', unit: 'per unit', price: 0.35, min: 0.4, mat: 0 },
  { key: 'lot', group: 'prep', label: 'Lot & expiry tracking', desc: 'Lot codes and best-by dates captured at receiving with first-expiry-first-out picking.', basis: 'unit', unit: 'per unit received', price: 0.10, min: 0.1, mat: 0 },
  { key: 'serial', group: 'prep', label: 'Serial number capture', desc: 'Serial scanned at receipt and at shipment, tied to the order for warranty and recalls.', basis: 'unit', unit: 'per unit', price: 0.20, min: 0.25, mat: 0 },
  { key: 'count', group: 'prep', label: 'Monthly full physical count', desc: 'A wall-to-wall count once a month with a signed variance report, on top of our standard cycle counts.', basis: 'month', unit: 'per month', price: 75, min: 150, mat: 0 },
  { key: 'returns_restock', group: 'returns', label: 'Returns inspection & restock', desc: 'Each return opened, graded A/B/C against your rules, and restocked or quarantined. Standard returns are logged only.', basis: 'return', unit: 'per return', price: 2.00, min: 3, mat: 0 },
  { key: 'returns_photos', group: 'returns', label: 'Return condition photos', desc: 'Photos of every returned item and its packaging attached to the return record.', basis: 'return', unit: 'per return', price: 0.75, min: 0.75, mat: 0 },
  { key: 'returns_refurb', group: 'returns', label: 'Repackage & refurbish returns', desc: 'Resealing, re-bagging and replacing damaged retail packaging so B-grade stock sells again.', basis: 'return', unit: 'per unit', price: 1.75, min: 2.5, mat: 0.15 },
  { key: 'pallet_build', group: 'b2b', label: 'Pallet build & stretch-wrap', desc: 'Orders built to your retailer’s ti-hi, wrapped, labeled and staged for pickup.', basis: 'each', unit: 'per pallet', price: 18, min: 20, mat: 2.5 },
  { key: 'routing', group: 'b2b', label: 'Retailer routing-guide compliance', desc: 'UCC-128 / GS1 carton labels, packing lists and ASN data to the retailer’s routing guide — chargeback protection.', basis: 'b2b_order', unit: 'per wholesale order', price: 4.50, min: 6, mat: 0.20 },
  { key: 'edi', group: 'b2b', label: 'EDI document handling', desc: '850 / 856 / 810 documents handled through your EDI provider, per order.', basis: 'b2b_order', unit: 'per wholesale order', price: 2.00, min: 2, mat: 0 },
  { key: 'freight_booking', group: 'b2b', label: 'LTL / freight booking & BOL', desc: 'We quote, book and tender LTL or FTL freight on your behalf and prepare the bill of lading.', basis: 'each', unit: 'per shipment', price: 15, min: 15, mat: 0 },
  { key: 'same_day', group: 'speed', label: 'Extended same-day cutoff (3 pm ET)', desc: 'Orders in by 3 pm ship the same day, instead of our standard 1 pm cutoff.', basis: 'order', unit: 'per order', price: 0.20, min: 0.1, mat: 0 },
  { key: 'rush', group: 'speed', label: 'Priority handling on flagged orders', desc: 'Orders you tag as priority jump the queue and ship within two hours of release.', basis: 'order', unit: 'per flagged order', price: 2.50, min: 1.5, mat: 0, share: 0.05 },
  { key: 'saturday', group: 'speed', label: 'Saturday processing', desc: 'A Saturday shift so Friday-evening orders ship before Monday.', basis: 'each', unit: 'per Saturday', price: 95, min: 180, mat: 0 },
  { key: 'peak', group: 'speed', label: 'Peak-season capacity guarantee', desc: 'Reserved labor and dock space for November–December at your forecast volume, no surge pricing.', basis: 'month', unit: 'per month (Nov–Dec)', price: 150, min: 0, mat: 0 },
  { key: 'intl_docs', group: 'speed', label: 'International customs documentation', desc: 'Commercial invoice, HS codes and electronic customs data for every international parcel.', basis: 'order', unit: 'per international order', price: 1.50, min: 2, mat: 0, share: 0.02 },
  { key: 'climate', group: 'account', label: 'Climate-controlled storage', desc: 'Temperature-controlled positions for chocolate, cosmetics, candles or vinyl.', basis: 'pallet', unit: 'per pallet / month', price: 8, min: 0, mat: 4 },
  { key: 'account_mgr', group: 'account', label: 'Weekly account review call', desc: 'A standing 20-minute call with your account lead: volumes, exceptions, what’s coming.', basis: 'month', unit: 'per month', price: 0, min: 90, mat: 0 },
  { key: 'reporting', group: 'account', label: 'Custom reporting & data exports', desc: 'Scheduled exports or a custom report built around your finance or ops needs.', basis: 'month', unit: 'per month', price: 50, min: 60, mat: 0 },
  { key: 'photography', group: 'account', label: 'Product photography at receiving', desc: 'Clean white-background photos of each new SKU as it arrives, for your listings and our pick accuracy.', basis: 'each', unit: 'per SKU', price: 12, min: 10, mat: 0 },
  { key: 'disposal', group: 'account', label: 'Disposal / destruction', desc: 'Certified disposal of expired, recalled or unsellable units.', basis: 'each', unit: 'per unit', price: 0.25, min: 0.2, mat: 0.03 },
  { key: 'sku_setup', group: 'account', label: 'SKU setup beyond the first 100', desc: 'Barcoding, dimensioning and slotting for large catalogs. The first 100 SKUs are on us.', basis: 'once', unit: 'per SKU', price: 0.50, min: 0.5, mat: 0.02 },
  { key: 'onboarding', group: 'account', label: 'Onboarding & integration setup', desc: 'Store connection, SKU import, packing-slip template and a test order before go-live.', basis: 'once', unit: 'one-time', price: 0, min: 180, mat: 0 },
];
export const VAS_BY_KEY = Object.fromEntries(VAS.map((v) => [v.key, v]));

/** Things every ShipBay account gets. A quote can tick which ones to print under "What's included". */
export const INCLUDED = [
  { key: 'portal', label: 'Real-time client portal', desc: 'Inventory, orders, tracking and documents in one place, updated as we work.' },
  { key: 'integrations', label: 'Store & marketplace integrations', desc: 'Shopify, Veeqo, Amazon, TikTok Shop and more. Orders flow in and tracking flows back automatically.' },
  { key: 'rate_shopping', label: 'Carrier rate shopping, billed at cost', desc: 'Every label shopped across USPS, UPS and FedEx at our negotiated rates. You pay what we pay.' },
  { key: 'same_day', label: 'Same-day shipping on orders by 1 pm ET', desc: 'Released orders in by 1 pm go out that afternoon, Monday to Friday.' },
  { key: 'mailer', label: 'Standard poly mailer & dunnage', desc: 'Our standard mailer, tape and void fill are built into the pick & pack rate.' },
  { key: 'slip', label: 'Branded packing slip', desc: 'Printed from your own template, or ours with your logo, in every order.' },
  { key: 'validation', label: 'Address validation', desc: 'Bad addresses caught before a label is bought, not after a return.' },
  { key: 'cycle_counts', label: 'Cycle counts & monthly reconciliation', desc: 'Ongoing counts with a monthly inventory statement you can hand to your accountant.' },
  { key: 'returns_log', label: 'Returns received & logged within one business day', desc: 'You see the return, the reason and the condition before the customer asks.' },
  { key: 'contact', label: 'A named point of contact', desc: 'One person who knows your account and answers the phone.' },
  { key: 'no_contract', label: 'Month-to-month', desc: 'No long-term contract. Thirty days’ written notice ends the agreement.' },
  { key: 'no_setup', label: 'No setup fee', desc: 'Onboarding, integration and your first 100 SKUs are included.' },
  { key: 'insurance', label: 'Insured, climate-stable warehouse', desc: 'Sprinklered, alarmed and monitored, 15 minutes from the NJ Turnpike and I-287.' },
  { key: 'reporting', label: 'Monthly statement', desc: 'One itemized invoice: every order, every unit, every fee, exportable to CSV.' },
];
export const DEFAULT_INCLUDED = ['portal', 'integrations', 'rate_shopping', 'same_day', 'mailer', 'slip', 'validation', 'cycle_counts', 'returns_log', 'contact', 'no_contract', 'no_setup'];

export const DEFAULT_PROPOSAL = {
  title: 'Fulfillment proposal',
  intro: 'Thanks for walking us through {company}. Below is exactly what it would cost to run your fulfillment from our Hillsborough, New Jersey warehouse at around {volume} — every rate, what’s included, and a worked example of a typical month so there are no surprises on the first invoice.\n\nWe built ShipBay for brands your size. You get the same integrations and carrier rates the big 3PLs offer, without the minimums, the surcharges or the ticket queue. If something below doesn’t fit the way you operate, tell us and we’ll change it.',
  highlights: [],
  valid_days: 30,
  payment_terms: 'Fulfillment and storage are invoiced monthly in arrears, due net 15. Postage is invoiced weekly at our carrier cost with no markup.',
  term: 'Month-to-month. Either side may end the agreement with thirty days’ written notice; we return your inventory at the pallet rate with no exit fee.',
  included: DEFAULT_INCLUDED,
  show_postage: true, show_example: true, show_phases: true, show_batch: true, signature: true,
  prepared_by: 'Derek Harrison', prepared_title: 'Founder, ShipBay', prepared_email: 'derekh@shipbay3pl.com', prepared_phone: '',
};

/* ---------- helpers ---------- */
const n = (v, d = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;

/** The services switched on for a quote, merged with the catalog: [{...catalog, on, price, qty, share}] */
export function serviceList(q) {
  const s = q.services || {};
  return VAS.map((v) => { const o = s[v.key] || {}; return { ...v, on: !!o.on, price: n(o.price, v.price), qty: n(o.qty, 0), share: n(o.share, v.share ?? 1), note: o.note || '' }; });
}

/**
 * One period at `volume` (orders / boxes / units / pallets / hours depending on the model) and `phase`.
 * Returns { lines, vasLines, setup, services, postage, allIn, perOrder, cost, batch, contribution, margin, laborHours, ... }.
 */
export function compute(q, volume = n(q.inputs?.orders), phase = 'standard') {
  const model = modelOf(q);
  const oneTime = isOneTime(model);
  const i = { ...DEFAULT_INPUTS, ...(q.inputs || {}) };
  const c = { ...DEFAULT_COSTS, ...(q.costs || {}) };
  const r0 = q.rates || {};
  const intro = !oneTime && phase !== 'standard' && n(r0.intro?.months) > 0;
  const r = { ...r0, ...(intro ? { pick_first: n(r0.intro.pick_first, r0.pick_first), pick_addl: n(r0.intro.pick_addl, r0.pick_addl) } : {}) };
  const waived = (k) => !oneTime && phase === 'waived' && n(r[`${k}_waived_months`]) > 0;

  // volumes by model
  const orders = Math.max(0, n(volume));
  const parcel = PARCEL.includes(model);
  const upo = Math.max(1, n(i.units_per_order, 1));
  const dtc = parcel ? orders : 0;
  const b2b = model === 'b2b' ? orders : model === 'hybrid' ? n(i.b2b_orders) : 0;
  const b2bUpo = Math.max(1, n(i.b2b_units_per_order, 24));
  const fbaUnits = model === 'fba' ? orders : 0;
  const hours = model === 'project' ? orders : 0;
  const kits = model === 'project' ? n(i.kits) : 0;
  const addlUnits = dtc * (upo - 1);
  const intl = Math.round(dtc * n(i.intl_share));
  const shipbayPack = parcel && i.packaging !== 'client';
  const boxes = shipbayPack ? Math.round(dtc * n(i.box_share)) : 0;
  const mailers = shipbayPack ? dtc - boxes : 0;
  const pallets = model === 'storage' ? orders : n(i.pallets), shelves = n(i.shelves), bins = n(i.bins);
  const inP = n(i.inbound_pallets), inC = n(i.inbound_cartons);
  const rets = parcel ? n(i.returns) : 0;
  const months = oneTime ? Math.max(1, n(i.storage_months, 1)) : 1;
  const palletsOut = ['b2b', 'hybrid', 'fba'].includes(model) ? n(i.pallets_out) : 0;
  const cartonsOut = model === 'fba' ? n(i.cartons_out) : 0;
  const moves = model === 'storage' ? n(i.pallet_moves) : 0;
  const units = parcel ? Math.round(dtc * upo) : model === 'b2b' ? Math.round(b2b * b2bUpo) : model === 'fba' ? fbaUnits : 0;
  const postageRate = n(r.postage_guarantee_avg, n(i.avg_postage));

  const lines = [];
  const add = (key, label, qty, rate, note) => { const amount = r2(qty * rate); lines.push({ key, label, qty, rate, amount, note }); return amount; };
  if (dtc) {
    add('pick', model === 'subscription' ? `Pick & pack — per box${intro ? ' (founding rate)' : ''}` : `Pick & pack — first unit${intro ? ' (founding rate)' : ''}`, dtc, n(r.pick_first));
    if (addlUnits) add('addl', model === 'subscription' ? 'Additional items per box' : 'Additional units', Math.round(addlUnits), n(r.pick_addl));
    if (model === 'subscription' && n(r.assembly) > 0) add('assembly', 'Box assembly & kitting', dtc, n(r.assembly));
  }
  if (b2b) { add('b2b', 'Wholesale orders', b2b, n(r.b2b_order)); add('b2b_units', 'Wholesale units handled', Math.round(b2b * b2bUpo), n(r.b2b_unit)); }
  if (fbaUnits) { add('fba_prep', 'FBA prep — poly bag, warning & FNSKU label', fbaUnits, n(r.fba_prep)); if (cartonsOut) add('fba_carton', 'Carton pack, label & manifest', cartonsOut, n(r.fba_carton)); }
  if (palletsOut) add('pallet_build', 'Pallet build & stretch-wrap', palletsOut, n(r.pallet_build));
  if (hours) add('hours', 'Project labor', hours, n(r.project_hr));
  if (kits) add('kits', 'Kits assembled', kits, n(r.kit_rate));
  if (model === 'project' && n(i.materials) > 0) add('materials', 'Materials — at cost', 1, n(i.materials));
  if (shipbayPack) { if (mailers && n(r.mailer) > 0) add('mailer', 'Poly mailers', mailers, n(r.mailer)); if (boxes) add('box', 'Shipper boxes', boxes, n(r.box_single)); }
  else if (parcel) lines.push({ key: 'pack', label: 'Packaging — client-supplied', qty: 0, rate: 0, amount: 0 });
  const mo = oneTime && months > 1 ? ` (${months} months)` : '';
  if (waived('storage')) lines.push({ key: 'storage', label: `Storage — waived (first ${n(r.storage_waived_months)} months)`, qty: pallets + shelves + bins, rate: 0, amount: 0 });
  else { if (pallets || model === 'storage') add('storage_p', `Storage — pallets${mo}`, pallets * months, n(r.storage_pallet)); if (shelves) add('storage_s', `Storage — shelves${mo}`, shelves * months, n(r.storage_shelf)); if (bins) add('storage_b', `Storage — bins${mo}`, bins * months, n(r.storage_bin)); }
  if (moves) add('moves', 'Pallet in / out handling', moves, n(r.pallet_move));
  if (waived('receiving')) lines.push({ key: 'receiving', label: `Receiving — waived (first ${n(r.receiving_waived_months)} months)`, qty: inP + inC, rate: 0, amount: 0 });
  else { if (inP) add('recv_p', 'Receiving — pallets', inP, n(r.receiving_pallet)); if (inC) add('recv_c', 'Receiving — loose cartons', inC, n(r.receiving_carton)); }
  if (rets) add('returns', 'Returns processed', rets, n(r.returns));
  if (intl) add('intl', 'International surcharge', intl, n(r.intl));

  // value-added services
  const vasLines = [], setup = [];
  let vasMinutes = 0, vasMaterials = 0;
  const basisQty = { order: parcel ? dtc : b2b || fbaUnits, unit: units, return: rets, b2b_order: b2b, pallet: pallets, month: 1 };
  for (const s of serviceList(q)) {
    if (!s.on) continue;
    const qty = s.basis === 'each' || s.basis === 'once' ? s.qty : Math.round((basisQty[s.basis] || 0) * (['order', 'unit', 'return', 'b2b_order'].includes(s.basis) ? s.share : 1));
    const amount = r2(qty * s.price);
    const row = { key: `vas_${s.key}`, label: s.label, qty, rate: s.price, amount, unit: s.unit, basis: s.basis, desc: s.desc, note: s.note };
    if (s.basis === 'once') { setup.push(row); continue; }
    vasLines.push(row); vasMinutes += qty * s.min; vasMaterials += qty * s.mat;
  }
  if (n(r.setup) > 0) setup.unshift({ key: 'setup', label: 'Account setup', qty: 1, rate: n(r.setup), amount: n(r.setup), unit: 'one-time' });

  let services = r2(lines.reduce((s, l) => s + l.amount, 0) + vasLines.reduce((s, l) => s + l.amount, 0));
  const min = n(r.minimum);
  let minimumLine = null;
  if (!oneTime) {
    if (!waived('minimum') && min > services) { const top = r2(min - services); minimumLine = { key: 'minimum', label: 'Monthly minimum top-up', qty: 1, rate: top, amount: top }; services = min; }
    else if (waived('minimum') && min > 0) minimumLine = { key: 'minimum', label: `Monthly minimum — waived (first ${n(r.minimum_waived_months)} months)`, qty: 0, rate: 0, amount: 0 };
  }
  const setupTotal = r2(setup.reduce((s, l) => s + l.amount, 0));
  const postage = parcel ? r2(orders * postageRate * (1 + n(r.postage_markup_pct) / 100)) : 0;
  const allIn = r2(services + postage);

  // ShipBay side
  const minutes = dtc * c.min_per_order + addlUnits * c.min_per_addl_unit + (model === 'subscription' ? dtc * c.min_assembly_per_box : 0)
    + b2b * c.min_per_b2b_order + b2b * b2bUpo * c.min_per_b2b_unit + palletsOut * c.min_per_pallet_build + fbaUnits * c.min_per_fba_unit + cartonsOut * c.min_per_carton_out
    + moves * c.min_per_pallet_move + hours * 60 + kits * c.min_per_kit + inP * c.min_per_pallet_in + inC * c.min_per_carton_in + rets * c.min_per_return + vasMinutes;
  const laborHours = minutes / 60;
  const labor = r2(laborHours * c.labor_rate);
  const packaging = r2(mailers * c.pack_cost_mailer + boxes * c.pack_cost_box_single + dtc * c.dunnage_per_order + palletsOut * c.pallet_wrap_cost + fbaUnits * c.fba_material + vasMaterials + (model === 'project' ? n(i.materials) : 0));
  const space = r2((pallets * c.space_cost_pallet + shelves * c.space_cost_shelf + bins * c.space_cost_bin) * months);
  const overhead = n(c.overhead_per_month);
  const postageCost = parcel ? r2(orders * n(c.postage_cost_avg, postageRate)) : 0;
  const postageMargin = r2(postage - postageCost);
  const cost = { labor, packaging, space, overhead, total: r2(labor + packaging + space + overhead) };

  // batch / drop plan: boxes that ship inside a window → labor hours per day and the packers it takes
  let batch = null;
  const drops = Math.max(1, n(i.drops_per_month, 1));
  const share = model === 'subscription' ? (n(i.batch_share) > 0 ? n(i.batch_share) : 1) : model === 'launch' ? 1 : n(i.batch_share);
  const days = model === 'launch' ? Math.max(1, n(i.batch_days, 5)) : n(i.batch_days);
  if (dtc && share > 0 && days > 0) {
    const perDrop = Math.round((dtc * share) / (model === 'launch' ? 1 : drops));
    const bh = (perDrop * c.min_per_order + perDrop * (upo - 1) * c.min_per_addl_unit + (model === 'subscription' ? perDrop * c.min_assembly_per_box : 0)) / 60;
    const perDay = bh / days;
    batch = { orders: perDrop, drops: model === 'launch' ? 1 : drops, hours: r2(bh), perDay: r2(perDay), headcount: Math.max(1, Math.ceil(perDay / 7.5)), ordersPerDay: Math.round(perDrop / days), days, trickle: Math.round(dtc * (1 - share)) };
  }
  const contribution = r2(services - cost.total + postageMargin);
  const per = orders || 1;
  return { model, oneTime, phase, orders, lines: minimumLine ? [...lines, minimumLine] : lines, vasLines, setup, setupTotal, services, postage, allIn,
    perOrder: r2(allIn / per), servicesPerOrder: r2(services / per), cost, batch, postageMargin, contribution, margin: services ? contribution / services : 0,
    laborHours: r2(laborHours), laborPerOrder: r2(labor / per), costPerOrder: r2(cost.total / per), units,
    vsCurrent: i.current_cost ? r2(n(i.current_cost) - allIn) : null };
}

/** The phases this quote actually has, in order, with the months they cover. Phases that bill identically to the next one are dropped. */
export function phases(q) {
  if (isOneTime(modelOf(q))) return [{ key: 'standard', label: 'Project', months: null }];
  const r = q.rates || {};
  const waiveMonths = Math.max(...['storage', 'receiving', 'minimum'].map((k) => n(r[`${k}_waived_months`])), 0);
  const introMonths = n(r.intro?.months);
  const out = [];
  if (waiveMonths > 0) out.push({ key: 'waived', label: `Months 1–${waiveMonths}`, months: waiveMonths });
  if (introMonths > waiveMonths) out.push({ key: 'intro', label: `Months ${waiveMonths + 1}–${introMonths}`, months: introMonths - waiveMonths });
  out.push({ key: 'standard', label: out.length ? `Month ${Math.max(waiveMonths, introMonths) + 1}+` : 'Standard', months: null });
  const base = n(q.inputs?.orders) || 1;
  const kept = out.filter((p, i) => i === out.length - 1 || compute(q, base, p.key).allIn !== compute(q, base, out[i + 1].key).allIn || compute(q, base, p.key).contribution !== compute(q, base, out[i + 1].key).contribution);
  return kept.length === 1 ? [{ ...kept[0], label: 'Standard' }] : kept;
}
/** Every phase at each scenario volume. */
export function scenarios(q) {
  const vols = (Array.isArray(q.scenarios) && q.scenarios.length ? q.scenarios : [n(q.inputs?.orders)]).map((v) => n(v)).filter((v) => v > 0);
  const ph = phases(q);
  return vols.map((v) => ({ orders: v, rows: ph.map((p) => ({ ...compute(q, v, p.key), label: p.label })) }));
}

/** Where the rate card sits against published 2026 benchmarks (fulfill.com survey + verified rate cards; ratecardlab). */
export const BENCHMARKS = [
  { key: 'pick_first', label: 'Pick & pack, first unit', unit: '/order', typical: '$2.00 median · $2–3 typical · $3.20 survey avg', majors: 'ShipBob / ShipMonk $2.50–3.50', lowerIsBetter: true },
  { key: 'pick_addl', label: 'Additional unit', unit: '/unit', typical: '$0.40 median · $0.30–0.75', majors: '$0.50–0.95', lowerIsBetter: true },
  { key: 'storage_pallet', label: 'Pallet storage', unit: '/mo', typical: '$18–25 typical · $20 avg', majors: '$35–45', lowerIsBetter: true },
  { key: 'storage_bin', label: 'Bin storage', unit: '/mo', typical: '$1–5 · $3.08 avg', majors: '$3–5', lowerIsBetter: true },
  { key: 'receiving_pallet', label: 'Receiving', unit: '/pallet', typical: '$5–15 · $10.52 avg (or $30–60/hr)', majors: '$35–45/hr', lowerIsBetter: true },
  { key: 'returns', label: 'Return processed', unit: '/return', typical: '$1–7 · $4.06 avg', majors: '$3–5', lowerIsBetter: true },
  { key: 'minimum', label: 'Monthly minimum', unit: '/mo', typical: '$0–750 · $517 avg', majors: '$500–5,000', lowerIsBetter: true },
  { key: 'kitting_hr', label: 'Kitting / projects', unit: '/hr', typical: '$35–60 · $39–43 avg', majors: '$45–60', lowerIsBetter: true },
];
export const BENCHMARK_SOURCES = [
  ['fulfill.com — How Much Does a 3PL Cost in 2026? 16 fee benchmarks', 'https://www.fulfill.com/3pl-pricing'],
  ['ratecardlab — Pick and pack pricing in 2026: every published 3PL rate', 'https://ratecardlab.com/guides/3pl-pick-fee-benchmarks/'],
  ['Red Stag — 3PL pricing guide 2026', 'https://redstagfulfillment.com/3pl-pricing-explained/'],
  ['warehousingcosts.com — ShipMonk pricing & review 2026', 'https://warehousingcosts.com/guides/shipmonk-pricing-review'],
];

export const money = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
export const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`);
export const fmtVol = (q, v) => `${Number(v || 0).toLocaleString()} ${MODEL[modelOf(q)].unit}${isOneTime(modelOf(q)) ? '' : '/mo'}`;
