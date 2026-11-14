// Today: what is scheduled in and what has to go out, on one screen. Inbound comes from the shipments the brands (or
// the office) booked in the dashboard; orders come from each brand's connector. Read fresh every minute.
import { useEffect, useState } from 'react';
import { supabase } from './lib';

const num = (n) => Number(n || 0).toLocaleString('en-US');
const dayName = (iso, today) => {
  if (!iso) return 'No date';
  if (iso === today) return 'Today';
  const d = new Date(`${iso}T12:00:00`); const t = new Date(`${today}T12:00:00`); const diff = Math.round((d - t) / 86400000);
  if (diff === 1) return 'Tomorrow';
  if (diff < 0) return `${-diff} day${diff === -1 ? '' : 's'} late`;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};
const plural = (n, w) => `${num(n)} ${w}${Number(n) === 1 ? '' : 's'}`;

export default function Today({ go, openBrand }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(null);
  const load = async () => { const { data, error } = await supabase.rpc('wms_today'); if (error) setErr(error.message); else { setErr(null); setD(data); } };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);

  if (!d) return (<><header className="pagehead"><h1>Today<span className="dot">.</span></h1></header>{err ? <div className="strip bad"><b>Can’t load today.</b><span>{err}</span><button onClick={load}>Try again</button></div> : <div className="empty">Loading…</div>}</>);

  const today = d.today;
  const due = (o) => !o.ship_by || o.ship_by <= today;
  const inToday = d.inbound.filter((i) => i.expected_at && i.expected_at <= today);
  const inLater = d.inbound.filter((i) => !i.expected_at || i.expected_at > today);
  const outToday = d.orders.filter(due); const outLater = d.orders.filter((o) => !due(o));
  const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const palletsIn = sum(inToday, 'pallets');
  const ordersOut = sum(outToday, 'orders'); const unitsLeft = sum(outToday, 'units') - sum(outToday, 'picked_units'); const ready = sum(d.orders, 'ready');
  // one row per brand for today's outbound
  const brands = [...outToday.reduce((m, o) => { const r = m.get(o.org_id) || { org_id: o.org_id, brand: o.brand, orders: 0, units: 0, picked_units: 0, ready: 0, late: 0 }; r.orders += o.orders; r.units += o.units; r.picked_units += o.picked_units; r.ready += o.ready; if (o.ship_by && o.ship_by < today) r.late += o.orders - o.ready; m.set(o.org_id, r); return m; }, new Map()).values()];
  // the week: one row per day that has anything on it
  const days = [...new Set([...inLater.map((i) => i.expected_at), ...outLater.map((o) => o.ship_by)].filter(Boolean))].sort();

  return (
    <>
      <header className="pagehead">
        <h1>Today<span className="dot">.</span></h1>
        <div className="glance">
          <div><b>{num(inToday.length)}</b><small>{inToday.length === 1 ? 'Delivery due' : 'Deliveries due'}{palletsIn ? ` · ${plural(palletsIn, 'pallet')}` : ''}</small></div>
          <div><b>{num(ordersOut)}</b><small>Orders to ship</small></div>
          <div><b className={unitsLeft ? 'hot' : ''}>{num(unitsLeft)}</b><small>Units to pick</small></div>
          <div><b>{num(ready)}</b><small>Ready to pack</small></div>
        </div>
      </header>
      {err && <div className="strip bad"><b>Not refreshed.</b><span>{err}</span><button onClick={load}>Try again</button></div>}

      <div className="today">
        <section className="panel">
          <header className="panelhead"><h3>Coming in</h3><span>{inToday.length ? `${num(inToday.length)} ${inToday.length === 1 ? 'delivery' : 'deliveries'} due` : 'Nothing booked for today'}</span></header>
          {inToday.length > 0 && <ul className="rows">{inToday.map((i) => (
            <li key={i.id}>
              <div><b>{i.brand}</b><span>{[i.reference, i.carrier].filter(Boolean).join(' · ') || 'No reference'}</span></div>
              <div className="r"><b>{i.pallets ? plural(i.pallets, 'pallet') : i.cartons ? plural(i.cartons, 'carton') : '—'}</b><span className={i.expected_at < today ? 'late' : ''}>{dayName(i.expected_at, today)}</span></div>
            </li>))}</ul>}
          <div className="floor">
            <button onClick={() => go('receive')}><b>{num(d.pallets.received_today)}</b><small>Pallets received today</small></button>
            <button onClick={() => go('pallets')}><b className={d.pallets.to_scan ? 'hot' : ''}>{num(d.pallets.to_scan)}</b><small>Cartons to scan in</small></button>
            <button onClick={() => go('pallets')}><b className={d.pallets.to_put_away ? 'hot' : ''}>{num(d.pallets.to_put_away)}</b><small>To put away</small></button>
          </div>
          <button className="btn big go" onClick={() => go('receive')}>Receive a pallet</button>
        </section>

        <section className="panel">
          <header className="panelhead"><h3>Going out</h3><span>{ordersOut ? `${plural(ordersOut, 'order')} · ${plural(sum(outToday, 'units'), 'unit')}` : 'No orders due today'}</span></header>
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
            <div><b>{num(ready)}</b><small>Orders ready to pack</small></div>
            <div><b>{num(d.closed_today)}</b><small>Orders closed today</small></div>
          </div>
          <button className="btn big" onClick={() => go('orders')}>Open the pick lists</button>
        </section>
      </div>

      <section className="panel">
        <header className="panelhead"><h3>Next 7 days</h3><span>{days.length ? '' : 'Nothing on the schedule yet'}</span></header>
        {days.length > 0 && (
          <div className="weekwrap"><table className="grid week">
            <thead><tr><th>Day</th><th>Coming in</th><th>Going out</th></tr></thead>
            <tbody>{days.map((day) => {
              const ins = inLater.filter((i) => i.expected_at === day); const outs = outLater.filter((o) => o.ship_by === day);
              return (
                <tr key={day}>
                  <td className="code">{dayName(day, today)}</td>
                  <td>{ins.length ? ins.map((i) => `${i.brand}${i.pallets ? ` · ${plural(i.pallets, 'pallet')}` : ''}`).join(', ') : <span className="muted">—</span>}</td>
                  <td>{outs.length ? outs.map((o) => `${o.brand} · ${plural(o.orders, 'order')}`).join(', ') : <span className="muted">—</span>}</td>
                </tr>);
            })}</tbody>
          </table></div>
        )}
        {inLater.some((i) => !i.expected_at) && <p className="hint">{(() => { const k = inLater.filter((i) => !i.expected_at).length; return `${k} booked ${k === 1 ? 'delivery has' : 'deliveries have'} no date yet.`; })()}</p>}
      </section>
    </>
  );
}
