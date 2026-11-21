// Floor map, drawn from the warehouse sketch: Exit and Dock at the top, entrance at the bottom. Outbound side (two lines) on the
// left, walkway, inbound side under the dock (the original line plus the line along the wall), two staging spots by the prep area.
// Which position code sits in which square is an assumption until confirmed on the floor: change LAYOUT only.
import { useEffect, useState } from 'react';
import { supabase, stamp } from './lib.js';
const ROWS = 18; const P = (n) => `P-${String(n).padStart(2, '0')}`;
const col = (from) => Array.from({ length: ROWS }, (_, i) => P(from + i));
export const LAYOUT = { outbound: [col(37), col(55)], inbound: [col(1), col(19)], staging: ['STG-01', 'STG-02'] };
const HUES = [355, 205, 145, 40, 275, 175, 20, 310];

export default function FloorMap({ compact }) {
  const [m, setM] = useState(null); const [err, setErr] = useState(null); const [sel, setSel] = useState(null);
  const load = () => supabase.rpc('nexus_map').then(({ data, error }) => { if (error) setErr(error.message); else { setErr(null); setM(data); } });
  useEffect(() => { load(); const t = setInterval(load, 10000); const vis = () => { if (!document.hidden) load(); }; document.addEventListener('visibilitychange', vis); return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); }; }, []);
  if (err && !m) return <div className="strip bad">Nexus could not be read ({err}).</div>;
  if (!m) return <div className="empty">Loading…</div>;
  const by = Object.fromEntries(m.positions.map((p) => [p.code, p]));
  const brands = [...new Set(m.positions.flatMap((p) => p.pallets.map((x) => x.brand)))].sort();
  const hue = (b) => HUES[brands.indexOf(b) % HUES.length];
  const Cell = ({ code }) => {
    const p = by[code]; const top = p?.pallets[0];
    return (
      <button className={`cell${!p ? ' none' : ''}${top ? ' full' : ''}${top?.held ? ' held' : ''}${sel === code ? ' on' : ''}`} data-testid={`cell-${code}`} disabled={!p}
        style={top ? { '--h': hue(top.brand) } : undefined} onClick={() => setSel(sel === code ? null : code)} title={!p ? `${code}: not set up` : top ? `${code} · ${top.brand} · ${top.psku}` : `${code}: empty`}>
        <b>{code.replace('P-', '')}</b>{p?.pallets.length > 1 && <i>{p.pallets.length}</i>}
      </button>);
  };
  const Block = ({ cols }) => <div className="block">{cols.map((c, i) => <div className="line" key={i}>{c.map((code) => <Cell key={code} code={code} />)}</div>)}</div>;
  const s = sel && by[sel];
  const used = m.positions.filter((p) => p.kind === 'pallet' && p.pallets.length).length; const total = m.positions.filter((p) => p.kind === 'pallet').length;
  return (
    <div className={`floor${compact ? ' compact' : ''}`} data-testid="floor-map">
      <div className="plan">
        <div className="side"><div className="door">Exit</div><small>Outbound</small><Block cols={LAYOUT.outbound} /></div>
        <div className="walk"><span>Walkway</span></div>
        <div className="side"><div className="door">Dock</div><small>Inbound · wall line on the right</small><Block cols={LAYOUT.inbound} />
          <div className="stage"><small>Staging</small><div className="line row">{LAYOUT.staging.map((c) => <Cell key={c} code={c} />)}</div></div></div>
        <div className="foot"><span>Prep area</span><div className="door">Entrance</div></div>
      </div>
      <aside>
        <h2>Live · {stamp(m.as_of)}</h2>
        <p className="big"><b>{used}</b> of {total} pallet positions in use</p>
        <div className="legend">{brands.map((b) => <span key={b}><i style={{ '--h': hue(b) }} />{b}</span>)}<span><i className="e" />Empty</span><span><i className="x" />Not set up</span></div>
        {s && <section data-testid="cell-detail"><h2>Position {s.code}</h2>{s.pallets.length === 0 ? <p className="sm">Empty.</p> : s.pallets.map((x) => (
          <div className="pal" key={x.psku}><b className="code">{x.psku}</b> · {x.brand}{x.held ? ' · ON HOLD' : ''}<div className="sm">{x.item || '—'} · {x.cartons ?? '—'} cartons · {x.units ?? '—'} units</div>
            <div className="sm">Received {stamp(x.received_at)} · {x.age_days}d · labels printed {x.label_prints}×</div></div>))}</section>}
        {m.unplaced.length > 0 && <section data-testid="unplaced"><h2>Received, no position yet · {m.unplaced.length}</h2>{m.unplaced.slice(0, 12).map((x) => (
          <div className="pal" key={x.psku}><b className="code">{x.psku}</b> · {x.brand}{x.held ? ' · ON HOLD' : ''}<div className="sm">{x.item || '—'} · {stamp(x.received_at)} · labels printed {x.label_prints}×</div></div>))}</section>}
      </aside>
    </div>);
}
