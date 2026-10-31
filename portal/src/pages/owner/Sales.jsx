// Sales — the CRM. Dashboard (goals, unread replies, funnel, channel leaderboard), Pipeline board, Contacts,
// Conversations (reply inbox), Calls (dialer), Calendar (Calendly + Google Calendar). Any contact opens in a
// slide-in panel where everything can be done: reply, log a call, change stage, notes, hand-off, do-not-contact.
// `rep` mode scopes everything to the signed-in salesperson (RLS enforces it; the UI just hides owner controls).
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib';
import { useTeamData, teamStats, TeamTable, useGoals, goalsFor, GoalBars, bonusFor, bonusProgress, BonusBar, BONUS_METRICS } from './Team';
import { ownerFn, fetchAll, money, pct, num, ago, mmss, hhmm, STAGES, stageLabel, stageClass, parseCsv, guessColumns } from './util';
import { compute, phases } from '../../quote';
import Quotes from '../Quotes';
import Onboarding from '../Onboarding';

/** the quotes that belong to an account (by the account row, or its client org) — best first */
const QRANK = { accepted: 0, sent: 1, draft: 2, declined: 3, superseded: 4 };
export const quotesFor = (lead, quotes) => (quotes || []).filter((q) => q.lead_id === lead?.id || (lead?.org_id && q.org_id === lead.org_id)).sort((a, b) => (a.internal_only - b.internal_only) || (QRANK[a.status] ?? 9) - (QRANK[b.status] ?? 9) || (b.updated_at || '').localeCompare(a.updated_at || ''));
/** what a quote bills per month in services — the first phase after any waived-fees months (what a normal month looks like) */
export const quoteMonthly = (q) => { try { const ph = phases(q); const p = ph.find((x) => x.key !== 'waived') || ph[0]; const m = compute(q, undefined, p?.key || 'standard'); return m.oneTime ? null : Math.round(m.services || 0); } catch { return null; } };
/** expected services $/month for an account: its quote if it has one, else the hand-typed deal value */
export const expectedMonthly = (lead, quotes) => { const q = quotesFor(lead, quotes).find((x) => !x.internal_only && x.status !== 'declined' && x.status !== 'superseded'); const v = q ? quoteMonthly(q) : null; return v != null ? { value: v, from: q } : { value: lead?.deal_value ? Number(lead.deal_value) : null, from: null }; };

const SUB = [['overview', 'Dashboard'], ['pipeline', 'Pipeline'], ['master', 'Contacts'], ['email', 'Conversations'], ['calls', 'Calls'], ['calendar', 'Calendar'], ['quotes', 'Quotes'], ['onboarding', 'Onboarding'], ['bonus', 'Bonus'], ['settings', 'Settings']];
export const LIST_NAMES = { A1: 'Self-ship brands · NJ metro', A2: 'Already on a 3PL · NJ metro', A3: 'Self-ship brands · Northeast', A4: 'Shopify Plus upgrades', B1: 'Founder-run · NJ metro', C1: 'Amazon sellers · Northeast', C2: 'Q4 overflow', X0: 'Control group' };
export const listName = (code) => (code && LIST_NAMES[code] ? `${code} · ${LIST_NAMES[code]}` : code || '—');
export const srcLabel = (sources, k) => sources.find((s) => s.key === k)?.label || k;
export const srcLabelPlain = (k) => ({ cold_call: 'Cold call list', cold_email: 'Cold email', fulfill_com: 'Fulfill.com', fulfilment_com: 'fulfilment.com', agency: 'Agency', referral: 'Referral', inbound: 'Inbound', linkedin: 'LinkedIn' }[k] || 'Other');
const lists = (leads) => [...new Set(leads.map((l) => l.filter_id).filter(Boolean))].sort();
/** Gmail compose link */
const gmailUrl = (email, subject, body) => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email || '')}&su=${encodeURIComponent(subject || '')}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
/** the team's Calendly booking link (fin_settings.booking_link) */
export function useBookingLink() { const [u, setU] = useState(''); useEffect(() => { supabase.from('fin_settings').select('value').eq('key', 'booking_link').maybeSingle().then(({ data }) => setU(data?.value?.url || '')); }, []); return u; }
export const DEFAULT_TPL = { reply_subject: 'Quick one, {first}', reply_body: 'Hi {first},\n\n\n\nEasiest is to grab 15 minutes here: {booking}\n\n{me}', signature: '' };
export const TPL_VARS = [['{first}', "prospect's first name"], ['{company}', 'their brand'], ['{booking}', 'your booking link'], ['{me}', 'your first name']];
/** fill a template with a lead's details */
export const fillTpl = (t, lead, me, booking) => (t || '').replace(/\{first\}/g, firstName(lead) || 'there').replace(/\{company\}/g, lead?.company || lead?.domain || 'your brand').replace(/\{booking\}/g, booking || '').replace(/\{me\}/g, (me?.full_name || '').split(' ')[0] || '');
/** everything needed to open a pre-filled Gmail reply: the rep's own template (Sales → Settings) + the booking link */
export function useReplyKit(me) {
  const booking = useBookingLink(); const [tpl, setTpl] = useState(null);
  useEffect(() => { if (!me?.id) return; supabase.from('sales_rep_settings').select('*').eq('user_id', me.id).maybeSingle().then(({ data }) => setTpl(data || {})); }, [me?.id]);
  const t = { ...DEFAULT_TPL, ...Object.fromEntries(Object.entries(tpl || {}).filter(([, v]) => v)) };
  const link = (email, replyToSubject, lead) => {
    const body = fillTpl(t.reply_body, lead, me, booking) + (t.signature ? `\n${fillTpl(t.signature, lead, me, booking)}` : '');
    const su = replyToSubject ? (/^re:/i.test(replyToSubject) ? replyToSubject : `Re: ${replyToSubject}`) : (fillTpl(t.reply_subject, lead, me, booking) || 'Following up');
    return gmailUrl(email, su, body);
  };
  return { booking, tpl: t, link };
}
/** Won: the client account is created or linked (one profile everywhere), the quote's number becomes the deal value */
export async function winLead(lead, quotes, say) {
  const exp = expectedMonthly(lead, quotes);
  let value = exp.value;
  if (!exp.from) { const v = window.prompt(`${lead.company || lead.email} is won. Expected services $ / month? (a quote fills this in automatically)`, lead.deal_value || ''); if (v === null) return false; value = Number(v) || null; }
  const { data, error } = await supabase.rpc('win_lead', { p_lead_id: lead.id, p_deal_value: value });
  if (error) { say({ error: error.message }); return false; }
  say(null, `${lead.company || lead.email} is a client${exp.from ? ` — ${money(value)}/mo from ${exp.from.label}` : ''}. Onboarding is ready for them.`);
  return data;
}
/** is this company / email / website already in the system? */
export async function findExisting({ email, domain, company }) { const { data } = await supabase.rpc('find_lead', { p_email: email || '', p_domain: domain || '', p_company: company || '' }); return data || null; }
const firstName = (l) => (l?.contact_name || '').split(' ')[0] || '';

