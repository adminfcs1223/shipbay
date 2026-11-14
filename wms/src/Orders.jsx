// Orders → brand → Picklist. Built for a phone held in one hand.
// Orders arrive from each brand's own program through the connector (POST /api/orders); the WMS never fetches them.
// The list is re-read every time it is shown, so a product that moved shows where it is now. The same product across
// orders is one row with the total, rows run in walking order (location code), and anything that can't be picked
// (no location, or not enough on hand) sits at the top so it gets reported instead of searched for.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib';
import { beep } from './parts';
import { demoOrders } from './demo';

const num = (n) => Number(n || 0).toLocaleString('en-US');
const byCode = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const PROBLEM = { missing: 'Not at the location', short: 'Short', other: 'Other problem' };
const shift = (iso, days) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

export default function Orders({ me, startBrand, clearStart }) {
  const [brands, setBrands] = useState(null); const [err, setErr] = useState(null);
  const [brand, setBrand] = useState(null); const [busy, setBusy] = useState(false);
  const load = async () => { const { data, error } = await supabase.rpc('wms_order_brands'); if (error) setErr(error.message); else { setErr(null); setBrands(data || []); } return data || []; };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (startBrand && brands) { const b = brands.find((x) => x.id === startBrand); if (b) setBrand(b); clearStart(); } }, [startBrand, brands]);

  const loadDemo = async () => {
    setBusy(true); setErr(null);
    const problem = await resetDemo();
    setBusy(false); if (problem) return setErr(problem);
    const rows = await load(); const b = rows.find((x) => x.client_code === 'DEMO'); if (b) setBrand(b);
  };

  if (brand) return <Picklist me={me} brand={brand} back={() => { setBrand(null); load(); }} />;
  const due = (brands || []).reduce((s, b) => s + b.due_orders, 0);
  return (
    <>
      <header className="pagehead">
        <h1>Orders<span className="dot">.</span></h1>
        <div className="glance"><div><b className={due ? 'hot' : ''}>{num(due)}</b><small>To ship today</small></div><div><b>{num((brands || []).reduce((s, b) => s + b.ready, 0))}</b><small>Ready to pack</small></div></div>
      </header>
      {err && <div className="strip bad"><span>{err}</span><button onClick={() => { setErr(null); load(); }}>Try again</button></div>}
      {!brands ? <div className="empty">Loading…</div> : (
        <ul className="brandlist">
          {brands.map((b) => (
            <li key={b.id}><button onClick={() => setBrand(b)}>
              <div><b>{b.name}</b><span>{b.open_orders ? `${num(b.open_orders)} open order${b.open_orders === 1 ? '' : 's'}${b.ready ? ` · ${b.ready} ready to pack` : ''}` : b.ready ? `${b.ready} ready to pack` : 'No open orders'}</span></div>
              <div className="r"><b className={b.due_units ? 'hot' : ''}>{num(b.due_units)}</b><span>units to pick today</span></div>
            </button></li>
          ))}
          {!brands.some((b) => b.client_code === 'DEMO') && (
            <li className="demo"><button onClick={loadDemo} disabled={busy}><div><b>Demo Brand</b><span>{busy ? 'Loading sample data…' : 'Load 12 sample products and 8 sample orders to see the whole flow'}</span></div></button></li>
          )}
        </ul>
      )}
    </>
  );
}

