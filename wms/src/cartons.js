// Carton rows as the database holds them: reading them safely and checking them before a label is printed from them.
// No DOM and no Supabase import here (the client is passed in), so this file runs under `node --test` with no backend.
//
// Why it exists: a carton label must carry the carton's own code and product. Both live in wms_cartons. When that read
// failed, the screens used to carry on with an empty list and the label code made the codes up from the pallet's carton
// count, which drops the product on a mixed pallet and gives the wrong codes when a pallet has an NCC line.

export const PAGE = 500;   // rows per read; under the API's row cap, so a short page always means the end

const digits = (psku) => String(psku || '').replace(/\D/g, '');
/** The code the database gives carton `seq` of a pallet that has `rows` carton rows in all (wms_receive: v_w, v_seq). */
export const expectedCode = (psku, seq, rows) => `C${digits(psku)}${String(seq).padStart(Math.max(2, String(rows).length), '0')}`;

/** Every carton row of the pallets given, read in pages. Throws when a page fails or comes back as anything but a list:
 *  the caller must never treat a failed read as "no cartons". */
export async function fetchCartons(client, palletIds, page = PAGE) {
  const ids = [...new Set((palletIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const out = [];
  for (let from = 0, guard = 0; ; from += page) {
    if (++guard > 200) throw new Error('The carton list did not end. Nothing was printed.');
    const { data, error } = await client.from('wms_cartons').select('*').in('pallet_id', ids).order('pallet_id').order('seq').range(from, from + page - 1);
    if (error) throw new Error(error.message || 'The carton list could not be read.');
    if (!Array.isArray(data)) throw new Error('The carton list could not be read.');
    out.push(...data);
    if (data.length < page) return out;
  }
}

/** What is wrong with a pallet's carton rows, in plain words; an empty list means the labels can be printed from them.
 *  `rows` are that pallet's rows only. An NCC product has one marker row (cle) that is never labelled or counted. */
export function checkCartons(pallet, rows) {
  const bad = []; const list = rows || []; const counted = list.filter((c) => !c.cle);
  if (list.some((c) => c.pallet_id !== pallet.id)) bad.push('a carton that belongs to another pallet came back');
  const want = pallet.cartons ?? 0;
  if (counted.length !== want) bad.push(`${want} carton${want === 1 ? '' : 's'} on the pallet, ${counted.length} on file`);
  if (pallet.cle && !list.some((c) => c.cle)) bad.push('an NCC pallet with no NCC line on file');
  const seqs = list.map((c) => c.seq).sort((a, b) => a - b);
  if (seqs.some((s, i) => s !== i + 1)) bad.push('carton numbers are not 1 to ' + list.length);
  if (new Set(list.map((c) => c.code)).size !== list.length) bad.push('two cartons share a barcode');
  if (list.some((c) => !c.code || c.code !== expectedCode(pallet.psku, c.seq, list.length))) bad.push('a carton barcode does not match its pallet and number');
  if (pallet.mixed && list.some((c) => !String(c.item_name || '').trim())) bad.push('a carton on a mixed pallet has no product');
  return bad;
}

/** Pallets with their checked carton rows attached. A pallet whose rows pass is marked `_cartonsOk`; the label code
 *  prints carton labels for marked pallets only. */
export function attachCartons(pallets, rows) {
  const problems = [];
  const out = (pallets || []).map((p) => {
    const mine = (rows || []).filter((c) => c.pallet_id === p.id).sort((a, b) => a.seq - b.seq);
    const bad = checkCartons(p, mine);
    if (bad.length) problems.push({ psku: p.psku, problems: bad });
    return { ...p, _cartons: mine, _cartonsOk: bad.length === 0 };
  });
  if ((rows || []).some((c) => !(pallets || []).some((p) => p.id === c.pallet_id))) problems.push({ psku: null, problems: ['cartons for a pallet that was not asked for came back'] });
  return { pallets: out, problems, ok: problems.length === 0 };
}

/** May carton labels be printed for this pallet? Only from checked database rows, or from the form's own draft when the
 *  labels are printed before Receive (the pallet number is held by then; Receive compares the two afterwards). */
export const canPrintCartons = (p) => !!p && Array.isArray(p._cartons) && (p._cartonsOk === true || p._draft === true);

/** Do two sets of carton rows print the same labels (same code, product and FBA mark on every labelled carton)? */
export function sameLabels(a, b) {
  const key = (rows) => (rows || []).filter((c) => !c.cle).map((c) => [c.seq, c.code, String(c.item_name || ''), c.item_no ?? null, !!c.fba].join('\u0001')).sort().join('\u0002');
  return key(a) === key(b);
}

/** The pallets a Receive made, looked up by the key it was sent with: settles "did it go through?" without sending it again. */
export async function findReceipt(client, key) {
  if (!key) return [];
  const { data, error } = await client.from('wms_pallets').select('*').eq('batch_key', key).order('batch_pos');
  if (error) throw new Error(error.message || 'The pallets could not be read.');
  if (!Array.isArray(data)) throw new Error('The pallets could not be read.');
  return data;
}