export default function Sales({ me, status, refreshStatus, rep = false, nav }) {
  const [sub, setSub] = useState(() => (window.location.hash.startsWith('#sales=gmail') ? 'settings' : 'overview'));
  const [leads, setLeads] = useState(null); const [sources, setSources] = useState([]); const [sends, setSends] = useState([]);
  const [msg, setMsg] = useState(() => {       // Gmail connect round-trip lands with #sales=gmail|ok|msg
    const h = window.location.hash; if (!h.startsWith('#sales=gmail')) return null;
    const [, ok, m] = h.slice(7).split('|'); history.replaceState(null, '', window.location.pathname);
    return { kind: ok === 'ok' ? 'ok' : 'err', text: decodeURIComponent(m || '') };
  }); const [panel, setPanel] = useState(null); const [focus, setFocus] = useState(null); const [q, setQ] = useState(''); const [people, setPeople] = useState([]);
  useEffect(() => { supabase.from('profiles').select('id, full_name, email, is_sales, is_owner').like('role', 'shipbay%').eq('active', true).then(({ data }) => setPeople((data || []).filter((p) => p.is_sales || p.is_owner))); }, []);
  const [mail, setMail] = useState([]); const [mailAccts, setMailAccts] = useState([]); const [quotes, setQuotes] = useState([]); const [orgs, setOrgs] = useState([]);
  const load = async () => {
    const [qs, os] = await Promise.all([supabase.from('quotes').select('id, company, label, status, internal_only, org_id, lead_id, model, inputs, rates, costs, services, scenarios, updated_at'), supabase.from('orgs').select('id, name, slug, status, contact_email, sales_rep_id')]);
    setQuotes(qs.data || []); setOrgs(os.data || []);
    const [l, s, e, g, ga] = await Promise.all([fetchAll('sales_leads', '*', (qq) => qq.order('created_at', { ascending: false })), fetchAll('sales_sources'), fetchAll('sales_email_sends', '*', (qq) => qq.order('sent_at', { ascending: false })),
      fetchAll('gmail_messages', 'id, user_id, gmail_id, thread_id, message_id_hdr, from_email, from_name, to_email, subject, snippet, at, is_sent, lead_id, read_at, hidden', (qq) => qq.order('at', { ascending: false })), supabase.from('v_gmail_accounts').select('*')]);
    setLeads(l); setSources(s); setSends(e); setMail(g); setMailAccts(ga.data || []);
  };
  useEffect(() => { load(); }, []);
  const say = (r, ok) => { if (r?.error) setMsg({ kind: 'err', text: r.error }); else if (ok) setMsg({ kind: 'ok', text: ok }); };
  const [subParams, setSubParams] = useState({});
  const go = (tab, focusId = null) => { setFocus(focusId); setSub(tab); };
  /** jump to a subtab with parameters (open a quote, start a quote for an account, open a brand's onboarding) */
  const goTab = (tab, p = {}) => { setSubParams({ ...p, _t: Date.now() }); setSub(tab); };
  const openLead = (idOrLead) => setPanel(typeof idOrLead === 'string' ? idOrLead : idOrLead?.id || null);
  // a rep's Dashboard / Pipeline / Contacts / Conversations are their own leads; Calls also sees the untouched pool
  const mine = useMemo(() => (rep ? (leads || []).filter((l) => l.assigned_to === me.id) : leads || []), [leads, rep, me.id]);
  const mineIds = useMemo(() => new Set(mine.map((l) => l.id)), [mine]);
  const mySends = useMemo(() => (rep ? sends.filter((s) => mineIds.has(s.lead_id)) : sends), [sends, mineIds, rep]);
  const counts = useMemo(() => { const c = { total: 0 }; for (const l of mine) { c.total++; c[l.stage] = (c[l.stage] || 0) + 1; } return c; }, [mine]);
  const stopped = useMemo(() => new Set((leads || []).filter((l) => l.stage === 'dnc').map((l) => l.id)), [leads]);
  const unread = mySends.filter((s) => s.replied && !s.read_at && !s.bounced && !s.mailbox && !stopped.has(s.lead_id)).length + mail.filter((m) => m.user_id === me.id && !m.is_sent && !m.read_at && !m.hidden).length;
  const hits = useMemo(() => { const t = q.trim().toLowerCase(); if (t.length < 2) return []; return (leads || []).filter((l) => [l.company, l.domain, l.contact_name, l.email, l.phone, l.city].filter(Boolean).some((v) => v.toLowerCase().includes(t))).slice(0, 8); }, [q, leads]);
  const panelLead = panel ? (leads || []).find((l) => l.id === panel) : null;
  const ctx = { me, rep, sources, people, reload: load, say, openLead, go, goTab, nav, quotes, orgs };

  if (leads === null) return <div className="card"><div className="empty">Loading…</div></div>;
  return (
    <>
      {msg && <div className={`msg ${msg.kind} flash`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
      <div className="card ownertabs withsearch">
        <div className="tabs">{SUB.map(([k, l]) => <button key={k} className={sub === k ? 'on' : ''} onClick={() => go(k)}>{l}{k === 'email' && unread ? <i>{unread}</i> : null}</button>)}</div>
        <div className="gsearch">
          <input className="search" placeholder="Search contacts…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { openLead(hits[0]); setQ(''); } if (e.key === 'Escape') setQ(''); }} />
          {hits.length > 0 && <div className="hits">{hits.map((l) => <button key={l.id} onClick={() => { openLead(l); setQ(''); }}><b>{l.company || l.domain || l.email}</b><span className="sm">{[l.contact_name, l.email, l.city].filter(Boolean).join(' · ')}</span><span className={`statuspill ${stageClass(l.stage)}`}>{stageLabel(l.stage)}</span></button>)}</div>}
        </div>
      </div>
      {sub === 'settings' && <RepSettings {...ctx} status={status} />}
      {sub === 'quotes' && <div className="subpage"><Quotes me={me} params={subParams} /></div>}
      {sub === 'onboarding' && <div className="subpage"><Onboarding me={me} params={subParams} /></div>}
      {sub === 'overview' && <Overview {...ctx} leads={mine} pool={leads} sends={mySends} counts={counts} />}
      {sub === 'pipeline' && <Pipeline {...ctx} leads={mine} />}
      {sub === 'master' && <Master {...ctx} leads={mine} />}
      {sub === 'email' && <Conversations {...ctx} leads={mine} allLeads={leads} sends={mySends} mail={mail} mailAccts={mailAccts} status={status} refreshStatus={refreshStatus} focus={focus} clearFocus={() => setFocus(null)} />}
      {sub === 'calls' && <Calls {...ctx} leads={leads} />}
      {sub === 'calendar' && <Calendar {...ctx} leads={leads} status={status} refreshStatus={refreshStatus} mineOnly={rep} focusDate={focus} />}
      {sub === 'bonus' && <Bonus {...ctx} leads={leads} />}
      {panelLead && <LeadPanel {...ctx} lead={panelLead} sends={sends.filter((s) => s.lead_id === panelLead.id)} onClose={() => setPanel(null)} />}
    </>
  );
}

/* =================== Dashboard =================== */
function Overview({ me, rep, leads, pool, sends, sources, counts, go, goTab, openLead, nav }) {
  const [calls, setCalls] = useState([]);
  useEffect(() => { fetchAll('sales_calls', 'id, lead_id, outcome, started_at, seconds, by_user').then((c) => setCalls(rep ? c.filter((x) => x.by_user === me.id) : c)); }, []);
  const available = (pool || leads).filter((l) => l.stage === 'new' && !l.assigned_to && l.phone).length;
  const week = Date.now() - 7 * 86400000; const day0 = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const funnel = [['new', 'New'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['call_booked', 'Call booked'], ['quoted', 'Quoted'], ['signed', 'Won']];
  const order = funnel.map((f) => f[0]); const reached = (k) => leads.filter((l) => order.indexOf(l.stage) >= order.indexOf(k) && l.stage !== 'lost' && l.stage !== 'dnc').length + (k === 'new' ? leads.filter((l) => l.stage === 'lost' || l.stage === 'dnc').length : 0);
  const byChannel = useMemo(() => {
    const g = {}; for (const sc of sources) g[sc.key] = { k: sc.key, label: sc.label, leads: 0, contacted: 0, replied: 0, booked: 0, signed: 0 };
    for (const l of leads) { const r = g[l.source] || (g[l.source] = { k: l.source, label: l.source, leads: 0, contacted: 0, replied: 0, booked: 0, signed: 0 }); r.leads++; if (l.stage !== 'new') r.contacted++; if (['replied', 'call_booked', 'quoted', 'signed'].includes(l.stage)) r.replied++; if (['call_booked', 'quoted', 'signed'].includes(l.stage)) r.booked++; if (l.stage === 'signed') r.signed++; }
    // leaderboard: signed, then booked, then reply rate
    return Object.values(g).map((r) => ({ ...r, replyRate: r.contacted ? r.replied / r.contacted : 0, bookRate: r.contacted ? r.booked / r.contacted : 0 })).sort((a, b) => b.signed - a.signed || b.booked - a.booked || b.replyRate - a.replyRate || b.leads - a.leads);
  }, [leads, sources]);
  const live = sends.filter((s) => s.replied && !s.bounced && leads.find((x) => x.id === s.lead_id)?.stage !== 'dnc');
  const inbox = live.sort((a, b) => (a.read_at ? 1 : 0) - (b.read_at ? 1 : 0) || (b.reply_at || b.sent_at).localeCompare(a.reply_at || a.sent_at)).slice(0, 10);
  const unread = live.filter((s) => !s.read_at).length;
  const wk = { dials: calls.filter((c) => new Date(c.started_at) > week).length, booked: calls.filter((c) => c.outcome === 'booked' && new Date(c.started_at) > week).length, emails: sends.filter((e) => new Date(e.sent_at) > week).length };
  const td = { dials: calls.filter((c) => new Date(c.started_at) >= day0).length, booked: calls.filter((c) => c.outcome === 'booked' && new Date(c.started_at) >= day0).length, emails: sends.filter((e) => new Date(e.sent_at) >= day0).length };
  const [goals] = useGoals(); const g = goalsFor(goals, rep ? me.id : null);
  const bonus = goals ? bonusFor(goals, rep ? me.id : null) : null; const bp = bonus ? bonusProgress(bonus, { calls, leads }, rep ? me.id : null) : null;
  const won = leads.filter((l) => l.stage === 'signed').length; const lostN = leads.filter((l) => l.stage === 'lost').length; const closeRate = won + lostN ? won / (won + lostN) : null;
  const goalItems = (per, v) => [{ key: 'dials', value: v.dials, goal: g[`dials_${per}`] }, ...(rep ? [] : [{ key: 'emails', value: v.emails, goal: g[`emails_${per}`] }]), { key: 'booked', value: v.booked, goal: g[`booked_${per}`] }];
  const openReply = async (s) => { if (!s.read_at) await supabase.from('sales_email_sends').update({ read_at: new Date().toISOString(), read_by: me.id }).eq('id', s.id); go('email', s.id); };
  return (
    <>
      {bonus && bp && <BonusBar b={bonus} p={bp} compact={!rep} name={rep ? null : 'Team'} />}
      <div className="kpis fin">
        {rep ? <div className="tile"><small>Your leads</small><b>{num(counts.total)}</b><span>{num(available)} untouched in the shared pool</span></div>
             : <div className="tile"><small>Leads in the system</small><b>{num(counts.total)}</b><span>{num(counts.new || 0)} not touched yet</span></div>}
        <div className={`tile ${unread ? 'warn' : ''}`}><small>Unread replies</small><b className={unread ? 'hot' : ''}>{num(unread)}</b><span>{num(leads.filter((l) => l.stage === 'replied' && !l.answered_at).length)} still to answer</span></div>
        <div className="tile ok"><small>Calls booked</small><b>{num(counts.call_booked || 0)}</b><span>{num(counts.quoted || 0)} quoted · {num(counts.signed || 0)} won</span></div>
        <div className="tile"><small>Close rate</small><b>{closeRate == null ? '—' : pct(closeRate)}</b><span>{num(won)} won · {num(lostN)} lost{rep ? '' : ' · team'}</span></div>
      </div>
      <div className="ownergrid">
        <GoalBars title="Today" items={goalItems('day', td)} />
        <GoalBars title="This week" items={goalItems('week', wk)} />
      </div>
      <div className="ownergrid">
        <div className="card">
          <div className="cardhead"><h3>Inbox</h3><span className="sm">{unread ? `${num(unread)} unread` : 'all read'}</span><div className="spacer" /><button className="btn-xs" onClick={() => go('email')}>Open conversations →</button></div>
          {inbox.length === 0 ? <div className="empty">No replies yet.</div> : (
            <ul className="inbox">{inbox.map((s) => { const l = leads.find((x) => x.id === s.lead_id); return (
              <li key={s.id} className={s.read_at ? 'read' : 'unread'} onClick={() => openReply(s)}>
                <i className="dot" />
                <div className="who"><b>{s.lead_name || l?.company || s.lead_email}</b><span className="sm">{l?.company && s.lead_name ? l.company : s.lead_email}</span></div>
                <div className="snip">{(s.reply_body || s.subject || '').split('\n').filter(Boolean).join(' ').slice(0, 110)}</div>
                <div className="meta"><span className="sm">{ago(s.reply_at || s.sent_at)}</span>{l?.answered_at ? <span className="pill connected">answered</span> : <span className="pill pending">needs answer</span>}</div>
              </li>
            ); })}</ul>
          )}
        </div>
        <Accounts me={me} rep={rep} nav={goTab} />
      </div>
      {!rep && <div className="ownergrid">
        <div className="card">
          <div className="cardhead"><h3>Channel leaderboard</h3><span className="sm">ranked by won, then booked, then reply rate</span></div>
          <div className="tablewrap"><table className="ordertable fin">
            <thead><tr><th>#</th><th>Channel</th><th className="n">Leads</th><th className="n">Contacted</th><th className="n">Reply %</th><th className="n">Booked</th><th className="n">Won</th></tr></thead>
            <tbody>{byChannel.map((r, i) => <tr key={r.k} className={i === 0 && r.contacted ? 'hl' : ''}><td className="mono">{i + 1}</td><td><b>{r.label}</b></td><td className="n">{num(r.leads)}</td><td className="n">{num(r.contacted)}</td><td className="n">{pct(r.replyRate, 1)}</td><td className="n">{num(r.booked)}</td><td className="n">{num(r.signed)}</td></tr>)}</tbody>
          </table></div>
        </div>
      </div>}
      {!rep && <OwnerTeamBlock />}
      <div className="card">
        <div className="cardhead"><h3>Funnel</h3><span className="sm">{rep ? 'your leads' : 'every lead, every channel'}</span></div>
        <div className="funnel">{funnel.map(([k, l], i) => { const r = reached(k); const w = Math.max(4, (r / (leads.length || 1)) * 100); return (
          <div key={k} className="step"><div className="barw"><i style={{ width: `${w}%` }} /></div><b>{num(r)}</b><small>{l}{i > 0 && <span className="conv"> · {pct(r / (reached(funnel[i - 1][0]) || 1))}</span>}</small></div>
        ); })}</div>
      </div>
    </>
  );
}
/* Your accounts: the clients this rep owns (orgs.sales_rep_id), with onboarding progress; opens Onboarding for that brand */
function Accounts({ me, rep, nav }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { supabase.from('v_onboarding_progress').select('*').order('created_at', { ascending: false }).then(async ({ data }) => { const { data: orgs } = await supabase.from('orgs').select('id, sales_rep_id, sales_rep, go_live_date, go_live_status, contact_name, contact_email, founding_account'); setRows((data || []).map((a) => ({ ...a, ...(orgs || []).find((o) => o.id === a.org_id) }))); }); }, []);
  if (rows === null) return <div className="card"><div className="cardhead"><h3>Your accounts</h3></div><div className="empty">Loading…</div></div>;
  const mine = rows.filter((a) => !rep || a.sales_rep_id === me.id || (a.sales_rep || '').toLowerCase() === (me.full_name || '').toLowerCase());
  const live = mine.filter((a) => a.status === 'active').length;
  return (
    <div className="card">
      <div className="cardhead"><h3>{rep ? 'Your accounts' : 'Accounts'}</h3><span className="sm">{num(mine.length)} · {num(live)} live · {num(mine.filter((a) => a.status === 'onboarding').length)} onboarding</span></div>
      {mine.length === 0 ? <div className="empty">No accounts yet. Win one on the Pipeline and it lands here.</div> : (
        <ul className="acctcards">{mine.map((a) => { const pctDone = a.total ? a.done / a.total : 0; const days = a.go_live_date ? Math.ceil((new Date(a.go_live_date) - Date.now()) / 86400000) : null; return (
          <li key={a.org_id} className="click" onClick={() => nav?.('onboarding', { org: a.org_id })}>
            <div className="top"><b>{a.name}</b>{a.founding_account && <span className="tag founding">founding</span>}<span className={`statuspill ${a.status === 'active' ? 'ok' : a.go_live_status === 'at_risk' || a.go_live_status === 'delayed' ? 'warn' : 'navy'}`}>{a.status === 'active' ? 'Live' : `Onboarding · ${(a.go_live_status || 'on_time').replace('_', ' ')}`}</span></div>
            <div className="sm">{[a.contact_name, a.contact_email].filter(Boolean).join(' · ')}{!rep && a.sales_rep ? ` · rep ${a.sales_rep.split(' ')[0]}` : ''}</div>
            <div className="prog"><div className="bar"><i style={{ width: `${pctDone * 100}%` }} /></div><span className="sm">{num(a.done)}/{num(a.total)} onboarding steps{days != null ? ` · go-live ${days >= 0 ? `in ${days}d` : `${-days}d ago`}` : ''}{a.last_activity ? ` · last activity ${ago(a.last_activity)}` : ''}</span></div>
          </li>
        ); })}</ul>
      )}
    </div>
  );
}
function OwnerTeamBlock() {
  const [d] = useTeamData(); const rows = useMemo(() => (d ? teamStats(d, 'week') : []), [d]);
  return <div className="card"><div className="cardhead"><h3>Team · last 7 days</h3><span className="sm">full detail under the Team tab</span></div>{d ? <TeamTable rows={rows} compact /> : <div className="empty">Loading…</div>}</div>;
}
export function ChannelTable({ rows, mono }) {
  return (
    <div className="tablewrap"><table className="ordertable fin">
      <thead><tr><th /><th className="n">Leads</th><th className="n">Contacted</th><th className="n">Replied</th><th className="n">Reply %</th><th className="n">Booked</th><th className="n">Won</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.k}><td title={r.label}><b className={mono ? 'mono' : ''}>{mono ? r.k : r.label}</b>{mono && LIST_NAMES[r.k] && <span className="sm"> {LIST_NAMES[r.k]}</span>}</td><td className="n">{num(r.leads)}</td><td className="n">{num(r.contacted)}</td><td className="n">{num(r.replied)}</td><td className="n">{pct(r.replied / (r.contacted || 1), 1)}</td><td className="n">{num(r.booked)}</td><td className="n">{num(r.signed)}</td></tr>)}</tbody>
    </table></div>
  );
}
/** leads grouped by list — used on the Strategies page */
export function byListRows(leads) {
  const g = {}; for (const l of leads) { const k = l.filter_id || '—'; const r = g[k] || (g[k] = { k, label: listName(k), leads: 0, contacted: 0, replied: 0, booked: 0, signed: 0 }); r.leads++; if (l.stage !== 'new') r.contacted++; if (['replied', 'call_booked', 'quoted', 'signed'].includes(l.stage)) r.replied++; if (['call_booked', 'quoted', 'signed'].includes(l.stage)) r.booked++; if (l.stage === 'signed') r.signed++; }
  return Object.values(g).sort((a, b) => b.leads - a.leads);
}

