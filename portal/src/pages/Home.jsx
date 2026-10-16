import { useState } from 'react';
import { supabase, fmtDateTime, fmtDate, cutoffState, monthStart } from '../lib';
import { Pill, Kpi, Empty, useAsync, Modal, Field } from '../ui';

const OPEN = ['new', 'on_hold', 'backordered', 'picked', 'packed'];

export default function Home({ me, org, go, setOrg }) {
  if (me.isStaff && !org) return <Clients me={me} go={go} setOrg={setOrg} />;
  return <ClientHome me={me} org={org} go={go} />;
}

function ClientHome({ me, org, go }) {
  const { data } = useAsync(async () => {
    const since = new Date(); since.setDate(since.getDate() - 30);
    const [orders, inv, inbound, tickets, cutoffs] = await Promise.all([
      supabase.from('orders').select('id,status,placed_at,shipped_at,cutoff_at,received_at,order_number,customer_name,total_units').eq('org_id', org.id).gte('placed_at', since.toISOString()).order('placed_at', { ascending: false }),
      supabase.from('inventory_levels').select('*').eq('org_id', org.id).eq('is_physical', true).eq('active', true),
      supabase.from('inbound_shipments').select('*').eq('org_id', org.id).in('status', ['expected', 'in_transit']).order('expected_at'),
      supabase.from('tickets').select('id').eq('org_id', org.id).neq('status', 'closed'),
      supabase.from('orders').select('cutoff_at,shipped_at').eq('org_id', org.id).eq('status', 'shipped').gte('shipped_at', monthStart()),
    ]);
    return { orders: orders.data || [], inv: inv.data || [], inbound: inbound.data || [], tickets: tickets.data || [], cutoffs: cutoffs.data || [] };
  }, [org.id]);
  if (!data) return <Empty>Loading…</Empty>;
  const open = data.orders.filter((o) => OPEN.includes(o.status));
  const shippedMonth = data.cutoffs.length;
  const onTime = data.cutoffs.filter((o) => !o.cutoff_at || new Date(o.shipped_at) <= new Date(o.cutoff_at)).length;
  const low = data.inv.filter((s) => s.on_hand - s.reserved <= s.low_stock_threshold);
  const pct = shippedMonth ? Math.round((onTime / shippedMonth) * 100) : null;

  return (
    <>
      <div className="topbar">
        <div><h1>{org.name}</h1><div className="sub">Hillsborough, NJ · same-day cutoff {org.cutoff_time?.slice(0, 5)} ET Mon–Sat · <Pill s={org.status} /></div></div>
      </div>
      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <Kpi label="Open orders" value={open.length} hint={`${open.filter((o) => cutoffState(o)?.[0] === 'bad').length} past cutoff`} tone={open.some((o) => cutoffState(o)?.[0] === 'bad') ? 'bad' : ''} />
        <Kpi label="Shipped this month" value={shippedMonth} />
        <Kpi label="On-time (SLA 98%)" value={pct == null ? '—' : `${pct}%`} tone={pct == null ? '' : pct >= 98 ? 'ok' : 'warn'} hint="Shipped by cutoff" />
        <Kpi label="Units on hand" value={data.inv.reduce((a, s) => a + s.on_hand, 0).toLocaleString()} hint={low.length ? `${low.length} SKU${low.length > 1 ? 's' : ''} low` : 'Stock healthy'} tone={low.length ? 'warn' : ''} />
        <Kpi label="Open tickets" value={data.tickets.length} tone={data.tickets.length ? 'warn' : ''} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}><h3>Recent orders</h3><div className="spacer" /><button className="btn sm" onClick={() => go('orders')}>All orders →</button></div>
          {data.orders.length === 0 ? <Empty>No orders in the last 30 days.</Empty> : (
            <table><tbody>{data.orders.slice(0, 8).map((o) => { const c = cutoffState(o); return (
              <tr key={o.id}><td className="mono">{o.order_number}</td><td>{o.customer_name}</td><td className="small muted">{fmtDateTime(o.placed_at)}</td><td><Pill s={o.status} /></td><td>{c && <span className={`pill ${c[0]}`}>{c[1]}</span>}</td></tr>); })}</tbody></table>
          )}
        </div>
        <div className="stack">
          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}><h3>Low stock</h3><div className="spacer" /><button className="btn sm" onClick={() => go('inventory')}>Inventory →</button></div>
            {low.length === 0 ? <Empty>All SKUs above threshold.</Empty> : <table><tbody>{low.slice(0, 6).map((s) => <tr key={s.sku_id}><td className="mono">{s.sku}</td><td className="small">{s.name}</td><td className="num" style={{ fontWeight: 600, color: 'var(--warn)' }}>{s.on_hand - s.reserved}</td></tr>)}</tbody></table>}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}><h3>Inbound</h3></div>
            {data.inbound.length === 0 ? <Empty>Nothing expected.</Empty> : <table><tbody>{data.inbound.map((i) => <tr key={i.id}><td className="mono">{i.reference}</td><td className="small">{fmtDate(i.expected_at)}</td><td><Pill s={i.status} /></td></tr>)}</tbody></table>}
          </div>
        </div>
      </div>
    </>
  );
}

