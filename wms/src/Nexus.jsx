// Nexus window: the live pallet count from Nexus (the warehouse-floor system), read with this WMS login. Read-only here;
// FIFO and cycle counts open in Nexus itself. Refreshes every 30 seconds and whenever the tab is shown again.
import { useEffect, useState } from 'react';
import { supabase } from './lib.js';
export const NEXUS_URL = import.meta.env.VITE_NEXUS_URL || 'https://nexuslogistics-tjbp.netlify.app';
const num = (n) => Number(n || 0).toLocaleString('en-US');
export default function Nexus() {
  const [ov, setOv] = useState(null); const [err, setErr] = useState(null); const [at, setAt] = useState(null);
  const load = () => supabase.rpc('nexus_overview').then(({ data, error }) => { if (error) setErr(error.message); else { setErr(null); setOv(data); setAt(new Date()); } });
  useEffect(() => { load(); const t = setInterval(load, 30000); const vis = () => { if (!document.hidden) load(); }; document.addEventListener('visibilitychange', vis); return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); }; }, []);
  const t = (ov?.brands || []).reduce((a, b) => ({ s: a.s + b.pallets_stored, w: a.w + b.pallets_waiting, h: a.h + b.pallets_on_hold }), { s: 0, w: 0, h: 0 });
  return (
    <>
      <header className="pagehead">
        <h1>Nexus<span className="dot">.</span></h1>
        <div className="glance" data-testid="nexus-glance">
          <div><b>{num(t.s)}</b><small>Pallets stored</small></div><div><b className={t.w ? 'hot' : ''}>{num(t.w)}</b><small>To put away</small></div>
          <div><b className={t.h ? 'hot' : ''}>{num(t.h)}</b><small>On hold</small></div><div><b>{ov ? `${num(ov.locations.used)} / ${num(ov.locations.total)}` : '—'}</b><small>Positions used</small></div>
        </div>
      </header>
      {err && <div className="strip bad"><span>Nexus could not be read ({err}).</span><button onClick={load}>Try again</button></div>}
      {!ov && !err ? <div className="empty">Loading…</div> : ov && (
        <section className="ready" data-testid="nexus-brands">
          <h3>Live pallet count <span>{at ? `as of ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}</span></h3>
          <ul>{ov.brands.map((b) => <li key={b.org_id}><b>{b.brand}</b> · {num(b.pallets_stored)} stored · {num(b.pallets_waiting)} to put away{b.pallets_on_hold ? ` · ${num(b.pallets_on_hold)} on hold` : ''} · {num(b.units_on_hand)} units on hand</li>)}</ul>
          {ov.brands.length === 0 && <p className="sm">No pallets on file.</p>}
        </section>)}
      <p><a className="btn" href={NEXUS_URL} target="_blank" rel="noopener">Open Nexus for FIFO and cycle counts</a></p>
    </>
  );
}
