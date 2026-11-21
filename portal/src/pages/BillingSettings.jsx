// Billing settings: each brand's rates, as agreed with that brand. A rate either counts itself from tracked WMS activity
// ("Counted from") or is entered by hand on the Billing page. Admin only to change.
import { useEffect, useState } from 'react';
import { supabase } from '../lib';
import { useBrands } from '../shared';
export const SOURCES = { manual: 'Entered by hand', pallet_received: 'Pallets received', stored_pallets_53cuft: 'Stored pallets x 53 cu ft', shipment: 'Shipments', pick_units: 'Units picked',
  pack_scan: 'Units pack-checked', carton_scan: 'Carton scans', pallet_label_print: 'Pallet labels printed', pallet_putaway: 'Pallets put away', cycle_count_scan: 'Cycle-count scans' };
const BLANK = { code: '', label: '', unit: '', rate: '', source: 'manual', note: '', active: true };
export default function BillingSettings({ me }) {
  const [orgs] = useBrands(); const [org, setOrg] = useState(''); const [rows, setRows] = useState(null); const [f, setF] = useState(null); const [msg, setMsg] = useState(null);
  const admin = me?.role === 'shipbay_admin';
  const load = () => (org ? supabase.rpc('billing_rates_list', { p_org: org }).then(({ data, error }) => { setRows(data || []); if (error) setMsg({ kind: 'err', text: error.message }); }) : setRows(null));
  useEffect(() => { load(); }, [org]);
  const save = async (e) => {
    e.preventDefault(); setMsg(null);
    const { error } = await supabase.rpc('billing_rate_save', { p_org: org, p_code: f.code, p_label: f.label, p_unit: f.unit, p_rate: Number(f.rate), p_source: f.source, p_note: f.note, p_active: f.active });
    if (error) return setMsg({ kind: 'err', text: error.message }); setF(null); setMsg({ kind: 'ok', text: 'Saved.' }); load();
  };
  return (
    <div className="card" style={{ marginTop: 16 }} data-testid="billing-settings">
      <div className="cardhead"><h3>Billing settings<span className="dot">.</span></h3>
        <select aria-label="Billing brand" value={org} onChange={(e) => { setOrg(e.target.value); setF(null); }}><option value="">Choose a brand…</option>{(orgs || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {!org ? <div className="empty">Pick a brand to see or set its rates.</div> : rows === null ? <div className="empty">Loading…</div> : <>
        <div className="tablewrap"><table className="ordertable"><thead><tr><th>Charge</th><th className="n">Rate</th><th>Per</th><th>Counted from</th><th>Note</th><th /></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className={r.active ? '' : 'muted'}><td><b>{r.label}</b>{!r.active && ' (off)'}</td><td className="n">${Number(r.rate).toFixed(Number(r.rate) * 100 % 1 ? 3 : 2)}</td><td>{r.unit}</td><td>{SOURCES[r.source] || r.source}</td><td className="sm">{r.note}</td>
            <td>{admin && <button className="btn-xs" onClick={() => setF({ ...r, rate: String(r.rate), note: r.note || '' })}>Edit</button>}</td></tr>)}</tbody></table></div>
        {rows.length === 0 && <div className="empty">No rates set for this brand.</div>}
        {admin && !f && <div className="actions"><button className="btn-sm" onClick={() => setF({ ...BLANK })}>+ Add a charge</button></div>}
        {f && <form className="actions" onSubmit={save} style={{ flexWrap: 'wrap', gap: 8 }}>
          <input aria-label="Code" placeholder="code (a-z, 0-9, _)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} disabled={!!f.id} required />
          <input aria-label="Charge" placeholder="Charge name" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required />
          <input aria-label="Rate" type="number" step="0.001" min="0" placeholder="Rate $" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} required style={{ width: 100 }} />
          <input aria-label="Per" placeholder="per (pallet, order…)" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} required style={{ width: 140 }} />
          <select aria-label="Counted from" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{Object.entries(SOURCES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input aria-label="Note" placeholder="Note (agreement clause)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
          <label className="sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> On</label>
          <button className="btn-sm primary">Save</button><button type="button" className="btn-sm" onClick={() => setF(null)}>Cancel</button></form>}
      </>}
    </div>);
}
