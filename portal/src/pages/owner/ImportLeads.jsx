// Admin → Import leads. Drop the Storeleads (or Apollo) CSV; every row is split by what it carries:
//   email + phone  → CCE  (cold_call, in the call queue — the rep calls, then emails from their own address)
//   email only     → CBE  (cold_email — pushed to the Smartlead campaign)
//   no email       → dropped (phone-only rows are counted so you can see what the cut lost)
// The list ID (the Storeleads filter name) travels on every row as filter_id. Duplicates by domain/email are skipped, so re-importing is safe.
import { useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib';
import { ownerFn, parseCsv, guessColumns, num } from './util';

const FIELDS = [['company', 'Company'], ['domain', 'Domain / website'], ['contact_name', 'Contact name'], ['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['title', 'Title'], ['city', 'City'], ['state', 'State'], ['est_sales_usd', 'Est. sales $/mo'], ['orders_est', 'Orders / mo (est.)'], ['first_line', 'First line (for E1)'], ['products', 'Products'], ['categories', 'Categories'], ['notes', 'Notes']];
const cleanDomain = (d) => (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;
const cleanPhone = (p) => { const d = String(p || '').replace(/[^0-9+]/g, ''); return d.replace(/\D/g, '').length >= 10 ? d : null; };
const cleanEmail = (e) => { const m = String(e || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/); return m ? m[0] : null; };
/** Storeleads / Apollo header guesses on top of the generic ones */
function guess(headers) {
  const g = guessColumns(headers);
  const H = headers.map((h) => h.toLowerCase());
  const find = (...cands) => { for (const c of cands) { const i = H.findIndex((h) => h === c); if (i >= 0) return headers[i]; } for (const c of cands) { const i = H.findIndex((h) => h.includes(c)); if (i >= 0) return headers[i]; } return ''; };
  return { ...g,
    company: find('merchant name', 'merchant', 'company name', 'company', 'brand', 'store name', 'account name') || g.company,
    domain: find('domain', 'website', 'company website', 'url') || g.domain,
    first_name: find('first name', 'firstname', 'first_name'),
    last_name: find('last name', 'lastname', 'last_name'),
    contact_name: find('contact name', 'full name', 'contact') || (find('first name', 'firstname', 'first_name') ? '' : g.contact_name),
    email: find('email', 'emails', 'work email', 'contact email') || g.email,
    phone: find('phone', 'phones', 'mobile phone', 'corporate phone', 'work direct phone', 'phone number', 'telephone') || g.phone,
    est_sales_usd: find('estimated monthly sales', 'estimated sales', 'est. sales', 'est_sales', 'monthly sales', 'sales', 'revenue') || g.est_sales_usd,
    orders_est: find('orders_est', 'orders / mo', 'orders per month', 'orders'),
    first_line: find('first_line', 'first line', 'opener', 'personalization', 'icebreaker'),
    products: find('product count', 'products', 'product_count'),
    categories: find('categories', 'category'),
    city: find('city') || g.city, state: find('state', 'region', 'province') || g.state, title: find('title', 'job title', 'role') || g.title,
  };
}
const ordersFromSales = (usd) => { if (!usd) return null; const o = Math.round(usd / 60 / 100) * 100; return o ? `~${o.toLocaleString()}` : null; };

export default function ImportLeads({ status, modal = false, onClose, reload, say: saySay, defaultList = '' }) {
  const [parsed, setParsed] = useState(null); const [map, setMap] = useState({}); const [list, setList] = useState(defaultList);
  const campaigns = (status?.smartlead_campaigns || '4039101').split(',').map((s) => s.trim()).filter(Boolean);
  const [campaign, setCampaign] = useState(campaigns[0] || ''); const [push, setPush] = useState(true);
  const [prog, setProg] = useState(null); const [done, setDone] = useState(null); const [msg, setMsg] = useState(null); const fileRef = useRef();
  const say = (r, ok) => { if (r?.error) setMsg({ kind: 'err', text: r.error }); else setMsg({ kind: 'ok', text: ok }); saySay?.(r, ok); };

  const onFile = async (file) => { const text = await file.text(); const p = parseCsv(text); setParsed(p); setMap(guess(p.headers)); setDone(null); if (!list) setList(file.name.replace(/\.csv$/i, '').replace(/[_ ]+/g, '-')); };

  // every CSV row → a portal row with its channel decided
  const rows = useMemo(() => {
    if (!parsed) return [];
    const g = (r, k) => (map[k] ? String(r[map[k]] ?? '').trim() : '');
    return parsed.rows.map((r) => {
      const email = cleanEmail(g(r, 'email')); const phone = cleanPhone(g(r, 'phone'));
      const sales = g(r, 'est_sales_usd').replace(/[^0-9.]/g, ''); const est = sales ? Math.round(Number(sales)) : null;
      const name = g(r, 'contact_name') || [g(r, 'first_name'), g(r, 'last_name')].filter(Boolean).join(' ');
      const channel = email && phone ? 'CCE' : email ? 'CBE' : phone ? 'phone-only' : 'nothing';
      return { channel, company: g(r, 'company') || null, domain: cleanDomain(g(r, 'domain')), contact_name: name || null, email, phone, title: g(r, 'title') || null, city: g(r, 'city') || null, state: g(r, 'state') || null,
        est_sales_usd: est, orders_est: g(r, 'orders_est') || ordersFromSales(est), first_line: g(r, 'first_line') || null, products: g(r, 'products') ? Number(g(r, 'products').replace(/[^0-9]/g, '')) || null : null, categories: g(r, 'categories') || null, notes: g(r, 'notes') || null };
    }).filter((r) => r.company || r.domain || r.email);
  }, [parsed, map]);
  const counts = useMemo(() => rows.reduce((a, r) => ({ ...a, [r.channel]: (a[r.channel] || 0) + 1 }), {}), [rows]);
  const noLine = rows.filter((r) => r.channel === 'CBE' && !r.first_line).length;

  const run = async () => {
    const keep = rows.filter((r) => r.channel === 'CCE' || r.channel === 'CBE');
    const toRow = ({ channel, ...r }) => ({ ...r, source: channel === 'CCE' ? 'cold_call' : 'cold_email', filter_id: list || null, in_calls: channel === 'CCE', in_email: false, tags: [channel.toLowerCase(), ...(list ? [list] : [])] });
    let ok = 0, dup = 0, bad = 0; const cbeIds = []; const cceIds = [];
    const note = (ins) => { for (const x of ins || []) { ok++; (x.source === 'cold_email' ? cbeIds : cceIds).push(x.id); } };
    for (let i = 0; i < keep.length; i += 200) {
      const chunk = keep.slice(i, i + 200).map(toRow);
      const { data: ins, error } = await supabase.from('sales_leads').insert(chunk).select('id, source');
      if (!error) note(ins);
      else for (const r of chunk) { const { data: one, error: e2 } = await supabase.from('sales_leads').insert(r).select('id, source'); if (!e2) note(one); else if (/duplicate/i.test(e2.message)) dup++; else bad++; }
      setProg({ done: Math.min(i + 200, keep.length), total: keep.length });
    }
    let sl = null;
    if (push && campaign && cbeIds.length) { sl = await ownerFn({ action: 'smartlead_add_leads', lead_ids: cbeIds, campaign_id: campaign }); if (sl.error) say(sl); }
    const r = { ok, dup, bad, cce: cceIds.length, cbe: cbeIds.length, dropped: (counts['phone-only'] || 0) + (counts.nothing || 0), sl };
    setDone(r); setProg(null); reload?.();
    say(null, `${ok} leads in — ${r.cce} to the call queue, ${r.cbe} cold email${sl && !sl.error ? ` (${sl.added} pushed to Smartlead${sl.dup ? `, ${sl.dup} already there` : ''}${sl.blocked ? `, ${sl.blocked} blocked` : ''})` : ''}${dup ? ` · ${dup} already in the system` : ''}${bad ? ` · ${bad} failed` : ''}.`);
  };

  const body = (
    <>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      {!parsed ? (
        <div className="drop" onClick={() => fileRef.current.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}>
          <b>Drop the Storeleads CSV here or click to choose</b><span>First row must be the column names. Apollo exports work too.</span>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
        </div>
      ) : done ? (
        <div className="card">
          <div className="glance imp">
            <div><small>In the call queue (CCE)</small><b>{num(done.cce)}</b></div>
            <div><small>Cold email (CBE)</small><b>{num(done.cbe)}</b></div>
            <div><small>Pushed to Smartlead</small><b>{done.sl && !done.sl.error ? num(done.sl.added) : push ? '—' : 'not pushed'}</b></div>
            <div><small>Already in the system</small><b>{num(done.dup)}</b></div>
            <div><small>Dropped (no email)</small><b>{num(done.dropped)}</b></div>
          </div>
          <div className="row" style={{ marginTop: 14 }}><button className="btn-sm" onClick={() => { setParsed(null); setDone(null); }}>Import another file</button><div className="spacer" />{modal && <button className="btn-sm primary" onClick={onClose}>Done</button>}</div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="glance imp">
              <div><small>Rows</small><b>{num(rows.length)}</b></div>
              <div><small>CCE · email + phone</small><b>{num(counts.CCE || 0)}</b></div>
              <div><small>CBE · email only</small><b>{num(counts.CBE || 0)}</b></div>
              <div><small>Phone only · dropped</small><b>{num(counts['phone-only'] || 0)}</b></div>
              <div><small>Neither · dropped</small><b>{num(counts.nothing || 0)}</b></div>
            </div>
            <div className="addgrid lead" style={{ marginTop: 14 }}>
              <label>List ID<input value={list} onChange={(e) => setList(e.target.value)} placeholder="SL-A1-selfship-NJmetro-v2" /></label>
              <label>Smartlead campaign for CBE<select value={campaign} onChange={(e) => setCampaign(e.target.value)}>{campaigns.map((c) => <option key={c} value={c}>{c}</option>)}<option value="">— don't push —</option></select></label>
              <label className="chk"><input type="checkbox" checked={push && !!campaign} disabled={!campaign} onChange={(e) => setPush(e.target.checked)} /> push CBE rows to Smartlead now</label>
            </div>
            {noLine > 0 && push && campaign ? <p className="note warn">{num(noLine)} CBE {noLine === 1 ? 'row has' : 'rows have'} no first line — E1 would open "Hi {'{first}'} —" and nothing. Map a "first line" column or push later from Contacts.</p> : null}
          </div>
          <div className="card">
            <div className="cardhead"><h3>Columns</h3><span className="sm">Guessed from the headers — fix anything that's wrong before importing.</span></div>
            <div className="mapgrid">{FIELDS.map(([k, l]) => <label key={k}><span>{l}</span><select value={map[k] || ''} onChange={(e) => setMap({ ...map, [k]: e.target.value })}><option value="">— skip —</option>{parsed.headers.map((h) => <option key={h}>{h}</option>)}</select></label>)}</div>
          </div>
          <div className="card">
            <div className="cardhead"><h3>First rows</h3><span className="sm">{num(rows.length)} rows · how each one is routed</span></div>
            <div className="tablewrap"><table className="ordertable fin"><thead><tr><th>Route</th><th>Company</th><th>Domain</th><th>Contact</th><th>Email</th><th>Phone</th><th className="n">Est. $/mo</th><th>Orders</th></tr></thead>
              <tbody>{rows.slice(0, 12).map((r, i) => <tr key={i} className={r.channel === 'CCE' || r.channel === 'CBE' ? '' : 'muted'}><td><span className={`pill ${r.channel === 'CCE' ? 'connected' : r.channel === 'CBE' ? 'on' : ''}`}>{r.channel === 'phone-only' ? 'dropped · phone only' : r.channel === 'nothing' ? 'dropped · no contact' : r.channel}</span></td><td><b>{r.company || '—'}</b></td><td className="sm">{r.domain || '—'}</td><td>{r.contact_name || '—'}</td><td className="sm">{r.email || '—'}</td><td className="sm">{r.phone || '—'}</td><td className="n">{r.est_sales_usd ? num(r.est_sales_usd) : '—'}</td><td className="sm">{r.orders_est || '—'}</td></tr>)}</tbody></table></div>
          </div>
          {prog && <div className="bar"><i style={{ width: `${(prog.done / prog.total) * 100}%` }} /></div>}
          <div className="row"><button className="btn-sm" onClick={() => setParsed(null)}>Different file</button><div className="spacer" />{modal && <button className="btn-sm" onClick={onClose}>Cancel</button>}<button className="btn-sm primary" disabled={!!prog || !((counts.CCE || 0) + (counts.CBE || 0))} onClick={run}>{prog ? `${prog.done} / ${prog.total}…` : `Import ${num((counts.CCE || 0) + (counts.CBE || 0))} leads`}</button></div>
        </>
      )}
    </>
  );
  if (modal) return <div className="overlay" onClick={onClose}><div className="modal wide importmodal" onClick={(e) => e.stopPropagation()}><h3>Import leads</h3>{body}</div></div>;
  return (
    <div className="importpage">
      <div className="pagehead"><div><h1>Import leads<span className="dot">.</span></h1></div>
        <div className="glance"><div><small>Call queue</small><b>CCE</b></div><div><small>Cold email</small><b>CBE</b></div></div></div>
      {body}
    </div>
  );
}
