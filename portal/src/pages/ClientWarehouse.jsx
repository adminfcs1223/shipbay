// Client-facing Warehouse: what the WMS knows about the brand, read straight from the same rows the floor works on.
// Order progress, stock on hand, pallets received, problems a picker reported, deliveries (the brand books them here and
// they show on the warehouse's Today screen), and the brand's connection for sending orders in.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';

import { WMS_URL as WMS_HOST } from './WmsWindow';   // the build's own WMS (VITE_WMS_URL), production by default
const num = (n) => Number(n || 0).toLocaleString('en-US');
const day = (d) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—');
const when = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const PALLET = { open: ['Being counted in', 'warn'], counted: ['Counted, going to its position', 'warn'], stored: ['Put away', 'ok'], received: ['Received', 'ok'] };
const PROBLEM = { missing: 'Not at the location', short: 'Short', other: 'Other' };
// An order is open while the warehouse still owes it work: the same statuses the database counts as open orders
// (wms_stock_summary 'on_open_orders'). Shipped and cancelled orders are finished whether or not the program closed them.
const OPEN_STATUSES = ['new', 'on_hold', 'backordered', 'picked', 'packed'];
const TABS = [['orders', 'Orders'], ['stock', 'Stock'], ['pallets', 'Pallets'], ['problems', 'Problems'], ['deliveries', 'Deliveries'], ['connection', 'Connection']];

