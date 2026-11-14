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

/** The cartons of a pallet. With the database rows attached (p._cartons) each carries its own product; otherwise the
 *  codes are derived by the same rule as the database: C + the pallet's six digits + the carton number. */
export function cartonCodes(p) {
  if (p._cartons?.length) return p._cartons.map((c) => ({ seq: c.seq, code: c.code, item_no: c.item_no, item_name: c.item_name, units_per_carton: c.units_per_carton, fba: c.fba }));
  const n = p.cartons || 0; const w = Math.max(2, String(n).length); const num = p.psku.replace(/\D/g, '');
  return Array.from({ length: n }, (_, i) => ({ seq: i + 1, code: `C${num}${String(i + 1).padStart(w, '0')}` }));
}
/** What is on a pallet, product by product, in carton order. */
export function linesOf(p) {
  const out = [];
  for (const c of cartonCodes(p)) {
    const name = c.item_name || (p.mixed ? '' : p.item_name) || p.notes || ''; const no = c.item_no ?? (p.mixed ? null : p.item_no) ?? null; const fba = c.fba ?? p.fba ?? false; const upc = c.units_per_carton ?? (p.mixed ? null : p.units_per_carton) ?? null;
    const last = out[out.length - 1];
    if (last && last.item_name === name && last.item_no === no && last.fba === fba && last.units_per_carton === upc) { last.cartons += 1; last.to = c.seq; }
    else out.push({ item_name: name, item_no: no, fba, units_per_carton: upc, cartons: 1, from: c.seq, to: c.seq });
  }
  return out;
}

/** One 4x6 pallet label's markup. The on-screen preview scales the same markup (CSS var --u = one inch). */
export function labelHtml(p, brand) {
  const meta = [
    p.cartons != null ? ['Cartons', String(p.cartons)] : null,
    p.units_per_carton ? ['Units per carton', String(p.units_per_carton)] : null,
    ['Received', fmtStamp(p.received_at)],
    p.received_by_name ? ['By', p.received_by_name] : null,
    !p.item_name && p.reference ? ['Reference', p.reference] : null,
    !p.item_name && p.carrier ? ['Carrier', p.carrier] : null,
  ].filter(Boolean);
  return `
  <section class="plabel">
    <header>
      <small>Brand</small>
      <div class="brand" style="font-size: calc(var(--u) * ${brandSize(brand)})">${esc(brand)}</div>
    </header>
    <div class="pskurow">
      <div><small>PSKU#</small><div class="psku">${esc(p.psku)}</div></div>
      <div class="of">${p.fba ? '<em class="fba">FBA</em>' : `<small>Pallet</small><b>${p.batch_pos}<i>of</i>${p.batch_size}</b>`}</div>
    </div>
    <div class="bc">${barcodeSvg(p.psku)}</div>
    ${p.mixed ? (() => { const ls = linesOf(p); return `<div class="prod mix"><small>Mixed pallet · ${ls.length || '?'} products</small>${ls.slice(0, 6).map((l) => `<p><b>${l.cartons}</b> ${l.fba ? '<em>FBA</em> ' : ''}${esc(l.item_no ? `${l.item_no} ` : '')}${esc(l.item_name)}</p>`).join('')}${ls.length > 6 ? `<p>+ ${ls.length - 6} more</p>` : ''}</div>`; })()
      : p.item_name ? `<div class="prod"><small>Product${p.item_no ? ` · ${esc(p.item_no)}` : ''}</small><div>${esc(p.item_name)}</div></div>` : ''}
    <div class="meta">${meta.map(([k, v]) => `<div><small>${k}</small><span>${esc(v)}</span></div>`).join('')}</div>
    ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
    <footer><span>ShipBay WMS</span><span>${esc(p.psku)}</span></footer>
  </section>`;
}

