// Locations. The floor by section: which pallet positions exist, which are taken and by what. Admins add positions
// and print their 4x6 labels; the put-away scan reads those labels.
import { useMemo, useState } from 'react';
import { supabase } from './lib';
import { printLocationLabels, CARTON_SIZES } from './label';
import { FloorMap, occupantOf } from './parts.jsx';

export default function Locations({ me, locations, pallets, brandName, reload, open }) {
  const admin = me.role === 'shipbay_admin';
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ zone: '', prefix: '', from: '1', count: '4' });
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null);
  const [psize, setPsizeRaw] = useState(() => { try { return localStorage.getItem('wms-pos-size') || '4x6'; } catch { return '4x6'; } });   // which roll the position labels print on, per station
  const setPsize = (v) => { setPsizeRaw(v); try { localStorage.setItem('wms-pos-size', v); } catch { /* storage off */ } };
  const isSpot = (l) => l.kind === 'pallet' || l.kind === 'floor' || (l.zone || '').toLowerCase() === 'open box';
  const spots = useMemo(() => (locations || []).filter((l) => l.active !== false && l.kind === 'pallet'), [locations]);
  const zones = useMemo(() => [...new Set((locations || []).filter(isSpot).map((l) => l.zone).filter(Boolean))].sort(), [locations]);
  const taken = spots.filter((l) => occupantOf(pallets, l.id)).length;
  const codes = useMemo(() => { const n = Math.max(0, Math.min(200, Number(f.count) || 0)); const a = Math.max(0, Number(f.from) || 0); const p = f.prefix.trim().toUpperCase(); return p ? Array.from({ length: n }, (_, i) => `${p}-${String(a + i).padStart(2, '0')}`) : []; }, [f]);
  const clash = codes.filter((c) => (locations || []).some((l) => l.code.toUpperCase() === c));

  const add = async (e) => {
    e.preventDefault(); if (!codes.length || clash.length || !f.zone.trim()) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase.from('locations').insert(codes.map((code) => ({ code, zone: f.zone.trim(), kind: 'pallet', active: true })));
    setBusy(false); if (error) return setMsg({ kind: 'bad', text: error.message });
    setMsg({ kind: 'ok', text: `${codes.length} positions added to ${f.zone.trim()}: ${codes[0]} to ${codes[codes.length - 1]}.` }); setAdding(false); setF({ zone: '', prefix: '', from: '1', count: '4' }); reload();
  };

  return (
    <>
      <header className="pagehead">
        <h1>Locations<span className="dot">.</span></h1>
        <div className="glance">
          <div><b>{spots.length}</b><small>Pallet positions</small></div>
          <div><b>{taken}</b><small>Taken</small></div>
          <div><b className={spots.length - taken === 0 && spots.length ? 'hot' : ''}>{spots.length - taken}</b><small>Free</small></div>
        </div>
      </header>
      {msg && <div className={`strip ${msg.kind}`}><span>{msg.text}</span><button className="x" onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}

      <div className="toolbar">
        <label className="inlinepick">Position labels on<select className="sizepick" value={psize} onChange={(e) => setPsize(e.target.value)}><option value="4x6">4 × 6 in</option>{CARTON_SIZES.filter(([k]) => k !== '4x6').map(([k, l]) => <option key={k} value={k}>{l} in</option>)}</select></label>
        {zones.map((z) => { const ls = (locations || []).filter((l) => l.zone === z && isSpot(l) && l.active !== false).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })); return <button key={z} className="btn cap" onClick={() => printLocationLabels(ls, psize)}>Print {ls.length} {z} label{ls.length === 1 ? '' : 's'}</button>; })}
        <span style={{ flex: 1 }} />
        {admin && !adding && <button className="btn go" onClick={() => setAdding(true)}>+ Add positions</button>}
      </div>

      {adding && (
        <form className="panel pad addloc" onSubmit={add}>
          <div className="fields four">
            <label>Section<input value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })} placeholder="Lane 1" list="zones" required autoFocus maxLength={30} /><datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist></label>
            <label>Code starts with<input value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 6) })} placeholder="L1" required /></label>
            <label>First number<input type="number" min="0" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
            <label>How many<input type="number" min="1" max="200" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} /></label>
          </div>
          <div className="hold">{clash.length ? `${clash.slice(0, 4).join(', ')} already exist${clash.length === 1 ? 's' : ''}.` : codes.length ? `Makes ${codes[0]}${codes.length > 1 ? ` to ${codes[codes.length - 1]}` : ''}.` : 'Each position gets a code like L1-01.'}</div>
          <div className="rowbtns"><button className="btn go" disabled={busy || !codes.length || clash.length > 0 || !f.zone.trim()}>{busy ? 'Adding…' : `Add ${codes.length || ''} positions`}</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button></div>
        </form>
      )}

      <section className="panel pad">
        <FloorMap locations={locations} pallets={pallets} brandName={brandName} onOpen={(p) => open(p.psku)} />
      </section>
    </>
  );
}
