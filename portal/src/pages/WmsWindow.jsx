// The ShipBay WMS, loaded inside the dashboard. The WMS keeps no session of its own here: when it says it is ready the dashboard
// hands it this user's current access token (and again whenever it is refreshed), only to the WMS origin.
import { useEffect, useRef } from 'react';
import { supabase } from '../lib';
export const WMS_URL = import.meta.env.VITE_WMS_URL || 'https://wmsshipbay.netlify.app';
const ORIGIN = new URL(WMS_URL).origin;
export default function WmsWindow() {
  const frame = useRef(null);
  useEffect(() => {
    const send = async (session) => { const s = session || (await supabase.auth.getSession()).data.session; if (s && frame.current?.contentWindow) frame.current.contentWindow.postMessage({ type: 'wms-token', token: s.access_token, user: s.user.id }, ORIGIN); };
    const on = (e) => { if (e.origin === ORIGIN && e.data?.type === 'wms-ready') send(); };
    window.addEventListener('message', on);
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { if (s) send(s); });
    return () => { window.removeEventListener('message', on); sub.subscription.unsubscribe(); };
  }, []);
  return (
    <>
      <div className="card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }} data-testid="wms-window">
        <div className="cardhead" style={{ padding: '12px 16px' }}><h3>ShipBay WMS<span className="dot">.</span></h3><a className="sm" href={WMS_URL} target="_blank" rel="noopener">Open in its own tab</a></div>
        <iframe ref={frame} title="ShipBay WMS" src={`${WMS_URL}/?embed=1`} style={{ width: '100%', height: '82vh', border: 0, display: 'block' }} />
      </div>
    </>);
}
