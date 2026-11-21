import { createClient } from '@supabase/supabase-js';
// Nexus uses the ShipBay project and the same floor logins; it keeps its own session on its own host.
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY, { auth: { storageKey: 'nexus-auth' } });
export const NEXUS_ROLES = ['shipbay_admin', 'shipbay_staff', 'wms_employee'];
export const num = (n) => Number(n || 0).toLocaleString('en-US');
export const day = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const stamp = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
