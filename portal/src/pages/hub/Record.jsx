// Contact record — HubSpot's three columns: the contact + "About" on the left, Overview / Activities timeline in the
// middle, associations (company, deal, quotes, client account) on the right. Every edit writes to the one account
// row; the sync carries it to HubSpot.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib';
import { ownerFn, money, num, ago, STAGES, stageLabel } from '../owner/util';
import { useReplyKit, expectedMonthly, quotesFor, quoteMonthly, winLead, srcLabelPlain, listName } from '../owner/Sales';
import { HS_URL, initialsOf, avColor } from './Hub';

const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '--');
const fmtD = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '--');
const LIFE = (s) => (s === 'signed' ? 'Customer' : ['quoted', 'call_booked'].includes(s) ? 'Opportunity' : s === 'replied' ? 'Sales qualified lead' : 'Lead');
const OUTCOMES = [['connected', 'Connected'], ['voicemail', 'Left voicemail'], ['no_answer', 'No answer'], ['gatekeeper', 'Gatekeeper'], ['booked', 'Booked a call'], ['not_fit', 'Not a fit'], ['wrong_number', 'Wrong number']];
const ICON = {
  note: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>,
  email: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>,
  call: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.7a2 2 0 0 1 1.7 2z"/></svg>,
  meeting: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  task: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>,
  more: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>,
};

