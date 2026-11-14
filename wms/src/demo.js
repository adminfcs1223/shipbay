// Demo Brand's sample orders, dated from today. They are sent through POST /api/orders like any brand's orders, so the
// demo exercises the real connector. The mix is deliberate: one product in three orders (one row on the picklist), an
// order with a note, a product with no location, a line with not enough stock, one late order and two for tomorrow.
const P = {
  'DEMO-TEE-BLK-M': ['Logo Tee, Black, M', '0F1B2A'], 'DEMO-TEE-WHT-M': ['Logo Tee, White, M', 'C9C5BC'], 'DEMO-HOOD-GRY-L': ['Pullover Hoodie, Grey, L', '6B7280'],
  'DEMO-CAP-NVY': ['Dad Cap, Navy', '1E3A8A'], 'DEMO-SOCK-3PK': ['Crew Socks, 3 Pack', 'B45309'], 'DEMO-MUG-11': ['Ceramic Mug, 11 oz', '0F766E'],
  'DEMO-TOTE-NAT': ['Canvas Tote, Natural', 'A16207'], 'DEMO-STKR-PK': ['Sticker Pack', 'BE123C'], 'DEMO-BTL-20': ['Steel Bottle, 20 oz', '334155'],
  'DEMO-NOTE-A5': ['Notebook, A5', '7C3AED'], 'DEMO-PIN-SET': ['Enamel Pin Set', 'FF6B15'], 'DEMO-POSTER-18': ['Poster, 18 × 24', '15803D'],
};
const line = (sku, quantity) => ({ sku, name: P[sku][0], image_url: `https://placehold.co/400x400/${P[sku][1]}/FFFFFF/png?text=${encodeURIComponent(P[sku][0].split(',')[0]).replace(/%20/g, '+')}`, quantity });
const shift = (iso, days) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

export function demoOrders(today) {
  const o = (n, ship_by, notes, lines) => ({ order_number: `DEMO-${n}`, client: 'DEMO', ship_by, notes, lines });
  return [
    o(1001, today, null, [line('DEMO-TEE-BLK-M', 2), line('DEMO-CAP-NVY', 1)]),
    o(1002, today, 'Fragile, bubble wrap the mugs', [line('DEMO-TEE-BLK-M', 1), line('DEMO-MUG-11', 2)]),
    o(1003, today, null, [line('DEMO-TEE-BLK-M', 3), line('DEMO-SOCK-3PK', 2)]),
    o(1004, today, null, [line('DEMO-POSTER-18', 1), line('DEMO-STKR-PK', 5)]),      // the poster has no location
    o(1005, today, null, [line('DEMO-BTL-20', 4), line('DEMO-TOTE-NAT', 1)]),         // 4 bottles wanted, 2 on hand
    o(1006, shift(today, -1), null, [line('DEMO-HOOD-GRY-L', 1), line('DEMO-PIN-SET', 2)]),   // late
    o(1007, shift(today, 1), null, [line('DEMO-NOTE-A5', 3), line('DEMO-TEE-WHT-M', 1)]),
    o(1008, shift(today, 1), null, [line('DEMO-CAP-NVY', 2), line('DEMO-STKR-PK', 10)]),
  ];
}
