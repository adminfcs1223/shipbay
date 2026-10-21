// Quote math — pure functions, no React. A quote = inputs (the prospect's profile) + rates (what we charge) +
// costs (what it costs ShipBay). compute() returns one month at a given order volume and phase ('intro' = founding /
// waiver period, 'standard' = after it), with the client's bill line by line and ShipBay's labor, cost and contribution.

export const DEFAULT_INPUTS = { orders: 500, units_per_order: 1.2, pallets: 4, shelves: 10, bins: 0, inbound_pallets: 2, inbound_cartons: 10, returns: 10, intl_share: 0.02, packaging: 'shipbay', box_share: 0.2, avg_postage: 7.5, current_cost: null, b2b_orders: 0, batch_share: 0, batch_days: 0 };
export const DEFAULT_COSTS = { labor_rate: 22.40, min_per_order: 3.5, min_per_addl_unit: 0.5, min_per_pallet_in: 30, min_per_carton_in: 3, min_per_return: 6, min_per_b2b_order: 12, pack_cost_mailer: 0.12, pack_cost_box_single: 0.62, pack_cost_box_double: 0.90, dunnage_per_order: 0.06, space_cost_pallet: 26, space_cost_shelf: 5, space_cost_bin: 1.25, overhead_per_month: 60, postage_cost_avg: 7.5 };

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
    b2b_order: Number(ex.b2b_order ?? 5.5), b2b_unit: Number(ex.b2b_unit ?? 0.4), intro: { months: 0 },
  };
}

