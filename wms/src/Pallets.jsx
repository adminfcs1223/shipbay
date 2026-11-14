// Pallet register. Scan a pallet label (or type its number) to pull the pallet up; filter by brand and by when it came in.
// A pallet entered by mistake is voided with a reason; it is never deleted and its PSKU# is never reused.
import { useEffect, useMemo, useState } from 'react';
import { supabase, fmtStamp, sameDay } from './lib';
import { printPalletLabels } from './label';
import { LabelPreview, ScanBox, beep, normPsku } from './parts.jsx';

const WHEN = [['today', 'Today'], ['week', '7 days'], ['all', 'All']];

export default function Pallets({ orgs, pallets, brandName, merge, find, setFind }) {
  const [q, setQ] = useState(find || '');
  const [org, setOrg] = useState('');
  const [when, setWhen] = useState(find ? 'all' : 'week');
  const [sel, setSel] = useState(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => { if (find) { setQ(find); setWhen('all'); const p = (pallets || []).find((x) => x.psku === find); if (p) setSel(p.id); setFind(''); } }, [find]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase(); const want = normPsku(q).toLowerCase(); const weekAgo = Date.now() - 7 * 864e5;
    return (pallets || []).filter((p) => {
      if (org && p.org_id !== org) return false;
      if (when === 'today' && !sameDay(p.received_at)) return false;
      if (when === 'week' && new Date(p.received_at).getTime() < weekAgo) return false;
      if (!t) return true;
      return p.psku.toLowerCase() === want || p.psku.toLowerCase().includes(t) || (p.reference || '').toLowerCase().includes(t) || (p.carrier || '').toLowerCase().includes(t) || brandName(p.org_id).toLowerCase().includes(t);
    });
  }, [pallets, q, org, when, orgs]);
  const cur = (pallets || []).find((p) => p.id === sel) || null;
  const live = (pallets || []).filter((p) => p.status !== 'void');

  const scan = (code) => {
    const want = normPsku(code); const p = (pallets || []).find((x) => x.psku === want);
    if (p) { beep('ok'); setWhen('all'); setOrg(''); setQ(want); setSel(p.id); setMsg(null); }
    else { beep('bad'); setQ(code); setWhen('all'); setSel(null); setMsg(`${want} is not on file.`); }
  };
  const print = async (p) => {
    await printPalletLabels([p], (x) => brandName(x.org_id));
    const { error } = await supabase.rpc('wms_mark_printed', { p_ids: [p.id] });
    if (!error) merge([{ ...p, label_prints: (p.label_prints || 0) + 1, last_printed_at: new Date().toISOString() }]);
  };
  const doVoid = async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.rpc('wms_void_pallet', { p_id: cur.id, p_reason: reason });
    if (error) { beep('bad'); return setMsg(error.message); }
    merge([data]); setVoiding(false); setReason(''); setMsg(null);
  };
  useEffect(() => { setVoiding(false); setReason(''); }, [sel]);

  return (
    <>
      <header className="pagehead">
        <h1>Pallets<span className="dot">.</span></h1>
        <div className="glance">
          <div><b>{live.length}</b><small>On file</small></div>
          <div><b>{live.filter((p) => sameDay(p.received_at)).length}</b><small>Received today</small></div>
          <div><b>{new Set(live.map((p) => p.org_id)).size}</b><small>Brands</small></div>
        </div>
      </header>

      <div className="toolbar">
        <ScanBox value={q} onChange={(v) => { setQ(v); setMsg(null); }} onScan={scan} placeholder="Scan a pallet label, or type a PSKU#, reference or brand" autoFocus />
        <select value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Brand"><option value="">All brands</option>{(orgs || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <div className="seg">{WHEN.map(([k, l]) => <button key={k} className={when === k ? 'on' : ''} onClick={() => setWhen(k)}>{l}</button>)}</div>
      </div>
      {msg && <div className="strip bad"><span>{msg}</span><button className="x" onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className={`register ${cur ? 'open' : ''}`}>
        <section className="panel">
          {pallets === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">{(pallets || []).length === 0 ? 'No pallets received yet.' : 'No pallets match.'}</div> : (
            <table className="grid pick">
              <thead><tr><th>PSKU#</th><th>Brand</th><th>Pallet</th><th>Reference</th><th className="n">Cartons</th><th>Received</th><th>By</th><th>Status</th></tr></thead>
              <tbody>{list.map((p) => (
                <tr key={p.id} className={`${p.id === sel ? 'on' : ''} ${p.status === 'void' ? 'void' : ''}`} onClick={() => setSel(p.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(p.id)}>
                  <td className="code">{p.psku}</td><td><b>{brandName(p.org_id)}</b></td>
                  <td className="num">{p.batch_pos} of {p.batch_size}</td><td>{p.reference || '—'}</td>
                  <td className="n num">{p.cartons ?? '—'}</td><td className="num">{fmtStamp(p.received_at)}</td><td>{p.received_by_name || '—'}</td>
                  <td>{p.status === 'void' ? <span className="tag bad">Void</span> : <span className="tag ok">Received</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>

        {cur && (
          <aside className="panel detail">
            <div className="panelhead"><h3 className="code">{cur.psku}</h3><button className="x" onClick={() => setSel(null)} aria-label="Close">×</button></div>
            <LabelPreview pallet={cur} brand={brandName(cur.org_id)} inch={52} />
            <dl>
              <div><dt>Brand</dt><dd>{brandName(cur.org_id)}</dd></div>
              <div><dt>Status</dt><dd>{cur.status === 'void' ? `Void · ${cur.void_reason}` : 'Received'}</dd></div>
              <div><dt>Received</dt><dd>{fmtStamp(cur.received_at)}{cur.received_by_name ? ` · ${cur.received_by_name}` : ''}</dd></div>
              <div><dt>Label printed</dt><dd>{cur.label_prints ? `${cur.label_prints}×, last ${fmtStamp(cur.last_printed_at)}` : 'Not yet'}</dd></div>
            </dl>
            {cur.status !== 'void' && !voiding && <div className="acts"><button className="btn go" onClick={() => print(cur)}>Reprint label</button><button className="btn" onClick={() => setVoiding(true)}>Void pallet</button></div>}
            {voiding && (
              <form className="voidform" onSubmit={doVoid}>
                <label>Why is {cur.psku} being voided?<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered twice, wrong brand…" autoFocus required maxLength={140} /></label>
                <div className="acts"><button className="btn danger" disabled={!reason.trim()}>Void {cur.psku}</button><button type="button" className="btn" onClick={() => setVoiding(false)}>Keep it</button></div>
              </form>
            )}
          </aside>
        )}
      </div>
    </>
  );
}
