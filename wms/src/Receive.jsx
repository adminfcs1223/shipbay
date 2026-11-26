// Receiving. Product first: pick the brand, find the product on its inventory list, say how many cartons are on the
// pallet. A pallet can hold one product or several (a mixed pallet: one line per product), and any line can be marked
// FBA. The database hands back a PSKU# per pallet and a number per carton; the station is then asked to print the 4x6
// pallet label and one small label per carton (sized to the roll at the station), and the pallet opens for the carton scan.
// The carton labels can also be printed before Receive is pressed: the PSKU# is taken then (wms_hold_pskus) so the
// barcodes are the real ones, and Receive uses that number. What was printed is kept on the station until it is received.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, fmtTime, sameDay, PALLET_SCREEN } from './lib';
import { printPalletLabels, printCartonLabels, cartonCodes, linesOf, firstLabelled, sizeLabel } from './label';
import { fetchCartons, attachCartons, sameLabels, findReceipt, lookupBookedReceipt } from './cartons.js';
import { LabelPreview, CartonPreview, CartonSizePicker, CartonTurnPicker, useCartonSize, StatusTag, beep } from './parts.jsx';
import { progressText } from './bookingProgress';

const num = (n) => Number(n || 0).toLocaleString();
let lineId = 0;
// Receiving is against a pre-entered shipment only (Derek 2026-11-21). The switch exists for the station test of the unchanged label/print machinery.
const NEED_SHIPMENT = import.meta.env.VITE_ALLOW_UNBOOKED !== '1';
const newLine = () => ({ id: ++lineId, prod: null, off: false, what: '', q: '', cartons: '', upc: '', fba: false, cle: false });
const lineReady = (l) => !!(l.prod || (l.off && l.what.trim()));
const lineCartons = (l) => (l.cle || l.cartons === '' ? 0 : Math.max(0, Math.min(500, Math.round(Number(l.cartons) || 0))));
// labels printed before Receive: the form and the PSKU numbers it took, kept on this station until the pallet is received
// A Receive that was sent and not yet settled: the exact request (its key and everything it carried), kept on this station
// before it is sent, so neither a reload nor an edit can lose or change it. It is cleared only when its pallets are found,
// or when the database refused it outright (nothing was written). An empty lookup does not clear it.
// It lives in this browser only: another station, another browser profile or cleared site data will not see it.
const FLIGHT = 'wms-inflight';
const validFlight = (f) => !!(f && typeof f.key === 'string' && f.key && f.payload && f.payload.p_key === f.key && Array.isArray(f.payload.p_lines) && f.form && Array.isArray(f.form.lines));
/** null = nothing saved; { bad: true } = something is saved that cannot be read (the station is held until an admin clears it). */
const loadFlight = () => {
  let raw; try { raw = localStorage.getItem(FLIGHT); } catch { return null; }
  if (raw == null) return null;
  try { const f = JSON.parse(raw); return validFlight(f) ? f : { bad: true }; } catch { return { bad: true }; }
};
/** Saves (or clears) the record and reads it back. false = it is not durably on this station: the caller must not send. */
const saveFlight = (f) => {
  try {
    if (!f) { localStorage.removeItem(FLIGHT); return localStorage.getItem(FLIGHT) == null; }
    const text = JSON.stringify(f); localStorage.setItem(FLIGHT, text);
    return localStorage.getItem(FLIGHT) === text;
  } catch { return false; }
};
const loadHold = () => { try { const h = JSON.parse(localStorage.getItem('wms-hold') || 'null'); return h && h.key && h.org && Array.isArray(h.lines) && h.lines.length && h.pskus?.length ? h : null; } catch { return null; } };

export function BookingProgress({ b }) { return <span>{progressText(b)}</span>; }

