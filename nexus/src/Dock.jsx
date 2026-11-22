// Nexus dock: put-away (scan the pallet, scan the position) and the inbound calendar (book a shipment with its items).
// Shared warehouse controls live here, not in any one WMS.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, num, stamp } from './lib.js';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

export function Putaway() {
  const [psku, setPsku] = useState(''); const [pal, setPal] = useState(null); const [loc, setLoc] = useState('');
  const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false); const [wait, setWait] = useState(null); const [log, setLog] = useState([]);
  const a = useRef(null); const b = useRef(null);
  const load = () => supabase.rpc('nexus_pallets', { p_org: null, p_q: null }).then(({ data }) => setWait((data || []).filter((r) => r.status === 'open' || r.status === 'counted')));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  useEffect(() => { (pal ? b : a).current?.focus(); }, [pal]);
  const scanPallet = (e) => {
    e.preventDefault(); const code = psku.trim().toUpperCase().split('-C')[0]; if (!code) return;
    const p = (wait || []).find((r) => r.psku.toUpperCase() === code);
    if (!p) return setMsg({ kind: 'bad', text: `${code} is not waiting for put-away.` });
    if (p.held) return setMsg({ kind: 'bad', text: `${p.psku} is on HOLD. An admin must release it first.` });
    setMsg(null); setPal(p); setLoc('');
  };
  const scanLoc = async (e) => {
    e.preventDefault(); if (!loc.trim() || busy) return; setBusy(true);
    const { data, error } = await supabase.rpc('nexus_putaway', { p_psku: pal.psku, p_location: loc.trim() }); setBusy(false);
    if (error) { setLoc(''); return setMsg({ kind: 'bad', text: error.message }); }
    setLog((l) => [{ ...data, at: new Date().toISOString(), item: pal.item_name, brand: pal.org_name }, ...l].slice(0, 12));
    setMsg({ kind: 'ok', text: `${data.psku} is in ${data.location}. ${num(data.units_posted)} units are now in stock.` }); setPal(null); setPsku(''); setLoc(''); load();
  };
  const ready = (wait || []).filter((r) => !r.held); const held = (wait || []).filter((r) => r.held);
  return (
    <>
      <div className="head"><h1>Put-away</h1><div className="glance"><div><b className={ready.length ? 'hot' : ''}>{num(ready.length)}</b><small>Waiting</small></div><div><b>{num(held.length)}</b><small>On hold</small></div></div></div>
      {msg && <div className={`strip ${msg.kind}`} data-testid="putaway-msg">{msg.text}</div>}
      <div className="scanflow">
        <form onSubmit={scanPallet} className={pal ? 'done' : 'now'}><span>1</span><label>Scan the pallet label<input ref={a} data-testid="scan-pallet" value={pal ? pal.psku : psku} disabled={!!pal} onChange={(e) => setPsku(e.target.value)} placeholder="PSKU…" autoComplete="off" /></label>
          {pal && <div className="what"><b>{pal.org_name}</b> · {pal.item_name || 'Mixed pallet'} · {pal.cartons ?? '—'} cartons{pal.units_total ? ` · ${num(pal.units_total)} units` : ''} <button type="button" className="btn sm" onClick={() => { setPal(null); setPsku(''); }}>Change</button></div>}</form>
        <form onSubmit={scanLoc} className={pal ? 'now' : 'off'}><span>2</span><label>Scan the position label<input ref={b} data-testid="scan-position" value={loc} disabled={!pal || busy} onChange={(e) => setLoc(e.target.value)} placeholder="P-01…" autoComplete="off" /></label></form>
      </div>
      <section><h2>Waiting for a position</h2>
        <table data-testid="putaway-table"><thead><tr><th>Pallet</th><th>Brand</th><th>Item</th><th className="n">Cartons</th><th className="n">Units</th><th>Received</th><th /></tr></thead>
          <tbody>{(wait || []).map((r) => <tr key={r.id}><td className="code">{r.psku}</td><td>{r.org_name}</td><td>{r.item_name}</td><td className="n">{r.cartons ?? '—'}</td><td className="n">{r.units_total ? num(r.units_total) : '—'}</td><td>{stamp(r.received_at)}</td>
            <td>{r.held ? <span className="pill held">On hold</span> : <button className="btn sm" onClick={() => { setMsg(null); setPal(r); setLoc(''); }}>Put away</button>}</td></tr>)}</tbody></table>
        {wait && wait.length === 0 && <div className="empty">Nothing is waiting. Every received pallet has a position.</div>}
      </section>
      {log.length > 0 && <section><h2>Put away this session</h2><table><tbody>{log.map((l) => <tr key={l.psku}><td className="code">{l.psku}</td><td>{l.brand}</td><td>{l.item}</td><td className="code">{l.location}</td><td className="n">{num(l.units_posted)} units</td><td>{stamp(l.at)}</td></tr>)}</tbody></table></section>}
    </>
  );
}

