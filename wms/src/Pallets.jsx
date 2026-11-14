// Pallets. The register (scan or search any pallet) and, once one is open, the pallet's own work screen:
//   Scan cartons → every carton label scanned in · Put away → the map shows its position; scan the position label and
//   the PSKU label there · Received. A pallet entered by mistake is voided with a reason, never deleted.
import { useEffect, useMemo, useState } from 'react';
import { supabase, fmtStamp, sameDay } from './lib';
import { printPalletLabels, printCartonLabels } from './label';
import { LabelPreview, CartonPreview, CartonSizePicker, useCartonSize, ScanBox, StatusTag, FloorMap, beep, normPsku } from './parts.jsx';

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
                <td className="clip">{p.item_name || p.notes || '—'}</td>
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
  const brand = brandName(p.org_id);
  const [csize, setCsize] = useCartonSize();
  const loc = (locations || []).find((l) => l.id === p.location_id) || null;

  const loadCartons = async () => { const { data } = await supabase.from('wms_cartons').select('*').eq('pallet_id', p.id).order('seq'); setCartons(data || []); };
  useEffect(() => { loadCartons(); }, [p.id]);
  const scanned = (cartons || []).filter((c) => c.scanned_at).length; const total = (cartons || []).length;
  const step = p.status === 'open' ? 1 : p.status === 'counted' ? 2 : 3;
  const say = (kind, text) => { beep(kind === 'ok' ? 'ok' : 'bad'); setFeed({ kind, text }); };

  const scanCarton = async (raw) => {
    setScanV('');
    let c = cartonOf(raw);
    if (!c && /^\d{1,3}$/.test(raw.trim()) && total) { const seq = Number(raw); const row = cartons.find((x) => x.seq === seq); if (row) c = { psku: p.psku, seq, code: row.code }; }
    if (!c) { const other = (pallets || []).find((x) => x.psku === normPsku(raw)); if (other && other.id !== p.id) return onOpen(other); return say('bad', /^PSKU/i.test(raw.trim()) ? 'That is the pallet label. Scan the small label on each carton.' : `${raw.trim()} is not a carton label.`); }
    if (c.psku !== p.psku) return say('bad', `Carton ${c.seq} belongs to ${c.psku}, not this pallet. Set it aside.`);
    const { data, error } = await supabase.rpc('wms_scan_carton', { p_code: c.code });
    if (error) return say('bad', error.message);
    setCartons((cs) => cs.map((x) => (x.seq === data.seq ? { ...x, scanned_at: x.scanned_at || new Date().toISOString() } : x)));
    if (data.already) return say('bad', `Carton ${data.seq} was already scanned. ${data.scanned} of ${data.total}.`);
    setFeed({ kind: 'ok', text: data.scanned === data.total ? `All ${data.total} cartons are in.` : `Carton ${data.seq} in. ${data.scanned} of ${data.total}.` }); beep('ok');
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
  const reprint = async () => {
    await printPalletLabels([p], () => brand);
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
          <div><b>{total ? `${scanned}/${total}` : '—'}</b><small>Cartons scanned</small></div>
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
                <div className="ctiles">{cartons.map((c) => <span key={c.id} className={c.scanned_at ? 'in' : ''} title={c.code}>{c.seq}</span>)}</div>
              )}
              <button className="btn go big" disabled={busy || !total || scanned < total} onClick={complete}>
                {scanned < total ? `${total - scanned} carton${total - scanned === 1 ? '' : 's'} not scanned in yet` : busy ? 'Saving…' : 'All cartons in · show where it goes'}
              </button>
              {missing.length > 0 && scanned > 0 && <button className="swap" onClick={() => printCartonLabels([p], () => brand, missing, csize)}>Reprint the {missing.length} label{missing.length === 1 ? '' : 's'} not scanned yet</button>}
            </section>
          )}

          {p.status === 'counted' && (
            <section className="panel pad">
              <div className="goto"><small>Take {p.psku} to</small><b>{loc ? loc.code : 'No free position'}</b>{loc?.zone && <span>{loc.zone}</span>}</div>
              {loc ? <>
                <ScanBox value={scanV} onChange={setScanV} onScan={scanPutaway} placeholder={`At ${loc.code}: scan the position label and the pallet label`} autoFocus />
                <div className="checks"><span className={got.loc ? 'in' : ''}>{got.loc ? '✓' : '1'} Position label {loc.code}</span><span className={got.psku ? 'in' : ''}>{got.psku ? '✓' : '2'} Pallet label {p.psku}</span></div>
              </> : <div className="hold">Every pallet position is taken. Pick a floor area on the map, or add positions under Locations.</div>}
              <FloorMap locations={locations} pallets={pallets} brandName={brandName} target={p.location_id} onPick={pick} onOpen={onOpen} />
            </section>
          )}

          {(p.status === 'stored' || p.status === 'received') && (
            <section className="panel pad">
              <div className="goto ok"><small>Received{p.stored_at ? ` ${fmtStamp(p.stored_at)}${p.stored_by_name ? ` by ${p.stored_by_name}` : ''}` : ''}</small><b>{loc ? loc.code : 'No position recorded'}</b>{loc?.zone && <span>{loc.zone}</span>}</div>
              {loc && <FloorMap locations={locations} pallets={pallets} brandName={brandName} target={p.location_id} onOpen={onOpen} />}
            </section>
          )}
          {p.status === 'void' && <section className="panel pad"><div className="goto"><small>Voided</small><b>{p.void_reason}</b></div></section>}
        </div>

        <aside className="panel detail">
          <LabelPreview pallet={p} brand={brand} inch={52} />
          {total > 0 && <CartonPreview pallet={p} brand={brand} carton={cartons[0]} size={csize} width={208} />}
          <dl>
            <div><dt>Brand</dt><dd>{brand}</dd></div>
            <div><dt>Product</dt><dd>{p.item_name || p.notes || 'Not recorded'}{p.item_no ? ` · ${p.item_no}` : ''}</dd></div>
            <div><dt>Cartons</dt><dd>{p.cartons ?? 'None recorded'}{p.units_per_carton ? ` · ${p.units_per_carton} units each = ${(p.cartons * p.units_per_carton).toLocaleString()}` : ''}</dd></div>
            <div><dt>Entered</dt><dd>{fmtStamp(p.received_at)}{p.received_by_name ? ` · ${p.received_by_name}` : ''}</dd></div>
            {p.counted_at && total > 0 && <div><dt>Cartons checked</dt><dd>{fmtStamp(p.counted_at)}{p.counted_by_name ? ` · ${p.counted_by_name}` : ''}</dd></div>}
          </dl>
          {p.status !== 'void' && !voiding && <div className="acts">
            <button className="btn" onClick={reprint}>Reprint pallet label</button>
            {total > 0 && <button className="btn" onClick={() => printCartonLabels([p], () => brand, null, csize)}>Reprint {total} carton labels</button>}
            {total > 0 && <label className="sizerow">Carton label roll<CartonSizePicker size={csize} onChange={setCsize} /></label>}
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
    </>
  );
}
