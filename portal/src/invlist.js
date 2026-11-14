// Inventory lists: read a client's .xlsx or .csv in the browser, match its columns, and roll the rows up into products.
// A list can be one row per product with a quantity, or one row per unit (Amazon sellers' sheets); both end up as
// one line per product with expected units split FBA / FBM. Nothing here talks to the database.
import { unzipSync, strFromU8 } from 'fflate';

const ent = (s) => s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m, e) => (
  { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
const texts = (xml) => { let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) out += m[1]; return ent(out); };
const colIndex = (ref) => { let n = 0; for (let i = 0; i < ref.length; i++) { const c = ref.charCodeAt(i); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; };

/** First visible worksheet of an .xlsx → array of rows (arrays of strings). Reads values only; no formulas, no styles. */
export function parseXlsx(buf) {
  const zip = unzipSync(new Uint8Array(buf), { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name) });
  const read = (n) => (zip[n] ? strFromU8(zip[n]) : '');
  const shared = []; { const re = /<si>([\s\S]*?)<\/si>/g; let m; const s = read('xl/sharedStrings.xml'); while ((m = re.exec(s))) shared.push(texts(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, ''))); }
  // pick the first sheet that is not hidden, in workbook order
  let sheetPath = null;
  const rels = {}; { const re = /<Relationship\s[^>]*>/g; let m; const s = read('xl/_rels/workbook.xml.rels'); while ((m = re.exec(s))) { const id = /Id="([^"]+)"/.exec(m[0])?.[1]; const t = /Target="([^"]+)"/.exec(m[0])?.[1]; if (id && t) rels[id] = t.replace(/^\/?xl\//, '').replace(/^\//, ''); } }
  { const re = /<sheet\s[^>]*>/g; let m; const s = read('xl/workbook.xml'); while ((m = re.exec(s))) { if (/state="(hidden|veryHidden)"/.test(m[0])) continue; const rid = /r:id="([^"]+)"/.exec(m[0])?.[1]; if (rid && rels[rid] && zip[`xl/${rels[rid]}`]) { sheetPath = `xl/${rels[rid]}`; break; } } }
  if (!sheetPath) sheetPath = Object.keys(zip).filter((k) => k.startsWith('xl/worksheets/')).sort()[0];
  if (!sheetPath) throw new Error('That file has no worksheet in it.');
  const xml = read(sheetPath); const rows = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g; const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let rm;
  while ((rm = rowRe.exec(xml))) {
    if (!rm[1]) continue;
    const row = []; let cm; let next = 0; cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1]; const body = cm[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1]; const i = ref ? colIndex(ref) : next; next = i + 1;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      let v = '';
      if (t === 'inlineStr') v = texts(body);
      else { const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]; if (raw != null) v = t === 's' ? (shared[Number(raw)] ?? '') : ent(raw); }
      if (v !== '') { while (row.length < i) row.push(''); row[i] = v; }
    }
    if (row.some((c) => String(c).trim() !== '')) rows.push(row.map((c) => c ?? ''));
  }
  return rows;
}

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** The columns a list can carry. Only the product name is required. */
export const LIST_FIELDS = [
  ['name', 'Product name', true, /^(product |item )?(name|title)$|^description$|^product$|^item$/i],
  ['asin', 'ASIN', false, /asin/i],
  ['code', 'Your SKU / item code', false, /^(variant |seller |merchant |m)?sku$|^sku ?(code|id|#)?$|^item ?(number|no|#|code)$|^part ?(number|no|#)$|^fnsku$/i],
  ['channel', 'FBA or FBM', false, /fba|fbm|fulfil?lment|channel/i],
  ['supplier', 'Supplier / brand', false, /supplier|vendor|brand|source|store|manufacturer/i],
  ['qty', 'Quantity', false, /^(qty|quantity|units?|count|on ?hand|stock|pieces|pcs)\b/i],
];

/** Guess which column is which from the header row; a first column with no header on an Amazon-style sheet is the supplier. */
export function guessMap(headers) {
  const m = {}; const taken = new Set();
  for (const [key, , , re] of LIST_FIELDS) { const i = headers.findIndex((h, idx) => !taken.has(idx) && re.test(String(h).trim())); if (i >= 0) { m[key] = i; taken.add(i); } }
  if (m.supplier == null && m.asin != null && !taken.has(0) && String(headers[0] ?? '').trim() === '') m.supplier = 0;
  return m;
}

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// "Blue Mug 12ozBlue Mug 12oz" (a cell pasted twice) → "Blue Mug 12oz"
const undouble = (s) => { if (s.length >= 16 && s.length % 2 === 0) { const h = s.slice(0, s.length / 2); if (h === s.slice(s.length / 2)) return h.trim(); } return s; };
export const asinsOf = (cell) => [...new Set(String(cell ?? '').toUpperCase().split(/[\s/,;|&+]+/).filter((t) => /^[A-Z0-9]{10}$/.test(t) && /\d/.test(t)))];
const channelOf = (cell) => { const t = String(cell ?? '').toUpperCase().replace(/[^A-Z]/g, ''); return t === 'FBA' ? 'fba' : t === 'FBM' || t === 'MFN' ? 'fbm' : 'other'; };
const top = (counts) => { let best = null, n = -1; for (const [k, v] of counts) if (v > n || (v === n && k.length > best.length)) { best = k; n = v; } return best; };

/**
 * rows (without the header) + column map → products.
 * A product is: the client's own code when the list has one; otherwise every row sharing an ASIN (a cell holding several
 * ASINs ties them together as one product); otherwise the product name.
 * Returns { items: [{ code, asins, name, supplier, qty, qty_fba, qty_fbm }], stats }.
 */
export function buildItems(data, map) {
  const parent = new Map(); const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let c = x; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); return x; };
  const union = (a, b) => { const ra = find(add(a)), rb = find(add(b)); if (ra !== rb) parent.set(rb, ra); };
  const cell = (r, k) => (map[k] == null ? '' : r[map[k]] ?? '');
  const parsed = []; let skipped = 0;
  for (const r of data) {
    const name = undouble(tidy(cell(r, 'name'))); const code = tidy(cell(r, 'code')); const asins = asinsOf(cell(r, 'asin'));
    if (!name && !code && !asins.length) { skipped++; continue; }
    let qty = 1;
    if (map.qty != null) { const n = parseFloat(String(cell(r, 'qty')).replace(/[^0-9.\-]/g, '')); qty = Number.isFinite(n) ? Math.round(n) : 0; if (qty < 0) qty = 0; }
    let key;
    if (code) key = add(`c:${code.toLowerCase()}`);
    else if (asins.length) { asins.forEach((a) => union(`a:${asins[0]}`, `a:${a}`)); key = `a:${asins[0]}`; }
    else key = add(`n:${name.toLowerCase()}`);
    parsed.push({ key, name, code, asins, supplier: tidy(cell(r, 'supplier')), channel: map.channel == null ? 'other' : channelOf(cell(r, 'channel')), qty });
  }
  const groups = new Map(); const allCase = new Map();   // one spelling per supplier across the whole list (Tenax, not TENAX on some lines)
  for (const p of parsed) {
    const k = find(p.key);
    let g = groups.get(k); if (!g) { g = { code: '', asins: new Set(), names: new Map(), sups: new Map(), qty: 0, qty_fba: 0, qty_fbm: 0, first: groups.size }; groups.set(k, g); }
    if (p.code && !g.code) g.code = p.code;
    p.asins.forEach((a) => g.asins.add(a));
    if (p.name) g.names.set(p.name, (g.names.get(p.name) || 0) + 1);
    if (p.supplier) { const lk = p.supplier.toLowerCase(); g.sups.set(lk, (g.sups.get(lk) || 0) + 1); const sc = allCase.get(lk) || new Map(); sc.set(p.supplier, (sc.get(p.supplier) || 0) + p.qty); allCase.set(lk, sc); }
    g.qty += p.qty; if (p.channel === 'fba') g.qty_fba += p.qty; else if (p.channel === 'fbm') g.qty_fbm += p.qty;
  }
  const items = [...groups.values()].sort((a, b) => a.first - b.first).map((g) => {
    const sup = g.sups.size ? top(allCase.get(top(g.sups))) : '';
    return { code: g.code, asins: [...g.asins].sort(), name: (top(g.names) || g.code || [...g.asins][0] || '').slice(0, 300), supplier: sup.slice(0, 120), qty: g.qty, qty_fba: g.qty_fba, qty_fbm: g.qty_fbm };
  });
  const sum = (k) => items.reduce((s, i) => s + i[k], 0);
  return { items, stats: { rows: data.length, skipped, products: items.length, units: sum('qty'), fba: sum('qty_fba'), fbm: sum('qty_fbm'), noAsin: items.filter((i) => !i.asins.length).length, multiAsin: items.filter((i) => i.asins.length > 1).length, perUnit: map.qty == null } };
}

/** File → rows. */
export async function readListFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx')) return parseXlsx(await file.arrayBuffer());
  if (name.endsWith('.csv') || file.type === 'text/csv') return parseCsv(await file.text());
  if (name.endsWith('.xls')) throw new Error('That is an old Excel format (.xls). Open it and save it as .xlsx or .csv, then upload it again.');
  throw new Error('Upload an Excel file (.xlsx) or a .csv.');
}