// Rebuilds Demo Brand, then sends its orders through the real connector with the key the reset hands back.
async function resetDemo() {
  const { data, error } = await supabase.rpc('wms_demo_reset');
  if (error || !data?.key) return error?.message || 'The demo could not be reset.';
  for (const order of demoOrders(data.today)) {
    let res;
    try { res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.key}` }, body: JSON.stringify(order) }); }
    catch { return 'The orders endpoint could not be reached.'; }
    if (!res.ok) { let m = ''; try { m = (await res.json()).message; } catch { /* no body */ } return `Order ${order.order_number} was refused (${res.status}). ${m || ''}`; }
  }
  return null;
}

function Picklist({ me, brand, back }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(null); const [note, setNote] = useState(null);
  const [day, setDay] = useState(null);       // null = due today or earlier (the default); a date = that day only
  const [all, setAll] = useState(false);
  const [openRow, setOpenRow] = useState(null); const [zoom, setZoom] = useState(null); const [busy, setBusy] = useState(null);
  const [showPicked, setShowPicked] = useState(false); const [showProbs, setShowProbs] = useState(false);
  const [report, setReport] = useState(null);   // the row a problem is being reported on

  const load = async () => {
    const { data: d, error } = await supabase.rpc('wms_picklist', { p_org: brand.id, p_day: day, p_all: all });
    if (error) setErr(error.message); else { setErr(null); setData(d); }
  };
  useEffect(() => { load(); const t = setInterval(load, 45000); const vis = () => { if (!document.hidden) load(); }; document.addEventListener('visibilitychange', vis); return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); }; }, [brand.id, day, all]);

  const { todo, probs, done } = useMemo(() => {
    if (!data) return { todo: [], probs: [], done: [] };
    const stock = new Map();   // sku_id → its locations, the one to pick from first
    for (const s of data.stock) { if (s.on_hand > 0) { if (!stock.has(s.sku_id)) stock.set(s.sku_id, []); stock.get(s.sku_id).push(s); } }
    for (const locs of stock.values()) locs.sort((a, b) => (b.zone === 'open box') - (a.zone === 'open box') || String(a.first_in || '').localeCompare(String(b.first_in || '')) || byCode(a.code, b.code));
    const group = (lines, extra) => {
      const m = new Map();
      for (const l of lines) {
        const k = (l.sku_id || `sku:${l.sku.toLowerCase()}`) + (extra ? extra(l) : '');
        if (!m.has(k)) m.set(k, { key: k, sku: l.sku, sku_id: l.sku_id, name: l.name, image_url: l.image_url, qty: 0, lines: [], notes: [] });
        const g = m.get(k); g.qty += l.qty; g.lines.push(l); if (!g.image_url && l.image_url) g.image_url = l.image_url;
        if (l.notes && !g.notes.some((n) => n.order_number === l.order_number)) g.notes.push({ order_number: l.order_number, text: l.notes });
      }
      return [...m.values()];
    };
    // Every open line is on the list to be picked, whether or not the system knows a location or enough stock for it.
    // What the system has on file is shown beside it; it never blocks the pick. No-location rows come first (nowhere to
    // walk to yet), then walking order by location.
    const withStock = (g) => { const locs = g.sku_id ? stock.get(g.sku_id) || [] : []; return { ...g, locs, onHand: locs.reduce((t, x) => t + x.on_hand, 0) }; };
    const order = (a, b) => (!a.locs.length - !b.locs.length) * -1 || byCode(a.locs[0]?.code || '', b.locs[0]?.code || '') || a.name.localeCompare(b.name);
    const todo = group(data.lines.filter((l) => !l.picked_at && !l.problem)).map(withStock).sort(order);
    // lines someone reported a problem on, one row per product and problem
    const probs = group(data.lines.filter((l) => !l.picked_at && l.problem), (l) => `|${l.problem.kind}|${l.problem.found ?? ''}|${l.problem.note || ''}`).map(withStock).map((g) => ({ ...g, problem: g.lines[0].problem })).sort((a, b) => (b.problem.at > a.problem.at ? 1 : -1));
    const done = group(data.lines.filter((l) => l.picked_at)).map((g) => ({ ...g, from: [...new Set(g.lines.map((l) => l.picked_from).filter(Boolean))].join(', '), who: g.lines[0].picked_by_name, at: g.lines.reduce((t, l) => (l.picked_at > t ? l.picked_at : t), '') }))
      .sort((a, b) => (b.at > a.at ? 1 : -1));
    return { todo, probs, done };
  }, [data]);

  const pick = async (g) => {
    if (busy) return; setBusy(g.key); setNote(null);
    const { data: r, error } = await supabase.rpc('wms_pick', { p_lines: g.lines.map((l) => l.id) });
    setBusy(null);
    if (error) { beep('bad'); return setNote({ kind: 'bad', text: error.message }); }
    beep('ok'); if (navigator.vibrate) navigator.vibrate(30);
    load();
  };
  const undo = async (g) => {
    if (busy) return; setBusy(g.key); setNote(null);
    const { error } = await supabase.rpc('wms_unpick', { p_lines: g.lines.map((l) => l.id) });
    setBusy(null); if (error) { beep('bad'); setNote({ kind: 'bad', text: error.message }); } load();
  };
  const putBack = async (g) => {
    if (busy) return; setBusy(g.key); setNote(null);
    const { error } = await supabase.rpc('wms_resolve_problem', { p_lines: g.lines.map((l) => l.id) });
    setBusy(null); if (error) { beep('bad'); setNote({ kind: 'bad', text: error.message }); } load();
  };
  const reset = async () => { setBusy('reset'); setNote(null); const problem = await resetDemo(); setBusy(null); if (problem) setNote({ kind: 'bad', text: problem }); else setNote({ kind: 'ok', text: 'Demo data reset.' }); setDay(null); setAll(false); load(); };

  const today = data?.today; const unitsLeft = todo.reduce((s, g) => s + g.qty, 0);
  const viewing = all ? 'All open orders' : day ? (day === today ? 'Due today only' : fmtDate(day)) : 'Due today';
  return (
    <>
      <header className="pagehead pick">
        <div><button className="back" onClick={back}>‹ Orders</button><h1>{brand.name}<span className="dot">.</span></h1></div>
        <div className="glance"><div><b className={unitsLeft ? 'hot' : ''}>{num(unitsLeft)}</b><small>Units to pick</small></div><div><b>{num(todo.length)}</b><small>Stops</small></div><div><b className={probs.length ? 'hot' : ''}>{num(probs.length)}</b><small>Problems</small></div></div>
      </header>

      <div className="daybar">
        <button className={!day && !all ? 'on' : ''} onClick={() => { setDay(null); setAll(false); }}>Due today</button>
        <label className={day && !all ? 'on' : ''}><span>{day && !all ? fmtDate(day) : 'Another day'}</span><input type="date" value={day || ''} onChange={(e) => { setDay(e.target.value || null); setAll(false); }} aria-label="Ship-by date" /></label>
        {today && <button className={day === shift(today, 1) && !all ? 'on' : ''} onClick={() => { setDay(shift(today, 1)); setAll(false); }}>Tomorrow</button>}
        <button className={all ? 'on' : ''} onClick={() => setAll(true)}>All open</button>
      </div>

      {err && <div className="strip bad"><span>{err}</span><button onClick={load}>Try again</button></div>}
      {note && <div className={`strip ${note.kind}`}><span>{note.text}</span><button className="x" onClick={() => setNote(null)} aria-label="Dismiss">×</button></div>}

      {data?.ready?.length > 0 && (
        <section className="ready">
          <h3>Ready to pack <span>{data.ready.length}</span></h3>
          <ul>{data.ready.map((o) => <li key={o.order_number} className="code">{o.order_number}</li>)}</ul>
        </section>
      )}

      <h2 className="sect">To pick <span>{todo.length ? `${viewing} · ${num(unitsLeft)} unit${unitsLeft === 1 ? '' : 's'}` : viewing}</span></h2>
      {data && todo.length > 0 && <div className="phead"><span /><span>Item</span><span>Qty</span><span>Location</span><span>Done</span></div>}
      {!data ? <div className="empty">Loading…</div> : todo.length === 0 ? <div className="empty panel">{done.length ? 'Everything in this view is picked.' : 'Nothing to pick in this view.'}</div> : (
        <ul className="prows">{todo.map((g) => (
          <li key={g.key}>
            <div className="prow">
              <button className="pthumb" onClick={() => g.image_url && setZoom(g)} aria-label={g.image_url ? `Enlarge ${g.name}` : undefined} disabled={!g.image_url}>
                {g.image_url ? <img src={g.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : null}
              </button>
              <button className="pwhat" onClick={() => setOpenRow(openRow === g.key ? null : g.key)} aria-expanded={openRow === g.key}>
                <b>{g.name}</b>
                <span className="code">{g.sku}</span>
                {g.notes.map((n) => <em key={n.order_number}>{n.text}</em>)}
              </button>
              <div className="pq"><b>{num(g.qty)}</b>{g.lines.length > 1 && <span>{g.lines.length} orders</span>}</div>
              <div className={`pl ${g.locs.length ? '' : 'none'}`}>
                <b>{g.locs.length ? g.locs[0].code : 'No location'}</b>
                {g.locs.length > 0 && g.onHand < g.qty && <span>{num(g.onHand)} on file</span>}
                {g.locs.length > 1 && g.onHand >= g.qty && <span>also {g.locs.slice(1).map((x) => x.code).join(', ')}</span>}
              </div>
              <button className="pcheck" onClick={() => pick(g)} disabled={!!busy} aria-label={`Picked ${g.qty} ${g.name}`}>{busy === g.key ? '…' : ''}</button>
            </div>
            <button className="pprob" onClick={() => setReport(g)}>Problem?</button>
            {openRow === g.key && <ul className="breakdown">{g.lines.map((l) => <li key={l.id}><span className="code">{l.order_number}</span><span>{l.ship_by ? (l.ship_by < today ? 'Late · ' : '') + fmtDate(l.ship_by) : 'No date'}</span><b>{num(l.qty)}</b></li>)}</ul>}
          </li>
        ))}</ul>
      )}

      <button className="sect toggle" onClick={() => setShowProbs((v) => !v)} aria-expanded={showProbs}>Problems <span className={probs.length ? 'hot' : ''}>{probs.length} <i>{showProbs ? '▴' : '▾'}</i></span></button>
      {showProbs && (probs.length === 0 ? <div className="empty panel">No problems reported in this view.</div> : (
        <ul className="prows probs">{probs.map((g) => (
          <li key={g.key}>
            <div className="prow">
              <div className="pthumb">{g.image_url ? <img src={g.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : null}</div>
              <div className="pwhat"><b>{g.name}</b><span className="code">{g.sku}</span>
                <em>{PROBLEM[g.problem.kind]}{g.problem.kind === 'short' ? `: ${num(g.problem.found)} there` : ''}{g.problem.note ? ` · ${g.problem.note}` : ''}</em>
                <span>{g.problem.by || 'Someone'} · {new Date(g.problem.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · {g.lines.map((l) => l.order_number).join(', ')}</span></div>
              <div className="pq"><b>{num(g.qty)}</b></div>
              <div className={`pl ${g.problem.location || g.locs.length ? '' : 'none'}`}><b>{g.problem.location || g.locs[0]?.code || 'No location'}</b></div>
              <button className="undo" onClick={() => putBack(g)} disabled={!!busy}>{busy === g.key ? '…' : 'Back to list'}</button>
            </div>
          </li>
        ))}</ul>
      ))}

      <button className="sect toggle" onClick={() => setShowPicked((v) => !v)} aria-expanded={showPicked}>Picked <span>{done.length} <i>{showPicked ? '▴' : '▾'}</i></span></button>
      {showPicked && (done.length === 0 ? <div className="empty panel">Nothing picked in this view yet.</div> : (
        <ul className="prows done">{done.map((g) => (
          <li key={g.key}>
            <div className="prow">
              <div className="pthumb">{g.image_url ? <img src={g.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : null}</div>
              <div className="pwhat"><b>{g.name}</b><span className="code">{g.sku}</span><span>{g.who || 'Someone'} · {new Date(g.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span></div>
              <div className="pq"><b>{num(g.qty)}</b></div>
              <div className="pl"><b>{g.from || '—'}</b></div>
              <button className="undo" onClick={() => undo(g)} disabled={!!busy}>{busy === g.key ? '…' : 'Undo'}</button>
            </div>
          </li>
        ))}</ul>
      ))}

      {brand.client_code === 'DEMO' && <button className="btn reset" onClick={reset} disabled={busy === 'reset'}>{busy === 'reset' ? 'Resetting…' : 'Reset demo data'}</button>}

      {report && <ReportProblem row={report} onClose={() => setReport(null)} onDone={() => { setReport(null); setShowProbs(true); load(); }} />}
      {zoom && (
        <div className="overlay" onClick={() => setZoom(null)}>
          <div className="zoom" role="dialog" aria-label={zoom.name}><img src={zoom.image_url} alt={zoom.name} /><b>{zoom.name}</b><span className="code">{zoom.sku}</span></div>
        </div>
      )}
    </>
  );
}

// Report a problem on a row: not at the location, short (with how many are there), or anything else in a few words.
// The row moves to Problems until someone puts it back on the list.
function ReportProblem({ row, onClose, onDone }) {
  const [kind, setKind] = useState(null); const [found, setFound] = useState(''); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const ok = kind === 'missing' || (kind === 'short' && found !== '' && Number(found) >= 0) || (kind === 'other' && note.trim());
  const send = async () => {
    if (!ok || busy) return; setBusy(true); setErr(null);
    const { error } = await supabase.rpc('wms_report_problem', { p_lines: row.lines.map((l) => l.id), p_kind: kind, p_found: kind === 'short' ? Math.round(Number(found)) : null, p_note: note.trim() || null, p_location: row.locs[0]?.code || null });
    setBusy(false); if (error) return setErr(error.message); onDone();
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog probdlg" role="dialog" aria-label="Report a problem" onClick={(e) => e.stopPropagation()}>
        <h2>Problem<span className="dot">.</span></h2>
        <p className="lead">{row.name} · {num(row.qty)} to pick{row.locs[0] ? ` · ${row.locs[0].code}` : ''}</p>
        <div className="kinds">
          {[['missing', 'Not at the location'], ['short', 'Short'], ['other', 'Something else']].map(([k, t]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{t}</button>)}
        </div>
        {kind === 'short' && <label className="pf">How many are there?<input type="number" min="0" inputMode="numeric" value={found} onChange={(e) => setFound(e.target.value)} autoFocus /></label>}
        {kind && <label className="pf">{kind === 'other' ? 'What is the problem?' : <>Note <em>optional</em></>}<textarea rows="2" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={kind === 'other'} /></label>}
        {err && <div className="strip bad"><span>{err}</span></div>}
        <div className="dlgbtns"><button className="btn" onClick={onClose}>Cancel</button><button className="btn big" disabled={!ok || busy} onClick={send}>{busy ? 'Sending…' : 'Report it'}</button></div>
      </div>
    </div>
  );
}
