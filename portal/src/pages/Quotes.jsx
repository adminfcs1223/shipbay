// Quotes — every prospect quote with the client's bill, ShipBay's labor & cost model and the contribution at three
// volumes, plus the finalized standard rate card and how it sits against published industry benchmarks.
// Math lives in ../quote.js; a quote row is just the saved inputs/rates/costs.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
import { compute, scenarios, phases, ratesFromCard, money, pct, BENCHMARKS, BENCHMARK_SOURCES, DEFAULT_INPUTS, DEFAULT_COSTS } from '../quote';

const STATUS = { draft: ['Draft', 'muted'], sent: ['Sent', 'navy'], accepted: ['Accepted', 'ok'], declined: ['Declined', 'bad'], superseded: ['Superseded', 'muted'] };
const PACKAGING = [['client', 'Client-supplied'], ['shipbay', 'ShipBay supplies']];

export default function Quotes({ me }) {
  const [quotes, setQuotes] = useState(null);
  const [card, setCard] = useState(null);
  const [sel, setSel] = useState('card');
  const [msg, setMsg] = useState(null);

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
  const newQuote = async () => {
    const company = window.prompt('Company name for the new quote');
    if (!company?.trim()) return;
    const rates = card ? ratesFromCard(card, DEFAULT_INPUTS.orders) : {};
    const { data, error } = await supabase.from('quotes').insert({ company: company.trim(), label: 'Quote', inputs: DEFAULT_INPUTS, rates, costs: DEFAULT_COSTS, scenarios: [DEFAULT_INPUTS.orders, DEFAULT_INPUTS.orders * 2, DEFAULT_INPUTS.orders * 4], created_by: me?.id }).select().single();
    if (error) return flash('err', error.message);
    await load(); setSel(data.id);
  };

  const groups = useMemo(() => { const g = {}; for (const q of quotes || []) (g[q.company] ||= []).push(q); return g; }, [quotes]);
  const current = sel !== 'card' ? (quotes || []).find((q) => q.id === sel) : null;

  return (
    <>
      <div className="pagehead">
        <div><h1>Quotes<span className="dot">.</span></h1><p className="sub">What each prospect pays, what it costs us to serve them, and what’s left. Tune any number and the whole quote recalculates; save when it’s the one you want to send.</p></div>
        <div className="glance">
          <div><small>Quotes</small><b>{(quotes || []).filter((q) => !q.internal_only).length}</b></div>
          <div><small>Sent</small><b>{(quotes || []).filter((q) => q.status === 'sent').length}</b></div>
          <div><small>Accepted</small><b>{(quotes || []).filter((q) => q.status === 'accepted').length}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="ops quotes">
        <div className="card queue">
          <div className="cardhead"><h3>Prospects</h3><div className="spacer" /><button className="btn-xs primary" onClick={newQuote}>+ New quote</button></div>
          <ul className="queuelist">
            <li><button className={`qitem ${sel === 'card' ? 'active' : ''}`} onClick={() => setSel('card')}><div className="top"><b>Standard rate card</b><span className={`pill ${card ? 'connected' : 'pending'}`}>{card ? 'current' : 'missing'}</span></div><div className="meta">Published tiers · industry comparison</div></button></li>
            {quotes === null ? <li className="empty">Loading…</li> : Object.entries(groups).map(([company, list]) => list.map((q) => (
              <li key={q.id}><button className={`qitem ${sel === q.id ? 'active' : ''}`} onClick={() => setSel(q.id)}>
                <div className="top"><b>{company}</b><span className={`statuspill ${STATUS[q.status]?.[1]}`}>{STATUS[q.status]?.[0]}</span></div>
                <div className="meta">{q.label}{q.internal_only ? ' · internal' : ''} · {Number(q.inputs?.orders || 0).toLocaleString()} orders/mo{q.contact_name ? ` · ${q.contact_name}` : ''}</div>
              </button></li>
            )))}
          </ul>
        </div>

        {sel === 'card' ? <RateCard card={card} onSaved={() => { load(); flash('ok', 'Standard rate card saved.'); }} onErr={(t) => flash('err', t)} me={me} />
          : current ? <QuoteDetail key={current.id} q={current} card={card} onSaved={(t) => { load(); flash('ok', t || 'Quote saved.'); }} onErr={(t) => flash('err', t)} />
          : <div className="card detail"><div className="empty">Pick a quote on the left.</div></div>}
      </div>
    </>
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

/* ---------- Quote detail ---------- */
function QuoteDetail({ q, card, onSaved, onErr }) {
  const [d, setD] = useState(() => ({ ...q, inputs: { ...DEFAULT_INPUTS, ...(q.inputs || {}) }, rates: { intro: { months: 0 }, ...(q.rates || {}) }, costs: { ...DEFAULT_COSTS, ...(q.costs || {}) }, scenarios: q.scenarios?.length ? q.scenarios : [q.inputs?.orders || 500] }));
  const [phase, setPhase] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showCosts, setShowCosts] = useState(true);
  const setI = (k, v) => setD((x) => ({ ...x, inputs: { ...x.inputs, [k]: v } }));
  const setR = (k, v) => setD((x) => ({ ...x, rates: { ...x.rates, [k]: v } }));
  const setIntro = (k, v) => setD((x) => ({ ...x, rates: { ...x.rates, intro: { ...(x.rates.intro || {}), [k]: v } } }));
  const setC = (k, v) => setD((x) => ({ ...x, costs: { ...x.costs, [k]: v } }));
  const dirty = JSON.stringify({ a: d.inputs, b: d.rates, c: d.costs, s: d.scenarios, n: d.notes, l: d.label, st: d.status, i: d.internal_only, cn: d.contact_name, ce: d.contact_email }) !== JSON.stringify({ a: { ...DEFAULT_INPUTS, ...(q.inputs || {}) }, b: { intro: { months: 0 }, ...(q.rates || {}) }, c: { ...DEFAULT_COSTS, ...(q.costs || {}) }, s: q.scenarios?.length ? q.scenarios : [q.inputs?.orders || 500], n: q.notes, l: q.label, st: q.status, i: q.internal_only, cn: q.contact_name, ce: q.contact_email });

  const phs = useMemo(() => phases(d), [d]);
  const hasIntro = phs.length > 1;
  const cur = phs.find((p) => p.key === phase) || phs[0];
  const ph = cur.key;
  const m = useMemo(() => compute(d, Number(d.inputs.orders), ph), [d, ph]);
  const sc = useMemo(() => scenarios(d), [d]);

  const save = async (extra = {}) => {
    setBusy(true);
    const { error } = await supabase.from('quotes').update({ inputs: d.inputs, rates: d.rates, costs: d.costs, scenarios: d.scenarios.map(Number).filter(Boolean), notes: d.notes, label: d.label, status: d.status, internal_only: d.internal_only, contact_name: d.contact_name, contact_email: d.contact_email, contact_phone: d.contact_phone, ...extra }).eq('id', q.id);
    setBusy(false);
    if (error) return onErr(error.message);
    onSaved();
  };
  const useStandard = () => { if (!card) return onErr('No standard rate card yet.'); const r = ratesFromCard(card, Number(d.inputs.orders)); setD((x) => ({ ...x, rates: { ...r, intro: x.rates.intro || { months: 0 } } })); };
  const duplicate = async () => {
    const { error } = await supabase.from('quotes').insert({ org_id: q.org_id, company: q.company, contact_name: q.contact_name, contact_email: q.contact_email, contact_phone: q.contact_phone, label: `${d.label} (copy)`, status: 'draft', internal_only: d.internal_only, inputs: d.inputs, rates: d.rates, costs: d.costs, scenarios: d.scenarios, notes: d.notes });
    if (error) return onErr(error.message); onSaved('Copied — it’s in the list as a draft.');
  };
  const toRateCard = async () => {
    if (!q.org_id) return onErr('This prospect isn’t a client yet — convert them under Onboarding first, then push the rates.');
    if (!window.confirm(`Write these rates as ${q.company}’s rate card? Their current card is retired and billing uses the new one from today.`)) return;
    const r = d.rates; const intro = Number(r.intro?.months) > 0;
    const today = new Date(); const addM = (mo) => { const t = new Date(today); t.setMonth(t.getMonth() + mo); return t.toISOString().slice(0, 10); };
    await supabase.from('rate_cards').update({ status: 'retired', effective_to: today.toISOString().slice(0, 10) }).eq('org_id', q.org_id).eq('scope', 'org').eq('status', 'current');
    const base = { org_id: q.org_id, scope: 'org', status: 'current', storage_pallet: r.storage_pallet, storage_shelf: r.storage_shelf, storage_bin: r.storage_bin, receiving_pallet: r.receiving_pallet, receiving_carton: r.receiving_carton, returns_fee: r.returns, packaging_mailer: r.mailer, packaging_box_single: r.box_single, packaging_box_double: r.box_double, intl_surcharge: r.intl, monthly_minimum: r.minimum, postage_markup_pct: r.postage_markup_pct, postage_guarantee_avg: r.postage_guarantee_avg || null, extras: { returns_addl: r.returns_addl, b2b_order: r.b2b_order, b2b_unit: r.b2b_unit } };
    const rows = [];
    if (intro) rows.push({ ...base, label: `${d.label} — founding (${r.intro.months} mo)`, effective_from: today.toISOString().slice(0, 10), effective_to: addM(r.intro.months), pick_pack_first: r.intro.pick_first ?? r.pick_first, pick_pack_addl: r.intro.pick_addl ?? r.pick_addl, storage_waived_until: Number(r.storage_waived_months) ? addM(Number(r.storage_waived_months)) : null, minimum_waived_until: Number(r.minimum_waived_months) ? addM(Number(r.minimum_waived_months)) : null, storage_waived_months: r.storage_waived_months || 0, minimum_waived_months: r.minimum_waived_months || 0, notes: `From quote "${d.label}"` });
    rows.push({ ...base, label: intro ? `${d.label} — standard` : d.label, status: intro ? 'draft' : 'current', effective_from: intro ? addM(r.intro.months) : today.toISOString().slice(0, 10), pick_pack_first: r.pick_first, pick_pack_addl: r.pick_addl, storage_waived_months: 0, minimum_waived_months: 0, notes: `From quote "${d.label}"` });
    const { error } = await supabase.from('rate_cards').insert(rows);
    if (error) return onErr(error.message);
    await save({ status: 'accepted', decided_at: new Date().toISOString() });
  };

  const vol = Number(d.inputs.orders) || 0;
  return (
    <div className="card detail quote">
      <div className="cardhead">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h3>{q.company} <input className="inline" value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} /></h3>
          <div className="small"><input className="inline sm" placeholder="Contact" value={d.contact_name || ''} onChange={(e) => setD({ ...d, contact_name: e.target.value })} /> · <input className="inline sm" placeholder="email" value={d.contact_email || ''} onChange={(e) => setD({ ...d, contact_email: e.target.value })} />{q.org_id ? ' · client' : ' · prospect'}</div>
        </div>
        <select className={`statusselect ${STATUS[d.status]?.[1]}`} value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })}>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <label className="chk"><input type="checkbox" checked={!!d.internal_only} onChange={(e) => setD({ ...d, internal_only: e.target.checked })} /> internal only</label>
        <button className="btn-sm" onClick={useStandard} title="Replace the price lines with the standard rate card at this volume">Use standard rates</button>
        <button className="btn-sm" onClick={duplicate}>Duplicate</button>
        {q.org_id && !d.internal_only && <button className="btn-sm" onClick={toRateCard} disabled={busy}>Make it their rate card</button>}
        <button className="btn-sm primary" onClick={() => save()} disabled={busy || !dirty}>{busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
      </div>

      {/* headline */}
      <div className="kpis">
        <div><small>Client pays / month{hasIntro ? ` · ${cur.label}` : ''}</small><b>{money(m.allIn, 0)}</b><span>{money(m.services, 0)} services + {money(m.postage, 0)} postage</span></div>
        <div><small>Per order, all-in</small><b>{money(m.perOrder)}</b><span>{money(m.servicesPerOrder)} ex-postage</span></div>
        <div><small>ShipBay contribution / month</small><b className={m.contribution < 0 ? 'neg' : 'pos'}>{money(m.contribution, 0)}</b><span>{pct(m.margin)} of services{m.postageMargin ? ` · postage ${money(m.postageMargin, 0)}` : ''}</span></div>
        <div><small>Labor</small><b>{m.laborHours} hrs/mo</b><span>{money(m.laborPerOrder)}/order · {money(m.cost.labor, 0)} at {money(d.costs.labor_rate)}/hr</span></div>
        {m.batch && <div className="batch"><small>Batch drop · {m.batch.orders.toLocaleString()} orders in {m.batch.days} days</small><b>{m.batch.headcount} packers</b><span>{m.batch.ordersPerDay.toLocaleString()} orders/day · {m.batch.perDay} labor hrs/day · {m.batch.hours} hrs total</span></div>}
        {d.inputs.current_cost ? <div><small>vs. their cost today</small><b className={m.vsCurrent >= 0 ? 'pos' : 'neg'}>{m.vsCurrent >= 0 ? 'saves ' : 'costs +'}{money(Math.abs(m.vsCurrent), 0)}</b><span>in-house {money(d.inputs.current_cost, 0)}/mo{d.inputs.current_cost_cash ? ` · ${money(d.inputs.current_cost_cash, 0)} cash` : ''}</span></div> : null}
      </div>
      {hasIntro && <div className="seg" style={{ margin: '0 18px 10px' }}>{phs.map((p) => <button key={p.key} className={ph === p.key ? 'on' : ''} onClick={() => setPhase(p.key)}>{p.label}{p.key === 'waived' ? ' · waivers' : p.key === 'intro' ? ' · founding rates' : ' · standard'}</button>)}</div>}

      <div className="qgrid">
        {/* prospect profile */}
        <section>
          <div className="lbl">Prospect profile</div>
          <Num label="Orders / month" value={d.inputs.orders} onChange={(v) => setI('orders', v)} />
          <Num label="Units per order" value={d.inputs.units_per_order} onChange={(v) => setI('units_per_order', v)} step={0.01} />
          <Num label="B2B / wholesale orders / mo" value={d.inputs.b2b_orders} onChange={(v) => setI('b2b_orders', v)} />
          <div className="qrow"><Num label="Pallets stored" value={d.inputs.pallets} onChange={(v) => setI('pallets', v)} small /><Num label="Shelves" value={d.inputs.shelves} onChange={(v) => setI('shelves', v)} small /><Num label="Bins" value={d.inputs.bins} onChange={(v) => setI('bins', v)} small /></div>
          <div className="qrow"><Num label="Inbound pallets / mo" value={d.inputs.inbound_pallets} onChange={(v) => setI('inbound_pallets', v)} small /><Num label="Loose cartons / mo" value={d.inputs.inbound_cartons} onChange={(v) => setI('inbound_cartons', v)} small /><Num label="Returns / mo" value={d.inputs.returns} onChange={(v) => setI('returns', v)} small /></div>
          <Num label="International share" value={d.inputs.intl_share} onChange={(v) => setI('intl_share', v)} step={0.01} min={0} suffix="× orders" />
          <label className="qf"><span>Packaging</span><select value={d.inputs.packaging} onChange={(e) => setI('packaging', e.target.value)}>{PACKAGING.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {d.inputs.packaging !== 'client' && <Num label="Share that needs a box (rest = mailer)" value={d.inputs.box_share} onChange={(v) => setI('box_share', v)} step={0.05} min={0} />}
          <div className="qrow"><Num label="Batch drop share" value={d.inputs.batch_share ?? 0} onChange={(v) => setI('batch_share', v)} step={0.05} min={0} small help="share of the month that ships in one drop" /><Num label="Drop window (days)" value={d.inputs.batch_days ?? 0} onChange={(v) => setI('batch_days', v)} small /></div>
          <Num label="Avg postage they pay today" value={d.inputs.avg_postage} onChange={(v) => setI('avg_postage', v)} step={0.01} prefix="$" help="Postage is billed at cost; the quote shows it so the all-in number is honest." />
          <Num label="Their all-in cost today / mo" value={d.inputs.current_cost ?? ''} onChange={(v) => setI('current_cost', v === '' ? null : v)} prefix="$" help="Optional — in-house or current 3PL, incl. postage." />
        </section>

        {/* our price */}
        <section>
          <div className="lbl">Our price</div>
          <div className="qrow"><Num label="Pick & pack, first unit" value={d.rates.pick_first} onChange={(v) => setR('pick_first', v)} step={0.05} prefix="$" small /><Num label="Additional unit" value={d.rates.pick_addl} onChange={(v) => setR('pick_addl', v)} step={0.05} prefix="$" small /></div>
          <div className="introbox">
            <div className="qrow"><Num label="Founding months" value={d.rates.intro?.months ?? 0} onChange={(v) => setIntro('months', v)} small /><Num label="Founding first unit" value={d.rates.intro?.pick_first ?? ''} onChange={(v) => setIntro('pick_first', v)} step={0.05} prefix="$" small /><Num label="Founding addl" value={d.rates.intro?.pick_addl ?? ''} onChange={(v) => setIntro('pick_addl', v)} step={0.05} prefix="$" small /></div>
            <small>Founding-period rates apply for the first N months, then the standard lines above.</small>
          </div>
          <div className="qrow"><Num label="Poly mailer" value={d.rates.mailer} onChange={(v) => setR('mailer', v)} step={0.05} prefix="$" small help="0 = included" /><Num label="Box single" value={d.rates.box_single} onChange={(v) => setR('box_single', v)} step={0.05} prefix="$" small /><Num label="Box double" value={d.rates.box_double} onChange={(v) => setR('box_double', v)} step={0.05} prefix="$" small /></div>
          <div className="qrow"><Num label="Pallet / mo" value={d.rates.storage_pallet} onChange={(v) => setR('storage_pallet', v)} prefix="$" small /><Num label="Shelf / mo" value={d.rates.storage_shelf} onChange={(v) => setR('storage_shelf', v)} prefix="$" small /><Num label="Bin / mo" value={d.rates.storage_bin} onChange={(v) => setR('storage_bin', v)} step={0.25} prefix="$" small /><Num label="Waived mo" value={d.rates.storage_waived_months ?? 0} onChange={(v) => setR('storage_waived_months', v)} small /></div>
          <div className="qrow"><Num label="Receiving / pallet" value={d.rates.receiving_pallet} onChange={(v) => setR('receiving_pallet', v)} prefix="$" small /><Num label="/ carton" value={d.rates.receiving_carton} onChange={(v) => setR('receiving_carton', v)} prefix="$" small /><Num label="Waived mo" value={d.rates.receiving_waived_months ?? 0} onChange={(v) => setR('receiving_waived_months', v)} small /></div>
          <div className="qrow"><Num label="Return" value={d.rates.returns} onChange={(v) => setR('returns', v)} step={0.25} prefix="$" small /><Num label="+ addl item" value={d.rates.returns_addl ?? 0.5} onChange={(v) => setR('returns_addl', v)} step={0.25} prefix="$" small /><Num label="Intl surcharge" value={d.rates.intl} onChange={(v) => setR('intl', v)} step={0.25} prefix="$" small /></div>
          <div className="qrow"><Num label="B2B order" value={d.rates.b2b_order ?? 5.5} onChange={(v) => setR('b2b_order', v)} step={0.25} prefix="$" small /><Num label="B2B unit" value={d.rates.b2b_unit ?? 0.4} onChange={(v) => setR('b2b_unit', v)} step={0.05} prefix="$" small /></div>
          <div className="qrow"><Num label="Monthly minimum" value={d.rates.minimum} onChange={(v) => setR('minimum', v)} prefix="$" small /><Num label="Waived mo" value={d.rates.minimum_waived_months ?? 0} onChange={(v) => setR('minimum_waived_months', v)} small /></div>
          <div className="qrow"><Num label="Postage markup" value={d.rates.postage_markup_pct ?? 0} onChange={(v) => setR('postage_markup_pct', v)} suffix="%" small help="0 = at cost" /><Num label="Postage guarantee avg" value={d.rates.postage_guarantee_avg ?? ''} onChange={(v) => setR('postage_guarantee_avg', v === '' ? null : v)} step={0.01} prefix="$" small help="blank = none" /></div>
        </section>

        {/* our cost */}
        <section>
          <div className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>ShipBay cost model <button className="btn-xs" onClick={() => setShowCosts(!showCosts)}>{showCosts ? 'hide' : 'show'}</button></div>
          {showCosts && <>
            <Num label="Burdened labor rate" value={d.costs.labor_rate} onChange={(v) => setC('labor_rate', v)} step={0.1} prefix="$" suffix="/hr" help="$20 wage + ~12% payroll burden." />
            <div className="qrow"><Num label="Min / order" value={d.costs.min_per_order} onChange={(v) => setC('min_per_order', v)} step={0.1} small help="pick, pack, label" /><Num label="Min / addl unit" value={d.costs.min_per_addl_unit} onChange={(v) => setC('min_per_addl_unit', v)} step={0.1} small /><Num label="Min / B2B order" value={d.costs.min_per_b2b_order} onChange={(v) => setC('min_per_b2b_order', v)} small /></div>
            <div className="qrow"><Num label="Min / pallet in" value={d.costs.min_per_pallet_in} onChange={(v) => setC('min_per_pallet_in', v)} small /><Num label="Min / carton in" value={d.costs.min_per_carton_in} onChange={(v) => setC('min_per_carton_in', v)} small /><Num label="Min / return" value={d.costs.min_per_return} onChange={(v) => setC('min_per_return', v)} small /></div>
            <div className="qrow"><Num label="Mailer cost" value={d.costs.pack_cost_mailer} onChange={(v) => setC('pack_cost_mailer', v)} step={0.01} prefix="$" small /><Num label="Box cost" value={d.costs.pack_cost_box_single} onChange={(v) => setC('pack_cost_box_single', v)} step={0.01} prefix="$" small /><Num label="Tape/dunnage / order" value={d.costs.dunnage_per_order} onChange={(v) => setC('dunnage_per_order', v)} step={0.01} prefix="$" small /></div>
            <div className="qrow"><Num label="Space / pallet" value={d.costs.space_cost_pallet} onChange={(v) => setC('space_cost_pallet', v)} prefix="$" small help="rent ÷ positions" /><Num label="/ shelf" value={d.costs.space_cost_shelf} onChange={(v) => setC('space_cost_shelf', v)} prefix="$" small /><Num label="/ bin" value={d.costs.space_cost_bin} onChange={(v) => setC('space_cost_bin', v)} step={0.25} prefix="$" small /></div>
            <div className="qrow"><Num label="Account overhead / mo" value={d.costs.overhead_per_month} onChange={(v) => setC('overhead_per_month', v)} prefix="$" small help="software, support time" /><Num label="Postage we pay (avg)" value={d.costs.postage_cost_avg} onChange={(v) => setC('postage_cost_avg', v)} step={0.01} prefix="$" small help="vs. guarantee → margin or exposure" /></div>
            <div className="costsum">
              <div><span>Labor</span><b>{money(m.cost.labor, 0)}</b></div><div><span>Packaging</span><b>{money(m.cost.packaging, 0)}</b></div><div><span>Space</span><b>{money(m.cost.space, 0)}</b></div><div><span>Overhead</span><b>{money(m.cost.overhead, 0)}</b></div>
              <div className="tot"><span>Cost to serve</span><b>{money(m.cost.total, 0)}</b></div><div className="tot"><span>Per order</span><b>{money(m.costPerOrder)}</b></div>
            </div>
          </>}
        </section>
      </div>

      {/* bill + scenarios */}
      <div className="qtables">
        <div>
          <div className="lbl">The client’s month at {vol.toLocaleString()} orders{hasIntro ? ` — ${cur.label}` : ''}</div>
          <div className="tablewrap"><table className="ordertable bill">
            <thead><tr><th>Line</th><th className="n">Qty</th><th className="n">Rate</th><th className="n">Amount</th></tr></thead>
            <tbody>
              {m.lines.map((l) => <tr key={l.key} className={l.amount === 0 ? 'zero' : ''}><td>{l.label}</td><td className="n">{l.qty ? Number(l.qty).toLocaleString() : '—'}</td><td className="n">{l.qty ? money(l.rate) : '—'}</td><td className="n">{money(l.amount)}</td></tr>)}
              <tr className="sub"><td colSpan={3}>Services</td><td className="n">{money(m.services)}</td></tr>
              <tr><td colSpan={3}>Postage at cost — {vol.toLocaleString()} × {money(d.rates.postage_guarantee_avg || d.inputs.avg_postage)}{Number(d.rates.postage_markup_pct) ? ` + ${d.rates.postage_markup_pct}%` : ''}</td><td className="n">{money(m.postage)}</td></tr>
              <tr className="tot"><td colSpan={3}>All-in · {money(m.perOrder)} / order</td><td className="n">{money(m.allIn)}</td></tr>
            </tbody>
          </table></div>
        </div>
        <div>
          <div className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>Profit at volume <span className="sm" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>scenarios:</span>{d.scenarios.map((v, i) => <input key={i} className="inline sm num" type="number" value={v} onChange={(e) => setD({ ...d, scenarios: d.scenarios.map((x, j) => (j === i ? Number(e.target.value) : x)) })} />)}</div>
          <div className="tablewrap"><table className="ordertable profit">
            <thead><tr><th>Orders</th>{hasIntro && <th>Phase</th>}<th className="n">Client all-in</th><th className="n">$ / order</th><th className="n">Hrs</th><th className="n">Our cost</th><th className="n">Contribution</th><th className="n">Margin</th></tr></thead>
            <tbody>{sc.flatMap((s) => s.rows.map((x) => (
              <tr key={`${s.orders}-${x.phase}`}><td><b>{s.orders.toLocaleString()}</b></td>{hasIntro && <td style={{ whiteSpace: 'nowrap' }}>{x.label}</td>}<td className="n">{money(x.allIn, 0)}<div className="sm">{money(x.services, 0)} svc</div></td><td className="n">{money(x.perOrder)}</td><td className="n">{x.laborHours}</td><td className="n">{money(x.cost.total, 0)}</td><td className={`n ${x.contribution < 0 ? 'neg' : 'pos'}`}><b>{money(x.contribution, 0)}</b></td><td className={`n ${x.contribution < 0 ? 'neg' : ''}`}>{pct(x.margin)}</td></tr>
            )))}</tbody>
          </table></div>
          <p className="sm" style={{ marginTop: 8 }}>Contribution = services billed − labor − packaging − space − account overhead (+ any postage margin). Rent and your time aren’t in it; storage lines carry the space cost.</p>
        </div>
      </div>

      <div style={{ padding: '0 18px' }}>
        <div className="lbl">Notes / terms</div>
        <textarea className="notes" rows={4} value={d.notes || ''} onChange={(e) => setD({ ...d, notes: e.target.value })} />
      </div>
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
  const ex = d.extras || {};
  const val = (key) => ({ pick_first: d.tiers?.[0]?.pick_first, pick_addl: d.tiers?.[0]?.pick_addl, storage_pallet: d.storage_pallet, storage_bin: d.storage_bin, receiving_pallet: d.receiving_pallet, returns: d.returns_fee, minimum: d.monthly_minimum, kitting_hr: ex.kitting_hr }[key]);
  // the cost floor for the lines we can see: labor minutes × burdened rate (+ packaging)
  const floor = { pick_first: (DEFAULT_COSTS.min_per_order / 60) * DEFAULT_COSTS.labor_rate + DEFAULT_COSTS.pack_cost_mailer + DEFAULT_COSTS.dunnage_per_order, pick_addl: (DEFAULT_COSTS.min_per_addl_unit / 60) * DEFAULT_COSTS.labor_rate, storage_pallet: DEFAULT_COSTS.space_cost_pallet, storage_bin: DEFAULT_COSTS.space_cost_bin, receiving_pallet: (DEFAULT_COSTS.min_per_pallet_in / 60) * DEFAULT_COSTS.labor_rate, returns: (DEFAULT_COSTS.min_per_return / 60) * DEFAULT_COSTS.labor_rate, minimum: 0, kitting_hr: DEFAULT_COSTS.labor_rate };

  return (
    <div className="card detail quote ratecard">
      <div className="cardhead">
        <div style={{ flex: 1 }}><h3>Standard rate card <span className="pill connected">current</span></h3><div className="small">Effective {d.effective_from} · what shipbay3pl.com/pricing, the emailed rate card and every new quote start from. Edit here, then update the site copy.</div></div>
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
          <div className="qrow"><Num label="Pallet / mo" value={d.storage_pallet} onChange={(v) => set('storage_pallet', v)} prefix="$" small /><Num label="Shelf / mo" value={d.storage_shelf} onChange={(v) => set('storage_shelf', v)} prefix="$" small /><Num label="Bin / mo" value={d.storage_bin} onChange={(v) => set('storage_bin', v)} step={0.25} prefix="$" small /></div>
          <div className="lbl">Receiving</div>
          <div className="qrow"><Num label="Pallet" value={d.receiving_pallet} onChange={(v) => set('receiving_pallet', v)} prefix="$" small /><Num label="Loose carton" value={d.receiving_carton} onChange={(v) => set('receiving_carton', v)} prefix="$" small /></div>
          <div className="qrow"><Num label="20′ container" value={ex.container_20 ?? 350} onChange={(v) => setEx('container_20', v)} prefix="$" small /><Num label="40′ container" value={ex.container_40 ?? 500} onChange={(v) => setEx('container_40', v)} prefix="$" small /><Num label="Floor-loaded +" value={ex.floor_loaded ?? 150} onChange={(v) => setEx('floor_loaded', v)} prefix="$" small /></div>
        </section>
        <section>
          <div className="lbl">Everything else</div>
          <div className="qrow"><Num label="Return processed" value={d.returns_fee} onChange={(v) => set('returns_fee', v)} step={0.25} prefix="$" small /><Num label="+ addl item" value={ex.returns_addl ?? 0.5} onChange={(v) => setEx('returns_addl', v)} step={0.25} prefix="$" small /><Num label="Intl surcharge" value={d.intl_surcharge} onChange={(v) => set('intl_surcharge', v)} step={0.25} prefix="$" small /></div>
          <div className="qrow"><Num label="B2B order" value={ex.b2b_order ?? 5.5} onChange={(v) => setEx('b2b_order', v)} step={0.25} prefix="$" small /><Num label="B2B unit" value={ex.b2b_unit ?? 0.4} onChange={(v) => setEx('b2b_unit', v)} step={0.05} prefix="$" small /><Num label="Pallet build" value={ex.pallet_build ?? 18} onChange={(v) => setEx('pallet_build', v)} prefix="$" small /></div>
          <div className="qrow"><Num label="FBA / marketplace prep" value={ex.fba_prep ?? 0.6} onChange={(v) => setEx('fba_prep', v)} step={0.05} prefix="$" suffix="/unit" small /><Num label="Kitting / projects" value={ex.kitting_hr ?? 40} onChange={(v) => setEx('kitting_hr', v)} prefix="$" suffix="/hr" small /></div>
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