/** Carton label sizes (inches, the label read the right way up: width × height). The station remembers which roll it has. */
export const CARTON_SIZES = [['2x1', '2 × 1'], ['2.25x1.25', '2¼ × 1¼'], ['3x1', '3 × 1'], ['4x2', '4 × 2'], ['4x6', '4 × 6']];
export const DEFAULT_CARTON_SIZE = '2x1';
export const parseSize = (v) => { const m = String(v || '').match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/); const w = m ? Number(m[1]) : 2; const h = m ? Number(m[2]) : 1; return w >= 1 && w <= 8.5 && h >= 0.75 && h <= 11 ? { w, h, key: `${w}x${h}` } : { w: 2, h: 1, key: DEFAULT_CARTON_SIZE }; };
export const sizeLabel = (v) => { const s = parseSize(v); return CARTON_SIZES.find(([k]) => k === s.key)?.[1] || `${s.w} × ${s.h}`; };
export function getCartonSize() { try { return parseSize(localStorage.getItem('wms-carton-size') || DEFAULT_CARTON_SIZE).key; } catch { return DEFAULT_CARTON_SIZE; } }
export function setCartonSize(v) { try { localStorage.setItem('wms-carton-size', parseSize(v).key); } catch { /* storage off */ } }
/** How the carton label sits on the roll at this station. Left / right send a page turned a quarter (its sides swapped) with the label turned inside it. */
export const CARTON_TURNS = [['0', 'Straight'], ['left', 'Turned left'], ['right', 'Turned right'], ['180', 'Upside down']];
export function getCartonTurn() { try { const v = localStorage.getItem('wms-carton-turn'); return CARTON_TURNS.some(([k]) => k === v) ? v : '0'; } catch { return '0'; } }
export function setCartonTurn(v) { try { localStorage.setItem('wms-carton-turn', v); } catch { /* storage off */ } }
/** A printed page holding one small label, turned for this station's printer. The label is laid out at the page's top
 *  left and turned about that corner, so its untransformed box never crosses the page edge (print layout splits there). */
function turnedPage(inner, size, turn = '0') {
  const z = parseSize(size); const side = turn === 'left' || turn === 'right';
  const W = `calc(var(--u) * ${z.w})`; const H = `calc(var(--u) * ${z.h})`;
  const t = turn === 'left' ? `translateY(${W}) rotate(-90deg)` : turn === 'right' ? `translateX(${H}) rotate(90deg)` : turn === '180' ? `translate(${W}, ${H}) rotate(180deg)` : 'none';
  return `<div class="cpage" style="width: ${side ? H : W}; height: calc(${side ? W : H} - var(--u) * .02)"><div class="cturn" style="width: ${W}; height: ${H}; transform: ${t}">${inner}</div></div>`;
}
export const cartonPageHtml = (p, brand, c, size, turn = '0') => turnedPage(cartonLabelHtml(p, brand, c, parseSize(size).key), size, turn);
/** A position label on the small roll: the code as large as it fits, then the LOC- barcode. */
export function smallLocationHtml(l, size) {
  const z = parseSize(size); const k = Math.max(0.8, Math.min(z.w / 2.25, z.h / 1.25, 2.6));
  return `<section class="clabel sloc" style="--lw: ${z.w}; --lh: ${z.h}; --k: ${k.toFixed(3)}"><div class="sl"><b>${esc(l.code)}</b><span>${esc(l.zone || '')}</span></div><div class="cb">${barcodeSvg(`LOC-${l.code}`, { height: 60, width: 2 })}</div></section>`;
}

