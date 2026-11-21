// Billing activity: every floor action the WMS and Nexus recorded (database triggers), by brand and month. Counts only:
// no rates are applied and nothing is invoiced from this screen.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
const LABEL = { pallet_received: 'Pallets received', carton_received: 'Cartons received', pallet_label_print: 'Pallet labels printed', carton_scan: 'Carton scans', pallet_counted: 'Pallets counted',
  pallet_putaway: 'Pallets put away', pallet_hold: 'Pallets put on hold', pallet_hold_released: 'Holds released', pallet_hold_voided: 'Holds voided', pallet_voided: 'Pallets voided',
  carton_open_box: 'Open-box units', pick: 'Units picked', pick_undone: 'Units un-picked', pack_scan: 'Units pack-checked', shipment: 'Shipments', cycle_count_scan: 'Cycle-count scans' };
const month = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export default function WmsBilling() {
  const [m, setM] = useState(month(new Date())); const [rows, setRows] = useState(null); const [recent, setRecent] = useState([]); const [err, setErr] = useState(null);
  useEffect(() => { setRows(null); Promise.all([supabase.rpc('wms_activity_summary', { p_month: `${m}-01` }), supabase.rpc('wms_activity_recent', { p_org: null, p_limit: 100 })]).then(([a, b]) => { setErr(a.error?.message || b.error?.message || null); setRows(a.data || []); setRecent(b.data || []); }); }, [m]);
  const brands = useMemo(() => [...new Set((rows || []).map((r) => r.brand || 'No brand'))], [rows]);
  const csv = () => { const lines = [['Brand', 'Action', 'Events', 'Quantity', 'First', 'Last'], ...(rows || []).map((r) => [r.brand || '', LABEL[r.kind] || r.kind, r.events, r.qty, r.first_at, r.last_at])].map((l) => l.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `shipbay-wms-activity-${m}.csv`; a.click(); };
  return (
    <>
      <div className="pagehead"><div><h1>Billing<span className="dot">.</span></h1></div>
        <div className="glance"><div><small>Brands with activity</small><b>{brands.length}</b></div><div><small>Actions recorded</small><b>{(rows || []).reduce((t, r) => t + Number(r.events), 0).toLocaleString()}</b></div></div></div>
      <div className="opsbar"><input type="month" value={m} onChange={(e) => e.target.value && setM(e.target.value)} aria-label="Month" /><div className="spacer" /><button className="btn-sm" onClick={csv} disabled={!rows?.length}>Download CSV</button></div>
      {err && <div className="msg err">{err}</div>}
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
