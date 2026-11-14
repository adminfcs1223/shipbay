// A station tab stays open for days. This checks /version.json and offers (or does, when the tab was in the background) a reload once a newer build is live.
import { useEffect, useRef, useState } from 'react';

/* global __SHIPBAY_BUILD__ */
const MINE = typeof __SHIPBAY_BUILD__ !== 'undefined' ? __SHIPBAY_BUILD__ : 'dev';
const EVERY = 4 * 60 * 1000;

export default function VersionWatch() {
  const [stale, setStale] = useState(false); const hiddenAt = useRef(null);
  useEffect(() => {
    if (MINE === 'dev' || MINE.startsWith('local-')) return undefined;
    let live = true;
    const check = async () => {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) return false;
        const j = await r.json(); const newer = !!j?.build && j.build !== MINE; if (live && newer) setStale(true); return newer;
      } catch { return false; }
    };
    const onVis = async () => {
      if (document.hidden) { hiddenAt.current = Date.now(); return; }
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0; hiddenAt.current = null;
      if ((await check()) && away > 60000 && !window.__shipbayBusy) window.location.reload();
    };
    const t = setInterval(check, EVERY); document.addEventListener('visibilitychange', onVis); check();
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  if (!stale) return null;
  return <div className="versionbar"><span>The WMS was updated. Reload to get the new version.</span><button onClick={() => window.location.reload()}>Reload</button></div>;
}