export default function ClientWarehouse({ me, title, onChanged }) {
  const org = me?.org_id;
  const [tab, setTab] = useState('orders'); const [d, setD] = useState(null); const [err, setErr] = useState(null); const [msg, setMsg] = useState(null);
  const load = async () => {
    if (!org) return;
    const [o, s, p, pr, i, c] = await Promise.all([
      supabase.from('orders').select('id, order_number, ship_by, status, closed_at, received_at, total_units, notes, order_lines(id, sku, name, qty, picked_at)').eq('org_id', org).eq('source', 'connector').order('received_at', { ascending: false }).limit(300),
      supabase.from('inventory_levels').select('sku_id, sku, name, on_hand, reserved, active').eq('org_id', org).order('name'),
      supabase.from('wms_pallets').select('id, psku, status, item_no, item_name, cartons, units_per_carton, units_total, mixed, fba, cle, received_at, stored_at').eq('org_id', org).neq('status', 'void').order('received_at', { ascending: false }).limit(300),
      supabase.from('wms_pick_problems').select('id, line_id, order_id, kind, found, note, reported_at, resolved_at, resolved_how, order_lines(sku, name, qty)').eq('org_id', org).order('reported_at', { ascending: false }).limit(100),
      supabase.from('inbound_shipments').select('id, reference, status, carrier, tracking, expected_at, received_at, pallets, cartons, notes, created_at, approved_at').eq('org_id', org).order('created_at', { ascending: false }).limit(100),
      supabase.rpc('wms_org_connector', { p_org: org }),
    ]);
    const e = o.error || s.error || p.error || pr.error || i.error || c.error;
    setErr(e ? e.message : null);
    setD({ orders: o.data || [], stock: s.data || [], pallets: p.data || [], problems: pr.data || [], inbound: i.data || [], conn: c.data || { client_code: null, keys: [] } });
  };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [org]);

  const orders = useMemo(() => (d?.orders || []).map((o) => {
    const lines = o.order_lines || []; const picked = lines.filter((l) => l.picked_at).length;
    const stage = o.status === 'shipped' ? ['Shipped', 'ok'] : o.status === 'cancelled' ? ['Cancelled', 'muted'] : o.closed_at ? ['Closed', 'muted']
      : o.status === 'packed' ? ['Packed', 'ok'] : o.status === 'picked' ? ['Ready to pack', 'ok'] : picked > 0 ? [`Being picked · ${picked} of ${lines.length}`, 'warn'] : ['Waiting to be picked', 'navy'];
    return { ...o, lines, stage, isOpen: !o.closed_at && OPEN_STATUSES.includes(o.status) };
  }), [d]);
  const open = orders.filter((o) => o.isOpen); const openProblems = (d?.problems || []).filter((p) => !p.resolved_at);
  const orderNo = (id) => orders.find((o) => o.id === id)?.order_number || '';
  const stock = (d?.stock || []).filter((s) => s.active !== false);

  if (!org) return <div className="card"><div className="empty">This login is not attached to a brand.</div></div>;
  return (
    <>
      <div className="pagehead">
        <div><h1>{title || 'Warehouse'}<span className="dot">.</span></h1></div>
        <div className="glance">
          <div><small>Open orders</small><b>{num(open.length)}</b></div>
          <div><small>Ready to pack</small><b>{num(open.filter((o) => o.status === 'picked').length)}</b></div>
          <div><small>Units on hand</small><b>{num(stock.reduce((t, s) => t + Math.max(0, s.on_hand), 0))}</b></div>
          <div><small>Problems</small><b className={openProblems.length ? 'hot' : ''}>{num(openProblems.length)}</b></div>
        </div>
      </div>
      {err && <div className="msg err">{err}</div>}
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="card">
        <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'problems' && openProblems.length ? ` (${openProblems.length})` : ''}</button>)}</div>
        {!d ? <div className="empty">Loading…</div> : (
          <>
            {tab === 'orders' && (orders.length === 0 ? <div className="empty">No orders have come in from your program yet. Set it up under Connection.</div> : (
              <div className="tablewrap"><table className="ordertable">
                <thead><tr><th>Order</th><th>Ship by</th><th>Items</th><th className="n">Units</th><th>Where it is</th><th>Came in</th></tr></thead>
                <tbody>{orders.map((o) => (
                  <tr key={o.id} className={o.closed_at ? 'muted' : ''}>
                    <td><b className="mono">{o.order_number}</b></td><td>{day(o.ship_by)}</td>
                    <td className="sm">{o.lines.slice(0, 3).map((l) => `${l.qty} × ${l.name}`).join(', ')}{o.lines.length > 3 ? ` +${o.lines.length - 3} more` : ''}</td>
                    <td className="n">{num(o.total_units)}</td><td><span className={`statuspill ${o.stage[1]}`}>{o.stage[0]}</span></td><td className="sm">{when(o.received_at)}</td>
                  </tr>))}</tbody>
              </table></div>))}

            {tab === 'stock' && (stock.length === 0 ? <div className="empty">No products on file yet.</div> : (
              <div className="tablewrap"><table className="ordertable">
                <thead><tr><th>Product</th><th>Item #</th><th className="n">On hand</th><th className="n">On open orders</th><th className="n">Available</th></tr></thead>
                <tbody>{stock.map((s) => (
                  <tr key={s.sku_id} className={s.on_hand ? '' : 'muted'}>
                    <td><b>{s.name}</b></td><td className="mono sm">{s.sku}</td><td className="n"><b>{num(s.on_hand)}</b></td><td className="n">{num(s.reserved)}</td><td className="n">{num(s.on_hand - s.reserved)}</td>
                  </tr>))}</tbody>
              </table></div>))}

            {tab === 'pallets' && (d.pallets.length === 0 ? <div className="empty">No pallets received yet.</div> : (
              <div className="tablewrap"><table className="ordertable">
                <thead><tr><th>Pallet</th><th>What’s on it</th><th className="n">Cartons</th><th className="n">Units</th><th>Status</th><th>Received</th></tr></thead>
                <tbody>{d.pallets.map((p) => {
                  const units = p.units_total ?? (p.cartons && p.units_per_carton ? p.cartons * p.units_per_carton : null); const st = PALLET[p.status] || [p.status, 'muted'];
                  return (
                    <tr key={p.id}>
                      <td><b className="mono">{p.psku}</b></td><td>{p.item_name || 'Not recorded'}{p.item_no ? <span className="sm"> · {p.item_no}</span> : null}{p.fba ? <span className="sm"> · FBA</span> : null}</td>
                      <td className="n">{p.cartons ?? (p.cle ? 'Not counted' : '—')}</td><td className="n">{units != null ? num(units) : '—'}</td>
                      <td><span className={`statuspill ${st[1]}`}>{st[0]}</span></td><td className="sm">{when(p.received_at)}</td>
                    </tr>);
                })}</tbody>
              </table></div>))}

            {tab === 'problems' && (d.problems.length === 0 ? <div className="empty">No problems reported on your orders.</div> : (
              <div className="tablewrap"><table className="ordertable">
                <thead><tr><th>Order</th><th>Item</th><th className="n">Ordered</th><th>Problem</th><th>Reported</th><th>Status</th></tr></thead>
                <tbody>{d.problems.map((p) => (
                  <tr key={p.id} className={p.resolved_at ? 'muted' : ''}>
                    <td className="mono">{orderNo(p.order_id) || '—'}</td><td><b>{p.order_lines?.name || '—'}</b><span className="sm"> · {p.order_lines?.sku}</span></td><td className="n">{num(p.order_lines?.qty)}</td>
                    <td>{PROBLEM[p.kind] || p.kind}{p.kind === 'short' ? `: ${num(p.found)} there` : ''}{p.note ? <span className="sm"> · {p.note}</span> : null}</td>
                    <td className="sm">{when(p.reported_at)}</td>
                    <td><span className={`statuspill ${p.resolved_at ? 'ok' : 'bad'}`}>{p.resolved_at ? (p.resolved_how === 'picked' ? 'Picked' : 'Cleared') : 'Open'}</span></td>
                  </tr>))}</tbody>
              </table></div>))}

            {tab === 'deliveries' && <Deliveries me={me} rows={d.inbound} reload={() => { load(); onChanged?.(); }} say={setMsg} />}
            {tab === 'connection' && <Connection me={me} conn={d.conn} reload={load} say={setMsg} />}
          </>
        )}
      </div>
    </>
  );
}

