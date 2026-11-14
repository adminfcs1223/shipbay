// Receiving. Product first: pick the brand, find the product on its inventory list, say how many cartons are on the
// pallet. A pallet can hold one product or several (a mixed pallet: one line per product), and any line can be marked
// FBA. The database hands back a PSKU# per pallet and a number per carton; the station is then asked to print the 4x6
// pallet label and one small label per carton (sized to the roll at the station), and the pallet opens for the carton scan.
// The carton labels can also be printed before Receive is pressed: the PSKU# is taken then (wms_hold_pskus) so the
// barcodes are the real ones, and Receive uses that number. What was printed is kept on the station until it is received.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, fmtTime, sameDay } from './lib';
import { printPalletLabels, printCartonLabels, cartonCodes, linesOf, firstLabelled, sizeLabel } from './label';
import { LabelPreview, CartonPreview, CartonSizePicker, CartonTurnPicker, useCartonSize, StatusTag, beep } from './parts.jsx';

const num = (n) => Number(n || 0).toLocaleString();
let lineId = 0;
const newLine = () => ({ id: ++lineId, prod: null, off: false, what: '', q: '', cartons: '', upc: '', fba: false, cle: false });
const lineReady = (l) => !!(l.prod || (l.off && l.what.trim()));
const lineCartons = (l) => (l.cartons === '' ? 0 : Math.max(0, Math.min(500, Math.round(Number(l.cartons) || 0))));
// labels printed before Receive: the form and the PSKU numbers it took, kept on this station until the pallet is received
const loadHold = () => { try { const h = JSON.parse(localStorage.getItem('wms-hold') || 'null'); return h && h.key && h.org && Array.isArray(h.lines) && h.lines.length && h.pskus?.length ? h : null; } catch { return null; } };

