// Financials — the finance sheet, live. Ledger (every dollar), recurring burn, pipeline, and QuickBooks pulled in.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { ownerFn, fetchAll, money, pct, num, ymd, monthKey, monthLabel, ago } from './util';

const MARGIN = 0.35;   // contribution margin on services at Rate Card v2 (what's left after labor + supplies)
const KINDS = [['expense', 'Expense'], ['revenue', 'Revenue (invoice)'], ['capex', 'Capex (equipment)'], ['owner_contribution', 'Owner put money in'], ['owner_draw', 'Owner took money out']];
const CATS = ['Software', 'Marketing & outbound', 'Souled fulfillment fee (base)', 'Pallet positions', 'Supplies', 'Labor', 'Legal & professional', 'Insurance', 'Capex (racking, equipment)', 'Services revenue', 'Owner contribution', 'Owner draw', 'Other'];

export default function Financials({ status, refreshStatus }) {
  const [tx, setTx] = useState(null); const [rec, setRec] = useState([]); const [pipe, setPipe] = useState([]); const [cash, setCash] = useState({ amount: 0 });
  const [qbo, setQbo] = useState({});
  const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(null);
  const [view, setView] = useState('overview');

  const load = async () => {
    const [t, r, p, s, q] = await Promise.all([
      fetchAll('fin_transactions', '*', (q) => q.order('txn_date', { ascending: false })),
      fetchAll('fin_recurring', '*', (q) => q.order('amount', { ascending: false })),
      fetchAll('fin_pipeline', '*', (q) => q.order('probability', { ascending: false })),
      supabase.from('fin_settings').select('*').eq('key', 'cash_on_hand').maybeSingle(),
      supabase.from('fin_qbo_reports').select('report, period_start, period_end, data, fetched_at').order('fetched_at', { ascending: false }).limit(12),
    ]);
    setTx(t); setRec(r); setPipe(p); setCash(s.data?.value || { amount: 0 });
    const latest = {}; for (const row of q.data || []) if (!latest[row.report]) latest[row.report] = row; setQbo(latest);
  };
  useEffect(() => { load(); }, []);

  const m = useMemo(() => summarize(tx || [], rec, pipe, cash), [tx, rec, pipe, cash]);

  const say = (r, ok) => { if (r?.error) setMsg({ kind: 'err', text: r.error }); else if (ok) setMsg({ kind: 'ok', text: ok }); };
  const qboConnect = async () => { setBusy('qbo'); const r = await ownerFn({ action: 'qbo_connect' }); setBusy(null); if (r.error) return say(r); window.location.href = r.url; };
  const qboSync = async () => { setBusy('qbo'); const r = await ownerFn({ action: 'qbo_sync' }); setBusy(null); say(r, `Pulled ${r.reports?.join(', ')} from QuickBooks.`); load(); refreshStatus(); };
  const qboDisconnect = async () => { if (!window.confirm('Disconnect QuickBooks? Cached reports stay; new pulls stop until you reconnect.')) return; setBusy('qbo'); const r = await ownerFn({ action: 'qbo_disconnect' }); setBusy(null); say(r, 'QuickBooks disconnected.'); refreshStatus(); };
  const saveCash = async (amount) => { const value = { ...cash, amount: Number(amount) || 0, at: new Date().toISOString() }; await supabase.from('fin_settings').upsert({ key: 'cash_on_hand', value }); setCash(value); };

  if (tx === null) return <div className="card"><div className="empty">Loading the books…</div></div>;
  return (
    <>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="kpis fin">
        <Tile label="Cash in the business" value={money(m.cash)} sub={m.cash ? `${m.runway === Infinity ? 'no burn' : m.runway.toFixed(1) + ' months of runway'}` : 'none yet — Derek pays everything personally'} edit={() => { const v = window.prompt('Cash ShipBay has on hand right now ($):', m.cash); if (v != null) saveCash(v); }} />
        <Tile label="Burn this month" value={money(m.burn)} sub="recurring costs before a single order" hot />
        <Tile label="Break-even" value={`${money(m.breakEven)} / mo`} sub={`services billed at ${pct(MARGIN)} margin · ≈ ${num(Math.ceil(m.breakEven / 2.45))} Launch orders`} />
        <Tile label="Owed to you" value={money(m.owed)} sub="invoices sent, not paid yet" />
        <Tile label={`${monthLabel(m.thisKey)} so far`} value={money(m.thisNet)} sub={`${money(m.thisRev)} in · ${money(m.thisExp)} out`} tone={m.thisNet < 0 ? 'bad' : 'ok'} />
        <Tile label="Derek has put in" value={money(m.ownerIn)} sub={`all-time spend ${money(m.spentAll)} · revenue ${money(m.revAll)}`} />
      </div>

      <div className="card plain">
        <h3>What the numbers say</h3>
        <ul className="plainlist">
          <li>Every month the business costs <b>{money(m.burn)}</b> whether or not an order ships (Souled fee, software, Fulfill.com). That is your <b>burn</b>.</li>
          <li>Roughly <b>{pct(MARGIN)}</b> of every services dollar is left after labor and supplies. To cover the burn you need <b>{money(m.breakEven)}</b> of services billed a month — about <b>{num(Math.ceil(m.breakEven / 2.45))}</b> small-brand orders.</li>
          <li>Signed + likely clients add up to <b>{money(m.weighted)}/mo</b> weighted (<b>{money(m.signed)}/mo</b> from signed accounts). {m.weighted >= m.breakEven ? 'That clears break-even on paper — now it has to show up as invoices.' : `Gap to break-even: ${money(m.breakEven - m.weighted)}/mo — about ${Math.ceil((m.breakEven - m.weighted) / 472)} more Launch-size brands.`}</li>
          <li>So far the company has spent <b>{money(m.spentAll)}</b> ({money(m.capexAll)} of it equipment that keeps value) and billed <b>{money(m.revAll)}</b>. All of that came out of Derek’s pocket, logged as owner contributions — it is capital in, not a loss you “lost”.</li>
        </ul>
      </div>

      <div className="seg">{[['overview', 'Month by month'], ['ledger', 'Ledger'], ['recurring', 'Recurring costs'], ['pipeline', 'Clients & pipeline'], ['qbo', 'QuickBooks']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>

      {view === 'overview' && <Months m={m} />}
      {view === 'ledger' && <Ledger tx={tx} reload={load} say={say} />}
      {view === 'recurring' && <Recurring rec={rec} reload={load} say={say} />}
      {view === 'pipeline' && <Pipeline pipe={pipe} reload={load} say={say} />}
      {view === 'qbo' && <QuickBooks status={status} qbo={qbo} busy={busy} onConnect={qboConnect} onSync={qboSync} onDisconnect={qboDisconnect} />}
    </>
  );
}

function Tile({ label, value, sub, hot, tone, edit }) {
  return <div className={`tile ${tone || ''}`}><small>{label}{edit && <button className="linkbtn" onClick={edit}>edit</button>}</small><b className={hot ? 'hot' : ''}>{value}</b>{sub && <span>{sub}</span>}</div>;
}

/* ---------- the math ---------- */
function summarize(tx, rec, pipe, cash) {
  const now = new Date(); const thisKey = monthKey(now);
  const activeIn = (r, key) => r.starts.slice(0, 7) <= key && (!r.ends || r.ends.slice(0, 7) >= key);
  const burnFor = (key) => rec.filter((r) => activeIn(r, key)).reduce((s, r) => s + Number(r.amount), 0);
  const pipeFor = (key) => pipe.filter((p) => p.status !== 'lost' && (!p.start_month || p.start_month.slice(0, 7) <= key)).reduce((s, p) => s + Number(p.services_mo) * Number(p.probability), 0);
  const months = {};
  const bump = (k, f, v) => { months[k] = months[k] || { rev: 0, exp: 0, capex: 0, ownerIn: 0, ownerOut: 0 }; months[k][f] += Number(v); };
  for (const t of tx) {
    const k = t.txn_date.slice(0, 7);
    if (t.kind === 'revenue') bump(k, 'rev', t.amount); else if (t.kind === 'expense') bump(k, 'exp', t.amount); else if (t.kind === 'capex') bump(k, 'capex', t.amount);
    else if (t.kind === 'owner_contribution') bump(k, 'ownerIn', t.amount); else if (t.kind === 'owner_draw') bump(k, 'ownerOut', t.amount);
  }
  // table: from the first month with data (or 3 months back) to 4 months ahead
  const keys = Object.keys(months).sort(); const first = keys[0] || monthKey(new Date(now.getFullYear(), now.getMonth() - 3, 1));
  const rows = []; let cur = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1); const end = new Date(now.getFullYear(), now.getMonth() + 4, 1);
  let cum = 0;
  while (cur <= end) {
    const k = monthKey(cur); const a = months[k] || { rev: 0, exp: 0, capex: 0, ownerIn: 0, ownerOut: 0 };
    const future = k > thisKey; const expRev = pipeFor(k); const expBurn = burnFor(k);
    const net = future ? expRev - expBurn : a.rev - a.exp;
    cum += net;
    rows.push({ key: k, label: monthLabel(k), future, current: k === thisKey, rev: a.rev, exp: a.exp, capex: a.capex, ownerIn: a.ownerIn, expRev, expBurn, net, cum });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  const burn = burnFor(thisKey); const breakEven = burn / MARGIN;
  const cashAmt = Number(cash?.amount) || 0;
  return {
    thisKey, rows, burn, breakEven, cash: cashAmt, runway: burn ? cashAmt / burn : Infinity,
    owed: tx.filter((t) => t.kind === 'revenue' && !t.paid).reduce((s, t) => s + Number(t.amount), 0),
    thisRev: months[thisKey]?.rev || 0, thisExp: (months[thisKey]?.exp || 0) + (months[thisKey]?.capex || 0), thisNet: (months[thisKey]?.rev || 0) - (months[thisKey]?.exp || 0) - (months[thisKey]?.capex || 0),
    ownerIn: tx.filter((t) => t.kind === 'owner_contribution').reduce((s, t) => s + Number(t.amount), 0) - tx.filter((t) => t.kind === 'owner_draw').reduce((s, t) => s + Number(t.amount), 0),
    spentAll: tx.filter((t) => t.kind === 'expense' || t.kind === 'capex').reduce((s, t) => s + Number(t.amount), 0),
    capexAll: tx.filter((t) => t.kind === 'capex').reduce((s, t) => s + Number(t.amount), 0),
    revAll: tx.filter((t) => t.kind === 'revenue').reduce((s, t) => s + Number(t.amount), 0),
    weighted: pipe.filter((p) => p.status !== 'lost').reduce((s, p) => s + Number(p.services_mo) * Number(p.probability), 0),
    signed: pipe.filter((p) => ['signed', 'live'].includes(p.status) || Number(p.probability) >= 0.9).reduce((s, p) => s + Number(p.services_mo), 0),
  };
}

/* ---------- Month by month: bars + table ---------- */
function Months({ m }) {
  const max = Math.max(1, ...m.rows.map((r) => Math.max(r.future ? r.expRev : r.rev, r.future ? r.expBurn : r.exp + r.capex)));
  return (
    <div className="card">
      <h3>Money in vs money out, by month</h3>
      <p className="hint">Solid months happened. Striped months are expected: recurring costs vs weighted pipeline. Green = in, orange = out.</p>
      <div className="bars">
        {m.rows.map((r) => { const inn = r.future ? r.expRev : r.rev; const out = r.future ? r.expBurn : r.exp + r.capex; return (
          <div key={r.key} className={`bar-m ${r.future ? 'future' : ''} ${r.current ? 'current' : ''}`} title={`${r.label}: in ${money(inn)} · out ${money(out)}`}>
            <div className="cols"><i className="in" style={{ height: `${(inn / max) * 100}%` }} /><i className="out" style={{ height: `${(out / max) * 100}%` }} /></div>
            <small>{r.label}</small>
          </div>
        ); })}
      </div>
      <div className="tablewrap"><table className="ordertable fin">
        <thead><tr><th>Month</th><th className="n">In (revenue)</th><th className="n">Out (expenses)</th><th className="n">Equipment</th><th className="n">Net</th><th className="n">Running total</th><th className="n">Derek put in</th></tr></thead>
        <tbody>{m.rows.map((r) => (
          <tr key={r.key} className={r.future ? 'muted' : r.current ? 'hl' : ''}>
            <td><b>{r.label}</b>{r.future && <span className="sm"> expected</span>}{r.current && <span className="sm"> now</span>}</td>
            <td className="n">{money(r.future ? r.expRev : r.rev)}</td>
            <td className="n">{money(r.future ? r.expBurn : r.exp)}</td>
            <td className="n">{r.future ? '—' : money(r.capex)}</td>
            <td className={`n ${r.net < 0 ? 'neg' : 'pos'}`}>{money(r.net)}</td>
            <td className={`n ${r.cum < 0 ? 'neg' : 'pos'}`}>{money(r.cum)}</td>
            <td className="n">{r.future ? '—' : money(r.ownerIn)}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

/* ---------- Ledger ---------- */
function Ledger({ tx, reload, say }) {
  const blank = { txn_date: ymd(new Date()), kind: 'expense', category: 'Software', counterparty: '', description: '', amount: '', paid: true };
  const [f, setF] = useState(blank); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const add = async (e) => {
    e.preventDefault(); if (!f.amount) return; setBusy(true);
    const { error } = await supabase.from('fin_transactions').insert({ ...f, amount: Number(f.amount), source: 'manual' });
    setBusy(false); if (error) return say({ error: error.message }); setF({ ...blank, txn_date: f.txn_date }); reload();
  };
  const del = async (t) => { if (!window.confirm(`Delete ${money(t.amount, 2)} ${t.counterparty || ''}?`)) return; await supabase.from('fin_transactions').delete().eq('id', t.id); reload(); };
  const togglePaid = async (t) => { await supabase.from('fin_transactions').update({ paid: !t.paid }).eq('id', t.id); reload(); };
  const list = tx.filter((t) => !q || [t.counterparty, t.description, t.category, t.kind].filter(Boolean).some((s) => s.toLowerCase().includes(q.toLowerCase()))).slice(0, 200);
  return (
    <>
      <form className="card addrow" onSubmit={add}>
        <h3>Add a line</h3>
        <div className="addgrid">
          <label>Date<input type="date" value={f.txn_date} onChange={set('txn_date')} /></label>
          <label>Type<select value={f.kind} onChange={set('kind')}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Category<select value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>Who<input value={f.counterparty} onChange={set('counterparty')} placeholder="Vendor or client" /></label>
          <label className="wide">What<input value={f.description} onChange={set('description')} placeholder="What it was for" /></label>
          <label>Amount $<input type="number" step="0.01" min="0" value={f.amount} onChange={set('amount')} /></label>
          <label className="chk"><input type="checkbox" checked={f.paid} onChange={set('paid')} /> paid</label>
          <button className="btn-sm primary" disabled={busy}>Add</button>
        </div>
        <p className="hint">Rule of thumb: if you paid it from your own card, add the expense <i>and</i> an “Owner put money in” line for the same amount. Invoices you send go in as Revenue, unchecked “paid” until the money lands.</p>
      </form>
      <div className="card">
        <div className="opsbar"><input className="search" placeholder="Search the ledger…" value={q} onChange={(e) => setQ(e.target.value)} /><div className="spacer" /><span className="sm">{tx.length} lines</span></div>
        <div className="tablewrap"><table className="ordertable fin">
          <thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Who</th><th>What</th><th className="n">Amount</th><th>Paid</th><th /></tr></thead>
          <tbody>{list.map((t) => (
            <tr key={t.id}>
              <td className="sm">{t.txn_date}</td>
              <td><span className={`pill ${t.kind === 'revenue' ? 'connected' : t.kind.startsWith('owner') ? 'pending' : ''}`}>{KINDS.find((k) => k[0] === t.kind)?.[1] || t.kind}</span></td>
              <td className="sm">{t.category}</td><td>{t.counterparty}</td><td className="sm">{t.description}</td>
              <td className={`n ${t.kind === 'revenue' || t.kind === 'owner_contribution' ? 'pos' : 'neg'}`}>{money(t.amount, 2)}</td>
              <td><button className={`btn-xs ${t.paid ? '' : 'warn'}`} onClick={() => togglePaid(t)}>{t.paid ? 'paid' : 'unpaid'}</button></td>
              <td className="n"><button className="btn-xs" onClick={() => del(t)}>×</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}

/* ---------- Recurring ---------- */
function Recurring({ rec, reload, say }) {
  const blank = { item: '', category: 'Software', amount: '', starts: ymd(new Date()).slice(0, 7) + '-01', ends: '', note: '' };
  const [f, setF] = useState(blank);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const add = async (e) => { e.preventDefault(); if (!f.item || !f.amount) return; const { error } = await supabase.from('fin_recurring').insert({ ...f, amount: Number(f.amount), ends: f.ends || null }); if (error) return say({ error: error.message }); setF(blank); reload(); };
  const del = async (r) => { if (!window.confirm(`Remove ${r.item}?`)) return; await supabase.from('fin_recurring').delete().eq('id', r.id); reload(); };
  const end = async (r) => { await supabase.from('fin_recurring').update({ ends: ymd(new Date()) }).eq('id', r.id); reload(); };
  const k = monthKey(new Date()); const active = rec.filter((r) => r.starts.slice(0, 7) <= k && (!r.ends || r.ends.slice(0, 7) >= k));
  return (
    <>
      <form className="card addrow" onSubmit={add}>
        <h3>Add a recurring cost</h3>
        <div className="addgrid">
          <label className="wide">Item<input value={f.item} onChange={set('item')} placeholder="e.g. Dialer subscription" /></label>
          <label>Category<select value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>$ / month<input type="number" step="0.01" value={f.amount} onChange={set('amount')} /></label>
          <label>Starts<input type="date" value={f.starts} onChange={set('starts')} /></label>
          <label>Ends<input type="date" value={f.ends} onChange={set('ends')} /></label>
          <label className="wide">Note<input value={f.note} onChange={set('note')} /></label>
          <button className="btn-sm primary">Add</button>
        </div>
      </form>
      <div className="card">
        <div className="opsbar"><b>{money(active.reduce((s, r) => s + Number(r.amount), 0))} / month right now</b><div className="spacer" /><span className="sm">{active.length} active · {rec.length - active.length} ended or future</span></div>
        <div className="tablewrap"><table className="ordertable fin">
          <thead><tr><th>Item</th><th>Category</th><th className="n">$ / mo</th><th>From</th><th>To</th><th>Note</th><th /></tr></thead>
          <tbody>{rec.map((r) => { const on = active.includes(r); return (
            <tr key={r.id} className={on ? '' : 'muted'}>
              <td><b>{r.item}</b></td><td className="sm">{r.category}</td><td className="n">{money(r.amount, 2)}</td><td className="sm">{r.starts.slice(0, 7)}</td><td className="sm">{r.ends ? r.ends.slice(0, 7) : 'open'}</td><td className="sm">{r.note}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{on && <button className="btn-xs" onClick={() => end(r)}>Cancelled today</button>} <button className="btn-xs" onClick={() => del(r)}>×</button></td>
            </tr>
          ); })}</tbody>
        </table></div>
      </div>
    </>
  );
}

/* ---------- Pipeline ---------- */
const PSTAT = ['prospect', 'quoted', 'signed', 'live', 'lost'];
function Pipeline({ pipe, reload, say }) {
  const blank = { client: '', status: 'prospect', model: 'DTC', orders_mo: '', services_mo: '', probability: 0.5, start_month: '', notes: '' };
  const [f, setF] = useState(blank);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const add = async (e) => { e.preventDefault(); if (!f.client) return; const { error } = await supabase.from('fin_pipeline').insert({ ...f, orders_mo: f.orders_mo ? Number(f.orders_mo) : null, services_mo: Number(f.services_mo) || 0, probability: Number(f.probability), start_month: f.start_month ? f.start_month + '-01' : null }); if (error) return say({ error: error.message }); setF(blank); reload(); };
  const upd = async (p, patch) => { await supabase.from('fin_pipeline').update(patch).eq('id', p.id); reload(); };
  const del = async (p) => { if (!window.confirm(`Remove ${p.client}?`)) return; await supabase.from('fin_pipeline').delete().eq('id', p.id); reload(); };
  const w = pipe.filter((p) => p.status !== 'lost').reduce((s, p) => s + Number(p.services_mo) * Number(p.probability), 0);
  return (
    <>
      <form className="card addrow" onSubmit={add}>
        <h3>Add a client or prospect</h3>
        <div className="addgrid">
          <label className="wide">Client<input value={f.client} onChange={set('client')} /></label>
          <label>Status<select value={f.status} onChange={set('status')}>{PSTAT.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Model<input value={f.model} onChange={set('model')} placeholder="DTC / subscription / B2B" /></label>
          <label>Orders / mo<input type="number" value={f.orders_mo} onChange={set('orders_mo')} /></label>
          <label>Services $ / mo<input type="number" step="0.01" value={f.services_mo} onChange={set('services_mo')} /></label>
          <label>Probability<input type="number" step="0.05" min="0" max="1" value={f.probability} onChange={set('probability')} /></label>
          <label>Start month<input type="month" value={f.start_month} onChange={set('start_month')} /></label>
          <label className="wide">Notes<input value={f.notes} onChange={set('notes')} /></label>
          <button className="btn-sm primary">Add</button>
        </div>
      </form>
      <div className="card">
        <div className="opsbar"><b>{money(w)} / month weighted</b><span className="sm"> · services only; postage is on the client’s account</span><div className="spacer" /></div>
        <div className="tablewrap"><table className="ordertable fin">
          <thead><tr><th>Client</th><th>Status</th><th>Model</th><th className="n">Orders / mo</th><th className="n">Services $ / mo</th><th className="n">Prob.</th><th className="n">Weighted</th><th>Start</th><th>Notes</th><th /></tr></thead>
          <tbody>{pipe.map((p) => (
            <tr key={p.id} className={p.status === 'lost' ? 'muted' : ''}>
              <td><b>{p.client}</b></td>
              <td><select className="statusselect" value={p.status} onChange={(e) => upd(p, { status: e.target.value })}>{PSTAT.map((s) => <option key={s}>{s}</option>)}</select></td>
              <td className="sm">{p.model}</td><td className="n">{num(p.orders_mo)}</td><td className="n">{money(p.services_mo)}</td>
              <td className="n"><input className="cellnum" type="number" step="0.05" min="0" max="1" defaultValue={p.probability} onBlur={(e) => Number(e.target.value) !== Number(p.probability) && upd(p, { probability: Number(e.target.value) })} /></td>
              <td className="n"><b>{money(Number(p.services_mo) * Number(p.probability))}</b></td>
              <td className="sm">{p.start_month ? p.start_month.slice(0, 7) : '—'}</td><td className="sm">{p.notes}</td>
              <td className="n"><button className="btn-xs" onClick={() => del(p)}>×</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}

/* ---------- QuickBooks ---------- */
function QuickBooks({ status, qbo, busy, onConnect, onSync, onDisconnect }) {
  const s = status.qbo || {};
  const pl = qbo.ProfitAndLoss ? plSummary(qbo.ProfitAndLoss.data) : null;
  const bs = qbo.BalanceSheet ? pickRows(qbo.BalanceSheet.data, /^(Total Bank Accounts|Total Accounts Receivable|Total Current Assets|Total Assets|Total Liabilities|Total Equity|Total Credit Cards)$/) : [];
  const ar = qbo.AgedReceivables ? pickRows(qbo.AgedReceivables.data, /^TOTAL$/i) : [];
  const tl = qbo.TransactionList ? flatRows(qbo.TransactionList.data).slice(0, 60) : [];
  return (
    <>
      <div className="card">
        <div className="opsbar">
          <div>
            <h3 style={{ margin: 0 }}>QuickBooks Online</h3>
            <span className="sm">{s.connected_at ? <>Connected to <b>{s.company_name || s.realm_id}</b> · last pull {ago(s.last_sync_at)}</> : status.qbo_keys_set ? 'App keys saved — connect to pull your books.' : 'Paste the Intuit app keys under Settings first.'}</span>
            {s.last_error && <div className="msg err" style={{ marginTop: 8 }}>{s.last_error}</div>}
          </div>
          <div className="spacer" />
          {!s.connected_at && <button className="btn-sm primary" disabled={busy === 'qbo' || !status.qbo_keys_set} onClick={onConnect}>Connect QuickBooks</button>}
          {s.connected_at && <><button className="btn-sm primary" disabled={busy === 'qbo'} onClick={onSync}>{busy === 'qbo' ? 'Pulling…' : 'Pull latest'}</button> <button className="btn-sm" disabled={busy === 'qbo'} onClick={onDisconnect}>Disconnect</button></>}
        </div>
        <p className="hint">What gets pulled: Profit & Loss by month (this year), Balance Sheet (today), the last 90 days of transactions, and who owes you (aged receivables). The Ledger above stays ShipBay’s own book of record until QuickBooks is clean; use this to check the two agree.</p>
      </div>
      {pl && (
        <div className="card">
          <h3>Profit & Loss by month (QuickBooks)</h3>
          <div className="tablewrap"><table className="ordertable fin">
            <thead><tr><th /> {pl.cols.map((c) => <th key={c} className="n">{c}</th>)}</tr></thead>
            <tbody>{pl.rows.map((r) => <tr key={r.label}><td><b>{r.label}</b></td>{r.vals.map((v, i) => <td key={i} className={`n ${v < 0 ? 'neg' : ''}`}>{money(v)}</td>)}</tr>)}</tbody>
          </table></div>
        </div>
      )}
      {(bs.length > 0 || ar.length > 0) && (
        <div className="card">
          <h3>Balance sheet (today)</h3>
          <table className="ordertable fin"><tbody>{bs.map((r) => <tr key={r[0]}><td>{r[0]}</td><td className="n">{money(r[1])}</td></tr>)}{ar.map((r) => <tr key="ar"><td>Owed to you (all invoices)</td><td className="n">{money(r[r.length - 1])}</td></tr>)}</tbody></table>
        </div>
      )}
      {tl.length > 0 && (
        <div className="card">
          <h3>Last 90 days of QuickBooks transactions</h3>
          <div className="tablewrap"><table className="ordertable fin">
            <thead><tr><th>Date</th><th>Type</th><th>Name</th><th>Memo</th><th>Account</th><th className="n">Amount</th></tr></thead>
            <tbody>{tl.map((r, i) => <tr key={i}><td className="sm">{r[0]}</td><td className="sm">{r[1]}</td><td>{r[3]}</td><td className="sm">{r[4]}</td><td className="sm">{r[5]}</td><td className={`n ${Number(r[6]) < 0 ? 'neg' : ''}`}>{money(r[6], 2)}</td></tr>)}</tbody>
          </table></div>
        </div>
      )}
    </>
  );
}
// QBO report JSON: Columns.Column[].ColTitle, Rows.Row[] nested with Header/Rows/Summary; Summary.ColData[] holds the totals.
function walk(rows, out) { for (const r of rows || []) { if (r.ColData) out.push(r.ColData.map((c) => c.value)); if (r.Summary) out.push(r.Summary.ColData.map((c) => c.value)); if (r.Rows) walk(r.Rows.Row, out); } return out; }
function flatRows(rep) { return walk(rep?.Rows?.Row, []).filter((r) => r[0] && !/^Total/i.test(r[0])); }
function pickRows(rep, re) { return walk(rep?.Rows?.Row, []).filter((r) => re.test(r[0])).map((r) => [r[0], Number(r[r.length - 1]) || 0]); }
function plSummary(rep) {
  const cols = (rep?.Columns?.Column || []).slice(1).map((c) => c.ColTitle);
  const want = ['Total Income', 'Total Cost of Goods Sold', 'Gross Profit', 'Total Expenses', 'Net Operating Income', 'Net Income'];
  const all = walk(rep?.Rows?.Row, []);
  const rows = want.map((w) => all.find((r) => r[0] === w)).filter(Boolean).map((r) => ({ label: r[0], vals: r.slice(1).map((v) => Number(v) || 0) }));
  return { cols, rows };
}
