// Sending label pages to the browser's print window, through a hidden frame (no pop-up for the browser to block).
// Kept apart from label.js (which needs the Supabase client through lib.js) so it can be tested with a fake document.
//
// What the answer means: true = the print window was asked for and the browser did not refuse. It does NOT mean a label
// came out of the printer: the browser cannot tell whether the operator pressed Cancel, the printer was off or the roll
// ran out. Only the person at the station can confirm that. false = nothing was sent to the print window.
export const PRINT_TIMEOUT_MS = 15000;

/** `size` is the CSS page size. `fixed: false` leaves the page size to the paper chosen in the print window: a label
 *  printer whose paper is wider than it is tall gets a declared wide page turned a quarter by the print system (seen at
 *  the station 2026-11-14: a 2 x 1 label printed 1 in wide and 2 in long), and does not when the page takes the paper's size. */
export function printPages(pages, cls, size, title, fixed = true, css = '', doc = globalThis.document, timeoutMs = PRINT_TIMEOUT_MS) {
  if (!doc || !Array.isArray(pages) || pages.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false; const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const styles = [...doc.querySelectorAll('style, link[rel="stylesheet"]')].map((n) => n.outerHTML).join('');
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${styles}
        <style>@page { ${fixed ? `size: ${size}; ` : ''}margin: 0; } html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; min-height: 0 !important; height: auto !important; }
        .${cls} { page-break-after: always; break-after: page; page-break-inside: avoid; break-inside: avoid; } .${cls}:last-child { page-break-after: auto; break-after: auto; }
        ${css}</style></head><body>${pages.join('')}</body></html>`;
      doc.getElementById('wms-print')?.remove();
      const f = doc.createElement('iframe');
      f.id = 'wms-print'; f.setAttribute('aria-hidden', 'true'); f.dataset.size = size;
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      const timer = setTimeout(() => finish(false), timeoutMs);   // the frame never loaded: nothing was sent
      f.onload = () => {
        const w = f.contentWindow;
        const go = () => {
          clearTimeout(timer);
          if (!w || typeof w.print !== 'function') return finish(false);
          try { w.focus?.(); w.print(); finish(true); } catch { finish(false); }   // printing blocked or refused
        };
        const ready = w?.document?.fonts?.ready;
        (ready && typeof ready.then === 'function' ? ready : Promise.resolve()).then(() => setTimeout(go, 60), go);
      };
      doc.body.appendChild(f);
      f.srcdoc = html;
    } catch { finish(false); }
  });
}
