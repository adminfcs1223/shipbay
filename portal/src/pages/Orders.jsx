import { useState } from 'react';
import { supabase, fmtDateTime, fmtMoney, cutoffState, callFn } from '../lib';
import { Pill, Kpi, Modal, Field, Empty, useAsync, Seg } from '../ui';

const OPEN = ['new', 'on_hold', 'backordered', 'picked', 'packed'];

export default function Orders({ me, org }) {
  const [view, setView] = useState('open');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const staff = me.isStaff;

  const { data, loading, reload } = useAsync(async () => {
    let qry = supabase.from('orders').select('*, order_lines(*), shipments(*)').order('placed_at', { ascending: false }).limit(300);
    if (org) qry = qry.eq('org_id', org.id);
    if (view === 'open') qry = qry.in('status', OPEN);
    else if (view === 'shipped') qry = qry.eq('status', 'shipped');
    const { data, error } = await qry;
    if (error) throw error;
    return data;
  }, [view, org?.id]);

  const rows = (data || []).filter((o) => !q || [o.order_number, o.customer_name, o.customer_email, o.ship_to?.city].join(' ').toLowerCase().includes(q.toLowerCase()));
  const open = (data || []).filter((o) => OPEN.includes(o.status));
  const past = open.filter((o) => cutoffState(o)?.[0] === 'bad').length;
  const dueToday = open.filter((o) => o.cutoff_at && new Date(o.cutoff_at).toDateString() === new Date().toDateString()).length;
  const todayShipped = (data || []).filter((o) => o.shipped_at && new Date(o.shipped_at).toDateString() === new Date().toDateString()).length;

  return (
    <>
      <div className="topbar">
        <div><h1>Orders</h1><div className="sub">Same-day cutoff {org ? org.cutoff_time?.slice(0, 5) : '2:00 PM'} ET · Mon–Sat</div></div>
        <div className="actions">
          <input type="text" placeholder="Search order, customer, city…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
          <Seg value={view} onChange={setView} options={[['open', 'Open'], ['shipped', 'Shipped'], ['all', 'All']]} />
        </div>
      </div>

      {view === 'open' && (
        <div className="grid kpis" style={{ marginBottom: 14 }}>
          <Kpi label="Open orders" value={open.length} />
          <Kpi label="Due today" value={dueToday} tone={dueToday ? 'warn' : ''} hint="Must ship by cutoff" />
          <Kpi label="Past cutoff" value={past} tone={past ? 'bad' : 'ok'} hint={past ? 'SLA at risk' : 'On track'} />
          <Kpi label="Shipped today" value={todayShipped} tone="ok" />
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        {loading ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No orders{view === 'open' ? ' in the queue' : ''}.</Empty> : (
          <table>
            <thead><tr>
              <th>Order</th>{!org && <th>Client</th>}<th>Customer</th><th>Ship to</th><th className="num">Units</th><th>Placed</th><th>Status</th><th>Cutoff</th><th>Tracking</th>
            </tr></thead>
            <tbody>
              {rows.map((o) => {
                const c = cutoffState(o); const sh = o.shipments?.[0];
                return (
                  <tr key={o.id} className="click" onClick={() => setSel(o)}>
                    <td className="mono">{o.order_number}</td>
                    {!org && <td className="small muted">{me.orgNames?.[o.org_id] || '—'}</td>}
                    <td>{o.customer_name}<div className="small muted">{o.shipping_method}</div></td>
                    <td className="small">{o.ship_to?.city}, {o.ship_to?.province || o.ship_to?.country}{o.is_international && <span className="pill info" style={{ marginLeft: 6 }}>INTL</span>}</td>
                    <td className="num">{o.total_units}</td>
                    <td className="small">{fmtDateTime(o.placed_at)}</td>
                    <td><Pill s={o.status} /></td>
                    <td>{c ? <span className={`pill ${c[0]}`}>{c[1]}</span> : o.shipped_at ? <span className="small muted">{fmtDateTime(o.shipped_at)}</span> : '—'}</td>
                    <td className="mono small">{sh ? `${sh.carrier} ${sh.tracking?.slice(-8)}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {sel && <OrderModal order={sel} staff={staff} onClose={() => setSel(null)} onChange={() => { reload(); setSel(null); }} />}
    </>
  );
}

function OrderModal({ order: o, staff, onClose, onChange }) {
  const [tab, setTab] = useState('detail');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [f, setF] = useState({ carrier: 'USPS', service: o.shipping_method?.replace('USPS ', '') || 'Ground Advantage', tracking: '', label_source: 'client_shopify', label_cost: '', packaging: 'mailer', weight_oz: '' });
  const sh = o.shipments?.[0];

  const setStatus = async (status) => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from('orders').update({ status }).eq('id', o.id);
    setBusy(false); if (error) setErr(error.message); else onChange();
  };
  const ship = async () => {
    if (!f.tracking) return setErr('Tracking number is required.');
    setBusy(true); setErr(null);
    const { data: shipId, error } = await supabase.rpc('ship_order', {
      p_order_id: o.id, p_carrier: f.carrier, p_service: f.service, p_tracking: f.tracking, p_label_source: f.label_source,
      p_label_cost: f.label_cost === '' ? null : Number(f.label_cost), p_packaging: f.packaging, p_weight_oz: f.weight_oz === '' ? null : Number(f.weight_oz),
    });
    if (error) { setBusy(false); return setErr(error.message); }
    try { await callFn('shopify-fulfill', { shipment_id: shipId }); } catch { /* Shopify not connected yet */ }
    setBusy(false); onChange();
  };

  const c = cutoffState(o);
  return (
    <Modal title={`Order ${o.order_number}`} sub={`${o.customer_name} · placed ${fmtDateTime(o.placed_at)}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}>
        <Pill s={o.status} />{c && <span className={`pill ${c[0]}`}>{c[1]}</span>}{o.is_international && <span className="pill info">International</span>}
        {o.tags?.map((t) => <span key={t} className="pill neutral">{t}</span>)}
        <div className="spacer" />
        {staff && <Seg value={tab} onChange={setTab} options={[['detail', 'Detail'], ['ship', o.status === 'shipped' ? 'Shipment' : 'Ship it']]} />}
      </div>

      {tab === 'detail' && (
        <div className="stack">
          <div className="form-grid">
            <div><h3>Ship to</h3><div style={{ marginTop: 6 }}>{o.ship_to?.name}<br />{o.ship_to?.address1}{o.ship_to?.address2 && <>, {o.ship_to.address2}</>}<br />{o.ship_to?.city}, {o.ship_to?.province} {o.ship_to?.zip}<br />{o.ship_to?.country}</div></div>
            <div><h3>Service</h3><div style={{ marginTop: 6 }}>{o.shipping_method || '—'}<div className="small muted">{o.customer_email}</div></div></div>
            {sh && <div><h3>Shipment</h3><div style={{ marginTop: 6 }}>{sh.carrier} {sh.service}<div className="mono small">{sh.tracking}</div><div className="small muted">{fmtDateTime(sh.shipped_at)} · {sh.label_source === 'client_shopify' ? 'label on client account' : 'ShipBay label'}{sh.label_cost != null && ` · ${fmtMoney(sh.label_cost)}`}</div></div></div>}
          </div>
          <div>
            <h3>Items</h3>
            <table style={{ marginTop: 6 }}>
              <thead><tr><th>SKU</th><th>Item</th><th className="num">Qty</th></tr></thead>
              <tbody>{o.order_lines?.filter((l) => l.qty > 0).map((l) => <tr key={l.id}><td className="mono">{l.sku || '—'}{!l.sku_id && l.is_physical && <span className="pill warn" style={{ marginLeft: 6 }}>unmapped</span>}</td><td>{l.name}{!l.is_physical && <span className="muted small"> (non-physical)</span>}</td><td className="num">{l.qty}</td></tr>)}</tbody>
            </table>
          </div>
          {o.notes && <div><h3>Order note</h3><div style={{ marginTop: 6 }}>{o.notes}</div></div>}
          {err && <div className="alert bad">{err}</div>}
          <div className="row">
            {!staff && ['new', 'on_hold'].includes(o.status) && (<>
              {o.status === 'new' && <button className="btn" disabled={busy} onClick={() => setStatus('on_hold')}>Put on hold</button>}
              {o.status === 'on_hold' && <button className="btn" disabled={busy} onClick={() => setStatus('new')}>Release hold</button>}
              <button className="btn" disabled={busy} onClick={() => confirm('Cancel this order at the warehouse? It will not ship.') && setStatus('cancelled')}>Cancel</button>
            </>)}
            {staff && o.status !== 'shipped' && o.status !== 'cancelled' && (<>
              {o.status !== 'picked' && o.status !== 'packed' && <button className="btn" disabled={busy} onClick={() => setStatus('picked')}>Mark picked</button>}
              {o.status === 'picked' && <button className="btn" disabled={busy} onClick={() => setStatus('packed')}>Mark packed</button>}
              {o.status !== 'on_hold' && <button className="btn" disabled={busy} onClick={() => setStatus('on_hold')}>Hold</button>}
              {o.status === 'on_hold' && <button className="btn" disabled={busy} onClick={() => setStatus('new')}>Release</button>}
              {o.status !== 'backordered' && <button className="btn" disabled={busy} onClick={() => setStatus('backordered')}>Backorder</button>}
              <div className="spacer" /><button className="btn primary" onClick={() => setTab('ship')}>Ship it →</button>
            </>)}
          </div>
        </div>
      )}

      {tab === 'ship' && staff && (o.status === 'shipped' ? (
        <div className="alert ok">Shipped {fmtDateTime(o.shipped_at)} · {sh?.carrier} {sh?.tracking}</div>
      ) : (
        <div className="stack">
          <div className="form-grid">
            <Field label="Carrier"><select value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })}>{['USPS', 'UPS', 'FedEx', 'DHL', 'Other'].map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Service"><input type="text" value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })} /></Field>
            <Field label="Tracking number"><input type="text" autoFocus value={f.tracking} onChange={(e) => setF({ ...f, tracking: e.target.value.trim() })} placeholder="Scan or paste" /></Field>
            <Field label="Label bought on"><select value={f.label_source} onChange={(e) => setF({ ...f, label_source: e.target.value })}><option value="client_shopify">Client's Shopify account</option><option value="shipbay_platform">ShipBay platform (bill postage)</option><option value="other">Other</option></select></Field>
            <Field label="Label cost ($)"><input type="number" step="0.01" value={f.label_cost} onChange={(e) => setF({ ...f, label_cost: e.target.value })} /></Field>
            <Field label="Packaging"><select value={f.packaging} onChange={(e) => setF({ ...f, packaging: e.target.value })}><option value="mailer">Poly mailer</option><option value="box_single">Box (single wall)</option><option value="box_double">Box (double wall)</option><option value="client_supplied">Client supplied</option></select></Field>
            <Field label="Weight (oz)"><input type="number" step="0.1" value={f.weight_oz} onChange={(e) => setF({ ...f, weight_oz: e.target.value })} /></Field>
          </div>
          <div className="alert info small">Shipping deducts inventory for each mapped SKU and pushes tracking to Shopify (customer gets the notification) when the store is connected.</div>
          {err && <div className="alert bad">{err}</div>}
          <div className="row"><div className="spacer" /><button className="btn primary" disabled={busy} onClick={ship}>{busy ? 'Shipping…' : 'Confirm shipped'}</button></div>
        </div>
      ))}
    </Modal>
  );
}
