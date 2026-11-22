// The WMS home screen: a greeting, what has to go out and what is on the floor, then the shipment calendar (what is
// expected in, on which day, how much). Shipments are the deliveries brands book in their portal; they appear here once ShipBay has approved them.
// Orders come from each brand's connector. Read fresh every minute.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib';
import { ENABLED as CALENDAR } from './nexusSource.js';

const num = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, w, ws) => `${num(n)} ${Number(n) === 1 ? w : ws || `${w}s`}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const at = (s) => new Date(`${s}T12:00:00`);
const longDay = (s) => at(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const amount = (rows) => { const p = rows.reduce((t, r) => t + Number(r.pallets || 0), 0); const c = rows.reduce((t, r) => t + Number(r.cartons || 0), 0); return [p ? plural(p, 'pallet') : null, c ? plural(c, 'carton') : null].filter(Boolean).join(' · ') || plural(rows.length, 'shipment'); };

export default function Today({ me, go, openBrand }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(null); const [sel, setSel] = useState(null);
  const load = async () => { const { data, error } = await supabase.rpc('wms_today'); if (error) setErr(error.message); else { setErr(null); setD(data); } };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  const first = (me?.full_name || '').trim().split(/\s+/)[0] || 'there';

  const today = d?.today;
  // five weeks, starting on the Sunday of this week
  const days = useMemo(() => {
    if (!today) return [];
    const start = at(today); start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 35 }, (_, i) => { const x = new Date(start); x.setDate(start.getDate() + i); return iso(x); });
  }, [today]);
  // a shipment that is overdue shows on today
  const byDay = useMemo(() => { const m = new Map(); for (const i of d?.inbound || []) { const k = i.expected_at && i.expected_at < today ? today : i.expected_at; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(i); } return m; }, [d, today]);

  if (!d) return (<><header className="pagehead"><h1>Hello, {first}<span className="dot">.</span></h1></header>{err ? <div className="strip bad"><b>Can’t load the schedule.</b><span>{err}</span><button onClick={load}>Try again</button></div> : <div className="empty">Loading…</div>}</>);

  const due = (o) => !o.ship_by || o.ship_by <= today;
  const outToday = d.orders.filter(due);
  const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const inToday = byDay.get(today) || [];
  const ordersOut = sum(outToday, 'orders'); const unitsLeft = sum(outToday, 'units') - sum(outToday, 'picked_units'); const ready = sum(d.orders, 'ready');
  const brands = [...outToday.reduce((m, o) => { const r = m.get(o.org_id) || { org_id: o.org_id, brand: o.brand, orders: 0, units: 0, picked_units: 0, ready: 0, late: 0 }; r.orders += o.orders; r.units += o.units; r.picked_units += o.picked_units; r.ready += o.ready; if (o.ship_by && o.ship_by < today) r.late += o.orders - o.ready; m.set(o.org_id, r); return m; }, new Map()).values()];
  const undated = d.inbound.filter((i) => !i.expected_at);
  const shown = sel || today; const list = byDay.get(shown) || [];

  return (
    <>
      <header className="pagehead">
        <div><h1>Hello, {first}<span className="dot">.</span></h1><p className="when">{longDay(today)}</p></div>
        <div className="glance">
          <div><b>{num(inToday.length)}</b><small>{inToday.length === 1 ? 'Shipment today' : 'Shipments today'}</small></div>
          <div><b>{num(ordersOut)}</b><small>Orders to ship</small></div>
          <div><b className={unitsLeft ? 'hot' : ''}>{num(unitsLeft)}</b><small>Units to pick</small></div>
          <div><b>{num(ready)}</b><small>Ready to pack</small></div>
        </div>
      </header>
      {err && <div className="strip bad"><b>Not refreshed.</b><span>{err}</span><button onClick={load}>Try again</button></div>}

      <div className="today">
        <section className="panel">
          <header className="panelhead"><h3>Going out today</h3><span>{ordersOut ? `${plural(ordersOut, 'order')} · ${plural(sum(outToday, 'units'), 'unit')}` : 'No orders due today'}</span></header>
          {brands.length > 0 && <ul className="rows">{brands.map((b) => {
            const pct = b.units ? Math.round((b.picked_units / b.units) * 100) : 0;
            return (
              <li key={b.org_id} className="tap" onClick={() => openBrand(b.org_id)}>
                <div><b>{b.brand}</b><span>{plural(b.orders, 'order')}{b.late > 0 ? <em className="late"> · {b.late} late</em> : null}{b.ready ? ` · ${b.ready} ready to pack` : ''}</span><i className="bar"><i style={{ width: `${pct}%` }} /></i></div>
                <div className="r"><b>{num(b.units - b.picked_units)}</b><span>units to pick</span></div>
              </li>);
          })}</ul>}
          <div className="floor">
            <div><b>{num(d.picked_today)}</b><small>Units picked today</small></div>
            <div><b>{num(ready)}</b><small>Ready to pack</small></div>
            <div><b className={d.problems ? 'hot' : ''}>{num(d.problems)}</b><small>Problems open</small></div>
          </div>
          <button className="btn big" onClick={() => go('orders')}>Open the pick lists</button>
        </section>

        <section className="panel">
          <header className="panelhead"><h3>On the floor</h3><span>Pallets</span></header>
          <div className="floor">
            <button onClick={() => go('receive')}><b>{num(d.pallets.received_today)}</b><small>Received today</small></button>
            <button onClick={() => go('pallets')}><b className={d.pallets.to_scan ? 'hot' : ''}>{num(d.pallets.to_scan)}</b><small>Cartons to scan in</small></button>
            <button onClick={() => go('pallets')}><b className={d.pallets.to_put_away ? 'hot' : ''}>{num(d.pallets.to_put_away)}</b><small>To put away</small></button>
          </div>
          <button className="btn big go" onClick={() => go('receive')}>Receive a pallet</button>
        </section>
      </div>

      <section className="panel">
        <header className="panelhead"><h3>Shipments expected</h3>{CALENDAR && <button className="btn sm" onClick={() => go('calendar')}>Open the shared calendar</button>}<span>{d.inbound.length ? `${plural(d.inbound.length, 'shipment')} in the next 5 weeks` : 'Nothing booked in the next 5 weeks'}</span></header>
        <div className="cal" role="grid" aria-label="Shipments expected by day">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => <div key={w} className="calhead">{w}</div>)}
          {days.map((day) => {
            const rows = byDay.get(day) || []; const dt = at(day); const pallets = rows.reduce((t, r) => t + Number(r.pallets || 0), 0);
            return (
              <button key={day} role="gridcell" className={`calday ${day === today ? 'today' : ''} ${day < today ? 'past' : ''} ${rows.length ? 'has' : ''} ${day === shown ? 'sel' : ''}`} onClick={() => setSel(day)} aria-label={`${longDay(day)}: ${rows.length ? amount(rows) : 'nothing expected'}`}>
                <span className="dnum">{dt.getDate() === 1 || day === days[0] ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : dt.getDate()}</span>
                {rows.length > 0 && <b>{pallets || rows.length}<i>{pallets ? (pallets === 1 ? ' pallet' : ' pallets') : rows.length === 1 ? ' shipment' : ' shipments'}</i></b>}
                {rows.length > 0 && <em>{[...new Set(rows.map((r) => r.brand))].join(', ')}</em>}
              </button>);
          })}
        </div>
        <div className="calday-detail">
          <h4>{shown === today ? 'Today' : longDay(shown)}<span>{list.length ? amount(list) : 'Nothing expected'}</span></h4>
          {list.length > 0 && <ul className="rows">{list.map((i) => (
            <li key={i.id}>
              <div><b>{i.brand}</b><span>{[i.reference, i.carrier, i.notes].filter(Boolean).join(' · ') || 'No details given'}</span></div>
              <div className="r"><b>{i.pallets ? plural(i.pallets, 'pallet') : i.cartons ? plural(i.cartons, 'carton') : '—'}</b><span className={i.expected_at < today ? 'late' : ''}>{i.expected_at < today ? `Was due ${at(i.expected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : i.status === 'in_transit' ? 'On its way' : 'Booked'}</span></div>
            </li>))}</ul>}
          {undated.length > 0 && <p className="hint">{undated.length === 1 ? '1 approved shipment has' : `${undated.length} approved shipments have`} no date yet.</p>}
        </div>
      </section>
    </>
  );
}