/* =================== Pipeline: the deals board =================== */
const COLS = [['contacted', 'Contacted'], ['replied', 'Replied'], ['call_booked', 'Call booked'], ['quoted', 'Quoted'], ['signed', 'Won']];
function Pipeline({ me, rep, leads, sources, people, reload, say, openLead, quotes }) {
  const val = (l) => expectedMonthly(l, quotes).value || 0;
  const [adding, setAdding] = useState(false); const [src, setSrc] = useState(''); const [list, setList] = useState(''); const [who, setWho] = useState(''); const [sort, setSort] = useState('value'); const [more, setMore] = useState({}); const [drag, setDrag] = useState(null); const [over, setOver] = useState(null);
  const pool = leads.filter((l) => (!src || l.source === src) && (!list || l.filter_id === list) && (!who || (who === 'none' ? !l.assigned_to : l.assigned_to === who)));
  const sorters = { value: (a, b) => val(b) - val(a) || (b.last_touch_at || '').localeCompare(a.last_touch_at || ''), recent: (a, b) => (b.last_touch_at || '').localeCompare(a.last_touch_at || ''), oldest: (a, b) => (a.last_touch_at || '').localeCompare(b.last_touch_at || ''), sales: (a, b) => (b.est_sales_usd || 0) - (a.est_sales_usd || 0), name: (a, b) => (a.company || '').localeCompare(b.company || '') };
  const col = (k) => pool.filter((l) => l.stage === k).sort(sorters[sort]);
  const repName = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email).split(' ')[0] : ''; };
  const move = async (l, stage) => {
    if (!l || l.stage === stage) return;
    const patch = { stage, last_touch_at: new Date().toISOString(), assigned_to: l.assigned_to || me.id };
    if (stage === 'signed') { const r = await winLead(l, quotes, say); if (r) reload(); return; }
    if (stage === 'lost') { const r = window.prompt('Why lost? (optional)', l.lost_reason || ''); if (r === null) return; patch.lost_reason = r || null; }
    const { error } = await supabase.from('sales_leads').update(patch).eq('id', l.id); if (error) return say({ error: error.message }); reload();
  };
  const lost = pool.filter((l) => l.stage === 'lost').length; const dnc = pool.filter((l) => l.stage === 'dnc').length; const fresh = pool.filter((l) => l.stage === 'new').length;
  const won = col('signed'); const wonVal = won.reduce((a, l) => a + val(l), 0); const openVal = ['replied', 'call_booked', 'quoted'].flatMap(col).reduce((a, l) => a + val(l), 0);
  return (
    <>
      <div className="opsbar wrap">
        <select value={src} onChange={(e) => setSrc(e.target.value)}><option value="">All channels</option>{sources.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
        <select value={list} onChange={(e) => setList(e.target.value)}><option value="">All lists</option>{lists(leads).map((f) => <option key={f} value={f}>{listName(f)}</option>)}</select>
        {!rep && <select value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{people.map((p) => <option key={p.id} value={p.id}>{(p.full_name || p.email).split(' ')[0]}</option>)}<option value="none">Unassigned</option></select>}
        <select value={sort} onChange={(e) => setSort(e.target.value)}><option value="value">Sort: deal value</option><option value="recent">Sort: most recent</option><option value="oldest">Sort: waiting longest</option><option value="sales">Sort: store size</option><option value="name">Sort: A–Z</option></select>
        <span className="sm">{num(fresh)} contacts not worked yet · {num(lost)} lost · {num(dnc)} do-not-contact</span>
        <div className="spacer" />
        <span className="sm">Open pipeline <b>{money(openVal)}/mo</b> · Won <b>{money(wonVal)}/mo</b></span>
        <button className="btn-sm primary" onClick={() => setAdding(true)}>+ Add opportunity</button>
      </div>
      <div className="kanban">
        {[...COLS, ['lost', 'Lost']].map(([k, label]) => { const items = col(k); const shown = items.slice(0, more[k] ? 1000 : 80); const colVal = items.reduce((a, l) => a + Number(val(l) || 0), 0); return (
          <div key={k} className={`kcol ${k} ${over === k ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver(null)} onDrop={() => { setOver(null); move(drag, k); setDrag(null); }}>
            <div className="khead"><b>{label}</b><span className="cnt">{num(items.length)}</span>{colVal > 0 && <span className="val">{money(colVal)}</span>}</div>
            <div className="kcards">
              {shown.map((l) => (
                <div key={l.id} className={`kcard ${l.stage === 'replied' && !l.answered_at ? 'hot' : ''}`} draggable onDragStart={() => setDrag(l)} onDragEnd={() => setDrag(null)} onClick={() => openLead(l)}>
                  <div className="kt"><b>{l.company || l.domain || l.email}</b>{val(l) ? <span className="kv" title="expected services per month">{money(val(l))}</span> : null}</div>
                  <div className="sm">{[l.contact_name, l.city].filter(Boolean).join(' · ') || l.email}</div>
                  <div className="kmeta"><span className="pill">{srcLabelPlain(l.source)}</span>{l.filter_id && <span className="pill">{l.filter_id}</span>}{l.assigned_to && <span className="pill connected">{rep ? 'yours' : repName(l.assigned_to)}</span>}<span className="sm">{ago(l.last_touch_at)}</span></div>
                  {l.stage === 'replied' && !l.answered_at && <div className="sm neg">reply waiting</div>}
                </div>
              ))}
              {items.length > shown.length && <button className="btn-xs" onClick={() => setMore({ ...more, [k]: true })}>Show all {num(items.length)}</button>}
              {items.length === 0 && <div className="kempty">Drop a card here</div>}
            </div>
          </div>
        ); })}
      </div>
      {adding && <LeadForm sources={sources} onClose={() => setAdding(false)} reload={reload} say={say} openExisting={openLead} title="Add an opportunity" defaultStage="contacted" claimAs={me.id} />}
    </>
  );
}


/* =================== Master =================== */
function Master({ me, rep, leads, sources, reload, say, openLead }) {
  const [dupes, setDupes] = useState(false); const dupeGroups = useMemo(() => findDupes(leads), [leads]);
  const [q, setQ] = useState(''); const [src, setSrc] = useState(''); const [stage, setStage] = useState(''); const [list, setList] = useState(''); const [phoneOnly, setPhoneOnly] = useState(false); const [showOut, setShowOut] = useState(false); const [pushing, setPushing] = useState(false);
  const [adding, setAdding] = useState(false); const [importing, setImporting] = useState(false);
  const rows = useMemo(() => leads.filter((l) => (!src || l.source === src) && (stage ? l.stage === stage : (showOut || (l.stage !== 'dnc' && l.stage !== 'lost'))) && (!list || l.filter_id === list) && (!phoneOnly || l.phone)
    && (!q || [l.company, l.domain, l.contact_name, l.email, l.phone, l.city, l.state, l.notes].filter(Boolean).some((s) => s.toLowerCase().includes(q.toLowerCase())))), [leads, q, src, stage, list, phoneOnly, showOut]);
  const pushable = rows.filter((l) => l.email && !l.in_email && !['dnc', 'lost', 'signed'].includes(l.stage));
  const pushToCampaign = async () => {
    const ids = pushable.slice(0, 500).map((l) => l.id);
    if (!window.confirm(`Add ${ids.length} lead${ids.length === 1 ? '' : 's'} with an email to the Smartlead campaign? They start getting the sequence on the next send window.`)) return;
    setPushing(true); const r = await ownerFn({ action: 'smartlead_add_leads', lead_ids: ids }); setPushing(false);
    say(r, r.error ? null : `Added ${r.added} to the campaign${r.dup ? ` · ${r.dup} already there` : ''}${r.blocked ? ` · ${r.blocked} blocked/unsubscribed` : ''}.`); reload();
  };
  const order = { replied: 0, call_booked: 1, quoted: 2, contacted: 3, new: 4, signed: 5, lost: 6, dnc: 7 };
  const sorted = useMemo(() => [...rows].sort((a, b) => (order[a.stage] ?? 9) - (order[b.stage] ?? 9) || (b.last_touch_at || '').localeCompare(a.last_touch_at || '') || (b.est_sales_usd || 0) - (a.est_sales_usd || 0)), [rows]);
  return (
    <>
      <div className="opsbar wrap">
        <input className="search" placeholder="Search company, email, phone, city…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={src} onChange={(e) => setSrc(e.target.value)}><option value="">All channels</option>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        <select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">All stages</option>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={list} onChange={(e) => setList(e.target.value)}><option value="">All lists</option>{lists(leads).map((f) => <option key={f} value={f}>{listName(f)}</option>)}</select>
        <label className="chk sm"><input type="checkbox" checked={phoneOnly} onChange={(e) => setPhoneOnly(e.target.checked)} /> has phone</label>
        <label className="chk sm"><input type="checkbox" checked={showOut} onChange={(e) => setShowOut(e.target.checked)} /> show lost / do-not-contact</label>
        <div className="spacer" />
        {!rep && pushable.length > 0 && <button className="btn-sm" disabled={pushing} onClick={pushToCampaign}>{pushing ? 'Adding…' : `Add ${num(Math.min(500, pushable.length))} to email campaign`}</button>}
        {dupeGroups.length > 0 && <button className="btn-sm warn" onClick={() => setDupes(true)}>Duplicates ({dupeGroups.length})</button>}
        {!rep && <button className="btn-sm" onClick={() => setImporting(true)}>Import CSV</button>}
        <button className="btn-sm primary" onClick={() => setAdding(true)}>+ Add lead</button>
      </div>
      {dupes && <DupModal groups={dupeGroups} onClose={() => setDupes(false)} reload={reload} say={say} />}
      <div className="card">
        <div className="tablewrap"><table className="ordertable leads">
          <thead><tr><th>Company</th><th>Contact</th><th>Phone</th><th>Where</th><th className="n">Est. sales / mo</th><th>Channel · list</th><th>Stage</th><th className="n">Tries</th><th>Last touch</th></tr></thead>
          <tbody>{sorted.slice(0, 400).map((l) => (
            <tr key={l.id} className="click" onClick={() => openLead(l)}>
              <td><b>{l.company || l.domain || l.email}</b>{l.domain && <div className="sm">{l.domain}</div>}</td>
              <td>{l.contact_name}{l.email && <div className="sm">{l.email}</div>}</td>
              <td className="mono sm">{l.phone}</td>
              <td className="sm">{[l.city, l.state].filter(Boolean).join(', ')}</td>
              <td className="n">{l.est_sales_usd ? money(l.est_sales_usd) : '—'}</td>
              <td className="sm">{srcLabel(sources, l.source)}{l.filter_id && <div className="sm mono" title={listName(l.filter_id)}>{l.filter_id}</div>}</td>
              <td><span className={`statuspill ${stageClass(l.stage)}`}>{stageLabel(l.stage)}</span></td>
              <td className="n">{l.attempts || 0}</td>
              <td className="sm">{ago(l.last_touch_at)}{l.last_outcome && <div className="sm">{l.last_outcome.replace('_', ' ')}</div>}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="sm" style={{ padding: '8px 2px' }}>Showing {Math.min(400, sorted.length)} of {sorted.length} · replies and booked calls float to the top.</div>
      </div>
      {adding && <LeadForm sources={sources} onClose={() => setAdding(false)} reload={reload} say={say} openExisting={openLead} claimAs={rep ? me.id : null} />}
      {importing && <ImportCsv sources={sources} onClose={() => setImporting(false)} reload={reload} say={say} />}
    </>
  );
}

/* ---------- one lead: edit, history ---------- */

/* =================== Contact panel: slides in from the right; everything about one lead =================== */
const PANEL_OUT = [['connected', 'Connected', 'ok'], ['voicemail', 'Voicemail', ''], ['no_answer', 'No answer', ''], ['gatekeeper', 'Gatekeeper', 'warn'], ['booked', 'Booked a call', 'ok solid'], ['not_fit', 'Not a fit', 'bad'], ['wrong_number', 'Wrong number', 'bad']];
export function LeadPanel({ me, rep, lead, sends, sources, onClose, reload, say, go, goTab, nav, quotes, orgs }) {
  const exp = expectedMonthly(lead, quotes); const myQuotes = quotesFor(lead, quotes); const org = lead.org_id ? (orgs || []).find((o) => o.id === lead.org_id) : null;
  const [tab, setTab] = useState('activity'); const kit = useReplyKit(me); const booking = kit.booking; const [touches, setTouches] = useState([]); const [f, setF] = useState(lead); const [calls, setCalls] = useState([]); const [people, setPeople] = useState([]); const [meetings, setMeetings] = useState([]);
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [logging, setLogging] = useState(false);
  const claimAs = rep ? me.id : null;
  useEffect(() => { setF(lead); }, [lead.id, lead.updated_at]);
  useEffect(() => { (async () => {
    const [c, p, m, t] = await Promise.all([supabase.from('sales_calls').select('*').eq('lead_id', lead.id).order('started_at', { ascending: false }), supabase.from('profiles').select('id, full_name, email').like('role', 'shipbay%').eq('active', true), supabase.from('sales_meetings').select('*').eq('lead_id', lead.id).order('starts_at', { ascending: false }), supabase.from('sales_touches').select('*').eq('lead_id', lead.id).order('at', { ascending: false })]);
    setCalls(c.data || []); setPeople(p.data || []); setMeetings(m.data || []); setTouches(t.data || []);
  })(); }, [lead.id]);
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const upd = async (patch, ok) => { const { error } = await supabase.from('sales_leads').update({ ...patch, assigned_to: patch.assigned_to !== undefined ? patch.assigned_to : (lead.assigned_to || claimAs || null) }).eq('id', lead.id); if (error) return say({ error: error.message }); if (ok) say(null, ok); reload(); };
  const save = async () => {
    setBusy(true);
    const patch = { company: f.company, domain: f.domain, contact_name: f.contact_name, email: f.email, phone: f.phone, title: f.title, city: f.city, state: f.state, est_sales_usd: f.est_sales_usd ? Number(f.est_sales_usd) : null, deal_value: f.deal_value ? Number(f.deal_value) : null, stage: f.stage, source: f.source, filter_id: f.filter_id, notes: f.notes, next_action_at: f.next_action_at ? new Date(f.next_action_at).toISOString() : null, in_calls: f.in_calls, in_email: f.in_email, assigned_to: f.assigned_to || claimAs || null, won_at: f.stage === 'signed' ? (lead.won_at || new Date().toISOString()) : lead.won_at };
    const { error } = await supabase.from('sales_leads').update(patch).eq('id', lead.id); setBusy(false);
    if (error) return say({ error: error.message });
    if (f.stage === 'dnc' && lead.stage !== 'dnc' && f.email) { const r = await ownerFn({ action: 'smartlead_stop_lead', email: f.email }); if (r.error) say(r); }
    say(null, 'Saved.'); reload(); setTab('activity');
  };
  const setStage = async (stage) => {
    const patch = { stage, last_touch_at: new Date().toISOString() };
    if (stage === 'signed') { if (await winLead(lead, quotes, say)) reload(); return; }
    if (stage === 'lost') { const r = window.prompt('Why lost? (optional)', lead.lost_reason || ''); if (r === null) return; patch.lost_reason = r || null; }
    if (stage === 'dnc') { if (!window.confirm('Mark do-not-contact? They come out of the email campaign and the call queue.')) return; if (lead.email) ownerFn({ action: 'smartlead_stop_lead', email: lead.email }); patch.in_calls = false; patch.in_email = false; }
    upd(patch);
  };
  const addNote = async () => { if (!note.trim()) return; await upd({ notes: [lead.notes, `${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${(me.full_name || me.email).split(' ')[0]}: ${note.trim()}`].filter(Boolean).join('\n'), last_touch_at: new Date().toISOString() }); setNote(''); };
  const logCall = async (outcome) => {
    await supabase.from('sales_calls').insert({ lead_id: lead.id, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), seconds: 0, outcome, note: note || null, by_user: me.id });
    const next = { no_answer: 2, voicemail: 3, gatekeeper: 1, connected: 7 }[outcome];
    const patch = { attempts: (lead.attempts || 0) + 1, last_outcome: outcome, last_touch_at: new Date().toISOString(), next_action_at: next ? new Date(Date.now() + next * 86400000).toISOString() : null };
    if (outcome === 'booked') patch.stage = 'call_booked'; else if (outcome === 'not_fit') patch.stage = 'lost'; else if (outcome === 'wrong_number') patch.in_calls = false; else if (lead.stage === 'new') patch.stage = 'contacted';
    if (note) patch.notes = [lead.notes, `${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${outcome.replace('_', ' ')}: ${note}`].filter(Boolean).join('\n');
    await upd(patch, 'Call logged.'); setNote(''); setLogging(false);
    const { data } = await supabase.from('sales_calls').select('*').eq('lead_id', lead.id).order('started_at', { ascending: false }); setCalls(data || []);
  };
  const markRead = async (s) => { if (!s.read_at) { await supabase.from('sales_email_sends').update({ read_at: new Date().toISOString(), read_by: me.id }).eq('id', s.id); reload(); } };
  const replies = sends.filter((s) => s.replied); const lastReply = replies[0];
  const timeline = [
    ...sends.map((s) => ({ at: s.reply_at && s.replied ? s.reply_at : s.sent_at, kind: s.replied ? 'reply' : 'sent', s })),
    ...calls.map((c) => ({ at: c.started_at, kind: 'call', c })),
    ...touches.map((t) => ({ at: t.at, kind: 'touch', t })),
    ...meetings.map((m) => ({ at: m.starts_at, kind: 'meeting', m })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const who = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email).split(' ')[0] : '—'; };
  return (
    <div className="overlay side" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel" role="dialog" aria-label={lead.company || lead.email}>
        <div className="phead">
          <div className="ptitle">
            <h2>{lead.company || lead.domain || lead.email}</h2>
            <div className="sm">{[lead.contact_name, lead.title, [lead.city, lead.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}{lead.domain && <> · <a href={`https://${lead.domain}`} target="_blank" rel="noreferrer">{lead.domain} ↗</a></>}</div>
            <div className="pchips">
              <select className={`statuspill ${stageClass(lead.stage)}`} value={lead.stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select className="statusselect" title="Where this lead came from" value={lead.source} onChange={(e) => upd({ source: e.target.value }, 'Channel updated.')}>{sources.map((sx) => <option key={sx.key} value={sx.key}>{sx.label}</option>)}</select>{lead.filter_id && <span className="pill" title={listName(lead.filter_id)}>{lead.filter_id}</span>}
              {!rep && <select className="statusselect" value={lead.assigned_to || ''} onChange={(e) => upd({ assigned_to: e.target.value || null }, 'Handed off.')}><option value="">— nobody —</option>{people.map((p) => <option key={p.id} value={p.id}>{(p.full_name || p.email).split(' ')[0]}</option>)}</select>}
              {rep && lead.assigned_to && <span className="pill connected">{lead.assigned_to === me.id ? 'yours' : who(lead.assigned_to)}</span>}
              {exp.value ? <span className="pill connected" title={exp.from ? `From ${exp.from.label}` : 'Typed in by hand'}>{money(exp.value)}/mo{exp.from ? ' · quote' : ''}</span> : null}
              {org && <span className="pill navy">client</span>}
            </div>
          </div>
          <button className="btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="pactions">
          {lead.email && <a className="btn-sm primary" href={kit.link(lead.email, lastReply?.subject, lead)} target="_blank" rel="noreferrer">{lastReply ? 'Reply in Gmail' : 'Email in Gmail'}</a>}
          {lead.email && <button className="btn-sm" onClick={async () => { await supabase.from('sales_touches').insert({ lead_id: lead.id, kind: 'email_sent', note: note || null, by_user: me.id }); await upd({ last_touch_at: new Date().toISOString(), last_outcome: 'email_sent', ...(lead.stage === 'new' ? { stage: 'contacted' } : {}) }, 'Email logged.'); const { data } = await supabase.from('sales_touches').select('*').eq('lead_id', lead.id).order('at', { ascending: false }); setTouches(data || []); }}>Mark email sent</button>}
          {booking && <button className="btn-sm" onClick={() => { navigator.clipboard?.writeText(booking); say(null, 'Booking link copied.'); }}>Copy booking link</button>}
          {lead.phone && <a className="btn-sm" href={`tel:${lead.phone.replace(/[^+\d]/g, '')}`}>Call {lead.phone}</a>}
          <button className="btn-sm" onClick={() => setLogging((v) => !v)}>Log a call</button>
          {lead.stage === 'replied' && (lead.answered_at ? <button className="btn-sm ok" onClick={() => upd({ answered_at: null })}>✓ Answered — undo</button> : <button className="btn-sm" onClick={() => upd({ answered_at: new Date().toISOString() }, 'Marked answered.')}>Mark answered</button>)}
          {lead.stage !== 'dnc' && <button className="btn-sm" onClick={() => setStage('dnc')}>Do not contact</button>}
        </div>
        {logging && <div className="plog"><textarea rows={2} placeholder="What happened on the call…" value={note} onChange={(e) => setNote(e.target.value)} /><div className="outcomes">{PANEL_OUT.map(([k, l, cls]) => <button key={k} className={`oc ${cls}`} onClick={() => logCall(k)}>{l}</button>)}</div></div>}
        <div className="tabs ptabs"><button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity{replies.length ? <i>{replies.length}</i> : null}</button><button className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>Details</button></div>
        <div className="pbody">
          <div className="acct">
            <div className="acctrow">
              <div><small>Client account</small>{org ? <b>{org.name} <span className={`statuspill ${org.status === 'active' ? 'ok' : 'navy'}`}>{org.status}</span></b> : <b className="sm">not a client yet</b>}</div>
              <div className="spacer" />
              {org ? <><button className="btn-xs" onClick={() => { goTab?.('onboarding', { org: org.id }); onClose(); }}>Onboarding →</button>{!rep && <button className="btn-xs" onClick={() => { nav?.('owner', { tab: 'admin', section: 'clients', org: org.id }); onClose(); }}>Client settings →</button>}</>
                : lead.stage !== 'dnc' && <button className="btn-xs primary" onClick={() => setStage('signed')}>Won — make them a client</button>}
            </div>
            <div className="acctrow">
              <div><small>Quotes</small>{myQuotes.length ? <div className="qlist">{myQuotes.map((q) => <button key={q.id} className="qchip" onClick={() => { goTab?.('quotes', { quote: q.id }); onClose(); }}><b>{q.label}</b><span className={`pill ${q.status === 'accepted' ? 'ok' : q.status === 'sent' ? 'navy' : 'muted'}`}>{q.status}</span>{quoteMonthly(q) != null && <span>{money(quoteMonthly(q))}/mo</span>}{q.internal_only ? <span className="sm">internal</span> : null}</button>)}</div> : <b className="sm">no quote yet</b>}</div>
              <div className="spacer" />
              <button className="btn-xs" onClick={() => { goTab?.('quotes', { lead: lead.id }); onClose(); }}>+ New quote</button>
            </div>
          </div>
          {tab === 'activity' && (
            <>
              <div className="notebox"><textarea rows={2} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} /><div className="row"><div className="spacer" /><button className="btn-xs primary" onClick={addNote} disabled={!note.trim()}>Add note</button></div></div>
              {lead.notes && <pre className="notes">{lead.notes}</pre>}
              {timeline.length === 0 ? <div className="empty">No activity yet.</div> : (
                <ul className="timeline">{timeline.map((t, i) => (
                  <li key={i} className={t.kind}>
                    <span className="when sm">{new Date(t.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                    {t.kind === 'reply' && <div className={`ev reply ${t.s.read_at ? '' : 'unread'}`} onClick={() => { markRead(t.s); go('email', t.s.id); onClose(); }}><b>Replied</b>{t.s.reply_type && <span className="pill">{t.s.reply_type}</span>}<div className="snip">{(t.s.reply_body || t.s.subject || '').split('\n').filter(Boolean).join(' ').slice(0, 220)}</div><span className="sm">open conversation →</span></div>}
                    {t.kind === 'sent' && <div className="ev"><span className="sm">Email step {t.s.step} sent · {t.s.subject}</span></div>}
                    {t.kind === 'call' && <div className="ev"><b>Call · {t.c.outcome.replace('_', ' ')}</b><span className="sm"> · {who(t.c.by_user)}{t.c.seconds ? ` · ${mmss(t.c.seconds)}` : ''}</span>{t.c.note && <div className="sm">{t.c.note}</div>}</div>}
                    {t.kind === 'touch' && <div className="ev"><b>{t.t.kind === 'email_sent' ? 'Email sent' : t.t.kind}</b><span className="sm"> · {who(t.t.by_user)}</span>{t.t.note && <div className="sm">{t.t.note}</div>}</div>}
                    {t.kind === 'meeting' && <div className="ev"><b>{t.m.status === 'canceled' ? 'Canceled call' : 'Call booked'}</b><span className="sm"> · {t.m.name}{t.m.outcome ? ` → ${t.m.outcome.replace('_', ' ')}` : ''}</span></div>}
                  </li>
                ))}</ul>
              )}
            </>
          )}
          {tab === 'details' && (
            <>
              <div className="addgrid lead">
                <label>Company<input value={f.company || ''} onChange={set('company')} /></label>
                <label>Domain<input value={f.domain || ''} onChange={set('domain')} /></label>
                <label>Contact<input value={f.contact_name || ''} onChange={set('contact_name')} /></label>
                <label>Title<input value={f.title || ''} onChange={set('title')} /></label>
                <label>Email<input value={f.email || ''} onChange={set('email')} /></label>
                <label>Phone<input value={f.phone || ''} onChange={set('phone')} /></label>
                <label>City<input value={f.city || ''} onChange={set('city')} /></label>
                <label>State<input value={f.state || ''} onChange={set('state')} /></label>
                <label>Status<select value={f.stage} onChange={set('stage')}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                <label>Channel<select value={f.source} onChange={set('source')}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
                <label>List<input value={f.filter_id || ''} onChange={set('filter_id')} /></label>
                <label>Follow up<input type="datetime-local" value={toLocalInput(f.next_action_at)} onChange={set('next_action_at')} /></label>
                <label>Est. online sales $/mo<input type="number" value={f.est_sales_usd || ''} onChange={set('est_sales_usd')} /></label>
                <label>Deal value $/mo<input type="number" value={f.deal_value || ''} onChange={set('deal_value')} placeholder="services if won" /></label>
                {!rep && <label>Handled by<select value={f.assigned_to || ''} onChange={set('assigned_to')}><option value="">— nobody —</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select></label>}
                <label className="chk"><input type="checkbox" checked={!!f.in_calls} onChange={(e) => setF({ ...f, in_calls: e.target.checked })} /> in the call queue</label>
                <label className="chk"><input type="checkbox" checked={!!f.in_email} onChange={(e) => setF({ ...f, in_email: e.target.checked })} /> in email campaign</label>
                <label className="wide2">Notes<textarea rows={5} value={f.notes || ''} onChange={set('notes')} /></label>
              </div>
              <div className="row"><span className="sm">{lead.products ? `${lead.products} products · ` : ''}{lead.plan || ''}{lead.rank ? ` · rank ${num(lead.rank)}` : ''}{lead.categories ? ` · ${lead.categories}` : ''}</span><div className="spacer" /><button className="btn-sm primary" disabled={busy} onClick={save}>Save</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* =================== Conversations: the reply inbox =================== */
/* =================== Conversations: SB Blast (Smartlead replies) or Email (your own Gmail) =================== */
function Conversations(props) {
  const { focus, sends, mailAccts, me } = props;
  const [src, setSrc] = useState(() => { try { return localStorage.getItem('shipbay-conv-src') || 'blast'; } catch { return 'blast'; } });
  const pick = (v) => { setSrc(v); try { localStorage.setItem('shipbay-conv-src', v); } catch { /* ignore */ } };
  // a Gmail-origin reply opened from the Dashboard inbox belongs in the Email view
  const focusSend = focus ? sends.find((x) => x.id === focus) : null;
  useEffect(() => { if (focusSend?.mailbox) setSrc('email'); }, [focusSend?.id]);
  const connected = mailAccts.some((a) => a.user_id === me.id);
  const picker = <select className="srcpick" value={src} onChange={(e) => pick(e.target.value)}><option value="blast">SB Blast</option><option value="email">Email{connected ? '' : ' (not connected)'}</option></select>;
  return src === 'email' ? <EmailInbox {...props} picker={picker} focusLead={focusSend?.mailbox ? focusSend.lead_id : null} /> : <BlastInbox {...props} picker={picker} toEmail={() => pick('email')} />;
}

function BlastInbox({ me, rep, leads, sends, mailAccts, status, people, reload, refreshStatus, say, openLead, focus, clearFocus, picker, toEmail }) {
  const [busy, setBusy] = useState(false); const [show, setShow] = useState('all'); const [who, setWho] = useState(''); const refs = useRef({}); const kit = useReplyKit(me);
  const sync = async () => { setBusy(true); const r = await ownerFn({ action: 'smartlead_sync' }); setBusy(false); say(r, r.error ? null : 'Smartlead synced.'); reload(); refreshStatus?.(); };
  const replies = useMemo(() => sends.filter((s) => s.replied && !s.bounced && !s.mailbox).sort((a, b) => (b.reply_at || b.sent_at).localeCompare(a.reply_at || a.sent_at)), [sends]);
  const unread = replies.filter((s) => !s.read_at && leads.find((x) => x.id === s.lead_id)?.stage !== 'dnc').length;
  const myMail = mailAccts.find((a) => a.user_id === me.id);
  /** take this conversation into my own Gmail: it leaves SB Blast and shows under Email, where I answer from my inbox */
  const moveToEmail = async (s, l) => {
    if (!myMail) { say({ error: 'Connect your Gmail first (Sales → Settings), then you can move conversations there.' }); return; }
    const { error } = await supabase.from('gmail_messages').upsert({ user_id: me.id, gmail_id: `sl:${s.id}`, thread_id: `sl:${l?.id || s.id}`, from_email: s.lead_email, from_name: s.lead_name, to_email: null, subject: s.reply_subject || s.subject, snippet: (s.reply_body || '').slice(0, 300), body: s.reply_body || '', at: s.reply_at || s.sent_at, is_sent: false, lead_id: l?.id || null, read_at: new Date().toISOString() }, { onConflict: 'user_id,gmail_id' });
    if (error) { say({ error: error.message }); return; }
    await supabase.from('sales_email_sends').update({ mailbox: 'moved', read_at: new Date().toISOString(), read_by: me.id }).eq('id', s.id);
    if (l && !l.assigned_to) await supabase.from('sales_leads').update({ assigned_to: me.id }).eq('id', l.id);
    await reload(); say(null, 'Moved to Email — answer it from there.'); toEmail();
  };
  const list = replies.filter((s) => { const l = leads.find((x) => x.id === s.lead_id); const stoppedRow = l?.stage === 'dnc'; if (who && l?.assigned_to !== who) return false; return (show === 'all' && !stoppedRow) || (show === 'unread' && !s.read_at && !stoppedRow) || (show === 'open' && l && !l.answered_at && !stoppedRow) || (show === 'stopped' && stoppedRow); });
  useEffect(() => { if (focus && refs.current[focus]) { refs.current[focus].scrollIntoView({ behavior: 'smooth', block: 'center' }); const t = setTimeout(clearFocus, 2500); return () => clearTimeout(t); } }, [focus, list.length]);
  const markRead = async (s, on = true) => { await supabase.from('sales_email_sends').update({ read_at: on ? new Date().toISOString() : null, read_by: on ? me.id : null }).eq('id', s.id); reload(); };
  const markAnswered = async (l, on) => { await supabase.from('sales_leads').update({ answered_at: on ? new Date().toISOString() : null, last_touch_at: new Date().toISOString(), assigned_to: l.assigned_to || (rep ? me.id : null) }).eq('id', l.id); reload(); };
  const setReply = async (s, reply_type) => {
    await supabase.from('sales_email_sends').update({ reply_type }).eq('id', s.id);
    const { data: cur } = await supabase.from('fin_settings').select('value').eq('key', 'reply_tags').maybeSingle();
    await supabase.from('fin_settings').upsert({ key: 'reply_tags', value: { ...(cur?.value || {}), [s.lead_email.toLowerCase()]: reply_type } });
    if (reply_type === 'Negative') { const r = await ownerFn({ action: 'smartlead_stop_lead', email: s.lead_email }); say(r, r.error ? null : 'Marked do-not-contact — unsubscribed in Smartlead, blocked, out of the call queue.'); }
    reload();
  };
  const stopLead = async (s) => { if (!window.confirm(`Stop ${s.lead_name || s.lead_email}? No more emails go to them and this leaves your inbox.`)) return; await supabase.from('sales_email_sends').update({ read_at: new Date().toISOString(), read_by: me.id }).eq('id', s.id); const r = await ownerFn({ action: 'smartlead_stop_lead', email: s.lead_email }); say(r, r.error ? null : 'Stopped — unsubscribed in Smartlead and out of the inbox.'); reload(); };
  return (
    <>
      <div className="opsbar wrap">
        {picker}
        <span className="seg tight"><button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All</button><button className={show === 'unread' ? 'on' : ''} onClick={() => setShow('unread')}>Unread ({unread})</button><button className={show === 'open' ? 'on' : ''} onClick={() => setShow('open')}>Needs answer</button><button className={show === 'stopped' ? 'on' : ''} onClick={() => setShow('stopped')}>Stopped</button></span>
        {!rep && <select value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{people.map((p) => <option key={p.id} value={p.id}>{(p.full_name || p.email).split(' ')[0]}</option>)}</select>}
        <span className="sm">{rep ? 'Replies handed to you. Answer from Gmail, then mark it answered.' : `Synced ${ago(status?.smartlead_last_sync?.at)}`}</span>
        <div className="spacer" />
        {!rep && <button className="btn-sm" disabled={busy || !status?.smartlead_key_set} onClick={sync}>{busy ? 'Syncing…' : 'Sync'}</button>}
      </div>
      <div className="replies">
        {list.length === 0 && <div className="card"><div className="empty">{show === 'unread' ? 'Nothing unread.' : 'No replies here.'}</div></div>}
        {list.map((s) => { const l = leads.find((x) => x.id === s.lead_id); const unreadRow = !s.read_at; return (
          <div key={s.id} ref={(el) => { refs.current[s.id] = el; }} className={`card reply ${s.reply_type ? s.reply_type.toLowerCase().replace(/[^a-z]/g, '') : 'untagged'} ${unreadRow ? 'unread' : ''} ${focus === s.id ? 'focus' : ''}`} onClick={() => unreadRow && markRead(s)}>
            <div className="cardhead">
              <div className="rwho">{unreadRow && <i className="dot" />}<div><b>{s.lead_name || l?.company || s.lead_email}</b>{l?.company && s.lead_name && <span className="sm"> · {l.company}</span>}<div className="sm">{s.lead_email}{l?.filter_id ? ` · list ${l.filter_id}` : ''} · step {s.step}{s.reply_at ? ` · ${ago(s.reply_at)}` : ''}</div></div></div>
              <div className="replyacts">
                <a className="btn-xs primary" href={kit.link(s.lead_email, s.subject, l || { contact_name: s.lead_name })} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Reply</a>
                {l && l.stage !== 'dnc' && (l.answered_at ? <button className="btn-xs ok" title="Click to undo" onClick={(e) => { e.stopPropagation(); markAnswered(l, false); }}>✓ Answered {new Date(l.answered_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</button> : <button className="btn-xs" onClick={(e) => { e.stopPropagation(); markAnswered(l, true); }}>Mark answered</button>)}
                {rep ? (s.reply_type && <span className="pill">{s.reply_type}</span>) : <select className="statusselect" value={s.reply_type || ''} onClick={(e) => e.stopPropagation()} onChange={(e) => setReply(s, e.target.value)}><option value="">tag it</option>{['Positive', 'Neutral', 'Negative', 'Auto-reply', 'Bounce-back'].map((t) => <option key={t}>{t}</option>)}</select>}
                {l && <span className={`statuspill ${stageClass(l.stage)}`}>{stageLabel(l.stage)}</span>}
                {l && l.stage !== 'dnc' ? <button className="btn-xs bad" onClick={(e) => { e.stopPropagation(); stopLead(s); }}>Stop</button> : <span className="pill error">stopped</span>}
                {!rep && l?.assigned_to && <span className="pill">{(people.find((p) => p.id === l.assigned_to)?.full_name || '').split(' ')[0]}</span>}
                {l && <button className="btn-xs" onClick={(e) => { e.stopPropagation(); openLead(l); }}>Open contact</button>}
                {l && l.stage !== 'dnc' && <button className="btn-xs" title="Move this conversation into your Gmail inbox view and answer it from there" onClick={(e) => { e.stopPropagation(); moveToEmail(s, l); }}>Move to Email →</button>}
                {!unreadRow && <button className="btn-xs" title="Mark unread" onClick={(e) => { e.stopPropagation(); markRead(s, false); }}>●</button>}
              </div>
            </div>
            {s.reply_body ? <pre className="replybody">{s.reply_body}</pre> : <div className="sm">Reply text arrives on the next sync.</div>}
            <div className="sm replyre">Re: {s.subject}</div>
          </div>
        ); })}
      </div>
    </>
  );
}


/* =================== Email: the rep's own Gmail — whole inbox, they decide what's a lead, reply from here =================== */
const FREE_MAIL = /(gmail|yahoo|hotmail|outlook|icloud|aol|proton|me)\.com$|\.edu$/i;
const initials = (name, email) => ((name || email || '?').trim()[0] || '?').toUpperCase();
function EmailInbox({ me, rep, leads, allLeads, mail, mailAccts, people, reload, say, openLead, picker, focusLead }) {
  const kit = useReplyKit(me);
  const [who, setWho] = useState(me.id); const [show, setShow] = useState('all'); const [q, setQ] = useState(''); const [sel, setSel] = useState(focusLead ? `lead:${focusLead}` : null);
  const [thread, setThread] = useState(null); const [draft, setDraft] = useState(''); const [sending, setSending] = useState(false); const [busy, setBusy] = useState(false);
  const [compose, setCompose] = useState(null); const [leadForm, setLeadForm] = useState(null);
  const acct = mailAccts.find((a) => a.user_id === who); const myAcct = mailAccts.find((a) => a.user_id === me.id); const mineView = who === me.id;
  const canSend = mineView && !!myAcct && String(myAcct.scopes || '').includes('gmail.send');
  const myAddr = (acct?.email || '').toLowerCase();
  const rows = useMemo(() => mail.filter((m) => m.user_id === who), [mail, who]);
  const leadOf = (id) => (allLeads || leads).find((l) => l.id === id);
  // conversations: one per lead when known, else one per Gmail thread
  const threads = useMemo(() => {
    const g = new Map();
    for (const m of rows) {
      const key = m.lead_id ? `lead:${m.lead_id}` : `t:${m.thread_id || m.gmail_id}`;
      const other = m.is_sent ? (m.to_email || '').split(',')[0].trim().toLowerCase() : (m.from_email || '').toLowerCase();
      const t = g.get(key) || { key, msgs: [], unread: 0, hidden: true, other, name: null, lead: m.lead_id ? leadOf(m.lead_id) : null, leadId: m.lead_id };
      t.msgs.push(m); if (!m.is_sent && !m.read_at) t.unread++; if (!m.hidden) t.hidden = false; if (!m.is_sent && m.from_name && !t.name) t.name = m.from_name; if (!m.is_sent) t.other = (m.from_email || '').toLowerCase();
      g.set(key, t);
    }
    return [...g.values()].map((t) => ({ ...t, last: t.msgs[0] })).sort((a, b) => b.last.at.localeCompare(a.last.at));
  }, [rows, allLeads, leads]);
  const unread = threads.filter((t) => !t.hidden && t.unread).length;
  const list = threads.filter((t) => {
    if (show === 'hidden') return t.hidden; if (t.hidden) return false;
    if (show === 'unread' && !t.unread) return false; if (show === 'leads' && !t.leadId) return false; if (show === 'unsorted' && t.leadId) return false;
    const s = q.trim().toLowerCase(); if (!s) return true;
    return [t.other, t.name, t.lead?.company, t.last.subject, t.last.snippet].filter(Boolean).some((v) => v.toLowerCase().includes(s));
  });
  const cur = threads.find((t) => t.key === sel) || null;
  // open a thread: fetch bodies, mark unread inbound as read
  useEffect(() => {
    if (!cur) { setThread(null); return; }
    let live = true;
    const want = new Set(cur.msgs.map((m) => m.id)); supabase.from('gmail_messages').select('*').in('id', [...want]).order('at', { ascending: true }).then(({ data }) => { if (live) setThread((data || []).filter((m) => want.has(m.id))); });
    const un = cur.msgs.filter((m) => !m.is_sent && !m.read_at).map((m) => m.id);
    if (un.length && mineView) supabase.from('gmail_messages').update({ read_at: new Date().toISOString() }).in('id', un).then(() => reload());
    setDraft(''); setLeadForm(null);
    return () => { live = false; };
  }, [sel, cur?.msgs.length]);
  const connect = async () => { setBusy(true); const r = await ownerFn({ action: 'gmail_connect' }); setBusy(false); if (r.url) window.location.href = r.url; else say(r); };
  const check = async () => { setBusy(true); const r = await ownerFn({ action: 'gmail_sync', all: !rep && !mineView }); setBusy(false); const v = r.accounts?.[acct?.email]; say(r, r.ok ? (v && typeof v === 'object' ? `Checked — ${v.added} new, ${v.linked} matched to leads.` : 'Checked.') : null); reload(); };
  const send = async ({ to, subject, body, threadId, inReplyTo, leadId }) => {
    if (!body.trim()) { say({ error: 'Write something first.' }); return false; }
    setSending(true); const r = await ownerFn({ action: 'gmail_send', to, subject, body, thread_id: threadId, in_reply_to: inReplyTo, lead_id: leadId }); setSending(false);
    if (r.error) { say(r); return false; }
    say(null, `Sent to ${to}.`); await reload(); return true;
  };
  const reply = async () => {
    if (!cur) return; const lastIn = [...(thread || [])].reverse().find((m) => !m.is_sent) || thread?.[thread.length - 1];
    const subj = lastIn?.subject ? (/^re:/i.test(lastIn.subject) ? lastIn.subject : `Re: ${lastIn.subject}`) : 'Re:';
    const realThread = cur.msgs.find((m) => m.thread_id && !String(m.thread_id).startsWith('sl:'))?.thread_id || null;
    if (await send({ to: cur.other, subject: subj, body: draft, threadId: realThread, inReplyTo: lastIn?.message_id_hdr || null, leadId: cur.leadId || null })) setDraft('');
  };
  const useTemplate = () => { const l = cur?.lead || { contact_name: cur?.name || '', company: '' }; setDraft(fillTpl(kit.tpl.reply_body, l, me, kit.booking) + (kit.tpl.signature ? `\n${fillTpl(kit.tpl.signature, l, me, kit.booking)}` : '')); };
  const hide = async (t, on = true) => { await supabase.from('gmail_messages').update({ hidden: on }).in('id', t.msgs.map((m) => m.id)); setSel(null); reload(); };
  // make (or link) a lead from a thread, then attach every message with that address to it
  const startLeadForm = (t) => { const dom = (t.other.split('@')[1] || '').toLowerCase(); const existing = !FREE_MAIL.test(dom) ? (allLeads || leads).find((l) => (l.domain || '').toLowerCase() === dom || (l.email || '').toLowerCase() === t.other) : (allLeads || leads).find((l) => (l.email || '').toLowerCase() === t.other); setLeadForm({ company: existing?.company || (FREE_MAIL.test(dom) ? '' : dom.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())), contact_name: t.name || '', email: t.other, domain: FREE_MAIL.test(dom) ? '' : dom, existing }); };
  const saveLead = async (t) => {
    const f = leadForm; let leadId = f.existing?.id;
    if (leadId) { await supabase.from('sales_leads').update({ email: f.existing.email || f.email, contact_name: f.existing.contact_name || f.contact_name, assigned_to: f.existing.assigned_to || me.id, ...(['new', 'contacted'].includes(f.existing.stage) ? { stage: 'replied' } : {}), last_touch_at: new Date().toISOString() }).eq('id', leadId); }
    else { const { data, error } = await supabase.from('sales_leads').insert({ company: f.company || f.email, contact_name: f.contact_name || null, email: f.email, domain: f.domain || null, source: 'inbound', stage: 'replied', assigned_to: me.id, last_touch_at: new Date().toISOString(), notes: 'Came in by email.' }).select('id').single(); if (error) { say({ error: error.message }); return; } leadId = data.id; }
    const ids = rows.filter((m) => (m.from_email || '').toLowerCase() === f.email || (m.to_email || '').toLowerCase().includes(f.email)).map((m) => m.id);
    await supabase.from('gmail_messages').update({ lead_id: leadId }).in('id', ids.length ? ids : t.msgs.map((m) => m.id));
    setLeadForm(null); setSel(`lead:${leadId}`); await reload(); say(null, f.existing ? `Linked to ${f.existing.company}.` : 'Added as a lead — it is in your pipeline under Replied.');
  };
  const dateish = (iso) => { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  const whoName = (id) => (people.find((p) => p.id === id)?.full_name || '').split(' ')[0];

  if (!acct) return (
    <>
      <div className="opsbar wrap">{picker}{!rep && <select value={who} onChange={(e) => { setWho(e.target.value); setSel(null); }}>{people.map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? 'My inbox' : `${whoName(p.id)}'s inbox`}</option>)}</select>}</div>
      <div className="card"><div className="empty">{mineView ? <>Your Gmail isn't connected yet. <button className="btn-sm primary" disabled={busy} onClick={connect}>{busy ? 'Opening Google…' : 'Connect Gmail'}</button><div className="sm" style={{ marginTop: 8 }}>Read + send on your own mailbox. Nothing goes out without you hitting Send.</div></> : `${whoName(who)} hasn't connected Gmail yet (they do it from Sales → Settings).`}</div></div>
    </>
  );
  return (
    <>
      <div className="opsbar wrap">
        {picker}
        {!rep && <select value={who} onChange={(e) => { setWho(e.target.value); setSel(null); }}>{people.map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? 'My inbox' : `${whoName(p.id)}'s inbox`}</option>)}</select>}
        <span className="seg tight"><button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All</button><button className={show === 'unread' ? 'on' : ''} onClick={() => setShow('unread')}>Unread ({unread})</button><button className={show === 'leads' ? 'on' : ''} onClick={() => setShow('leads')}>Leads</button><button className={show === 'unsorted' ? 'on' : ''} onClick={() => setShow('unsorted')}>Unsorted</button><button className={show === 'hidden' ? 'on' : ''} onClick={() => setShow('hidden')}>Not leads</button></span>
        <input className="search" placeholder="Search mail…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="sm">{acct.email} · checked {ago(acct.last_sync_at)}</span>
        <div className="spacer" />
        {mineView && <button className="btn-sm" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check now'}</button>}
        {mineView && <button className="btn-sm primary" onClick={() => setCompose({ to: '', subject: fillTpl(kit.tpl.reply_subject, {}, me, kit.booking), body: fillTpl(kit.tpl.reply_body, {}, me, kit.booking) + (kit.tpl.signature ? `\n${fillTpl(kit.tpl.signature, {}, me, kit.booking)}` : '') })}>New email</button>}
      </div>
      {myAcct && mineView && !canSend && <div className="msg warn">Sending from here needs one more permission — <button className="linkbtn" onClick={connect}>reconnect Gmail</button> and tick "Send email on your behalf". Reading works already.</div>}
      <div className="card mailgrid">
        <div className="mlist">
          {list.length === 0 && <div className="empty">{rows.length === 0 ? 'Nothing pulled in yet — hit Check now.' : 'Nothing here.'}</div>}
          {list.map((t) => <button key={t.key} className={`mrow ${t.unread ? 'unread' : ''} ${sel === t.key ? 'on' : ''}`} onClick={() => setSel(t.key)}>
            <span className={`av ${t.leadId ? 'lead' : ''}`}>{initials(t.lead?.company || t.name, t.other)}</span>
            <span className="mmain"><span className="mtop"><b>{t.lead?.company || t.name || t.other}</b><span className="when">{dateish(t.last.at)}</span></span><span className="msub">{t.last.is_sent ? 'You: ' : ''}{t.last.subject}</span><span className="msnip">{t.last.snippet}</span>
              <span className="mtags">{t.leadId ? <span className={`statuspill ${stageClass(t.lead?.stage)}`}>{stageLabel(t.lead?.stage)}</span> : <span className="pill muted">unsorted</span>}{t.msgs.length > 1 && <span className="sm">{t.msgs.length} msgs</span>}</span></span>
            {t.unread ? <i className="dot" /> : null}
          </button>)}
        </div>
        <div className="mthread">
          {!cur && <div className="empty">Pick a conversation. Unsorted ones aren't leads yet — open one and decide.</div>}
          {cur && (
            <>
              <div className="mhead">
                <div><b>{cur.lead?.company || cur.name || cur.other}</b><div className="sm">{cur.name && cur.lead?.company ? `${cur.name} · ` : ''}{cur.other}{cur.lead?.assigned_to && !rep ? ` · ${whoName(cur.lead.assigned_to)}` : ''}</div></div>
                <div className="spacer" />
                {cur.lead ? <><span className={`statuspill ${stageClass(cur.lead.stage)}`}>{stageLabel(cur.lead.stage)}</span><button className="btn-xs" onClick={() => openLead(cur.lead)}>Open contact</button></>
                  : mineView && !cur.hidden && <><button className="btn-xs primary" onClick={() => (leadForm ? setLeadForm(null) : startLeadForm(cur))}>{leadForm ? 'Cancel' : 'This is a lead'}</button><button className="btn-xs" onClick={() => hide(cur)}>Not a lead</button></>}
                {cur.hidden && mineView && <button className="btn-xs" onClick={() => hide(cur, false)}>Put back</button>}
              </div>
              {leadForm && <div className="leadform">
                {leadForm.existing ? <div className="sm">Already in your contacts as <b>{leadForm.existing.company}</b> — this links the conversation to them.</div> : <div className="addgrid two"><label>Company<input value={leadForm.company} onChange={(e) => setLeadForm({ ...leadForm, company: e.target.value })} /></label><label>Contact<input value={leadForm.contact_name} onChange={(e) => setLeadForm({ ...leadForm, contact_name: e.target.value })} /></label><label>Email<input value={leadForm.email} readOnly /></label><label>Website<input value={leadForm.domain} onChange={(e) => setLeadForm({ ...leadForm, domain: e.target.value })} /></label></div>}
                <div className="row"><button className="btn-sm primary" onClick={() => saveLead(cur)}>{leadForm.existing ? 'Link it' : 'Add to my leads'}</button><span className="sm">Goes into your pipeline as Replied, assigned to you.</span></div>
              </div>}
              <div className="mmsgs">
                {(thread || []).map((m) => <div key={m.id} className={`mmsg ${m.is_sent ? 'out' : 'in'}`}><div className="mmeta"><b>{m.is_sent ? 'You' : (m.from_name || m.from_email)}</b><span className="sm">{m.is_sent ? `to ${m.to_email}` : m.from_email} · {new Date(m.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div><div className="msubj">{m.subject}</div><pre>{m.body || m.snippet}</pre></div>)}
                {thread === null && <div className="empty">Loading…</div>}
              </div>
              {mineView && !cur.hidden && <div className="mreply">
                <textarea rows={5} placeholder={`Reply to ${cur.name || cur.other}…`} value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="row"><button className="btn-sm" onClick={useTemplate}>Use my template</button><a className="btn-sm" href={kit.link(cur.other, cur.last.subject, cur.lead || { contact_name: cur.name })} target="_blank" rel="noreferrer">Open in Gmail</a><div className="spacer" /><button className="btn-sm primary" disabled={sending || !canSend} title={canSend ? '' : 'Reconnect Gmail to send from here'} onClick={reply}>{sending ? 'Sending…' : `Send from ${acct.email}`}</button></div>
              </div>}
            </>
          )}
        </div>
      </div>
      {compose && <div className="overlay" onClick={() => setCompose(null)}><div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="cardhead"><h3>New email</h3><span className="sm">from {acct.email}</span><div className="spacer" /><button className="btn-xs" onClick={() => setCompose(null)}>×</button></div>
        <div className="addgrid two"><label className="wide2">To<input autoFocus placeholder="name@brand.com" value={compose.to} onChange={(e) => { const to = e.target.value; const l = (allLeads || leads).find((x) => (x.email || '').toLowerCase() === to.trim().toLowerCase()); setCompose({ ...compose, to, lead: l || null, ...(l ? { subject: fillTpl(kit.tpl.reply_subject, l, me, kit.booking), body: fillTpl(kit.tpl.reply_body, l, me, kit.booking) + (kit.tpl.signature ? `\n${fillTpl(kit.tpl.signature, l, me, kit.booking)}` : '') } : {}) }); }} /></label>
          <label className="wide2">Subject<input value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} /></label>
          <label className="wide2">Message<textarea rows={10} value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} /></label></div>
        {compose.lead && <div className="sm">Matches your contact <b>{compose.lead.company}</b> — this counts as a touch.</div>}
        <div className="row" style={{ marginTop: 10 }}><div className="spacer" /><button className="btn-sm" onClick={() => setCompose(null)}>Cancel</button><button className="btn-sm primary" disabled={sending || !canSend} onClick={async () => { if (await send({ to: compose.to.trim(), subject: compose.subject, body: compose.body, leadId: compose.lead?.id || null })) setCompose(null); }}>{sending ? 'Sending…' : 'Send'}</button></div>
      </div></div>}
    </>
  );
}


/* =================== Duplicates: same company / email / website under more than one row =================== */
const normCo = (t) => (t || '').toLowerCase().replace(/\b(the|llc|inc|co|company|corp|corporation|ltd|limited|store|shop|official)\b/g, '').replace(/[^a-z0-9]/g, '').replace(/s$/, '');
export function findDupes(leads) {
  const by = new Map(); const add = (k, l) => { if (!k) return; const a = by.get(k) || new Set(); a.add(l.id); by.set(k, a); };
  for (const l of leads) { const nc = normCo(l.company); if (nc.length >= 4) add(`c:${nc}`, l); if (l.email) add(`e:${l.email.toLowerCase()}`, l); if (l.domain) add(`d:${l.domain.toLowerCase().replace(/^www\./, '')}`, l); }
  // union the keys into groups
  const parent = new Map(); const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const l of leads) parent.set(l.id, l.id);
  for (const ids of by.values()) { const [a, ...rest] = [...ids]; for (const b of rest) parent.set(find(b), find(a)); }
  const groups = new Map(); for (const l of leads) { const r = find(l.id); const g = groups.get(r) || []; g.push(l); groups.set(r, g); }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => (STAGE_RANK[b.stage] || 0) - (STAGE_RANK[a.stage] || 0) || filled(b) - filled(a) || (a.created_at || '').localeCompare(b.created_at || '')));
}
const STAGE_RANK = { dnc: 90, signed: 80, quoted: 50, call_booked: 40, replied: 30, contacted: 20, new: 10, lost: 5 };
const filled = (l) => ['email', 'phone', 'contact_name', 'domain', 'city', 'notes', 'org_id', 'assigned_to'].filter((k) => l[k]).length;
function DupModal({ groups, onClose, reload, say }) {
  const [keep, setKeep] = useState(() => Object.fromEntries(groups.map((g, i) => [i, g[0].id]))); const [busy, setBusy] = useState(null);
  const merge = async (i) => { const g = groups[i]; const k = keep[i]; setBusy(i); const { error } = await supabase.rpc('merge_leads', { p_keep: k, p_drop: g.filter((l) => l.id !== k).map((l) => l.id) }); setBusy(null); if (error) return say({ error: error.message }); say(null, `Merged ${g.length} rows into one.`); reload(); };
  const mergeAll = async () => { setBusy('all'); for (let i = 0; i < groups.length; i++) { const g = groups[i]; const k = keep[i]; const { error } = await supabase.rpc('merge_leads', { p_keep: k, p_drop: g.filter((l) => l.id !== k).map((l) => l.id) }); if (error) { setBusy(null); return say({ error: error.message }); } } setBusy(null); say(null, `Merged ${groups.length} duplicate groups.`); reload(); onClose(); };
  return (
    <div className="overlay" onClick={onClose}><div className="modal wide" onClick={(e) => e.stopPropagation()}>
      <div className="cardhead"><h3>Duplicates</h3><span className="sm">Same company, email or website on more than one row. Pick the row to keep — calls, emails, quotes and notes from the others move onto it.</span><div className="spacer" /><button className="btn-xs" onClick={onClose}>×</button></div>
      <div className="dupgroups">
        {groups.map((g, i) => <div key={i} className="dupgroup">
          {g.map((l) => <label key={l.id} className={`duprow ${keep[i] === l.id ? 'on' : ''}`}><input type="radio" name={`k${i}`} checked={keep[i] === l.id} onChange={() => setKeep({ ...keep, [i]: l.id })} />
            <span className="dmain"><b>{l.company || l.domain || l.email}</b><span className="sm">{[l.contact_name, l.email, l.phone, l.domain, l.city].filter(Boolean).join(' · ') || 'no details'}</span></span>
            <span className={`statuspill ${stageClass(l.stage)}`}>{stageLabel(l.stage)}</span><span className="sm">{srcLabelPlain(l.source)}{l.filter_id ? ` · ${l.filter_id}` : ''}</span><span className="sm">{l.org_id ? 'client' : ''}</span>
          </label>)}
          <div className="row"><span className="sm">keep the checked one</span><div className="spacer" /><button className="btn-sm primary" disabled={busy !== null} onClick={() => merge(i)}>{busy === i ? 'Merging…' : `Merge ${g.length} → 1`}</button></div>
        </div>)}
      </div>
      {groups.length > 1 && <div className="row" style={{ marginTop: 12 }}><div className="spacer" /><button className="btn-sm" disabled={busy !== null} onClick={mergeAll}>{busy === 'all' ? 'Merging…' : `Merge all ${groups.length} groups`}</button></div>}
    </div></div>
  );
}

/* =================== Campaign cards (Strategies page) =================== */
export function CampaignCards({ status, say, reload }) {
  const [camp, setCamp] = useState(null); const [busy, setBusy] = useState(false); const [goals] = useGoals();
  const loadCamp = async () => { const r = await ownerFn({ action: 'smartlead_campaign' }); if (!r.error) setCamp(r.campaigns || []); else say?.(r); };
  useEffect(() => { loadCamp(); }, []);
  const setStatus = async (c, st) => { if (st !== 'START' && !window.confirm(`${st === 'PAUSED' ? 'Pause' : 'Stop'} “${c.name}”?`)) return; setBusy(true); const r = await ownerFn({ action: 'smartlead_status', campaign_id: c.id, status: st }); setBusy(false); say?.(r, r.error ? null : st === 'START' ? 'Campaign running.' : 'Campaign paused.'); loadCamp(); };
  const weekends = async (c, on) => { if (on && !window.confirm('Send on Saturdays and Sundays too? Weekend cold email gets fewer replies and more spam flags.')) return; setBusy(true); const r = await ownerFn({ action: 'smartlead_schedule', campaign_id: c.id, weekends: on }); setBusy(false); say?.(r, r.error ? null : on ? 'Sending 7 days a week.' : 'Sending Monday–Friday.'); loadCamp(); };
  const sync = async () => { setBusy(true); const r = await ownerFn({ action: 'smartlead_sync' }); setBusy(false); say?.(r, r.error ? null : 'Smartlead synced.'); reload?.(); loadCamp(); };
  const g = goalsFor(goals, null);
  if (camp === null) return <div className="card"><div className="empty">Checking the campaign…</div></div>;
  return camp.map((c) => { const lim = c.daily_limit || 0; const goal = g.emails_day || lim; const p = goal ? Math.min(1, c.sent_today / goal) : 0; const running = c.status === 'ACTIVE' || c.status === 'START'; const wk = Array.isArray(c.days) && c.days.includes(0); const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; return (
    <div key={c.id} className="card campaign">
      <div className="cardhead">
        <div><h3>{c.name}</h3><div className="sm">Smartlead · {Array.isArray(c.days) ? c.days.map((d) => dow[d]).join(' ') : ''}{c.hours ? ` · ${c.hours}` : ''}{lim ? ` · up to ${num(lim)} new leads/day` : ''}</div></div>
        <span className={`statuspill ${running ? 'ok' : c.status === 'PAUSED' ? 'warn' : 'muted'}`}>{running ? 'Running' : c.status === 'PAUSED' ? 'Paused' : c.status}</span>
        <div className="spacer" />
        <label className="chk sm"><input type="checkbox" checked={wk} disabled={busy} onChange={(e) => weekends(c, e.target.checked)} /> weekends</label>
        {running ? <button className="btn-sm" disabled={busy} onClick={() => setStatus(c, 'PAUSED')}>Pause</button> : <button className="btn-sm primary" disabled={busy} onClick={() => setStatus(c, 'START')}>{c.status === 'PAUSED' ? 'Resume' : 'Start'}</button>}
        <button className="btn-sm" disabled={busy || !status?.smartlead_key_set} onClick={sync}>{busy ? '…' : 'Sync'}</button>
      </div>
      <div className="today">
        <div className="prog"><div className="lbl"><b>Today</b><span>{num(c.sent_today)} of {num(goal)} emails · {num(c.replied_today)} replied</span></div><div className="bar"><i style={{ width: `${p * 100}%`, background: p >= 1 ? '#1E9E6F' : undefined }} /></div></div>
        {c.analytics && <div className="board camp">
          <div><b>{num(c.analytics.total_leads)}</b><small>leads in campaign</small></div>
          <div><b>{num(c.analytics.in_progress)}</b><small>in sequence</small></div>
          <div><b>{num(c.analytics.not_started)}</b><small>not started</small></div>
          <div><b>{num(c.analytics.completed)}</b><small>finished</small></div>
          <div><b>{num(c.analytics.sent)}</b><small>emails sent</small></div>
          <div><b>{num(c.analytics.replies)}</b><small>replies</small></div>
        </div>}
      </div>
    </div>
  ); });
}


export function LeadForm({ sources, onClose, reload, say, fixedSource, title = 'Add a lead', defaultStage = 'new', claimAs = null, openExisting = null }) {
  const [f, setF] = useState({ source: fixedSource || 'other', filter_id: '', company: '', domain: '', contact_name: '', email: '', phone: '', title: '', city: '', state: '', est_sales_usd: '', deal_value: '', stage: defaultStage, notes: '', in_calls: true });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); if (!f.company && !f.email && !f.domain) return say({ error: 'Give at least a company, email or domain.' }); setBusy(true);
    const row = { ...f, est_sales_usd: f.est_sales_usd ? Number(f.est_sales_usd) : null, deal_value: f.deal_value ? Number(f.deal_value) : null, domain: cleanDomain(f.domain), filter_id: f.filter_id || null, won_at: f.stage === 'signed' ? new Date().toISOString() : null, last_touch_at: f.stage === 'new' ? null : new Date().toISOString(), assigned_to: claimAs };
    const dup = await findExisting({ email: row.email, domain: row.domain, company: row.company });
    if (dup) { setBusy(false); const { data: ex } = await supabase.from('sales_leads').select('company, email, stage').eq('id', dup).maybeSingle(); if (!window.confirm(`${ex?.company || ex?.email || 'This company'} is already in the system (${stageLabel(ex?.stage)}). Open that one instead of adding a copy?`)) return; onClose(); openExisting?.(dup); return; }
    const { error } = await supabase.from('sales_leads').insert(row); setBusy(false);
    if (error) return say({ error: /duplicate/i.test(error.message) ? 'That domain or email is already in the list.' : error.message });
    say(null, 'Lead added.'); reload(); onClose();
  };
  return (
    <div className="overlay" onClick={onClose}><form className="modal wide" onClick={(e) => e.stopPropagation()} onSubmit={save}>
      <h3>{title}</h3>
      <div className="addgrid lead">
        {!fixedSource && <label>Channel<select value={f.source} onChange={set('source')}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>}
        <label>Status<select value={f.stage} onChange={set('stage')}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Deal value $ / mo<input type="number" value={f.deal_value} onChange={set('deal_value')} placeholder="expected services" /></label>
        <label>List / partner name<input value={f.filter_id} onChange={set('filter_id')} placeholder="e.g. Fulfill.com Nov" /></label>
        <label>Company<input value={f.company} onChange={set('company')} autoFocus /></label>
        <label>Domain<input value={f.domain} onChange={set('domain')} placeholder="brand.com" /></label>
        <label>Contact<input value={f.contact_name} onChange={set('contact_name')} /></label>
        <label>Title<input value={f.title} onChange={set('title')} /></label>
        <label>Email<input value={f.email} onChange={set('email')} /></label>
        <label>Phone<input value={f.phone} onChange={set('phone')} /></label>
        <label>City<input value={f.city} onChange={set('city')} /></label>
        <label>State<input value={f.state} onChange={set('state')} /></label>
        <label>Est. sales $/mo<input type="number" value={f.est_sales_usd} onChange={set('est_sales_usd')} /></label>
        <label className="chk"><input type="checkbox" checked={f.in_calls} onChange={(e) => setF({ ...f, in_calls: e.target.checked })} /> put in the call queue</label>
        <label className="wide2">Notes<textarea rows={2} value={f.notes} onChange={set('notes')} /></label>
      </div>
      <div className="row"><button type="button" className="btn-sm" onClick={onClose}>Cancel</button><button className="btn-sm primary" disabled={busy}>Add</button></div>
    </form></div>
  );
}
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const cleanDomain = (d) => (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;


function ImportCsv({ sources, onClose, reload, say }) {
  const [parsed, setParsed] = useState(null); const [map, setMap] = useState({}); const [source, setSource] = useState('other'); const [list, setList] = useState(''); const [inCalls, setInCalls] = useState(true);
  const [prog, setProg] = useState(null); const fileRef = useRef();
  const onFile = async (file) => { const text = await file.text(); const p = parseCsv(text); setParsed(p); setMap(guessColumns(p.headers)); if (!list) setList(file.name.replace(/\.csv$/i, '')); };
  const run = async () => {
    const rows = parsed.rows.map((r) => {
      const g = (k) => (map[k] ? r[map[k]] : '');
      const sales = g('est_sales_usd').replace(/[^0-9.]/g, '');
      return { source, filter_id: list || null, company: g('company') || null, domain: cleanDomain(g('domain')), contact_name: g('contact_name') || null, email: g('email').toLowerCase() || null, phone: g('phone') || null, title: g('title') || null, city: g('city') || null, state: g('state') || null, est_sales_usd: sales ? Math.round(Number(sales)) : null, products: g('products') ? Number(g('products')) || null : null, categories: g('categories') || null, notes: g('notes') || null, in_calls: inCalls };
    }).filter((r) => r.company || r.domain || r.email);
    let ok = 0, dup = 0, bad = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await supabase.from('sales_leads').insert(chunk);
      if (!error) ok += chunk.length;
      else for (const r of chunk) { const { error: e2 } = await supabase.from('sales_leads').insert(r); if (!e2) ok++; else if (/duplicate/i.test(e2.message)) dup++; else bad++; }
      setProg({ done: Math.min(i + 200, rows.length), total: rows.length, ok, dup, bad });
    }
    say(null, `Imported ${ok} leads${dup ? `, ${dup} already there` : ''}${bad ? `, ${bad} failed` : ''}.`); reload(); onClose();
  };
  const FIELDS = [['company', 'Company'], ['domain', 'Domain / website'], ['contact_name', 'Contact name'], ['email', 'Email'], ['phone', 'Phone'], ['title', 'Title'], ['city', 'City'], ['state', 'State'], ['est_sales_usd', 'Est. sales'], ['products', 'Products'], ['categories', 'Categories'], ['notes', 'Notes']];
  return (
    <div className="overlay" onClick={onClose}><div className="modal wide" onClick={(e) => e.stopPropagation()}>
      <h3>Import leads from a CSV</h3>
      <p className="lead">Any CSV — Storeleads export, a partner’s list, Apollo. Duplicates (same domain or email) are skipped, so re-importing is safe.</p>
      {!parsed ? (
        <div className="drop" onClick={() => fileRef.current.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}>
          <b>Drop a CSV here or click to choose</b><span>First row must be the column names.</span>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
        </div>
      ) : (
        <>
          <div className="addgrid lead">
            <label>Channel<select value={source} onChange={(e) => setSource(e.target.value)}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
            <label>List name<input value={list} onChange={(e) => setList(e.target.value)} /></label>
            <label className="chk"><input type="checkbox" checked={inCalls} onChange={(e) => setInCalls(e.target.checked)} /> put in the call queue</label>
          </div>
          <div className="mapgrid">{FIELDS.map(([k, l]) => <label key={k}><span>{l}</span><select value={map[k] || ''} onChange={(e) => setMap({ ...map, [k]: e.target.value })}><option value="">— skip —</option>{parsed.headers.map((h) => <option key={h}>{h}</option>)}</select></label>)}</div>
          <p className="note">{parsed.rows.length} rows found. First one: <code>{Object.values(parsed.rows[0] || {}).slice(0, 5).join(' · ')}</code></p>
          {prog && <div className="bar"><i style={{ width: `${(prog.done / prog.total) * 100}%` }} /></div>}
          <div className="row"><button className="btn-sm" onClick={() => setParsed(null)}>Different file</button><div className="spacer" /><button className="btn-sm primary" disabled={!!prog} onClick={run}>{prog ? `${prog.done} / ${prog.total}…` : `Import ${parsed.rows.length} leads`}</button></div>
        </>
      )}
    </div></div>
  );
}


export function Score({ title, rows }) {
  return (
    <div className="card"><h3>{title}</h3>
      <table className="ordertable fin"><thead><tr><th /><th className="n">Sent</th><th className="n">People</th><th className="n">Replied</th><th className="n">Reply %</th><th className="n">Positive</th><th className="n">Bounced</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.k}><td><b>{r.k}</b></td><td className="n">{num(r.sent)}</td><td className="n">{num(r.leads)}</td><td className="n">{num(r.replied)}</td><td className="n">{pct(r.replied / (r.leads || 1), 1)}</td><td className="n">{num(r.pos)}</td><td className="n">{num(r.bounced)}</td></tr>)}</tbody></table>
    </div>
  );
}


/* =================== Calls =================== */
const OUTCOMES = [['no_answer', 'No answer', ''], ['voicemail', 'Voicemail', ''], ['gatekeeper', 'Gatekeeper', 'warn'], ['connected', 'Connected', 'ok'], ['booked', 'Booked a call', 'ok solid'], ['not_fit', 'Not a fit', 'bad'], ['wrong_number', 'Wrong number', 'bad'], ['dnc', 'Do not call', 'bad']];
const PICKUP = new Set(['gatekeeper', 'connected', 'booked', 'not_fit']); const CONNECT = new Set(['connected', 'booked', 'not_fit']);
const grade = (bookedPer100, dials) => (dials < 30 ? '—' : bookedPer100 >= 3 ? 'A' : bookedPer100 >= 1.5 ? 'B' : bookedPer100 >= 0.5 ? 'C' : 'D');

function Calls({ me, rep, leads, people, reload, say, openLead }) {
  const [list, setList] = useState(''); const [who, setWho] = useState(''); const kit = useReplyKit(me); const booking = kit.booking; const [calls, setCalls] = useState([]); const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(() => { try { return JSON.parse(sessionStorage.getItem('shipbay-call-session') || 'null'); } catch { return null; } });
  const [cur, setCur] = useState(null); const [callStart, setCallStart] = useState(null); const [note, setNote] = useState(''); const [tick, setTick] = useState(0); const [skipped, setSkipped] = useState([]);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const loadCalls = async () => { const [c, s] = await Promise.all([fetchAll('sales_calls', '*', (q) => q.order('started_at', { ascending: false })), fetchAll('sales_call_sessions', '*', (q) => q.order('started_at', { ascending: false }))]); setCalls(c); setSessions(s); };
  useEffect(() => { loadCalls(); }, []);

  const queue = useMemo(() => {
    const now = Date.now();
    return leads.filter((l) => l.in_calls && l.phone && !['dnc', 'lost', 'signed'].includes(l.stage) && (rep ? (!l.assigned_to || l.assigned_to === me.id) : (!who || (who === 'none' ? !l.assigned_to : l.assigned_to === who))) && (!list || l.filter_id === list) && !skipped.includes(l.id) && (!l.next_action_at || new Date(l.next_action_at).getTime() <= now))
      .sort((a, b) => (a.stage === 'replied' ? -1 : 0) - (b.stage === 'replied' ? -1 : 0) || (a.attempts || 0) - (b.attempts || 0) || (b.est_sales_usd || 0) - (a.est_sales_usd || 0));
  }, [leads, list, skipped, who]);
  const lead = cur ? leads.find((l) => l.id === cur) : queue[0];
  const repName = (id) => { const p = (people || []).find((x) => x.id === id); return p ? (p.full_name || p.email).split(' ')[0] : ''; };

  const startSession = async () => { const { data } = await supabase.from('sales_call_sessions').insert({ started_at: new Date().toISOString(), by_user: me.id, note: list || null }).select().single(); const s = { id: data.id, started_at: data.started_at }; setSession(s); sessionStorage.setItem('shipbay-call-session', JSON.stringify(s)); };
  const endSession = async () => { const secs = Math.round((Date.now() - new Date(session.started_at)) / 1000); await supabase.from('sales_call_sessions').update({ ended_at: new Date().toISOString(), seconds: secs }).eq('id', session.id); setSession(null); sessionStorage.removeItem('shipbay-call-session'); if (callStart) setCallStart(null); loadCalls(); };
  const startCall = () => { if (!session) startSession(); setCallStart(Date.now()); };
  const finish = async (outcome) => {
    if (!lead) return;
    const started = callStart || Date.now(); const secs = Math.round((Date.now() - started) / 1000);
    await supabase.from('sales_calls').insert({ lead_id: lead.id, started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(), seconds: secs, outcome, note: note || null, by_user: me.id });
    const next = { no_answer: 2, voicemail: 3, gatekeeper: 1, connected: 7 }[outcome];
    const patch = { attempts: (lead.attempts || 0) + 1, last_outcome: outcome, last_touch_at: new Date().toISOString(), next_action_at: next ? new Date(Date.now() + next * 86400000).toISOString() : null, assigned_to: lead.assigned_to || me.id };   // first touch claims the lead
    if (outcome === 'booked') patch.stage = 'call_booked'; else if (outcome === 'dnc') patch.stage = 'dnc'; else if (outcome === 'not_fit') patch.stage = 'lost';
    else if (outcome === 'wrong_number') { patch.in_calls = false; patch.tags = [...new Set([...(lead.tags || []), 'bad_number'])]; }
    else if (lead.stage === 'new') patch.stage = 'contacted';
    if (note) patch.notes = [lead.notes, `${new Date().toLocaleDateString()} ${outcome.replace('_', ' ')}: ${note}`].filter(Boolean).join('\n');
    if ((lead.attempts || 0) + 1 >= 4 && !['booked', 'connected', 'gatekeeper'].includes(outcome)) patch.in_calls = false;   // 4 tries with no human → park it
    await supabase.from('sales_leads').update(patch).eq('id', lead.id);
    if (outcome === 'dnc' && lead.email) ownerFn({ action: 'smartlead_stop_lead', email: lead.email });
    setCallStart(null); setNote(''); setCur(null); reload(); loadCalls();
  };
  const skip = () => { if (lead) setSkipped([...skipped, lead.id]); setCur(null); setCallStart(null); };
  const [emailed, setEmailed] = useState(null); const [emailLogging, setEmailLogging] = useState(false);
  const logEmail = async (l) => {
    setEmailLogging(true);
    await supabase.from('sales_touches').insert({ lead_id: l.id, kind: 'email_sent', note: note || null, by_user: me.id });
    const patch = { last_touch_at: new Date().toISOString(), last_outcome: 'email_sent', assigned_to: l.assigned_to || me.id }; if (l.stage === 'new') patch.stage = 'contacted';
    await supabase.from('sales_leads').update(patch).eq('id', l.id);
    setEmailLogging(false); setEmailed(null); say(null, `Email to ${l.company || l.email} logged.`); reload();
  };

  const board = useMemo(() => {
    const today = new Date().toDateString();
    const stat = (C) => { const dials = C.length; const pick = C.filter((c) => PICKUP.has(c.outcome)).length; const conn = C.filter((c) => CONNECT.has(c.outcome)).length; const booked = C.filter((c) => c.outcome === 'booked').length; const bad = C.filter((c) => c.outcome === 'wrong_number').length; const talk = C.filter((c) => CONNECT.has(c.outcome)).reduce((s, c) => s + c.seconds, 0); const per100 = dials ? (booked / dials) * 100 : 0; return { dials, pick, conn, booked, bad, talk, pickRate: dials ? pick / dials : 0, connRate: dials ? conn / dials : 0, per100, grade: grade(per100, dials), minPerConn: conn ? talk / 60 / conn : 0 }; };
    const todayCalls = calls.filter((c) => new Date(c.started_at).toDateString() === today);
    const byList = {}; for (const c of calls) { const k = leads.find((l) => l.id === c.lead_id)?.filter_id || '—'; (byList[k] = byList[k] || []).push(c); }
    const sessTime = (S) => S.reduce((s, x) => s + (x.seconds || (x.ended_at ? 0 : Math.round((Date.now() - new Date(x.started_at)) / 1000))), 0);
    return { today: stat(todayCalls), all: stat(calls), byList: Object.entries(byList).map(([k, C]) => ({ k, ...stat(C) })).sort((a, b) => b.dials - a.dials), timeToday: sessTime(sessions.filter((s) => new Date(s.started_at).toDateString() === today)), timeAll: sessTime(sessions) };
  }, [calls, sessions, leads, tick]);

  const sessSecs = session ? Math.round((Date.now() - new Date(session.started_at)) / 1000) : 0;
  const callSecs = callStart ? Math.round((Date.now() - callStart) / 1000) : 0;
  return (
    <>
      <div className="opsbar wrap">
        <select value={list} onChange={(e) => { setList(e.target.value); setCur(null); }}><option value="">All lists ({queue.length} ready{rep ? ' · untouched + yours' : ''})</option>{lists(leads).map((f) => <option key={f} value={f}>{listName(f)}</option>)}</select>
        {!rep && <select value={who} onChange={(e) => { setWho(e.target.value); setCur(null); }}><option value="">Everyone’s</option>{(people || []).map((p) => <option key={p.id} value={p.id}>{(p.full_name || p.email).split(' ')[0]}’s</option>)}<option value="none">Unassigned only</option></select>}
        {booking && <span className="sm">Book them: <a href={booking} target="_blank" rel="noreferrer">{booking.replace(/^https?:\/\//, '')}</a></span>}
        <div className="spacer" />
        {session ? <><span className="mono">Session {hhmm(sessSecs)} {mmss(sessSecs % 60)}</span><button className="btn-sm" onClick={endSession}>End session</button></> : <button className="btn-sm primary" onClick={startSession}>Start session</button>}
      </div>
      <div className="callgrid">
        <div className="card dialer">
          {!lead ? <div className="empty">Queue is empty for this list. Import more leads or clear the filter.</div> : (
            <>
              <div className="who"><small>{lead.filter_id ? listName(lead.filter_id) : srcLabelPlain(lead.source)} · try #{(lead.attempts || 0) + 1}{!rep && lead.assigned_to && lead.assigned_to !== me.id ? ` · ${repName(lead.assigned_to)}’s lead` : ''}{lead.stage === 'replied' && <span className="statuspill warn" style={{ marginLeft: 8 }}>replied to email</span>}</small>
                <h2 className="click" onClick={() => openLead(lead)} title="Open contact">{lead.company || lead.domain}</h2>
                <a className="phone" href={`tel:${lead.phone.replace(/[^+\d]/g, '')}`}>{lead.phone}</a>
                <div className="sm">{[lead.contact_name, lead.city, lead.state].filter(Boolean).join(' · ')}{lead.est_sales_usd ? ` · ~${money(lead.est_sales_usd)}/mo online` : ''}{lead.products ? ` · ${lead.products} products` : ''}{lead.plan ? ` · ${lead.plan}` : ''}</div>
                {lead.domain && <a className="sm" href={`https://${lead.domain}`} target="_blank" rel="noreferrer">{lead.domain} ↗</a>}
                {lead.notes && <pre className="notes">{lead.notes}</pre>}
              </div>
              <div className="timer">{callStart ? <><b>{mmss(callSecs)}</b><span>on the call</span></> : <button className="btn primary big" onClick={startCall}>Start call</button>}
                {lead.email && <span className="emailacts"><a className="btn-sm" href={kit.link(lead.email, null, lead)} target="_blank" rel="noreferrer" onClick={() => setEmailed(lead.id)}>Compose email</a><button className="btn-sm" disabled={emailLogging} onClick={() => logEmail(lead)}>{emailed === lead.id ? '✓ Mark email sent' : 'Mark email sent'}</button></span>}
              </div>
              <textarea className="callnote" rows={2} placeholder="One line: who you spoke to, what they said, when to call back…" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="outcomes">{OUTCOMES.map(([k, l, cls]) => <button key={k} className={`oc ${cls}`} onClick={() => finish(k)}>{l}</button>)}</div>
              <div className="row"><button className="btn-xs" onClick={skip}>Skip for now</button><div className="spacer" /><span className="sm">Next up: {queue.filter((q) => q.id !== lead.id).slice(0, 3).map((q) => q.company).join(' · ') || '—'}</span></div>
            </>
          )}
        </div>
        <div className="scorecol">
          <div className="card"><h3>Today</h3><Board s={board.today} time={board.timeToday} /></div>
          <div className="card"><h3>All time</h3><Board s={board.all} time={board.timeAll} /></div>
        </div>
      </div>
      <div className="card">
        <h3>Lists</h3>
        <p className="hint">Grade = booked calls per 100 dials (A ≥ 3 · B 1.5–3 · C 0.5–1.5 · D below). Graded after 30 dials.</p>
        <table className="ordertable fin"><thead><tr><th>List</th><th className="n">Dials</th><th className="n">Pick-up</th><th className="n">Connect</th><th className="n">Booked</th><th className="n">Booked / 100</th><th className="n">Bad numbers</th><th className="n">Min / connect</th><th>Grade</th></tr></thead>
          <tbody>{board.byList.map((r) => <tr key={r.k}><td><b className="mono">{r.k}</b>{LIST_NAMES[r.k] && <span className="sm"> {LIST_NAMES[r.k]}</span>}</td><td className="n">{r.dials}</td><td className="n">{pct(r.pickRate)}</td><td className="n">{pct(r.connRate)}</td><td className="n">{r.booked}</td><td className="n">{r.per100.toFixed(1)}</td><td className="n">{pct(r.dials ? r.bad / r.dials : 0)}</td><td className="n">{r.minPerConn.toFixed(1)}</td><td><b className={`grade g${r.grade}`}>{r.grade}</b></td></tr>)}
            {!board.byList.length && <tr><td colSpan={9} className="empty">No calls logged yet.</td></tr>}</tbody></table>
      </div>
    </>
  );
}
const _unused = (k) => ({ cold_call: 'Cold call list', cold_email: 'Cold email', fulfill_com: 'Fulfill.com', fulfilment_com: 'fulfilment.com', agency: 'Agency', referral: 'Referral', inbound: 'Inbound', linkedin: 'LinkedIn' }[k] || 'Other');
function Board({ s, time }) {
  return (
    <div className="board">
      <div><b>{s.dials}</b><small>dials</small></div>
      <div><b>{pct(s.pickRate)}</b><small>pick-up</small></div>
      <div><b>{pct(s.connRate)}</b><small>connect</small></div>
      <div><b className="hot">{s.booked}</b><small>booked</small></div>
      <div><b>{s.per100.toFixed(1)}</b><small>booked / 100</small></div>
      <div><b className={`grade g${s.grade}`}>{s.grade}</b><small>grade</small></div>
      <div><b>{hhmm(time)}</b><small>time in sessions</small></div>
      <div><b>{s.minPerConn.toFixed(1)}</b><small>min / connect</small></div>
      <div><b>{pct(s.dials ? s.bad / s.dials : 0)}</b><small>bad numbers</small></div>
    </div>
  );
}


/* =================== Bonus =================== */
function Bonus({ me, rep, leads, people, go }) {
  const [goals] = useGoals(); const [calls, setCalls] = useState([]);
  useEffect(() => { fetchAll('sales_calls', 'id, lead_id, outcome, started_at, by_user').then(setCalls); }, []);
  if (!goals) return <div className="card"><div className="empty">Loading…</div></div>;
  const reps = rep ? [me] : people;
  return (
    <>
      {rep && (() => { const b = bonusFor(goals, me.id); const p = bonusProgress(b, { calls, leads }, me.id); return (
        <div className={`card bonushero ${p.hit ? 'hit' : ''}`}>
          <small>Your bonus this {b.period}</small>
          <h2>{p.hit ? (b.hit_message || 'SO STRONG') : (b.message || "NO YOU'RE WEAK")}</h2>
          {p.rules.map((r, i) => <div key={i} className="herorule"><div className="big">{i > 0 && <small>or </small>}{r.metric === 'won_value' ? money(r.value) : num(r.value)} <span>/ {r.metric === 'won_value' ? money(r.target) : num(r.target)} {r.label.toLowerCase()}</span></div><div className="bar"><i style={{ width: `${r.pct * 100}%` }} /></div></div>)}
          <div className="row"><span>{b.payout ? `${money(b.payout)} when you hit either` : ''}</span><div className="spacer" /><span>{p.daysLeft} day{p.daysLeft === 1 ? '' : 's'} left this {b.period}</span></div>
        </div>
      ); })()}
      {!rep && <div className="card"><div className="cardhead"><h3>Bonus · this {goals.bonus.period}</h3><span className="sm">{(bonusFor(goals).rules || []).map((r) => `${num(r.target)} ${(BONUS_METRICS[r.metric] || r.metric).toLowerCase()}`).join(' or ')} · {money(goals.bonus.payout)}</span><div className="spacer" /><span className="sm">Rules live under Team.</span></div>
        {reps.map((p) => { const b = bonusFor(goals, p.id); const pr = bonusProgress(b, { calls, leads }, p.id); return <BonusBar key={p.id} b={b} p={pr} name={(p.full_name || p.email).split(' ')[0]} />; })}
      </div>}
    </>
  );
}


/* =================== Settings: my reply template + my Gmail =================== */
function RepSettings({ me, rep, people, say, status }) {
  const booking = useBookingLink();
  const [t, setT] = useState(null); const [saving, setSaving] = useState(false); const [accts, setAccts] = useState([]); const [busy, setBusy] = useState(false);
  const load = async () => {
    const [{ data: row }, { data: ga }] = await Promise.all([supabase.from('sales_rep_settings').select('*').eq('user_id', me.id).maybeSingle(), supabase.from('v_gmail_accounts').select('*')]);
    setT({ reply_subject: row?.reply_subject ?? '', reply_body: row?.reply_body ?? '', signature: row?.signature ?? '' }); setAccts(ga || []);
  };
  useEffect(() => { load(); }, [me.id]);
  if (!t) return <div className="card"><div className="empty">Loading…</div></div>;
  const eff = { ...DEFAULT_TPL, ...Object.fromEntries(Object.entries(t).filter(([, v]) => v)) };
  const sample = { contact_name: 'Jordan Lee', company: 'Vinyl Moons' };
  const save = async () => { setSaving(true); const { error } = await supabase.from('sales_rep_settings').upsert({ user_id: me.id, ...t, updated_at: new Date().toISOString() }); setSaving(false); say(error ? { error: error.message } : null, 'Saved. Reply and Compose email now use this.'); };
  const reset = () => setT({ reply_subject: '', reply_body: '', signature: '' });
  const mine = accts.find((a) => a.user_id === me.id);
  const connect = async () => { setBusy(true); const r = await ownerFn({ action: 'gmail_connect' }); setBusy(false); if (r.url) window.location.href = r.url; else say(r); };
  const sync = async (all) => { setBusy(true); const r = await ownerFn({ action: 'gmail_sync', all }); setBusy(false); say(r, r.ok ? `Checked ${Object.entries(r.accounts || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : `${v.replies} repl${v.replies === 1 ? 'y' : 'ies'}, ${v.sent} sent`}`).join(' · ')}` : null); load(); };
  const disconnect = async () => { if (!confirm('Disconnect your Gmail? Replies will stop flowing in until you reconnect.')) return; setBusy(true); const r = await ownerFn({ action: 'gmail_disconnect' }); setBusy(false); say(r, 'Gmail disconnected.'); load(); };
  const insert = (k, v) => setT({ ...t, [k]: (t[k] || (k === 'reply_body' ? DEFAULT_TPL.reply_body : k === 'reply_subject' ? DEFAULT_TPL.reply_subject : '')) + v });
  return (
    <>
      <div className="card">
        <div className="cardhead"><h3>My auto email</h3><span className="sm">What Reply / Compose email pre-fills in Gmail. You can still edit before sending.</span><div className="spacer" /><button className="btn-sm" onClick={reset}>Use default</button><button className="btn-sm primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></div>
        <div className="tplgrid">
          <div>
            <label>Subject <span className="sm">(used when it is not a reply)</span><input value={t.reply_subject} placeholder={DEFAULT_TPL.reply_subject} onChange={(e) => setT({ ...t, reply_subject: e.target.value })} /></label>
            <label>Body<textarea rows={9} value={t.reply_body} placeholder={DEFAULT_TPL.reply_body} onChange={(e) => setT({ ...t, reply_body: e.target.value })} /></label>
            <label>Signature <span className="sm">(optional, goes under the body)</span><textarea rows={3} value={t.signature} placeholder={`${(me.full_name || '').split(' ')[0]}\nShipBay 3PL`} onChange={(e) => setT({ ...t, signature: e.target.value })} /></label>
            <div className="tplvars">{TPL_VARS.map(([v, d]) => <button key={v} className="btn-xs" title={`Insert ${v} into the body — ${d}`} onClick={() => insert('reply_body', v)}><code>{v}</code> {d}</button>)}</div>
          </div>
          <div className="tplpreview">
            <small>Preview · to Jordan Lee at Vinyl Moons</small>
            <div className="pv-subject">{fillTpl(eff.reply_subject, sample, me, booking)}</div>
            <pre>{fillTpl(eff.reply_body, sample, me, booking)}{eff.signature ? `\n${fillTpl(eff.signature, sample, me, booking)}` : ''}</pre>
            {!booking && <div className="sm warn">No booking link set yet{rep ? ' — ask Derek (Owner → Settings).' : ' — add it under Owner → Settings.'}</div>}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="cardhead"><h3>My Gmail</h3><span className="sm">Replies from prospects land in Conversations; emails you send them count as touches.</span><div className="spacer" />
          {mine ? <><button className="btn-sm" disabled={busy} onClick={() => sync(false)}>Check now</button><button className="btn-sm danger" disabled={busy} onClick={disconnect}>Disconnect</button></> : <button className="btn-sm primary" disabled={busy || status?.google_keys_set === false} onClick={connect}>{busy ? 'Opening Google…' : 'Connect Gmail'}</button>}
        </div>
        {mine
          ? <div className="kv"><div><span>Mailbox</span><b>{mine.email}</b></div><div><span>Connected</span><b>{new Date(mine.connected_at).toLocaleDateString()}</b></div><div><span>Last check</span><b>{ago(mine.last_sync_at)}</b></div>{mine.last_error && <div><span>Problem</span><b className="bad">{mine.last_error}</b></div>}</div>
          : <div className="empty">Not connected. Google will ask you to allow read access to your mailbox — nothing is ever sent from here; sending stays in Gmail.</div>}
        {!rep && (people || []).length > 1 && (
          <div className="tbl-wrap" style={{ marginTop: 12 }}><table className="tbl"><thead><tr><th>Teammate</th><th>Gmail</th><th>Last check</th><th>Problem</th></tr></thead><tbody>
            {(people || []).map((p) => { const a = accts.find((x) => x.user_id === p.id); return <tr key={p.id}><td>{p.full_name || p.email}</td><td>{a ? a.email : <span className="sm">not connected — they connect it from their Sales → Settings</span>}</td><td>{a ? ago(a.last_sync_at) : '—'}</td><td className="bad">{a?.last_error || ''}</td></tr>; })}
          </tbody></table>
          <div className="row" style={{ marginTop: 8 }}><button className="btn-sm" disabled={busy || !accts.length} onClick={() => sync(true)}>Check everyone's inbox now</button></div></div>
        )}
      </div>
    </>
  );
}

/* =================== Calendar: a real month grid — Calendly bookings + Google Calendar =================== */
export function Calendar({ me, leads, status, reload, say, refreshStatus, mineOnly, openLead }) {
  const [mtgs, setMtgs] = useState(null); const [people, setPeople] = useState([]); const [busy, setBusy] = useState(null); const [sel, setSel] = useState(null);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const load = async () => { const [m, p] = await Promise.all([fetchAll('sales_meetings', '*', (q) => q.order('starts_at')), supabase.from('profiles').select('id, full_name, email').like('role', 'shipbay%').eq('active', true)]); setMtgs(m); setPeople(p.data || []); };
  useEffect(() => { load(); }, []);
  const sync = async (which) => { setBusy(which); const r = await ownerFn({ action: which === 'google' ? 'gcal_sync' : 'calendly_sync' }); setBusy(null); say(r, r.error ? null : `${which === 'google' ? 'Google Calendar' : 'Calendly'} synced · ${r.events} event${r.events === 1 ? '' : 's'}.`); load(); reload?.(); refreshStatus?.(); };
  const upd = async (m, patch) => { await supabase.from('sales_meetings').update(patch).eq('id', m.id); load(); };
  const who = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email).split(' ')[0] : '—'; };
  if (mtgs === null) return <div className="card"><div className="empty">Loading…</div></div>;
  const visible = mtgs.filter((m) => !mineOnly || m.assigned_to === me?.id);
  // grid: Sunday-first weeks covering the month
  const first = new Date(month.getFullYear(), month.getMonth(), 1); const start = new Date(first); start.setDate(1 - first.getDay());
  const cells = []; for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); cells.push(d); }
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const byDay = {}; for (const m of visible) { const k = key(new Date(m.starts_at)); (byDay[k] = byDay[k] || []).push(m); }
  const today = key(new Date()); const now = Date.now();
  const upcoming = visible.filter((m) => new Date(m.starts_at).getTime() >= now - 3600000 && m.status !== 'canceled').slice(0, 8);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmtT = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  return (
    <>
      <div className="opsbar wrap">
        <div className="period"><button className="btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button><b className="monthtitle">{month.toLocaleString('en-US', { month: 'long', year: 'numeric' })}</b><button className="btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button><button className="btn-xs" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button></div>
        <span className="sm"><i className="sw cal" /> Calendly &nbsp; <i className="sw gcal" /> Google Calendar</span>
        <div className="spacer" />
        {!mineOnly && <>
          {status?.calendly_set ? <button className="btn-sm" disabled={!!busy} onClick={() => sync('calendly')}>{busy === 'calendly' ? '…' : 'Sync Calendly'}</button> : <span className="sm">Calendly token → Settings</span>}
          {status?.gcal_set ? <button className="btn-sm" disabled={!!busy} onClick={() => sync('google')}>{busy === 'google' ? '…' : 'Sync Google Calendar'}</button> : <span className="sm">· Google Calendar address → Settings</span>}
        </>}
      </div>
      <div className="calgrid-wrap">
        <div className="card calcard">
          <div className="calgrid">
            {dow.map((d) => <div key={d} className="dow">{d}</div>)}
            {cells.map((d) => { const k = key(d); const evs = (byDay[k] || []).sort((a, b) => a.starts_at.localeCompare(b.starts_at)); const other = d.getMonth() !== month.getMonth(); return (
              <div key={k} className={`day ${other ? 'other' : ''} ${k === today ? 'today' : ''}`}>
                <span className="dnum">{d.getDate()}</span>
                {evs.slice(0, 4).map((m) => <button key={m.id} className={`ev ${m.source} ${m.status === 'canceled' ? 'canceled' : ''} ${new Date(m.starts_at).getTime() < now ? 'past' : ''}`} onClick={() => setSel(m)} title={m.name}>{!m.all_day && <span className="t">{fmtT(m.starts_at)}</span>}<span className="n">{m.invitee_name || m.name}</span></button>)}
                {evs.length > 4 && <button className="more" onClick={() => setSel(evs[4])}>+{evs.length - 4} more</button>}
              </div>
            ); })}
          </div>
        </div>
        <div className="calside">
          <div className="card">
            <div className="cardhead"><h3>Coming up</h3></div>
            {upcoming.length === 0 ? <div className="empty">Nothing booked.</div> : <ul className="uplist">{upcoming.map((m) => <li key={m.id} onClick={() => setSel(m)}><b>{new Date(m.starts_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · {fmtT(m.starts_at)}</b><span>{m.invitee_name || m.name}</span><span className="sm">{m.name}{!mineOnly ? ` · ${who(m.assigned_to)}` : ''}</span></li>)}</ul>}
          </div>
        </div>
      </div>
      {sel && (() => { const m = sel; const l = leads?.find((x) => x.id === m.lead_id); const isPast = new Date(m.starts_at).getTime() < now; return (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setSel(null)}><div className="modal">
          <h3>{m.name}</h3>
          <p className="lead">{new Date(m.starts_at).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{m.ends_at ? ` – ${fmtT(m.ends_at)}` : ''} · <span className={`pill ${m.source === 'google' ? '' : 'connected'}`}>{m.source === 'google' ? 'Google Calendar' : 'Calendly'}</span></p>
          <div className="confirm">
            {(m.invitee_name || m.invitee_email) && <div><small>With</small><b>{m.invitee_name || m.invitee_email}</b>{m.invitee_email && m.invitee_name && <span className="muted"> · {m.invitee_email}</span>}{l && <> · <button className="btn-xs" onClick={() => { setSel(null); openLead(l); }}>Open contact</button></>}</div>}
            {m.location && <div><small>Where</small>{/^https?:/.test(m.location) ? <a href={m.location} target="_blank" rel="noreferrer">{m.location.includes('meet.google') ? 'Google Meet' : m.location.includes('zoom') ? 'Zoom' : 'Join link'} ↗</a> : <b>{m.location}</b>}</div>}
            {m.description && <div><small>Notes</small><pre className="notes">{m.description.slice(0, 600)}</pre></div>}
            <div><small>Taken by</small>{mineOnly ? <b>{who(m.assigned_to)}</b> : <select className="statusselect" value={m.assigned_to || ''} onChange={(e) => { upd(m, { assigned_to: e.target.value || null }); setSel({ ...m, assigned_to: e.target.value || null }); }}><option value="">— nobody —</option>{people.map((p) => <option key={p.id} value={p.id}>{(p.full_name || p.email).split(' ')[0]}</option>)}</select>}</div>
            {m.status === 'canceled' ? <div><small>Status</small><span className="statuspill bad">Canceled</span></div> : isPast && <div><small>How did it go?</small><select className="statusselect" value={m.outcome || ''} onChange={(e) => { upd(m, { outcome: e.target.value || null, status: 'done' }); setSel({ ...m, outcome: e.target.value }); }}><option value="">—</option><option value="quoted">Quoted</option><option value="follow_up">Follow up</option><option value="signed">Signed</option><option value="not_fit">Not a fit</option><option value="no_show">No-show</option></select></div>}
          </div>
          <div className="row"><div className="spacer" /><button className="btn-sm" onClick={() => setSel(null)}>Close</button></div>
        </div></div>
      ); })()}
    </>
  );
}


/* =================== Third party =================== */
export function Third({ leads, sources, reload, say }) {
  const [adding, setAdding] = useState(null); const [edit, setEdit] = useState(null);
  const partner = sources.filter((s) => !['cold_email', 'cold_call'].includes(s.key));
  const stats = (k) => { const L = leads.filter((l) => l.source === k); return { n: L.length, replied: L.filter((l) => ['replied', 'call_booked', 'quoted'].includes(l.stage)).length, signed: L.filter((l) => l.stage === 'signed').length }; };
  const saveSrc = async (s) => { const { error } = await supabase.from('sales_sources').update({ monthly_cost: Number(s.monthly_cost) || 0, one_time_cost: Number(s.one_time_cost) || 0, per_lead_cost: Number(s.per_lead_cost) || 0, rev_share: Number(s.rev_share) || 0, integration_status: s.integration_status, notes: s.notes }).eq('key', s.key); if (error) return say({ error: error.message }); setEdit(null); reload(); };
  const addSrc = async () => { const label = window.prompt('Name of the new lead source (e.g. "Shopify partner directory"):'); if (!label) return; const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40); const { error } = await supabase.from('sales_sources').insert({ key, label }); if (error) return say({ error: error.message }); reload(); };
  const monthsRunning = (k) => ({ fulfill_com: 1, cold_email: 2 }[k] || 1);
  return (
    <>
      <div className="card"><div className="tablewrap"><table className="ordertable fin">
        <thead><tr><th>Source</th><th className="n">Leads</th><th className="n">Replied / booked</th><th className="n">Signed</th><th className="n">$ / month</th><th className="n">One-time</th><th className="n">Per lead</th><th className="n">Rev share</th><th className="n">Spent so far</th><th className="n">$ per lead</th><th>Integration</th><th /></tr></thead>
        <tbody>{partner.map((s) => { const st = stats(s.key); const spent = Number(s.one_time_cost) + Number(s.monthly_cost) * monthsRunning(s.key) + Number(s.per_lead_cost) * st.n; return edit?.key === s.key ? (
          <tr key={s.key} className="hl"><td><b>{s.label}</b></td><td className="n">{st.n}</td><td className="n">{st.replied}</td><td className="n">{st.signed}</td>
            <td><input className="cellnum" type="number" value={edit.monthly_cost} onChange={(e) => setEdit({ ...edit, monthly_cost: e.target.value })} /></td>
            <td><input className="cellnum" type="number" value={edit.one_time_cost} onChange={(e) => setEdit({ ...edit, one_time_cost: e.target.value })} /></td>
            <td><input className="cellnum" type="number" value={edit.per_lead_cost} onChange={(e) => setEdit({ ...edit, per_lead_cost: e.target.value })} /></td>
            <td><input className="cellnum" type="number" step="0.01" value={edit.rev_share} onChange={(e) => setEdit({ ...edit, rev_share: e.target.value })} /></td>
            <td className="n">—</td><td className="n">—</td>
            <td><select className="statusselect" value={edit.integration_status} onChange={(e) => setEdit({ ...edit, integration_status: e.target.value })}>{['none', 'planned', 'connected'].map((x) => <option key={x}>{x}</option>)}</select></td>
            <td className="n" style={{ whiteSpace: 'nowrap' }}><button className="btn-xs primary" onClick={() => saveSrc(edit)}>Save</button> <button className="btn-xs" onClick={() => setEdit(null)}>Cancel</button></td></tr>
        ) : (
          <tr key={s.key}><td><b>{s.label}</b>{s.notes && <div className="sm">{s.notes}</div>}</td><td className="n">{st.n}</td><td className="n">{st.replied}</td><td className="n">{st.signed}</td><td className="n">{money(s.monthly_cost)}</td><td className="n">{money(s.one_time_cost)}</td><td className="n">{money(s.per_lead_cost)}</td><td className="n">{pct(s.rev_share)}</td><td className="n">{money(spent)}</td><td className="n">{st.n ? money(spent / st.n) : '—'}</td>
            <td><span className={`pill ${s.integration_status === 'connected' ? 'connected' : s.integration_status === 'planned' ? 'pending' : ''}`}>{s.integration_status}</span></td>
            <td className="n" style={{ whiteSpace: 'nowrap' }}><button className="btn-xs primary" onClick={() => setAdding(s.key)}>+ Lead</button> <button className="btn-xs" onClick={() => setEdit({ ...s })}>Costs</button></td></tr>
        ); })}</tbody>
      </table></div>
      <div className="row"><button className="btn-xs" onClick={addSrc}>+ New source</button></div></div>
      <div className="card">
        <h3>Recent third-party leads</h3>
        <table className="ordertable leads"><thead><tr><th>Company</th><th>Contact</th><th>Source</th><th>Stage</th><th>Added</th></tr></thead>
          <tbody>{leads.filter((l) => !['cold_email', 'cold_call'].includes(l.source)).slice(0, 50).map((l) => <tr key={l.id}><td><b>{l.company || l.domain}</b></td><td>{l.contact_name}<div className="sm">{l.email}{l.phone ? ` · ${l.phone}` : ''}</div></td><td className="sm">{srcLabel(sources, l.source)}{l.filter_id ? ` · ${l.filter_id}` : ''}</td><td><span className={`statuspill ${stageClass(l.stage)}`}>{stageLabel(l.stage)}</span></td><td className="sm">{new Date(l.created_at).toLocaleDateString()}</td></tr>)}
            {!leads.some((l) => !['cold_email', 'cold_call'].includes(l.source)) && <tr><td colSpan={5} className="empty">None yet — when Fulfill.com sends the first introduction, add it with “+ Lead”.</td></tr>}</tbody></table>
      </div>
      {adding && <LeadForm sources={sources} fixedSource={adding} title={`Add a lead from ${srcLabel(sources, adding)}`} onClose={() => setAdding(null)} reload={reload} say={say} />}
    </>
  );
}
