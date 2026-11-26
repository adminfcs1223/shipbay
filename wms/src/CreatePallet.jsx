// WMS → Warehouse Map → Create a pallet. A pallet for stock that is physically here, with or without a shipment.
//   Without a shipment: wms_create_pallet. The employee picks the brand's existing products, enters the quantities, and must
//   say where the pallet came from and why it is being created without a shipment. Both are kept on the pallet and in the
//   activity log. The pallet holds NO available stock until it is placed through Nexus: ShipBay posts stock only when a
//   pallet is stored at a position.
//   With a shipment (optional): the existing booked receiving (wms_receive_booking), exactly as the Receiving screen does it.
// The pallet id is made by the database (SB-PAL-000040 style). One request key per form, so pressing again never makes two.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib.js';
import { beep } from './parts.jsx';
import { printPalletLabels, printCartonLabels } from './label.js';
import { fetchCartons, attachCartons } from './cartons.js';

export const SOURCES = [['found_on_floor', 'Found on the floor'], ['client_drop_off', 'Client drop-off'], ['return', 'Return'], ['transfer_in', 'Transfer in'], ['count_correction', 'Count correction'], ['other', 'Other']];
const num = (n) => Number(n || 0).toLocaleString('en-US');
let lineSeq = 0;
const newLine = () => ({ id: ++lineSeq, prod: null, find: '', cartons: '', upc: '', units: '', loose: false });
const lineUnits = (l) => (l.loose ? Number(l.units) || 0 : (Number(l.cartons) || 0) * (Number(l.upc) || 0));
const lineOk = (l) => !!l.prod && (l.loose ? Number(l.units) >= 1 : Number(l.cartons) >= 1 && Number(l.upc) >= 1);

