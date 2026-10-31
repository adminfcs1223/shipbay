// Financials — one screen. Pick a month, see money in / money out / bottom line, where it went, and every transaction
// (yours + QuickBooks) underneath. Add an expense or income with one button.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { ownerFn, fetchAll, money, pct, ymd, monthKey, monthLabel, ago } from './util';

const CATS = ['Software', 'Marketing & outbound', 'Souled fulfillment fee (base)', 'Pallet positions', 'Supplies', 'Labor', 'Legal & professional', 'Insurance', 'Travel', 'Capex (racking, equipment)', 'Refunds', 'Other'];
const INCATS = ['Services revenue', 'Storage', 'Receiving', 'Other income'];
const PALETTE = ['#FF6B15', '#101C2B', '#1E9E6F', '#3B82F6', '#A855F7', '#F59E0B', '#EF4444', '#14B8A6', '#6B7280', '#EC4899', '#84CC16', '#0EA5E9'];

export default function Financials({ status, refreshStatus }) {
  const [tx, setTx] = useState(null); const [ar, setAr] = useState(null); const [rec, setRec] = useState([]);
  const [period, setPeriod] = useState(() => ({ kind: 'month', key: monthKey(new Date()) }));
  const [adding, setAdding] = useState(null); const [editing, setEditing] = useState(null); const [nutOpen, setNutOpen] = useState(false); const [newOpen, setNewOpen] = useState(false);
  const [q, setQ] = useState(''); const [showDupes, setShowDupes] = useState(false);
  const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);

  const load = async () => {
    const [t, r, rc] = await Promise.all([
      fetchAll('fin_transactions', '*', (qq) => qq.order('txn_date', { ascending: false }).order('created_at', { ascending: false })),
      supabase.from('fin_qbo_reports').select('data').eq('report', 'AgedReceivables').order('fetched_at', { ascending: false }).limit(1).maybeSingle(),
      fetchAll('fin_recurring', '*', (qq) => qq.order('amount', { ascending: false })),
    ]);
    setTx(t); setAr(r.data ? arTotal(r.data.data) : null); setRec(rc);
  };
  useEffect(() => { load(); }, []);

  const say = (r, ok) => { if (r?.error) setMsg({ kind: 'err', text: r.error }); else if (ok) setMsg({ kind: 'ok', text: ok }); };
  const connect = async () => { setBusy(true); const r = await ownerFn({ action: 'qbo_connect' }); setBusy(false); if (r.error) return say(r); window.location.href = r.url; };
  const sync = async () => { setBusy(true); const r = await ownerFn({ action: 'qbo_sync' }); setBusy(false); say(r, r.error ? null : `QuickBooks synced · ${r.imported || 0} transactions.`); load(); refreshStatus(); };

  const m = useMemo(() => tx ? summarize(tx, period) : null, [tx, period]);
  const nut = useMemo(() => { const k = period.kind === 'month' ? period.key : monthKey(new Date()); return rec.filter((r) => r.starts.slice(0, 7) <= k && (!r.ends || r.ends.slice(0, 7) >= k)); }, [rec, period]);
  const nutTotal = nut.reduce((a, r) => a + Number(r.amount), 0);
  if (!m) return <div className="card"><div className="empty">Loading…</div></div>;

  const qbo = status.qbo || {};
  const shift = (d) => { const [y, mo] = period.key.split('-').map(Number); setPeriod({ kind: 'month', key: monthKey(new Date(y, mo - 1 + d, 1)) }); };
  const title = period.kind === 'year' ? `${period.key} · year to date` : new Date(Number(period.key.slice(0, 4)), Number(period.key.slice(5, 7)) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const rows = [...m.rows].sort((a, b) => b.txn_date.localeCompare(a.txn_date)).filter((t) => (showDupes || !t.dupe) && (!q || [t.counterparty, t.description, t.category].filter(Boolean).some((s) => s.toLowerCase().includes(q.toLowerCase()))));
  const monthRev = period.kind === 'month' ? m.inn : m.trend[m.trend.length - 1].inn;
  const covered = nutTotal ? Math.min(1, monthRev / nutTotal) : 0;
  const plMax = Math.max(1, m.inn, m.out);

  return (
    <>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="finhead">
        <div className="period">
          <button className="btn-sm" onClick={() => shift(-1)} disabled={period.kind !== 'month'}>‹</button>
          <b>{title}</b>
          <button className="btn-sm" onClick={() => shift(1)} disabled={period.kind !== 'month' || period.key >= monthKey(new Date())}>›</button>
          <span className="seg tight"><button className={period.kind === 'month' ? 'on' : ''} onClick={() => setPeriod({ kind: 'month', key: monthKey(new Date()) })}>Month</button><button className={period.kind === 'year' ? 'on' : ''} onClick={() => setPeriod({ kind: 'year', key: String(new Date().getFullYear()) })}>Year</button></span>
        </div>
        <div className="qbo">
          {qbo.connected_at
            ? <><span className="dotok" /> QuickBooks synced {ago(qbo.last_sync_at)} <button className="btn-sm" disabled={busy} onClick={sync}>{busy ? '…' : 'Sync'}</button><a className="btn-sm" href="https://app.qbo.intuit.com/app/homepage" target="_blank" rel="noreferrer">Open QuickBooks ↗</a></>
            : <><span className="dotoff" /> QuickBooks not connected {status.qbo_keys_set ? <button className="btn-sm primary" disabled={busy} onClick={connect}>Connect</button> : <span className="sm">· add the app keys under Settings</span>}</>}
          <div className="newmenu">
            <button className="btn-sm primary" onClick={() => setNewOpen((v) => !v)}>+ New ▾</button>
            {newOpen && <div className="menu" onMouseLeave={() => setNewOpen(false)}>
              <button onClick={() => { setNewOpen(false); setAdding('expense'); }}>Expense</button>
              <button onClick={() => { setNewOpen(false); setAdding('revenue'); }}>Income / invoice paid</button>
              <button onClick={() => { setNewOpen(false); setAdding('owner_contribution'); }}>Money I put in</button>
              <button onClick={() => { setNewOpen(false); setAdding('capex'); }}>Equipment purchase</button>
            </div>}
          </div>
        </div>
      </div>
      {qbo.last_error && <div className="msg err flash">{qbo.last_error}</div>}

      <div className="kpis fin">
        <div className="tile rev"><small>Revenue</small><b className="pos">{money(m.inn)}</b><span>{m.inCount} payment{m.inCount === 1 ? '' : 's'} in</span></div>
        <div className="tile"><small>Expenses</small><b>{money(m.out)}</b><span>{m.outCount} transaction{m.outCount === 1 ? '' : 's'}</span></div>
        <div className={`tile ${m.net < 0 ? 'bad' : 'ok'}`}><small>Net profit</small><b>{money(m.net)}</b><span>{m.prevNet != null ? `${monthLabel(m.prevKey)}: ${money(m.prevNet)}` : ' '}</span></div>
        <div className="tile"><small>Open invoices</small><b>{money(ar ?? m.owed)}</b><span>{ar != null ? 'owed to you, per QuickBooks' : 'owed to you'}</span></div>
      </div>

      <div className="ownergrid">
        <div className="card nutcard">
          <div className="cardhead"><h3>Monthly nut</h3><span className="sm">what the business costs before a single order</span><div className="spacer" /><button className="btn-xs" onClick={() => setNutOpen(true)}>Edit</button></div>
          <div className="nutnum"><b>{money(monthRev)}</b><span>of {money(nutTotal)} covered by this month’s revenue</span></div>
          <div className="nutbar"><i style={{ width: `${covered * 100}%` }} /><em style={{ left: '100%' }} /></div>
          <div className="nutfoot">{monthRev >= nutTotal && nutTotal > 0 ? <span className="pos">Nut covered · {money(monthRev - nutTotal)} over</span> : <span>{money(nutTotal - monthRev)} to go · {pct(covered)}</span>}<span className="sm">{nut.length} fixed costs</span></div>
        </div>
        <div className="card">
          <div className="cardhead"><h3>Profit & loss</h3><span className="sm">{title}</span></div>
          <div className="plbars">
            <div className="plrow"><span>Income</span><div className="plbar"><i className="in" style={{ width: `${(m.inn / plMax) * 100}%` }} /></div><b className="pos">{money(m.inn)}</b></div>
            <div className="plrow"><span>Expenses</span><div className="plbar"><i className="out" style={{ width: `${(m.out / plMax) * 100}%` }} /></div><b>{money(m.out)}</b></div>
            <div className="plrow net"><span>Net profit</span><div /><b className={m.net < 0 ? 'neg' : 'pos'}>{money(m.net)}</b></div>
          </div>
        </div>
        <div className="card">
          <div className="cardhead"><h3>Expenses by category</h3></div>
          {m.outByCat.length === 0 ? <div className="empty">Nothing spent in this period.</div> : (
            <div className="piewrap">
              <Donut slices={m.outByCat} total={m.out} />
              <ul className="legend">{m.outByCat.map((s, i) => (
                <li key={s.name}><i style={{ background: PALETTE[i % PALETTE.length] }} /><span className="nm">{s.name}</span><b>{money(s.amount)}</b><span className="pc">{pct(s.amount / m.out)}</span>{s.flag && <span className="flag" title={s.flag}>{s.flag}</span>}</li>
              ))}</ul>
            </div>
          )}
        </div>
        <div className="card">
          <div className="cardhead"><h3>Last 6 months</h3><span className="sm"><i className="sw in" /> income &nbsp; <i className="sw out" /> expenses</span></div>
          <Trend months={m.trend} />
        </div>
      </div>

      <div className="card">
        <div className="cardhead">
          <h3>Transactions</h3>
          <input className="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          {m.dupes > 0 && <label className="chk sm"><input type="checkbox" checked={showDupes} onChange={(e) => setShowDupes(e.target.checked)} /> show {m.dupes} possible duplicate{m.dupes === 1 ? '' : 's'}</label>}
        </div>
        {rows.length === 0 ? <div className="empty">No transactions in this period.</div> : (
          <div className="tablewrap"><table className="ordertable fin txns">
            <thead><tr><th>Date</th><th>Payee / customer</th><th>Memo</th><th>Category</th><th>Source</th><th className="n">Amount</th></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.id} className="click" onClick={() => setEditing(t)}>
                <td className="sm mono">{t.txn_date.slice(5)}</td>
                <td><b>{t.counterparty || '—'}</b></td>
                <td className="sm">{t.description}</td>
                <td><span className="pill">{t.category}</span></td>
                <td>{t.source === 'qbo' ? <span className="pill connected">QuickBooks</span> : <span className="pill">manual</span>}</td>
                <td className={`n ${t.kind === 'revenue' ? 'pos' : t.kind === 'owner_contribution' ? '' : 'neg'}`}>{t.kind === 'revenue' || t.kind === 'owner_contribution' ? '+' : '−'}{money(t.amount, 2)}{t.kind === 'owner_contribution' && <div className="sm">put in</div>}{t.kind === 'capex' && <div className="sm">equipment</div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="sm" style={{ margin: '8px 2px 0' }}>You’ve put in <b>{money(m.ownerAll)}</b> all-time · spent <b>{money(m.spentAll)}</b> · earned <b>{money(m.earnedAll)}</b></div>

      {adding && <TxModal kind={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); load(); }} say={say} />}
      {editing && <TxModal tx={editing} kind={editing.kind} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} say={say} />}
      {nutOpen && <NutModal rec={rec} onClose={() => setNutOpen(false)} reload={load} say={say} />}
    </>
  );
}

