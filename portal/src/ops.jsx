// Shared warehouse-floor pieces: the scanner input (keyboard-wedge barcode scanners type the code and press Enter),
// beeps, barcode rendering (Code 128) and print helpers for the 3×1 label printer and packing slips.
import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';

/* ---------- sounds: short beep on a good scan, low double on a bad one ---------- */
let ctx;
export function beep(kind = 'ok') {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const tone = (f, t0, d) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.frequency.value = f; o.type = 'square'; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + t0); o.stop(ctx.currentTime + t0 + d); };
    if (kind === 'ok') tone(1320, 0, 0.08);
    else if (kind === 'done') { tone(1100, 0, 0.09); tone(1600, 0.1, 0.14); }
    else { tone(220, 0, 0.18); tone(220, 0.22, 0.18); }
  } catch { /* no audio */ }
}

/* ---------- scanner box: stays focused, fires on Enter, ignores accidental empty scans ---------- */
export function ScanBox({ onScan, placeholder = 'Scan a barcode…', disabled, autoFocus = true, hint }) {
  const ref = useRef(null);
  const [v, setV] = useState('');
  useEffect(() => { if (autoFocus && !disabled) ref.current?.focus(); }, [autoFocus, disabled]);
  // keep the scanner input focused unless the user is typing somewhere else on purpose
  useEffect(() => {
    const back = (e) => { if (!autoFocus || disabled) return; const t = e.target; if (t && (t.closest('input, textarea, select, button, a, [contenteditable]'))) return; setTimeout(() => ref.current?.focus(), 0); };
    document.addEventListener('click', back); return () => document.removeEventListener('click', back);
  }, [autoFocus, disabled]);
  const submit = (e) => { e.preventDefault(); const code = v.trim(); setV(''); if (code) onScan(code); };
  return (
    <form className={`scanbox ${disabled ? 'off' : ''}`} onSubmit={submit}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M11 8v8M14 8v8M17 8v8"/></svg>
      <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} disabled={disabled} autoComplete="off" spellCheck={false} />
      <button type="submit" className="btn-sm" disabled={disabled}>Enter</button>
      {hint && <div className="hint">{hint}</div>}
    </form>
  );
}

/* ---------- barcodes ---------- */
export function barcodeSvg(text, opts = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try { JsBarcode(svg, String(text), { format: 'CODE128', displayValue: true, fontSize: 14, height: 46, width: 1.6, margin: 4, ...opts }); } catch { return `<div>${text}</div>`; }
  return svg.outerHTML;
}