export default function Record({ me, rep, lead, data, people, sources, reload, say, goTab, nav, quotes, orgs, hs, back }) {
  const kit = useReplyKit(me); const [tab, setTab] = useState('catchup'); const [filter, setFilter] = useState('all'); const [composer, setComposer] = useState(null); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [more, setMore] = useState(false); const [editing, setEditing] = useState(null); const [draft, setDraft] = useState('');
  const { calls, touches, mail, meetings, allSends } = data;
  const sends = allSends.filter((s) => s.lead_id === lead.id);
  const exp = expectedMonthly(lead, quotes); const myQuotes = quotesFor(lead, quotes); const org = lead.org_id ? orgs.find((o) => o.id === lead.org_id) : null;
  const who = (id) => { const p = people.find((x) => x.id === id); return p ? (p.full_name || p.email) : ''; };
  const upd = async (patch, ok) => { const { error } = await supabase.from('sales_leads').update({ ...patch, ...(rep && !lead.assigned_to ? { assigned_to: me.id } : {}) }).eq('id', lead.id); if (error) return say({ error: error.message }); if (ok) say(null, ok); reload(); };
  const setStage = async (stage) => {
    if (stage === 'signed') { if (await winLead(lead, quotes, say)) reload(); return; }
    const patch = { stage, last_touch_at: new Date().toISOString() };
    if (stage === 'lost') { const r = window.prompt('Closed lost — reason? (optional)', lead.lost_reason || ''); if (r === null) return; patch.lost_reason = r || null; }
    if (stage === 'dnc') { if (!window.confirm('Mark do-not-contact? They leave the email campaign and the call queue.')) return; if (lead.email) ownerFn({ action: 'smartlead_stop_lead', email: lead.email }); patch.in_calls = false; patch.in_email = false; }
    upd(patch, 'Lead status updated.');
  };
  const addNote = async () => { if (!note.trim()) return; setBusy(true); await supabase.from('sales_touches').insert({ lead_id: lead.id, kind: 'note', note: note.trim(), by_user: me.id }); setBusy(false); setNote(''); setComposer(null); await upd({ last_touch_at: new Date().toISOString() }, 'Note saved.'); };
  const logEmail = async () => { setBusy(true); await supabase.from('sales_touches').insert({ lead_id: lead.id, kind: 'email_sent', note: note.trim() || null, by_user: me.id }); setBusy(false); setNote(''); setComposer(null); await upd({ last_touch_at: new Date().toISOString(), last_outcome: 'email_sent', ...(lead.stage === 'new' ? { stage: 'contacted' } : {}) }, 'Email logged.'); };
  const logCall = async (outcome) => {
    setBusy(true); await supabase.from('sales_calls').insert({ lead_id: lead.id, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), seconds: 0, outcome, note: note.trim() || null, by_user: me.id });
    const next = { no_answer: 2, voicemail: 3, gatekeeper: 1, connected: 7 }[outcome];
    const patch = { attempts: (lead.attempts || 0) + 1, last_outcome: outcome, last_touch_at: new Date().toISOString(), next_action_at: next ? new Date(Date.now() + next * 86400000).toISOString() : null };
    if (outcome === 'booked') patch.stage = 'call_booked'; else if (outcome === 'not_fit') patch.stage = 'lost'; else if (outcome === 'wrong_number') patch.in_calls = false; else if (lead.stage === 'new') patch.stage = 'contacted';
    setBusy(false); setNote(''); setComposer(null); await upd(patch, 'Call logged.');
  };
  const pushNow = async () => { setBusy(true); const r = await ownerFn({ action: 'hubspot_push_one', lead_id: lead.id }); setBusy(false); say(r, r.error ? null : 'Pushed to HubSpot.'); reload(); };
  // timeline
  const items = useMemo(() => [
    ...calls.filter((c) => c.lead_id === lead.id).map((c) => ({ id: `c${c.id}`, at: c.started_at, kind: 'call', title: `Call — ${c.outcome.replace('_', ' ')}`, by: who(c.by_user), body: c.note, meta: c.seconds ? `${Math.round(c.seconds / 60)} min` : null })),
    ...touches.filter((t) => t.lead_id === lead.id).map((t) => ({ id: `t${t.id}`, at: t.at, kind: t.kind === 'email_sent' ? 'email' : t.kind === 'meeting_note' ? 'meeting' : 'note', title: t.kind === 'email_sent' ? 'Email sent' : t.kind === 'meeting_note' ? 'Meeting note' : t.kind === 'sms' ? 'SMS' : 'Note', by: who(t.by_user) || (t.hs_id ? 'HubSpot' : ''), body: t.note })),
    ...mail.filter((m) => m.lead_id === lead.id).map((m) => ({ id: `m${m.id}`, at: m.at, kind: 'email', title: m.is_sent ? `Email sent — ${m.subject || ''}` : `Email received — ${m.subject || ''}`, by: m.is_sent ? who(m.user_id) : (m.from_name || m.from_email), body: m.snippet, mailId: m.id })),
    ...meetings.filter((m) => m.lead_id === lead.id).map((m) => ({ id: `g${m.id}`, at: m.starts_at, kind: 'meeting', title: m.name || 'Meeting', by: who(m.assigned_to), body: [m.status === 'canceled' ? 'Canceled' : null, m.location, m.notes, m.outcome].filter(Boolean).join(' · '), upcoming: new Date(m.starts_at) > new Date() && m.status !== 'canceled' })),
    ...sends.filter((s) => s.replied && !s.mailbox).map((s) => ({ id: `s${s.id}`, at: s.reply_at || s.sent_at, kind: 'email', title: `Email received — ${s.reply_subject || `Re: ${s.subject || ''}`}`, by: s.lead_name || s.lead_email, body: s.reply_body })),
    ...sends.filter((s) => !s.mailbox).map((s) => ({ id: `o${s.id}`, at: s.sent_at, kind: 'email', title: `Email sent — ${s.subject || ''}`, by: `Campaign · step ${s.step}`, body: null })),
    { id: 'created', at: lead.created_at, kind: 'note', title: `Contact created${lead.source ? ` · ${srcLabelPlain(lead.source)}` : ''}`, by: '', body: null },
  ].filter((i) => filter === 'all' || i.kind === filter).sort((a, b) => (b.at || '').localeCompare(a.at || '')), [calls, touches, mail, meetings, sends, lead, filter]);
  const groups = useMemo(() => { const g = []; for (const it of items) { const k = new Date(it.at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); const last = g[g.length - 1]; if (last && last.k === k) last.items.push(it); else g.push({ k, items: [it] }); } return g; }, [items]);
  const upcoming = meetings.filter((m) => m.lead_id === lead.id && new Date(m.starts_at) > new Date() && m.status !== 'canceled');
  const name = lead.contact_name || lead.company || lead.email;
  const Prop = ({ k, label, type = 'text', render }) => {
    const v = lead[k]; const on = editing === k;
    return <div className="hub-prop"><small>{label}</small>{on
      ? <div className="edit"><input autoFocus type={type} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { upd({ [k]: type === 'number' ? (draft === '' ? null : Number(draft)) : draft || null }); setEditing(null); } if (e.key === 'Escape') setEditing(null); }} /><button className="hs-btn primary sm" onClick={() => { upd({ [k]: type === 'number' ? (draft === '' ? null : Number(draft)) : draft || null }); setEditing(null); }}>Save</button><button className="linkish" onClick={() => setEditing(null)}>Cancel</button></div>
      : <b className="val" onClick={() => { setEditing(k); setDraft(v ?? ''); }} title="Click to edit">{render ? render(v) : (v || <span className="muted">--</span>)}</b>}</div>;
  };
  const hsLink = hs?.portal_id ? HS_URL(hs.portal_id, 'contact', lead.hs_contact_id) : null;
  return (
    <div className="hub-record">
      <div className="hub-cols">
        {/* left */}
        <aside className="hub-left">
          <div className="hub-card pad idcard">
            <div className="hub-cardtop"><button className="hub-link back" onClick={back}>‹ Contacts</button><span className="spacer" /><button className="linkish dark" onClick={() => setMore(!more)}>Actions <i>▾</i></button></div>
            <div className="hub-id"><span className="hub-av lg" style={{ background: avColor(name) }}>{lead.domain ? <img src={`https://www.google.com/s2/favicons?domain=${lead.domain}&sz=64`} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : initialsOf(name)}</span><h2>{name}</h2></div>
            {lead.email && <div className="hub-idmail"><a className="hub-link" href={`mailto:${lead.email}`}>{lead.email}</a> <button className="linkish" title="Copy" onClick={() => { navigator.clipboard?.writeText(lead.email); say(null, 'Copied.'); }}>⧉</button></div>}
            <div className="hub-actions">
              {[['note', 'Note'], ['email', 'Email'], ['call', 'Call'], ['task', 'Task'], ['meeting', 'Meeting'], ['more', 'More']].map(([k, l]) => <button key={k} className={composer === k || (k === 'more' && more) ? 'on' : ''} onClick={() => { if (k === 'more') { setMore(!more); return; } if (k === 'meeting') { if (kit.booking) { navigator.clipboard?.writeText(kit.booking); say(null, 'Booking link copied — paste it in your reply.'); } else goTab('meetings'); return; } setComposer(composer === k ? null : k); setNote(''); }}><span className="ic">{ICON[k]}</span>{l}</button>)}
            </div>
            {more && <div className="hub-moremenu">
              {lead.phone && <a href={`tel:${lead.phone.replace(/[^+\d]/g, '')}`}>Call {lead.phone}</a>}
              {lead.email && <a href={kit.link(lead.email, sends.find((s) => s.replied)?.subject, lead)} target="_blank" rel="noreferrer">Compose in Gmail</a>}
              <button onClick={() => { goTab('quotes', { lead: lead.id }); }}>Create quote</button>
              {hsLink && <a href={hsLink} target="_blank" rel="noreferrer">View in HubSpot</a>}
              {!hsLink && hs?.setup && <button disabled={busy} onClick={pushNow}>Push to HubSpot now</button>}
              {!rep && <button onClick={() => { const to = prompt('Hand off to (name or email)?'); const p = people.find((x) => (x.full_name || '').toLowerCase().includes((to || '').toLowerCase()) || (x.email || '').toLowerCase() === (to || '').toLowerCase()); if (p) upd({ assigned_to: p.id }, `Handed to ${p.full_name || p.email}.`); }}>Hand off</button>}
              {lead.stage !== 'dnc' && <button className="danger" onClick={() => setStage('dnc')}>Do not contact</button>}
            </div>}
          </div>
          <div className="hub-card pad keyinfo">
            <div className="hub-cardtop"><b><i className="tw">⌄</i> Key information</b><span className="spacer" /><button className="linkish dark" onClick={() => setTab('about')}>Actions <i>▾</i></button><span className="hub-roundbtn sm">⚙</span></div>
            <div className="hub-prop"><small>Email</small><b className="val static">{lead.email || <span className="muted">--</span>}</b></div>
            <div className="hub-prop"><small>Phone Number</small><b className="val static">{lead.phone ? <a className="hub-link" href={`tel:${lead.phone.replace(/[^+\d]/g, '')}`}>{lead.phone}</a> : <span className="muted">--</span>}</b></div>
            <div className="hub-prop"><small>Contact owner</small><b className="val static">{who(lead.assigned_to) || <span className="muted">No owner</span>}</b></div>
            <div className="hub-prop"><small>Last Contacted</small><b className="val static">{fmtDT(items.find((i) => i.id !== 'created' && (i.kind === 'email' || i.kind === 'call'))?.at)}</b></div>
            <div className="hub-prop"><small>Lifecycle Stage</small><b className="val static"><span className={`hub-life l-${LIFE(lead.stage).split(' ')[0].toLowerCase()}`}>{LIFE(lead.stage)}</span></b></div>
            <div className="hub-prop"><small>Lead Status</small><select className={`hub-select s-${lead.stage}`} value={lead.stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div className="hub-prop"><small>Expected services / month</small><b className="val static">{exp.value ? `${money(exp.value)}${exp.from ? ` · ${exp.from.label}` : ''}` : <span className="muted">--</span>}</b></div>
          </div>
        </aside>

        {/* middle */}
        <main className="hub-mid">
          <div className="hub-tabs">{[['catchup', 'Catch-up'], ['about', 'About'], ['activities', 'Activities']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}<span className="spacer" /><button className="hub-customize">⚙ Customize</button></div>
          {composer && <div className="hub-card pad composer">
            <div className="hub-ctitle">{composer === 'note' ? 'Create note' : composer === 'email' ? 'Log an email' : composer === 'call' ? 'Log a call' : 'Log activity'}</div>
            <textarea rows={4} autoFocus placeholder={composer === 'note' ? 'Start typing to leave a note…' : composer === 'call' ? 'What happened on the call…' : 'What was sent or said…'} value={note} onChange={(e) => setNote(e.target.value)} />
            {composer === 'call' && <div className="hub-outcomes">{OUTCOMES.map(([k, l]) => <button key={k} className={k === 'booked' ? 'good' : k === 'not_fit' || k === 'wrong_number' ? 'bad' : ''} disabled={busy} onClick={() => logCall(k)}>{l}</button>)}</div>}
            <div className="hub-cfoot">
              {composer === 'note' && <button className="hs-btn primary" disabled={busy || !note.trim()} onClick={addNote}>Save note</button>}
              {composer === 'email' && <><button className="hs-btn primary" disabled={busy} onClick={logEmail}>Log email</button>{lead.email && <a className="hs-btn ghost" href={kit.link(lead.email, sends.find((s) => s.replied)?.subject, lead)} target="_blank" rel="noreferrer">Compose in Gmail</a>}</>}
              {composer === 'task' && <><button className="hs-btn primary" disabled={busy} onClick={logEmail}>Log email sent</button><button className="hs-btn ghost" disabled={busy} onClick={() => setComposer('call')}>Log a call instead</button></>}
              {composer === 'call' && lead.phone && <a className="hs-btn ghost" href={`tel:${lead.phone.replace(/[^+\d]/g, '')}`}>Dial {lead.phone}</a>}
              <button className="linkish" onClick={() => setComposer(null)}>Cancel</button>
            </div>
          </div>}
          {tab === 'catchup' && <>
            <div className="hub-sectionlbl"><i>⌄</i> Overview</div>
            <div className="hub-card pad"><div className="hub-ctitle">Data highlights</div><div className="hub-highlights">
              <div><small>Create date</small><b>{fmtD(lead.created_at)}</b></div><div><small>Lifecycle stage</small><b>{LIFE(lead.stage)}</b></div><div><small>Last activity</small><b>{items.find((i) => i.id !== 'created') ? ago(items.find((i) => i.id !== 'created').at) : '--'}</b></div><div><small>Expected services</small><b>{exp.value ? `${money(exp.value)}/mo` : '--'}</b></div>
            </div></div>
            <div className="hub-card pad"><div className="hub-ctitle">Recent interactions</div><div className="hub-inout">
              <div className="hub-iobox"><b>Inbound</b>{items.filter((i) => i.kind === 'email' && /received/i.test(i.title)).slice(0, 5).map((i) => <div key={i.id} className="hub-iorow"><span className="ic">{ICON.email}</span><button className="hub-link" onClick={() => { setTab('activities'); setFilter('email'); }}>{i.title.replace(/^Email received — /, 'Incoming email - ')}</button><span className="muted">from {i.by}</span><span className="spacer" /><span className="muted">{fmtD(i.at)}</span></div>)}{!items.some((i) => i.kind === 'email' && /received/i.test(i.title)) && <div className="muted">No inbound emails yet.</div>}</div>
              <div className="hub-iobox"><b>Outbound</b>{items.filter((i) => (i.kind === 'email' && !/received/i.test(i.title)) || i.kind === 'call').slice(0, 5).map((i) => <div key={i.id} className="hub-iorow"><span className="ic">{ICON[i.kind]}</span><button className="hub-link" onClick={() => { setTab('activities'); setFilter(i.kind); }}>{i.title.replace(/^Email sent — /, 'Email - ')}</button>{i.by && <span className="muted">from {i.by}</span>}<span className="spacer" /><span className="muted">{fmtD(i.at)}</span></div>)}{!items.some((i) => (i.kind === 'email' && !/received/i.test(i.title)) || i.kind === 'call') && <div className="muted">Nothing sent yet.</div>}</div>
            </div></div>
            <div className="hub-card pad"><div className="hub-ctitle">Upcoming</div>{upcoming.length ? upcoming.map((m) => <div key={m.id} className="hub-upc"><span className="ic">{ICON.meeting}</span><div><b>{m.name || 'Meeting'}</b><small>{fmtDT(m.starts_at)}{m.location ? ` · ${m.location}` : ''}</small></div></div>) : lead.next_action_at ? <div className="hub-upc"><span className="ic">{ICON.task}</span><div><b>Follow up</b><small>{fmtDT(lead.next_action_at)}</small></div></div> : <div className="muted">Nothing scheduled.</div>}</div>
          </>}
          {tab === 'about' && <div className="hub-card pad"><div className="hub-ctitle">About this contact</div><div className="hub-aboutgrid">
              <Prop k="email" label="Email" type="email" render={(v) => (v ? <a className="hub-link" href={`mailto:${v}`}>{v}</a> : <span className="muted">--</span>)} />
              <Prop k="phone" label="Phone number" render={(v) => (v ? <a className="hub-link" href={`tel:${v.replace(/[^+\d]/g, '')}`}>{v}</a> : <span className="muted">--</span>)} />
              <Prop k="contact_name" label="Full name" /><Prop k="title" label="Job title" />
              <div className="hub-prop"><small>Contact owner</small>{rep ? <b className="val static">{who(lead.assigned_to) || <span className="muted">No owner</span>}</b> : <select className="hub-select" value={lead.assigned_to || ''} onChange={(e) => upd({ assigned_to: e.target.value || null }, 'Owner updated.')}><option value="">No owner</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</select>}</div>
              <div className="hub-prop"><small>Lead status</small><select className={`hub-select s-${lead.stage}`} value={lead.stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div className="hub-prop"><small>Lifecycle stage</small><b className="val static">{LIFE(lead.stage)}</b></div>
              <div className="hub-prop"><small>Original source</small><select className="hub-select" value={lead.source} onChange={(e) => upd({ source: e.target.value }, 'Source updated.')}>{sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
              {lead.filter_id && <div className="hub-prop"><small>List</small><b className="val static" title={listName(lead.filter_id)}>{lead.filter_id}</b></div>}
              <Prop k="city" label="City" /><Prop k="state" label="State/Region" />
              <div className="hub-prop"><small>Next step</small>{editing === 'next_action_at' ? <div className="edit"><input autoFocus type="datetime-local" value={draft} onChange={(e) => setDraft(e.target.value)} /><button className="hs-btn primary sm" onClick={() => { upd({ next_action_at: draft ? new Date(draft).toISOString() : null }); setEditing(null); }}>Save</button></div> : <b className="val" onClick={() => { setEditing('next_action_at'); setDraft(lead.next_action_at ? new Date(lead.next_action_at).toISOString().slice(0, 16) : ''); }}>{lead.next_action_at ? fmtDT(lead.next_action_at) : <span className="muted">--</span>}</b>}</div>
              <Prop k="est_sales_usd" label="Est. online sales / mo" type="number" render={(v) => (v ? money(v) : <span className="muted">--</span>)} />
              <div className="hub-prop"><small>Create date</small><b className="val static">{fmtDT(lead.created_at)}</b></div>
              <div className="hub-prop"><small>Last activity date</small><b className="val static">{fmtDT(items.find((i) => i.id !== 'created')?.at)}</b></div>
              <div className="hub-prop"><small>HubSpot</small><b className="val static">{lead.hs_contact_id ? <>synced{lead.hs_synced_at ? ` · ${ago(lead.hs_synced_at)}` : ''}</> : <span className="muted">not yet</span>}</b></div>
              <div className="hub-prop wide"><small>Notes</small>{editing === 'notes' ? <div className="edit"><textarea autoFocus rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: '100%' }} /><button className="hs-btn primary sm" onClick={() => { upd({ notes: draft || null }); setEditing(null); }}>Save</button><button className="linkish" onClick={() => setEditing(null)}>Cancel</button></div> : <b className="val pre" onClick={() => { setEditing('notes'); setDraft(lead.notes || ''); }}>{lead.notes || <span className="muted">--</span>}</b>}</div>
            </div></div>}
          {tab === 'activities' && <>
            <div className="hub-filterrow">{[['all', 'Activity'], ['note', 'Notes'], ['email', 'Emails'], ['call', 'Calls'], ['meeting', 'Meetings']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}<span className="spacer" /><span className="muted">{items.length} activities</span></div>
            {groups.map((g) => <div key={g.k} className="hub-month"><div className="hub-monthlbl">{g.k}</div>{g.items.map((i) => <TimelineItem key={i.id} i={i} />)}</div>)}
          </>}
        </main>

        {/* right */}
        <aside className="hub-rightcol">
          <AssocCard title="Companies" count={lead.company || lead.domain ? 1 : 0} onAdd={() => { setEditing('company'); setDraft(lead.company || ''); }}>
            {lead.company || lead.domain ? <div className="hub-assoc"><span className="hub-av sq" style={{ background: avColor(lead.company || lead.domain) }}>{lead.domain ? <img src={`https://www.google.com/s2/favicons?domain=${lead.domain}&sz=64`} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : initialsOf(lead.company)}</span><div>{editing === 'company' ? <div className="edit"><input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} /><button className="hs-btn primary sm" onClick={() => { upd({ company: draft || null }); setEditing(null); }}>Save</button></div> : <b onClick={() => { setEditing('company'); setDraft(lead.company || ''); }}>{lead.company || lead.domain}</b>}{lead.domain ? <a className="hub-link" href={`https://${lead.domain}`} target="_blank" rel="noreferrer">{lead.domain}</a> : <button className="linkish" onClick={() => { const d = prompt('Company website (domain)?', ''); if (d) upd({ domain: d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() }); }}>+ add website</button>}<small>{[lead.phone, [lead.city, lead.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</small>{hs?.portal_id && lead.hs_company_id && <a className="hub-link sm" href={HS_URL(hs.portal_id, 'company', lead.hs_company_id)} target="_blank" rel="noreferrer">View in HubSpot</a>}</div></div> : <div className="muted">No company yet.</div>}
          </AssocCard>
          <AssocCard title="Deals" count={['contacted', 'replied', 'call_booked', 'quoted', 'signed', 'lost'].includes(lead.stage) ? 1 : 0} onAdd={() => setStage('contacted')}>
            {['contacted', 'replied', 'call_booked', 'quoted', 'signed', 'lost'].includes(lead.stage) ? <div className="hub-assoc deal"><div><b>{lead.company || lead.email} — fulfillment</b><small>Amount: {exp.value ? `${money(exp.value)}/mo · ${money(exp.value * 12)}/yr` : '--'}{exp.from ? ` · from ${exp.from.label}` : ''}</small><small>Stage: <select className="hub-select inline" value={lead.stage} onChange={(e) => setStage(e.target.value)}>{STAGES.filter((s) => s[0] !== 'new' && s[0] !== 'dnc').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></small><small>Close date: {lead.won_at ? fmtD(lead.won_at) : '--'}</small>{!exp.from && <small>Expected $/mo: {editing === 'deal_value' ? <span className="edit"><input autoFocus type="number" value={draft} onChange={(e) => setDraft(e.target.value)} /><button className="hs-btn primary sm" onClick={() => { upd({ deal_value: draft === '' ? null : Number(draft) }); setEditing(null); }}>Save</button></span> : <button className="linkish" onClick={() => { setEditing('deal_value'); setDraft(lead.deal_value || ''); }}>{lead.deal_value ? money(lead.deal_value) : 'set'}</button>}</small>}{hs?.portal_id && lead.hs_deal_id && <a className="hub-link sm" href={HS_URL(hs.portal_id, 'deal', lead.hs_deal_id)} target="_blank" rel="noreferrer">View in HubSpot</a>}</div></div> : <div className="muted">No open deal — set a lead status past New to open one.</div>}
          </AssocCard>
          <AssocCard title="Quotes" count={myQuotes.length} onAdd={() => goTab('quotes', { lead: lead.id })}>
            {myQuotes.length ? myQuotes.map((q) => <button key={q.id} className="hub-assoc click" onClick={() => goTab('quotes', { quote: q.id })}><div><b>{q.label}</b><small>{q.status}{quoteMonthly(q) != null ? ` · ${money(quoteMonthly(q))}/mo` : ''}{q.internal_only ? ' · internal' : ''}</small></div></button>) : <div className="muted">No quote yet.</div>}
          </AssocCard>
          <AssocCard title="Client account" count={org ? 1 : 0} onAdd={lead.stage !== 'dnc' && !org ? () => setStage('signed') : null} addLabel="Make client">
            {org ? <div className="hub-assoc"><div><b>{org.name}</b><small>{org.status}</small><div className="row"><button className="linkish" onClick={() => goTab('onboarding', { org: org.id })}>Onboarding →</button>{!rep && <button className="linkish" onClick={() => nav?.('owner', { tab: 'admin', section: 'clients', org: org.id })}>Client settings →</button>}</div></div></div> : <div className="muted">Not a client yet.</div>}
          </AssocCard>
        </aside>
      </div>
    </div>
  );
}

function AssocCard({ title, count, onAdd, addLabel = '+ Add', children }) {
  const [open, setOpen] = useState(true);
  return <div className="hub-card hub-assoccard"><div className="hub-assochead" onClick={() => setOpen(!open)}><i className={`tw ${open ? 'open' : ''}`}>⌄</i><b>{title} ({count})</b><span className="spacer" />{onAdd && <button className="linkish dark" onClick={(e) => { e.stopPropagation(); onAdd(); }}>{addLabel}</button>}<span className="hub-roundbtn sm">⚙</span></div>{open && <div className="hub-assocbody">{children}</div>}</div>;
}
function TimelineItem({ i, compact }) {
  const [open, setOpen] = useState(!compact && (i.kind === 'note' || (i.body || '').length < 240));
  return <div className={`hub-tl k-${i.kind} ${i.upcoming ? 'upc' : ''}`}><span className="ic">{ICON[i.kind] || ICON.note}</span><div className="tlbody"><div className="tlhead"><b>{i.title}</b>{i.by && <span className="muted"> · {i.by}</span>}<span className="spacer" /><span className="muted">{fmtDT(i.at)}</span></div>{i.body && (open ? <pre>{i.body}</pre> : <button className="linkish" onClick={() => setOpen(true)}>{String(i.body).slice(0, 120).replace(/\s+/g, ' ')}… show more</button>)}{i.meta && <small className="muted">{i.meta}</small>}</div></div>;
}
