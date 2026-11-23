// Pallets. The register (scan or search any pallet) and, once one is open, the pallet's own work screen:
//   Scan cartons → every carton label scanned in · Put away → the map shows its position; scan the position label and
//   the PSKU label there · Received. A pallet entered by mistake is voided with a reason, never deleted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, fmtStamp, sameDay } from './lib';
import { printPalletLabels, printCartonLabels, printUnitLabels, linesOf, firstLabelled } from './label';
import { fetchCartons, checkCartons } from './cartons.js';
import { LabelPreview, CartonPreview, CartonSizePicker, CartonTurnPicker, useCartonSize, ScanBox, StatusTag, FloorMap, beep, normPsku } from './parts.jsx';

const WHEN = [['open', 'Not finished'], ['today', 'Today'], ['week', '7 days'], ['all', 'All']];
const cartonOf = (code) => { const m = String(code).trim().toUpperCase().match(/^C(\d{6})(\d{2,3})$/); return m ? { psku: `PSKU-${m[1]}`, seq: Number(m[2]), code: m[0] } : null; };
const locCode = (s) => String(s).trim().toUpperCase().replace(/^LOC-/, '');

export default function Pallets({ orgs, pallets, locations, brandName, merge, find, setFind }) {
  const [q, setQ] = useState('');
  const [org, setOrg] = useState('');
  const [when, setWhen] = useState('open');
  const [sel, setSel] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => { if (find && pallets) { const p = pallets.find((x) => x.psku === find); if (p) setSel(p.id); setFind(''); } }, [find, pallets]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase(); const want = normPsku(q).toLowerCase(); const weekAgo = Date.now() - 7 * 864e5;
    return (pallets || []).filter((p) => {
      if (org && p.org_id !== org) return false;
      if (!t) {
        if (when === 'open' && !(p.status === 'open' || p.status === 'counted')) return false;
        if (when === 'today' && !sameDay(p.received_at)) return false;
        if (when === 'week' && new Date(p.received_at).getTime() < weekAgo) return false;
        return true;
      }
      return p.psku.toLowerCase() === want || p.psku.toLowerCase().includes(t) || (p.item_name || '').toLowerCase().includes(t) || (p.item_no || '').toLowerCase().includes(t) || (p.notes || '').toLowerCase().includes(t) || brandName(p.org_id).toLowerCase().includes(t);
    });
  }, [pallets, q, org, when, orgs]);
  const cur = (pallets || []).find((p) => p.id === sel) || null;
  const live = (pallets || []).filter((p) => p.status !== 'void');
  const locName = (id) => (locations || []).find((l) => l.id === id)?.code || '';

  // the register's scan box: a pallet label opens the pallet; a carton label counts the carton and opens its pallet
  const scan = async (code) => {
    const c = cartonOf(code);
    if (c) {
      const { data, error } = await supabase.rpc('wms_scan_carton', { p_code: c.code });
      if (error) { beep('bad'); return setMsg(error.message); }
      beep(data.already ? 'bad' : 'ok'); setQ(''); setSel(data.pallet_id); return setMsg(data.already ? `Carton ${data.seq} of ${data.psku} was already scanned.` : null);
    }
    const want = normPsku(code); const p = (pallets || []).find((x) => x.psku === want);
    if (p) { beep('ok'); setQ(''); setSel(p.id); setMsg(null); } else { beep('bad'); setQ(code); setMsg(`${want} is not on file.`); }
  };

  if (cur) return <Workspace key={cur.id} p={cur} pallets={pallets} locations={locations} brandName={brandName} merge={merge} onBack={() => setSel(null)} onOpen={(x) => setSel(x.id)} />;

  return (
    <>
      <header className="pagehead">
        <h1>Pallets<span className="dot">.</span></h1>
        <div className="glance">
          <div><b className={live.some((p) => p.status === 'open') ? 'hot' : ''}>{live.filter((p) => p.status === 'open').length}</b><small>Cartons to scan</small></div>
          <div><b className={live.some((p) => p.status === 'counted') ? 'hot' : ''}>{live.filter((p) => p.status === 'counted').length}</b><small>To put away</small></div>
          <div><b>{live.filter((p) => p.status === 'stored' || p.status === 'received').length}</b><small>Received</small></div>
        </div>
      </header>

      <div className="toolbar">
        <ScanBox value={q} onChange={(v) => { setQ(v); setMsg(null); }} onScan={scan} placeholder="Scan a pallet or carton label, or type a PSKU#, product or brand" autoFocus />
        <select value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Brand"><option value="">All brands</option>{(orgs || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <div className="seg">{WHEN.map(([k, l]) => <button key={k} className={when === k ? 'on' : ''} onClick={() => setWhen(k)}>{l}</button>)}</div>
      </div>
      {msg && <div className="strip bad"><span>{msg}</span><button className="x" onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <section className="panel">
        {pallets === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">{q.trim() ? 'No pallets match.' : when === 'open' ? 'Every pallet is put away.' : 'No pallets here.'}</div> : (
          <table className="grid pick">
            <thead><tr><th>PSKU#</th><th>Brand</th><th>Product</th><th className="n">Cartons</th><th>Position</th><th>Received</th><th>By</th><th>Status</th></tr></thead>
            <tbody>{list.map((p) => (
              <tr key={p.id} className={p.status === 'void' ? 'void' : ''} onClick={() => setSel(p.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(p.id)}>
                <td className="code">{p.psku}</td><td><b>{brandName(p.org_id)}</b></td>
                <td className="clip">{p.fba && <span className="tag fba">FBA</span>} {p.cle && <span className="tag fba">NCC</span>} {p.item_name || p.notes || '—'}</td>
                <td className="n num">{p.cartons ?? '—'}</td><td className="code">{p.status === 'stored' ? locName(p.location_id) : p.status === 'counted' && p.location_id ? `→ ${locName(p.location_id)}` : '—'}</td>
                <td className="num">{fmtStamp(p.received_at)}</td><td>{p.received_by_name || '—'}</td>
                <td><StatusTag s={p.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

/* ---------- one pallet ---------- */
function Workspace({ p, pallets, locations, brandName, merge, onBack, onOpen }) {
  const [cartons, setCartons] = useState(null);
  const [scanV, setScanV] = useState('');
  const [feed, setFeed] = useState(null);         // { kind: 'ok' | 'bad', text }
  const [got, setGot] = useState({});             // put-away: { loc: true, psku: true }
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [units, setUnits] = useState([]);          // loose units from this pallet's open boxes
  const [ob, setOb] = useState(null);              // open-box dialog: { carton, units } while typing, { made: [...] } once created
  const brand = brandName(p.org_id);
  const [csize, setCsize, cturn, setCturn] = useCartonSize();
  const loc = (locations || []).find((l) => l.id === p.location_id) || null;

  const [cartonsOk, setCartonsOk] = useState(false);   // the carton rows were read and add up: labels may be printed from them
  // Reads can overlap (a scan or an open box reloads while an earlier read is still out). Only the newest one is used,
  // and only for the pallet it was made for; one that comes back after this screen is gone is dropped.
  const reads = useRef(0); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);   // StrictMode runs setup, cleanup, setup in development
  const loadCartons = async () => {
    const mine = ++reads.current; const id = p.id; const stale = () => !alive.current || mine !== reads.current || id !== p.id;
    let c;
    try { c = await fetchCartons(supabase, [id]); }
    catch (x) { if (stale()) return; setCartons([]); setCartonsOk(false); return say('bad', `The cartons of ${p.psku} could not be read (${x.message}). Nothing can be scanned or printed for it until they are: reload to try again.`); }
    if (stale()) return;
    const bad = checkCartons(p, c);
    setCartons(c); setCartonsOk(bad.length === 0);
    if (bad.length) say('bad', `The cartons on file for ${p.psku} do not add up (${bad.join(', ')}). Carton labels cannot be printed. Tell an admin.`);
    const u = await supabase.from('wms_units').select('*').eq('pallet_id', id).order('code');
    if (stale()) return;
    if (u.error) say('bad', `The open-box units of ${p.psku} could not be read (${u.error.message}).`);
    setUnits(u.data || []);
  };
  const printCartons = async (only) => {
    if (!cartonsOk) return say('bad', `No carton labels were printed: the cartons on file for ${p.psku} are not verified.`);
    if (!(await printCartonLabels([pp], () => brand, only, csize, cturn))) say('bad', `The print window did not open. Nothing was printed for ${p.psku}; try again.`);
  };
  useEffect(() => { loadCartons(); }, [p.id]);
  // NCC products (no carton count; cle in the data) have one marker row each: not a carton, never counted here
  const scanned = (cartons || []).filter((c) => !c.cle && c.scanned_at).length; const total = (cartons || []).filter((c) => !c.cle).length;
  const step = p.status === 'open' ? 1 : p.status === 'counted' ? 2 : 3;
  const pp = useMemo(() => ({ ...p, _cartons: cartons || [], _cartonsOk: cartonsOk }), [p, cartons, cartonsOk]);   // the pallet with its cartons: labels and prints read each carton's own product
  const plines = useMemo(() => (cartons?.length ? linesOf(pp) : []), [pp]);
  // how a carton is named on screen: as its label reads. On a mixed pallet that is its number within its own product.
  const cname = (seq) => { const ln = plines.length > 1 ? plines.find((l) => seq >= l.from && seq <= l.to) : null; return ln ? `${ln.item_name}, carton ${seq - ln.from + 1} of ${ln.cartons},` : `Carton ${seq}`; };
  const labelled = total;
  const shelfOf = (id) => (locations || []).find((l) => l.id === id)?.code || '';
  const say = (kind, text) => { beep(kind === 'ok' ? 'ok' : 'bad'); setFeed({ kind, text }); };

  const scanCarton = async (raw) => {
    setScanV('');
    let c = cartonOf(raw);
    if (!c && /^\d{1,3}$/.test(raw.trim()) && total) { const seq = Number(raw); const row = cartons.find((x) => x.seq === seq && !x.cle); if (row) c = { psku: p.psku, seq, code: row.code }; }
    if (!c) { const other = (pallets || []).find((x) => x.psku === normPsku(raw)); if (other && other.id !== p.id) return onOpen(other); return say('bad', /^PSKU/i.test(raw.trim()) ? 'That is the pallet label. Scan the small label on each carton.' : `${raw.trim()} is not a carton label.`); }
    if (c.psku !== p.psku) return say('bad', `Carton ${c.seq} belongs to ${c.psku}, not this pallet. Set it aside.`);
    const { data, error } = await supabase.rpc('wms_scan_carton', { p_code: c.code });
    if (error) return say('bad', error.message);
    setCartons((cs) => cs.map((x) => (x.seq === data.seq ? { ...x, scanned_at: x.scanned_at || new Date().toISOString() } : x)));
    if (data.already) return say('bad', `${cname(data.seq)} was already scanned. ${scanned} of ${total}.`);
    { const now = scanned + 1; setFeed({ kind: 'ok', text: data.scanned === data.total ? `All ${total} cartons are in.` : `${cname(data.seq)} in. ${now} of ${total} on the pallet.` }); } beep('ok');
  };
  const complete = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('wms_complete_count', { p_pallet: p.id });
    setBusy(false); if (error) return say('bad', error.message);
    merge([data]); setFeed(null); beep('ok');
  };
  const pick = async (l) => {
    const { data, error } = await supabase.rpc('wms_assign_location', { p_pallet: p.id, p_location: l.id });
    if (error) return say('bad', error.message);
    merge([data]); setGot({}); setFeed({ kind: 'ok', text: `${p.psku} now goes to ${l.code}.` });
  };
  const scanPutaway = async (raw) => {
    setScanV(''); const t = raw.trim(); let next = { ...got };
    if (normPsku(t) === p.psku) next.psku = true;
    else if (loc && locCode(t) === loc.code.toUpperCase()) next.loc = true;
    else if ((locations || []).some((l) => l.code.toUpperCase() === locCode(t))) return say('bad', `${p.psku} goes to ${loc?.code || 'a position picked on the map'}, not ${locCode(t)}.`);
    else if (/^PSKU|^\d+$/i.test(t)) return say('bad', `That is ${normPsku(t)}, not ${p.psku}.`);
    else return say('bad', `${t} is not a position or a pallet label.`);
    setGot(next);
    if (!(next.loc && next.psku)) { beep('ok'); return setFeed({ kind: 'ok', text: next.loc ? `${loc.code} confirmed. Now scan the pallet label.` : `Pallet confirmed. Now scan the position label at ${loc?.code || 'its position'}.` }); }
    setBusy(true);
    const { data, error } = await supabase.rpc('wms_putaway', { p_pallet: p.id, p_psku: p.psku, p_location_code: loc.code });
    setBusy(false); if (error) { setGot({}); return say('bad', error.message); }
    merge([data]); setFeed(null); beep('ok');
  };
  const openBox = async (e) => {
    e.preventDefault();
    const seq = Number(String(ob.carton).trim()); const viaLabel = cartonOf(ob.carton);
    const row = viaLabel ? (cartons || []).find((x) => x.code === viaLabel.code) : (cartons || []).find((x) => x.seq === seq);
    if (!row) return say('bad', viaLabel ? `Carton ${viaLabel.seq} belongs to ${viaLabel.psku}, not this pallet.` : 'Scan the carton label, or type the carton number.');
    setBusy(true);
    // put away and the count differs from the carton's: a stock correction (admin or staff, with a reason)
    const fix = p.status === 'stored' && row.units_per_carton != null && Number(ob.units) !== row.units_per_carton;
    if (fix && (ob.why || '').trim().length < 4) { setBusy(false); return say('bad', `Carton ${row.seq} holds ${row.units_per_carton} on file. Say why it holds ${Number(ob.units)}; an admin or staff login is needed.`); }
    const { data, error } = fix ? await supabase.rpc('wms_open_box_correct', { p_carton_code: row.code, p_units: Number(ob.units), p_location: null, p_reason: ob.why.trim() }) : await supabase.rpc('wms_open_box', { p_carton_code: row.code, p_units: Number(ob.units) });
    setBusy(false); if (error) return say('bad', error.message);
    await loadCartons();
    const { data: made } = await supabase.from('wms_units').select('*').eq('carton_id', row.id).order('code');
    beep('ok'); setFeed(null); setOb({ made: made || [], seq: data.seq, shelf: data.location });
  };
  const reprint = async () => {
    if (!(await printPalletLabels([pp], () => brand))) return say('bad', `The print window did not open. The pallet label for ${p.psku} was not printed; try again.`);
    const { error } = await supabase.rpc('wms_mark_printed', { p_ids: [p.id] });
    if (!error) merge([{ ...p, label_prints: (p.label_prints || 0) + 1, last_printed_at: new Date().toISOString() }]);
  };
  const doVoid = async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.rpc('wms_void_pallet', { p_id: p.id, p_reason: reason });
    if (error) return say('bad', error.message);
    merge([data]); setVoiding(false);
  };
  const missing = (cartons || []).filter((c) => !c.scanned_at).map((c) => c.seq);

  return (
    <>
      <header className="pagehead">
        <div>
          <button className="back" onClick={onBack}>‹ All pallets</button>
          <h1 className="code">{p.psku}<span className="dot">.</span></h1>
        </div>
        <div className="glance">
          <div><b>{p.cle ? 'NCC' : total ? `${scanned}/${total}` : '—'}</b><small>{p.cle ? 'No carton count' : 'Cartons scanned'}</small></div>
          <div><b className="code">{loc && p.status !== 'open' ? loc.code : '—'}</b><small>{p.status === 'stored' ? 'Position' : 'Goes to'}</small></div>
        </div>
      </header>

      {p.status !== 'void' && p.status !== 'received' && (
        <ol className="steps">
          <li className={step > 1 ? 'done' : 'now'}><i>1</i>Scan cartons</li>
          <li className={step > 2 ? 'done' : step === 2 ? 'now' : ''}><i>2</i>Put away</li>
          <li className={step === 3 ? 'done' : ''}><i>3</i>Received</li>
        </ol>
      )}
      {feed && <div className={`strip ${feed.kind}`}><span>{feed.text}</span><button className="x" onClick={() => setFeed(null)} aria-label="Dismiss">×</button></div>}

      <div className="pwork">
        <div className="pmain">
          {p.status === 'open' && (
            <section className="panel pad">
              <ScanBox value={scanV} onChange={setScanV} onScan={scanCarton} placeholder="Scan each carton label" autoFocus />
              <div className="progress"><div><i style={{ width: `${total ? (100 * scanned) / total : 0}%` }} /></div><b>{scanned} of {total}</b></div>
              {cartons === null ? <div className="empty">Loading cartons…</div> : (
                (plines.length > 1 ? plines : [null]).map((ln, i) => (
                  <div key={i} className="cgroup">
                    {ln && <div className="cgname">{ln.fba && <span className="tag fba">FBA</span>} {ln.cle && <span className="tag fba">NCC</span>} <b>{ln.item_name}</b><span>{ln.item_no ? `${ln.item_no} · ` : ''}{ln.cle ? 'no carton count' : `${ln.cartons} carton${ln.cartons === 1 ? '' : 's'}`}</span>{!ln.cle && <button className="swap" onClick={() => printCartonLabels([pp], () => brand, Array.from({ length: ln.cartons }, (_, k) => ln.from + k), csize, cturn)}>Print these {ln.cartons} label{ln.cartons === 1 ? '' : 's'}</button>}</div>}
                    <div className="ctiles">{cartons.filter((c) => !c.cle && (!ln || (c.seq >= ln.from && c.seq <= ln.to))).map((c) => <span key={c.id} className={`${c.scanned_at ? 'in' : ''} ${c.open_box_at ? 'ob' : ''}`} title={c.open_box_at ? `${c.code} · open box, ${c.open_units} units` : c.code}>{ln ? c.seq - ln.from + 1 : c.seq}</span>)}</div>
                  </div>
                ))
              )}
              <button className="btn go big" disabled={busy || !total || scanned < total} onClick={complete}>
                {scanned < total ? `${total - scanned} carton${total - scanned === 1 ? '' : 's'} not scanned in yet` : busy ? 'Saving…' : 'All cartons in · show where it goes'}
              </button>
              {missing.length > 0 && scanned > 0 && <button className="swap" onClick={() => printCartons(missing)}>Reprint the {missing.length} label{missing.length === 1 ? '' : 's'} not scanned yet</button>}
            </section>
          )}

          {p.status === 'counted' && (
            <section className="panel pad">
              <div className="goto"><small>Take {p.psku} to</small><b>{loc ? loc.code : (locations || []).some((l) => l.shared) ? 'The shared floor' : 'No free position'}</b>{loc?.zone && <span>{loc.zone}</span>}</div>
              {loc ? <>
                <ScanBox value={scanV} onChange={setScanV} onScan={scanPutaway} placeholder={`At ${loc.code}: scan the position label and the pallet label`} autoFocus />
                <div className="checks"><span className={got.loc ? 'in' : ''}>{got.loc ? '✓' : '1'} Position label {loc.code}</span><span className={got.psku ? 'in' : ''}>{got.psku ? '✓' : '2'} Pallet label {p.psku}</span></div>
              </> : (locations || []).some((l) => l.shared)
                ? <div className="hold" data-testid="goto-nexus">Shared positions are confirmed by Nexus, not here. Stand the pallet in a position, open Put away, and scan the pallet and the position: Nexus accepts it or tells you it is taken.</div>
                : <div className="hold">Every pallet position is taken. Pick a floor area on the map, or add positions under Locations.</div>}
              <FloorMap locations={locations} pallets={pallets} brandName={brandName} target={p.location_id} onPick={pick} onOpen={onOpen} />
            </section>
          )}

          {(p.status === 'stored' || p.status === 'received') && (
            <section className="panel pad">
              <div className="goto ok"><small>Received{p.stored_at ? ` ${fmtStamp(p.stored_at)}${p.stored_by_name ? ` by ${p.stored_by_name}` : ''}` : ''}</small><b>{loc ? loc.code : 'No position recorded'}</b>{loc?.zone && <span>{loc.zone}</span>}</div>
              {loc && <FloorMap locations={locations} pallets={pallets} brandName={brandName} target={p.location_id} onOpen={onOpen} />}
            </section>
          )}
          {p.status !== 'void' && <Units p={p} plines={plines} hasRows={(cartons || []).length > 0} done={(row) => { merge([row]); loadCartons(); }} />}
          {p.status !== 'void' && total > 0 && (
            <section className="panel pad obox">
              <div className="obhead"><h3>Open boxes</h3><span>{units.length ? `${units.length} loose unit${units.length === 1 ? '' : 's'} from this pallet` : 'Units from an open box get their own labels and are picked first'}</span>
                <button className="btn" onClick={() => setOb({ carton: '', units: '' })}>Found an open box</button></div>
              {(cartons || []).filter((c) => c.open_box_at).map((c) => { const us = units.filter((u) => u.carton_id === c.id); return (
                <div className="obrow" key={c.id}><b>{cname(c.seq).replace(/,$/, '')}</b><span>{c.open_units} unit{c.open_units === 1 ? '' : 's'} · {us[0]?.item_name || ''} · shelf {shelfOf(us[0]?.location_id) || '—'}{c.open_by_name ? ` · ${c.open_by_name}` : ''}</span>
                  <button className="btn sm" onClick={() => printUnitLabels(us, brand, shelfOf(us[0]?.location_id), csize, cturn)}>Reprint {us.length} unit labels</button></div>
              ); })}
            </section>
          )}
          {p.status === 'void' && <section className="panel pad"><div className="goto"><small>Voided</small><b>{p.void_reason}</b></div></section>}
        </div>

        <aside className="panel detail">
          <LabelPreview pallet={pp} brand={brand} inch={52} />
          {labelled > 0 && (plines.length > 1 ? plines : [{ from: firstLabelled(pp).seq }]).filter((ln) => !ln.cle).map((ln) => <CartonPreview key={ln.from} pallet={pp} brand={brand} carton={cartons[ln.from - 1]} size={csize} width={208} />)}
          <dl>
            <div><dt>Brand</dt><dd>{brand}</dd></div>
            <div><dt>{p.mixed ? 'Mixed pallet' : 'Product'}</dt><dd>{p.mixed && plines.length ? <ul className="plines">{plines.map((ln, i) => <li key={i}><b>{ln.cle ? '' : ln.cartons}</b> {ln.fba && <span className="tag fba">FBA</span>} {ln.cle && <span className="tag fba">NCC</span>} {ln.item_name}{ln.item_no ? ` · ${ln.item_no}` : ''}</li>)}</ul> : <>{p.fba && <span className="tag fba">FBA</span>} {p.cle && <span className="tag fba">NCC</span>} {p.item_name || p.notes || 'Not recorded'}{p.item_no ? ` · ${p.item_no}` : ''}</>}</dd></div>
            <div><dt>Cartons</dt><dd>{p.cartons ?? (p.cle ? 'Not counted' : 'None recorded')}{p.units_per_carton ? ` · ${p.units_per_carton} units each = ${(p.cartons * p.units_per_carton).toLocaleString()}` : ''}</dd></div>
            <div><dt>Entered</dt><dd>{fmtStamp(p.received_at)}{p.received_by_name ? ` · ${p.received_by_name}` : ''}</dd></div>
            {p.counted_at && total > 0 && <div><dt>Cartons checked</dt><dd>{fmtStamp(p.counted_at)}{p.counted_by_name ? ` · ${p.counted_by_name}` : ''}</dd></div>}
          </dl>
          {p.status !== 'void' && !voiding && <div className="acts">
            <button className="btn" onClick={reprint}>Reprint pallet label</button>
            {labelled > 0 && <button className="btn" onClick={() => printCartons(null)}>Reprint {labelled} carton labels</button>}
            {labelled > 0 && <button className="btn sm" onClick={() => printCartons([firstLabelled(pp)?.seq])}>Test with 1 carton label</button>}
            {labelled > 0 && <label className="sizerow">Carton label roll<CartonSizePicker size={csize} onChange={setCsize} /></label>}
            {labelled > 0 && <label className="sizerow">Label direction<CartonTurnPicker turn={cturn} onChange={setCturn} /></label>}
            <button className="btn" onClick={() => setVoiding(true)}>Void pallet</button>
          </div>}
          {voiding && (
            <form className="voidform" onSubmit={doVoid}>
              <label>Why is {p.psku} being voided?<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered twice, wrong product…" autoFocus required maxLength={140} /></label>
              <div className="acts"><button className="btn danger" disabled={!reason.trim()}>Void {p.psku}</button><button type="button" className="btn" onClick={() => setVoiding(false)}>Keep it</button></div>
            </form>
          )}
        </aside>
      </div>

      {ob && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !ob.made && setOb(null)}>
          {ob.made ? (
            <div className="dialog" role="dialog" aria-label="Open box labels">
              <h2>{plines.length > 1 ? 'Open box' : `Carton ${ob.seq}`}<span className="dot">.</span></h2>
              <p className="lead">{ob.made.length} loose unit{ob.made.length === 1 ? '' : 's'} · {ob.made[0]?.item_name} · shelf {ob.shelf}</p>
              <div className="printrow">
                <div className="picks"><CartonSizePicker size={csize} onChange={setCsize} /><CartonTurnPicker turn={cturn} onChange={setCturn} /></div>
                <div><b>{ob.made.length} unit label{ob.made.length === 1 ? '' : 's'}</b><span>One on each unit · {ob.made[0]?.code}{ob.made.length > 1 ? ` to ${ob.made[ob.made.length - 1].code}` : ''}</span></div>
                <button className="btn go" onClick={() => printUnitLabels(ob.made, brand, ob.shelf, csize, cturn)}>Print</button>
              </div>
              <div className="goto"><small>Then put the units on</small><b>{ob.shelf}</b></div>
              <button className="btn big" onClick={() => setOb(null)}>Done</button>
            </div>
          ) : (
            <form className="dialog" onSubmit={openBox} role="dialog" aria-label="Found an open box">
              <h2>Open box<span className="dot">.</span></h2>
              <p className="lead">{p.psku} · {brand}</p>
              <div className="fields">
                <label>Carton<input value={ob.carton} onChange={(e) => setOb({ ...ob, carton: e.target.value })} placeholder="Scan its label or type its number" autoFocus required /></label>
                <label>Units in it<input className="bignum" type="number" min="1" max="500" inputMode="numeric" value={ob.units} onChange={(e) => setOb({ ...ob, units: e.target.value })} required /></label>
                {p.status === 'stored' && <label>Reason, only if the count differs from the carton's (admin or staff)<input value={ob.why || ''} onChange={(e) => setOb({ ...ob, why: e.target.value })} placeholder="Two units missing…" maxLength={140} /></label>}
              </div>
              {feed?.kind === 'bad' && <div className="strip bad"><span>{feed.text}</span></div>}
              <div className="rowbtns"><button className="btn go" disabled={busy || !ob.carton || !Number(ob.units)}>{busy ? 'Saving…' : `Make ${Number(ob.units) || ''} unit labels`}</button><button type="button" className="btn" onClick={() => setOb(null)}>Cancel</button></div>
            </form>
          )}
        </div>
      )}
    </>
  );
}


// Stock: the units behind the pallet. Counted cartons carry units per carton (required at receiving now; asked for here
// on pallets received before that). An NCC product, or a pallet with no cartons, carries the units on the pallet.
// Saving posts the stock to the pallet's position once it is put away, which is what the pick lists read.
function Units({ p, plines, hasRows, done }) {
  const rows = hasRows ? (plines.length ? plines : []) : [{ item_no: p.item_no, item_name: p.item_name || 'This pallet', cle: true, whole: true, units_per_carton: p.units_total }];
  const [vals, setVals] = useState({}); const [busy, setBusy] = useState(null); const [msg, setMsg] = useState(null); const [why, setWhy] = useState('');
  if (!rows.length) return null;
  // a put-away pallet that already has a count: changing it changes stock, so it is a correction (admin or staff, with a reason)
  const fixing = (ln) => p.status === 'stored' && ln.units_per_carton != null;
  const save = async (ln, i) => {
    const v = Math.round(Number(vals[i])); if (!(v >= 0) || vals[i] === '' || vals[i] == null) return;
    if (fixing(ln) && why.trim().length < 4) return setMsg({ kind: 'bad', text: 'Say why the count is being corrected.' });   // checked before the button is locked: a missing reason must leave the form usable
    setBusy(i); setMsg(null);
    const args = { p_pallet: p.id, p_item: p.mixed ? ln.item_no : null, p_units: v };
    const { error } = fixing(ln) ? await supabase.rpc('wms_correct_units', { ...args, p_reason: why.trim() }) : await supabase.rpc('wms_set_units', args);
    if (error) { setBusy(null); return setMsg({ kind: 'bad', text: error.message }); }
    const { data } = await supabase.from('wms_pallets').select('*').eq('id', p.id).single();
    setBusy(null); setVals((x) => ({ ...x, [i]: undefined })); setMsg({ kind: 'ok', text: p.status === 'stored' ? 'Saved. Stock updated at this position.' : 'Saved. Stock posts when the pallet is put away.' });
    if (data) done(data);
  };
  const missing = rows.filter((ln) => ln.units_per_carton == null).length;
  return (
    <section className="panel pad unitsbox">
      <div className="obhead"><h3>Units</h3><span>{missing ? `${missing} product${missing === 1 ? '' : 's'} with no units yet: not on the pick lists until entered` : 'What the pick lists count from'}</span></div>
      {msg && <div className={`strip ${msg.kind}`}><span>{msg.text}</span></div>}
      {rows.some(fixing) && <label className="unitwhy">Reason for a count correction (admin or staff)<input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Recounted at the position…" maxLength={140} /></label>}
      <ul className="unitrows">{rows.map((ln, i) => {
        const perCarton = !ln.cle; const cur = ln.units_per_carton;
        return (
          <li key={i} className={cur == null ? 'need' : ''}>
            <div><b>{ln.item_name}</b><span>{ln.item_no ? `${ln.item_no} · ` : ''}{perCarton ? `${ln.cartons} carton${ln.cartons === 1 ? '' : 's'}${cur != null ? ` × ${cur} = ${(ln.cartons * cur).toLocaleString('en-US')} units` : ''}` : cur != null ? `${Number(cur).toLocaleString('en-US')} units on the pallet` : 'No carton count'}{!ln.item_no && !p.sku_id ? ' · not on the brand’s list, so no stock' : ''}</span></div>
            <label>{perCarton ? 'Units per carton' : 'Units on the pallet'}<input type="number" min="0" inputMode="numeric" value={vals[i] ?? ''} placeholder={cur != null ? String(cur) : ''} onChange={(e) => setVals((x) => ({ ...x, [i]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') save(ln, i); }} /></label>
            <button className="btn sm" disabled={busy != null || vals[i] == null || vals[i] === ''} onClick={() => save(ln, i)}>{busy === i ? 'Saving…' : 'Save'}</button>
          </li>);
      })}</ul>
    </section>
  );
}
