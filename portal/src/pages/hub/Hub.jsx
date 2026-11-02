// Hub — the CRM in HubSpot's own clothes. Same data as the portal's Sales desk (useCrm), laid out the way HubSpot lays
// it out: a dark top nav with CRM / Conversations / Sales / Reporting menus and global search, record indexes with
// views + filters + a column table, a three-column record page with the activity timeline, and a deal board per
// pipeline stage. HubSpot is the record underneath: every row carries its HubSpot ids, and "Open in HubSpot" lands
// on the same object. Everything that was already built (dialer, inbox, calendar, quotes, onboarding, bonus,
// settings) lives under the same menus.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib';
import { ownerFn, money, num, ago, STAGES, stageLabel } from '../owner/util';
import { useCrm, Overview, Conversations, Calls, Bonus, RepSettings, LeadPanel, expectedMonthly, quotesFor, winLead, findExisting, Calendar, srcLabelPlain } from '../owner/Sales';
import Quotes from '../Quotes';
import Onboarding from '../Onboarding';
import Contacts from './Contacts';
import Record from './Record';
import Deals from './Deals';

export const HS_URL = (portal, kind, id) => (portal && id ? `https://app.hubspot.com/contacts/${portal}/record/${kind === 'contact' ? '0-1' : kind === 'company' ? '0-2' : '0-3'}/${id}` : null);
const SIDE = [
  { items: [['home', 'Home', 'home']] },
  { items: [['dashboard', 'Sales Workspace', 'work'], ['meetings', 'Meetings', 'cal'], ['activities', 'Activity Feed', 'feed'], ['contacts', 'Contacts', 'person'], ['companies', 'Companies', 'building'], ['deals', 'Deals', 'deal'], ['inbox', 'Conversations', 'inbox'], ['calls', 'Calls', 'phone']] },
  { label: 'Sales', items: [['quotes', 'Quotes', 'quote'], ['onboarding', 'Onboarding', 'onboard'], ['bonus', 'Bonus', 'trophy']] },
  { label: 'Platform', items: [['settings', 'Settings', 'gear']] },
];
const I = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', work: 'M4 7h16v12H4zM9 7V4h6v3', cal: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4', feed: 'M4 6h16M4 12h10M4 18h16', person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', building: 'M4 21V5l8-3 8 3v16M9 9h2M13 9h2M9 13h2M13 13h2M9 17h2M13 17h2', deal: 'M3 7h18v4H3zM5 11v8h14v-8M10 11v8M14 11v8', inbox: 'M4 4h16v12h-5l-3 3-3-3H4z', phone: 'M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2', quote: 'M6 3h9l5 5v13H6zM14 3v6h6M9 13h6M9 17h6', onboard: 'M9 11l3 3 8-8M20 12v7H4V5h11', trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM6 6H3a3 3 0 0 0 3 3M18 6h3a3 3 0 0 1-3 3M12 13v4M8 21h8', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .3a7 7 0 0 0-1.4-1.4L17 4l-3-1-1 2a7 7 0 0 0-2 0L10 3 7 4l.4 2.9A7 7 0 0 0 6 8.3L4 8l-1 3 2 1a7 7 0 0 0 0 2l-2 1 1 3 2-.3a7 7 0 0 0 1.4 1.4L7 20l3 1 1-2a7 7 0 0 0 2 0l1 2 3-1-.4-2.9a7 7 0 0 0 1.4-1.4l2 .3 1-3-2-1a7 7 0 0 0 0-2z', more: 'M5 12h.01M12 12h.01M19 12h.01',
};
const Ico = ({ k }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={I[k] || I.more} /></svg>;
const TITLES = { contacts: 'Contacts', companies: 'Companies', deals: 'Deals', activities: 'Activities', inbox: 'Inbox', calls: 'Calls', meetings: 'Meetings', quotes: 'Quotes', onboarding: 'Onboarding', dashboard: 'Dashboard', bonus: 'Bonus', settings: 'Settings' };
export const initialsOf = (s) => (s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const avColor = (s) => { let h = 0; for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 42%)`; };

export default function Hub({ me, status, refreshStatus, rep = false, nav }) {
  const crm = useCrm({ me, rep });
  const { leads, sources, sends, people, mail, mailAccts, quotes, orgs, calls, meetings, touches, msg, setMsg, say, reload, mine, mySends, counts, unread } = crm;
  const [view, setView] = useState(() => { try { return sessionStorage.getItem('hub-view') || 'contacts'; } catch { return 'contacts'; } });
  const [recordId, setRecordId] = useState(null); const [open, setOpen] = useState(null); const [q, setQ] = useState(''); const [subParams, setSubParams] = useState({}); const [focus, setFocus] = useState(null);
  const [hs, setHs] = useState(null);
  useEffect(() => { ownerFn({ action: 'hubspot_links' }).then((r) => setHs(r?.error ? null : r)); }, []);
  useEffect(() => { try { sessionStorage.setItem('hub-view', view); } catch { /* ignore */ } }, [view]);
  // auto-sync with HubSpot at most every 5 minutes while someone is using the CRM
  useEffect(() => { if (!hs?.setup) return; const last = hs.last_sync ? new Date(hs.last_sync).getTime() : 0; if (Date.now() - last < 5 * 60 * 1000) return; ownerFn({ action: 'hubspot_sync' }).then((r) => { if (!r?.error) { reload(); setHs((h) => ({ ...h, last_sync: new Date().toISOString(), last_result: r })); } }); }, [hs?.setup]);
  const go = (v, p = {}) => { setView(v); setRecordId(null); setSubParams({ ...p, _t: Date.now() }); setOpen(null); if (p.focus) setFocus(p.focus); };
  const goTab = (v, p = {}) => go(v === 'email' ? 'inbox' : v === 'calendar' ? 'meetings' : v === 'master' ? 'contacts' : v === 'pipeline' ? 'deals' : v === 'overview' ? 'dashboard' : v, p);
  const openLead = (idOrLead) => { const id = typeof idOrLead === 'string' ? idOrLead : idOrLead?.id; if (id) { setRecordId(id); setView('record'); } };
  const hits = useMemo(() => { const t = q.trim().toLowerCase(); if (t.length < 2) return []; return (leads || []).filter((l) => [l.company, l.domain, l.contact_name, l.email, l.phone, l.city].filter(Boolean).some((v) => v.toLowerCase().includes(t))).slice(0, 8); }, [q, leads]);
  const ctx = { me, rep, sources, people, reload, say, openLead, go: goTab, goTab, nav, quotes, orgs, hs };
  const record = recordId ? (leads || []).find((l) => l.id === recordId) : null;
  const syncNow = async () => { const r = await ownerFn({ action: 'hubspot_sync' }); say(r, r.error ? null : `Synced with HubSpot — ${r.pushed} out, ${(r.pulled?.contacts || 0) + (r.pulled?.deals || 0) + (r.pulled?.activities || 0)} in.`); reload(); setHs((h) => ({ ...(h || {}), last_sync: new Date().toISOString() })); };

  if (leads === null) return <div className="hub"><div className="hub-top"><span className="hub-sprocketwrap"><Sprocket /></span></div><aside className="hub-side" /><div className="hub-body"><div className="hub-empty">Loading your CRM…</div></div></div>;
  const data = { leads: mine, allLeads: leads, sends: mySends, allSends: sends, mail, mailAccts, calls, meetings, touches, quotes, orgs, people, sources, counts };
  return (
    <div className="hub">
      <div className="hub-top">
        <span className="hub-sprocketwrap" onClick={() => go('contacts')}><Sprocket /></span>
        <div className="hub-search">
          <input placeholder="Find in ShipBay CRM" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { openLead(hits[0]); setQ(''); } if (e.key === 'Escape') setQ(''); }} />
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          {hits.length > 0 && <div className="hub-hits">{hits.map((l) => <button key={l.id} onClick={() => { openLead(l); setQ(''); }}><span className="hub-av" style={{ background: avColor(l.company || l.email) }}>{initialsOf(l.contact_name || l.company || l.email)}</span><span><b>{l.contact_name || l.company || l.email}</b><small>{[l.company, l.email].filter(Boolean).join(' · ')}</small></span><em>{stageLabel(l.stage)}</em></button>)}</div>}
        </div>
        <button className={`hub-breeze ${hs?.setup ? '' : 'off'}`} title={hs?.setup ? `Synced with HubSpot ${ago(hs.last_sync)} — click to sync now` : 'HubSpot not connected yet (Admin → Connections)'} onClick={syncNow}><HubSpotMark /> {hs?.setup ? `HubSpot synced ${ago(hs.last_sync)}` : 'HubSpot not connected'}</button>
        <div className="hub-topright">
          <button className="hub-icon" title="Create" onClick={() => go('contacts', { create: 1 })}>+</button>
          <button className="hub-icon" title="Calls" onClick={() => go('calls')}><Ico k="phone" /></button>
          <button className="hub-icon" title="Settings" onClick={() => go('settings')}><Ico k="gear" /></button>
          <span className="hub-acct"><span className="hub-me" style={{ background: avColor(me.full_name || me.email) }}>{initialsOf(me.full_name || me.email)}</span>ShipBay 3PL <i>▾</i></span>
        </div>
      </div>
      <aside className="hub-side">
        {SIDE.map((g, gi) => <div key={gi} className="hub-group">
          {g.label && <div className="hub-grouplbl"><i>⌄</i>{g.label}</div>}
          {g.items.map(([k, l, ic]) => <button key={k} className={`hub-sideitem ${view === k || (view === 'record' && k === 'contacts') ? 'on' : ''}`} onClick={() => (k === 'home' ? nav?.('orders') : go(k))}><Ico k={ic} />{l}{k === 'inbox' && unread ? <i className="hub-badge">{unread}</i> : null}</button>)}
        </div>)}
        <button className="hub-sideitem more"><Ico k="more" />More <span className="chev">›</span></button>
      </aside>
      <div className="hub-body">
        {msg && <div className={`hub-toast ${msg.kind}`}>{msg.text}<button onClick={() => setMsg(null)} aria-label="Dismiss">×</button></div>}
        {view === 'record' && record && <Record {...ctx} lead={record} data={data} back={() => { setView('contacts'); setRecordId(null); }} />}
        {view === 'record' && !record && <div className="hub-empty">That record isn't here any more.</div>}
        {view === 'contacts' && <Contacts {...ctx} kind="contact" data={data} autoCreate={!!subParams.create} />}
        {view === 'companies' && <Contacts {...ctx} kind="company" data={data} />}
        {view === 'deals' && <Deals {...ctx} data={data} />}
        {view === 'activities' && <Contacts {...ctx} kind="activity" data={data} />}
        <div className={`owner hub-legacy ${['inbox', 'calls', 'meetings', 'dashboard', 'bonus', 'settings', 'quotes', 'onboarding'].includes(view) ? '' : 'hidden'}`}>
          {view !== 'record' && <div className="hub-pagehead"><h1>{TITLES[view] || ''}</h1></div>}
          {view === 'inbox' && <Conversations {...ctx} leads={mine} allLeads={leads} sends={mySends} mail={mail} mailAccts={mailAccts} status={status} refreshStatus={refreshStatus} focus={focus} clearFocus={() => setFocus(null)} />}
          {view === 'calls' && <Calls {...ctx} leads={leads} />}
          {view === 'meetings' && <Calendar {...ctx} leads={leads} status={status} refreshStatus={refreshStatus} mineOnly={rep} focusDate={focus} />}
          {view === 'dashboard' && <Overview {...ctx} leads={mine} pool={leads} sends={mySends} counts={counts} />}
          {view === 'bonus' && <Bonus {...ctx} leads={leads} />}
          {view === 'settings' && <RepSettings {...ctx} status={status} />}
          {view === 'quotes' && <div className="subpage"><Quotes me={me} params={subParams} /></div>}
          {view === 'onboarding' && <div className="subpage"><Onboarding me={me} params={subParams} /></div>}
        </div>
      </div>
    </div>
  );
}

export function Sprocket() { return <svg className="hub-sprocket" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="2.4"/><g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></g></svg>; }
export function HubSpotMark() { return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.4 8.2V5.5a2 2 0 0 0 1.2-1.9 2 2 0 1 0-4.1 0 2 2 0 0 0 1.2 1.9v2.7a5.9 5.9 0 0 0-2.8 1.2L5.6 3.7a2.3 2.3 0 1 0-1.1 1.4l7.2 5.6a5.9 5.9 0 0 0 .1 6.7l-2.2 2.2a1.9 1.9 0 0 0-.6-.1 1.9 1.9 0 1 0 1.9 1.9 1.9 1.9 0 0 0-.1-.6l2.2-2.2a5.9 5.9 0 1 0 4.4-10.4zm-.8 8.9a3 3 0 1 1 0-6.1 3 3 0 0 1 0 6.1z"/></svg>; }
