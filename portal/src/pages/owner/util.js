// Shared bits for the Owner area: the passphrase token, calls to the `owner` edge function, paging reads, formatting.
import { supabase, fn } from '../../lib';

export const TOKEN_KEY = 'shipbay-owner-token';
export const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

/** Call the owner function with the unlock token attached. */
export const ownerFn = (body) => fn('owner', body, getToken() ? { 'x-owner-token': getToken() } : undefined);

/** Read every row of a table (PostgREST caps a single read at 1,000). `build(q)` adds filters/order to the query. */
export async function fetchAll(table, columns = '*', build = (q) => q, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(supabase.from(table).select(columns)).range(from, from + page - 1);
    if (error) { console.error(table, error); break; }
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

export const money = (n, d = 0) => (n == null || isNaN(n) ? '—' : (n < 0 ? '−' : '') + '$' + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const pct = (n, d = 0) => (n == null || isNaN(n) || !isFinite(n) ? '—' : (Number(n) * 100).toFixed(d) + '%');
export const num = (n) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US'));
export const ymd = (d) => { const x = d instanceof Date ? d : new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
export const monthKey = (d) => ymd(d).slice(0, 7);
export const monthLabel = (k) => { const [y, m] = k.split('-'); return new Date(Number(y), Number(m) - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' }); };
export const ago = (iso) => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
export const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
export const hhmm = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);

export const STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['call_booked', 'Call booked'], ['quoted', 'Quoted'], ['signed', 'Won'], ['lost', 'Lost'], ['dnc', 'Do not contact']];
export const stageLabel = (s) => STAGES.find((x) => x[0] === s)?.[1] || s;
export const stageClass = (s) => ({ signed: 'ok', call_booked: 'ok', quoted: 'ok', replied: 'warn', lost: 'bad', dnc: 'bad', new: 'muted', contacted: 'navy' }[s] || 'muted');

/** Tiny CSV parser (quotes, commas, newlines inside quotes). Returns { headers, rows: [{header: value}] }. */
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() || []).map((h) => h.trim());
  return { headers, rows: rows.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

/** Guess which CSV column holds what. Returns { field: header }. */
export function guessColumns(headers) {
  const H = headers.map((h) => h.toLowerCase());
  const find = (...cands) => { for (const c of cands) { const i = H.findIndex((h) => h === c || h.includes(c)); if (i >= 0) return headers[i]; } return ''; };
  return {
    company: find('company', 'merchant', 'brand', 'store', 'business', 'account'),
    domain: find('domain', 'website', 'url', 'site'),
    contact_name: find('contact', 'full name', 'first name', 'name'),
    email: find('email'),
    phone: find('phone', 'mobile', 'tel'),
    title: find('title', 'role'),
    city: find('city'),
    state: find('state', 'region', 'province'),
    est_sales_usd: find('est_sales', 'sales', 'revenue', 'gmv'),
    products: find('products', 'skus'),
    categories: find('categor'),
    notes: find('notes', 'comment'),
  };
}
