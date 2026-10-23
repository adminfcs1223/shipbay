// Proposal / rate-card document. Builds a print-ready HTML document (US Letter) from a quote and opens it in a new
// window; the browser's print dialog saves it as a PDF. Typeset like a real agency proposal: one serif-free family
// pair (Archivo display, Inter text), hairline rules, tabular numerals, section numbers, no decoration for its own sake.
import { compute, phases, serviceList, modelOf, MODEL, INCLUDED, DEFAULT_PROPOSAL, isOneTime, money } from './quote';
import LOGO from './logo-horizontal.svg?raw';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v, d = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const longDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const paras = (t) => String(t || '').split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
const rate = (v, d = 2) => (v == null || v === '' ? '—' : money(Number(v), d));
const num = (v) => Number(v || 0).toLocaleString('en-US');

/** Fill {company} {first} {contact} {volume} {model} in prose. */
export function fill(text, q) {
  const first = (q.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const model = MODEL[modelOf(q)];
  const vol = `${num(q.inputs?.orders)} ${model.unit}${isOneTime(model.key) ? '' : ' a month'}`;
  return String(text || '').replace(/\{company\}/g, q.company || 'your brand').replace(/\{first\}/g, first).replace(/\{contact\}/g, q.contact_name || first).replace(/\{volume\}/g, vol).replace(/\{model\}/g, model.label.toLowerCase());
}

/** The rate schedule for this model, grouped, with the founding-rate column where one applies. */
export function rateSchedule(q) {
  const r = q.rates || {}, i = q.inputs || {};
  const model = modelOf(q);
  const parcel = ['dtc', 'hybrid', 'subscription', 'launch'].includes(model);
  const introM = isOneTime(model) ? 0 : n(r.intro?.months);
  const waive = (k) => (n(r[`${k}_waived_months`]) > 0 ? `Waived for your first ${n(r[`${k}_waived_months`])} months` : '');
  const g = [];
  const grp = (title, rows) => { const keep = rows.filter(Boolean); if (keep.length) g.push({ title, rows: keep }); };
  if (parcel) grp('Fulfillment', [
    { label: model === 'subscription' ? 'Pick & pack, per box' : 'Pick & pack, first unit', rate: rate(r.pick_first), unit: model === 'subscription' ? 'per box' : 'per order', intro: introM ? rate(r.intro?.pick_first ?? r.pick_first) : null, note: 'Includes picking, packing, label and handoff to the carrier' + (n(r.mailer) === 0 && i.packaging !== 'client' ? ', standard poly mailer and void fill' : '') + '.' },
    { label: model === 'subscription' ? 'Additional item in the same box' : 'Each additional unit in the same order', rate: rate(r.pick_addl), unit: 'per unit', intro: introM ? rate(r.intro?.pick_addl ?? r.pick_addl) : null },
    model === 'subscription' && n(r.assembly) > 0 ? { label: 'Box assembly & kitting', rate: rate(r.assembly), unit: 'per box', note: 'Building each box to your packing spec ahead of the drop.' } : null,
    n(r.intl) > 0 ? { label: 'International order surcharge', rate: rate(r.intl), unit: 'per order', note: 'Customs form and carrier paperwork.' } : null,
  ]);
  if (model === 'b2b' || model === 'hybrid') grp('Wholesale & retail orders', [
    { label: 'Wholesale order handling', rate: rate(r.b2b_order), unit: 'per order', note: 'Pick list, packing list and carton labels.' },
    { label: 'Units handled', rate: rate(r.b2b_unit), unit: 'per unit' },
    { label: 'Pallet build & stretch-wrap', rate: rate(r.pallet_build), unit: 'per pallet' },
    { label: 'LTL / truckload freight', rate: 'at cost', unit: '', note: 'Booked on your account or ours, passed through with no markup.' },
  ]);
  if (model === 'fba') grp('Marketplace prep', [
    { label: 'Unit prep', rate: rate(r.fba_prep), unit: 'per unit', note: 'Poly bag, suffocation warning and FNSKU label to Amazon’s prep standard.' },
    { label: 'Carton pack, label & manifest', rate: rate(r.fba_carton), unit: 'per carton' },
    { label: 'Pallet build & stretch-wrap', rate: rate(r.pallet_build), unit: 'per pallet' },
    { label: 'Inbound freight to Amazon', rate: 'at cost', unit: '', note: 'Amazon-partnered carrier or LTL, passed through with no markup.' },
  ]);
  if (model === 'project') grp('Project work', [
    { label: 'Labor', rate: rate(r.project_hr), unit: 'per hour', note: 'Billed in quarter hours against the estimate below; we tell you before we exceed it.' },
    n(r.kit_rate) > 0 ? { label: 'Kit assembly', rate: rate(r.kit_rate), unit: 'per kit' } : null,
    { label: 'Materials', rate: 'at cost', unit: '', note: 'Bags, labels, boxes and inserts we buy for the job, with the receipt.' },
  ]);
  if (parcel && i.packaging !== 'client') grp('Packaging', [
    { label: 'Standard poly mailer', rate: n(r.mailer) > 0 ? rate(r.mailer) : 'included', unit: n(r.mailer) > 0 ? 'per order' : '' },
    { label: 'Shipper box, single-wall', rate: rate(r.box_single), unit: 'per order' },
    { label: 'Shipper box, double-wall', rate: rate(r.box_double), unit: 'per order' },
    { label: 'Your own branded packaging', rate: 'no charge', unit: '', note: 'Send us your boxes, mailers or tissue and we store and use them at no cost.' },
  ]);
  grp('Storage', [
    { label: 'Pallet position', rate: rate(r.storage_pallet), unit: 'per pallet, per month', note: waive('storage') || '48 × 40 in, up to 60 in tall. Billed on the month-end count.' },
    n(r.storage_shelf) > 0 ? { label: 'Shelf', rate: rate(r.storage_shelf), unit: 'per shelf, per month', note: waive('storage') } : null,
    n(r.storage_bin) > 0 ? { label: 'Bin', rate: rate(r.storage_bin), unit: 'per bin, per month', note: waive('storage') } : null,
    model === 'storage' ? { label: 'Pallet in / out handling', rate: rate(r.pallet_move), unit: 'per move' } : null,
  ]);
  grp('Receiving', [
    { label: 'Palletized inbound', rate: rate(r.receiving_pallet), unit: 'per pallet', note: waive('receiving') || 'Counted, inspected for damage and put away within one business day.' },
    { label: 'Loose cartons', rate: rate(r.receiving_carton), unit: 'per carton', note: waive('receiving') },
  ]);
  if (parcel) grp('Returns', [
    { label: 'Return received & logged', rate: rate(r.returns), unit: 'per return', note: 'Logged with reason and condition in your portal within one business day.' },
    n(r.returns_addl) > 0 ? { label: 'Each additional unit in the return', rate: rate(r.returns_addl), unit: 'per unit' } : null,
  ]);
  if (!isOneTime(model)) grp('Account', [
    { label: 'Monthly minimum', rate: n(r.minimum) > 0 ? rate(r.minimum, 0) : 'none', unit: n(r.minimum) > 0 ? 'per month' : '', note: n(r.minimum) > 0 ? (waive('minimum') || 'Fulfillment and storage charges count toward it; postage does not.') : 'You pay for what we do and nothing else.' },
    { label: 'Setup & onboarding', rate: n(r.setup) > 0 ? rate(r.setup, 0) : 'none', unit: n(r.setup) > 0 ? 'one-time' : '' },
    parcel ? { label: 'Postage', rate: n(r.postage_markup_pct) > 0 ? `cost + ${n(r.postage_markup_pct)}%` : 'at cost', unit: '', note: r.postage_guarantee_avg ? `Guaranteed average of ${money(r.postage_guarantee_avg)} per parcel across your mix.` : 'Rate-shopped across USPS, UPS and FedEx at our negotiated rates. You see every label’s cost.' } : null,
  ]);
  return { groups: g, introMonths: introM };
}

const CSS = `
@page { size: letter; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: 'Inter', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #141C26; font-size: 10.25pt; line-height: 1.5; -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
.page { width: 8.5in; height: 11in; padding: 0.72in 0.75in 0.85in; margin: 0 auto; position: relative; page-break-after: always; break-after: page; display: flex; flex-direction: column; overflow: hidden; }
.page > * { flex: 0 0 auto; }
.page:last-child { page-break-after: auto; break-after: auto; }
@media screen { body { background: #e9e7e2; padding: 24px 0; } .page { background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 12px 40px rgba(0,0,0,.08); margin-bottom: 24px; } .toolbar { position: fixed; top: 14px; right: 18px; display: flex; gap: 8px; z-index: 9; } .toolbar button { font: 600 13px Inter, sans-serif; padding: 9px 14px; border-radius: 8px; border: 1px solid #141C26; background: #141C26; color: #fff; cursor: pointer; } .toolbar button.alt { background: #fff; color: #141C26; } }
@media print { body { padding: 0; } .toolbar { display: none; } .page { box-shadow: none; margin: 0; } }
h1, h2, h3, .display { font-family: 'Archivo', 'Inter', sans-serif; letter-spacing: -0.01em; margin: 0; }
p { margin: 0 0 9pt; }
.mast { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 14pt; border-bottom: 1px solid #141C26; }
.mast .logo svg { height: 26px; width: auto; display: block; }
.mast .ref { text-align: right; font-size: 8.5pt; color: #5A6473; line-height: 1.45; }
.mast .ref b { color: #141C26; font-weight: 600; }
.cover-title { margin-top: 38pt; }
.cover-title .kicker { font-size: 8.5pt; letter-spacing: .16em; text-transform: uppercase; color: #D14E00; font-weight: 600; margin-bottom: 10pt; }
.cover-title h1 { font-size: 34pt; line-height: 1.05; font-weight: 700; }
.cover-title h1 i { font-style: normal; color: #FF6B15; }
.cover-for { margin-top: 20pt; display: grid; grid-template-columns: 1fr 1fr; gap: 10pt 28pt; padding: 14pt 0; border-top: 1px solid #E3E0DA; border-bottom: 1px solid #E3E0DA; }
.cover-for small { display: block; font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #5A6473; margin-bottom: 2pt; }
.cover-for b { font-weight: 600; font-size: 11pt; }
.letter { margin-top: 20pt; margin-bottom: 18pt; font-size: 10.25pt; line-height: 1.55; max-width: 6.5in; }
.letter p { margin-bottom: 10pt; }
.sig { margin-top: 10pt; font-size: 9.5pt; }
.sig b { font-weight: 600; }
.sig span { color: #5A6473; }
.glance { margin-top: auto; display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid #141C26; padding-top: 12pt; gap: 18pt; }
.glance small { display: block; font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #5A6473; margin-bottom: 3pt; }
.glance b { font-family: 'Archivo', sans-serif; font-size: 17pt; font-weight: 700; letter-spacing: -0.01em; }
.glance span { display: block; font-size: 8.5pt; color: #5A6473; }
.sec { display: flex; align-items: baseline; gap: 12pt; margin: 0 0 12pt; padding-bottom: 8pt; border-bottom: 1px solid #141C26; }
.sec .no { font-family: 'Archivo', sans-serif; font-size: 9pt; font-weight: 700; color: #FF6B15; letter-spacing: .08em; }
.sec h2 { font-size: 16pt; font-weight: 700; }
.sec .lede { margin-left: auto; font-size: 9pt; color: #5A6473; max-width: 3.4in; text-align: right; }
.sub { font-size: 9.5pt; color: #5A6473; margin: -4pt 0 12pt; max-width: 6.2in; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
th { text-align: left; font-size: 7.5pt; letter-spacing: .1em; text-transform: uppercase; color: #5A6473; font-weight: 600; padding: 0 6pt 5pt 0; border-bottom: 1px solid #141C26; }
td { padding: 5.5pt 6pt 5.5pt 0; border-bottom: 1px solid #ECEAE5; vertical-align: top; }
td.n, th.n { text-align: right; padding-right: 0; white-space: nowrap; }
td.u { width: 1.45in; white-space: nowrap; color: #5A6473; padding-left: 10pt; }
td .d { display: block; font-size: 8.5pt; color: #5A6473; line-height: 1.4; margin-top: 1pt; }
tr.g td { padding-top: 11pt; padding-bottom: 3pt; border-bottom: none; font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 9pt; letter-spacing: .02em; }
tr.g:first-child td { padding-top: 4pt; }
tr.sub td { font-weight: 600; border-bottom: 1px solid #141C26; }
tr.tot td { font-weight: 700; font-size: 11pt; border-bottom: none; padding-top: 8pt; font-family: 'Archivo', sans-serif; }
tr.zero td { color: #8A93A0; }
.intro-col { color: #D14E00; font-weight: 600; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28pt; }
.inc { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 28pt; }
.inc li { break-inside: avoid; padding: 5pt 0 5pt 14pt; position: relative; border-bottom: 1px solid #ECEAE5; font-size: 9.25pt; }
.inc li::before { content: ''; position: absolute; left: 0; top: 10.5pt; width: 6pt; height: 6pt; border-radius: 50%; background: #FF6B15; }
.inc li b { display: block; font-weight: 600; }
.inc li span { color: #5A6473; font-size: 8.5pt; line-height: 1.4; }
.panel { border: 1px solid #141C26; padding: 12pt 14pt; margin-top: 14pt; display: grid; grid-template-columns: 1.2fr 1fr 1fr 1fr; gap: 12pt; }
.panel h3 { grid-column: 1 / -1; font-size: 11pt; font-weight: 700; margin-bottom: 2pt; }
.panel small { display: block; font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #5A6473; }
.panel b { font-family: 'Archivo', sans-serif; font-size: 15pt; font-weight: 700; }
.panel p { grid-column: 1 / -1; font-size: 9pt; color: #5A6473; margin: 0; }
.phase { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12pt; margin-top: 14pt; }
.phase div { border-top: 2px solid #141C26; padding-top: 7pt; }
.phase small { display: block; font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #5A6473; }
.phase b { font-family: 'Archivo', sans-serif; font-size: 15pt; font-weight: 700; display: block; }
.phase span { font-size: 8.5pt; color: #5A6473; }
.steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14pt; }
.steps div { border-top: 2px solid #141C26; padding-top: 8pt; }
.steps small { display: block; font-family: 'Archivo', sans-serif; font-size: 9pt; font-weight: 700; color: #FF6B15; letter-spacing: .08em; margin-bottom: 4pt; }
.steps b { display: block; font-weight: 600; font-size: 10pt; margin-bottom: 3pt; }
.steps span { font-size: 9pt; color: #5A6473; line-height: 1.45; }
.terms h3 { font-size: 9.5pt; font-weight: 700; margin: 12pt 0 3pt; }
.terms p { font-size: 9.5pt; margin-bottom: 4pt; }
.accept { margin-top: 22pt; border-top: 1px solid #141C26; padding-top: 12pt; display: grid; grid-template-columns: 1fr 1fr; gap: 28pt; }
.accept .line { margin-top: 30pt; border-bottom: 1px solid #141C26; height: 1px; }
.accept small { display: block; font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; color: #5A6473; margin-top: 4pt; }
.accept b { font-weight: 600; font-size: 10pt; display: block; }
.foot { position: absolute; left: 0.75in; right: 0.75in; bottom: 0.42in; display: flex; justify-content: space-between; gap: 16pt; white-space: nowrap; font-size: 7.5pt; color: #8A93A0; letter-spacing: .02em; border-top: 1px solid #ECEAE5; padding-top: 6pt; }
.foot b { color: #5A6473; font-weight: 600; }
.hl { margin: 14pt 0 0; padding: 0; list-style: none; }
.hl li { padding: 6pt 0 6pt 16pt; position: relative; border-top: 1px solid #ECEAE5; font-size: 10pt; }
.hl li::before { content: ''; position: absolute; left: 0; top: 12pt; width: 7pt; height: 2px; background: #FF6B15; }
.note { font-size: 8.5pt; color: #5A6473; margin-top: 8pt; }
`;

/** Build the full HTML document for a quote (or a generic rate card when q.generic is set). */
export function proposalHtml(q, opts = {}) {
  const origin = opts.origin || (typeof window !== 'undefined' ? window.location.origin : '');
  const P = { ...DEFAULT_PROPOSAL, ...(q.proposal || {}) };
  const model = MODEL[modelOf(q)];
  const oneTime = isOneTime(model.key);
  const generic = !!q.generic;
  const today = new Date();
  const validUntil = new Date(today); validUntil.setDate(validUntil.getDate() + n(P.valid_days, 30));
  const ref = `SB-${today.getFullYear().toString().slice(2)}${String(today.getMonth() + 1).padStart(2, '0')}-${String(q.id || '').replace(/-/g, '').slice(0, 4).toUpperCase() || 'CARD'}`;
  const phs = phases(q);
  const vol = n(q.inputs?.orders);
  const m = compute(q, vol, phs[0].key);
  const mStd = compute(q, vol, 'standard');
  const sched = rateSchedule(q);
  const svcs = serviceList(q).filter((s) => s.on);
  const inc = INCLUDED.filter((x) => (P.included || []).includes(x.key));
  const title = generic ? 'Rate card' : P.title || 'Fulfillment proposal';
  const company = generic ? 'Growing brands' : q.company;
  const foot = (pg, total) => `<div class="foot"><span><b>ShipBay</b> · 115 Stryker Lane, Hillsborough Township, NJ 08844 · shipbay3pl.com</span><span>${esc(title)} · ${esc(company)} · ${ref}</span><span>${pg} / ${total}</span></div>`;
  const periodWord = oneTime ? 'project' : 'month';
  let secNo = 0; const sec = (h, lede) => `<div class="sec"><span class="no">0${++secNo}</span><h2>${h}</h2>${lede ? `<div class="lede">${lede}</div>` : ''}</div>`;

  /* ---- page 1: masthead, title, letter, glance ---- */
  const glance = generic ? `
    <div><small>Pick & pack from</small><b>${rate(q.rates?.pick_first)}</b><span>per order, mailer included</span></div>
    <div><small>Pallet storage</small><b>${rate(q.rates?.storage_pallet, 0)}</b><span>per pallet, per month</span></div>
    <div><small>Monthly minimum</small><b>${n(q.rates?.minimum) ? rate(q.rates.minimum, 0) : 'None'}</b><span>${n(q.rates?.minimum_waived_months) ? `waived first ${n(q.rates.minimum_waived_months)} months` : 'pay for what we do'}</span></div>
    <div><small>Contract</small><b>Monthly</b><span>30 days’ notice, no setup fee</span></div>`
    : `
    <div><small>${oneTime ? 'Project total' : 'Estimated services / month'}</small><b>${money(m.services, 0)}</b><span>at ${num(vol)} ${model.unit}${phs.length > 1 ? ` · ${phs[0].label.toLowerCase()}` : ''}</span></div>
    <div><small>Per ${model.unit.replace(/s$/, '')}, services</small><b>${money(m.servicesPerOrder)}</b><span>${m.postage && P.show_postage ? `${money(m.perOrder)} with postage` : 'all handling included'}</span></div>
    ${m.postage && P.show_postage ? `<div><small>Postage estimate</small><b>${money(m.postage, 0)}</b><span>at cost, ${money(q.rates?.postage_guarantee_avg || q.inputs?.avg_postage)} avg per parcel</span></div>` : `<div><small>Model</small><b>${esc(model.short)}</b><span>${esc(model.label)}</span></div>`}
    <div><small>Terms</small><b>${n(q.rates?.minimum) && !oneTime ? rate(q.rates.minimum, 0) + ' min' : 'No minimum'}</b><span>${oneTime ? 'quoted as one project' : 'month-to-month, no setup fee'}</span></div>`;
  const page1 = `<section class="page">
    <div class="mast"><div class="logo">${LOGO}</div><div class="ref"><b>${esc(title)}</b><br>${longDate(today)}<br>Ref. ${ref}</div></div>
    <div class="cover-title"><div class="kicker">${generic ? 'E-commerce fulfillment · Hillsborough, New Jersey' : esc(model.label) + ' fulfillment'}</div><h1>${generic ? 'Fulfillment that<br>fits a growing brand<i>.</i>' : `Prepared for<br>${esc(q.company)}<i>.</i>`}</h1></div>
    <div class="cover-for">
      ${generic ? `<div><small>Prepared by</small><b>${esc(P.prepared_by)}</b><div>${esc(P.prepared_title)}</div></div><div><small>Rates effective</small><b>${longDate(today)}</b><div>Reviewed quarterly</div></div>`
        : `<div><small>Attention</small><b>${esc(q.contact_name || 'The founders')}</b><div>${esc(q.contact_email || '')}</div></div><div><small>Prepared by</small><b>${esc(P.prepared_by)}</b><div>${esc(P.prepared_title)} · ${esc(P.prepared_email)}${P.prepared_phone ? ' · ' + esc(P.prepared_phone) : ''}</div></div><div><small>Valid through</small><b>${longDate(validUntil)}</b></div><div><small>Basis</small><b>${num(vol)} ${model.unit}${oneTime ? '' : ' a month'}</b><div>${esc(model.label)}</div></div>`}
    </div>
    <div class="letter">${generic
      ? paras('This is our standard rate card. Every number on it is what a new account pays from day one; there are no setup fees, no long-term contract and no surcharges that aren’t printed here.\n\nWe built ShipBay for brands doing a few hundred to a few thousand orders a month: the ones the large 3PLs treat as a ticket number. You get the same integrations and carrier rates, a warehouse 45 minutes from Newark, and a person who answers the phone.')
      : paras(fill(P.intro, q))}
      ${!generic && (P.highlights || []).filter(Boolean).length ? `<ul class="hl">${P.highlights.filter(Boolean).map((h) => `<li>${esc(fill(h, q))}</li>`).join('')}</ul>` : ''}
      ${generic ? '' : `<div class="sig"><b>${esc(P.prepared_by)}</b> <span>· ${esc(P.prepared_title)}</span></div>`}
    </div>
    <div class="glance">${glance}</div>
  </section>`;

  /* ---- page 2: rate schedule ---- */
  const schedRows = sched.groups.map((g) => `<tr class="g"><td colspan="${sched.introMonths ? 4 : 3}">${esc(g.title)}</td></tr>` + g.rows.map((r) => `<tr><td>${esc(r.label)}${r.note ? `<span class="d">${esc(r.note)}</span>` : ''}</td>${sched.introMonths ? `<td class="n intro-col">${r.intro ?? ''}</td>` : ''}<td class="n">${esc(r.rate)}</td><td class="u">${esc(r.unit)}</td></tr>`).join('')).join('');
  const page2 = `<section class="page">
    ${sec(generic ? 'Rates' : 'Your rates', oneTime ? 'Everything below is per unit of work; the project total is on the next page.' : 'Every charge you can be billed is on this page. Anything not listed here is not billed.')}
    <table><thead><tr><th>Service</th>${sched.introMonths ? `<th class="n">Founding rate<br>months 1–${sched.introMonths}</th>` : ''}<th class="n">${sched.introMonths ? 'Standard rate' : 'Rate'}</th><th style="padding-left:10pt">Unit</th></tr></thead><tbody>${schedRows}</tbody></table>
    ${sched.introMonths ? `<p class="note">Founding rates apply to your first ${sched.introMonths} months with us, then the standard rate. We will tell you a month ahead before anything changes on the invoice.</p>` : ''}
  </section>`;

  /* ---- page 3: services & included ---- */
  const vasRows = svcs.map((s) => `<tr><td>${esc(s.label)}<span class="d">${esc(s.note || s.desc)}</span></td><td class="n">${s.price > 0 ? money(s.price) : 'included'}</td><td class="u">${esc(s.unit)}</td></tr>`).join('');
    const svcSec = generic ? sec('Value-added services', 'Switch any of these on from your portal; each bills only when it happens.') : sec('Services we’ve added for you', svcs.length ? 'Chosen for the way you sell. Each one bills only when it happens.' : 'None added yet — the base rates cover everything you described.');
  const incBlock = inc.length ? `<div style="margin-top:${generic ? 0 : 22}pt">${sec('Included with every account', '')}<ul class="inc">${inc.map((x) => `<li><b>${esc(x.label)}</b><span>${esc(x.desc)}</span></li>`).join('')}</ul></div>` : '';
  const tbl = (rows) => `<table><thead><tr><th>Service</th><th class="n">Rate</th><th style="padding-left:10pt">Unit</th></tr></thead><tbody>${rows}</tbody></table>`;
  let page3, page3b = [], incPlaced = false;
  if (generic) {
    const all = serviceList(q); const per = 12;
    const row = (s) => `<tr><td>${esc(s.label)}<span class="d">${esc(s.desc)}</span></td><td class="n">${s.price > 0 ? money(s.price) : 'included'}</td><td class="u">${esc(s.unit)}</td></tr>`;
    page3 = `<section class="page">${svcSec}${tbl(all.slice(0, per).map(row).join(''))}</section>`;
    for (let i = per; i < all.length; i += per) { const last = i + per >= all.length && all.length - i <= 5; page3b.push(`<section class="page"><div class="sec"><span class="no">0${secNo - 1}</span><h2>Value-added services, continued</h2></div>${tbl(all.slice(i, i + per).map(row).join(''))}${last ? `<div style="margin-top:22pt">${incBlock}</div>` : ''}</section>`); if (last) incPlaced = true; }
  } else {
    const split = svcs.length > 7;   // a long list of services gets its own page so nothing clips
    page3 = `<section class="page">
    ${svcSec}
    ${vasRows ? tbl(vasRows) : ''}
    ${split ? '' : incBlock}
  </section>`;
    if (split) page3b.push(`<section class="page">${incBlock.replace('margin-top:22pt', 'margin-top:0')}</section>`);
  }
  /* ---- worked example, phases, drop plan ---- */
  const ex = generic ? '' : (() => {
    const rows = [...m.lines, ...m.vasLines].filter((l) => l.amount > 0 || /waived/i.test(l.label)).map((l) => `<tr class="${l.amount === 0 ? 'zero' : ''}"><td>${esc(l.label)}</td><td class="n">${l.qty ? num(l.qty) : '—'}</td><td class="n">${l.qty ? money(l.rate) : '—'}</td><td class="n">${money(l.amount)}</td></tr>`).join('');
    const post = m.postage && P.show_postage ? `<tr><td colspan="3">Postage, billed at cost — ${num(vol)} parcels at about ${money(q.rates?.postage_guarantee_avg || q.inputs?.avg_postage)}</td><td class="n">${money(m.postage)}</td></tr>` : '';
    const setupRows = m.setup.length ? m.setup.map((l) => `<tr><td colspan="3">${esc(l.label)} <span style="color:#5A6473">(one-time)</span></td><td class="n">${l.amount > 0 ? money(l.amount) : 'included'}</td></tr>`).join('') : '';
    return `<table><thead><tr><th>Line</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>${rows}
      <tr class="sub"><td colspan="3">${oneTime ? 'Project services' : 'Services for the month'}</td><td class="n">${money(m.services)}</td></tr>${post}${setupRows}
      <tr class="tot"><td colspan="3">${oneTime ? 'Project total' : 'Estimated total'}${m.postage && P.show_postage ? '' : ' (before postage)'} · ${money(m.postage && P.show_postage ? m.perOrder : m.servicesPerOrder)} per ${model.unit.replace(/s$/, '')}</td><td class="n">${money(m.postage && P.show_postage ? m.allIn + m.setupTotal : m.services + m.setupTotal)}</td></tr>
    </tbody></table>`;
  })();
  const phaseBlock = !generic && P.show_phases && phs.length > 1 ? `<div class="phase">${phs.map((p) => { const x = compute(q, vol, p.key); return `<div><small>${esc(p.label)}</small><b>${money(x.services, 0)}</b><span>${money(x.servicesPerOrder)} per ${model.unit.replace(/s$/, '')} · ${p.key === 'waived' ? 'founding rates, waivers on' : p.key === 'intro' ? 'founding rates' : 'standard rates'}</span></div>`; }).join('')}</div>` : '';
  const batchBlock = !generic && P.show_batch && m.batch ? `<div class="panel"><h3>${model.key === 'launch' ? 'Your launch window' : `Your drop plan`}</h3>
      <div><small>${model.key === 'launch' ? 'Packages' : 'Boxes per drop'}</small><b>${num(m.batch.orders)}</b></div><div><small>Ship window</small><b>${m.batch.days} day${m.batch.days === 1 ? '' : 's'}</b></div><div><small>Per day</small><b>${num(m.batch.ordersPerDay)}</b></div><div><small>Packers assigned</small><b>${m.batch.headcount}</b></div>
      <p>We staff ${m.batch.headcount} packer${m.batch.headcount === 1 ? '' : 's'} to your ${model.key === 'launch' ? 'launch' : 'drop'} (about ${Math.round(m.batch.hours)} labor hours) so every ${model.unit.replace(/s$/, '')} leaves inside the window${m.batch.drops > 1 ? `, ${m.batch.drops} drops a month` : ''}${m.batch.trickle ? `, with ${num(m.batch.trickle)} off-cycle ${model.unit} a month shipped same-day as they arrive` : ''}. Confirm your ship date ten business days out and the inventory is staged before day one.</p></div>` : '';
  const page4 = generic ? (incPlaced ? '' : `<section class="page">${incBlock}</section>`) : `<section class="page">
    ${sec(oneTime ? 'The project total' : 'A typical month', `Worked at ${num(vol)} ${model.unit}${oneTime ? '' : ' with the storage and inbound volume you described'}. Your invoice itemizes exactly like this.`)}
    ${P.show_example ? ex : ''}${phaseBlock}${batchBlock}
  </section>`;
  const steps = oneTime
    ? [['Confirm', 'You confirm quantities and the ship window; we reserve the dates and the dock.'], ['Receive', 'Inventory arrives, is counted against your packing list and staged by SKU.'], ['Test', 'We build and photograph one package to your spec for sign-off before the run.'], ['Ship', 'The run starts on day one and you get tracking for every package as it leaves.']]
    : [['Week 1 · Connect', 'We link your store or Veeqo, import SKUs and load your packing-slip template.'], ['Week 1–2 · Receive', 'Your first inbound is counted, inspected and put away; you watch it land in the portal.'], ['Week 2 · Test', 'A test order runs end to end so you see the pack, the label and the tracking before go-live.'], ['Go-live', 'Orders flow in automatically. Your account lead checks in daily for the first two weeks.']];
  const page5 = `<section class="page">
    ${sec(oneTime ? 'How the project runs' : 'Getting started', generic ? 'From signed proposal to first shipment in about two weeks.' : 'From a yes to your first shipment in about two weeks.')}
    <div class="steps">${steps.map(([h, t], i) => `<div><small>0${i + 1}</small><b>${esc(h)}</b><span>${esc(t)}</span></div>`).join('')}</div>
    <div class="terms" style="margin-top:22pt">${sec('Terms', '')}
      <div class="cols">
        <div><h3>Billing</h3><p>${esc(fill(P.payment_terms, q))}</p><h3>Agreement</h3><p>${esc(fill(P.term, q))}</p>${oneTime ? `<h3>Estimate</h3><p>The total is an estimate built from the quantities you gave us. We bill the actual quantities at these rates and tell you before anything runs more than ten percent over.</p>` : `<h3>Postage & carriers</h3><p>Labels are bought on our carrier accounts and passed through at cost, or on yours if you prefer. Carrier surcharges and address corrections are passed through as charged.</p>`}</div>
        <div><h3>Storage & inventory</h3><p>Storage is billed on the month-end count of occupied positions. We carry warehouse legal liability on inventory in our care; declared-value cargo insurance is available at cost.</p><h3>Accuracy</h3><p>Every order is scan-verified at pack. If we ship the wrong item, we reship at our cost and cover the return postage.</p><h3>Validity</h3><p>These rates are good through ${longDate(validUntil)} and, once accepted, are reviewed no more than once a year with thirty days’ written notice.</p></div>
      </div>
    </div>
    ${!generic && P.signature ? `<div class="accept"><div><small>Accepted for ${esc(q.company)}</small><div class="line"></div><small>Name, title and date</small></div><div><b>${esc(P.prepared_by)}</b><span style="font-size:9pt;color:#5A6473">${esc(P.prepared_title)} · ${esc(P.prepared_email)}</span><div class="line" style="margin-top:14pt"></div><small>For ShipBay</small></div></div>`
      : `<div class="accept" style="grid-template-columns:1fr"><div><b>Ready when you are</b><span style="font-size:9.5pt;color:#5A6473">Email ${esc(P.prepared_email)} or call and we’ll have a proposal built around your numbers within a business day.</span></div></div>`}
  </section>`;

  const inner = [page1, page2, page3, ...page3b, page4, page5].filter(Boolean);
  const pages = inner.map((h, i) => (i === 0 ? h : h.replace(/<\/section>$/, `${foot(i + 1, inner.length)}</section>`)));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} — ${esc(company)} — ShipBay</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}</style></head><body>
  <div class="toolbar"><button class="alt" onclick="window.close()">Close</button><button onclick="window.print()">Save as PDF</button></div>
  ${pages.join('')}
  <script>${opts.autoPrint ? "document.fonts.ready.then(function(){ setTimeout(function(){ window.print(); }, 250); });" : ''}</script>
  </body></html>`;
}

/** Open the document in a new tab; with print=true the Save-as-PDF dialog opens once fonts have loaded. */
export function openProposal(q, { print = false } = {}) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open(); w.document.write(proposalHtml(q, { autoPrint: print })); w.document.close();
  return true;
}