/** One unit label for an open box: marked OPEN BOX, the product, the unit's own barcode, its item number and shelf. */
export function unitLabelHtml(u, brand, shelf, size) {
  const z = parseSize(size); const k = Math.max(0.8, Math.min(z.w / 2.25, z.h / 1.25, 2.6));
  return `
  <section class="clabel" style="--lw: ${z.w}; --lh: ${z.h}; --k: ${k.toFixed(3)}">
    <div class="ct"><span><em>OPEN BOX</em>${u.fba ? ' <em>FBA</em>' : ''} ${esc(brand)}</span><b><i>${esc(shelf || '')}</i></b></div>
    <div class="cn" style="-webkit-line-clamp: ${z.h >= 1.2 ? 2 : 1}">${esc(u.item_name || brand)}</div>
    <div class="cb">${barcodeSvg(u.code, { height: 60, width: 2 })}</div>
    <div class="cf"><span>${esc(u.code)}</span><span>${esc(u.item_no || '')}</span><span>Pick first</span></div>
  </section>`;
}
/** One page per unit on the small roll at the station. */
export const printUnitLabels = (units, brand, shelf, size = getCartonSize(), turn = getCartonTurn()) => {
  const z = parseSize(size); const side = turn === 'left' || turn === 'right';
  return printPages(units.map((u) => turnedPage(unitLabelHtml(u, brand, shelf, z.key), z.key, turn)), 'cpage', side ? `${z.h}in ${z.w}in` : `${z.w}in ${z.h}in`, 'Unit labels', false);
};

/** One carton label: brand and "Carton 5 of 27", the product, the carton's own barcode, then carton / item / pallet numbers. */
export function cartonLabelHtml(p, brand, c, size) {
  const z = parseSize(size); const k = Math.min(z.w / 2.25, z.h / 1.25);   // type grows with the label, never past what the short side allows
  return `
  <section class="clabel" style="--lw: ${z.w}; --lh: ${z.h}; --k: ${Math.max(0.8, Math.min(k, 2.6)).toFixed(3)}">
    <div class="ct"><span>${(c.fba ?? p.fba) ? '<em>FBA</em> ' : ''}${esc(brand)}</span><b>${c.seq} <i>of</i> ${p.cartons}</b></div>
    <div class="cn" style="-webkit-line-clamp: ${z.h >= 1.2 ? 2 : 1}">${esc(c.item_name || (p.mixed ? '' : p.item_name) || p.notes || brand)}</div>
    <div class="cb">${barcodeSvg(c.code, { height: 60, width: 2 })}</div>
    <div class="cf"><span>${esc(c.code)}</span><span>${esc((c.item_no ?? (p.mixed ? '' : p.item_no)) || '')}</span><span>${esc(p.psku)}</span></div>
  </section>`;
}

/** One 4x6 position label for a rack upright or the floor: the code large, its section, and the LOC- barcode the put-away scan reads. */
export function locationLabelHtml(l) {
  return `
  <section class="plabel lloc">
    <header><small>Position</small><div class="brand" style="font-size: calc(var(--u) * ${l.code.length <= 5 ? 1.25 : l.code.length <= 8 ? 0.8 : 0.55})">${esc(l.code)}</div></header>
    <div class="pskurow"><div><small>Section</small><div class="psku">${esc(l.zone || '—')}</div></div></div>
    <div class="bc" style="height: calc(var(--u) * 1.9)">${barcodeSvg(`LOC-${l.code}`)}</div>
    <footer><span>ShipBay WMS</span><span>LOC-${esc(l.code)}</span></footer>
  </section>`;
}