export default function Receive({ me, orgs, pallets, brandName, merge, open }) {
  const [saved] = useState(loadHold);
  const [org, setOrg] = useState(() => { if (saved) return saved.org; try { return localStorage.getItem('wms-brand') || ''; } catch { return ''; } });
  const [products, setProducts] = useState(null);
  const [lines, setLines] = useState(() => (saved ? saved.lines.map((l) => ({ ...newLine(), ...l, id: ++lineId })) : [newLine()]));
  const [count, setCount] = useState(saved?.count || 1);
  const [hold, setHold] = useState(saved ? { pskus: saved.pskus, sig: saved.sig, full: !!saved.full } : null);   // carton labels printed before Receive
  const [holding, setHolding] = useState(false);
  const lastOrg = useRef(saved ? saved.org : null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);         // pallets just made (with their cartons) → the print prompt
  const [printed, setPrinted] = useState({});
  const [err, setErr] = useState(null);
  const key = useRef(saved?.key || crypto.randomUUID());
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

  const cur = orgs?.find((o) => o.id === org);
  const setLine = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const mixed = lines.length > 1;
  const today = useMemo(() => (pallets || []).filter((p) => sameDay(p.received_at)), [pallets]);
  const waiting = (pallets || []).filter((p) => p.status === 'open' || p.status === 'counted');
  const n = Math.max(1, Math.min(60, Number(count) || 1));
  const total = lines.reduce((s, l) => s + lineCartons(l), 0);
  const printable = lines.reduce((s, l) => s + (l.cle ? 0 : lineCartons(l)), 0);   // cartons that get a label: CLE (carton logging exempt) lines do not
  const problem = !org ? 'Pick a brand' : !lines.every(lineReady) ? (mixed ? 'Pick every product' : 'Pick the product') : mixed && lines.some((l) => !lineCartons(l)) ? 'Every product needs its carton count' : total > 500 ? 'Up to 500 cartons on a pallet' : null;

  const sig = JSON.stringify([org, n, lines.map((l) => [l.prod?.id || l.what.trim(), lineCartons(l), l.upc, l.fba, !!l.cle])]);
  const stale = !!hold && hold.sig !== sig;   // the form changed after the labels were printed
  useEffect(() => {
    try { hold ? localStorage.setItem('wms-hold', JSON.stringify({ key: key.current, org, lines, count: n, pskus: hold.pskus, sig: hold.sig, full: hold.full })) : localStorage.removeItem('wms-hold'); } catch { /* storage off */ }
  }, [hold, org, lines, n]);
  // the pallets as they will be received, cartons numbered the way the database numbers them
  const draft = (pskus) => {
    const w = Math.max(2, String(total).length); const one = lines[0];
    return pskus.map((psku, i) => {
      const num = psku.replace(/\D/g, '') || '000000'; let seq = 0; const cs = [];
      lines.forEach((l) => { for (let g = 0; g < lineCartons(l); g++) { seq += 1; cs.push({ seq, code: `C${num}${String(seq).padStart(w, '0')}`, item_no: l.prod?.sku || null, item_name: l.prod?.name || l.what.trim(), units_per_carton: l.upc === '' ? null : Number(l.upc), fba: l.fba, cle: !!l.cle }); } });
      return { psku, org_id: org, batch_pos: i + 1, batch_size: pskus.length, received_at: new Date().toISOString(), mixed, fba: lines.every((l) => l.fba), cle: total > 0 && lines.every((l) => l.cle), cartons: total || null, units_per_carton: !mixed && one.upc !== '' ? Number(one.upc) : null, item_no: mixed ? null : one.prod?.sku, item_name: mixed ? `Mixed pallet · ${lines.length} products` : one.prod?.name || (one.off ? one.what : ''), received_by_name: me.full_name || me.email, _cartons: cs };
    });
  };
  // Print carton labels before Receive: take the PSKU numbers for this form, then print with the real barcodes.
  const printFirst = async (only) => {
    if (problem || !printable || holding) return;
    setHolding(true); setErr(null);
    const { data, error } = await supabase.rpc('wms_hold_pskus', { p_key: key.current, p_pallets: n });
    setHolding(false);
    if (error || !data?.length) { beep('bad'); return setErr(error?.message || 'No pallet number came back. Check the connection and try again.'); }
    setHold((h) => ({ pskus: data, sig, full: !only || !!(h?.full && h.sig === sig) }));   // full = every carton label has been printed for the form as it stands
    await printCartonLabels(draft(data), () => cur?.name || '', only || null, csize, cturn);
  };
  const heldName = hold ? (hold.pskus.length === 1 ? hold.pskus[0] : `${hold.pskus[0]} → ${hold.pskus[hold.pskus.length - 1]}`) : '';
  const dropHold = () => { setHold(null); key.current = crypto.randomUUID(); };

  const receive = async (e) => {
    e?.preventDefault();
    if (problem || busy) return;
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc('wms_receive', {
      p_org: org, p_pallets: n, p_notes: null, p_key: key.current,
      p_lines: lines.map((l) => ({ sku: l.prod?.id || null, name: l.prod ? null : l.what.trim(), cartons: lineCartons(l), units_per_carton: l.upc === '' ? null : Number(l.upc), fba: l.fba, cle: !!l.cle })),
    });
    if (error || !data?.length) { setBusy(false); beep('bad'); return setErr(error?.message || 'Nothing came back. Check the connection and press Receive again; it will not make a second pallet.'); }
    // the carton rows carry each carton's product: the labels are printed from them
    const { data: cs } = await supabase.from('wms_cartons').select('*').in('pallet_id', data.map((p) => p.id)).order('seq');
    setBusy(false);
    key.current = crypto.randomUUID();
    beep('ok'); merge(data); setDone(data.map((p) => ({ ...p, _cartons: (cs || []).filter((c) => c.pallet_id === p.id) })));
    setPrinted(hold?.full && !stale && hold.pskus.join() === data.map((p) => p.psku).join() ? { cartons: true, early: true } : {});
    setHold(null); setLines([newLine()]); setCount(1);
  };
  const printPallet = async () => {
    await printPalletLabels(done, (p) => brandName(p.org_id)); setPrinted((x) => ({ ...x, pallet: true }));
    const { error } = await supabase.rpc('wms_mark_printed', { p_ids: done.map((r) => r.id) });
    if (!error) merge(done.map(({ _cartons, ...r }) => ({ ...r, label_prints: (r.label_prints || 0) + 1, last_printed_at: new Date().toISOString() })));
  };
  const testCarton = () => printCartonLabels([done[0]], (p) => brandName(p.org_id), [firstLabelled(done[0])?.seq], csize, cturn);   // one label, to check size and direction before the full run
  const printCartons = async () => { await printCartonLabels(done, (p) => brandName(p.org_id), null, csize, cturn); setPrinted((x) => ({ ...x, cartons: true })); };
  const toPallet = () => { const first = done[0]; setDone(null); open(first.psku); };

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

      {err && <div className="strip bad"><b>Not received.</b><span>{err}</span><button className="x" onClick={() => setErr(null)} aria-label="Dismiss">×</button></div>}

      <div className="station">
        <form className="panel entry" onSubmit={receive}>
          <div className="step"><i>1</i><h3>Brand</h3></div>
          {orgs === null ? <div className="empty">Loading brands…</div> : orgs.length === 0 ? <div className="empty">No brands on file yet.</div> : (
            <div className="brands">{orgs.map((o) => (
              <button type="button" key={o.id} className={o.id === org ? 'on' : ''} onClick={() => setOrg(o.id)} aria-pressed={o.id === org}><b>{o.name}</b></button>
            ))}</div>
          )}

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

          <button className="btn go big" disabled={!!problem || busy}>
            {busy ? 'Receiving…' : problem || <>Receive {n} {mixed ? 'mixed ' : ''}pallet{n > 1 ? 's' : ''}{total ? ` · ${num(total * n)} carton${total * n > 1 ? 's' : ''}` : ''}<kbd>Enter</kbd></>}
          </button>
        </form>

        <div className="panel preview">
          <div className="panelhead"><h3>Labels</h3><span>4 × 6 and {sizeLabel(csize)} in</span></div>
          <LabelPreview pallet={sample} brand={cur?.name || 'Brand'} ghost />
          {sampleLines.map((ln) => (
            <div className="flav" key={ln.from}>
              <CartonPreview pallet={sample} brand={cur?.name || 'Brand'} carton={cartonCodes(sample)[ln.from - 1]} size={csize} />
              {mixed && <small>{num(ln.cartons)} carton{ln.cartons === 1 ? '' : 's'} · labels 1 to {ln.cartons}<button type="button" className="swap" disabled={holding || !!problem} onClick={() => printFirst(Array.from({ length: ln.cartons }, (_, i) => ln.from + i))}>Print {num(ln.cartons * n)}</button></small>}
            </div>
          ))}
          {total > 0 && !printable && <div className="hold">CLE: no carton labels. The pallet goes straight to put-away.</div>}
          {printable > 0 && !problem && (
            <div className="early">
              {stale && <div className="strip bad"><span>The form changed after labels were printed for {heldName}. Print them again, or put the form back.</span></div>}
              {hold && !stale && <div className="strip ok"><span>{hold.full ? <>Carton labels printed for <b>{heldName}</b>. Press Receive when they are on.</> : <><b>{heldName}</b> is held for this pallet. Not every carton label is printed yet.</>}</span></div>}
              <div className="picks row"><CartonSizePicker size={csize} onChange={setCsize} /><CartonTurnPicker turn={cturn} onChange={setCturn} /></div>
              <button type="button" className="btn" disabled={holding} onClick={() => printFirst()}>{holding ? 'Getting the pallet number…' : `${hold?.full && !stale ? 'Print again' : 'Print now'} · ${num(printable * n)} carton label${printable * n > 1 ? 's' : ''}`}</button>
              <button type="button" className="btn sm" disabled={holding} onClick={() => printFirst([firstLabelled(sample)?.seq])}>Test with 1 label</button>
              {hold && <button type="button" className="swap" onClick={dropHold}>Throw those labels away and start over</button>}
            </div>
          )}
        </div>
      </div>

      <section className="panel">
        <div className="panelhead"><h3>Not finished</h3><span>{waiting.length} pallet{waiting.length === 1 ? '' : 's'}</span></div>
        {pallets === null ? <div className="empty">Loading…</div> : waiting.length === 0 ? <div className="empty">Every pallet is put away.</div> : (
          <table className="grid pick">
            <thead><tr><th>PSKU#</th><th>Brand</th><th>Product</th><th className="n">Cartons</th><th>Received</th><th>By</th><th>Next step</th></tr></thead>
            <tbody>{waiting.map((p) => (
              <tr key={p.id} onClick={() => open(p.psku)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(p.psku)}>
                <td className="code">{p.psku}</td><td><b>{brandName(p.org_id)}</b></td>
                <td className="clip">{p.fba && <span className="tag fba">FBA</span>} {p.cle && <span className="tag fba">CLE</span>} {p.item_name || p.notes || '—'}</td>
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
                  <button className="btn sm" onClick={() => printCartonLabels(done, (p) => brandName(p.org_id), Array.from({ length: ln.cartons }, (_, i) => ln.from + i), csize, cturn)}>Print {num(ln.cartons * done.length)}</button>
                </div>
              ))}</div>
            )}
            {doneCartons > 0 && doneLines.length <= 1 && <div className="proof"><CartonPreview pallet={done[0]} brand={brandName(done[0].org_id)} carton={firstLabelled(done[0])} size={csize} turn={cturn} width={300} /><small>How it leaves the printer</small></div>}
            <button className={`btn big ${printed.pallet && (printed.cartons || !doneCartons) ? 'go' : ''}`} onClick={toPallet}>{doneCartons ? 'Labels are on · scan the cartons' : 'Label is on · put it away'}</button>
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
          <label>Cartons{mixed ? ' of this product' : ' on the pallet'}<input className="bignum" type="number" min="0" max="500" inputMode="numeric" value={l.cartons} onChange={(e) => set({ cartons: e.target.value })} autoFocus /></label>
          <label>Units per carton <em>optional</em><input className="bignum" type="number" min="1" inputMode="numeric" value={l.upc} onChange={(e) => set({ upc: e.target.value })} /></label>
          <button type="button" className={`fbatoggle ${l.fba ? 'on' : ''}`} onClick={() => set({ fba: !l.fba })} aria-pressed={l.fba}><i>{l.fba ? '✓' : ''}</i>FBA</button>
          <button type="button" className={`fbatoggle ${l.cle ? 'on' : ''}`} onClick={() => set({ cle: !l.cle })} aria-pressed={!!l.cle} title="Carton logging exempt: no carton labels, no carton scan"><i>{l.cle ? '✓' : ''}</i>CLE</button>
        </div>
      )}
    </div>
  );
}
