// Quotes — every prospect quote: the model (DTC, batch drop, wholesale, FBA prep, launch, storage, project), the
// client's bill, the value-added services switched on, ShipBay's labor & cost model, the contribution at three
// volumes, and the proposal document that prints to PDF. Plus the standard rate card against industry benchmarks.
// Math lives in ../quote.js, the printed document in ../proposal.js; a quote row is just the saved inputs.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
import { compute, scenarios, phases, ratesFromCard, serviceList, money, pct, fmtVol, MODELS, MODEL, modelOf, isOneTime, VAS_GROUPS, INCLUDED, DEFAULT_INCLUDED, DEFAULT_PROPOSAL, BENCHMARKS, BENCHMARK_SOURCES, DEFAULT_INPUTS, DEFAULT_COSTS } from '../quote';
import { openProposal } from '../proposal';

const STATUS = { draft: ['Draft', 'muted'], sent: ['Sent', 'navy'], accepted: ['Accepted', 'ok'], declined: ['Declined', 'bad'], superseded: ['Superseded', 'muted'] };
const PACKAGING = [['client', 'Client-supplied'], ['shipbay', 'ShipBay supplies']];
const PARCEL = ['dtc', 'hybrid', 'subscription', 'launch'];

export default function Quotes({ me }) {
  const [quotes, setQuotes] = useState(null);
  const [card, setCard] = useState(null);
  const [sel, setSel] = useState('card');
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const [{ data: q }, { data: c }] = await Promise.all([
      supabase.from('quotes').select('*').order('company').order('internal_only').order('created_at'),
      supabase.from('rate_cards').select('*').eq('scope', 'standard').eq('status', 'current').maybeSingle(),
    ]);
    setQuotes(q || []); setCard(c || null);
    if (sel === 'card' && q?.length && !c) setSel(q[0].id);
  };
  useEffect(() => { load(); }, []);

  const flash = (kind, text) => setMsg({ kind, text });
  const createQuote = async (f) => {
    const orders = Number(f.orders) || DEFAULT_INPUTS.orders;
    const rates = card ? ratesFromCard(card, orders) : {};
    const inputs = { ...DEFAULT_INPUTS, orders, ...(f.model === 'subscription' ? { batch_share: 1, batch_days: 3, drops_per_month: 1, units_per_order: 4 } : {}), ...(f.model === 'launch' ? { batch_days: 5, storage_months: 2, pallets: 6, inbound_pallets: 6 } : {}), ...(f.model === 'b2b' ? { pallets_out: Math.ceil(orders / 4) } : {}), ...(f.model === 'fba' ? { cartons_out: Math.ceil(orders / 24), pallets_out: Math.ceil(orders / 800) } : {}), ...(f.model === 'storage' ? { pallets: orders, pallet_moves: Math.ceil(orders / 2), shelves: 0 } : {}), ...(f.model === 'project' ? { kits: 0, materials: 0, pallets: 0, shelves: 0, inbound_pallets: 1, inbound_cartons: 0 } : {}) };
    const { data, error } = await supabase.from('quotes').insert({ company: f.company.trim(), contact_name: f.contact_name || null, contact_email: f.contact_email || null, label: f.label || 'Quote', model: f.model, inputs, rates, costs: DEFAULT_COSTS, services: {}, proposal: { included: DEFAULT_INCLUDED }, scenarios: [orders, Math.round(orders * 1.5), orders * 2], created_by: me?.id }).select().single();
    if (error) return flash('err', error.message);
    setAdding(false); await load(); setSel(data.id);
  };

  const groups = useMemo(() => { const g = {}; for (const q of quotes || []) (g[q.company] ||= []).push(q); return g; }, [quotes]);
  const current = sel !== 'card' ? (quotes || []).find((q) => q.id === sel) : null;

  return (
    <>
      <div className="pagehead">
        <div><h1>Quotes<span className="dot">.</span></h1><p className="sub">What each prospect pays, what it costs us to serve them, and what’s left. Pick the model that fits how they sell, switch on the extras they need, and print a proposal they can sign.</p></div>
        <div className="glance">
          <div><small>Quotes</small><b>{(quotes || []).filter((q) => !q.internal_only).length}</b></div>
          <div><small>Sent</small><b>{(quotes || []).filter((q) => q.status === 'sent').length}</b></div>
          <div><small>Accepted</small><b>{(quotes || []).filter((q) => q.status === 'accepted').length}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="ops quotes">
        <div className="card queue">
          <div className="cardhead"><h3>Prospects</h3><div className="spacer" /><button className="btn-xs primary" onClick={() => setAdding(true)}>+ New quote</button></div>
          <ul className="queuelist">
            <li><button className={`qitem ${sel === 'card' ? 'active' : ''}`} onClick={() => setSel('card')}><div className="top"><b>Standard rate card</b><span className={`pill ${card ? 'connected' : 'pending'}`}>{card ? 'current' : 'missing'}</span></div><div className="meta">Published tiers · industry comparison · printable</div></button></li>
            {quotes === null ? <li className="empty">Loading…</li> : Object.entries(groups).map(([company, list]) => list.map((q) => (
              <li key={q.id}><button className={`qitem ${sel === q.id ? 'active' : ''}`} onClick={() => setSel(q.id)}>
                <div className="top"><b>{company}</b><span className={`statuspill ${STATUS[q.status]?.[1]}`}>{STATUS[q.status]?.[0]}</span></div>
                <div className="meta"><span className="pill tiny">{MODEL[modelOf(q)].short}</span> {q.label}{q.internal_only ? ' · internal' : ''} · {fmtVol(q, q.inputs?.orders)}{q.contact_name ? ` · ${q.contact_name}` : ''}</div>
              </button></li>
            )))}
          </ul>
        </div>

        {sel === 'card' ? <RateCard card={card} onSaved={() => { load(); flash('ok', 'Standard rate card saved.'); }} onErr={(t) => flash('err', t)} me={me} />
          : current ? <QuoteDetail key={current.id} q={current} card={card} onSaved={(t) => { load(); flash('ok', t || 'Quote saved.'); }} onErr={(t) => flash('err', t)} />
          : <div className="card detail"><div className="empty">Pick a quote on the left.</div></div>}
      </div>
      {adding && <NewQuote onClose={() => setAdding(false)} onCreate={createQuote} />}
    </>
  );
}

/* ---------- new quote: company + model ---------- */
function NewQuote({ onClose, onCreate }) {
  const [f, setF] = useState({ company: '', contact_name: '', contact_email: '', label: 'Quote', model: 'dtc', orders: 500 });
  const [busy, setBusy] = useState(false);
  const m = MODEL[f.model];
  const submit = async (e) => { e.preventDefault(); if (!f.company.trim()) return; setBusy(true); await onCreate(f); setBusy(false); };
  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New quote<span className="dot">.</span></h3>
        <p className="lead">Start from how they sell. Every number is editable afterwards and the quote starts from the standard rate card.</p>
        <div className="grid2">
          <div className="field"><label>Company</label><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} autoFocus required /></div>
          <div className="field"><label>Quote label</label><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
          <div className="field"><label>Contact name</label><input value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} /></div>
          <div className="field"><label>Contact email</label><input type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} /></div>
        </div>
        <div className="lbl">Quote model</div>
        <div className="modelgrid">
          {MODELS.map((x) => <label key={x.key} className={f.model === x.key ? 'on' : ''}><input type="radio" name="model" checked={f.model === x.key} onChange={() => setF({ ...f, model: x.key })} /><b>{x.label}</b><span>{x.desc}</span></label>)}
        </div>
        <div className="field" style={{ maxWidth: 260 }}><label>{m.volume}</label><input type="number" min={1} value={f.orders} onChange={(e) => setF({ ...f, orders: e.target.value })} /></div>
        <div className="actions"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy || !f.company.trim()}>{busy ? 'Creating…' : 'Create quote'}</button></div>
      </form>
    </div>
  );
}