export const LABEL_CSS = `
  :root { --u: 1in; }
  .plabel { width: calc(var(--u) * 4); height: calc(var(--u) * 6); padding: calc(var(--u) * .2) calc(var(--u) * .22) calc(var(--u) * .14); display: flex; flex-direction: column;
    font-family: 'Archivo', 'Helvetica Neue', Arial, sans-serif; color: #000; background: #fff; overflow: hidden; box-sizing: border-box; }
  .plabel * { box-sizing: border-box; margin: 0; padding: 0; }
  .plabel small { display: block; font-size: calc(var(--u) * .1); font-weight: 600; color: #000; letter-spacing: .01em; }
  .plabel header { border-bottom: calc(var(--u) * .035) solid #000; padding-bottom: calc(var(--u) * .1); min-height: calc(var(--u) * 1.12); display: flex; flex-direction: column; }
  .plabel .brand { font-weight: 800; line-height: .98; letter-spacing: -.02em; margin-top: auto; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .plabel .pskurow { display: flex; justify-content: space-between; align-items: flex-end; gap: calc(var(--u) * .1); padding: calc(var(--u) * .12) 0 calc(var(--u) * .1); }
  .plabel .psku { font-size: calc(var(--u) * .4); font-weight: 800; letter-spacing: -.01em; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .plabel .of { text-align: right; flex: none; }
  .plabel .of b { display: block; font-size: calc(var(--u) * .26); font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .plabel .of i { font-style: normal; font-size: calc(var(--u) * .12); font-weight: 600; margin: 0 calc(var(--u) * .04); }
  .plabel .bc { height: calc(var(--u) * 1.5); padding: 0 calc(var(--u) * .12); }
  .plabel .bc svg { width: 100%; height: 100%; display: block; }
  .plabel .bc { height: calc(var(--u) * 1.3); }
  .plabel .prod { margin-top: calc(var(--u) * .12); }
  .plabel .prod div { font-size: calc(var(--u) * .2); font-weight: 800; line-height: 1.12; letter-spacing: -.01em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .plabel .fba { display: inline-block; font-style: normal; font-size: calc(var(--u) * .3); font-weight: 800; line-height: 1; padding: calc(var(--u) * .05) calc(var(--u) * .1); background: #000; color: #fff; }
  .plabel .prod.mix p { font-size: calc(var(--u) * .125); font-weight: 600; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plabel .prod.mix p b { display: inline-block; min-width: calc(var(--u) * .28); font-weight: 800; font-variant-numeric: tabular-nums; }
  .plabel .prod.mix em { font-style: normal; font-weight: 800; background: #000; color: #fff; padding: 0 calc(var(--u) * .03); }
  .plabel.lloc header { min-height: calc(var(--u) * 1.9); }
  .plabel .meta { margin-top: calc(var(--u) * .12); border-top: calc(var(--u) * .012) solid #000; display: grid; grid-template-columns: 1fr 1fr; }
  .plabel .meta div { padding: calc(var(--u) * .07) 0; border-bottom: calc(var(--u) * .012) solid #000; min-width: 0; }
  .plabel .meta div:nth-child(odd) { padding-right: calc(var(--u) * .1); }
  .plabel .meta span { display: block; font-size: calc(var(--u) * .16); font-weight: 700; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plabel .notes { font-size: calc(var(--u) * .13); font-weight: 500; line-height: 1.25; padding-top: calc(var(--u) * .08); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .clabel { --lw: 2.25; --lh: 1.25; --k: 1; --v: calc(var(--u) * var(--k)); width: calc(var(--u) * var(--lw)); height: calc(var(--u) * var(--lh)); padding: calc(var(--v) * .07) calc(var(--v) * .1) calc(var(--v) * .06); display: flex; flex-direction: column; font-family: 'Archivo', 'Helvetica Neue', Arial, sans-serif; color: #000; background: #fff; overflow: hidden; box-sizing: border-box; }
  .clabel * { box-sizing: border-box; margin: 0; padding: 0; }
  .clabel.sloc .sl { display: flex; align-items: baseline; justify-content: space-between; gap: calc(var(--v) * .1); }
  .clabel.sloc .sl b { font-size: calc(var(--v) * .42); font-weight: 800; line-height: 1; letter-spacing: -.01em; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .clabel.sloc .sl span { font-size: calc(var(--v) * .1); font-weight: 700; text-transform: capitalize; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cpage { position: relative; overflow: hidden; background: #fff; }
  .cpage .cturn { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .clabel .ct { display: flex; justify-content: space-between; align-items: baseline; gap: calc(var(--v) * .08); font-size: calc(var(--v) * .085); font-weight: 700; line-height: 1.1; }
  .clabel .ct span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .clabel .ct em { font-style: normal; font-weight: 800; background: #000; color: #fff; padding: 0 calc(var(--v) * .03); }
  .clabel .ct b { flex: none; font-size: calc(var(--v) * .17); font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .clabel .ct i { font-style: normal; font-size: calc(var(--v) * .09); font-weight: 700; }
  .clabel .cn { font-size: calc(var(--v) * .112); font-weight: 800; line-height: 1.1; margin-top: calc(var(--v) * .02); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
  .clabel .cb { flex: 1; min-height: 0; padding: calc(var(--v) * .04) calc(var(--v) * .1) calc(var(--v) * .03); }
  .clabel .cb svg { width: 100%; height: 100%; display: block; }
  .clabel .cf { display: flex; justify-content: space-between; gap: calc(var(--v) * .06); font-size: calc(var(--v) * .082); font-weight: 700; white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
  .plabel footer { margin-top: auto; display: flex; justify-content: space-between; font-size: calc(var(--u) * .1); font-weight: 600; padding-top: calc(var(--u) * .06); }
`;