export default function CreatePallet({ brands, onDone, onCancel }) {
  const [org, setOrg] = useState(''); const [products, setProducts] = useState(null); const [bookings, setBookings] = useState([]);
  const [lines, setLines] = useState([newLine()]); const [booking, setBooking] = useState('');
  const [source, setSource] = useState(''); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [made, setMade] = useState(null);
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    setProducts(null); setBookings([]); setBooking(''); setLines([newLine()]); if (!org) return;
    let live = true;
    supabase.rpc('wms_products', { p_org: org }).then(({ data, error }) => { if (live) { setProducts(data || []); if (error) setErr(error.message); } });
    supabase.rpc('wms_bookings', { p_org: org }).then(({ data }) => { if (live) setBookings(data || []); });
    return () => { live = false; };
  }, [org]);
  const brandOf = (id) => brands.find((b) => b.id === id)?.name || '';
  const set = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const matches = (l) => { const q = l.find.trim().toLowerCase(); const taken = lines.filter((x) => x.id !== l.id && x.prod).map((x) => x.prod.id);
    return (products || []).filter((p) => !taken.includes(p.id) && (!q || `${p.sku} ${p.name} ${p.barcode || ''}`.toLowerCase().includes(q))).slice(0, 40); };
  const mixed = lines.length > 1;
  const units = lines.reduce((n, l) => n + lineUnits(l), 0);
  const problem = !org ? 'Pick the brand.' : !lines.every(lineOk) ? 'Pick each product and enter its quantity.' : mixed && lines.some((l) => l.loose) ? 'On a mixed pallet every product needs cartons and units per carton.'
    : !booking && !source ? 'Say where this pallet came from.' : !booking && reason.trim().length < 4 ? 'Say why it is being created without a shipment.' : null;

  const create = async (e) => {
    e.preventDefault(); if (problem || busy) return;
    setBusy(true); setErr(null);
    const p_lines = lines.map((l) => (l.loose ? { sku: l.prod.id, cartons: 1, units_per_carton: Number(l.units), cle: true } : { sku: l.prod.id, cartons: Number(l.cartons), units_per_carton: Number(l.upc), cle: false }));
    const r = booking
      ? await supabase.rpc('wms_receive_booking', { p_inbound: booking, p_org: org, p_lines, p_pallets: 1, p_notes: reason.trim() || null, p_key: key.current, p_mode: 'partial', p_hold_reason: null })
      : await supabase.rpc('wms_create_pallet', { p_org: org, p_lines, p_source: source, p_reason: reason.trim(), p_key: key.current, p_pallets: 1 });
    if (r.error) { setBusy(false); beep('bad'); return setErr(r.error.message); }
    const { data: rows, error } = await supabase.from('wms_pallets').select('*').eq('batch_key', key.current).order('batch_pos');
    setBusy(false);
    if (error || !rows?.length) { beep('bad'); return setErr('The pallet may have been created, but it could not be read back. Search for it before creating it again.'); }
    let cartons = []; try { cartons = await fetchCartons(supabase, rows.map((p) => p.id)); } catch { /* labels print without carton lines */ }
    beep('ok'); setMade(attachCartons(rows, cartons).pallets);
  };
  const printPallet = () => { printPalletLabels(made, (p) => brandOf(p.org_id)); supabase.rpc('wms_mark_printed', { p_ids: made.map((p) => p.id) }).then(() => {}, () => {}); };
  const printCartons = () => printCartonLabels(made, (p) => brandOf(p.org_id));
  const hasCartons = useMemo(() => (made || []).some((p) => (p._cartons || []).some((c) => !c.cle)), [made]);

  if (made) return (
    <div className="hold wm-create" data-testid="cp-made">
      <b data-testid="cp-id">{made.map((p) => p.psku).join(', ')}</b> is created for {brandOf(made[0].org_id)}. It holds no available stock until it is placed.
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button className="btn sm" data-testid="cp-print" onClick={printPallet}>Print pallet label</button>
        {hasCartons && <button className="btn sm" onClick={printCartons}>Print carton labels</button>}
        <button className="btn go" data-testid="cp-place" onClick={() => onDone(made[0])}>Place it on the map</button>
        <button className="btn sm" onClick={onCancel}>Done</button>
      </div>
    </div>);

  return (
    <form className="hold wm-create" data-testid="cp-form" onSubmit={create}>
      <b>Create a pallet</b> for stock that is here now. The pallet ID is made for you.
      <label className="wm-step">Brand
        <select value={org} onChange={(e) => setOrg(e.target.value)} data-testid="cp-brand"><option value="">Choose…</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      {org && products === null && <p className="sm">Loading the brand's products…</p>}
      {org && products && products.length === 0 && <p className="wm-warn">This brand has no products on file. Add them in the dashboard first.</p>}
      {org && products && products.length > 0 && lines.map((l, i) => (
        <div key={l.id} className="cp-line" data-testid="cp-line">
          <label className="wm-step">Product {mixed ? i + 1 : ''}
            {l.prod ? <span className="cp-picked"><b>{l.prod.name}</b> <em>{l.prod.sku}</em> <button type="button" className="btn sm" onClick={() => set(l.id, { prod: null })}>Change</button></span>
              : (<><input value={l.find} onChange={(e) => set(l.id, { find: e.target.value })} placeholder="Search by name, SKU or barcode" data-testid="cp-find" />
                <select size={Math.min(6, Math.max(2, matches(l).length))} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); if (p) set(l.id, { prod: p }); }} data-testid="cp-product">
                  {matches(l).map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}</select></>)}
          </label>
          {!mixed && <label className="sc-check"><input type="checkbox" checked={l.loose} onChange={(e) => set(l.id, { loose: e.target.checked })} /> No cartons to count: enter the total units</label>}
          {l.loose ? <label className="wm-step">Total units<input inputMode="numeric" value={l.units} onChange={(e) => set(l.id, { units: e.target.value.replace(/\D/g, '').slice(0, 7) })} data-testid="cp-units" /></label>
            : (<div style={{ display: 'flex', gap: 10 }}>
              <label className="wm-step">Cartons<input inputMode="numeric" value={l.cartons} onChange={(e) => set(l.id, { cartons: e.target.value.replace(/\D/g, '').slice(0, 3) })} data-testid="cp-cartons" /></label>
              <label className="wm-step">Units per carton<input inputMode="numeric" value={l.upc} onChange={(e) => set(l.id, { upc: e.target.value.replace(/\D/g, '').slice(0, 6) })} data-testid="cp-upc" /></label></div>)}
          {mixed && <button type="button" className="btn sm" onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}>Remove this product</button>}
        </div>))}
      {org && products?.length > 0 && <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setLines((ls) => [...ls.map((x) => ({ ...x, loose: false })), newLine()])}>Add another product (mixed pallet)</button>}
      {org && <label className="wm-step">Shipment (optional)
        <select value={booking} onChange={(e) => setBooking(e.target.value)} data-testid="cp-booking"><option value="">No shipment</option>{bookings.map((b) => <option key={b.id} value={b.id}>{b.reference} · {b.received_pallets} of {b.expected_pallets} pallets in</option>)}</select></label>}
      {org && !booking && (<>
        <label className="wm-step">Where did it come from?
          <select value={source} onChange={(e) => setSource(e.target.value)} data-testid="cp-source"><option value="">Choose…</option>{SOURCES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        <label className="wm-step">Why is it being created without a shipment?
          <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Kept on the pallet and in the activity log" data-testid="cp-reason" /></label></>)}
      {units > 0 && <p className="sm">{num(units)} units on this pallet. They become available stock only once the pallet is placed.</p>}
      {err && <p className="wm-warn" data-testid="cp-err">{err}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn go" data-testid="cp-create" disabled={!!problem || busy}>{busy ? 'Creating…' : 'Create pallet'}</button>
        <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
      </div>
      {problem && org && <p className="sm">{problem}</p>}
    </form>);
}