function Deliveries({ me, rows, reload, say }) {
  const blank = { expected_at: '', pallets: '', cartons: '', carrier: '', tracking: '', reference: '', notes: '' };
  const [f, setF] = useState(blank); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const book = async (e) => {
    e.preventDefault(); if (busy) return;
    if (!f.expected_at) return say({ kind: 'err', text: 'Pick the day it arrives.' });
    if (!Number(f.pallets) && !Number(f.cartons)) return say({ kind: 'err', text: 'Enter how many pallets or cartons are coming.' });
    setBusy(true);
    const { error } = await supabase.from('inbound_shipments').insert({ org_id: me.org_id, status: 'expected', expected_at: f.expected_at, pallets: Number(f.pallets) || null, cartons: Number(f.cartons) || null,
      carrier: f.carrier.trim() || null, tracking: f.tracking.trim() || null, reference: f.reference.trim() || `Delivery ${f.expected_at}`, notes: f.notes.trim() || null, created_by: me.id });
    setBusy(false); if (error) return say({ kind: 'err', text: error.message });
    setF(blank); say({ kind: 'ok', text: me.isStaff ? 'Booked and approved. It is on the warehouse schedule.' : 'Sent. ShipBay confirms it, then it goes on the warehouse schedule.' }); reload();
  };
  const approve = async (r) => {
    const { error } = await supabase.from('inbound_shipments').update({ approved_at: new Date().toISOString(), approved_by: me.id, approved_by_name: me.full_name || me.email }).eq('id', r.id);
    if (error) return say({ kind: 'err', text: error.message }); say({ kind: 'ok', text: 'Approved. It is on the warehouse schedule.' }); reload();
  };
  const decline = async (r) => {
    if (!window.confirm('Decline this shipment? It is marked cancelled and the brand sees that.')) return;
    const { error } = await supabase.from('inbound_shipments').update({ status: 'cancelled' }).eq('id', r.id); if (error) return say({ kind: 'err', text: error.message }); reload();
  };
  const ST = { expected: ['Confirmed', 'navy'], in_transit: ['On its way', 'warn'], received: ['Received', 'ok'], discrepancy: ['Received with a difference', 'bad'], cancelled: ['Cancelled', 'muted'] };
  return (
    <>
      <form onSubmit={book} style={{ padding: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, alignItems: 'end', borderBottom: '1px solid var(--line)' }}>
        <div className="field" style={{ margin: 0 }}><label>Arrives</label><input type="date" value={f.expected_at} onChange={set('expected_at')} required /></div>
        <div className="field" style={{ margin: 0 }}><label>Pallets</label><input type="number" min="0" inputMode="numeric" value={f.pallets} onChange={set('pallets')} /></div>
        <div className="field" style={{ margin: 0 }}><label>Cartons</label><input type="number" min="0" inputMode="numeric" value={f.cartons} onChange={set('cartons')} /></div>
        <div className="field" style={{ margin: 0 }}><label>Carrier</label><input value={f.carrier} onChange={set('carrier')} maxLength={80} /></div>
        <div className="field" style={{ margin: 0 }}><label>Tracking or PRO #</label><input value={f.tracking} onChange={set('tracking')} maxLength={120} /></div>
        <div className="field" style={{ margin: 0 }}><label>Your reference</label><input value={f.reference} onChange={set('reference')} maxLength={120} /></div>
        <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}><label>What’s coming</label><input value={f.notes} onChange={set('notes')} maxLength={500} /></div>
        <div><button className="btn-sm primary" disabled={busy || me.viewOnly}>{busy ? 'Booking…' : 'Book delivery'}</button></div>
      </form>
      {rows.length === 0 ? <div className="empty">No deliveries booked.</div> : (
        <div className="tablewrap"><table className="ordertable">
          <thead><tr><th>Arrives</th><th>Reference</th><th>Carrier</th><th className="n">Pallets</th><th className="n">Cartons</th><th>Status</th>{me.isStaff && <th />}</tr></thead>
          <tbody>{rows.map((r) => { const waiting = !r.approved_at && ['expected', 'in_transit'].includes(r.status); const st = waiting ? ['Waiting for ShipBay to confirm', 'warn'] : ST[r.status] || [r.status, 'muted']; return (
            <tr key={r.id} className={['received', 'cancelled'].includes(r.status) ? 'muted' : ''}>
              <td><b>{day(r.expected_at)}</b></td><td>{r.reference || '—'}{r.notes ? <span className="sm"> · {r.notes}</span> : null}</td><td>{[r.carrier, r.tracking].filter(Boolean).join(' · ') || '—'}</td>
              <td className="n">{r.pallets ?? '—'}</td><td className="n">{r.cartons ?? '—'}</td><td><span className={`statuspill ${st[1]}`}>{st[0]}</span></td>
              {me.isStaff && <td className="n" style={{ whiteSpace: 'nowrap' }}>{waiting && <><button className="btn-xs" onClick={() => approve(r)}>Approve</button>{' '}<button className="btn-xs" onClick={() => decline(r)}>Decline</button></>}</td>}
            </tr>); })}</tbody>
        </table></div>)}
    </>
  );
}