export default function Receive({ me, orgs, pallets, brandName, merge, open }) {
  const [saved] = useState(loadHold);
  const [loaded] = useState(loadFlight);
  const flight = loaded?.bad ? null : loaded;
  const [corrupt, setCorrupt] = useState(!!loaded?.bad);   // a saved Receive record that cannot be read: hold the station
  const [org, setOrg] = useState(() => { if (flight) return flight.form.org; if (saved) return saved.org; try { return localStorage.getItem('wms-brand') || ''; } catch { return ''; } });
  const [products, setProducts] = useState(null);
  const [lines, setLines] = useState(() => (flight ? flight.form.lines.map((l) => ({ ...newLine(), ...l, id: ++lineId })) : saved ? saved.lines.map((l) => ({ ...newLine(), ...l, id: ++lineId })) : [newLine()]));
  const [count, setCount] = useState(flight?.form.count || saved?.count || 1);
  // Optional booking link (separate database entrypoint, wms_receive_booking). Empty = unbooked receiving, unchanged.
  const [booking, setBooking] = useState(flight?.form.booking || '');
  const [mode, setMode] = useState(flight?.form.mode || 'partial');
  const [holdWhy, setHoldWhy] = useState(flight?.form.holdWhy || '');
  const [bookings, setBookings] = useState(null);
  const [due, setDue] = useState(null);   // every shipment set to be received
  const wantBooking = useRef('');
  const loadDue = () => supabase.rpc('wms_shipments_due').then(({ data, error }) => setDue(error ? [] : data || []));
  useEffect(() => { loadDue(); }, []);
  const pickDue = (d) => { if (d.org_id === org) { setBooking(d.id); setMode('partial'); setHoldWhy(''); } else { wantBooking.current = d.id; setOrg(d.org_id); } };
  const [expected, setExpected] = useState([]);   // what the chosen shipment says is on it
  useEffect(() => { setExpected([]); if (booking) supabase.rpc('wms_booking_lines', { p_inbound: booking }).then(({ data }) => setExpected(data || [])); }, [booking]);
  const [hold, setHold] = useState(saved ? { pskus: saved.pskus, sig: saved.sig, full: !!saved.full } : null);   // carton labels printed before Receive
  const [holding, setHolding] = useState(false);
  const lastOrg = useRef(flight ? flight.form.org : saved ? saved.org : null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);         // pallets just made (with their cartons) → the print prompt
  const [printed, setPrinted] = useState({});
  const [err, setErr] = useState(null);
  const key = useRef(flight?.key || saved?.key || crypto.randomUUID());
  const [sent, setSent] = useState(flight);        // the unsettled Receive (see loadFlight); while it exists the form is locked
  const [looked, setLooked] = useState(0);          // lookups that found nothing for it, this session
  const unsure = !!sent && !busy;                   // sent, and no answer that settles it
  const locked = !!sent || busy || corrupt;                    // nothing that could change or drop what was sent may run
  const isAdmin = me?.role === 'shipbay_admin';
  const [pending, setPending] = useState(null);     // received, cartons not yet read and checked: { pallets, early, reading | why | bad }
  const sending = useRef(false);
  const lastBookingOrg = useRef(flight?.form.org || null);
  const [csize, setCsize, cturn, setCturn] = useCartonSize();

  useEffect(() => { if (orgs && org && !orgs.some((o) => o.id === org)) setOrg(''); }, [orgs]);
  useEffect(() => {
    try { org ? localStorage.setItem('wms-brand', org) : localStorage.removeItem('wms-brand'); } catch { /* storage off */ }
    if (lastOrg.current !== org) setLines([newLine()]);   // a form restored with its printed labels keeps its lines
    lastOrg.current = org; setProducts(null);
    if (!org) return;
    let live = true;
    supabase.rpc('wms_products', { p_org: org }).then(({ data, error }) => { if (live) { setProducts(data || []); if (error) setErr(error.message); } });
    return () => { live = false; };
  }, [org]);
  const loadBookings = async (o = org) => {
    if (!o) { setBookings(null); return; }
    const { data, error } = await supabase.rpc('wms_bookings', { p_org: o });
    if (error) { setBookings([]); return; }   // entrypoint not on this database: booking link hidden, unbooked receiving as before
    setBookings(data || []);
  };
  useEffect(() => {
    if (!sent) { const keep = lastBookingOrg.current === org; lastBookingOrg.current = org; if (!keep) { setBooking(wantBooking.current || ''); setMode('partial'); setHoldWhy(''); } }
    wantBooking.current = '';
    setBookings(null); loadBookings(org);
  }, [org]);
  const curBooking = (bookings || []).find((b) => b.id === booking) || null;

  const cur = orgs?.find((o) => o.id === org);
  const setLine = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const mixed = lines.length > 1;
  const today = useMemo(() => (pallets || []).filter((p) => sameDay(p.received_at)), [pallets]);
  const waiting = (pallets || []).filter((p) => p.status === 'open' || p.status === 'counted');
  const n = Math.max(1, Math.min(60, Number(count) || 1));
  const total = lines.reduce((s, l) => s + lineCartons(l), 0);
  const printable = total;   // an NCC product (no carton count; cle in the data) has no cartons to label
  const rows = total + lines.filter((l) => l.cle).length;   // the database writes one marker row per NCC product; carton codes are padded to this
  const problem = NEED_SHIPMENT && org && !booking ? (bookings && bookings.length === 0 ? 'No shipment is booked for this brand' : 'Pick the shipment') : booking && mode === 'hold' && !holdWhy.trim() ? 'Say why it is on HOLD' : !org ? 'Pick a brand' : !lines.every(lineReady) ? (mixed ? 'Pick every product' : 'Pick the product') : mixed && lines.some((l) => !l.cle && !lineCartons(l)) ? 'Every product needs its carton count, or NCC' : lines.some((l) => !l.cle && lineCartons(l) > 0 && !(Number(l.upc) >= 1)) ? 'Enter the units per carton' : total > 500 ? 'Up to 500 cartons on a pallet' : null;

  const sig = JSON.stringify([org, n, lines.map((l) => [l.prod?.id || l.what.trim(), lineCartons(l), l.upc, l.fba, !!l.cle])]);
  const stale = !!hold && hold.sig !== sig;   // the form changed after the labels were printed
  useEffect(() => {
    try { hold ? localStorage.setItem('wms-hold', JSON.stringify({ key: key.current, org, lines, count: n, pskus: hold.pskus, sig: hold.sig, full: hold.full })) : localStorage.removeItem('wms-hold'); } catch { /* storage off */ }
  }, [hold, org, lines, n]);
  // the pallets as they will be received, cartons numbered the way the database numbers them
  const draft = (pskus) => {
    const w = Math.max(2, String(rows).length); const one = lines[0];
    return pskus.map((psku, i) => {
      const num = psku.replace(/\D/g, '') || '000000'; let seq = 0; const cs = [];
      lines.forEach((l) => { for (let g = 0; g < (l.cle ? 1 : lineCartons(l)); g++) { seq += 1; cs.push({ seq, code: `C${num}${String(seq).padStart(w, '0')}`, item_no: l.prod?.sku || null, item_name: l.prod?.name || l.what.trim(), units_per_carton: l.upc === '' ? null : Number(l.upc), fba: l.fba, cle: !!l.cle }); } });
      return { psku, org_id: org, batch_pos: i + 1, batch_size: pskus.length, received_at: new Date().toISOString(), mixed, fba: lines.every((l) => l.fba), cle: lines.every((l) => l.cle), cartons: total || null, units_per_carton: !mixed && one.upc !== '' ? Number(one.upc) : null, item_no: mixed ? null : one.prod?.sku, item_name: mixed ? `Mixed pallet · ${lines.length} products` : one.prod?.name || (one.off ? one.what : ''), received_by_name: me.full_name || me.email, _cartons: cs, _draft: true };
    });
  };
  // Print carton labels before Receive: take the PSKU numbers for this form, then print with the real barcodes.
  const printFirst = async (only) => {
    if (problem || !printable || holding || locked) return;
    setHolding(true); setErr(null);
    const { data, error } = await supabase.rpc('wms_hold_pskus', { p_key: key.current, p_pallets: n });
    setHolding(false);
    if (error || !data?.length) { beep('bad'); return setErr(error?.message || 'No pallet number came back. Check the connection and try again.'); }
    setHold((h) => ({ pskus: data, sig, full: !!(h?.full && h.sig === sig) }));   // the numbers are held whether or not the print goes
    const ok = await printCartonLabels(draft(data), () => cur?.name || '', only || null, csize, cturn);
    if (!ok) { beep('bad'); return setErr(`The print window did not open, so nothing was printed for ${data[0]}${data.length > 1 ? ' and the rest' : ''}. The number stays held: print again.`); }
    if (!only) setHold((h) => (h && h.sig === sig ? { ...h, full: true } : h));   // full = every carton label went to the print window for the form as it stands
  };
  const heldName = hold ? (hold.pskus.length === 1 ? hold.pskus[0] : `${hold.pskus[0]} → ${hold.pskus[hold.pskus.length - 1]}`) : '';
  const dropHold = () => { if (locked) return; setHold(null); key.current = crypto.randomUUID(); };

  // The cartons of pallets just received, read from the database and checked. Labels are offered only when they pass.
  const verify = async (data, early) => {
    setPending({ pallets: data, early, reading: true });
    let rows;
    try { rows = await fetchCartons(supabase, data.map((p) => p.id)); }
    catch (x) { beep('bad'); return setPending({ pallets: data, early, why: x.message }); }
    const got = attachCartons(data, rows);
    if (!got.ok) { beep('bad'); return setPending({ pallets: data, early, bad: got.problems }); }
    // labels printed before Receive count as printed only if they are, carton for carton, what the database now holds
    const same = !!early && early.length === got.pallets.length && early.every((d, i) => d.psku === got.pallets[i].psku && sameLabels(d._cartons, got.pallets[i]._cartons));
    setPending(null); setDone(got.pallets);
    setPrinted(same ? { cartons: true, early: true } : early ? { mismatch: true } : {});
  };
  // The pallets are on file: this form is finished whatever happens to the carton read that follows.
  const landed = async (data, early) => {
    saveFlight(null); setSent(null); setLooked(0); key.current = crypto.randomUUID();
    beep('ok'); merge(data); setErr(null);
    setHold(null); setLines([newLine()]); setCount(1); setMode('partial'); setHoldWhy('');
    if (booking) {   // same booking stays chosen for the next pallets off the truck, unless that receipt closed it
      const { data: bs } = await supabase.rpc('wms_bookings', { p_org: org });
      setBookings(bs || []); if (!(bs || []).some((b) => b.id === booking)) setBooking('');
    }
    await verify(data, early);
  };
  // Send a pinned request and settle what came back. Used for the first send and for an admin's re-send of the same request.
  const send = async (f) => {
    sending.current = true; setBusy(true); setErr(null);
    let res;
    try { res = await supabase.rpc(f.rpc === 'wms_receive_booking' ? 'wms_receive_booking' : 'wms_receive', f.payload); }
    catch (x) { res = { data: null, error: { message: String(x?.message || x) }, status: 0 }; }
    sending.current = false; setBusy(false);
    const { data, error, status } = res;
    // Refused before anything was written: the database raised on the form (400), or the login was not let in (401/403).
    // 409 (a unique key already taken: the same request may have gone in) and 408 (timeout) are not refusals.
    if (error && status >= 400 && status < 500 && status !== 408 && status !== 409) { saveFlight(null); setSent(null); beep('bad'); return setErr(error.message); }
    if (error || !data?.length || data.some((p) => p.batch_key && p.batch_key !== f.key)) { beep('bad'); return; }   // still unsettled: stays pinned
    await landed(data, f.early);
  };
  const receive = async (e) => {
    e?.preventDefault();
    if (problem || busy || sending.current || pending || sent || corrupt) return;
    const f = {
      key: key.current, at: Date.now(), early: hold?.full && !stale ? draft(hold.pskus) : null,
      form: { org, count: n, lines: lines.map(({ id, q, ...l }) => l), booking: booking || null, mode: booking ? mode : null, holdWhy: booking && mode === 'hold' ? holdWhy.trim() : null },
      rpc: booking ? 'wms_receive_booking' : 'wms_receive',
      payload: { p_org: org, p_pallets: n, p_notes: null, p_key: key.current,
        p_lines: lines.map((l) => ({ sku: l.prod?.id || null, name: l.prod ? null : l.what.trim(), cartons: lineCartons(l), units_per_carton: l.upc === '' ? null : Number(l.upc), fba: l.fba, cle: !!l.cle })),
        ...(booking ? { p_inbound: booking, p_mode: mode, p_hold_reason: mode === 'hold' ? holdWhy.trim() : null } : {}) },
    };
    sending.current = true;   // closes the gap before React re-renders the button
    if (!saveFlight(f)) {   // not durably recorded: if the answer were lost, nothing would show it may be on file
      sending.current = false; beep('bad');
      return setErr('Nothing was sent. This station could not save the Receive before sending it (browser storage is blocked, full, or in a private window). Use a normal window or another station, or ask an admin.');
    }
    setSent(f);
    await send(f);
  };
  // "Did it go through?" Looked up by the key of the request that was sent. Nothing is sent. Finding nothing settles nothing:
  // the request may still be finishing in the database, or this login may not be allowed to see it.
  const check = async () => {
    if (busy || !sent) return;
    setBusy(true); setErr(null);
    let found;
    // booked: the dedicated lookup (brand + booking + key + content); unbooked: the original search by key, unchanged
    try { found = sent.rpc === 'wms_receive_booking' ? await lookupBookedReceipt(supabase, sent) : { state: 'legacy', pallets: await findReceipt(supabase, sent.key) }; }
    catch (x) { setBusy(false); beep('bad'); return setErr(`It could not be checked (${x.message}). Do not enter it again.`); }
    setBusy(false);
    if (found.state === 'different_request' || found.state === 'key_used_elsewhere') {
      beep('bad'); return setErr(`Receipt ${sent.key.slice(0, 8)} is on file for a different receipt${found.state === 'key_used_elsewhere' ? ' (another booking or an unbooked receipt)' : ' on this booking'}. This one was not received under it. Do not enter it again: ask an admin.`);
    }
    if (found.pallets?.length) return landed(found.pallets, sent.early);
    setLooked((k) => k + 1); beep('bad');
  };
  // Admin only: send the very same request again, same key. The database returns the pallets already made under that key
  // instead of making new ones (wms_receive; client_key unique). Not exercised against a live database yet (staging gate).
  // Admin only, after checking today's receipts by hand: drop an unreadable record so the station can work again.
  const clearCorrupt = () => { if (!isAdmin) return; if (saveFlight(null)) { setCorrupt(false); setErr(null); } else setErr('The record could not be cleared: browser storage is blocked here.'); };
  const resend = async () => { if (!isAdmin || busy || !sent) return; await send(sent); };
  const printFail = (what) => { beep('bad'); setPrinted((x) => ({ ...x, fail: `The print window did not open for the ${what}. Nothing was printed; press Print again.` })); };
  const printPallet = async () => {
    if (!(await printPalletLabels(done, (p) => brandName(p.org_id)))) return printFail('pallet label');
    setPrinted((x) => ({ ...x, pallet: true, fail: null }));
    const { error } = await supabase.rpc('wms_mark_printed', { p_ids: done.map((r) => r.id) });
    if (!error) merge(done.map(({ _cartons, ...r }) => ({ ...r, label_prints: (r.label_prints || 0) + 1, last_printed_at: new Date().toISOString() })));
  };
  const testCarton = async () => { if (!(await printCartonLabels([done[0]], (p) => brandName(p.org_id), [firstLabelled(done[0])?.seq], csize, cturn))) printFail('test label'); };   // one label, to check size and direction before the full run
  const printCartons = async () => { if (!(await printCartonLabels(done, (p) => brandName(p.org_id), null, csize, cturn))) return printFail('carton labels'); setPrinted((x) => ({ ...x, cartons: true, fail: null })); };
  const toPallet = () => { const first = done[0]; setDone(null); loadDue(); open(first.psku); };

  // what the labels will look like, from what is typed so far
  const sample = useMemo(() => draft([hold?.pskus[0] || 'PSKU-______'])[0], [lines, n, mixed, total, me, hold, org]);
  const sampleLines = useMemo(() => (total ? linesOf(sample).filter((ln) => !ln.cle) : []), [sample]);
  const doneLines = done?.[0]?.mixed ? linesOf(done[0]).filter((ln) => !ln.cle) : [];
  const doneCartons = done ? done.reduce((s, p) => s + cartonCodes(p).filter((c) => !c.cle).length, 0) : 0;   // labels to print: CLE cartons get none

  return (
    <>
      <header className="pagehead">
        <h1>Receiving<span className="dot">.</span></h1>
        <div className="glance">
          <div><b>{today.filter((p) => p.status !== 'void').length}</b><small>Pallets today</small></div>
          <div><b className={waiting.filter((p) => p.status === 'open').length ? 'hot' : ''}>{waiting.filter((p) => p.status === 'open').length}</b><small>Cartons to scan</small></div>
          <div><b className={waiting.filter((p) => p.status === 'counted').length ? 'hot' : ''}>{waiting.filter((p) => p.status === 'counted').length}</b><small>To put away</small></div>
        </div>
      </header>

      {corrupt && <div className="strip bad"><b>Stop.</b><span>This station has a saved Receive record it cannot read, so an earlier Receive may or may not be on file. Check today's receipts before receiving here.{isAdmin ? '' : ' An admin must clear this.'}</span>
        {isAdmin && <button type="button" className="btn sm" onClick={clearCorrupt}>Admin: receipts checked, clear the record</button>}</div>}
      {unsure && <div className="strip bad"><b>Stop.</b>
        <span>{looked ? `Nothing found yet for receipt ${sent.key.slice(0, 8)} (looked ${looked} time${looked === 1 ? '' : 's'}). That does not prove it was not received: it may still be finishing, or this login may not be able to see it. Do not enter it again.${isAdmin ? '' : ' Check again in a minute; if it still shows nothing, an admin must resolve it.'}` : `No answer came back for receipt ${sent.key.slice(0, 8)}, so it may or may not be on file. Do not enter it again.`}</span>
        <button type="button" className="btn sm" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check whether it was received'}</button>
        {isAdmin && looked > 0 && <button type="button" className="btn sm" disabled={busy} onClick={resend}>Admin: send the same Receive again (same receipt)</button>}
      </div>}
      {pending && <div className="strip bad"><b>Received as {pending.pallets.length === 1 ? pending.pallets[0].psku : `${pending.pallets[0].psku} → ${pending.pallets[pending.pallets.length - 1].psku}`}.</b>
        <span>{pending.reading ? 'Reading its cartons…' : pending.why ? `Its cartons could not be read (${pending.why}). No carton labels can be printed yet. Do not receive it again.` : `The cartons on file do not add up (${pending.bad.map((b) => `${b.psku || 'other'}: ${b.problems.join(', ')}`).join('; ')}). No carton labels can be printed. Do not receive it again; tell an admin.`}</span>
        {!pending.reading && <button type="button" className="btn sm" onClick={() => verify(pending.pallets, pending.early)}>Read the cartons again</button>}
        {!pending.reading && <button type="button" className="swap" onClick={() => setPending(null)}>Leave it for an admin</button>}
      </div>}
      {err && <div className="strip bad"><b>Not received.</b><span>{err}</span><button className="x" onClick={() => setErr(null)} aria-label="Dismiss">×</button></div>}

      <div className="station">
        <form className="panel entry" onSubmit={receive}>
          <fieldset className="lockset" disabled={locked}>
          {NEED_SHIPMENT && <div className="duelist" data-testid="due">
            <div className="step"><i>·</i><h3>Shipments to receive</h3><span>tap the one at the dock</span></div>
            {due === null ? <div className="empty">Loading shipments…</div> : due.length === 0 ? <div className="empty">Nothing is booked. Book the shipment in Nexus (Calendar) first.</div> : due.map((d) => (
              <button type="button" key={d.id} className={`due ${d.id === booking ? 'on' : ''}`} onClick={() => pickDue(d)} aria-pressed={d.id === booking}>
                <b>{d.brand}</b><span>{d.reference}</span>
                <small>{d.expected_at ? new Date(d.expected_at + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'No date'} · {d.received_pallets} of {d.expected_pallets} pallets in{d.lines.length ? ' · ' + d.lines.map((x) => `${x.sku} × ${num(x.qty)}`).join(', ') : ' · no items listed'}</small>
              </button>
            ))}
          </div>}
          <div className="step"><i>1</i><h3>Brand</h3></div>
          {orgs === null ? <div className="empty">Loading brands…</div> : orgs.length === 0 ? <div className="empty">No brands on file yet.</div> : (
            <div className="brands">{orgs.map((o) => (
              <button type="button" key={o.id} className={o.id === org ? 'on' : ''} onClick={() => setOrg(o.id)} aria-pressed={o.id === org}><b>{o.name}</b></button>
            ))}</div>
          )}

          {org && bookings && bookings.length === 0 && NEED_SHIPMENT && <div className="strip bad" data-testid="no-shipment"><span>No shipment is booked for this brand. Book it in Nexus (Calendar) first, then receive against it.</span></div>}
          {org && bookings && bookings.length > 0 && (<>
            <div className="step"><i>·</i><h3>Shipment</h3><span>{NEED_SHIPMENT ? 'which delivery is this?' : 'optional'}</span></div>
            <div className="bookingrow" data-testid="booking">
              <select value={booking} onChange={(e) => { setBooking(e.target.value); setMode('partial'); setHoldWhy(''); }} aria-label="Booking">
                <option value="">{NEED_SHIPMENT ? 'Choose the shipment…' : 'No booking (unbooked receipt)'}</option>
                {bookings.map((b) => <option key={b.id} value={b.id}>{b.reference} · {b.received_pallets} of {b.expected_pallets} pallets in</option>)}
              </select>
              {curBooking && <div className="bookingstate" data-testid="booking-state"><BookingProgress b={curBooking} /></div>}
              {curBooking && expected.length > 0 && <div className="expected" data-testid="expected-items"><small>Expected on this shipment. Check the pallet against it; tap one to receive it:</small>
                {expected.map((x) => <button type="button" key={x.sku_id} className="btn sm" onClick={() => { const pr = (products || []).find((p) => p.id === x.sku_id); if (pr) setLines((ls) => ls.map((l, i) => (i === 0 ? { ...l, prod: pr, q: '' } : l))); }}>{x.sku} · {x.name} · {num(x.qty_expected)} units</button>)}</div>}
              {curBooking && (
                <div className="bookingmode" role="radiogroup" aria-label="This receipt">
                  {[['partial', 'More to come'], ['hold', 'On HOLD'], ['final', 'Last of this booking']].map(([k, t]) => (
                    <label key={k}><input type="radio" name="bmode" value={k} checked={mode === k} onChange={() => setMode(k)} /> {t}</label>
                  ))}
                  {mode === 'hold' && <input className="holdwhy" placeholder="Why is it on HOLD?" value={holdWhy} onChange={(e) => setHoldWhy(e.target.value)} aria-label="HOLD reason" />}
                  {mode === 'final' && <small>Closes the booking. Anything not received is recorded as short.</small>}
                </div>
              )}
            </div>
          </>)}

          <div className="step"><i>2</i><h3>{mixed ? 'Mixed pallet' : 'Product'}</h3>{org && products && <span>{mixed ? `${lines.length} products · ${num(total)} cartons` : `${num(products.length)} on ${cur?.name}’s list`}</span>}</div>
          {!org ? <div className="hold">Pick the brand first.</div> : (
            <div className="lines">
              {lines.map((l, i) => (
                <Line key={l.id} l={l} n={i + 1} mixed={mixed} products={products} brand={cur?.name} set={(patch) => setLine(l.id, patch)}
                  onRemove={mixed ? () => setLines((ls) => ls.filter((x) => x.id !== l.id)) : null} taken={lines.filter((x) => x.id !== l.id && x.prod).map((x) => x.prod.id)} />
              ))}
              {lines.length < 20 && <button type="button" className="addline" onClick={() => setLines((ls) => [...ls, newLine()])}>+ Another product on this pallet{mixed ? '' : ' (mixed pallet)'}</button>}
            </div>
          )}

          <div className="step"><i>3</i><h3>Pallets like this</h3></div>
          <div className="countrow" style={{ marginBottom: 22 }}>
            <div className="stepper">
              <button type="button" onClick={() => setCount(Math.max(1, n - 1))} aria-label="One fewer pallet">−</button>
              <input type="number" min="1" max="60" value={count} onChange={(e) => setCount(e.target.value)} onBlur={() => setCount(n)} aria-label="Pallets" />
              <button type="button" onClick={() => setCount(Math.min(60, n + 1))} aria-label="One more pallet">+</button>
            </div>
          </div>

          </fieldset>
          <button className="btn go big" disabled={!!problem || locked || !!pending}>
            {busy ? 'Receiving…' : problem || <>Receive {n} {mixed ? 'mixed ' : ''}pallet{n > 1 ? 's' : ''}{total ? ` · ${num(total * n)} carton${total * n > 1 ? 's' : ''}` : ''}<kbd>Enter</kbd></>}
          </button>
        </form>

        <div className="panel preview">
          <div className="panelhead"><h3>Labels</h3><span>4 × 6 and {sizeLabel(csize)} in</span></div>
          <LabelPreview pallet={sample} brand={cur?.name || 'Brand'} ghost />
          {sampleLines.map((ln) => (
            <div className="flav" key={ln.from}>
              <CartonPreview pallet={sample} brand={cur?.name || 'Brand'} carton={cartonCodes(sample)[ln.from - 1]} size={csize} />
              {mixed && <small>{num(ln.cartons)} carton{ln.cartons === 1 ? '' : 's'} · labels 1 to {ln.cartons}<button type="button" className="swap" disabled={holding || !!problem || locked} onClick={() => printFirst(Array.from({ length: ln.cartons }, (_, i) => ln.from + i))}>Print {num(ln.cartons * n)}</button></small>}
            </div>
          ))}
          {!problem && lines.every((l) => l.cle) && <div className="hold">NCC: no carton count and no carton labels. The pallet goes straight to put-away.</div>}
          {printable > 0 && !problem && (
            <div className="early">
              {stale && <div className="strip bad"><span>The form changed after labels were printed for {heldName}. Print them again, or put the form back.</span></div>}
              {hold && !stale && <div className="strip ok"><span>{hold.full ? <>Carton labels printed for <b>{heldName}</b>. Press Receive when they are on.</> : <><b>{heldName}</b> is held for this pallet. Not every carton label is printed yet.</>}</span></div>}
              <div className="picks row"><CartonSizePicker size={csize} onChange={setCsize} /><CartonTurnPicker turn={cturn} onChange={setCturn} /></div>
              <button type="button" className="btn" disabled={holding || locked} onClick={() => printFirst()}>{holding ? 'Getting the pallet number…' : `${hold?.full && !stale ? 'Print again' : 'Print now'} · ${num(printable * n)} carton label${printable * n > 1 ? 's' : ''}`}</button>
              <button type="button" className="btn sm" disabled={holding || locked} onClick={() => printFirst([firstLabelled(sample)?.seq])}>Test with 1 label</button>
              {hold && <button type="button" className="swap" disabled={locked} onClick={dropHold}>Throw those labels away and start over</button>}
            </div>
          )}
        </div>
      </div>

      <section className="panel">
        <div className="panelhead"><h3>{PALLET_SCREEN ? 'Not finished' : 'Waiting for the Warehouse Map'}</h3><span>{waiting.length} pallet{waiting.length === 1 ? '' : 's'}</span></div>
        {pallets === null ? <div className="empty">Loading…</div> : waiting.length === 0 ? <div className="empty">Every pallet is put away.</div> : (
          <table className="grid pick">
            <thead><tr><th>PSKU#</th><th>Brand</th><th>Product</th><th className="n">Cartons</th><th>Received</th><th>By</th><th>Next step</th></tr></thead>
            <tbody>{waiting.map((p) => (
              <tr key={p.id} onClick={() => open(p.psku)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(p.psku)}>
                <td className="code">{p.psku}</td><td><b>{brandName(p.org_id)}</b></td>
                <td className="clip">{p.fba && <span className="tag fba">FBA</span>} {p.cle && <span className="tag fba">NCC</span>} {p.item_name || p.notes || '—'}</td>
                <td className="n num">{p.cartons ?? '—'}</td>
                <td className="num">{sameDay(p.received_at) ? fmtTime(p.received_at) : new Date(p.received_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td><td>{p.received_by_name || '—'}</td>
                <td><StatusTag s={p.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      {done && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-label="Print labels">
            <h2>{done.length === 1 ? done[0].psku : `${done[0].psku} → ${done[done.length - 1].psku}`}<span className="dot">.</span></h2>
            <p className="lead">{brandName(done[0].org_id)} · {done[0].item_name || done[0].notes}</p>
            {printed.fail && <div className="strip bad"><span>{printed.fail}</span></div>}
            <p className="lead sm">Print sends the labels to the print window. Only you can confirm they came out of the printer.</p>
            {printed.mismatch && <div className="strip bad"><span>The carton labels printed before Receive are not what was received. Take them off and print the labels again from here.</span></div>}
            <div className={`printrow ${printed.pallet ? 'done' : ''}`}>
              <i>4 × 6</i><div><b>{done.length} pallet label{done.length > 1 ? 's' : ''}</b><span>Paper 4 × 6 in · margins none · headers and footers off · scale 100%</span></div>
              <button className={`btn ${printed.pallet ? '' : 'go'}`} onClick={printPallet}>{printed.pallet ? 'Print again' : 'Print'}</button>
            </div>
            {doneCartons > 0 && (
              <div className={`printrow ${printed.cartons ? 'done' : ''}`}>
                <div className="picks"><CartonSizePicker size={csize} onChange={(v) => { setCsize(v); setPrinted((x) => ({ ...x, cartons: false })); }} /><CartonTurnPicker turn={cturn} onChange={(v) => { setCturn(v); setPrinted((x) => ({ ...x, cartons: false })); }} /></div>
                <div><b>{num(doneCartons)} carton label{doneCartons > 1 ? 's' : ''}{printed.early ? ' · printed before receiving' : ''}</b><span>In the print window: Paper size {cturn === 'left' || cturn === 'right' ? sizeLabel(csize).split(' × ').reverse().join(' × ') : sizeLabel(csize)} in (width × height) · Layout Portrait · Margins None · Headers and footers off · Scale 100</span></div>
                <div className="twobtn"><button className={`btn ${printed.cartons ? '' : 'go'}`} onClick={printCartons}>{printed.cartons ? 'Print again' : `Print ${num(doneCartons)}`}</button><button className="btn sm" onClick={testCarton}>Test with 1 label</button></div>
              </div>
            )}
            {doneLines.length > 1 && (
              <div className="flavs">{doneLines.map((ln) => (
                <div className="flavrow" key={ln.from}>
                  <CartonPreview pallet={done[0]} brand={brandName(done[0].org_id)} carton={cartonCodes(done[0])[ln.from - 1]} size={csize} width={150} />
                  <div><b>{ln.fba && <span className="tag fba">FBA</span>} {ln.item_name}</b><span>{num(ln.cartons)} carton{ln.cartons === 1 ? '' : 's'} · labels 1 to {ln.cartons}{ln.item_no ? ` · ${ln.item_no}` : ''}</span></div>
                  <button className="btn sm" onClick={async () => { if (!(await printCartonLabels(done, (p) => brandName(p.org_id), Array.from({ length: ln.cartons }, (_, i) => ln.from + i), csize, cturn))) printFail(`${ln.item_name} labels`); }}>Print {num(ln.cartons * done.length)}</button>
                </div>
              ))}</div>
            )}
            {doneCartons > 0 && doneLines.length <= 1 && <div className="proof"><CartonPreview pallet={done[0]} brand={brandName(done[0].org_id)} carton={firstLabelled(done[0])} size={csize} turn={cturn} width={300} /><small>How it leaves the printer</small></div>}
            <button className={`btn big ${printed.pallet && (printed.cartons || !doneCartons) ? 'go' : ''}`} onClick={toPallet}>{!PALLET_SCREEN ? 'Labels are on · next pallet' : doneCartons ? 'Labels are on · scan the cartons' : 'Label is on · put it away'}</button>
          </div>
        </div>
      )}
    </>
  );
}

/* One product on the pallet: search → pick → cartons, units per carton, FBA. */
function Line({ l, n, mixed, products, brand, set, onRemove, taken }) {
  const ref = useRef(null);
  useEffect(() => { if (!l.prod && !l.off) ref.current?.focus(); }, []);
  const hits = useMemo(() => {
    const words = l.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!products || !words.length) return [];
    return products.filter((p) => !taken.includes(p.id)).filter((p) => { const hay = `${p.sku} ${p.name} ${(p.asins || []).join(' ')} ${p.supplier || ''} ${p.barcode || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); }).slice(0, 8);
  }, [products, l.q, taken.join(',')]);
  const picked = l.prod || (l.off && l.what.trim());

  return (
    <div className={`line ${mixed ? 'mixed' : ''}`}>
      {mixed && <div className="linehead"><b>Product {n}</b>{onRemove && <button type="button" className="swap" onClick={onRemove}>Remove</button>}</div>}
      {l.prod ? (
        <div className="prodcard">
          <div className="pc-main"><small>{l.prod.sku}</small><b>{l.prod.name}</b></div>
          <button type="button" className="btn sm" onClick={() => set({ prod: null, q: '' })}>Change</button>
          <dl>
            <div><dt>ASIN</dt><dd>{l.prod.asins?.length ? l.prod.asins.join(' / ') : 'None'}</dd></div>
            <div><dt>Supplier</dt><dd>{l.prod.supplier || '—'}</dd></div>
            <div><dt>Expected units</dt><dd>{l.prod.expected_qty != null ? `${num(l.prod.expected_qty)} (FBA ${num(l.prod.expected_fba)} · FBM ${num(l.prod.expected_fbm)})` : '—'}</dd></div>
          </dl>
        </div>
      ) : l.off ? (
        <div className="offlist">
          <label>What is it<input value={l.what} onChange={(e) => set({ what: e.target.value })} placeholder="Product name as printed on the carton" maxLength={140} autoFocus /></label>
          <button type="button" className="btn sm" onClick={() => set({ off: false, what: '' })}>Back to the list</button>
        </div>
      ) : (
        <div className="search">
          <div className="scanbox">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input ref={ref} value={l.q} onChange={(e) => set({ q: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (hits[0]) set({ prod: hits[0] }); } }} placeholder="Search product name, item number, ASIN or supplier" autoComplete="off" spellCheck={false} />
            {l.q && <button type="button" className="x" onClick={() => { set({ q: '' }); ref.current?.focus(); }} aria-label="Clear">×</button>}
          </div>
          {products === null ? <div className="hold">Loading {brand}’s products…</div> : products.length === 0 ? <div className="hold">{brand} has no inventory list yet.</div> : l.q.trim() && (
            <ul className="hits">
              {hits.map((p) => (
                <li key={p.id}><button type="button" onClick={() => set({ prod: p })}>
                  <b>{p.name}</b><span><em>{p.sku}</em>{p.asins?.length ? ` · ${p.asins[0]}${p.asins.length > 1 ? ` +${p.asins.length - 1}` : ''}` : ''}{p.supplier ? ` · ${p.supplier}` : ''}</span>
                </button></li>
              ))}
              {hits.length === 0 && <li className="none">Nothing on the list matches “{l.q.trim()}”.</li>}
            </ul>
          )}
          <button type="button" className="swap" onClick={() => set({ off: true, what: l.q })}>It isn’t on the list</button>
        </div>
      )}
      {picked && (
        <div className="qtyrow">
          <label>Cartons{mixed ? ' of this product' : ' on the pallet'}<input className="bignum" type="number" min="0" max="500" inputMode="numeric" value={l.cle ? '' : l.cartons} onChange={(e) => set({ cartons: e.target.value })} autoFocus disabled={!!l.cle} placeholder={l.cle ? 'Not counted' : ''} /></label>
          <label>{l.cle ? <>Units on the pallet <em>optional</em></> : 'Units per carton'}<input className="bignum" type="number" min="1" inputMode="numeric" value={l.upc} onChange={(e) => set({ upc: e.target.value })} /></label>
          <button type="button" className={`fbatoggle ${l.fba ? 'on' : ''}`} onClick={() => set({ fba: !l.fba })} aria-pressed={l.fba}><i>{l.fba ? '✓' : ''}</i>FBA</button>
          <button type="button" className={`fbatoggle ${l.cle ? 'on' : ''}`} onClick={() => set({ cle: !l.cle })} aria-pressed={!!l.cle} title="No carton count: the cartons are not counted, labelled or scanned"><i>{l.cle ? '✓' : ''}</i>NCC</button>
        </div>
      )}
    </div>
  );
}
