// Receiving — brand first. Pick the brand → its inbounds → one inbound → pick the SKU you're counting → label prompt
// (scan the existing 3×1 labels, or print a batch and stick them on) → scan units one by one → next SKU → Finalize.
// A scan that isn't the chosen SKU is refused, so counts never cross. New inbound takes the expected SKUs + quantities.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
import { ScanBox, beep, printSkuLabels, printLocationLabels, fmtDate } from '../ops';
import { useBrands, BrandPicker, BrandBar } from '../shared';

const ST = { expected: ['Expected', 'muted'], in_transit: ['Receiving', 'navy'], received: ['Received', 'ok'], discrepancy: ['Discrepancy', 'warn'], cancelled: ['Cancelled', 'bad'] };
const TABS = [['open', 'To receive'], ['done', 'Received'], ['all', 'All']];
const OPEN_ST = ['expected', 'in_transit', 'discrepancy'];

export default function Receiving({ me, brand, setBrand }) {
  const [inbounds, setInbounds] = useState(null);
  const [orgs] = useBrands();
  const [locs, setLocs] = useState([]);
  const [tab, setTab] = useState('open');
  const [sel, setSel] = useState(null);
  const [lines, setLines] = useState([]);
  const [skus, setSkus] = useState([]);
  const [skuId, setSkuId] = useState(null);     // the SKU being counted
  const [labels, setLabels] = useState(null);   // 'have' | 'printed' — answered the label prompt for this SKU
  const [batch, setBatch] = useState('');
  const [loc, setLoc] = useState('');
  const [last, setLast] = useState(null);
  const [unknown, setUnknown] = useState(null);
  const [creating, setCreating] = useState(false);
  const [addSku, setAddSku] = useState({ sku_id: '', qty: '' });
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const [{ data: i }, { data: l }] = await Promise.all([
      supabase.from('inbound_shipments').select('*, org:orgs(name)').order('expected_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(400),
      supabase.from('locations').select('*').order('code'),
    ]);
    setInbounds(i || []); setLocs(l || []);
    if (!loc && l?.length) setLoc(l.find((x) => x.code === 'RCV-DOCK')?.id || l[0].id);
  };
  const loadLines = async (id) => { const { data } = await supabase.from('inbound_lines').select('*, sku:skus(id, sku, name, variant, barcode)').eq('inbound_id', id).order('created_at'); setLines(data || []); };
  useEffect(() => { load(); }, []);
  const org = (orgs || []).find((o) => o.id === brand) || null;
  const mine = useMemo(() => (inbounds || []).filter((i) => !brand || i.org_id === brand), [inbounds, brand]);
  const current = mine.find((i) => i.id === sel) || null;
  useEffect(() => {
    setLast(null); setUnknown(null); setSkuId(null); setLabels(null);
    if (!current) { setLines([]); setSkus([]); return; }
    loadLines(current.id);
    supabase.from('skus').select('id, sku, name, variant, barcode').eq('org_id', current.org_id).eq('active', true).order('sku').then(({ data }) => setSkus(data || []));
  }, [current?.id]);
  useEffect(() => { setLabels(null); setLast(null); setUnknown(null); setBatch(''); }, [skuId]);

  const list = useMemo(() => mine.filter((i) => tab === 'all' || (tab === 'open' ? OPEN_ST.includes(i.status) : i.status === 'received')), [mine, tab]);
  const totals = useMemo(() => ({ exp: lines.reduce((s, l) => s + (l.qty_expected || 0), 0), rec: lines.reduce((s, l) => s + (l.qty_received || 0), 0) }), [lines]);
  const closed = current && ['received', 'cancelled'].includes(current.status);
  const curSku = skus.find((s) => s.id === skuId) || lines.find((l) => l.sku?.id === skuId)?.sku || null;
  const curLine = lines.find((l) => l.sku?.id === skuId) || null;
  const allMatched = lines.length > 0 && lines.every((l) => (l.qty_expected || 0) === (l.qty_received || 0));

  const scan = async (code, qty = 1) => {
    if (!current || closed) return;
    if (/^LOC-/i.test(code)) { const l = locs.find((x) => x.code.toLowerCase() === code.slice(4).toLowerCase()); if (l) { setLoc(l.id); beep('ok'); setLast({ kind: 'loc', text: `Put-away location set to ${l.code}` }); } else beep('bad'); return; }
    if (!skuId) { beep('bad'); return setLast({ kind: 'bad', text: 'Pick the SKU you’re counting first.' }); }
    const { data, error } = await supabase.rpc('scan_receive_sku', { p_inbound_id: current.id, p_sku_id: skuId, p_code: code, p_qty: qty });
    if (error) { beep('bad'); return setLast({ kind: 'bad', text: error.message }); }
    if (!data.found) { beep('bad'); setUnknown(code); return setLast({ kind: 'bad', text: `Unknown barcode ${code}. If it’s a ${curSku?.sku} label, save it below and it’ll count from now on.` }); }
    if (data.wrong_item) { beep('bad'); return setLast({ kind: 'bad', text: `That’s ${data.sku} (${data.name}) — you’re counting ${data.expected_sku}. Switch SKU or put it aside.` }); }
    beep(data.qty_expected && data.qty_received >= data.qty_expected ? 'done' : 'ok');
    setUnknown(null);
    setLast({ kind: data.qty_expected && data.qty_received > data.qty_expected ? 'warn' : 'ok', sku: data.sku, name: data.name + (data.variant ? ` — ${data.variant}` : ''), rec: data.qty_received, exp: data.qty_expected });
    await loadLines(current.id);
    if (current.status === 'expected') load();
  };
  const saveBarcode = async () => {
    if (!unknown || !skuId) return;
    setBusy('assign');
    const { error } = await supabase.from('skus').update({ barcode: unknown }).eq('id', skuId);
    setBusy(null); if (error) return setMsg({ kind: 'err', text: error.message });
    setSkus(skus.map((s) => (s.id === skuId ? { ...s, barcode: unknown } : s)));
    const code = unknown; setUnknown(null); await scan(code);
  };
  const adjust = async (l, d) => { setSkuId(l.sku.id); setLabels('have'); await supabase.rpc('scan_receive_sku', { p_inbound_id: current.id, p_sku_id: l.sku.id, p_code: l.sku.barcode || l.sku.sku, p_qty: d }); loadLines(current.id); };
  const printBatch = () => { const n = Math.max(1, Number(batch) || curLine?.qty_expected || 1); if (curSku) { printSkuLabels([curSku], n); setLabels('printed'); } };
  const finalize = async () => {
    if (!current) return;
    const short = lines.filter((l) => l.qty_received !== l.qty_expected);
    if (!window.confirm(`Finalize ${current.reference || 'this inbound'}: ${totals.rec} units received${short.length ? ` — ${short.length} line${short.length > 1 ? 's' : ''} differ from what was expected (this will be flagged for ${org?.name})` : ', everything as expected'}. Inventory posts to ${locs.find((x) => x.id === loc)?.code || 'RCV-DOCK'}.`)) return;
    setBusy('final');
    const { data, error } = await supabase.rpc('finalize_inbound', { p_inbound_id: current.id, p_location_id: loc || null });
    setBusy(null); if (error) return setMsg({ kind: 'err', text: error.message });
    beep('done');
    setMsg({ kind: data.discrepancy ? 'err' : 'ok', text: data.discrepancy ? `Received ${data.units} units with discrepancies — flagged for the client.` : `Received ${data.units} units. Inventory is live.` });
    await load(); await loadLines(current.id); setSkuId(null);
  };
  const addExpected = async (e) => {
    e.preventDefault(); if (!addSku.sku_id || !addSku.qty) return;
    const { error } = await supabase.from('inbound_lines').upsert({ inbound_id: current.id, sku_id: addSku.sku_id, qty_expected: Number(addSku.qty), qty_received: lines.find((l) => l.sku?.id === addSku.sku_id)?.qty_received || 0 }, { onConflict: 'inbound_id,sku_id' });
    if (error) return setMsg({ kind: 'err', text: error.message });
    setAddSku({ sku_id: '', qty: '' }); loadLines(current.id);
  };

  /* ---------- level 1: brand ---------- */
  if (!brand) {
    const stats = (o) => { const rs = (inbounds || []).filter((i) => i.org_id === o.id); return [['To receive', rs.filter((i) => ['expected', 'in_transit'].includes(i.status)).length], ['Discrepancies', rs.filter((i) => i.status === 'discrepancy').length, rs.some((i) => i.status === 'discrepancy')], ['Received', rs.filter((i) => i.status === 'received').length]]; };
    return (
      <>
        <div className="pagehead"><div><h1>Receiving<span className="dot">.</span></h1><p className="sub">Pick the brand whose stock is on the dock.</p></div>
          <div className="glance"><div><small>To receive</small><b>{(inbounds || []).filter((i) => ['expected', 'in_transit'].includes(i.status)).length}</b></div></div></div>
        <BrandPicker orgs={orgs} onPick={setBrand} stats={stats} title="Brands" />
      </>
    );
  }

  /* ---------- level 2: the brand's inbounds ---------- */
  return (
    <>
      <BrandBar org={org} onBack={() => { setBrand(null); setSel(null); }}>
        <button className="btn-sm primary" onClick={() => setCreating(true)}>+ New inbound</button>
        <button className="btn-sm" onClick={() => printLocationLabels(locs)}>Print bin labels (3×1)</button>
      </BrandBar>
      <div className="pagehead">
        <div><h1>Receiving<span className="dot">.</span></h1><p className="sub">Pick the inbound, then the SKU you’re counting. Scan one unit at a time; the wrong item is refused.</p></div>
        <div className="glance">
          <div><small>To receive</small><b>{mine.filter((i) => ['expected', 'in_transit'].includes(i.status)).length}</b></div>
          <div><small>Discrepancies</small><b className={mine.some((i) => i.status === 'discrepancy') ? 'hot' : ''}>{mine.filter((i) => i.status === 'discrepancy').length}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="ops receiving">
        <div className="card queue">
          <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
          {inbounds === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">{tab === 'open' ? `Nothing expected for ${org?.name}. Add an inbound when they tell you stock is on the way.` : 'Nothing here.'}</div> : (
            <ul className="queuelist">{list.map((i) => (
              <li key={i.id}><button className={`qitem ${i.id === sel ? 'active' : ''}`} onClick={() => setSel(i.id)}>
                <div className="top"><b>{i.reference || 'Inbound'}</b><span className={`statuspill ${ST[i.status]?.[1]}`}>{ST[i.status]?.[0]}</span></div>
                <div className="meta">{i.expected_at ? `expected ${fmtDate(i.expected_at)}` : 'no date'}{i.cartons ? ` · ${i.cartons} ctn` : ''}{i.pallets ? ` · ${i.pallets} plt` : ''}{i.carrier ? ` · ${i.carrier}` : ''}</div>
              </button></li>
            ))}</ul>
          )}
        </div>

        <div className="card detail">
          {!current ? <div className="empty">Select an inbound on the left, or add a new one.</div> : <>
            <div className="cardhead">
              <div><h3>{current.reference || 'Inbound'} <span className={`statuspill ${ST[current.status]?.[1]}`}>{ST[current.status]?.[0]}</span></h3>
                <div className="small">{current.carrier ? `${current.carrier} · ` : ''}{current.tracking ? `${current.tracking} · ` : ''}{current.expected_at ? `expected ${fmtDate(current.expected_at)}` : ''}{current.received_at ? ` · received ${new Date(current.received_at).toLocaleString()}` : ''}{current.notes ? ` · ${current.notes}` : ''}</div></div>
              <div className="spacer" />
              {!closed && <label className="mult">Put away to <select value={loc} onChange={(e) => setLoc(e.target.value)}>{locs.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></label>}
              {!closed && <button className="btn-sm primary" disabled={busy === 'final' || totals.rec === 0} onClick={finalize} title={allMatched ? 'Everything matches — post it' : 'You can finalize with differences; they get flagged'}>{busy === 'final' ? 'Posting…' : allMatched ? '✓ Finalize receiving' : 'Finalize receiving'}</button>}
            </div>

            {/* step 1: which SKU */}
            {!closed && <>
              <div className="lbl" style={{ padding: '12px 18px 0' }}>1 · What are you counting?</div>
              <div className="skupick">
                {lines.map((l) => <button key={l.id} className={`${skuId === l.sku?.id ? 'on' : ''} ${l.qty_expected && l.qty_received === l.qty_expected ? 'done' : ''}`} onClick={() => setSkuId(l.sku?.id)}><em>{l.qty_received}{l.qty_expected ? ` / ${l.qty_expected}` : ''}</em><b>{l.sku?.sku}</b><small>{l.sku?.name}{l.sku?.variant ? ` — ${l.sku.variant}` : ''}</small></button>)}
                <select className="skupick-other" value={lines.some((l) => l.sku?.id === skuId) ? '' : (skuId || '')} onChange={(e) => e.target.value && setSkuId(e.target.value)} style={{ border: '1.5px dashed var(--line)', borderRadius: 10, padding: '10px 12px', font: 'inherit', background: '#fff', color: 'var(--muted)' }}>
                  <option value="">+ another SKU not on the list…</option>
                  {skus.filter((s) => !lines.some((l) => l.sku?.id === s.id)).map((s) => <option key={s.id} value={s.id}>{s.sku} · {s.name}{s.variant ? ` (${s.variant})` : ''}</option>)}
                </select>
              </div>

              {/* step 2: labels */}
              {curSku && !labels && (
                <div className="labelprompt">
                  <b>2 · {curSku.sku} — do the units have our 3×1 labels?</b>
                  <button className="btn-sm primary" onClick={() => setLabels('have')}>Yes — scan them in</button>
                  <span>or print a batch:</span>
                  <input type="number" min="1" placeholder={String(curLine?.qty_expected || 1)} value={batch} onChange={(e) => setBatch(e.target.value)} />
                  <button className="btn-sm" onClick={printBatch}>Print {batch || curLine?.qty_expected || 1} labels</button>
                  <span className="sm">{curSku.barcode ? `Labels carry the UPC ${curSku.barcode}.` : `No UPC on file — labels carry the SKU code ${curSku.sku}. A unit’s own barcode can be saved on first scan.`}</span>
                </div>
              )}

              {/* step 3: scan */}
              {curSku && labels && <>
                <div className="scanrow">
                  <ScanBox onScan={(c) => scan(c)} placeholder={`Scan each ${curSku.sku} unit…`} />
                  <span className="sm">{labels === 'printed' ? 'Stick the labels on, then scan each one.' : 'One scan = one unit.'}</span>
                  <button className="btn-xs" onClick={() => setLabels(null)}>Print more labels</button>
                </div>
                {last && (
                  <div className={`scanfeed ${last.kind}`}>
                    {last.kind === 'ok' || last.kind === 'warn' ? <><b>{last.name}</b><span>{last.sku}</span><em>{last.rec}{last.exp ? ` / ${last.exp}` : ''}</em>{last.kind === 'warn' && <small>More than expected — check the count</small>}{last.exp && last.rec === last.exp && <small>Done — pick the next SKU</small>}</> : <b>{last.text}</b>}
                  </div>
                )}
                {unknown && (
                  <div className="assign">
                    <span>Save <b>{unknown}</b> as the barcode for <b>{curSku.sku}</b>?</span>
                    <button className="btn-sm primary" disabled={busy === 'assign'} onClick={saveBarcode}>Save &amp; count it</button>
                    <button className="btn-sm" onClick={() => setUnknown(null)}>No, ignore</button>
                  </div>
                )}
              </>}
            </>}

            <div className="progress" style={{ padding: '10px 18px 0' }}><div className="bar"><i style={{ width: `${totals.exp ? Math.min(100, (100 * totals.rec) / totals.exp) : (totals.rec ? 100 : 0)}%` }} /></div><span>{totals.rec} received{totals.exp ? ` of ${totals.exp} expected` : ''}</span></div>
            <table className="lines"><thead><tr><th>SKU</th><th>Item</th><th className="n">Expected</th><th className="n">Received</th><th className="n">Diff</th>{!closed && <th />}</tr></thead>
              <tbody>{lines.map((l) => { const d = (l.qty_received || 0) - (l.qty_expected || 0); return (
                <tr key={l.id} className={d === 0 && l.qty_expected ? 'ok' : d !== 0 && (l.qty_received || l.qty_expected) ? 'diff' : ''}><td>{l.sku?.sku}</td><td>{l.sku?.name}{l.sku?.variant ? ` — ${l.sku.variant}` : ''}</td><td className="n">{l.qty_expected}</td><td className="n"><b>{l.qty_received}</b></td><td className="n">{d > 0 ? `+${d}` : d}</td>
                  {!closed && <td className="n"><button className="btn-xs" onClick={() => adjust(l, -1)}>−</button> <button className="btn-xs" onClick={() => adjust(l, 1)}>+</button></td>}</tr>); })}
              {!lines.length && <tr><td colSpan={6} className="sm" style={{ padding: 14 }}>Nothing expected on this inbound yet — add what the client said is coming below, or pick a SKU above and start counting.</td></tr>}</tbody></table>
            {!closed && (
              <form className="addline" onSubmit={addExpected}>
                <span>Add expected:</span>
                <select value={addSku.sku_id} onChange={(e) => setAddSku({ ...addSku, sku_id: e.target.value })}><option value="">— item —</option>{skus.map((s) => <option key={s.id} value={s.id}>{s.sku} · {s.name}{s.variant ? ` (${s.variant})` : ''}</option>)}</select>
                <input type="number" min="1" placeholder="qty" value={addSku.qty} onChange={(e) => setAddSku({ ...addSku, qty: e.target.value })} />
                <button className="btn-sm" type="submit">Add</button>
              </form>
            )}
          </>}
        </div>
      </div>

      {creating && org && <NewInbound org={org} me={me} onClose={() => setCreating(false)} onCreated={async (id) => { setCreating(false); await load(); setSel(id); setTab('open'); }} onErr={(t) => setMsg({ kind: 'err', text: t })} />}
    </>
  );
}

