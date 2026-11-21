// Position labels, printed from Nexus (the warehouse's shared controls live here, not in any one WMS).
// 4x6 label: the code large, its zone, and the LOC-<code> barcode the put-away scan reads.
import JsBarcode from 'jsbarcode';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bars = (v) => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); JsBarcode(svg, v, { format: 'CODE128', displayValue: false, margin: 0, height: 90, width: 3 }); svg.setAttribute('preserveAspectRatio', 'none'); svg.style.width = '100%'; svg.style.height = '1.6in'; return svg.outerHTML; };
export const labelsHtml = (rows) => `<!doctype html><html><head><meta charset="utf-8"><title>Position labels</title><style>
@page { size: 4in 6in; margin: 0; } body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
section { width: 4in; height: 6in; padding: .3in; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; }
h1 { font-size: 1.25in; margin: 0; line-height: 1; } p { margin: .1in 0 0; font-size: .26in; text-transform: uppercase; } footer { display: flex; justify-content: space-between; font-size: .16in; }
</style></head><body>${rows.map((l) => `<section><div><h1>${esc(l.code)}</h1><p>${esc(l.zone || '')}</p></div>${bars(`LOC-${l.code}`)}<footer><span>NEXUS</span><span>LOC-${esc(l.code)}</span></footer></section>`).join('')}</body></html>`;
export function printPositionLabels(rows) {
  const w = window.open('', '_blank'); if (!w) return false;
  w.document.write(labelsHtml(rows)); w.document.close(); w.focus(); setTimeout(() => w.print(), 300); return true;
}
// "P-65..P-72" or "P-65, P-66" -> list of codes
export function expandCodes(text) {
  const out = [];
  for (const part of String(text || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(.*?)(\d+)\s*\.\.\s*(?:\1)?(\d+)$/);
    if (!m) { out.push(part.toUpperCase()); continue; }
    const [, pre, a, b] = m; const lo = Number(a), hi = Number(b); if (hi < lo || hi - lo > 200) throw new Error('Check the range.');
    for (let n = lo; n <= hi; n++) out.push(`${pre}${String(n).padStart(a.length, '0')}`.toUpperCase());
  }
  return out;
}
