// Pieces both WMS screens share: the on-screen 4x6 label (same markup that prints), the scanner box and the beeps.
import { useEffect, useRef, useState } from 'react';
import { labelHtml, cartonLabelHtml, cartonPageHtml, CARTON_SIZES, CARTON_TURNS, parseSize, sizeLabel, getCartonSize, setCartonSize, getCartonTurn, setCartonTurn } from './label';

/** The label at screen size. `inch` = how many CSS pixels one label inch gets. */
export function LabelPreview({ pallet, brand, inch = 62, ghost }) {
  return <div className={`labelview ${ghost ? 'ghost' : ''}`} style={{ '--u': `${inch}px`, width: inch * 4, height: inch * 6 }} dangerouslySetInnerHTML={{ __html: labelHtml(pallet, brand) }} />;
}

/** A carton label at screen size. With `turn` it is drawn as the page that goes to the printer (the roll feeds downward). */
export function CartonPreview({ pallet, brand, carton, size, turn, width = 246 }) {
  const z = parseSize(size); const side = turn === 'left' || turn === 'right';
  const inch = turn == null ? width / z.w : Math.min(width / (side ? z.h : z.w), 150 / (side ? z.w : z.h), 130);
  const html = turn == null ? cartonLabelHtml(pallet, brand, carton, z.key) : cartonPageHtml(pallet, brand, carton, z.key, turn);
  return <div className="labelview carton" style={{ '--u': `${inch}px`, width: inch * (side ? z.h : z.w), height: inch * (side ? z.w : z.h) }} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Which carton-label roll this station has. Remembered per station (browser). */
export function useCartonSize() {
  const [size, set] = useState(getCartonSize);
  const [turn, setT] = useState(getCartonTurn);
  return [size, (v) => { setCartonSize(v); set(parseSize(v).key); }, turn, (v) => { setCartonTurn(v); setT(v); }];
}
export function CartonTurnPicker({ turn, onChange }) {
  return <select className="sizepick" value={turn} onChange={(e) => onChange(e.target.value)} aria-label="Carton label direction">{CARTON_TURNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
}
export function CartonSizePicker({ size, onChange }) {
  const known = CARTON_SIZES.some(([k]) => k === size);
  return (
    <select className="sizepick" value={size} onChange={(e) => onChange(e.target.value)} aria-label="Carton label size">
      {CARTON_SIZES.map(([k, l]) => <option key={k} value={k}>{l} in</option>)}
      {!known && <option value={size}>{sizeLabel(size)} in</option>}
    </select>
  );
}

export const STATUS = { open: ['Scan cartons', 'warn'], counted: ['Put away', 'go'], stored: ['Received', 'ok'], received: ['Received', 'ok'], void: ['Void', 'bad'] };
export const StatusTag = ({ s }) => <span className={`tag ${STATUS[s]?.[1] || ''}`}>{STATUS[s]?.[0] || s}</span>;
/** A position is taken by a pallet that is counted or stored there. */
export const occupantOf = (pallets, locId) => (pallets || []).find((p) => p.location_id === locId && (p.status === 'counted' || p.status === 'stored')) || null;

/** The floor by section: every pallet position as a cell. `target` is where the open pallet goes; a free cell can be picked. */
export function FloorMap({ locations, pallets, brandName, target, onPick, onOpen }) {
  const spots = (locations || []).filter((l) => l.active !== false && (l.kind === 'pallet' || l.kind === 'floor'));
  const zones = [...new Set(spots.map((l) => l.zone || 'Other'))].sort((a, b) => (a === (spots.find((l) => l.id === target)?.zone || '') ? -1 : b === (spots.find((l) => l.id === target)?.zone || '') ? 1 : a.localeCompare(b)));
  if (!spots.length) return <div className="empty">No pallet positions set up yet.</div>;
  return (
    <div className="floormap">{zones.map((z) => (
      <div className="zone" key={z}>
        <div className="zhead"><b>{z}</b>{spots.some((l) => (l.zone || 'Other') === z && l.kind === 'pallet') && <span>{spots.filter((l) => (l.zone || 'Other') === z && l.kind === 'pallet' && !occupantOf(pallets, l.id)).length} free</span>}</div>
        <div className="cells">{spots.filter((l) => (l.zone || 'Other') === z).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).map((l) => {
          const occ = l.kind === 'pallet' ? occupantOf(pallets, l.id) : null; const here = l.id === target;
          const many = l.kind === 'floor' ? (pallets || []).filter((p) => p.location_id === l.id && (p.status === 'counted' || p.status === 'stored')).length : 0;
          const can = !here && ((!occ && onPick) || (occ && onOpen));
          return (
            <button type="button" key={l.id} disabled={!can} className={`cell ${here ? 'here' : occ ? 'full' : ''} ${l.kind}`} onClick={() => (occ ? onOpen?.(occ) : onPick?.(l))} title={occ ? `${occ.psku} · ${brandName(occ.org_id)}` : here ? 'This pallet goes here' : 'Free'}>
              <b>{l.code}</b>
              <small>{here ? 'Goes here' : occ ? <>{occ.psku.replace('PSKU-', '')}<br />{brandName(occ.org_id)}</> : l.kind === 'floor' ? (many ? `${many} pallet${many > 1 ? 's' : ''}` : 'Floor area') : 'Free'}</small>
            </button>
          );
        })}</div>
      </div>
    ))}</div>
  );
}

let ctx;
export function beep(kind = 'ok') {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const tone = (f, t0, d) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.frequency.value = f; o.type = 'square'; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + t0); o.stop(ctx.currentTime + t0 + d); };
    if (kind === 'ok') { tone(1100, 0, 0.09); tone(1600, 0.1, 0.14); } else { tone(220, 0, 0.18); tone(220, 0.22, 0.18); }
  } catch { /* no audio */ }
}

/** Keyboard-wedge scanners type the code and press Enter. Typing a number alone ("123") finds PSKU-000123. */
export function ScanBox({ onScan, placeholder, value, onChange, autoFocus }) {
  const ref = useRef(null);
  const [own, setOwn] = useState('');
  const v = value ?? own; const set = onChange ?? setOwn;
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <form className="scanbox" onSubmit={(e) => { e.preventDefault(); const c = v.trim(); if (c) onScan(c); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 8v8M11 8v8M14 8v8M17 8v8" /></svg>
      <input ref={ref} value={v} onChange={(e) => set(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      {v && <button type="button" className="x" onClick={() => { set(''); ref.current?.focus(); }} aria-label="Clear">×</button>}
    </form>
  );
}

/** "123", "psku 123", "PSKU-000123" → "PSKU-000123"; anything else comes back trimmed and upper-cased. */
export function normPsku(s) {
  const t = String(s || '').trim().toUpperCase();
  const m = t.match(/^(?:PSKU[\s-]*)?(\d{1,9})$/);
  return m ? `PSKU-${m[1].padStart(6, '0')}` : t;
}
