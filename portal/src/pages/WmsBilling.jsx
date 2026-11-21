// Billing activity: every floor action the WMS and Nexus recorded (database triggers), by brand and month. Counts only:
// no rates are applied and nothing is invoiced from this screen.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
import { useBrands } from '../shared';
import { SOURCES } from './BillingSettings';
const LABEL = { pallet_received: 'Pallets received', carton_received: 'Cartons received', pallet_label_print: 'Pallet labels printed', carton_scan: 'Carton scans', pallet_counted: 'Pallets counted',
  pallet_putaway: 'Pallets put away', pallet_hold: 'Pallets put on hold', pallet_hold_released: 'Holds released', pallet_hold_voided: 'Holds voided', pallet_voided: 'Pallets voided',
  carton_open_box: 'Open-box units', pick: 'Units picked', pick_undone: 'Units un-picked', pack_scan: 'Units pack-checked', shipment: 'Shipments', cycle_count_scan: 'Cycle-count scans' };
const month = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export default function WmsBilling() {
  const [m, setM] = useState(month(new Date())); const [rows, setRows] = useState(null); const [recent, setRecent] = useState([]); const [err, setErr] = useState(null);
  useEffect(() => { setRows(null); Promise.all([supabase.rpc('wms_activity_summary', { p_month: `${m}-01` }), supabase.rpc('wms_activity_recent', { p_org: null, p_limit: 100 })]).then(([a, b]) => { setErr(a.error?.message || b.error?.message || null); setRows(a.data || []); setRecent(b.data || []); }); }, [m]);
  const [orgs] = useBrands(); const [org, setOrg] = useState(''); const [est, setEst] = useState(null); const [hand, setHand] = useState({});
  useEffect(() => { setEst(null); setHand({}); if (org) supabase.rpc('billing_estimate', { p_org: org, p_month: `${m}-01` }).then(({ data, error }) => { setEst(data || []); if (error) setErr(error.message); }); }, [org, m]);
  const qtyOf = (r) => (r.source === 'manual' ? Number(hand[r.code] || 0) : Number(r.qty || 0)); const total = (est || []).reduce((t, r) => t + qtyOf(r) * Number(r.rate), 0);
  const brands = useMemo(() => [...new Set((rows || []).map((r) => r.brand || 'No brand'))], [rows]);
  const csv = () => { const lines = [['Brand', 'Action', 'Events', 'Quantity', 'First', 'Last'], ...(rows || []).map((r) => [r.brand || '', LABEL[r.kind] || r.kind, r.events, r.qty, r.first_at, r.last_at])].map((l) => l.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `shipbay-wms-activity-${m}.csv`; a.click(); };
  return (
    <>
      <div className="pagehead"><div><h1>Billing<span className="dot">.</span></h1></div>
        <div className="glance"><div><small>Brands with activity</small><b>{brands.length}</b></div><div><small>Actions recorded</small><b>{(rows || []).reduce((t, r) => t + Number(r.events), 0).toLocaleString()}</b></div></div></div>
      <div className="opsbar"><input type="month" value={m} onChange={(e) => e.target.value && setM(e.target.value)} aria-label="Month" /><div className="spacer" /><button className="btn-sm" onClick={csv} disabled={!rows?.length}>Download CSV</button></div>
      {err && <div className="msg err">{err}</div>}
      <div className="card" style={{ marginBottom: 16 }} data-testid="billing-charges">
        <div className="cardhead"><h3>Charges for the month<span className="dot">.</span></h3><select aria-label="Charges brand" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">Choose a brand…</option>{(orgs || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        {!org ? <div className="empty">Pick a brand to work out its charges from its billing settings.</div> : est === null ? <div className="empty">Loading…</div> : est.length === 0 ? <div className="empty">No billing settings for this brand yet (Admin → Settings → Billing settings).</div> : <>
          <div className="tablewrap"><table className="ordertable"><thead><tr><th>Charge</th><th>Counted from</th><th className="n">Quantity</th><th className="n">Rate</th><th className="n">Amount</th></tr></thead>
            <tbody>{est.map((r) => <tr key={r.code}><td><b>{r.label}</b><div className="sm">{r.note}</div></td><td>{SOURCES[r.source] || r.source}</td>
              <td className="n">{r.source === 'manual' ? <input aria-label={`Quantity ${r.label}`} type="number" min="0" value={hand[r.code] || ''} onChange={(e) => setHand({ ...hand, [r.code]: e.target.value })} style={{ width: 90, textAlign: 'right' }} placeholder="0" /> : Number(r.qty).toLocaleString()}</td>
              <td className="n">${Number(r.rate)}/{r.unit}</td><td className="n">${(qtyOf(r) * Number(r.rate)).toFixed(2)}</td></tr>)}
              <tr><td colSpan={4}><b>Total (working figure, not an invoice)</b></td><td className="n"><b data-testid="billing-total">${total.toFixed(2)}</b></td></tr></tbody></table></div>
          <div className="sm" style={{ padding: '8px 16px' }}>Hand-entered quantities are not saved. Storage uses the pallets stored right now. Nothing here creates an invoice or reaches QuickBooks.</div></>}
      </div>
      {rows === null ? <div className="card"><div className="empty">Loading…</div></div> : rows.length === 0 ? <div className="card"><div className="empty">No WMS activity recorded in this month. Tracking started 2026-11-20; earlier work is not in this log.</div></div> : brands.map((b) => (
        <div className="card" style={{ marginBottom: 16 }} key={b} data-testid="billing-brand">
          <div className="cardhead"><h3>{b}<span className="dot">.</span></h3></div>
          <div className="tablewrap"><table className="ordertable"><thead><tr><th>Action</th><th className="n">Events</th><th className="n">Quantity</th><th>Last</th></tr></thead>
            <tbody>{rows.filter((r) => (r.brand || 'No brand') === b).map((r) => <tr key={r.kind}><td>{LABEL[r.kind] || r.kind}</td><td className="n">{Number(r.events).toLocaleString()}</td><td className="n">{Number(r.qty).toLocaleString()}</td><td>{new Date(r.last_at).toLocaleString()}</td></tr>)}</tbody></table></div>
        </div>))}
      <div className="card"><div className="cardhead"><h3>Latest activity<span className="dot">.</span></h3></div>
        <div className="tablewrap"><table className="ordertable"><thead><tr><th>When</th><th>Brand</th><th>Action</th><th className="n">Qty</th><th>Reference</th><th>By</th></tr></thead>
          <tbody>{recent.map((r, i) => <tr key={i}><td>{new Date(r.at).toLocaleString()}</td><td>{r.brand || '—'}</td><td>{LABEL[r.kind] || r.kind}</td><td className="n">{r.qty}</td><td>{r.ref || '—'}</td><td>{r.actor_name || '—'}</td></tr>)}</tbody></table></div>
        {recent.length === 0 && <div className="empty">Nothing recorded yet.</div>}</div>
    </>);
}
