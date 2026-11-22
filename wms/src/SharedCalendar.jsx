// WMS → Calendar: the dock calendar ShipBay's staff work from. ShipBay's own shipments with their private detail, and
// the other company's appointments as Nexus shares them (company, direction, time, pallets, status and nothing else).
// All times America/New_York. This screen only reads: publishing is done by the bridge from ShipBay's shipment records.
import { useEffect, useMemo, useState } from 'react';
import { mergeCalendar, byDay, easternWindow, ZONE } from './nexusCalendar.js';
import { loadCalendar, MODE } from './nexusSource.js';

const num = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, w) => `${num(n)} ${Number(n) === 1 ? w : `${w}s`}`;
const at = (s) => new Date(`${s}T12:00:00Z`);
const fmt = (s, o) => at(s).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const longDay = (s) => fmt(s, { weekday: 'long', month: 'long', day: 'numeric' });
const add = (s, n) => { const d = at(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const NAMES = { SHIPBAY: 'ShipBay', SOULED: 'Souled' };
const STATUS = { scheduled: 'Scheduled', arrived: 'Arrived', completed: 'Completed', cancelled: 'Cancelled', expected: 'Booked', in_transit: 'On its way' };
const SHARED = { published: 'On the shared calendar', not_published: 'Not on the shared calendar yet', cancelled_in_nexus: 'Shared booking cancelled', held_date_only: 'Not shared yet: Nexus needs a time' };

export default function SharedCalendar({ go }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(null); const [sel, setSel] = useState(null); const [busy, setBusy] = useState(false); const [hideCancelled, setHide] = useState(true);
  const load = async () => { setBusy(true); try { setD(await loadCalendar()); setErr(null); } catch (e) { setErr(e.message); } setBusy(false); };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  const today = d?.today;
  const rows = useMemo(() => (d ? mergeCalendar(d.shipments, d.nexus.events, { today }) : []), [d]);
  const shownRows = useMemo(() => rows.filter((r) => !hideCancelled || (r.status !== 'cancelled')), [rows, hideCancelled]);
  const { days, undated } = useMemo(() => byDay(shownRows, today), [shownRows, today]);
  const grid = useMemo(() => { if (!today) return []; const start = add(today, -at(today).getUTCDay()); return Array.from({ length: 35 }, (_, i) => add(start, i)); }, [today]);

  if (!d) return (<><header className="pagehead"><h1>Calendar<span className="dot">.</span></h1></header>{err ? <div className="strip bad"><b>Can’t load the calendar.</b><span>{err}</span><button onClick={load}>Try again</button></div> : <div className="empty">Loading the calendar…</div>}</>);
  const shown = sel || today; const list = days.get(shown) || [];
  const count = (c) => shownRows.filter((r) => r.company === c && r.day && r.day >= today).length;
  const cancelledN = rows.filter((r) => r.status === 'cancelled').length;

  return (
    <>
      <header className="pagehead">
        <div><h1>Calendar<span className="dot">.</span></h1><p className="when" data-testid="zone">Shared dock calendar · all times {ZONE} (ET)</p></div>
        <div className="glance">
          <div><b>{num((days.get(today) || []).length)}</b><small>Today</small></div>
          <div><b>{num(count('SHIPBAY'))}</b><small>ShipBay ahead</small></div>
          <div><b>{num(shownRows.filter((r) => r.company !== 'SHIPBAY' && r.day >= today).length)}</b><small>Other company ahead</small></div>
        </div>
      </header>
      {MODE === 'demo' && <div className="strip" data-testid="demo-banner"><b>Demonstration data.</b><span>Everything on this screen is synthetic. This build is not connected to Nexus and cannot publish, change or cancel a booking.</span></div>}
      {d.mode === 'bridge' && !d.nexus.ok && <div className="strip bad" data-testid="nexus-down"><b>Nexus is not answering.</b><span>Showing ShipBay's own shipments only. The other company's appointments are not on this screen right now.</span></div>}
      {err && <div className="strip bad"><b>Not refreshed.</b><span>{err}</span><button onClick={load}>Try again</button></div>}

      <section className="panel">
        <header className="panelhead">
          <h3>Next 5 weeks</h3>
          <span className="sc-tools">
            <span className="sc-key"><i className="sc-dot own" />ShipBay</span><span className="sc-key"><i className="sc-dot other" />Other company</span>
            {cancelledN > 0 && <label className="sc-check"><input type="checkbox" checked={!hideCancelled} onChange={(e) => setHide(!e.target.checked)} /> Show cancelled ({cancelledN})</label>}
            <button className="btn sm" onClick={load} disabled={busy} data-testid="refresh">{busy ? 'Refreshing…' : 'Refresh'}</button>
          </span>
        </header>
        <div className="cal" role="grid" aria-label="Shared dock calendar by day" data-testid="shared-cal">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => <div key={w} className="calhead">{w}</div>)}
          {grid.map((day) => {
            const rs = days.get(day) || []; const own = rs.filter((r) => r.company === 'SHIPBAY').length; const other = rs.length - own; const dt = at(day);
            return (
              <button key={day} role="gridcell" data-day={day} className={`calday ${day === today ? 'today' : ''} ${day < today ? 'past' : ''} ${rs.length ? 'has' : ''} ${day === shown ? 'sel' : ''}`} onClick={() => setSel(day)} aria-label={`${longDay(day)}: ${rs.length ? plural(rs.length, 'appointment') : 'nothing scheduled'}`}>
                <span className="dnum">{dt.getUTCDate() === 1 || day === grid[0] ? fmt(day, { month: 'short', day: 'numeric' }) : dt.getUTCDate()}</span>
                {own > 0 && <em className="sc-chip own">ShipBay · {own}</em>}
                {other > 0 && <em className="sc-chip other">{[...new Set(rs.filter((r) => r.company !== 'SHIPBAY').map((r) => NAMES[r.company] || r.company))].join(', ')} · {other}</em>}
              </button>);
          })}
        </div>
        <div className="calday-detail" data-testid="day-detail">
          <h4>{shown === today ? 'Today' : longDay(shown)}<span>{list.length ? plural(list.length, 'appointment') : 'Nothing scheduled'}</span></h4>
          {list.length > 0 && <ul className="rows">{list.map((r) => <Row key={r.key} r={r} go={go} />)}</ul>}
        </div>
      </section>

      {undated.length > 0 && (
        <section className="panel" data-testid="undated">
          <header className="panelhead"><h3>No date yet</h3><span>{plural(undated.length, 'ShipBay shipment')}</span></header>
          <ul className="rows">{undated.map((r) => <Row key={r.key} r={r} go={go} />)}</ul>
        </section>)}
    </>
  );
}

