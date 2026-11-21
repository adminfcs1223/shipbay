import { createClient } from '@supabase/supabase-js';
// Nexus uses the ShipBay project and the same floor logins. Standalone it keeps its own session. Embedded in a WMS (?embed)
// it keeps no session at all: the WMS hands it the signed-in user's short-lived access token (see App.jsx).
export const EMBED = new URLSearchParams(window.location.search).has('embed');
export const WMS_ORIGINS = ['https://wms.shipbay3pl.com', 'https://wmsshipbay.netlify.app'];
let token = null; export const setToken = (t) => { token = t; };
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY,
  EMBED ? { accessToken: async () => token } : { auth: { storageKey: 'nexus-auth' } });
export const NEXUS_ROLES = ['shipbay_admin', 'shipbay_staff', 'wms_employee'];
export const num = (n) => Number(n || 0).toLocaleString('en-US');
export const day = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const stamp = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