function Clients({ me, go, setOrg }) {
  const [creating, setCreating] = useState(false);
  const { data, reload } = useAsync(async () => {
    const [orgs, orders, tickets] = await Promise.all([
      supabase.from('orgs').select('*').order('name'),
      supabase.from('orders').select('org_id,status,cutoff_at').in('status', OPEN),
      supabase.from('tickets').select('org_id').neq('status', 'closed'),
    ]);
    return { orgs: orgs.data || [], orders: orders.data || [], tickets: tickets.data || [] };
  }, []);
  if (!data) return <Empty>Loading…</Empty>;
  const open = data.orders; const past = open.filter((o) => cutoffState(o)?.[0] === 'bad');
  return (
    <>
      <div className="topbar">
        <div><h1>ShipBay operations</h1><div className="sub">All clients · {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
        <div className="actions"><button className="btn" onClick={() => go('orders')}>Open order queue</button><button className="btn primary" onClick={() => setCreating(true)}>+ New client</button></div>
      </div>
      <div className="grid kpis" style={{ marginBottom: 14 }}>
        <Kpi label="Clients" value={data.orgs.length} hint={`${data.orgs.filter((o) => o.status === 'active').length} active`} />
        <Kpi label="Open orders" value={open.length} />
        <Kpi label="Past cutoff" value={past.length} tone={past.length ? 'bad' : 'ok'} />
        <Kpi label="Open tickets" value={data.tickets.length} tone={data.tickets.length ? 'warn' : ''} />
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Client</th><th>Status</th><th>Contact</th><th>Shopify</th><th className="num">Open orders</th><th className="num">Past cutoff</th><th className="num">Tickets</th><th></th></tr></thead>
          <tbody>{data.orgs.map((o) => {
            const oo = open.filter((x) => x.org_id === o.id); const pc = oo.filter((x) => cutoffState(x)?.[0] === 'bad').length; const tk = data.tickets.filter((t) => t.org_id === o.id).length;
            return (<tr key={o.id} className="click" onClick={() => setOrg(o)}>
              <td style={{ fontWeight: 600 }}>{o.name}<div className="small muted">{o.notes?.slice(0, 70)}</div></td><td><Pill s={o.status} /></td>
              <td className="small">{o.contact_name}<div className="muted">{o.contact_email}</div></td>
              <td>{o.shopify_domain ? <span className="pill ok">connected</span> : <span className="pill neutral">not connected</span>}</td>
              <td className="num">{oo.length}</td><td className="num" style={{ color: pc ? 'var(--bad)' : undefined, fontWeight: pc ? 600 : 400 }}>{pc}</td><td className="num">{tk}</td>
              <td style={{ textAlign: 'right' }}><button className="btn sm">Open →</button></td>
            </tr>);
          })}</tbody>
        </table>
      </div>
      {creating && <NewClient onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
    </>
  );
}

function NewClient({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', slug: '', contact_name: '', contact_email: '', shopify_domain: '', cutoff_time: '14:00', status: 'onboarding' }); const [err, setErr] = useState(null);
  const save = async () => {
    const slug = f.slug || f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const { data: org, error } = await supabase.from('orgs').insert({ ...f, slug, shopify_domain: f.shopify_domain || null }).select('id').single();
    if (error) return setErr(error.message);
    await supabase.from('rate_cards').insert({ org_id: org.id, label: 'Standard (<1,000 orders/mo)' });
    onSaved();
  };
  return (
    <Modal title="New client" sub="Creates the org with the standard rate card. Edit rates in the database or via a founding-terms row." onClose={onClose}>
      <div className="form-grid">
        <Field label="Brand name"><input type="text" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Contact name"><input type="text" value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} /></Field>
        <Field label="Contact email"><input type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} /></Field>
        <Field label="Shopify domain (x.myshopify.com)"><input type="text" value={f.shopify_domain} onChange={(e) => setF({ ...f, shopify_domain: e.target.value })} /></Field>
      </div>
      {err && <div className="alert bad">{err}</div>}
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={save}>Create client</button></div>
    </Modal>
  );
}
