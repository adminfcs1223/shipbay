// Client view of their own orders: status, deadline, tracking. Read-only; RLS scopes the view to their org.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
import { STATUS, SOURCE, dueClass, fmtDate } from '../ops';

const TABS = [['open', 'In progress'], ['shipped', 'Shipped'], ['hold', 'On hold'], ['all', 'All']];
const OPEN = ['new', 'picked', 'packed'];
const chan = (r) => r.marketplace || (r.channel === 'veeqo' ? 'Veeqo' : r.channel === 'manual' ? 'Manual' : SOURCE[r.source] || 'Shopify');

export default function ClientOrders({ me }) {
  const [rows, setRows] = useState(null);
  const [tab, setTab] = useState('open');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [lines, setLines] = useState([]);
  useEffect(() => { supabase.from('v_orders_queue').select('*').order('placed_at', { ascending: false }).limit(1000).then(({ data }) => setRows(data || [])); }, []);
  useEffect(() => { if (!sel) return setLines([]); supabase.from('order_lines').select('*').eq('order_id', sel).order('name').then(({ data }) => setLines(data || [])); }, [sel]);
  const list = useMemo(() => (rows || []).filter((r) => (tab === 'all' || (tab === 'open' ? OPEN.includes(r.status) : tab === 'hold' ? ['on_hold', 'backordered'].includes(r.status) : r.status === tab))
    && (!q || [r.order_number, r.customer_name, r.marketplace, r.tracking].filter(Boolean).some((s) => String(s).toLowerCase().includes(q.toLowerCase())))), [rows, tab, q]);
  const current = (rows || []).find((r) => r.id === sel);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <div className="pagehead">
        <div><h1>Orders<span className="dot">.</span></h1><p className="sub">Everything we’ve received for {me?.orgName || 'your brand'}. Tracking appears the moment a label is bought.</p></div>
        <div className="glance">
          <div><small>In progress</small><b>{(rows || []).filter((r) => OPEN.includes(r.status)).length}</b></div>
          <div><small>Shipped today</small><b>{(rows || []).filter((r) => r.status === 'shipped' && r.shipped_at?.slice(0, 10) === today).length}</b></div>
          <div><small>On hold</small><b className={(rows || []).some((r) => ['on_hold', 'backordered'].includes(r.status)) ? 'hot' : ''}>{(rows || []).filter((r) => ['on_hold', 'backordered'].includes(r.status)).length}</b></div>
        </div>
      </div>
      <div className="opsbar"><input className="search" placeholder="Search order #, customer, tracking…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="ops">
        <div className="card queue">
          <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
          {rows === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">Nothing here yet.</div> : (
            <div className="tablewrap"><table className="ordertable">
              <thead><tr><th>Order</th><th>Channel</th><th>Ship by</th><th>Customer</th><th>Status</th><th>Tracking</th></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.id} className={r.id === sel ? 'active' : ''} onClick={() => setSel(r.id)}>
                  <td><b>{r.order_number}</b><div className="sm">{fmtDate(r.placed_at)}</div></td>
                  <td><span className={`pill ${r.marketplace ? 'connected' : ''}`}>{chan(r)}</span></td>
                  <td className={`due ${r.status === 'shipped' ? '' : dueClass(r.ship_by)}`}>{r.ship_by ? fmtDate(r.ship_by) : '—'}</td>
                  <td>{r.customer_name}<div className="sm">{[r.ship_to?.city, r.ship_to?.province_code].filter(Boolean).join(', ')}</div></td>
                  <td><span className={`statuspill ${STATUS[r.status]?.[1]}`}>{STATUS[r.status]?.[0] || r.status}</span></td>
                  <td>{r.tracking ? (r.tracking_url ? <a href={r.tracking_url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{r.tracking}</a> : r.tracking) : '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
        <div className="card detail">
          {!current ? <div className="empty">Select an order to see its items.</div> : <>
            <div className="cardhead"><div><h3>{current.order_number} <span className={`statuspill ${STATUS[current.status]?.[1]}`}>{STATUS[current.status]?.[0]}</span></h3><div className="small">{chan(current)} · placed {new Date(current.placed_at).toLocaleString()}{current.shipped_at ? ` · shipped ${new Date(current.shipped_at).toLocaleString()}` : ''}</div></div></div>
            <div className="detailgrid">
              <div><div className="lbl">Ship to</div><div className="addr">{current.ship_to?.name}<br />{current.ship_to?.address1}<br />{[current.ship_to?.city, current.ship_to?.province_code, current.ship_to?.zip].filter(Boolean).join(', ')}</div></div>
              <div><div className="lbl">Shipment</div><div className="addr">{current.carrier ? <>{current.carrier}<br />{current.tracking_url ? <a href={current.tracking_url} target="_blank" rel="noopener">{current.tracking}</a> : current.tracking}</> : <span className="sm">Not shipped yet</span>}</div>{current.hold_reason && <div className="note" style={{ marginTop: 8 }}>On hold: {current.hold_reason}</div>}</div>
            </div>
            <table className="lines"><thead><tr><th>SKU</th><th>Item</th><th className="n">Qty</th></tr></thead><tbody>{lines.filter((l) => l.qty > 0).map((l) => <tr key={l.id}><td>{l.sku || '—'}</td><td>{l.name}</td><td className="n">{l.qty}</td></tr>)}</tbody></table>
          </>}
        </div>
      </div>
    </>
  );
}