/* ---------- monthly nut: the fixed costs list ---------- */
function NutModal({ rec, onClose, reload, say }) {
  const [item, setItem] = useState(''); const [amt, setAmt] = useState('');
  const k = monthKey(new Date()); const active = rec.filter((r) => r.starts.slice(0, 7) <= k && (!r.ends || r.ends.slice(0, 7) >= k));
  const add = async (e) => { e.preventDefault(); if (!item.trim() || !amt) return; const { error } = await supabase.from('fin_recurring').insert({ item: item.trim(), category: 'Other', amount: Number(amt), starts: k + '-01' }); if (error) return say({ error: error.message }); setItem(''); setAmt(''); reload(); };
  const stop = async (r) => { await supabase.from('fin_recurring').update({ ends: ymd(new Date()) }).eq('id', r.id); reload(); };
  const setAmount = async (r, v) => { if (Number(v) === Number(r.amount)) return; await supabase.from('fin_recurring').update({ amount: Number(v) || 0 }).eq('id', r.id); reload(); };
  return (
    <div className="overlay" onClick={onClose}><div className="modal wide" onClick={(e) => e.stopPropagation()}>
      <h3>Monthly nut</h3>
      <p className="lead">Every cost that hits whether or not an order ships. Total right now: <b>{money(active.reduce((a, r) => a + Number(r.amount), 0))}</b> / month.</p>
      <table className="ordertable fin"><tbody>{active.map((r) => <tr key={r.id}><td>{r.item}</td><td className="n"><input className="cellnum" type="number" step="0.01" defaultValue={r.amount} onBlur={(e) => setAmount(r, e.target.value)} /></td><td className="n"><button className="btn-xs" onClick={() => stop(r)}>Cancelled</button></td></tr>)}</tbody></table>
      <form className="addgrid two" style={{ marginTop: 12 }} onSubmit={add}>
        <label>New fixed cost<input value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Dialer" /></label>
        <label>$ / month<input type="number" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} /></label>
        <div className="wide2 row" style={{ marginTop: 0 }}><div className="spacer" /><button className="btn-sm primary">Add</button><button type="button" className="btn-sm" onClick={onClose}>Done</button></div>
      </form>
    </div></div>
  );
}