/* ---------- number input that keeps the draft editable ---------- */
function Num({ label, value, onChange, step = 1, min, prefix, suffix, help, small }) {
  return (
    <label className={`qf ${small ? 'small' : ''}`}>
      <span>{label}</span>
      <div className="qin">{prefix && <i>{prefix}</i>}<input type="number" step={step} min={min} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />{suffix && <i>{suffix}</i>}</div>
      {help && <small>{help}</small>}
    </label>
  );
}
function Txt({ label, value, onChange, rows, help, placeholder }) {
  return (
    <label className="qf text"><span>{label}</span>{rows ? <textarea rows={rows} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /> : <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}{help && <small>{help}</small>}</label>
  );
}

const norm = (q) => ({ model: modelOf(q), inputs: { ...DEFAULT_INPUTS, ...(q.inputs || {}) }, rates: { intro: { months: 0 }, ...(q.rates || {}) }, costs: { ...DEFAULT_COSTS, ...(q.costs || {}) }, services: q.services || {}, proposal: { ...DEFAULT_PROPOSAL, ...(q.proposal || {}) }, scenarios: q.scenarios?.length ? q.scenarios : [q.inputs?.orders || 500], notes: q.notes, label: q.label, status: q.status, internal_only: q.internal_only, contact_name: q.contact_name, contact_email: q.contact_email, contact_phone: q.contact_phone });

