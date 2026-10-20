// Receiving — inbound shipments checked in with the barcode scanner. Scan each unit (or set a multiplier for cases),
// the count builds against what was expected, then Finalize posts inventory and flags any discrepancy.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib';
import { ScanBox, beep, printSkuLabels, printLocationLabels, fmtDate } from '../ops';

const ST = { expected: ['Expected', 'muted'], in_transit: ['Receiving', 'navy'], received: ['Received', 'ok'], discrepancy: ['Discrepancy', 'warn'], cancelled: ['Cancelled', 'bad'] };
const TABS = [['open', 'To receive'], ['done', 'Received'], ['all', 'All']];

export default function Receiving({ me }) {
  const [inbounds, setInbounds] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [locs, setLocs] = useState([]);
  const [tab, setTab] = useState('open');
  const [sel, setSel] = useState(null);
  const [lines, setLines] = useState([]);
  const [skus, setSkus] = useState([]);
  const [mult, setMult] = useState(1);
  const [loc, setLoc] = useState('');
  const [last, setLast] = useState(null);      // last scan result for the big feedback panel
  const [unknown, setUnknown] = useState(null); // unknown code → assign to a SKU
  const [assignTo, setAssignTo] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ org_id: '', reference: '', carrier: '', tracking: '', expected_at: '', cartons: '', pallets: '', notes: '' });
  const [addSku, setAddSku] = useState({ sku_id: '', qty: '' });
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const [{ data: i }, { data: o }, { data: l }] = await Promise.all([
      supabase.from('inbound_shipments').select('*, org:orgs(name)').order('expected_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(300),
      supabase.from('orgs').select('id, name').order('name'),
      supabase.from('locations').select('*').order('code'),
    ]);
    setInbounds(i || []); setOrgs(o || []); setLocs(l || []);
    if (!loc && l?.length) setLoc(l.find((x) => x.code === 'RCV-DOCK')?.id || l[0].id);
  };
  const loadLines = async (id) => {
    const { data } = await supabase.from('inbound_lines').select('*, sku:skus(id, sku, name, variant, barcode)').eq('inbound_id', id).order('created_at');
    setLines(data || []);
  };
  useEffect(() => { load(); }, []);
  const current = (inbounds || []).find((i) => i.id === sel) || null;
  useEffect(() => {
    setLast(null); setUnknown(null);
    if (!current) { setLines([]); setSkus([]); return; }
    loadLines(current.id);
    supabase.from('skus').select('id, sku, name, variant, barcode').eq('org_id', current.org_id).order('sku').then(({ data }) => setSkus(data || []));
  }, [current?.id]);

  const list = useMemo(() => (inbounds || []).filter((i) => tab === 'all' || (tab === 'open' ? ['expected', 'in_transit', 'discrepancy'].includes(i.status) : ['received'].includes(i.status))), [inbounds, tab]);
  const totals = useMemo(() => ({ exp: lines.reduce((s, l) => s + (l.qty_expected || 0), 0), rec: lines.reduce((s, l) => s + (l.qty_received || 0), 0) }), [lines]);
  const closed = current && ['received', 'cancelled'].includes(current.status);

  const scan = async (code, qty = mult) => {
    if (!current || closed) return;
    if (/^LOC-/i.test(code)) { const l = locs.find((x) => x.code.toLowerCase() === code.slice(4).toLowerCase()); if (l) { setLoc(l.id); beep('ok'); setLast({ kind: 'loc', text: `Put-away location set to ${l.code}` }); } else beep('bad'); return; }
    const { data, error } = await supabase.rpc('scan_receive', { p_inbound_id: current.id, p_code: code, p_qty: qty });
    if (error) { beep('bad'); return setLast({ kind: 'bad', text: error.message }); }
    if (!data.found) { beep('bad'); setUnknown(code); setAssignTo(''); return setLast({ kind: 'bad', text: `Unknown barcode ${code} — pick the item it belongs to below and it’ll be remembered.` }); }
    beep(data.qty_expected && data.qty_received >= data.qty_expected ? 'done' : 'ok');
    setUnknown(null);
    setLast({ kind: data.qty_expected && data.qty_received > data.qty_expected ? 'warn' : 'ok', sku: data.sku, name: data.name + (data.variant ? ` — ${data.variant}` : ''), rec: data.qty_received, exp: data.qty_expected, qty });
    await loadLines(current.id);
    if (current.status === 'expected') load();
  };
  const assignBarcode = async () => {
    if (!unknown || !assignTo) return;
    setBusy('assign');
    const { error } = await supabase.from('skus').update({ barcode: unknown }).eq('id', assignTo);
    setBusy(null);
    if (error) return setMsg({ kind: 'err', text: error.message });
    const s = skus.find((x) => x.id === assignTo); if (s) s.barcode = unknown;
    const code = unknown; setUnknown(null);
    await scan(code);
  };
  const adjust = async (l, d) => { await scan(l.sku?.barcode || l.sku?.sku, d); };
  const finalize = async () => {
    if (!current) return;
    const short = lines.filter((l) => l.qty_received !== l.qty_expected);
    if (!window.confirm(`Finalize ${current.reference || 'this inbound'}: ${totals.rec} units received${short.length ? ` — ${short.length} line${short.length > 1 ? 's' : ''} differ from what was expected` : ''}. Inventory will be posted to ${locs.find((x) => x.id === loc)?.code || 'RCV-DOCK'}.`)) return;
    setBusy('final');
    const { data, error } = await supabase.rpc('finalize_inbound', { p_inbound_id: current.id, p_location_id: loc || null });
    setBusy(null);
    if (error) return setMsg({ kind: 'err', text: error.message });
    beep('done');
    setMsg({ kind: data.discrepancy ? 'err' : 'ok', text: data.discrepancy ? `Received ${data.units} units with discrepancies — flagged for the client.` : `Received ${data.units} units. Inventory is live.` });
    await load(); await loadLines(current.id);
  };
  const create = async (e) => {
    e.preventDefault(); setBusy('create');
    const row = { org_id: form.org_id, reference: form.reference || null, carrier: form.carrier || null, tracking: form.tracking || null, expected_at: form.expected_at || null, cartons: form.cartons ? Number(form.cartons) : null, pallets: form.pallets ? Number(form.pallets) : null, notes: form.notes || null, status: 'expected', created_by: me.id };
    const { data, error } = await supabase.from('inbound_shipments').insert(row).select('id').single();
    setBusy(null);
    if (error) return setMsg({ kind: 'err', text: error.message });
    setCreating(false); setForm({ org_id: '', reference: '', carrier: '', tracking: '', expected_at: '', cartons: '', pallets: '', notes: '' });
    await load(); setSel(data.id); setTab('open');
  };
  const addExpected = async (e) => {
    e.preventDefault(); if (!addSku.sku_id || !addSku.qty) return;
    const { error } = await supabase.from('inbound_lines').upsert({ inbound_id: current.id, sku_id: addSku.sku_id, qty_expected: Number(addSku.qty), qty_received: 0 }, { onConflict: 'inbound_id,sku_id', ignoreDuplicates: false });
    if (error) return setMsg({ kind: 'err', text: error.message });
    setAddSku({ sku_id: '', qty: '' }); loadLines(current.id);
  };

  return (
    <>
      <div className="pagehead">
        <div><h1>Receiving<span className="dot">.</span></h1><p className="sub">Check in inbound stock with the scanner. Every scan counts one unit (set a multiplier for sealed cases); Finalize posts the counts to inventory.</p></div>
        <div className="glance">
          <div><small>To receive</small><b>{(inbounds || []).filter((i) => ['expected', 'in_transit'].includes(i.status)).length}</b></div>
          <div><small>Discrepancies</small><b className={(inbounds || []).some((i) => i.status === 'discrepancy') ? 'hot' : ''}>{(inbounds || []).filter((i) => i.status === 'discrepancy').length}</b></div>
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="opsbar">
        <button className="btn-sm primary" onClick={() => setCreating(true)}>+ New inbound</button>
        <button className="btn-sm" onClick={() => printLocationLabels(locs)}>Print bin labels (3×1)</button>
        <div className="spacer" />
        <div className="sm">Scanner tip: scan a bin label (LOC-…) at any time to set the put-away location.</div>
      </div>

      <div className="ops receiving">
        <div className="card queue">
          <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
          {inbounds === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">{tab === 'open' ? 'Nothing expected. Add an inbound when a client tells you stock is on the way.' : 'Nothing here.'}</div> : (
            <ul className="queuelist">{list.map((i) => (
              <li key={i.id}><button className={`qitem ${i.id === sel ? 'active' : ''}`} onClick={() => setSel(i.id)}>
                <div className="top"><b>{i.reference || 'Inbound'}</b><span className={`statuspill ${ST[i.status]?.[1]}`}>{ST[i.status]?.[0]}</span></div>
                <div className="meta">{i.org?.name}{i.expected_at ? ` · expected ${fmtDate(i.expected_at)}` : ''}{i.cartons ? ` · ${i.cartons} ctn` : ''}{i.pallets ? ` · ${i.pallets} plt` : ''}{i.carrier ? ` · ${i.carrier}` : ''}</div>
              </button></li>
            ))}</ul>
          )}
        </div>

        <div className="card detail">
          {!current ? <div className="empty">Select an inbound, or add a new one.</div> : <>
            <div className="cardhead">
              <div><h3>{current.reference || 'Inbound'} <span className={`statuspill ${ST[current.status]?.[1]}`}>{ST[current.status]?.[0]}</span></h3>
                <div className="small">{current.org?.name}{current.carrier ? ` · ${current.carrier}` : ''}{current.tracking ? ` · ${current.tracking}` : ''}{current.expected_at ? ` · expected ${fmtDate(current.expected_at)}` : ''}{current.received_at ? ` · received ${new Date(current.received_at).toLocaleString()}` : ''}</div></div>
              <div className="spacer" />
              <button className="btn-sm" disabled={!lines.length} onClick={() => printSkuLabels(lines.map((l) => l.sku).filter(Boolean), 1)}>Print item labels (3×1)</button>
              {!closed && <button className="btn-sm primary" disabled={busy === 'final' || totals.rec === 0} onClick={finalize}>{busy === 'final' ? 'Posting…' : 'Finalize receiving'}</button>}
            </div>

            {!closed && <>
              <div className="scanrow">
                <ScanBox onScan={(c) => scan(c)} placeholder="Scan item barcode (or type the SKU) and press Enter" />
                <label className="mult">× <input type="number" min="1" value={mult} onChange={(e) => setMult(Math.max(1, Number(e.target.value) || 1))} /> per scan</label>
                <label className="mult">Put away to <select value={loc} onChange={(e) => setLoc(e.target.value)}>{locs.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></label>
              </div>
              {last && (
                <div className={`scanfeed ${last.kind}`}>
                  {last.kind === 'ok' || last.kind === 'warn' ? <><b>{last.name}</b><span>{last.sku}</span><em>{last.rec}{last.exp ? ` / ${last.exp}` : ''}</em>{last.kind === 'warn' && <small>More than expected — check the count</small>}</> : <b>{last.text}</b>}
                </div>
              )}
              {unknown && (
                <div className="assign">
                  <span>Assign barcode <b>{unknown}</b> to:</span>
                  <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}><option value="">— pick the item —</option>{skus.map((s) => <option key={s.id} value={s.id}>{s.sku} · {s.name}{s.variant ? ` (${s.variant})` : ''}</option>)}</select>
                  <button className="btn-sm primary" disabled={!assignTo || busy === 'assign'} onClick={assignBarcode}>Save &amp; count it</button>
                  <button className="btn-sm" onClick={() => setUnknown(null)}>Ignore</button>
                </div>
              )}
            </>}

            <div className="progress"><div className="bar"><i style={{ width: `${totals.exp ? Math.min(100, (100 * totals.rec) / totals.exp) : (totals.rec ? 100 : 0)}%` }} /></div><span>{totals.rec} received{totals.exp ? ` of ${totals.exp} expected` : ''}</span></div>
            <table className="lines"><thead><tr><th>SKU</th><th>Item</th><th className="n">Expected</th><th className="n">Received</th><th className="n">Diff</th>{!closed && <th />}</tr></thead>
              <tbody>{lines.map((l) => { const d = (l.qty_received || 0) - (l.qty_expected || 0); return (
                <tr key={l.id} className={d === 0 && l.qty_expected ? 'ok' : d !== 0 && (l.qty_received || l.qty_expected) ? 'diff' : ''}><td>{l.sku?.sku}</td><td>{l.sku?.name}{l.sku?.variant ? ` — ${l.sku.variant}` : ''}</td><td className="n">{l.qty_expected}</td><td className="n"><b>{l.qty_received}</b></td><td className="n">{d > 0 ? `+${d}` : d}</td>
                  {!closed && <td className="n"><button className="btn-xs" onClick={() => adjust(l, -1)}>−</button> <button className="btn-xs" onClick={() => adjust(l, 1)}>+</button></td>}</tr>); })}
              {!lines.length && <tr><td colSpan={6} className="sm" style={{ padding: 14 }}>No lines yet — scan the first unit, or add what the client said is coming below.</td></tr>}</tbody></table>
            {!closed && (
              <form className="addline" onSubmit={addExpected}>
                <span>Expected:</span>
                <select value={addSku.sku_id} onChange={(e) => setAddSku({ ...addSku, sku_id: e.target.value })}><option value="">— item —</option>{skus.map((s) => <option key={s.id} value={s.id}>{s.sku} · {s.name}{s.variant ? ` (${s.variant})` : ''}</option>)}</select>
                <input type="number" min="1" placeholder="qty" value={addSku.qty} onChange={(e) => setAddSku({ ...addSku, qty: e.target.value })} />
                <button className="btn-sm" type="submit">Add</button>
              </form>
            )}
          </>}
        </div>
      </div>

      {creating && (
        <div className="overlay" onClick={() => setCreating(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={create}>
            <h3>New inbound<span className="dot">.</span></h3>
            <div className="field"><label>Client</label><select required value={form.org_id} onChange={(e) => setForm({ ...form, org_id: e.target.value })}><option value="">— choose —</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
            <div className="field"><label>Reference (PO, ASN, or what the client calls it)</label><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="e.g. SH-INBOUND-001" /></div>
            <div className="grid2">
              <div className="field"><label>Carrier</label><input value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} placeholder="UPS, freight, client drop-off…" /></div>
              <div className="field"><label>Tracking / PRO #</label><input value={form.tracking} onChange={(e) => setForm({ ...form, tracking: e.target.value })} /></div>
              <div className="field"><label>Expected date</label><input type="date" value={form.expected_at} onChange={(e) => setForm({ ...form, expected_at: e.target.value })} /></div>
              <div className="field"><label>Cartons / pallets</label><div style={{ display: 'flex', gap: 8 }}><input type="number" min="0" placeholder="cartons" value={form.cartons} onChange={(e) => setForm({ ...form, cartons: e.target.value })} /><input type="number" min="0" placeholder="pallets" value={form.pallets} onChange={(e) => setForm({ ...form, pallets: e.target.value })} /></div></div>
            </div>
            <div className="field"><label>Notes</label><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <div className="actions"><button type="button" className="btn-sm" onClick={() => setCreating(false)}>Cancel</button><button className="btn-sm primary" disabled={busy === 'create'}>{busy === 'create' ? 'Saving…' : 'Create inbound'}</button></div>
          </form>
        </div>
      )}
    </>
  );
}
