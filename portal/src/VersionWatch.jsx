// A tab left open across a deploy runs old code. This checks /version.json every few minutes and whenever the tab comes
// back into view. When a newer build is live: reload at once if the tab has been in the background and nothing is in
// progress, otherwise show a bar with a Reload button. Calls in progress are never interrupted (window.__shipbayBusy),
// and a call that is saved in the browser's outbox survives the reload.
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
  return <div className="versionbar"><span>The portal was updated. Reload to get the new version{window.__shipbayBusy ? ' after this call' : ''}.</span><button onClick={() => window.location.reload()}>Reload</button></div>;
}