/* ---------- Quote detail ---------- */
function QuoteDetail({ q, card, onSaved, onErr }) {
  const [d, setD] = useState(() => ({ ...q, ...norm(q) }));
  const [phase, setPhase] = useState(null);
  const [tab, setTab] = useState('pricing');
  const [busy, setBusy] = useState(false);
  const [showCosts, setShowCosts] = useState(true);
  const setI = (k, v) => setD((x) => ({ ...x, inputs: { ...x.inputs, [k]: v } }));
  const setR = (k, v) => setD((x) => ({ ...x, rates: { ...x.rates, [k]: v } }));
  const setIntro = (k, v) => setD((x) => ({ ...x, rates: { ...x.rates, intro: { ...(x.rates.intro || {}), [k]: v } } }));
  const setC = (k, v) => setD((x) => ({ ...x, costs: { ...x.costs, [k]: v } }));
  const setP = (k, v) => setD((x) => ({ ...x, proposal: { ...x.proposal, [k]: v } }));
  const setS = (key, patch) => setD((x) => ({ ...x, services: { ...x.services, [key]: { ...(x.services[key] || {}), ...patch } } }));
  const dirty = JSON.stringify(norm(d)) !== JSON.stringify(norm(q));

  const model = d.model; const M = MODEL[model]; const oneTime = isOneTime(model); const parcel = PARCEL.includes(model);
  const phs = useMemo(() => phases(d), [d]);
  const hasIntro = phs.length > 1;
  const cur = phs.find((p) => p.key === phase) || phs[0];
  const ph = cur.key;
  const vol = Number(d.inputs.orders) || 0;
  const m = useMemo(() => compute(d, vol, ph), [d, ph, vol]);
  const sc = useMemo(() => scenarios(d), [d]);
  const svc = useMemo(() => serviceList(d), [d]);
  const vasTotal = m.vasLines.reduce((s, l) => s + l.amount, 0);

  const payload = () => ({ model: d.model, inputs: d.inputs, rates: d.rates, costs: d.costs, services: d.services, proposal: d.proposal, scenarios: d.scenarios.map(Number).filter(Boolean), notes: d.notes, label: d.label, status: d.status, internal_only: d.internal_only, contact_name: d.contact_name, contact_email: d.contact_email, contact_phone: d.contact_phone });
  const save = async (extra = {}) => {
    setBusy(true);
    const { error } = await supabase.from('quotes').update({ ...payload(), ...extra }).eq('id', q.id);
    setBusy(false);
    if (error) return onErr(error.message);
    onSaved();
  };
  const useStandard = () => { if (!card) return onErr('No standard rate card yet.'); const r = ratesFromCard(card, vol); setD((x) => ({ ...x, rates: { ...r, intro: x.rates.intro || { months: 0 } } })); };
  const duplicate = async () => {
    const { error } = await supabase.from('quotes').insert({ org_id: q.org_id, company: q.company, ...payload(), label: `${d.label} (copy)`, status: 'draft' });
    if (error) return onErr(error.message); onSaved('Copied — it’s in the list as a draft.');
  };
  const toRateCard = async () => {
    if (!q.org_id) return onErr('This prospect isn’t a client yet — convert them under Onboarding first, then push the rates.');
    if (!window.confirm(`Write these rates as ${q.company}’s rate card? Their current card is retired and billing uses the new one from today.`)) return;
    const r = d.rates; const intro = Number(r.intro?.months) > 0;
    const today = new Date(); const addM = (mo) => { const t = new Date(today); t.setMonth(t.getMonth() + mo); return t.toISOString().slice(0, 10); };
    await supabase.from('rate_cards').update({ status: 'retired', effective_to: today.toISOString().slice(0, 10) }).eq('org_id', q.org_id).eq('scope', 'org').eq('status', 'current');
    const base = { org_id: q.org_id, scope: 'org', status: 'current', storage_pallet: r.storage_pallet, storage_shelf: r.storage_shelf, storage_bin: r.storage_bin, receiving_pallet: r.receiving_pallet, receiving_carton: r.receiving_carton, returns_fee: r.returns, packaging_mailer: r.mailer, packaging_box_single: r.box_single, packaging_box_double: r.box_double, intl_surcharge: r.intl, monthly_minimum: r.minimum, postage_markup_pct: r.postage_markup_pct, postage_guarantee_avg: r.postage_guarantee_avg || null, extras: { returns_addl: r.returns_addl, b2b_order: r.b2b_order, b2b_unit: r.b2b_unit, pallet_build: r.pallet_build, assembly: r.assembly, fba_prep: r.fba_prep, fba_carton: r.fba_carton, pallet_move: r.pallet_move, kitting_hr: r.project_hr, kit_rate: r.kit_rate, services: d.services, model: d.model } };
    const rows = [];
    if (intro) rows.push({ ...base, label: `${d.label} — founding (${r.intro.months} mo)`, effective_from: today.toISOString().slice(0, 10), effective_to: addM(r.intro.months), pick_pack_first: r.intro.pick_first ?? r.pick_first, pick_pack_addl: r.intro.pick_addl ?? r.pick_addl, storage_waived_until: Number(r.storage_waived_months) ? addM(Number(r.storage_waived_months)) : null, minimum_waived_until: Number(r.minimum_waived_months) ? addM(Number(r.minimum_waived_months)) : null, storage_waived_months: r.storage_waived_months || 0, minimum_waived_months: r.minimum_waived_months || 0, notes: `From quote "${d.label}"` });
    rows.push({ ...base, label: intro ? `${d.label} — standard` : d.label, status: intro ? 'draft' : 'current', effective_from: intro ? addM(r.intro.months) : today.toISOString().slice(0, 10), pick_pack_first: r.pick_first, pick_pack_addl: r.pick_addl, storage_waived_months: 0, minimum_waived_months: 0, notes: `From quote "${d.label}"` });
    const { error } = await supabase.from('rate_cards').insert(rows);
    if (error) return onErr(error.message);
    await save({ status: 'accepted', decided_at: new Date().toISOString() });
  };
  const preview = (print) => { if (!openProposal({ ...q, ...d }, { print })) onErr('Your browser blocked the new tab — allow pop-ups for dashboard.shipbay3pl.com and try again.'); };

  const unitWord = M.unit.replace(/s$/, '');
  return (
    <div className="card detail quote">
      <div className="cardhead">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h3>{q.company} <input className="inline" value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} /></h3>
          <div className="small"><input className="inline sm" placeholder="Contact" value={d.contact_name || ''} onChange={(e) => setD({ ...d, contact_name: e.target.value })} /> · <input className="inline sm" placeholder="email" value={d.contact_email || ''} onChange={(e) => setD({ ...d, contact_email: e.target.value })} /> · <input className="inline sm" placeholder="phone" value={d.contact_phone || ''} onChange={(e) => setD({ ...d, contact_phone: e.target.value })} />{q.org_id ? ' · client' : ' · prospect'}</div>
        </div>
        <select className="statusselect" value={d.model} onChange={(e) => setD({ ...d, model: e.target.value })} title="Quote model">{MODELS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
        <select className={`statusselect ${STATUS[d.status]?.[1]}`} value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })}>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <label className="chk"><input type="checkbox" checked={!!d.internal_only} onChange={(e) => setD({ ...d, internal_only: e.target.checked })} /> internal</label>
        <button className="btn-sm" onClick={useStandard} title="Replace the price lines with the standard rate card at this volume">Use standard rates</button>
        <button className="btn-sm" onClick={duplicate}>Duplicate</button>
        {q.org_id && !d.internal_only && <button className="btn-sm" onClick={toRateCard} disabled={busy}>Make it their rate card</button>}
        <button className="btn-sm" onClick={() => preview(false)}>Preview proposal</button>
        <button className="btn-sm" onClick={() => preview(true)} title="Opens the proposal and the print dialog — choose Save as PDF">Save PDF</button>
        <button className="btn-sm primary" onClick={() => save()} disabled={busy || !dirty}>{busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
      </div>
      {dirty && <div className="sm" style={{ padding: '0 18px 6px', color: 'var(--muted)' }}>Unsaved changes — the proposal prints from what’s on screen, but save before you send it.</div>}

      {/* headline */}
      <div className="kpis">
        <div><small>Client pays{oneTime ? ' · project' : ' / month'}{hasIntro ? ` · ${cur.label}` : ''}</small><b>{money(m.allIn + m.setupTotal, 0)}</b><span>{money(m.services, 0)} services{m.postage ? ` + ${money(m.postage, 0)} postage` : ''}{m.setupTotal ? ` + ${money(m.setupTotal, 0)} one-time` : ''}</span></div>
        <div><small>Per {unitWord}, all-in</small><b>{money(m.perOrder)}</b><span>{money(m.servicesPerOrder)} ex-postage{vasTotal ? ` · ${money(vasTotal / (vol || 1))} of it services` : ''}</span></div>
        <div><small>ShipBay contribution{oneTime ? '' : ' / month'}</small><b className={m.contribution < 0 ? 'neg' : 'pos'}>{money(m.contribution, 0)}</b><span>{pct(m.margin)} of services{m.postageMargin ? ` · postage ${money(m.postageMargin, 0)}` : ''}</span></div>
        <div><small>Labor</small><b>{m.laborHours} hrs{oneTime ? '' : '/mo'}</b><span>{money(m.laborPerOrder)}/{unitWord} · {money(m.cost.labor, 0)} at {money(d.costs.labor_rate)}/hr</span></div>
        {m.batch && <div className="batch"><small>{model === 'launch' ? 'Launch' : 'Drop'} · {m.batch.orders.toLocaleString()} {M.unit} in {m.batch.days} day{m.batch.days === 1 ? '' : 's'}{m.batch.drops > 1 ? ` × ${m.batch.drops} drops` : ''}</small><b>{m.batch.headcount} packers</b><span>{m.batch.ordersPerDay.toLocaleString()}/day · {m.batch.perDay} labor hrs/day · {m.batch.hours} hrs per drop{m.batch.trickle ? ` · ${m.batch.trickle.toLocaleString()} off-cycle` : ''}</span></div>}
        {d.inputs.current_cost ? <div><small>vs. their cost today</small><b className={m.vsCurrent >= 0 ? 'pos' : 'neg'}>{m.vsCurrent >= 0 ? 'saves ' : 'costs +'}{money(Math.abs(m.vsCurrent), 0)}</b><span>today {money(d.inputs.current_cost, 0)}{oneTime ? '' : '/mo'}</span></div> : null}
      </div>
      <div className="qtabs">
        {hasIntro && <div className="seg">{phs.map((p) => <button key={p.key} className={ph === p.key ? 'on' : ''} onClick={() => setPhase(p.key)}>{p.label}{p.key === 'waived' ? ' · waivers' : p.key === 'intro' ? ' · founding rates' : ' · standard'}</button>)}</div>}
        <div className="spacer" />
        <div className="tabs">{[['pricing', 'Pricing & profit'], ['services', `Value-added services${svc.filter((s) => s.on).length ? ` · ${svc.filter((s) => s.on).length}` : ''}`], ['proposal', 'Proposal']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      </div>

      {tab === 'pricing' && <>
        <div className="qgrid">
          {/* prospect profile */}
          <section>
            <div className="lbl">Prospect profile <span className="pill tiny">{M.short}</span></div>
            <Num label={M.volume} value={d.inputs.orders} onChange={(v) => setI('orders', v)} help={M.desc} />
            {parcel && <Num label={model === 'subscription' ? 'Items per box' : 'Units per order'} value={d.inputs.units_per_order} onChange={(v) => setI('units_per_order', v)} step={0.01} />}
            {model === 'subscription' && <div className="qrow"><Num label="Drops / month" value={d.inputs.drops_per_month ?? 1} onChange={(v) => setI('drops_per_month', v)} small /><Num label="Ship window (days)" value={d.inputs.batch_days ?? 0} onChange={(v) => setI('batch_days', v)} small /><Num label="Share in drops" value={d.inputs.batch_share ?? 1} onChange={(v) => setI('batch_share', v)} step={0.05} min={0} small help="rest ships off-cycle" /></div>}
            {model === 'launch' && <div className="qrow"><Num label="Ship window (days)" value={d.inputs.batch_days ?? 5} onChange={(v) => setI('batch_days', v)} small /><Num label="Months stored" value={d.inputs.storage_months ?? 1} onChange={(v) => setI('storage_months', v)} small help="from receipt to last ship" /></div>}
            {model === 'dtc' && <div className="qrow"><Num label="Optional drop share" value={d.inputs.batch_share ?? 0} onChange={(v) => setI('batch_share', v)} step={0.05} min={0} small help="share of the month that ships in one window" /><Num label="Window (days)" value={d.inputs.batch_days ?? 0} onChange={(v) => setI('batch_days', v)} small /></div>}
            {model === 'hybrid' && <div className="qrow"><Num label="Wholesale orders / mo" value={d.inputs.b2b_orders} onChange={(v) => setI('b2b_orders', v)} small /><Num label="Units per wholesale order" value={d.inputs.b2b_units_per_order ?? 24} onChange={(v) => setI('b2b_units_per_order', v)} small /><Num label="Pallets built / mo" value={d.inputs.pallets_out ?? 0} onChange={(v) => setI('pallets_out', v)} small /></div>}
            {model === 'b2b' && <div className="qrow"><Num label="Units per order" value={d.inputs.b2b_units_per_order ?? 24} onChange={(v) => setI('b2b_units_per_order', v)} small /><Num label="Pallets built / mo" value={d.inputs.pallets_out ?? 0} onChange={(v) => setI('pallets_out', v)} small /></div>}
            {model === 'fba' && <div className="qrow"><Num label="Cartons out / mo" value={d.inputs.cartons_out ?? 0} onChange={(v) => setI('cartons_out', v)} small /><Num label="Pallets built / mo" value={d.inputs.pallets_out ?? 0} onChange={(v) => setI('pallets_out', v)} small /></div>}
            {model === 'project' && <div className="qrow"><Num label="Kits to assemble" value={d.inputs.kits ?? 0} onChange={(v) => setI('kits', v)} small /><Num label="Materials at cost" value={d.inputs.materials ?? 0} onChange={(v) => setI('materials', v)} prefix="$" small /></div>}
            <div className="qrow">{model !== 'storage' && <Num label="Pallets stored" value={d.inputs.pallets} onChange={(v) => setI('pallets', v)} small />}<Num label="Shelves" value={d.inputs.shelves} onChange={(v) => setI('shelves', v)} small /><Num label="Bins" value={d.inputs.bins} onChange={(v) => setI('bins', v)} small />{model === 'storage' && <Num label="Pallet moves / mo" value={d.inputs.pallet_moves ?? 0} onChange={(v) => setI('pallet_moves', v)} small help="in + out" />}</div>
            <div className="qrow"><Num label={oneTime ? 'Inbound pallets' : 'Inbound pallets / mo'} value={d.inputs.inbound_pallets} onChange={(v) => setI('inbound_pallets', v)} small /><Num label={oneTime ? 'Loose cartons' : 'Loose cartons / mo'} value={d.inputs.inbound_cartons} onChange={(v) => setI('inbound_cartons', v)} small />{parcel && <Num label={oneTime ? 'Returns expected' : 'Returns / mo'} value={d.inputs.returns} onChange={(v) => setI('returns', v)} small />}</div>
            {parcel && <Num label="International share" value={d.inputs.intl_share} onChange={(v) => setI('intl_share', v)} step={0.01} min={0} suffix={`× ${M.unit}`} />}
            {parcel && <label className="qf"><span>Packaging</span><select value={d.inputs.packaging} onChange={(e) => setI('packaging', e.target.value)}>{PACKAGING.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
            {parcel && d.inputs.packaging !== 'client' && <Num label="Share that needs a box (rest = mailer)" value={d.inputs.box_share} onChange={(v) => setI('box_share', v)} step={0.05} min={0} />}
            {parcel && <Num label="Avg postage they pay today" value={d.inputs.avg_postage} onChange={(v) => setI('avg_postage', v)} step={0.01} prefix="$" help="Postage is billed at cost; the quote shows it so the all-in number is honest." />}
            <Num label={oneTime ? 'Their quote elsewhere' : 'Their all-in cost today / mo'} value={d.inputs.current_cost ?? ''} onChange={(v) => setI('current_cost', v === '' ? null : v)} prefix="$" help="Optional — in-house or current 3PL, incl. postage." />
          </section>

          {/* our price */}
          <section>
            <div className="lbl">Our price</div>
            {parcel && <>
              <div className="qrow"><Num label={model === 'subscription' ? 'Pick & pack, per box' : 'Pick & pack, first unit'} value={d.rates.pick_first} onChange={(v) => setR('pick_first', v)} step={0.05} prefix="$" small /><Num label={model === 'subscription' ? 'Additional item' : 'Additional unit'} value={d.rates.pick_addl} onChange={(v) => setR('pick_addl', v)} step={0.05} prefix="$" small />{model === 'subscription' && <Num label="Assembly / box" value={d.rates.assembly ?? 0} onChange={(v) => setR('assembly', v)} step={0.05} prefix="$" small help="0 = none" />}</div>
              {!oneTime && <div className="introbox">
                <div className="qrow"><Num label="Founding months" value={d.rates.intro?.months ?? 0} onChange={(v) => setIntro('months', v)} small /><Num label="Founding first unit" value={d.rates.intro?.pick_first ?? ''} onChange={(v) => setIntro('pick_first', v)} step={0.05} prefix="$" small /><Num label="Founding addl" value={d.rates.intro?.pick_addl ?? ''} onChange={(v) => setIntro('pick_addl', v)} step={0.05} prefix="$" small /></div>
                <small>Founding-period rates apply for the first N months, then the standard lines above.</small>
              </div>}
              <div className="qrow"><Num label="Poly mailer" value={d.rates.mailer} onChange={(v) => setR('mailer', v)} step={0.05} prefix="$" small help="0 = included" /><Num label="Box single" value={d.rates.box_single} onChange={(v) => setR('box_single', v)} step={0.05} prefix="$" small /><Num label="Box double" value={d.rates.box_double} onChange={(v) => setR('box_double', v)} step={0.05} prefix="$" small /></div>
            </>}
            {(model === 'b2b' || model === 'hybrid') && <div className="qrow"><Num label="Wholesale order" value={d.rates.b2b_order ?? 5.5} onChange={(v) => setR('b2b_order', v)} step={0.25} prefix="$" small /><Num label="Per unit" value={d.rates.b2b_unit ?? 0.4} onChange={(v) => setR('b2b_unit', v)} step={0.05} prefix="$" small /><Num label="Pallet build" value={d.rates.pallet_build ?? 18} onChange={(v) => setR('pallet_build', v)} prefix="$" small /></div>}
            {model === 'fba' && <div className="qrow"><Num label="Prep / unit" value={d.rates.fba_prep ?? 0.6} onChange={(v) => setR('fba_prep', v)} step={0.05} prefix="$" small /><Num label="Carton pack" value={d.rates.fba_carton ?? 2.5} onChange={(v) => setR('fba_carton', v)} step={0.25} prefix="$" small /><Num label="Pallet build" value={d.rates.pallet_build ?? 18} onChange={(v) => setR('pallet_build', v)} prefix="$" small /></div>}
            {model === 'project' && <div className="qrow"><Num label="Labor / hr" value={d.rates.project_hr ?? 40} onChange={(v) => setR('project_hr', v)} prefix="$" small /><Num label="Per kit" value={d.rates.kit_rate ?? 0} onChange={(v) => setR('kit_rate', v)} step={0.05} prefix="$" small help="0 = hourly only" /></div>}
            <div className="qrow"><Num label={oneTime ? 'Pallet / mo stored' : 'Pallet / mo'} value={d.rates.storage_pallet} onChange={(v) => setR('storage_pallet', v)} prefix="$" small /><Num label="Shelf / mo" value={d.rates.storage_shelf} onChange={(v) => setR('storage_shelf', v)} prefix="$" small /><Num label="Bin / mo" value={d.rates.storage_bin} onChange={(v) => setR('storage_bin', v)} step={0.25} prefix="$" small />{!oneTime && <Num label="Waived mo" value={d.rates.storage_waived_months ?? 0} onChange={(v) => setR('storage_waived_months', v)} small />}</div>
            {model === 'storage' && <Num label="Pallet in / out move" value={d.rates.pallet_move ?? 12} onChange={(v) => setR('pallet_move', v)} prefix="$" small />}
            <div className="qrow"><Num label="Receiving / pallet" value={d.rates.receiving_pallet} onChange={(v) => setR('receiving_pallet', v)} prefix="$" small /><Num label="/ carton" value={d.rates.receiving_carton} onChange={(v) => setR('receiving_carton', v)} prefix="$" small />{!oneTime && <Num label="Waived mo" value={d.rates.receiving_waived_months ?? 0} onChange={(v) => setR('receiving_waived_months', v)} small />}</div>
            {parcel && <div className="qrow"><Num label="Return" value={d.rates.returns} onChange={(v) => setR('returns', v)} step={0.25} prefix="$" small /><Num label="+ addl item" value={d.rates.returns_addl ?? 0.5} onChange={(v) => setR('returns_addl', v)} step={0.25} prefix="$" small /><Num label="Intl surcharge" value={d.rates.intl} onChange={(v) => setR('intl', v)} step={0.25} prefix="$" small /></div>}
            {!oneTime && <div className="qrow"><Num label="Monthly minimum" value={d.rates.minimum} onChange={(v) => setR('minimum', v)} prefix="$" small help="0 = none" /><Num label="Waived mo" value={d.rates.minimum_waived_months ?? 0} onChange={(v) => setR('minimum_waived_months', v)} small /><Num label="Setup fee" value={d.rates.setup ?? 0} onChange={(v) => setR('setup', v)} prefix="$" small help="one-time · 0 = none" /></div>}
            {parcel && <div className="qrow"><Num label="Postage markup" value={d.rates.postage_markup_pct ?? 0} onChange={(v) => setR('postage_markup_pct', v)} suffix="%" small help="0 = at cost" /><Num label="Postage guarantee avg" value={d.rates.postage_guarantee_avg ?? ''} onChange={(v) => setR('postage_guarantee_avg', v === '' ? null : v)} step={0.01} prefix="$" small help="blank = none" /></div>}
          </section>

          {/* our cost */}
          <section>
            <div className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>ShipBay cost model <button className="btn-xs" onClick={() => setShowCosts(!showCosts)}>{showCosts ? 'hide' : 'show'}</button></div>
            {showCosts && <>
              <Num label="Burdened labor rate" value={d.costs.labor_rate} onChange={(v) => setC('labor_rate', v)} step={0.1} prefix="$" suffix="/hr" help="$20 wage + ~12% payroll burden." />
              {parcel && <div className="qrow"><Num label={model === 'subscription' ? 'Min / box' : 'Min / order'} value={d.costs.min_per_order} onChange={(v) => setC('min_per_order', v)} step={0.1} small help="pick, pack, label" /><Num label="Min / addl unit" value={d.costs.min_per_addl_unit} onChange={(v) => setC('min_per_addl_unit', v)} step={0.1} small />{model === 'subscription' && <Num label="Min assembly / box" value={d.costs.min_assembly_per_box} onChange={(v) => setC('min_assembly_per_box', v)} step={0.1} small />}</div>}
              {(model === 'b2b' || model === 'hybrid') && <div className="qrow"><Num label="Min / wholesale order" value={d.costs.min_per_b2b_order} onChange={(v) => setC('min_per_b2b_order', v)} small /><Num label="Min / unit" value={d.costs.min_per_b2b_unit} onChange={(v) => setC('min_per_b2b_unit', v)} step={0.05} small /><Num label="Min / pallet build" value={d.costs.min_per_pallet_build} onChange={(v) => setC('min_per_pallet_build', v)} small /></div>}
              {model === 'fba' && <div className="qrow"><Num label="Min / unit prep" value={d.costs.min_per_fba_unit} onChange={(v) => setC('min_per_fba_unit', v)} step={0.1} small /><Num label="Min / carton" value={d.costs.min_per_carton_out} onChange={(v) => setC('min_per_carton_out', v)} small /><Num label="Prep material / unit" value={d.costs.fba_material} onChange={(v) => setC('fba_material', v)} step={0.01} prefix="$" small /></div>}
              {model === 'storage' && <Num label="Min / pallet move" value={d.costs.min_per_pallet_move} onChange={(v) => setC('min_per_pallet_move', v)} small />}
              {model === 'project' && <Num label="Min / kit" value={d.costs.min_per_kit} onChange={(v) => setC('min_per_kit', v)} step={0.1} small />}
              <div className="qrow"><Num label="Min / pallet in" value={d.costs.min_per_pallet_in} onChange={(v) => setC('min_per_pallet_in', v)} small /><Num label="Min / carton in" value={d.costs.min_per_carton_in} onChange={(v) => setC('min_per_carton_in', v)} small />{parcel && <Num label="Min / return" value={d.costs.min_per_return} onChange={(v) => setC('min_per_return', v)} small />}</div>
              {parcel && <div className="qrow"><Num label="Mailer cost" value={d.costs.pack_cost_mailer} onChange={(v) => setC('pack_cost_mailer', v)} step={0.01} prefix="$" small /><Num label="Box cost" value={d.costs.pack_cost_box_single} onChange={(v) => setC('pack_cost_box_single', v)} step={0.01} prefix="$" small /><Num label="Tape/dunnage / order" value={d.costs.dunnage_per_order} onChange={(v) => setC('dunnage_per_order', v)} step={0.01} prefix="$" small /></div>}
              <div className="qrow"><Num label="Space / pallet" value={d.costs.space_cost_pallet} onChange={(v) => setC('space_cost_pallet', v)} prefix="$" small help="rent ÷ positions" /><Num label="/ shelf" value={d.costs.space_cost_shelf} onChange={(v) => setC('space_cost_shelf', v)} prefix="$" small /><Num label="/ bin" value={d.costs.space_cost_bin} onChange={(v) => setC('space_cost_bin', v)} step={0.25} prefix="$" small /></div>
              <div className="qrow"><Num label={oneTime ? 'Account overhead' : 'Account overhead / mo'} value={d.costs.overhead_per_month} onChange={(v) => setC('overhead_per_month', v)} prefix="$" small help="software, support time" />{parcel && <Num label="Postage we pay (avg)" value={d.costs.postage_cost_avg} onChange={(v) => setC('postage_cost_avg', v)} step={0.01} prefix="$" small help="vs. guarantee → margin or exposure" />}</div>
              <div className="costsum">
                <div><span>Labor</span><b>{money(m.cost.labor, 0)}</b></div><div><span>Materials</span><b>{money(m.cost.packaging, 0)}</b></div><div><span>Space</span><b>{money(m.cost.space, 0)}</b></div><div><span>Overhead</span><b>{money(m.cost.overhead, 0)}</b></div>
                <div className="tot"><span>Cost to serve</span><b>{money(m.cost.total, 0)}</b></div><div className="tot"><span>Per {unitWord}</span><b>{money(m.costPerOrder)}</b></div>
              </div>
            </>}
          </section>
        </div>

        {/* bill + scenarios */}
        <div className="qtables">
          <div>
            <div className="lbl">{oneTime ? 'The project' : 'The client’s month'} at {vol.toLocaleString()} {M.unit}{hasIntro ? ` — ${cur.label}` : ''}</div>
            <div className="tablewrap"><table className="ordertable bill">
              <thead><tr><th>Line</th><th className="n">Qty</th><th className="n">Rate</th><th className="n">Amount</th></tr></thead>
              <tbody>
                {m.lines.filter((l) => l.key !== 'minimum').map((l) => <tr key={l.key} className={l.amount === 0 ? 'zero' : ''}><td>{l.label}</td><td className="n">{l.qty ? Number(l.qty).toLocaleString() : '—'}</td><td className="n">{l.qty ? money(l.rate) : '—'}</td><td className="n">{money(l.amount)}</td></tr>)}
                {m.vasLines.map((l) => <tr key={l.key} className={`vas ${l.amount === 0 ? 'zero' : ''}`}><td>{l.label}<div className="sm">value-added · {l.unit}</div></td><td className="n">{l.qty ? Number(l.qty).toLocaleString() : '—'}</td><td className="n">{l.qty ? money(l.rate) : '—'}</td><td className="n">{money(l.amount)}</td></tr>)}
                {m.lines.filter((l) => l.key === 'minimum').map((l) => <tr key={l.key} className={l.amount === 0 ? 'zero' : ''}><td>{l.label}</td><td className="n">—</td><td className="n">—</td><td className="n">{money(l.amount)}</td></tr>)}
                <tr className="sub"><td colSpan={3}>Services</td><td className="n">{money(m.services)}</td></tr>
                {parcel && <tr><td colSpan={3}>Postage at cost — {vol.toLocaleString()} × {money(d.rates.postage_guarantee_avg || d.inputs.avg_postage)}{Number(d.rates.postage_markup_pct) ? ` + ${d.rates.postage_markup_pct}%` : ''}</td><td className="n">{money(m.postage)}</td></tr>}
                {m.setup.map((l) => <tr key={l.key}><td colSpan={3}>{l.label} <span className="sm">one-time{l.qty > 1 ? ` · ${l.qty} × ${money(l.rate)}` : ''}</span></td><td className="n">{l.amount ? money(l.amount) : 'included'}</td></tr>)}
                <tr className="tot"><td colSpan={3}>All-in · {money(m.perOrder)} / {unitWord}</td><td className="n">{money(m.allIn + m.setupTotal)}</td></tr>
              </tbody>
            </table></div>
          </div>
          <div>
            <div className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>Profit at volume <span className="sm" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{M.unit}:</span>{d.scenarios.map((v, i) => <input key={i} className="inline sm num" type="number" value={v} onChange={(e) => setD({ ...d, scenarios: d.scenarios.map((x, j) => (j === i ? Number(e.target.value) : x)) })} />)}</div>
            <div className="tablewrap"><table className="ordertable profit">
              <thead><tr><th>{M.unit[0].toUpperCase() + M.unit.slice(1)}</th>{hasIntro && <th>Phase</th>}<th className="n">Client all-in</th><th className="n">$ / {unitWord}</th><th className="n">Hrs</th><th className="n">Our cost</th><th className="n">Contribution</th><th className="n">Margin</th></tr></thead>
              <tbody>{sc.flatMap((s) => s.rows.map((x) => (
                <tr key={`${s.orders}-${x.phase}`}><td><b>{s.orders.toLocaleString()}</b></td>{hasIntro && <td style={{ whiteSpace: 'nowrap' }}>{x.label}</td>}<td className="n">{money(x.allIn, 0)}<div className="sm">{money(x.services, 0)} svc</div></td><td className="n">{money(x.perOrder)}</td><td className="n">{x.laborHours}</td><td className="n">{money(x.cost.total, 0)}</td><td className={`n ${x.contribution < 0 ? 'neg' : 'pos'}`}><b>{money(x.contribution, 0)}</b></td><td className={`n ${x.contribution < 0 ? 'neg' : ''}`}>{pct(x.margin)}</td></tr>
              )))}</tbody>
            </table></div>
            <p className="sm" style={{ marginTop: 8 }}>Contribution = services billed − labor − materials − space − account overhead (+ any postage margin). Value-added services carry their own labor minutes and material cost, so switching one on moves both sides.</p>
          </div>
        </div>
        <div style={{ padding: '0 18px' }}>
          <div className="lbl">Internal notes</div>
          <textarea className="notes" rows={3} value={d.notes || ''} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="What they said on the call, what to watch, why these numbers. Never printed." />
        </div>
      </>}

      {tab === 'services' && <div className="vaswrap">
        <div className="vashead">
          <div><div className="lbl">Value-added services</div><p className="sm">Tick what this brand needs. Each line bills at its rate only when it happens; the quantity follows the quote’s volume (× the share where only some orders qualify) or is one you type. Our labor minutes and material cost ride along so contribution stays honest.</p></div>
          <div className="vastot"><small>Added services / {oneTime ? 'project' : 'month'}</small><b>{money(vasTotal, 0)}</b><span>{m.setupTotal ? `+ ${money(m.setupTotal, 0)} one-time · ` : ''}{svc.filter((s) => s.on).length} on</span></div>
        </div>
        {VAS_GROUPS.map(([gk, gl]) => (
          <div className="vasgroup" key={gk}>
            <div className="lbl">{gl}</div>
            {svc.filter((s) => s.group === gk).map((s) => {
              const line = m.vasLines.find((l) => l.key === `vas_${s.key}`) || m.setup.find((l) => l.key === `vas_${s.key}`);
              const unitCost = (s.min / 60) * Number(d.costs.labor_rate || 0) + s.mat;
              const manual = s.basis === 'each' || s.basis === 'once';
              const shareable = ['order', 'unit', 'return', 'b2b_order'].includes(s.basis);
              return (
                <div className={`vasrow ${s.on ? 'on' : ''}`} key={s.key}>
                  <label className="vaschk"><input type="checkbox" checked={s.on} onChange={(e) => setS(s.key, { on: e.target.checked })} /><div><b>{s.label}</b><div className="d">{s.desc}</div></div></label>
                  <div className="vasnum"><small>Rate · {s.unit}</small><div className="qin"><i>$</i><input type="number" step={0.05} value={s.price} onChange={(e) => setS(s.key, { price: e.target.value === '' ? '' : Number(e.target.value) })} /></div><em className={s.price > 0 && s.price < unitCost ? 'neg' : ''}>our cost {money(unitCost)}</em></div>
                  {manual ? <div className="vasnum"><small>{s.basis === 'once' ? 'Quantity' : `Per ${oneTime ? 'project' : 'month'}`}</small><div className="qin"><input type="number" min={0} value={s.qty} onChange={(e) => setS(s.key, { qty: e.target.value === '' ? '' : Number(e.target.value) })} /></div></div>
                    : shareable ? <div className="vasnum"><small>Share of {s.basis === 'b2b_order' ? 'wholesale orders' : s.basis + 's'}</small><div className="qin"><input type="number" min={0} max={1} step={0.05} value={s.share} onChange={(e) => setS(s.key, { share: e.target.value === '' ? '' : Number(e.target.value) })} /><i>×</i></div></div>
                    : <div className="vasnum"><small>Basis</small><div className="qin static">{s.basis === 'month' ? 'flat monthly' : 'per pallet stored'}</div></div>}
                  <div className="vasamt"><small>{s.basis === 'once' ? 'One-time' : oneTime ? 'This project' : 'This month'}</small><b>{s.on ? (line?.amount ? money(line.amount, 0) : line && line.qty ? 'included' : '—') : '—'}</b>{s.on && line?.qty ? <span>{Number(line.qty).toLocaleString()} × {money(s.price)}</span> : null}</div>
                  <input className="vasnote" placeholder="Note for the proposal (optional — replaces the description)" value={s.note} onChange={(e) => setS(s.key, { note: e.target.value })} />
                </div>
              );
            })}
          </div>
        ))}
        <div className="vasgroup">
          <div className="lbl">Included with every account <span className="sm" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— ticked items print under “What’s included”</span></div>
          <div className="inclist">{INCLUDED.map((x) => { const on = (d.proposal.included || []).includes(x.key); return <label key={x.key} className={on ? 'on' : ''}><input type="checkbox" checked={on} onChange={(e) => setP('included', e.target.checked ? [...(d.proposal.included || []), x.key] : (d.proposal.included || []).filter((k) => k !== x.key))} /><div><b>{x.label}</b><div className="d">{x.desc}</div></div></label>; })}</div>
        </div>
      </div>}

      {tab === 'proposal' && <div className="propwrap">
        <section>
          <div className="lbl">The letter</div>
          <Txt label="Document title" value={d.proposal.title} onChange={(v) => setP('title', v)} />
          <Txt label="Opening" rows={7} value={d.proposal.intro} onChange={(v) => setP('intro', v)} help="Placeholders: {company} {first} {contact} {volume} {model}. Blank line = new paragraph. Keep it to two short paragraphs so the first page holds." />
          <div className="lbl">Three things that matter to them</div>
          {[0, 1, 2].map((i) => <Txt key={i} label={`Point ${i + 1}`} value={(d.proposal.highlights || [])[i] || ''} placeholder={['e.g. Every drop staffed and shipped inside four days — we put the headcount in writing.', 'e.g. Your mailers and inserts stored and used at no charge.', 'e.g. One invoice, every line itemized, exportable to CSV.'][i]} onChange={(v) => { const h = [...(d.proposal.highlights || ['', '', ''])]; h[i] = v; setP('highlights', h); }} />)}
          <div className="lbl">Prepared by</div>
          <div className="qrow"><Txt label="Name" value={d.proposal.prepared_by} onChange={(v) => setP('prepared_by', v)} /><Txt label="Title" value={d.proposal.prepared_title} onChange={(v) => setP('prepared_title', v)} /></div>
          <div className="qrow"><Txt label="Email" value={d.proposal.prepared_email} onChange={(v) => setP('prepared_email', v)} /><Txt label="Phone" value={d.proposal.prepared_phone} onChange={(v) => setP('prepared_phone', v)} /></div>
        </section>
        <section>
          <div className="lbl">Terms</div>
          <Num label="Valid for (days)" value={d.proposal.valid_days} onChange={(v) => setP('valid_days', v)} small />
          <Txt label="Billing" rows={3} value={d.proposal.payment_terms} onChange={(v) => setP('payment_terms', v)} />
          <Txt label="Agreement" rows={3} value={d.proposal.term} onChange={(v) => setP('term', v)} />
          <div className="lbl">What the document shows</div>
          <div className="chanlist tight">
            {[['show_example', oneTime ? 'The project total, line by line' : 'A typical month, line by line', 'The worked example at their volume — the same layout as the invoice.'], ['show_postage', 'Postage estimate', 'Shows postage at cost next to services so the all-in number is on the page. Turn off if they ship on their own account.'], ['show_phases', 'Founding-period schedule', 'Months 1–N vs. standard, when the quote has one.'], ['show_batch', model === 'launch' ? 'Launch window plan' : 'Drop plan & staffing', 'Boxes per drop, days, packers assigned — in writing.'], ['signature', 'Acceptance block', 'Signature lines for both sides on the last page.']].map(([k, l, dsc]) => <label key={k} className={d.proposal[k] ? 'on' : ''}><input type="checkbox" checked={!!d.proposal[k]} onChange={(e) => setP(k, e.target.checked)} /><div><b>{l}</b><div className="d">{dsc}</div></div></label>)}
          </div>
          <div className="propactions">
            <button className="btn-sm" onClick={() => preview(false)}>Preview proposal</button>
            <button className="btn-sm primary" onClick={() => preview(true)}>Save as PDF</button>
            <p className="sm">Opens in a new tab as a four-page Letter document: letter and key numbers, your rates, services and what’s included, then the worked example and terms with signature lines. In the print dialog pick “Save as PDF” with margins set to None.</p>
          </div>
        </section>
      </div>}
    </div>
  );
}

/* ---------- Standard rate card ---------- */
function RateCard({ card, onSaved, onErr, me }) {
  const [draft, setD] = useState(null);           // null = untouched → mirrors the saved card
  const [busy, setBusy] = useState(false);
  useEffect(() => setD(null), [card]);
  const d = draft || card;
  if (!d) return <div className="card detail"><div className="empty">No standard rate card yet — run the latest migration.</div></div>;
  const set = (k, v) => setD({ ...d, [k]: v });
  const setTier = (i, k, v) => setD({ ...d, tiers: d.tiers.map((t, j) => (j === i ? { ...t, [k]: v } : t)) });
  const setEx = (k, v) => setD({ ...d, extras: { ...(d.extras || {}), [k]: v } });
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(card);
  const save = async () => {
    setBusy(true);
    const { id, created_at, updated_at, ...rest } = d;
    const { error } = await supabase.from('rate_cards').update({ ...rest, pick_pack_first: d.tiers?.[0]?.pick_first ?? d.pick_pack_first, pick_pack_addl: d.tiers?.[0]?.pick_addl ?? d.pick_pack_addl }).eq('id', id);
    setBusy(false); if (error) return onErr(error.message); onSaved();
  };
  const printCard = (print) => {
    const q = { generic: true, id: 'card', company: 'Growing brands', model: 'dtc', inputs: { ...DEFAULT_INPUTS, orders: 500 }, rates: ratesFromCard(d, 500), costs: DEFAULT_COSTS, services: {}, proposal: { ...DEFAULT_PROPOSAL, included: DEFAULT_INCLUDED } };
    if (!openProposal(q, { print })) onErr('Your browser blocked the new tab — allow pop-ups and try again.');
  };
  const ex = d.extras || {};
  const val = (key) => ({ pick_first: d.tiers?.[0]?.pick_first, pick_addl: d.tiers?.[0]?.pick_addl, storage_pallet: d.storage_pallet, storage_bin: d.storage_bin, receiving_pallet: d.receiving_pallet, returns: d.returns_fee, minimum: d.monthly_minimum, kitting_hr: ex.kitting_hr }[key]);
  // the cost floor for the lines we can see: labor minutes × burdened rate (+ packaging)
  const floor = { pick_first: (DEFAULT_COSTS.min_per_order / 60) * DEFAULT_COSTS.labor_rate + DEFAULT_COSTS.pack_cost_mailer + DEFAULT_COSTS.dunnage_per_order, pick_addl: (DEFAULT_COSTS.min_per_addl_unit / 60) * DEFAULT_COSTS.labor_rate, storage_pallet: DEFAULT_COSTS.space_cost_pallet, storage_bin: DEFAULT_COSTS.space_cost_bin, receiving_pallet: (DEFAULT_COSTS.min_per_pallet_in / 60) * DEFAULT_COSTS.labor_rate, returns: (DEFAULT_COSTS.min_per_return / 60) * DEFAULT_COSTS.labor_rate, minimum: 0, kitting_hr: DEFAULT_COSTS.labor_rate };

  return (
    <div className="card detail quote ratecard">
      <div className="cardhead">
        <div style={{ flex: 1 }}><h3>Standard rate card <span className="pill connected">current</span></h3><div className="small">Effective {d.effective_from} · what shipbay3pl.com/pricing, the emailed rate card and every new quote start from. Edit here, then update the site copy.</div></div>
        <button className="btn-sm" onClick={() => printCard(false)}>Preview rate card</button>
        <button className="btn-sm" onClick={() => printCard(true)} title="Printable rate card — the generic version you attach to a cold email">Save PDF</button>
        <button className="btn-sm primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : dirty ? 'Save rate card' : 'Saved'}</button>
      </div>
      <div className="qgrid">
        <section>
          <div className="lbl">Pick & pack tiers</div>
          {(d.tiers || []).map((t, i) => (
            <div className="qrow tier" key={i}>
              <label className="qf small"><span>Tier</span><input value={t.label} onChange={(e) => setTier(i, 'label', e.target.value)} /></label>
              <Num label="Up to orders/mo" value={t.max_orders ?? ''} onChange={(v) => setTier(i, 'max_orders', v === '' ? null : v)} small help={t.max_orders == null ? 'no cap' : ''} />
              <Num label="First unit" value={t.pick_first} onChange={(v) => setTier(i, 'pick_first', v)} step={0.05} prefix="$" small />
              <Num label="Addl unit" value={t.pick_addl} onChange={(v) => setTier(i, 'pick_addl', v)} step={0.05} prefix="$" small />
            </div>
          ))}
          <label className="chk" style={{ margin: '4px 0 14px' }}><input type="checkbox" checked={!!ex.mailer_included} onChange={(e) => setEx('mailer_included', e.target.checked)} /> standard poly mailer included in pick & pack</label>
          <div className="qrow"><Num label="Mailer (if billed)" value={d.packaging_mailer} onChange={(v) => set('packaging_mailer', v)} step={0.05} prefix="$" small /><Num label="Box single" value={d.packaging_box_single} onChange={(v) => set('packaging_box_single', v)} step={0.05} prefix="$" small /><Num label="Box double" value={d.packaging_box_double} onChange={(v) => set('packaging_box_double', v)} step={0.05} prefix="$" small /></div>
          <div className="lbl">Storage</div>
          <div className="qrow"><Num label="Pallet / mo" value={d.storage_pallet} onChange={(v) => set('storage_pallet', v)} prefix="$" small /><Num label="Shelf / mo" value={d.storage_shelf} onChange={(v) => set('storage_shelf', v)} prefix="$" small /><Num label="Bin / mo" value={d.storage_bin} onChange={(v) => set('storage_bin', v)} step={0.25} prefix="$" small /><Num label="Pallet move" value={ex.pallet_move ?? 12} onChange={(v) => setEx('pallet_move', v)} prefix="$" small help="storage-only accounts" /></div>
          <div className="lbl">Receiving</div>
          <div className="qrow"><Num label="Pallet" value={d.receiving_pallet} onChange={(v) => set('receiving_pallet', v)} prefix="$" small /><Num label="Loose carton" value={d.receiving_carton} onChange={(v) => set('receiving_carton', v)} prefix="$" small /></div>
          <div className="qrow"><Num label="20′ container" value={ex.container_20 ?? 350} onChange={(v) => setEx('container_20', v)} prefix="$" small /><Num label="40′ container" value={ex.container_40 ?? 500} onChange={(v) => setEx('container_40', v)} prefix="$" small /><Num label="Floor-loaded +" value={ex.floor_loaded ?? 150} onChange={(v) => setEx('floor_loaded', v)} prefix="$" small /></div>
        </section>
        <section>
          <div className="lbl">Everything else</div>
          <div className="qrow"><Num label="Return processed" value={d.returns_fee} onChange={(v) => set('returns_fee', v)} step={0.25} prefix="$" small /><Num label="+ addl item" value={ex.returns_addl ?? 0.5} onChange={(v) => setEx('returns_addl', v)} step={0.25} prefix="$" small /><Num label="Intl surcharge" value={d.intl_surcharge} onChange={(v) => set('intl_surcharge', v)} step={0.25} prefix="$" small /></div>
          <div className="qrow"><Num label="B2B order" value={ex.b2b_order ?? 5.5} onChange={(v) => setEx('b2b_order', v)} step={0.25} prefix="$" small /><Num label="B2B unit" value={ex.b2b_unit ?? 0.4} onChange={(v) => setEx('b2b_unit', v)} step={0.05} prefix="$" small /><Num label="Pallet build" value={ex.pallet_build ?? 18} onChange={(v) => setEx('pallet_build', v)} prefix="$" small /></div>
          <div className="qrow"><Num label="Box assembly" value={ex.assembly ?? 1.25} onChange={(v) => setEx('assembly', v)} step={0.05} prefix="$" suffix="/box" small help="subscription drops" /><Num label="FBA prep" value={ex.fba_prep ?? 0.6} onChange={(v) => setEx('fba_prep', v)} step={0.05} prefix="$" suffix="/unit" small /><Num label="FBA carton" value={ex.fba_carton ?? 2.5} onChange={(v) => setEx('fba_carton', v)} step={0.25} prefix="$" small /></div>
          <div className="qrow"><Num label="Kitting / projects" value={ex.kitting_hr ?? 40} onChange={(v) => setEx('kitting_hr', v)} prefix="$" suffix="/hr" small /><Num label="Per kit" value={ex.kit_rate ?? 1.5} onChange={(v) => setEx('kit_rate', v)} step={0.05} prefix="$" small /></div>
          <div className="qrow"><Num label="Monthly minimum" value={d.monthly_minimum} onChange={(v) => set('monthly_minimum', v)} prefix="$" small /><Num label="Waived months" value={d.minimum_waived_months ?? 2} onChange={(v) => set('minimum_waived_months', v)} small /><Num label="Setup" value={ex.setup ?? 0} onChange={(v) => setEx('setup', v)} prefix="$" small /><Num label="Postage markup" value={d.postage_markup_pct ?? 0} onChange={(v) => set('postage_markup_pct', v)} suffix="%" small help="0 = at cost" /></div>
          <div className="lbl">Notes</div>
          <textarea className="notes" rows={5} value={d.notes || ''} onChange={(e) => set('notes', e.target.value)} />
        </section>
      </div>
      <div className="benchwrap">
          <div className="lbl">Where we sit — 2026 published benchmarks</div>
          <table className="bench">
            <thead><tr><th>Line</th><th className="n">Ours</th><th>Industry typical</th><th>The majors</th><th className="n">Our floor</th></tr></thead>
            <tbody>{BENCHMARKS.map((b) => { const v = Number(val(b.key)); const f = floor[b.key]; const isSpace = b.key.startsWith('storage'); const under = f != null && v > 0 && v < (isSpace ? f * 0.9 : f); const near = isSpace && !under && v < f; return (
              <tr key={b.key} className={under ? 'warnrow' : ''}><td>{b.label}<div className="sm">{b.unit}</div></td><td className="n"><b>{money(v)}</b></td><td>{b.typical}</td><td>{b.majors}</td><td className="n">{b.key === 'minimum' ? '—' : money(f)}<div className={`sm ${under ? 'neg' : ''}`}>{under ? 'below cost' : near ? 'rent share — storage pays the rent, pick & pack carries margin' : isSpace ? 'rent share' : 'labor at ' + money(DEFAULT_COSTS.labor_rate) + '/hr'}</div></td></tr>
            ); })}</tbody>
          </table>
          <p className="sm" style={{ marginTop: 8 }}>“Our floor” = labor minutes × {money(DEFAULT_COSTS.labor_rate)}/hr burdened (+ mailer and dunnage on the first unit). Storage floor = rent ÷ ~62 pallet positions, a fixed cost we pay either way. Anything priced under its floor is a loss leader on purpose, not an accident.</p>
          <p className="sm">Sources: {BENCHMARK_SOURCES.map(([t, u], i) => <span key={u}>{i ? ' · ' : ''}<a href={u} target="_blank" rel="noreferrer">{t}</a></span>)}</p>
      </div>
    </div>
  );
}
