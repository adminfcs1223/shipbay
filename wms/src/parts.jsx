// Pieces both WMS screens share: the on-screen 4x6 label (same markup that prints), the scanner box and the beeps.
import { useEffect, useRef, useState } from 'react';
import { labelHtml } from './label';

/** The label at screen size. `inch` = how many CSS pixels one label inch gets. */
export function LabelPreview({ pallet, brand, inch = 62, ghost }) {
  return <div className={`labelview ${ghost ? 'ghost' : ''}`} style={{ '--u': `${inch}px`, width: inch * 4, height: inch * 6 }} dangerouslySetInnerHTML={{ __html: labelHtml(pallet, brand) }} />;
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
