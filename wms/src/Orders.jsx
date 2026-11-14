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
  const [showPicked, setShowPicked] = useState(false);

  const load = async () => {
    const { data: d, error } = await supabase.rpc('wms_picklist', { p_org: brand.id, p_day: day, p_all: all });
    if (error) setErr(error.message); else { setErr(null); setData(d); }
  };
  useEffect(() => { load(); const t = setInterval(load, 45000); const vis = () => { if (!document.hidden) load(); }; document.addEventListener('visibilitychange', vis); return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); }; }, [brand.id, day, all]);

  const { todo, done } = useMemo(() => {
    if (!data) return { todo: [], done: [] };
    const stock = new Map();   // sku_id → its locations, the one to pick from first
    for (const s of data.stock) { if (s.on_hand > 0) { if (!stock.has(s.sku_id)) stock.set(s.sku_id, []); stock.get(s.sku_id).push(s); } }
    for (const locs of stock.values()) locs.sort((a, b) => (b.zone === 'open box') - (a.zone === 'open box') || String(a.first_in || '').localeCompare(String(b.first_in || '')) || byCode(a.code, b.code));
    const group = (lines) => {
      const m = new Map();
      for (const l of lines) {
        const k = l.sku_id || `sku:${l.sku.toLowerCase()}`;
        if (!m.has(k)) m.set(k, { key: k, sku: l.sku, sku_id: l.sku_id, name: l.name, image_url: l.image_url, qty: 0, lines: [], notes: [] });
        const g = m.get(k); g.qty += l.qty; g.lines.push(l); if (!g.image_url && l.image_url) g.image_url = l.image_url;
        if (l.notes && !g.notes.some((n) => n.order_number === l.order_number)) g.notes.push({ order_number: l.order_number, text: l.notes });
      }
      return [...m.values()];
    };
    const todo = group(data.lines.filter((l) => !l.picked_at)).map((g) => {
      const locs = g.sku_id ? stock.get(g.sku_id) || [] : []; const onHand = locs.reduce((s, x) => s + x.on_hand, 0);
      return { ...g, locs, onHand, flag: !locs.length ? 'No location' : onHand < g.qty ? 'Short' : null };
    }).sort((a, b) => (!!b.flag - !!a.flag) || byCode(a.locs[0]?.code || '', b.locs[0]?.code || '') || a.name.localeCompare(b.name));
    const done = group(data.lines.filter((l) => l.picked_at)).map((g) => ({ ...g, from: [...new Set(g.lines.map((l) => l.picked_from).filter(Boolean))].join(', '), who: g.lines[0].picked_by_name, at: g.lines.reduce((t, l) => (l.picked_at > t ? l.picked_at : t), '') }))
      .sort((a, b) => (b.at > a.at ? 1 : -1));
    return { todo, done };
  }, [data]);

  const pick = async (g) => {
    if (busy) return; setBusy(g.key); setNote(null);
    const { data: r, error } = await supabase.rpc('wms_pick', { p_lines: g.lines.map((l) => l.id) });
    setBusy(null);
    if (error) { beep('bad'); return setNote({ kind: 'bad', text: error.message }); }
    if (r.not_picked?.length) { beep('bad'); setNote({ kind: 'bad', text: `${g.name}: ${r.picked ? `${r.picked} of ${g.lines.length} orders picked. ` : ''}${r.not_picked[0].why === 'Short' ? `Short. Only ${r.not_picked[0].on_hand} left. Report it.` : 'No location. Report it.'}` }); }
    else { beep('ok'); if (navigator.vibrate) navigator.vibrate(30); }
    load();
  };
  const undo = async (g) => {
    if (busy) return; setBusy(g.key); setNote(null);
    const { error } = await supabase.rpc('wms_unpick', { p_lines: g.lines.map((l) => l.id) });
    setBusy(null); if (error) { beep('bad'); setNote({ kind: 'bad', text: error.message }); } load();
  };
  const reset = async () => { setBusy('reset'); setNote(null); const problem = await resetDemo(); setBusy(null); if (problem) setNote({ kind: 'bad', text: problem }); else setNote({ kind: 'ok', text: 'Demo data reset.' }); setDay(null); setAll(false); load(); };

  const today = data?.today; const unitsLeft = todo.reduce((s, g) => s + g.qty, 0);
  const viewing = all ? 'All open orders' : day ? (day === today ? 'Due today only' : fmtDate(day)) : 'Due today';
  return (
    <>
      <header className="pagehead pick">
        <div><button className="back" onClick={back}>‹ Orders</button><h1>{brand.name}<span className="dot">.</span></h1></div>
        <div className="glance"><div><b className={unitsLeft ? 'hot' : ''}>{num(unitsLeft)}</b><small>Units to pick</small></div><div><b>{num(todo.length)}</b><small>Stops</small></div></div>
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
      {!data ? <div className="empty">Loading…</div> : todo.length === 0 ? <div className="empty panel">{done.length ? 'Everything in this view is picked.' : 'Nothing to pick in this view.'}</div> : (
        <ul className="picks">{todo.map((g) => (
          <li key={g.key} className={g.flag ? 'flagged' : ''}>
            <div className="pickmain">
              <button className="pimg" onClick={() => g.image_url && setZoom(g)} aria-label={g.image_url ? `Enlarge ${g.name}` : undefined} disabled={!g.image_url}>
                {g.image_url ? <img src={g.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : null}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8" /></svg>
              </button>
              <div className="pname"><b>{g.name}</b><span className="code">{g.sku}</span></div>
            </div>
            <div className="pnums">
              <div className="pqty"><small>Pick</small><b>{num(g.qty)}</b></div>
              <div className="ploc"><small>{g.flag ? 'Problem' : 'Location'}</small>
                {g.flag ? <b className="flag">{g.flag}</b> : <b>{g.locs[0].code}</b>}
                {g.flag === 'Short' && <span>{num(g.onHand)} on hand at {g.locs.map((x) => x.code).join(', ')}</span>}
                {g.flag === 'No location' && <span>Don’t search. Report it.</span>}
                {!g.flag && <span>{num(g.locs[0].on_hand)} here{g.locs.length > 1 ? ` · also ${g.locs.slice(1).map((x) => `${x.code} (${num(x.on_hand)})`).join(', ')}` : ''}</span>}
              </div>
            </div>
            {g.notes.map((n) => <p className="pnote" key={n.order_number}><b>Note</b> {n.text} <span className="code">{n.order_number}</span></p>)}
            <button className="orders" onClick={() => setOpenRow(openRow === g.key ? null : g.key)} aria-expanded={openRow === g.key}>{g.lines.length} order{g.lines.length === 1 ? '' : 's'} <i>{openRow === g.key ? '▴' : '▾'}</i></button>
            {openRow === g.key && <ul className="breakdown">{g.lines.map((l) => <li key={l.id}><span className="code">{l.order_number}</span><span>{l.ship_by ? (l.ship_by < today ? 'Late · ' : '') + fmtDate(l.ship_by) : 'No date'}</span><b>{num(l.qty)}</b></li>)}</ul>}
            <button className="pickbtn" onClick={() => pick(g)} disabled={!!busy || g.flag === 'No location'}>
              <i aria-hidden="true" />{busy === g.key ? 'Saving…' : g.flag === 'No location' ? 'Can’t pick: no location' : `Picked ${num(g.qty)}`}
            </button>
          </li>
        ))}</ul>
      )}

      <button className="sect toggle" onClick={() => setShowPicked((v) => !v)} aria-expanded={showPicked}>Picked <span>{done.length} <i>{showPicked ? '▴' : '▾'}</i></span></button>
      {showPicked && (done.length === 0 ? <div className="empty panel">Nothing picked in this view yet.</div> : (
        <ul className="picks done">{done.map((g) => (
          <li key={g.key}>
            <div className="pickmain">
              <div className="pimg">{g.image_url ? <img src={g.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : null}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8" /></svg></div>
              <div className="pname"><b>{g.name}</b><span className="code">{g.sku}</span><span>{num(g.qty)} from {g.from || '—'} · {g.who || 'Someone'} · {new Date(g.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span></div>
            </div>
            <button className="undo" onClick={() => undo(g)} disabled={!!busy}>{busy === g.key ? 'Undoing…' : 'Undo'}</button>
          </li>
        ))}</ul>
      ))}

      {brand.client_code === 'DEMO' && <button className="btn reset" onClick={reset} disabled={busy === 'reset'}>{busy === 'reset' ? 'Resetting…' : 'Reset demo data'}</button>}

      {zoom && (
        <div className="overlay" onClick={() => setZoom(null)}>
          <div className="zoom" role="dialog" aria-label={zoom.name}><img src={zoom.image_url} alt={zoom.name} /><b>{zoom.name}</b><span className="code">{zoom.sku}</span></div>
        </div>
      )}
    </>
  );
}
