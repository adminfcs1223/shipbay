import { createClient } from '@supabase/supabase-js';

// Same Supabase project and the same logins as dashboard.shipbay3pl.com; the WMS keeps its own session on its own host.
export const STORAGE_KEY = 'shipbay-wms-auth';
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY, {
  auth: { storageKey: STORAGE_KEY },
});
export const WMS_ROLES = ['shipbay_admin', 'shipbay_staff'];
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtTime = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const fmtDay = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const fmtStamp = (d) => `${fmtDay(d)} · ${fmtTime(d)}`;
export const sameDay = (a, b = new Date()) => new Date(a).toDateString() === new Date(b).toDateString();
