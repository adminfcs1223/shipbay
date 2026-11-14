// The 4x6 pallet label: brand name, PSKU# and its Code 128 barcode, plus what the floor needs to read from ten feet
// (pallet n of m, received when, by whom, reference). One label per page, sized for a 4x6 thermal printer.
import JsBarcode from 'jsbarcode';
import { esc, fmtStamp } from './lib';

export function barcodeSvg(text, opts = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(svg, String(text), { format: 'CODE128', displayValue: false, height: 120, width: 3, margin: 0, ...opts });
    svg.setAttribute('preserveAspectRatio', 'none');
    const w = svg.getAttribute('width'); const h = svg.getAttribute('height');
    if (w && h) svg.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
    svg.removeAttribute('width'); svg.removeAttribute('height'); svg.removeAttribute('style');
  } catch { return `<div>${esc(text)}</div>`; }
  return svg.outerHTML;
}

// brand name is the biggest thing on the label; step the size down so long names still fit on two lines
const brandSize = (name) => { const n = (name || '').length; return n <= 9 ? 0.74 : n <= 13 ? 0.58 : n <= 18 ? 0.46 : n <= 28 ? 0.38 : 0.3; };

/** One label's markup. `unit` lets the on-screen preview scale the same markup (CSS var --u = one inch). */
export function labelHtml(p, brand) {
  const meta = [
    ['Received', fmtStamp(p.received_at)],
    p.reference ? ['Reference', p.reference] : null,
    p.carrier ? ['Carrier', p.carrier] : null,
    p.cartons != null ? ['Cartons', String(p.cartons)] : null,
    p.received_by_name ? ['By', p.received_by_name] : null,
  ].filter(Boolean);
  return `
  <section class="plabel">
    <header>
      <small>Brand</small>
      <div class="brand" style="font-size: calc(var(--u) * ${brandSize(brand)})">${esc(brand)}</div>
    </header>
    <div class="pskurow">
      <div><small>PSKU#</small><div class="psku">${esc(p.psku)}</div></div>
      <div class="of"><small>Pallet</small><b>${p.batch_pos}<i>of</i>${p.batch_size}</b></div>
    </div>
    <div class="bc">${barcodeSvg(p.psku)}</div>
    <div class="meta">${meta.map(([k, v]) => `<div><small>${k}</small><span>${esc(v)}</span></div>`).join('')}</div>
    ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
    <footer><span>ShipBay WMS</span><span>${esc(p.psku)}</span></footer>
  </section>`;
}

export const LABEL_CSS = `
  :root { --u: 1in; }
  .plabel { width: calc(var(--u) * 4); height: calc(var(--u) * 6); padding: calc(var(--u) * .2) calc(var(--u) * .22) calc(var(--u) * .14); display: flex; flex-direction: column;
    font-family: 'Archivo', 'Helvetica Neue', Arial, sans-serif; color: #000; background: #fff; overflow: hidden; box-sizing: border-box; }
  .plabel * { box-sizing: border-box; margin: 0; padding: 0; }
  .plabel small { display: block; font-size: calc(var(--u) * .1); font-weight: 600; color: #000; letter-spacing: .01em; }
  .plabel header { border-bottom: calc(var(--u) * .035) solid #000; padding-bottom: calc(var(--u) * .1); min-height: calc(var(--u) * 1.32); display: flex; flex-direction: column; }
  .plabel .brand { font-weight: 800; line-height: .98; letter-spacing: -.02em; margin-top: auto; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .plabel .pskurow { display: flex; justify-content: space-between; align-items: flex-end; gap: calc(var(--u) * .1); padding: calc(var(--u) * .12) 0 calc(var(--u) * .1); }
  .plabel .psku { font-size: calc(var(--u) * .4); font-weight: 800; letter-spacing: -.01em; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .plabel .of { text-align: right; flex: none; }
  .plabel .of b { display: block; font-size: calc(var(--u) * .26); font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .plabel .of i { font-style: normal; font-size: calc(var(--u) * .12); font-weight: 600; margin: 0 calc(var(--u) * .04); }
  .plabel .bc { height: calc(var(--u) * 1.5); padding: 0 calc(var(--u) * .12); }
  .plabel .bc svg { width: 100%; height: 100%; display: block; }
  .plabel .meta { margin-top: calc(var(--u) * .14); border-top: calc(var(--u) * .012) solid #000; display: grid; grid-template-columns: 1fr 1fr; }
  .plabel .meta div { padding: calc(var(--u) * .07) 0; border-bottom: calc(var(--u) * .012) solid #000; min-width: 0; }
  .plabel .meta div:nth-child(odd) { padding-right: calc(var(--u) * .1); }
  .plabel .meta span { display: block; font-size: calc(var(--u) * .16); font-weight: 700; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plabel .notes { font-size: calc(var(--u) * .13); font-weight: 500; line-height: 1.25; padding-top: calc(var(--u) * .08); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .plabel footer { margin-top: auto; display: flex; justify-content: space-between; font-size: calc(var(--u) * .1); font-weight: 600; padding-top: calc(var(--u) * .06); }
`;

/** Print one 4x6 page per pallet through a hidden frame (no pop-up for the browser to block). Resolves once the print dialog has been opened. */
export function printPalletLabels(pallets, brandOf) {
  return new Promise((resolve) => {
    const fonts = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map((n) => n.outerHTML).join('');
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>Pallet labels 4x6</title>${fonts}
      <style>@page { size: 4in 6in; margin: 0; } html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; min-height: 0 !important; height: auto !important; }
      .plabel { page-break-after: always; break-after: page; } .plabel:last-child { page-break-after: auto; break-after: auto; }
      ${LABEL_CSS}</style></head><body>${pallets.map((p) => labelHtml(p, brandOf(p))).join('')}</body></html>`;
    document.getElementById('wms-print')?.remove();
    const f = document.createElement('iframe');
    f.id = 'wms-print'; f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    f.onload = () => {
      const w = f.contentWindow;
      const go = () => { try { w.focus(); w.print(); } catch { /* printing blocked */ } resolve(true); };
      (w.document.fonts?.ready || Promise.resolve()).then(() => setTimeout(go, 60), go);
    };
    document.body.appendChild(f);
    f.srcdoc = doc;
  });
}

// the on-screen preview uses the same rules as the printed label
if (typeof document !== 'undefined' && !document.getElementById('wms-label-css')) {
  const st = document.createElement('style'); st.id = 'wms-label-css'; st.textContent = LABEL_CSS; document.head.appendChild(st);
}
