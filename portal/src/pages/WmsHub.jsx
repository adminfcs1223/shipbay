// WMS — the one warehouse screen in the dashboard. It replaces the old Orders, Receiving and Pack & Ship screens.
//   All brands: what is waiting for approval, the shipment calendar, and where each brand stands.
//   A brand's tab: everything the brand sees on its own Warehouse page, with ShipBay's access on top (approve or
//   decline a shipment, book one for them, make or revoke their connector key).
// Orders need no approval: a brand's program sends them and they go straight to the pick lists. Shipments do: a brand
// books one, it waits here, and it reaches the warehouse's schedule only once someone approves it.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
import ClientWarehouse from './ClientWarehouse';

const WMS_URL = 'https://wmsshipbay.netlify.app';
const num = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, w) => `${num(n)} ${w}${Number(n) === 1 ? '' : 's'}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const at = (s) => new Date(`${s}T12:00:00`);
const longDay = (s) => (s ? at(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'No date');
const amount = (r) => [r.pallets ? plural(r.pallets, 'pallet') : null, r.cartons ? plural(r.cartons, 'carton') : null].filter(Boolean).join(' · ') || '—';

export default function WmsHub({ me }) {
  const [tab, setTab] = useState('all'); const [d, setD] = useState(null); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(null); const [sel, setSel] = useState(null);
  const today = iso(new Date());
  const load = async () => {
    const [o, i, ord, pr] = await Promise.all([
      supabase.from('orgs').select('id, name, status, client_code').neq('status', 'churned').order('name'),
      supabase.from('inbound_shipments').select('id, org_id, reference, status, carrier, tracking, expected_at, pallets, cartons, notes, created_at, approved_at, approved_by_name').in('status', ['expected', 'in_transit']).order('expected_at', { ascending: true, nullsFirst: false }),
      supabase.from('orders').select('id, org_id, status, ship_by, received_at, closed_at').eq('source', 'connector').is('closed_at', null).in('status', ['new', 'picked']).limit(2000),
      supabase.from('wms_pick_problems').select('id, org_id').is('resolved_at', null),
    ]);
    const e = o.error || i.error || ord.error || pr.error; if (e) setMsg({ kind: 'err', text: e.message });
    setD({ orgs: o.data || [], inbound: i.data || [], orders: ord.data || [], problems: pr.data || [] });
  };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);

  const name = (id) => d?.orgs.find((x) => x.id === id)?.name || '';
  const pending = (d?.inbound || []).filter((r) => !r.approved_at);
  const approved = (d?.inbound || []).filter((r) => r.approved_at);
  const inToday = (d?.orders || []).filter((r) => (r.received_at || '').slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const approve = async (r) => {
    setBusy(r.id); const { error } = await supabase.from('inbound_shipments').update({ approved_at: new Date().toISOString(), approved_by: me.id, approved_by_name: me.full_name || me.email }).eq('id', r.id); setBusy(null);
    if (error) return setMsg({ kind: 'err', text: error.message }); setMsg({ kind: 'ok', text: `Approved. ${name(r.org_id)}’s shipment is on the warehouse schedule.` }); load();
  };
  const decline = async (r) => {
    if (!window.confirm(`Decline ${name(r.org_id)}’s shipment for ${longDay(r.expected_at)}? It is marked cancelled and the brand sees that.`)) return;
    setBusy(r.id); const { error } = await supabase.from('inbound_shipments').update({ status: 'cancelled' }).eq('id', r.id); setBusy(null);
    if (error) return setMsg({ kind: 'err', text: error.message }); load();
  };

  const days = useMemo(() => { const start = at(today); start.setDate(start.getDate() - start.getDay()); return Array.from({ length: 35 }, (_, k) => { const x = new Date(start); x.setDate(start.getDate() + k); return iso(x); }); }, [today]);
  const byDay = useMemo(() => { const m = new Map(); for (const r of d?.inbound || []) { const k = r.expected_at && r.expected_at < today ? today : r.expected_at; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }, [d, today]);
  const shown = sel || today; const dayRows = byDay.get(shown) || [];
  const brand = tab !== 'all' ? d?.orgs.find((x) => x.id === tab) : null;

  return (
    <>
      <div className="pagehead">
        <div><h1>WMS<span className="dot">.</span></h1></div>
        <div className="glance">
          <div><small>Shipments to approve</small><b className={pending.length ? 'hot' : ''}>{num(pending.length)}</b></div>
          <div><small>Orders to approve</small><b>0</b></div>
          <div><small>Orders in today</small><b>{num(inToday)}</b></div>
          <div><small>Open orders</small><b>{num((d?.orders || []).length)}</b></div>
          <div><small>Problems</small><b className={d?.problems.length ? 'hot' : ''}>{num(d?.problems.length)}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="opsbar">
        <div className="tabs hubtabs">
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All brands{pending.length ? ` (${pending.length})` : ''}</button>
          {(d?.orgs || []).map((o) => { const p = pending.filter((r) => r.org_id === o.id).length; return <button key={o.id} className={tab === o.id ? 'on' : ''} onClick={() => setTab(o.id)}>{o.name}{p ? ` (${p})` : ''}</button>; })}
        </div>
        <div className="spacer" />
        <a className="btn-sm" href={WMS_URL} target="_blank" rel="noreferrer">Open the WMS ↗</a>
      </div>

      {!d ? <div className="card"><div className="empty">Loading…</div></div> : brand ? (
        <ClientWarehouse key={brand.id} me={{ ...me, org_id: brand.id, orgName: brand.name }} title={brand.name} onChanged={load} />
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="cardhead"><h3>Waiting for approval<span className="dot">.</span></h3><span className="sm">Orders are approved automatically. Shipments reach the warehouse schedule once approved here.</span></div>
            {pending.length === 0 ? <div className="empty">Nothing to approve.</div> : (
              <div className="tablewrap"><table className="ordertable">
                <thead><tr><th>Brand</th><th>Arrives</th><th>How much</th><th>Carrier</th><th>Reference</th><th>Booked</th><th /></tr></thead>
                <tbody>{pending.map((r) => (
                  <tr key={r.id}>
                    <td><b>{name(r.org_id)}</b></td><td><b>{longDay(r.expected_at)}</b></td><td>{amount(r)}</td><td>{[r.carrier, r.tracking].filter(Boolean).join(' · ') || '—'}</td>
                    <td>{r.reference || '—'}{r.notes ? <span className="sm"> · {r.notes}</span> : null}</td><td className="sm">{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                    <td className="n" style={{ whiteSpace: 'nowrap' }}><button className="btn-sm primary" disabled={busy === r.id} onClick={() => approve(r)}>Approve</button>{' '}<button className="btn-sm" disabled={busy === r.id} onClick={() => decline(r)}>Decline</button></td>
                  </tr>))}</tbody>
              </table></div>)}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="cardhead"><h3>Shipments expected<span className="dot">.</span></h3><span className="sm">{approved.length ? `${plural(approved.length, 'approved shipment')} coming` : 'No approved shipments coming'}{pending.length ? ` · ${pending.length} waiting for approval` : ''}</span></div>
            <div className="shipcal">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => <div key={w} className="sch">{w}</div>)}
              {days.map((day) => {
                const rows = byDay.get(day) || []; const dt = at(day); const pallets = rows.reduce((t, r) => t + Number(r.pallets || 0), 0); const wait = rows.some((r) => !r.approved_at);
                return (
                  <button key={day} className={`scd ${day === today ? 'today' : ''} ${day < today ? 'past' : ''} ${rows.length ? 'has' : ''} ${wait ? 'wait' : ''} ${day === shown ? 'sel' : ''}`} onClick={() => setSel(day)}>
                    <span>{dt.getDate() === 1 || day === days[0] ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : dt.getDate()}</span>
                    {rows.length > 0 && <b>{pallets || rows.length}<i>{pallets ? (pallets === 1 ? ' pallet' : ' pallets') : rows.length === 1 ? ' shipment' : ' shipments'}</i></b>}
                    {rows.length > 0 && <em>{[...new Set(rows.map((r) => name(r.org_id)))].join(', ')}{wait ? ' · to approve' : ''}</em>}
                  </button>);
              })}
            </div>
            <div className="scdetail"><b>{shown === today ? 'Today' : longDay(shown)}</b>{dayRows.length === 0 ? <span className="sm"> · Nothing expected</span> : dayRows.map((r) => <span key={r.id} className="sm"> · {name(r.org_id)}, {amount(r)}{r.carrier ? `, ${r.carrier}` : ''}{r.approved_at ? '' : ' (waiting for approval)'}</span>)}</div>
          </div>

          <div className="card">
            <div className="cardhead"><h3>Brands<span className="dot">.</span></h3></div>
            <div className="tablewrap"><table className="ordertable">
              <thead><tr><th>Brand</th><th>Client code</th><th className="n">Open orders</th><th className="n">Ready to pack</th><th className="n">Shipments coming</th><th className="n">To approve</th><th className="n">Problems</th></tr></thead>
              <tbody>{d.orgs.map((o) => { const mine = d.orders.filter((r) => r.org_id === o.id); return (
                <tr key={o.id} onClick={() => setTab(o.id)} style={{ cursor: 'pointer' }}>
                  <td><b>{o.name}</b></td><td className="mono sm">{o.client_code || 'Not set'}</td><td className="n">{num(mine.length)}</td><td className="n">{num(mine.filter((r) => r.status === 'picked').length)}</td>
                  <td className="n">{num(approved.filter((r) => r.org_id === o.id).length)}</td><td className="n">{num(pending.filter((r) => r.org_id === o.id).length)}</td><td className="n">{num(d.problems.filter((r) => r.org_id === o.id).length)}</td>
                </tr>); })}</tbody>
            </table></div>
          </div>
        </>
      )}
    </>
  );
}