export function Calendar({ me }) {
  const [month, setMonth] = useState(() => monthStart(new Date())); const [rows, setRows] = useState(null); const [err, setErr] = useState(null); const [form, setForm] = useState(null); const [sel, setSel] = useState(null);
  const cells = useMemo(() => { const s = new Date(month); s.setDate(1 - s.getDay()); return Array.from({ length: 42 }, (_, i) => { const d = new Date(s); d.setDate(s.getDate() + i); return d; }); }, [month]);
  const load = () => supabase.rpc('nexus_shipments', { p_from: iso(cells[0]), p_to: iso(cells[41]) }).then(({ data, error }) => { setErr(error?.message || null); if (!error) setRows(data || []); });
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [month]);
  const by = useMemo(() => { const m = {}; (rows || []).forEach((r) => { (m[r.expected_at] = m[r.expected_at] || []).push(r); }); return m; }, [rows]);
  const canBook = ['shipbay_admin', 'shipbay_staff'].includes(me.role); const today = iso(new Date());
  const state = (r) => (r.closed ? 'done' : r.received_pallets > 0 ? 'part' : !r.approved ? 'wait' : 'due');
  const shift = (n) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  return (
    <>
      <div className="head"><h1>Calendar</h1><div className="calnav"><button className="btn sm" onClick={() => shift(-1)}>‹</button><b>{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</b><button className="btn sm" onClick={() => shift(1)}>›</button>
        {canBook && <button className="btn primary" data-testid="new-shipment" onClick={() => setForm({ date: today })}>New inbound shipment</button>}</div></div>
      {err && <div className="strip bad">{err}</div>}
      {form && <ShipmentForm start={form.date} close={(saved) => { setForm(null); if (saved) load(); }} />}
      <div className="cal" data-testid="calendar">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="dow">{d}</div>)}
        {cells.map((d) => { const k = iso(d); return (
          <div key={k} className={`day ${d.getMonth() !== month.getMonth() ? 'out' : ''} ${k === today ? 'today' : ''}`} onDoubleClick={() => canBook && setForm({ date: k })}>
            <i>{d.getDate()}</i>
            {(by[k] || []).map((r) => <button key={r.id} className={`ship ${state(r)}`} onClick={() => setSel(r)} title={r.reference}><b>{r.brand}</b><span>{r.received_pallets}/{r.pallets} pallets</span></button>)}
          </div>); })}
      </div>
      <div className="legend"><span className="ship due">Expected</span><span className="ship part">Partly received</span><span className="ship done">Closed</span><span className="ship wait">Waiting for approval</span></div>
      {sel && <section data-testid="shipment-detail"><h2>{sel.brand} · {sel.reference}</h2>
        <p className="sm">{new Date(sel.expected_at + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}{sel.origin ? ` · from ${sel.origin}` : ''} · {sel.received_pallets} of {sel.pallets} pallets received{sel.cartons ? ` · ${num(sel.cartons)} cartons expected` : ''}</p>
        {sel.notes && <p className="sm">{sel.notes}</p>}
        {sel.lines.length ? <table><thead><tr><th>SKU</th><th>Item</th><th className="n">Units expected</th></tr></thead><tbody>{sel.lines.map((l) => <tr key={l.sku}><td className="code">{l.sku}</td><td>{l.name}</td><td className="n">{num(l.qty)}</td></tr>)}</tbody></table> : <div className="empty">No items were entered for this shipment.</div>}
        <button className="btn sm" onClick={() => setSel(null)}>Close</button></section>}
    </>
  );
}