function Row({ r, go }) {
  const cancelled = r.status === 'cancelled'; const s = r.shipment;
  const time = r.time_known ? easternWindow(r.starts_at, r.ends_at) : r.day ? 'Time not confirmed' : 'Date not set';
  return (
    <li className={`sc-row ${r.kind} ${cancelled ? 'gone' : ''} ${r.tentative ? 'tentative' : ''}`} data-tentative={!!r.tentative} data-kind={r.kind} data-company={r.company} data-booking={r.kind === 'other' ? '' : r.booking_id} data-time-known={r.time_known}>
      <div>
        <b><i className={`sc-dot ${r.company === 'SHIPBAY' ? 'own' : 'other'}`} />{r.kind === 'shipment' ? s.brand : NAMES[r.company] || r.company}{r.kind !== 'shipment' && <small> · {r.tentative ? 'Expected arrival' : r.direction === 'outbound' ? 'Outbound pickup' : 'Inbound delivery'}</small>}{r.kind === 'shipment' && r.tentative && <small> · Expected arrival</small>}</b>
        {r.kind === 'shipment' && <span>{[s.reference, s.carrier, s.notes].filter(Boolean).join(' · ') || 'No details given'}</span>}
        {r.kind === 'own' && <span>ShipBay booking {r.booking_id} · no shipment record in this WMS</span>}
        {r.kind === 'other' && <span>Shared by Nexus. Details are private to {NAMES[r.company] || r.company}.</span>}
      </div>
      <div className="r">
        <b className={r.time_known ? '' : 'sc-notime'}>{time}</b>
        <span>{[r.pallets != null ? plural(r.pallets, 'pallet') : null, r.late ? `Was due ${fmt(s.expected_at, { month: 'short', day: 'numeric' })}` : STATUS[r.status] || r.status, r.kind === 'shipment' ? SHARED[r.shared] : null].filter(Boolean).join(' · ')}</span>
        {r.kind === 'shipment' && go && <button className="btn sm" onClick={() => go('receive')}>Receive</button>}
      </div>
    </li>
  );
}
