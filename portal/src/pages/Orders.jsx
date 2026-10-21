// Orders — two levels. No brand picked: the overview, every open order across all brands sorted by ship-by, plus one
// Sync button that pulls each brand's orders from wherever they live. Click an order (or a brand card) → that brand's
// orders page: queue, detail, hold/release, packing slip, Pack & ship, and ⚙ Order settings (which systems we pull from).
import { useEffect, useMemo, useState } from 'react';
import { supabase, fn } from '../lib';
import { STATUS, SOURCE, dueClass, fmtDate, printPackingSlip } from '../ops';
import { useBrands, BrandPicker, BrandBar, CHANNELS, channelsLabel } from '../shared';
import { CreateOrder } from './PackShip';

const TABS = [['open', 'Open'], ['hold', 'On hold'], ['shipped', 'Shipped'], ['all', 'All']];
export const OPEN = ['new', 'picked', 'packed'];
const ago = (d) => { const h = (Date.now() - new Date(d)) / 36e5; return h < 1 ? 'just now' : h < 24 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`; };
const chan = (r) => r.marketplace || (r.channel === 'veeqo' ? 'Veeqo' : r.channel === 'manual' ? 'Manual' : SOURCE[r.source] || 'Shopify');

/** Sync every enabled channel for a brand. Returns a one-line summary. */
export async function syncBrand(o) {
  const c = o.order_channels || {};
  const out = [];
  if (c.veeqo) { const r = await fn('veeqo-sync', { action: 'backfill', org_id: o.id }); out.push(r.error ? `Veeqo: ${r.error}` : `Veeqo: ${r.imported} new, ${r.updated} updated${r.closed ? `, ${r.closed} closed` : ''}`); }
  if (c.shopify) { const r = await fn('shopify-sync', { action: 'backfill', org_id: o.id }); out.push(r.error ? `Shopify: ${r.error}` : `Shopify: ${r.imported} new, ${r.updated} updated`); }
  if (!out.length) out.push('no order system connected — turn one on under ⚙ Order settings');
  return `${o.name} — ${out.join(' · ')}`;
}

export default function Orders({ me, go, params, brand, setBrand }) {
  const [rows, setRows] = useState(null);
  const [orgs, reloadOrgs] = useBrands();
  const [tab, setTab] = useState('open');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(params?.order || null);
  const [lines, setLines] = useState([]);
  const [ships, setShips] = useState([]);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [holdNote, setHoldNote] = useState('');
  const [settings, setSettings] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    const { data: r } = await supabase.from('v_orders_queue').select('*').order('ship_by', { ascending: true, nullsFirst: false }).order('placed_at', { ascending: true }).limit(1500);
    setRows(r || []);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!sel) { setLines([]); setShips([]); return; }
    let live = true;
    Promise.all([supabase.from('order_lines').select('*').eq('order_id', sel).order('name'), supabase.from('shipments').select('*').eq('order_id', sel).order('created_at', { ascending: false })])
      .then(([{ data: l }, { data: s }]) => { if (live) { setLines(l || []); setShips(s || []); } });
    return () => { live = false; };
  }, [sel]);

  const org = (orgs || []).find((o) => o.id === brand) || null;
  const today = new Date().toISOString().slice(0, 10);
  const mine = useMemo(() => (rows || []).filter((r) => !brand || r.org_id === brand), [rows, brand]);
  const list = useMemo(() => mine.filter((r) =>
    (tab === 'all' || (tab === 'open' ? OPEN.includes(r.status) : tab === 'hold' ? ['on_hold', 'backordered'].includes(r.status) : r.status === tab))
    && (!q || [r.order_number, r.customer_name, r.marketplace, r.tracking, r.ship_to?.city, r.ship_to?.zip].filter(Boolean).some((s) => String(s).toLowerCase().includes(q.toLowerCase())))
  ), [mine, tab, q]);
  const current = (rows || []).find((r) => r.id === sel) || null;
  const counts = useMemo(() => ({ open: mine.filter((r) => OPEN.includes(r.status)).length, hold: mine.filter((r) => ['on_hold', 'backordered'].includes(r.status)).length,
    late: mine.filter((r) => OPEN.includes(r.status) && r.ship_by && r.ship_by < today).length, today: mine.filter((r) => OPEN.includes(r.status) && r.ship_by === today).length,
    shippedToday: mine.filter((r) => r.status === 'shipped' && r.shipped_at && r.shipped_at.slice(0, 10) === today).length }), [mine, today]);
  const brandStats = (o) => { const rs = (rows || []).filter((r) => r.org_id === o.id); const open = rs.filter((r) => OPEN.includes(r.status)); return [['Open', open.length], ['Late', open.filter((r) => r.ship_by && r.ship_by < today).length, open.some((r) => r.ship_by && r.ship_by < today)], ['Shipped today', rs.filter((r) => r.status === 'shipped' && r.shipped_at?.slice(0, 10) === today).length]]; };

  const sync = async () => {
    const targets = (orgs || []).filter((o) => !brand || o.id === brand);
    setBusy('sync'); setMsg(null);
    const out = []; for (const o of targets) out.push(await syncBrand(o));
    setBusy(null); setMsg({ kind: out.some((s) => /HTTP|isn’t|error|no order system/i.test(s)) ? 'err' : 'ok', text: out.join(' | ') });
    load();
  };
  const setStatus = async (status, extra = {}) => {
    if (!current) return; setBusy('status');
    const { error } = await supabase.from('orders').update({ status, ...extra }).eq('id', current.id);
    setBusy(null); if (error) return setMsg({ kind: 'err', text: error.message });
    setHoldNote(''); load();
  };
  const openOrder = (r) => { setBrand(r.org_id); setSel(r.id); };

  /* ---------- level 1: overview ---------- */
  if (!brand) {
    const open = (rows || []).filter((r) => OPEN.includes(r.status));
    return (
      <>
        <div className="pagehead">
          <div><h1>Orders<span className="dot">.</span></h1><p className="sub">Every brand, every open order, earliest deadline first. Click one to work in that brand.</p></div>
          <div className="glance">
            <div><small>Open</small><b>{open.length}</b></div>
            <div><small>Due today</small><b className={counts.today ? 'hot' : ''}>{counts.today}</b></div>
            <div><small>Late</small><b className={counts.late ? 'hot' : ''}>{counts.late}</b></div>
            <div><small>Shipped today</small><b>{counts.shippedToday}</b></div>
          </div>
        </div>
        {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
        <div className="opsbar">
          <input className="search" placeholder="Search order #, customer, marketplace, tracking…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="spacer" />
          <button className="btn-sm primary" disabled={busy === 'sync'} onClick={sync}>{busy === 'sync' ? 'Syncing…' : '↻ Sync all brands'}</button>
        </div>
        <BrandPicker orgs={orgs} onPick={setBrand} stats={brandStats} title="Brands" hint="click to open that brand’s orders" />
        <div className="card overview" style={{ marginTop: 18 }}>
          <div className="cardhead"><h3>Open orders — all brands</h3><span className="sm">{open.length} open</span></div>
          {rows === null ? <div className="empty">Loading…</div> : open.length === 0 ? <div className="empty">Nothing open. New orders appear here as they come in; press Sync to catch up.</div> : (
            <div className="tablewrap"><table className="ordertable">
              <thead><tr><th>Order</th><th>Brand</th><th>Channel</th><th>Ship by</th><th>Customer</th><th>Units</th><th>Status</th></tr></thead>
              <tbody>{open.filter((r) => !q || [r.order_number, r.customer_name, r.marketplace, r.org_name].filter(Boolean).some((s) => String(s).toLowerCase().includes(q.toLowerCase()))).map((r) => (
                <tr key={r.id} onClick={() => openOrder(r)}>
                  <td><b>{r.order_number}</b><div className="sm">{ago(r.placed_at)}</div></td>
                  <td>{r.org_name}</td>
                  <td><span className={`pill ${r.marketplace ? 'connected' : ''}`}>{chan(r)}</span></td>
                  <td className={`due ${dueClass(r.ship_by)}`}>{r.ship_by ? fmtDate(r.ship_by) : '—'}</td>
                  <td>{r.customer_name}<div className="sm">{[r.ship_to?.city, r.ship_to?.province_code].filter(Boolean).join(', ')}{r.is_international ? ' · intl' : ''}</div></td>
                  <td>{r.units}</td>
                  <td><span className={`statuspill ${STATUS[r.status]?.[1]}`}>{STATUS[r.status]?.[0] || r.status}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </>
    );
  }

  /* ---------- level 2: one brand ---------- */
  return (
    <>
      <BrandBar org={org} onBack={() => { setBrand(null); setSel(null); }}>
        <button className="btn-sm" onClick={() => setCreating(true)}>+ Create order</button>
        <button className="btn-sm" disabled={busy === 'sync'} onClick={sync}>{busy === 'sync' ? 'Syncing…' : '↻ Sync'}</button>
        <button className="btn-sm primary" onClick={() => go('pack', { org: brand })}>Pack &amp; Ship →</button>
        <button className="gear" title="Order settings — where this brand’s orders come from" onClick={() => setSettings(true)}>⚙</button>
      </BrandBar>
      <div className="pagehead">
        <div><h1>{org?.name || 'Orders'}<span className="dot">.</span></h1><p className="sub">Orders{channelsLabel(org)}. Sorted by ship-by date.</p></div>
        <div className="glance">
          <div><small>Open</small><b>{counts.open}</b></div>
          <div><small>Due today</small><b className={counts.today ? 'hot' : ''}>{counts.today}</b></div>
          <div><small>Late</small><b className={counts.late ? 'hot' : ''}>{counts.late}</b></div>
          <div><small>Shipped today</small><b>{counts.shippedToday}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="opsbar"><input className="search" placeholder="Search order #, customer, marketplace, tracking…" value={q} onChange={(e) => setQ(e.target.value)} /></div>

      <div className="ops">
        <div className="card queue">
          <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'open' && counts.open ? <i>{counts.open}</i> : null}{k === 'hold' && counts.hold ? <i>{counts.hold}</i> : null}</button>)}</div>
          {rows === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">{tab === 'open' ? 'No open orders for this brand. Press Sync to pull in anything new.' : 'Nothing here.'}</div> : (
            <div className="tablewrap"><table className="ordertable">
              <thead><tr><th>Order</th><th>Channel</th><th>Ship by</th><th>Customer</th><th>Units</th><th>Status</th></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.id} className={r.id === sel ? 'active' : ''} onClick={() => setSel(r.id)}>
                  <td><b>{r.order_number}</b><div className="sm">{ago(r.placed_at)}</div></td>
                  <td><span className={`pill ${r.marketplace ? 'connected' : ''}`}>{chan(r)}</span></td>
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
                <div className="small">{chan(current)} · placed {new Date(current.placed_at).toLocaleString()}{current.ship_by ? ` · ship by ${fmtDate(current.ship_by)}` : ''}</div></div>
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
                <button className="btn-sm reject" disabled={busy === 'status'} onClick={() => { if (window.confirm(`Cancel ${current.order_number} in the warehouse queue? (This does not cancel it in ${chan(current)}.)`)) setStatus('cancelled'); }}>Cancel</button>
              </div>
            )}
          </>}
        </div>
      </div>

      {settings && org && <OrderSettings org={org} onClose={() => setSettings(false)} onSaved={() => { reloadOrgs(); setSettings(false); setMsg({ kind: 'ok', text: 'Order settings saved.' }); }} />}
      {creating && org && <CreateOrder org={org} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); load(); setSel(id); setTab('open'); }} />}
    </>
  );
}

/* ---------- ⚙ Order settings: which systems we pull this brand's orders from ---------- */
export function OrderSettings({ org, onClose, onSaved }) {
  const [c, setC] = useState({ shopify: false, veeqo: false, manual: true, ...(org.order_channels || {}) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const desc = { veeqo: 'Pull open orders from the brand’s Veeqo account (which already gathers their Shopify + marketplace orders). Tracking goes back to Veeqo.', shopify: 'Pull orders straight from their Shopify store (needs the Shopify connection under Onboarding → Systems). Tracking goes back to Shopify.', manual: 'Orders keyed in by staff — samples, replacements, wholesale. Always available.' };
  const save = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from('orgs').update({ order_channels: { ...c, manual: true } }).eq('id', org.id);
    setBusy(false); if (error) return setErr(error.message); onSaved();
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Order settings — {org.name}<span className="dot">.</span></h3>
        <p className="sm" style={{ marginBottom: 12 }}>Where do this brand’s orders come from? Sync pulls from every system that’s on.</p>
        {err && <div className="msg err">{err}</div>}
        <div className="chanlist">
          {CHANNELS.map(([k, l]) => (
            <label key={k} className={c[k] ? 'on' : ''}><input type="checkbox" checked={!!c[k] || k === 'manual'} disabled={k === 'manual'} onChange={(e) => setC({ ...c, [k]: e.target.checked })} /><div><b>{l}</b><div className="d">{desc[k]}</div></div></label>
          ))}
        </div>
        <div className="actions"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
      </div>
    </div>
  );
}