/* ---------- New inbound: what's coming, how, when — and the expected SKUs + quantities ---------- */
function NewInbound({ org, me, onClose, onCreated, onErr }) {
  const [form, setForm] = useState({ reference: '', carrier: '', tracking: '', expected_at: '', cartons: '', pallets: '', notes: '' });
  const [rows, setRows] = useState([{ sku_id: '', qty: '' }]);
  const [skus, setSkus] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { supabase.from('skus').select('id, sku, name, variant').eq('org_id', org.id).eq('active', true).order('sku').then(({ data }) => setSkus(data || [])); }, [org.id]);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    const row = { org_id: org.id, reference: form.reference || null, carrier: form.carrier || null, tracking: form.tracking || null, expected_at: form.expected_at || null, cartons: form.cartons ? Number(form.cartons) : null, pallets: form.pallets ? Number(form.pallets) : null, notes: form.notes || null, status: 'expected', created_by: me.id };
    const { data, error } = await supabase.from('inbound_shipments').insert(row).select('id').single();
    if (error) { setBusy(false); return onErr(error.message); }
    const exp = rows.filter((r) => r.sku_id && Number(r.qty) > 0).map((r) => ({ inbound_id: data.id, sku_id: r.sku_id, qty_expected: Number(r.qty), qty_received: 0 }));
    if (exp.length) { const { error: e2 } = await supabase.from('inbound_lines').upsert(exp, { onConflict: 'inbound_id,sku_id' }); if (e2) onErr(e2.message); }
    setBusy(false); onCreated(data.id);
  };
  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New inbound — {org.name}<span className="dot">.</span></h3>
        <div className="field"><label>Reference (PO, ASN, or what the client calls it)</label><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="e.g. SH-INBOUND-001" autoFocus /></div>
        <div className="grid2">
          <div className="field"><label>Carrier</label><input value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} placeholder="UPS, freight, client drop-off…" /></div>
          <div className="field"><label>Tracking / PRO #</label><input value={form.tracking} onChange={(e) => setForm({ ...form, tracking: e.target.value })} /></div>
          <div className="field"><label>Expected date</label><input type="date" value={form.expected_at} onChange={(e) => setForm({ ...form, expected_at: e.target.value })} /></div>
          <div className="field"><label>Cartons / pallets</label><div style={{ display: 'flex', gap: 8 }}><input type="number" min="0" placeholder="cartons" value={form.cartons} onChange={(e) => setForm({ ...form, cartons: e.target.value })} /><input type="number" min="0" placeholder="pallets" value={form.pallets} onChange={(e) => setForm({ ...form, pallets: e.target.value })} /></div></div>
        </div>
        <div className="lbl">Expected SKUs &amp; quantities</div>
        <div className="exprows">
          {rows.map((r, i) => (
            <div className="exprow" key={i}>
              <select value={r.sku_id} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, sku_id: e.target.value } : x)))}><option value="">— item —</option>{skus.map((s) => <option key={s.id} value={s.id}>{s.sku} · {s.name}{s.variant ? ` (${s.variant})` : ''}</option>)}</select>
              <input type="number" min="1" placeholder="qty" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <button type="button" className="btn-xs" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>×</button>
            </div>
          ))}
          <div><button type="button" className="btn-xs" onClick={() => setRows([...rows, { sku_id: '', qty: '' }])}>+ Add SKU</button> <span className="sm">Leave empty for a blind receipt — you can still count anything that arrives.</span></div>
        </div>
        <div className="field" style={{ marginTop: 12 }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        <div className="actions"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy}>{busy ? 'Saving…' : 'Create inbound'}</button></div>
      </form>
    </div>
  );
}