function ShipmentForm({ start, close }) {
  const [brands, setBrands] = useState([]); const [skus, setSkus] = useState([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const [f, setF] = useState({ org: '', reference: '', origin: '', expected: start, pallets: '', cartons: '', notes: '' }); const [lines, setLines] = useState([{ sku_id: '', qty: '' }]);
  useEffect(() => { supabase.rpc('nexus_brands').then(({ data }) => setBrands(data || [])); }, []);
  useEffect(() => { setSkus([]); setLines([{ sku_id: '', qty: '' }]); if (f.org) supabase.rpc('nexus_brand_skus', { p_org: f.org }).then(({ data }) => setSkus(data || [])); }, [f.org]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setLine = (i, p) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const save = async (e) => {
    e.preventDefault(); setErr(null); const ls = lines.filter((l) => l.sku_id);
    if (ls.some((l) => !(Number(l.qty) > 0))) return setErr('Each item needs its expected units.');
    setBusy(true);
    const { error } = await supabase.rpc('nexus_shipment_create', { p_org: f.org || null, p_reference: f.reference, p_origin: f.origin, p_expected: f.expected || null, p_pallets: Number(f.pallets) || 0, p_cartons: Number(f.cartons) || 0, p_notes: f.notes, p_lines: ls.map((l) => ({ sku_id: l.sku_id, qty: Number(l.qty) })) });
    setBusy(false); if (error) return setErr(error.message); close(true);
  };
  return (
    <form className="shipform" onSubmit={save} data-testid="shipment-form">
      <h2>New inbound shipment</h2>
      {err && <div className="strip bad">{err}</div>}
      <div className="fields">
        <label>Brand<select value={f.org} onChange={set('org')} required><option value="">Choose…</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label>Reference (PO, BOL or shipment no.)<input value={f.reference} onChange={set('reference')} required /></label>
        <label>Coming from<input value={f.origin} onChange={set('origin')} /></label>
        <label>Expected on<input type="date" value={f.expected} onChange={set('expected')} required /></label>
        <label>Pallets<input type="number" min="1" max="200" value={f.pallets} onChange={set('pallets')} required /></label>
        <label>Cartons (if known)<input type="number" min="0" value={f.cartons} onChange={set('cartons')} /></label>
      </div>
      <h3>What is on it</h3>
      {!f.org ? <div className="empty">Choose the brand to list its items.</div> : skus.length === 0 ? <div className="empty">This brand has no items on file yet.</div> : lines.map((l, i) => (
        <div className="lineitem" key={i}>
          <select aria-label="Item" value={l.sku_id} onChange={(e) => setLine(i, { sku_id: e.target.value })}><option value="">Item…</option>{skus.filter((s) => s.id === l.sku_id || !lines.some((x) => x.sku_id === s.id)).map((s) => <option key={s.id} value={s.id}>{s.sku} · {s.name}</option>)}</select>
          <input aria-label="Units expected" type="number" min="1" placeholder="Units expected" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
          {lines.length > 1 && <button type="button" className="btn sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button>}
        </div>))}
      {f.org && skus.length > lines.length && <button type="button" className="btn sm" onClick={() => setLines((ls) => [...ls, { sku_id: '', qty: '' }])}>Add another item</button>}
      <label className="wide">Notes<input value={f.notes} onChange={set('notes')} /></label>
      <div className="actions"><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Book it'}</button><button type="button" className="btn" onClick={() => close(false)}>Cancel</button></div>
    </form>
  );
}
