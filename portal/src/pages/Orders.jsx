// Orders — every order flowing in from connected stores (Shopify, incl. the marketplace orders Mirakl Connect relays
// into Shopify), sorted by ship-by deadline. Staff can hold/release, print packing slips and jump into Pack & Ship.
import { useEffect, useMemo, useState } from 'react';
import { supabase, fn } from '../lib';
import { STATUS, SOURCE, dueClass, fmtDate, printPackingSlip } from '../ops';

const TABS = [['open', 'Open'], ['hold', 'On hold'], ['shipped', 'Shipped'], ['all', 'All']];
const OPEN = ['new', 'picked', 'packed'];
const ago = (d) => { const h = (Date.now() - new Date(d)) / 36e5; return h < 1 ? 'just now' : h < 24 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`; };

export default function Orders({ me, go, params }) {
  const [rows, setRows] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [tab, setTab] = useState('open');
  const [org, setOrg] = useState(params?.org || '');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(params?.order || null);
  const [lines, setLines] = useState([]);
  const [ships, setShips] = useState([]);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [holdNote, setHoldNote] = useState('');

  const load = async () => {
    const [{ data: r }, { data: o }] = await Promise.all([
      supabase.from('v_orders_queue').select('*').order('ship_by', { ascending: true, nullsFirst: false }).order('placed_at', { ascending: true }).limit(1000),
      supabase.from('orgs').select('id, name, status, shopify_domain').order('name'),
    ]);
    setRows(r || []); setOrgs(o || []);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!sel) { setLines([]); setShips([]); return; }
    let live = true;
    Promise.all([supabase.from('order_lines').select('*').eq('order_id', sel).order('name'), supabase.from('shipments').select('*').eq('order_id', sel).order('created_at', { ascending: false })])
      .then(([{ data: l }, { data: s }]) => { if (live) { setLines(l || []); setShips(s || []); } });
    return () => { live = false; };
  }, [sel]);

  const list = useMemo(() => (rows || []).filter((r) =>
    (tab === 'all' || (tab === 'open' ? OPEN.includes(r.status) : tab === 'hold' ? ['on_hold', 'backordered'].includes(r.status) : r.status === tab))
    && (!org || r.org_id === org)
    && (!q || [r.order_number, r.customer_name, r.marketplace, r.tracking, r.ship_to?.city, r.ship_to?.zip].filter(Boolean).some((s) => String(s).toLowerCase().includes(q.toLowerCase())))
  ), [rows, tab, org, q]);
  const current = (rows || []).find((r) => r.id === sel) || null;
  const today = new Date().toISOString().slice(0, 10);
  const glance = useMemo(() => {
    const open = (rows || []).filter((r) => OPEN.includes(r.status) && (!org || r.org_id === org));
    return { open: open.length, late: open.filter((r) => r.ship_by && r.ship_by < today).length, today: open.filter((r) => r.ship_by === today).length,
      shippedToday: (rows || []).filter((r) => r.status === 'shipped' && r.shipped_at && r.shipped_at.slice(0, 10) === today && (!org || r.org_id === org)).length };
  }, [rows, org, today]);
  const counts = useMemo(() => ({ open: (rows || []).filter((r) => OPEN.includes(r.status)).length, hold: (rows || []).filter((r) => ['on_hold', 'backordered'].includes(r.status)).length }), [rows]);

  const sync = async () => {
    const targets = orgs.filter((o) => o.shopify_domain && (!org || o.id === org));
    if (!targets.length) return setMsg({ kind: 'err', text: 'No client has Shopify connected yet — connect it under Onboarding → Systems first.' });
    setBusy('sync'); setMsg(null);
    const out = [];
    for (const o of targets) { const r = await fn('shopify-sync', { action: 'backfill', org_id: o.id }); out.push(r.error ? `${o.name}: ${r.error}` : `${o.name}: ${r.imported} new, ${r.updated} updated (${r.total} open in Shopify)`); }
    setBusy(null); setMsg({ kind: out.some((s) => /HTTP|isn’t|error/i.test(s)) ? 'err' : 'ok', text: out.join(' · ') });
    load();
  };
  const setStatus = async (status, extra = {}) => {
    if (!current) return; setBusy('status');
    const { error } = await supabase.from('orders').update({ status, ...extra }).eq('id', current.id);
    setBusy(null); if (error) return setMsg({ kind: 'err', text: error.message });
    setHoldNote(''); load();
  };
  const orgName = (id) => orgs.find((o) => o.id === id)?.name || '';

  return (
    <>
      <div className="pagehead">
        <div><h1>Orders<span className="dot">.</span></h1><p className="sub">Everything coming in from connected stores, sorted by ship-by date. Marketplace orders (Nordstrom, Kohl’s, …) arrive through Shopify via Mirakl Connect.</p></div>
        <div className="glance">
          <div><small>Open</small><b>{glance.open}</b></div>
          <div><small>Due today</small><b className={glance.today ? 'hot' : ''}>{glance.today}</b></div>
          <div><small>Late</small><b className={glance.late ? 'hot' : ''}>{glance.late}</b></div>
          <div><small>Shipped today</small><b>{glance.shippedToday}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="opsbar">
        <select value={org} onChange={(e) => setOrg(e.target.value)}><option value="">All clients</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <input className="search" placeholder="Search order #, customer, marketplace, tracking…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <button className="btn-sm" disabled={busy === 'sync'} onClick={sync}>{busy === 'sync' ? 'Syncing…' : '↻ Sync from Shopify'}</button>
        <button className="btn-sm primary" onClick={() => go('pack', { org })}>Pack &amp; Ship →</button>
      </div>

      <div className="ops">
        <div className="card queue">
          <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'open' && counts.open ? <i>{counts.open}</i> : null}{k === 'hold' && counts.hold ? <i>{counts.hold}</i> : null}</button>)}</div>
          {rows === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">{tab === 'open' ? 'No open orders. New ones show up here the moment Shopify sends them.' : 'Nothing here.'}</div> : (
            <div className="tablewrap"><table className="ordertable">
              <thead><tr><th>Order</th><th>Channel</th><th>Ship by</th><th>Customer</th><th>Units</th><th>Status</th></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.id} className={r.id === sel ? 'active' : ''} onClick={() => setSel(r.id)}>
                  <td><b>{r.order_number}</b><div className="sm">{r.org_name} · {ago(r.placed_at)}</div></td>
                  <td>{r.marketplace ? <span className="pill connected">{r.marketplace}</span> : <span className="pill">{SOURCE[r.source] || r.source || 'Shopify'}</span>}</td>
                  <td className={`due ${dueClass(r.ship_by)}`}>{r.ship_by ? fmtDate(r.ship_by) : '—'}</td>
                  <td>{r.customer_name}<div className="sm">{[r.ship_to?.city, r.ship_to?.province_code].filter(Boolean).join(', ')}{r.is_international ? ' · intl' : ''}</div></td>
                  <td>{r.units}{r.status !== 'shipped' && r.units_verified > 0 ? <div className="sm">{r.units_verified} verified</div> : null}</td>
                  <td><span className={`statuspill ${STATUS[r.status]?.[1]}`}>{STATUS[r.status]?.[0] || r.status}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>

        <div className="card detail">
          {!current ? <div className="empty">Select an order.</div> : <>
            <div className="cardhead">
              <div><h3>{current.order_number} <span className={`statuspill ${STATUS[current.status]?.[1]}`}>{STATUS[current.status]?.[0]}</span></h3>
                <div className="small">{current.org_name} · {current.marketplace || SOURCE[current.source] || 'Shopify'} · placed {new Date(current.placed_at).toLocaleString()}{current.ship_by ? ` · ship by ${fmtDate(current.ship_by)}` : ''}</div></div>
              <div className="spacer" />
              <button className="btn-sm" onClick={() => printPackingSlip(current, lines, current.org_name)}>Packing slip</button>
              {OPEN.includes(current.status) && <button className="btn-sm primary" onClick={() => go('pack', { order: current.id, org: current.org_id })}>Pack &amp; ship →</button>}
            </div>
            <div className="detailgrid">
              <div>
                <div className="lbl">Ship to</div>
                <div className="addr">{current.ship_to?.name}<br />{current.ship_to?.company && <>{current.ship_to.company}<br /></>}{current.ship_to?.address1}<br />{current.ship_to?.address2 && <>{current.ship_to.address2}<br /></>}{[current.ship_to?.city, current.ship_to?.province_code, current.ship_to?.zip].filter(Boolean).join(', ')}{current.ship_to?.country_code && current.ship_to.country_code !== 'US' ? <><br />{current.ship_to.country}</> : null}{current.ship_to?.phone && <><br />{current.ship_to.phone}</>}</div>
                {current.shipping_method && <div className="sm" style={{ marginTop: 6 }}>Method: {current.shipping_method}</div>}
              </div>
              <div>
                <div className="lbl">Tags &amp; notes</div>
                <div className="tags">{(current.tags || []).map((t) => <span key={t} className="pill">{t}</span>)}{!current.tags?.length && <span className="sm">none</span>}</div>
                {current.notes && <div className="note" style={{ marginTop: 8 }}>{current.notes}</div>}
                {current.hold_reason && <div className="note" style={{ marginTop: 8 }}>Hold: {current.hold_reason}</div>}
              </div>
            </div>
            <table className="lines"><thead><tr><th>SKU</th><th>Item</th><th className="n">Qty</th>{current.status !== 'shipped' && <th className="n">Verified</th>}</tr></thead>
              <tbody>{lines.filter((l) => l.qty > 0).map((l) => <tr key={l.id} className={l.is_physical ? '' : 'muted'}><td>{l.sku || '—'}</td><td>{l.name}{!l.is_physical && ' (no shipping)'}</td><td className="n">{l.qty}</td>{current.status !== 'shipped' && <td className="n">{l.qty_verified}/{l.qty}</td>}</tr>)}</tbody></table>
            {ships.length > 0 && <div className="shipments">{ships.map((s) => <div key={s.id} className="ship"><b>{s.carrier}{s.service ? ` · ${s.service}` : ''}</b> {s.tracking_url ? <a href={s.tracking_url} target="_blank" rel="noopener">{s.tracking}</a> : s.tracking}{s.label_cost != null && ` · $${Number(s.label_cost).toFixed(2)}`} · {new Date(s.shipped_at || s.created_at).toLocaleString()}{s.label_path && <> · <button className="linkbtn" onClick={async () => { const r = await fn('labels', { action: 'label_url', shipment_id: s.id }); if (r.label_url) window.open(r.label_url, '_blank'); }}>label</button></>}</div>)}</div>}
            {current.status !== 'shipped' && current.status !== 'cancelled' && (
              <div className="actions">
                {['on_hold', 'backordered'].includes(current.status) ? <button className="btn-sm primary" disabled={busy === 'status'} onClick={() => setStatus('new', { hold_reason: null })}>Release hold</button> : <>
                  <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Hold reason</label><input value={holdNote} onChange={(e) => setHoldNote(e.target.value)} placeholder="e.g. address needs confirming, waiting on stock" /></div>
                  <button className="btn-sm" disabled={busy === 'status'} onClick={() => setStatus('on_hold', { hold_reason: holdNote || null })}>Put on hold</button>
                </>}
                <button className="btn-sm reject" disabled={busy === 'status'} onClick={() => { if (window.confirm(`Cancel ${current.order_number} in the warehouse queue? (This does not cancel it in Shopify.)`)) setStatus('cancelled'); }}>Cancel</button>
              </div>
            )}
          </>}
        </div>
      </div>
    </>
  );
}
