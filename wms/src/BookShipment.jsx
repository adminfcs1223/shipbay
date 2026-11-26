// WMS → Receiving → Book a shipment. Shipments are booked in ShipBay itself (Nexus is not involved): ShipBay admin or staff
// enter the brand, a reference, the expected date and how many pallets are coming. It is booked ready to receive. Clients can
// also book their own deliveries in the dashboard (Warehouse); those wait for a ShipBay approval in the dashboard's WMS hub.
import { useState } from 'react';
import { supabase } from './lib.js';
import { beep } from './parts.jsx';

export default function BookShipment({ orgs, org: startOrg, onBooked, onCancel }) {
  const today = new Date().toLocaleDateString('en-CA');
  const [f, setF] = useState({ org: startOrg || '', reference: '', expected: today, pallets: '1', cartons: '', origin: '', notes: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const problem = !f.org ? 'Pick the brand.' : !f.reference.trim() ? 'Give the shipment a reference.' : !f.expected ? 'Pick the expected date.' : !(Number(f.pallets) >= 1 && Number(f.pallets) <= 200) ? 'Pallets expected: 1 to 200.' : null;
  const book = async () => {
    if (problem || busy) return; setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc('nexus_shipment_create', { p_org: f.org, p_reference: f.reference.trim(), p_origin: f.origin.trim() || null, p_expected: f.expected,
      p_pallets: Number(f.pallets), p_cartons: f.cartons === '' ? 0 : Number(f.cartons), p_notes: f.notes.trim() || null, p_lines: [] });
    setBusy(false);
    if (error) { beep('bad'); return setErr(/cannot use Nexus|admin or staff/i.test(error.message) ? 'Only a ShipBay admin or staff login can book a shipment.' : error.message); }
    beep('ok'); onBooked(data, f.org);
  };
  return (
    <section className="panel pad" data-testid="book-shipment" style={{ marginBottom: 16 }}>
      <header className="panelhead"><h3>Book a shipment</h3><span>Booked in ShipBay, ready to receive</span></header>
      <div className="bookgrid">
        <label>Brand<select value={f.org} onChange={set('org')} data-testid="bs-brand"><option value="">Choose…</option>{(orgs || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <label>Reference<input value={f.reference} onChange={set('reference')} maxLength={120} placeholder="PO, BOL or carrier reference" data-testid="bs-ref" /></label>
        <label>Expected<input type="date" value={f.expected} onChange={set('expected')} data-testid="bs-date" /></label>
        <label>Pallets<input inputMode="numeric" value={f.pallets} onChange={(e) => setF({ ...f, pallets: e.target.value.replace(/\D/g, '').slice(0, 3) })} data-testid="bs-pallets" /></label>
        <label>Cartons (optional)<input inputMode="numeric" value={f.cartons} onChange={(e) => setF({ ...f, cartons: e.target.value.replace(/\D/g, '').slice(0, 5) })} /></label>
        <label>From (optional)<input value={f.origin} onChange={set('origin')} maxLength={120} /></label>
        <label className="wide">Notes (optional)<input value={f.notes} onChange={set('notes')} maxLength={300} /></label>
      </div>
      {err && <p className="wm-warn">{err}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button type="button" className="btn go" disabled={!!problem || busy} onClick={book} data-testid="bs-book">{busy ? 'Booking…' : 'Book shipment'}</button>
        <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
        {problem && <span className="sm">{problem}</span>}
      </div>
    </section>);
}
