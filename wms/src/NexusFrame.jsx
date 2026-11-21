// Nexus inside the WMS: the live floor map, loaded from the Nexus site. Nexus keeps no session of its own here; when it says it
// is ready we hand it this user's current access token (and again whenever the token is refreshed), only to the Nexus origin.
import { useEffect, useRef } from 'react';
import { getAccess, onAccess } from './lib.js';
export const NEXUS_URL = import.meta.env.VITE_NEXUS_URL || 'https://nexus-logistics-wms.netlify.app';
const ORIGIN = new URL(NEXUS_URL).origin;
export default function NexusFrame() {
  const frame = useRef(null);
  useEffect(() => {
    const send = async (given) => { const a = given || (await getAccess()); if (a?.token && frame.current?.contentWindow) frame.current.contentWindow.postMessage({ type: 'nexus-token', token: a.token, user: a.user }, ORIGIN); };
    const on = (e) => { if (e.origin === ORIGIN && e.data?.type === 'nexus-ready') send(); };
    window.addEventListener('message', on);
    const off = onAccess((a) => send(a));
    return () => { window.removeEventListener('message', on); off(); };
  }, []);
  return (
    <section className="nexusframe" data-testid="nexus-frame">
      <h3>Locations · live from Nexus</h3>
      <p className="sm">Positions are managed in Nexus (add positions, print position labels, cycle counts). <a href={NEXUS_URL} target="_blank" rel="noopener">Open Nexus</a></p>
      <iframe ref={frame} title="Nexus floor map" src={`${NEXUS_URL}/?embed=1`} style={{ width: '100%', height: 720, border: '1px solid #2a2e35', background: '#0e1013' }} />
    </section>);
}
