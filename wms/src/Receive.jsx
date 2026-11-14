// Receiving station. A pallet comes off the truck → pick its brand → Receive. The database hands back a PSKU# for
// each pallet and the 4x6 labels go to the printer. Several pallets off the same truck can be received in one go;
// each still gets its own PSKU# and its own label.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, fmtTime, sameDay } from './lib';
import { printPalletLabels } from './label';
import { LabelPreview, beep } from './parts.jsx';

const QUICK = [1, 2, 4, 6, 10];
const BLANK = { reference: '', carrier: '', cartons: '', notes: '' };

export default function Receive({ me, orgs, pallets, brandName, merge, open }) {
  const [org, setOrg] = useState(() => { try { return localStorage.getItem('wms-brand') || ''; } catch { return ''; } });
  const [count, setCount] = useState(1);
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);     // the pallets just received
  const [err, setErr] = useState(null);
  const key = useRef(crypto.randomUUID());    // one key per attempt: a retry returns the same pallets

  useEffect(() => { if (orgs && org && !orgs.some((o) => o.id === org)) setOrg(''); }, [orgs]);
  useEffect(() => { try { org ? localStorage.setItem('wms-brand', org) : localStorage.removeItem('wms-brand'); } catch { /* storage off */ } }, [org]);

  const today = useMemo(() => (pallets || []).filter((p) => sameDay(p.received_at)), [pallets]);
  const live = today.filter((p) => p.status !== 'void');
  const perBrand = useMemo(() => { const m = {}; live.forEach((p) => { m[p.org_id] = (m[p.org_id] || 0) + 1; }); return m; }, [live]);
  const n = Math.max(1, Math.min(60, Number(count) || 1));

  const print = async (rows) => {
    await printPalletLabels(rows, (p) => brandName(p.org_id));
    const { error } = await supabase.rpc('wms_mark_printed', { p_ids: rows.map((r) => r.id) });
    if (!error) merge(rows.map((r) => ({ ...r, label_prints: (r.label_prints || 0) + 1, last_printed_at: new Date().toISOString() })));
  };

  const receive = async (e) => {
    e?.preventDefault();
    if (!org || busy) return;
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc('wms_receive_pallets', {
      p_org: org, p_count: n, p_reference: f.reference || null, p_carrier: f.carrier || null,
      p_cartons: f.cartons === '' ? null : Number(f.cartons), p_notes: f.notes || null, p_key: key.current,
    });
    setBusy(false);
    if (error || !data?.length) { beep('bad'); return setErr(error?.message || 'Nothing came back. Check the connection and press Receive again; it will not make a second pallet.'); }
    key.current = crypto.randomUUID();
    beep('ok'); merge(data); setDone(data); setCount(1); setF({ ...BLANK, carrier: f.carrier });
    print(data);
  };

  const cur = orgs?.find((o) => o.id === org);
  const sample = { psku: 'PSKU-______', batch_pos: 1, batch_size: n, received_at: new Date().toISOString(), reference: f.reference, carrier: f.carrier, cartons: f.cartons === '' ? null : Number(f.cartons), notes: f.notes, received_by_name: me.full_name || me.email };
  const shown = done?.[0];

  return (
    <>
      <header className="pagehead">
        <h1>Receiving<span className="dot">.</span></h1>
        <div className="glance">
          <div><b>{live.length}</b><small>Pallets today</small></div>
          <div><b>{Object.keys(perBrand).length}</b><small>Brands today</small></div>
          <div><b className="code">{(pallets || []).find((p) => p.status !== 'void')?.psku?.replace('PSKU-', '') || '—'}</b><small>Last PSKU#</small></div>
        </div>
      </header>

      {done && (
        <div className="strip ok">
          <b>{done.length === 1 ? done[0].psku : `${done[0].psku} → ${done[done.length - 1].psku}`}</b>
          <span>{brandName(done[0].org_id)} · {done.length} label{done.length > 1 ? 's' : ''} sent to the printer</span>
          <button onClick={() => print(done)}>Print again</button>
          <button className="x" onClick={() => setDone(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {err && <div className="strip bad"><b>Not received.</b><span>{err}</span><button className="x" onClick={() => setErr(null)} aria-label="Dismiss">×</button></div>}

      <div className="station">
        <form className="panel entry" onSubmit={receive}>
          <div className="step"><i>1</i><h3>Brand</h3></div>
          {orgs === null ? <div className="empty">Loading brands…</div> : orgs.length === 0 ? <div className="empty">No brands on file yet.</div> : (
            <div className="brands">{orgs.map((o) => (
              <button type="button" key={o.id} className={o.id === org ? 'on' : ''} onClick={() => setOrg(o.id)} aria-pressed={o.id === org}>
                <b>{o.name}</b><small>{perBrand[o.id] ? `${perBrand[o.id]} today` : 'none today'}</small>
              </button>
            ))}</div>
          )}

          <div className="step"><i>2</i><h3>Pallets on this delivery</h3></div>
          <div className="countrow">
            <div className="stepper">
              <button type="button" onClick={() => setCount(Math.max(1, n - 1))} aria-label="One fewer">−</button>
              <input type="number" min="1" max="60" value={count} onChange={(e) => setCount(e.target.value)} onBlur={() => setCount(n)} aria-label="Number of pallets" />
              <button type="button" onClick={() => setCount(Math.min(60, n + 1))} aria-label="One more">+</button>
            </div>
            <div className="quick">{QUICK.map((q) => <button type="button" key={q} className={n === q ? 'on' : ''} onClick={() => setCount(q)}>{q}</button>)}</div>
          </div>

          <div className="step"><i>3</i><h3>Delivery details</h3><span>optional</span></div>
          <div className="fields">
            <label>Reference<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="PO, BOL or ASN" maxLength={60} /></label>
            <label>Carrier<input value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} placeholder="Who delivered it" maxLength={60} /></label>
            <label>Cartons per pallet<input type="number" min="0" value={f.cartons} onChange={(e) => setF({ ...f, cartons: e.target.value })} /></label>
            <label>Notes<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Damage, shrink wrap, leaning…" maxLength={140} /></label>
          </div>

          <button className="btn go big" disabled={!org || busy}>
            {busy ? 'Receiving…' : !org ? 'Pick a brand' : <>Receive {n} pallet{n > 1 ? 's' : ''} · print {n > 1 ? `${n} labels` : 'label'}<kbd>Enter</kbd></>}
          </button>
        </form>

        <div className="panel preview">
          <div className="panelhead"><h3>{shown ? 'Last label' : 'Label'}</h3><span>4 × 6 in</span></div>
          <LabelPreview pallet={shown || sample} brand={shown ? brandName(shown.org_id) : (cur?.name || 'Brand')} ghost={!shown} />
          {shown && <button className="btn" onClick={() => print(done)}>Print again</button>}
        </div>
      </div>

      <section className="panel">
        <div className="panelhead"><h3>Received today</h3><span>{live.length} pallet{live.length === 1 ? '' : 's'}</span></div>
        {pallets === null ? <div className="empty">Loading…</div> : today.length === 0 ? <div className="empty">Nothing received yet today.</div> : (
          <table className="grid">
            <thead><tr><th>PSKU#</th><th>Brand</th><th>Pallet</th><th>Reference</th><th>Carrier</th><th className="n">Cartons</th><th>Time</th><th>By</th><th className="n">Prints</th><th /></tr></thead>
            <tbody>{today.map((p) => (
              <tr key={p.id} className={p.status === 'void' ? 'void' : ''}>
                <td><button className="code link" onClick={() => open(p.psku)}>{p.psku}</button></td>
                <td><b>{brandName(p.org_id)}</b></td>
                <td className="num">{p.batch_pos} of {p.batch_size}</td>
                <td>{p.reference || '—'}</td><td>{p.carrier || '—'}</td>
                <td className="n num">{p.cartons ?? '—'}</td>
                <td className="num">{fmtTime(p.received_at)}</td><td>{p.received_by_name || '—'}</td>
                <td className="n num">{p.label_prints}</td>
                <td className="n">{p.status === 'void' ? <span className="tag bad">Void</span> : <button className="btn sm" onClick={() => print([p])}>Reprint</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