/* ---------- numbers ---------- */
function inPeriod(t, p) { return p.kind === 'year' ? t.txn_date.startsWith(p.key) : t.txn_date.startsWith(p.key); }
function summarize(tx, period) {
  const cur = tx.filter((t) => inPeriod(t, period));
  // manual rows that look like a QuickBooks row (same date + amount) are probably the same charge
  const qboKeys = new Set(cur.filter((t) => t.source === 'qbo').map((t) => `${t.txn_date}|${Number(t.amount).toFixed(2)}`));
  for (const t of cur) t.dupe = t.source !== 'qbo' && t.kind !== 'owner_contribution' && qboKeys.has(`${t.txn_date}|${Number(t.amount).toFixed(2)}`);
  const live = cur.filter((t) => !t.dupe);
  const sum = (arr) => arr.reduce((s, t) => s + Number(t.amount), 0);
  const inn = sum(live.filter((t) => t.kind === 'revenue')); const out = sum(live.filter((t) => t.kind === 'expense' || t.kind === 'capex'));
  const group = (arr, key) => { const g = {}; for (const t of arr) g[key(t)] = (g[key(t)] || 0) + Number(t.amount); return Object.entries(g).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount); };
  // previous period for flags
  const prevKey = period.kind === 'month' ? monthKey(new Date(Number(period.key.slice(0, 4)), Number(period.key.slice(5, 7)) - 2, 1)) : String(Number(period.key) - 1);
  const prev = tx.filter((t) => t.txn_date.startsWith(prevKey));
  const prevOut = group(prev.filter((t) => t.kind === 'expense' || t.kind === 'capex'), (t) => t.category);
  const outByCat = group(live.filter((t) => t.kind === 'expense' || t.kind === 'capex'), (t) => t.category).map((s) => {
    const p = prevOut.find((x) => x.name === s.name)?.amount || 0;
    let flag = null;
    if (out && s.amount / out >= 0.4 && s.amount >= 500) flag = `${pct(s.amount / out)} of everything you spent`;
    else if (p && s.amount >= p * 1.5 && s.amount - p >= 100) flag = `up ${pct(s.amount / p - 1)} vs ${monthLabel(prevKey)}`;
    return { ...s, flag };
  });
  const inByWho = group(live.filter((t) => t.kind === 'revenue'), (t) => t.counterparty || t.category || 'Other');
  const prevNet = prev.length ? sum(prev.filter((t) => t.kind === 'revenue')) - sum(prev.filter((t) => t.kind === 'expense' || t.kind === 'capex')) : null;
  // 6-month trend ending at the selected month (or current month for year view)
  const endKey = period.kind === 'month' ? period.key : monthKey(new Date());
  const trend = [];
  for (let i = 5; i >= 0; i--) { const k = monthKey(new Date(Number(endKey.slice(0, 4)), Number(endKey.slice(5, 7)) - 1 - i, 1)); const T = tx.filter((t) => t.txn_date.startsWith(k)); trend.push({ key: k, label: monthLabel(k), inn: sum(T.filter((t) => t.kind === 'revenue')), out: sum(T.filter((t) => t.kind === 'expense' || t.kind === 'capex')) }); }
  return {
    rows: cur, inn, out, net: inn - out, inCount: live.filter((t) => t.kind === 'revenue').length, outCount: live.filter((t) => t.kind === 'expense' || t.kind === 'capex').length,
    outByCat, inByWho, prevKey, prevNet, trend, dupes: cur.filter((t) => t.dupe).length,
    owed: sum(tx.filter((t) => t.kind === 'revenue' && !t.paid)),
    ownerAll: sum(tx.filter((t) => t.kind === 'owner_contribution')) - sum(tx.filter((t) => t.kind === 'owner_draw')),
    spentAll: sum(tx.filter((t) => (t.kind === 'expense' || t.kind === 'capex') && !t.dupe)), earnedAll: sum(tx.filter((t) => t.kind === 'revenue')),
  };
}
function arTotal(rep) { try { const walk = (rows, out) => { for (const r of rows || []) { if (r.Summary) out.push(r.Summary.ColData.map((c) => c.value)); if (r.Rows) walk(r.Rows.Row, out); } return out; }; const t = walk(rep?.Rows?.Row, []).find((r) => /^total$/i.test(r[0])); return t ? Number(t[t.length - 1]) || 0 : null; } catch { return null; } }