const n = (v, d = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * One month. phase 'intro' applies rates.intro overrides (pick/addl) and every *_waived_months waiver; 'standard' applies none.
 * Returns { lines: [{key,label,qty,rate,amount}], services, postage, allIn, perOrder, cost: {...}, contribution, margin, laborHours }.
 */
export function compute(q, orders = n(q.inputs?.orders), phase = 'standard') {
  const i = { ...DEFAULT_INPUTS, ...(q.inputs || {}) };
  const c = { ...DEFAULT_COSTS, ...(q.costs || {}) };
  const r0 = q.rates || {};
  // phases: 'waived' = founding rates + every waiver (the first months), 'intro' = founding rates only, 'standard' = the card
  const intro = phase !== 'standard' && n(r0.intro?.months) > 0;
  const r = { ...r0, ...(intro ? { pick_first: n(r0.intro.pick_first, r0.pick_first), pick_addl: n(r0.intro.pick_addl, r0.pick_addl) } : {}) };
  const waived = (k) => phase === 'waived' && n(r[`${k}_waived_months`]) > 0;

  const upo = Math.max(1, n(i.units_per_order, 1));
  const addlUnits = orders * (upo - 1);
  const b2b = n(i.b2b_orders);
  const dtc = Math.max(0, orders - b2b);
  const intl = Math.round(dtc * n(i.intl_share));
  const shipbayPack = i.packaging !== 'client';
  const boxes = shipbayPack ? Math.round(dtc * n(i.box_share)) : 0;
  const mailers = shipbayPack ? dtc - boxes : 0;
  const pallets = n(i.pallets), shelves = n(i.shelves), bins = n(i.bins);
  const inP = n(i.inbound_pallets), inC = n(i.inbound_cartons), rets = n(i.returns);
  const postageRate = n(r.postage_guarantee_avg, n(i.avg_postage));

  const lines = [];
  const add = (key, label, qty, rate, note) => { const amount = r2(qty * rate); lines.push({ key, label, qty, rate, amount, note }); return amount; };
  add('pick', `Pick & pack — first unit${intro ? ' (founding rate)' : ''}`, dtc, n(r.pick_first));
  add('addl', 'Additional units', Math.round(addlUnits), n(r.pick_addl));
  if (b2b) { add('b2b', 'B2B / wholesale orders', b2b, n(r.b2b_order)); add('b2b_units', 'B2B units', Math.round(b2b * upo), n(r.b2b_unit)); }
  if (shipbayPack) { if (mailers && n(r.mailer) > 0) add('mailer', 'Poly mailers', mailers, n(r.mailer)); if (boxes) add('box', 'Shipper boxes', boxes, n(r.box_single)); }
  else lines.push({ key: 'pack', label: 'Packaging — client-supplied', qty: 0, rate: 0, amount: 0 });
  if (waived('storage')) lines.push({ key: 'storage', label: `Storage — waived (first ${n(r.storage_waived_months)} months)`, qty: pallets + shelves + bins, rate: 0, amount: 0 });
  else { add('storage_p', 'Storage — pallets', pallets, n(r.storage_pallet)); if (shelves) add('storage_s', 'Storage — shelves', shelves, n(r.storage_shelf)); if (bins) add('storage_b', 'Storage — bins', bins, n(r.storage_bin)); }
  if (waived('receiving')) lines.push({ key: 'receiving', label: `Receiving — waived (first ${n(r.receiving_waived_months)} months)`, qty: inP + inC, rate: 0, amount: 0 });
  else { if (inP) add('recv_p', 'Receiving — pallets', inP, n(r.receiving_pallet)); if (inC) add('recv_c', 'Receiving — loose cartons', inC, n(r.receiving_carton)); }
  if (rets) add('returns', 'Returns processed', rets, n(r.returns));
  if (intl) add('intl', 'International surcharge', intl, n(r.intl));
  let services = r2(lines.reduce((s, l) => s + l.amount, 0));
  const min = n(r.minimum);
  if (!waived('minimum') && min > services) { const top = r2(min - services); lines.push({ key: 'minimum', label: 'Monthly minimum top-up', qty: 1, rate: top, amount: top }); services = min; }
  else if (waived('minimum')) lines.push({ key: 'minimum', label: `Monthly minimum — waived (first ${n(r.minimum_waived_months)} months)`, qty: 0, rate: 0, amount: 0 });
  const postage = r2(orders * postageRate * (1 + n(r.postage_markup_pct) / 100));
  const allIn = r2(services + postage);

  // ShipBay side
  const minutes = dtc * c.min_per_order + addlUnits * c.min_per_addl_unit + b2b * c.min_per_b2b_order + inP * c.min_per_pallet_in + inC * c.min_per_carton_in + rets * c.min_per_return;
  const laborHours = minutes / 60;
  const labor = r2(laborHours * c.labor_rate);
  const packaging = r2(mailers * c.pack_cost_mailer + boxes * c.pack_cost_box_single + orders * c.dunnage_per_order);
  const space = r2(pallets * c.space_cost_pallet + shelves * c.space_cost_shelf + bins * c.space_cost_bin);
  const overhead = n(c.overhead_per_month);
  // postage: we bill what we pay unless a guarantee pins the client's rate below our cost
  const postageCost = r2(orders * n(c.postage_cost_avg, postageRate));
  const postageMargin = r2(postage - postageCost);
  const cost = { labor, packaging, space, overhead, total: r2(labor + packaging + space + overhead) };
  // batch drop (subscription boxes): share of the month that ships inside a short window → peak hours/day and headcount
  let batch = null;
  if (n(i.batch_share) > 0 && n(i.batch_days) > 0) {
    const bo = Math.round(dtc * n(i.batch_share));
    const bh = (bo * c.min_per_order + bo * (upo - 1) * c.min_per_addl_unit) / 60;
    const perDay = bh / n(i.batch_days);
    batch = { orders: bo, hours: r2(bh), perDay: r2(perDay), headcount: Math.ceil(perDay / 7.5), ordersPerDay: Math.round(bo / n(i.batch_days)), days: n(i.batch_days) };
  }
  const contribution = r2(services - cost.total + postageMargin);
  return { phase, orders, lines, services, postage, allIn, perOrder: orders ? r2(allIn / orders) : 0, servicesPerOrder: orders ? r2(services / orders) : 0,
    cost, batch, postageMargin, contribution, margin: services ? contribution / services : 0, laborHours: r2(laborHours), laborPerOrder: orders ? r2(labor / orders) : 0, costPerOrder: orders ? r2(cost.total / orders) : 0,
    vsCurrent: i.current_cost ? r2(n(i.current_cost) - allIn) : null };
}

/** The phases this quote actually has, in order, with the months they cover. Phases that bill identically to the next one are dropped. */
export function phases(q) {
  const r = q.rates || {};
  const waiveMonths = Math.max(...['storage', 'receiving', 'minimum'].map((k) => n(r[`${k}_waived_months`])), 0);
  const introMonths = n(r.intro?.months);
  const out = [];
  if (waiveMonths > 0) out.push({ key: 'waived', label: `Months 1–${waiveMonths}`, months: waiveMonths });
  if (introMonths > waiveMonths) out.push({ key: 'intro', label: `Months ${waiveMonths + 1}–${introMonths}`, months: introMonths - waiveMonths });
  out.push({ key: 'standard', label: out.length ? `Month ${Math.max(waiveMonths, introMonths) + 1}+` : 'Standard', months: null });
  // drop a phase whose bill equals the next phase's (e.g. a minimum waiver that never bites)
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