function Connection({ me, conn, reload, say }) {
  const [shown, setShown] = useState(null); const [busy, setBusy] = useState(false);
  const active = conn.keys.filter((k) => !k.revoked_at);
  const make = async () => {
    const label = window.prompt('A name for this key, so you can tell it apart later (for example "Veeqo program").', 'Orders program'); if (label == null) return;
    setBusy(true); const { data, error } = await supabase.rpc('wms_org_create_key', { p_org: me.org_id, p_label: label }); setBusy(false);
    if (error) return say({ kind: 'err', text: error.message }); setShown(data); reload();
  };
  const revoke = async (k) => {
    if (!window.confirm(`Revoke the key ending ${k.hint}? Any program using it stops being able to send orders straight away.`)) return;
    const { error } = await supabase.rpc('wms_org_revoke_key', { p_id: k.id }); if (error) return say({ kind: 'err', text: error.message }); reload();
  };
  return (
    <div style={{ padding: 20 }}>
      <div className="credbox" style={{ marginBottom: 18 }}>
        <div><small>Send orders to</small><b style={{ wordBreak: 'break-all' }}>{WMS_HOST}/api/orders</b></div>
        <div><small>Close an order</small><b style={{ wordBreak: 'break-all' }}>{WMS_HOST}/api/orders/&#123;order_number&#125;/close</b></div>
        <div><small>Your client code</small><b className="mono">{conn.client_code || 'Not set yet. Ask ShipBay.'}</b></div>
      </div>
      <p className="sm" style={{ marginBottom: 14, maxWidth: '70ch' }}>Your own program reads orders from your sales channel (Veeqo, ShipStation or another) and sends each one here with the key below. Only the order number, ship-by date, notes and the items go across: no customer names, addresses or prices.</p>
      <div className="opsbar"><b>Keys</b><div className="spacer" /><button className="btn-sm primary" disabled={busy || !conn.client_code || me.viewOnly} onClick={make}>{busy ? 'Making…' : '+ New key'}</button></div>
      {conn.keys.length === 0 ? <div className="empty">No keys yet.</div> : (
        <div className="tablewrap"><table className="ordertable">
          <thead><tr><th>Key</th><th>Name</th><th>Made</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>{conn.keys.map((k) => (
            <tr key={k.id} className={k.revoked_at ? 'muted' : ''}>
              <td className="mono">…{k.hint}</td><td>{k.label || '—'}</td><td className="sm">{when(k.created_at)}</td><td className="sm">{k.last_used_at ? when(k.last_used_at) : 'Never'}</td>
              <td><span className={`statuspill ${k.revoked_at ? 'bad' : 'ok'}`}>{k.revoked_at ? 'Revoked' : 'Active'}</span></td>
              <td className="n">{!k.revoked_at && <button className="btn-xs" disabled={me.viewOnly} onClick={() => revoke(k)}>Revoke</button>}</td>
            </tr>))}</tbody>
        </table></div>)}
      {active.length >= 5 && <p className="sm">Five active keys is the limit. Revoke one to make another.</p>}
      {shown && (
        <div className="overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Your new key<span className="dot">.</span></h3>
            <p className="lead">Shown once. Put it in your program now; it can’t be looked up later, only replaced.</p>
            <div className="credbox"><div><small>Authorization: Bearer</small><b className="mono" style={{ wordBreak: 'break-all' }}>{shown}</b></div></div>
            <div className="actions"><button className="btn-sm" onClick={() => navigator.clipboard?.writeText(`WMS orders endpoint: ${WMS_HOST}/api/orders\nclient: ${conn.client_code}\nAuthorization: Bearer ${shown}`)}>Copy</button><button className="btn-sm primary" onClick={() => setShown(null)}>Done</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