/* ---------- donut ---------- */
function Donut({ slices, total }) {
  const R = 54, C = 2 * Math.PI * R; let acc = 0;
  return (
    <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="Breakdown">
      <circle cx="70" cy="70" r={R} fill="none" stroke="#EEF0F3" strokeWidth="22" />
      {slices.map((s, i) => { const f = total ? s.amount / total : 0; const el = <circle key={s.name} cx="70" cy="70" r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="22" strokeDasharray={`${f * C} ${C}`} strokeDashoffset={-acc * C} transform="rotate(-90 70 70)"><title>{s.name}: {money(s.amount)}</title></circle>; acc += f; return el; })}
      <text x="70" y="66" textAnchor="middle" className="dtot">{money(total)}</text>
      <text x="70" y="82" textAnchor="middle" className="dsub">{slices.length} categor{slices.length === 1 ? 'y' : 'ies'}</text>
    </svg>
  );
}

/* ---------- 6-month trend ---------- */
function Trend({ months }) {
  const max = Math.max(1, ...months.map((x) => Math.max(x.inn, x.out)));
  return (
    <>
      <div className="bars">{months.map((x) => (
        <div key={x.key} className="bar-m" title={`${x.label}: in ${money(x.inn)} · out ${money(x.out)}`}>
          <div className="cols"><i className="in" style={{ height: `${(x.inn / max) * 100}%` }} /><i className="out" style={{ height: `${(x.out / max) * 100}%` }} /></div>
          <small>{x.label}</small>
        </div>
      ))}</div>
      <table className="ordertable fin mini"><tbody>
        <tr><td>In</td>{months.map((x) => <td key={x.key} className="n pos">{money(x.inn)}</td>)}</tr>
        <tr><td>Out</td>{months.map((x) => <td key={x.key} className="n">{money(x.out)}</td>)}</tr>
        <tr><td><b>Bottom line</b></td>{months.map((x) => <td key={x.key} className={`n ${x.inn - x.out < 0 ? 'neg' : 'pos'}`}><b>{money(x.inn - x.out)}</b></td>)}</tr>
      </tbody></table>
    </>
  );
}