const PRINT_CSS = `
  * { box-sizing: border-box; } body { margin: 0; font-family: Inter, system-ui, sans-serif; color: #111; }
  .lbl { width: 3in; height: 1in; padding: .06in .1in; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; overflow: hidden; }
  .lbl .t { font-size: 10px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lbl .s { font-size: 8.5px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lbl svg { width: 100%; height: .52in; }
  @page { margin: 0; }
`;
function openPrint(html, title, extraCss = '') {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${PRINT_CSS}${extraCss}</style></head><body>${html}<script>setTimeout(function(){window.print();},250);</script></body></html>`);
  w.document.close();
  return true;
}

/** 3×1 item labels: SKU barcode (uses the UPC/barcode if the SKU has one, else the SKU code) — `copies` per item. */
export function printSkuLabels(items, copies = 1) {
  const html = items.flatMap((s) => Array.from({ length: copies }, () =>
    `<div class="lbl"><div class="t">${esc(s.name)}${s.variant ? ` — ${esc(s.variant)}` : ''}</div>${barcodeSvg(s.barcode || s.sku, { height: 40, fontSize: 12, width: 1.4 })}<div class="s">${esc(s.sku)}${s.barcode && s.barcode !== s.sku ? ` · UPC ${esc(s.barcode)}` : ''}</div></div>`)).join('');
  return openPrint(html, 'Item labels 3×1');
}
/** 3×1 bin/location labels */
export function printLocationLabels(locs) {
  const html = locs.map((l) => `<div class="lbl"><div class="t" style="font-size:13px">${esc(l.code)}</div>${barcodeSvg(`LOC-${l.code}`, { height: 40, fontSize: 12, width: 1.6 })}<div class="s">${esc(l.kind || '')} ${l.zone ? '· zone ' + esc(l.zone) : ''}</div></div>`).join('');
  return openPrint(html, 'Location labels 3×1');
}

/** Packing slip (letter size) with an order-number barcode the packing station can scan to pull the order up. */
export function printPackingSlip(o, lines, orgName) {
  const a = o.ship_to || {};
  const addr = [a.name, a.company, a.address1, a.address2, [a.city, a.province_code || a.province, a.zip].filter(Boolean).join(', '), a.country_code !== 'US' ? a.country : ''].filter(Boolean).map(esc).join('<br>');
  const rows = lines.filter((l) => l.is_physical && l.qty > 0).map((l) => `<tr><td>${esc(l.sku || '')}</td><td>${esc(l.name)}</td><td class="n">${l.qty}</td><td class="chk">☐</td></tr>`).join('');
  const html = `
    <div class="slip">
      <div class="head"><div><div class="brand">${esc(orgName)}</div><div class="sub">Fulfilled by shipbay · 115 Stryker Ln, Unit 10, Hillsborough Township, NJ 08844</div></div><div class="bc">${barcodeSvg(o.order_number, { height: 44, fontSize: 13 })}</div></div>
      <div class="meta"><div><b>Order</b> ${esc(o.order_number)}${o.marketplace ? ` · ${esc(o.marketplace)}` : ''}</div><div><b>Placed</b> ${new Date(o.placed_at).toLocaleDateString()}</div>${o.ship_by ? `<div><b>Ship by</b> ${esc(o.ship_by)}</div>` : ''}${o.shipping_method ? `<div><b>Method</b> ${esc(o.shipping_method)}</div>` : ''}</div>
      <div class="to"><b>Ship to</b><div>${addr}</div></div>
      <table><thead><tr><th>SKU</th><th>Item</th><th class="n">Qty</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      ${o.notes ? `<div class="note"><b>Notes</b> ${esc(o.notes)}</div>` : ''}
      <div class="foot">Questions about your order? Contact ${esc(orgName)}. Packed with care in Hillsborough, NJ.</div>
    </div>`;
  const css = `
    .slip { width: 8.5in; min-height: 11in; padding: .6in; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 12px; }
    .brand { font-size: 22px; font-weight: 800; } .sub { font-size: 11px; color: #555; margin-top: 4px; }
    .bc svg { height: 60px; }
    .meta { display: flex; gap: 24px; font-size: 12.5px; margin: 14px 0; flex-wrap: wrap; }
    .to { font-size: 13px; margin-bottom: 18px; line-height: 1.45; } .to b { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #555; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; } th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #555; border-bottom: 1px solid #999; padding: 6px 4px; }
    td { padding: 8px 4px; border-bottom: 1px solid #e5e5e5; } .n { text-align: right; width: 50px; } .chk { width: 28px; text-align: center; font-size: 16px; }
    .note { margin-top: 16px; font-size: 12.5px; background: #f6f6f6; padding: 10px; border-radius: 6px; }
    .foot { margin-top: 40px; font-size: 11px; color: #777; text-align: center; }
    @page { size: letter; margin: 0; }`;
  return openPrint(html, `Packing slip ${o.order_number}`, css);
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
export const money = (n) => (n == null || n === '' ? '—' : `$${Number(n).toFixed(2)}`);
export const STATUS = { new: ['New', 'muted'], on_hold: ['On hold', 'warn'], backordered: ['Backordered', 'bad'], picked: ['Picking', 'navy'], packed: ['Packed', 'ok'], shipped: ['Shipped', 'ok'], cancelled: ['Cancelled', 'bad'] };
export const SOURCE = { mirakl: 'Marketplace', online_store: 'Online store', draft: 'Wholesale / draft', shop: 'Shop app', shopify: 'Shopify', pos: 'POS' };
/** red when late, orange when due today/tomorrow */
export function dueClass(ship_by) {
  if (!ship_by) return '';
  const d = Math.round((new Date(ship_by + 'T23:59:59') - Date.now()) / 864e5);
  return d < 0 ? 'late' : d <= 1 ? 'soon' : '';
}