/** Print label pages through a hidden frame (no pop-up for the browser to block).
 *  `size` is the CSS page size. `fixed: false` leaves the page size to the paper chosen in the print window: a label
 *  printer whose paper is wider than it is tall gets a declared wide page turned a quarter by the print system (seen at
 *  the station 2026-11-14: a 2 x 1 label printed 1 in wide and 2 in long), and does not when the page takes the paper's size. */
function printPages(pages, cls, size, title, fixed = true) {
  return new Promise((resolve) => {
    const styles = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map((n) => n.outerHTML).join('');
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${styles}
      <style>@page { ${fixed ? `size: ${size}; ` : ''}margin: 0; } html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; min-height: 0 !important; height: auto !important; }
      .${cls} { page-break-after: always; break-after: page; page-break-inside: avoid; break-inside: avoid; } .${cls}:last-child { page-break-after: auto; break-after: auto; }
      ${LABEL_CSS}</style></head><body>${pages.join('')}</body></html>`;
    document.getElementById('wms-print')?.remove();
    const f = document.createElement('iframe');
    f.id = 'wms-print'; f.setAttribute('aria-hidden', 'true'); f.dataset.size = size;
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
/** 4x6: one page per pallet. */
export const printPalletLabels = (pallets, brandOf) => printPages(pallets.map((p) => labelHtml(p, brandOf(p))), 'plabel', '4in 6in', 'Pallet labels');
/** One page per carton at the size and turn of the roll in the printer, for every carton of the pallets given (or only the cartons listed). */
export const printCartonLabels = (pallets, brandOf, only, size = getCartonSize(), turn = getCartonTurn()) => {
  const z = parseSize(size); const side = turn === 'left' || turn === 'right';
  return printPages(pallets.flatMap((p) => cartonCodes(p).filter((c) => !only || only.includes(c.seq)).map((c) => cartonPageHtml(p, brandOf(p), c, z.key, turn))), 'cpage', side ? `${z.h}in ${z.w}in` : `${z.w}in ${z.h}in`, 'Carton labels', false);
};
/** One page per position: 4x6 (declared), or the small roll at the station (page size left to the printer paper, same turn as carton labels). */
export const printLocationLabels = (locs, size = '4x6', turn = getCartonTurn()) => {
  if (parseSize(size).key === '4x6') return printPages(locs.map(locationLabelHtml), 'plabel', '4in 6in', 'Position labels');
  const z = parseSize(size); const side = turn === 'left' || turn === 'right';
  return printPages(locs.map((l) => turnedPage(smallLocationHtml(l, z.key), z.key, turn)), 'cpage', side ? `${z.h}in ${z.w}in` : `${z.w}in ${z.h}in`, 'Position labels', false);
};

// the on-screen preview uses the same rules as the printed label
if (typeof document !== 'undefined' && !document.getElementById('wms-label-css')) {
  const st = document.createElement('style'); st.id = 'wms-label-css'; st.textContent = LABEL_CSS; document.head.appendChild(st);
}