/* ---------- add / edit one transaction ---------- */
function TxModal({ tx, kind, onClose, onSaved, say }) {
  const isQbo = tx?.source === 'qbo';
  const [f, setF] = useState(tx ? { ...tx } : { txn_date: ymd(new Date()), kind, category: kind === 'revenue' ? 'Services revenue' : kind === 'owner_contribution' ? 'Owner contribution' : kind === 'capex' ? 'Capex (racking, equipment)' : 'Software', counterparty: '', description: '', amount: '', paid: true });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const titles = { expense: 'Add an expense', revenue: 'Add income', owner_contribution: 'Money you put in', capex: 'Equipment purchase' };
  const save = async (e) => {
    e.preventDefault(); if (!f.amount || Number(f.amount) <= 0) return; setBusy(true);
    const row = { txn_date: f.txn_date, kind: f.kind, category: f.category, counterparty: f.counterparty || null, description: f.description || null, amount: Number(f.amount), paid: f.paid !== false };
    const r = tx ? await supabase.from('fin_transactions').update(isQbo ? { category: row.category, kind: row.kind } : row).eq('id', tx.id) : await supabase.from('fin_transactions').insert({ ...row, source: 'manual' });
    setBusy(false); if (r.error) return say({ error: r.error.message }); say(null, tx ? 'Saved.' : 'Added.'); onSaved();
  };
  const del = async () => { if (!window.confirm('Delete this transaction?')) return; await supabase.from('fin_transactions').delete().eq('id', tx.id); onSaved(); };
  const cats = f.kind === 'revenue' ? INCATS : f.kind === 'owner_contribution' ? ['Owner contribution'] : CATS;
  return (
    <div className="overlay" onClick={onClose}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
      <h3>{tx ? (isQbo ? 'QuickBooks transaction' : 'Edit transaction') : titles[kind]}</h3>
      {isQbo && <p className="lead">Pulled from QuickBooks. Change the amount or the date there; here you can only re-categorize it.</p>}
      <div className="addgrid two">
        <label>Amount $<input type="number" step="0.01" min="0" value={f.amount} onChange={set('amount')} autoFocus={!tx} disabled={isQbo} /></label>
        <label>Date<input type="date" value={f.txn_date} onChange={set('txn_date')} disabled={isQbo} /></label>
        <label>Who<input value={f.counterparty || ''} onChange={set('counterparty')} placeholder={f.kind === 'revenue' ? 'Client' : 'Vendor'} disabled={isQbo} /></label>
        <label>Category<select value={cats.includes(f.category) ? f.category : '__custom'} onChange={(e) => setF({ ...f, category: e.target.value === '__custom' ? '' : e.target.value })}>{cats.map((c) => <option key={c}>{c}</option>)}<option value="__custom">Other…</option></select></label>
        {!cats.includes(f.category) && <label>Category name<input value={f.category} onChange={set('category')} /></label>}
        <label className="wide2">What<input value={f.description || ''} onChange={set('description')} placeholder="One line" disabled={isQbo} /></label>
        {tx && f.kind !== 'owner_contribution' && !isQbo && <label>Type<select value={f.kind} onChange={set('kind')}><option value="expense">Expense</option><option value="capex">Equipment</option><option value="revenue">Income</option></select></label>}
        {f.kind === 'revenue' && <label className="chk"><input type="checkbox" checked={f.paid !== false} onChange={set('paid')} /> paid</label>}
      </div>
      <div className="row">{tx && !isQbo && <button type="button" className="btn-xs" onClick={del}>Delete</button>}<div className="spacer" /><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy}>{tx ? 'Save' : 'Add'}</button></div>
    </form></div>
  );
}
