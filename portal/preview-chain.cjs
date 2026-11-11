// Local visual check of the Owner area: serves dist/ with every Supabase call stubbed, screenshots each tab.
// node preview-owner.cjs   (run from portal/ after `npx vite build`)
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path'); const http = require('http');

const DIST = path.join(__dirname, 'dist');
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(4173);

const OWNER = '2ad97f56-03f5-453b-99a0-5b7523ef5c8a'; const XAVIER = '740c00d8-9056-49de-9649-4f23f01ffda5'; const SETTER = '5e77e500-0000-4000-8000-000000000001';
const AS = process.argv[2] || 'setter';
const UID = OWNER;   // fixtures are built around the owner; ME is who signs in
const ME = AS === 'setter' ? SETTER : OWNER;
const day = (d) => { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); };
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const uid = (() => { let i = 0; return () => `00000000-0000-4000-8000-${String(++i).padStart(12, '0')}`; })();

const tx = [];
const add = (dAgo, kind, category, who, what, amount, source = 'manual') => tx.push({ id: uid(), txn_date: day(dAgo), kind, category, counterparty: who, description: what, amount, paid: true, source, external_id: null });
add(2, 'expense', 'Software', 'Storeleads', 'Lead lists', 250, 'qbo'); add(2, 'expense', 'Software', 'Storeleads', 'Storeleads — lead lists', 250);
add(5, 'expense', 'Software', 'Netlify', 'Hosting', 20, 'qbo'); add(6, 'expense', 'Software', 'Apollo.io', 'Cold outbound', 99, 'qbo');
add(3, 'expense', 'Marketing & outbound', 'fulfilment.com (UK)', 'Listing fee', 2667.8); add(18, 'expense', 'Travel', 'United Airlines', 'Airfare', 1591.99); add(17, 'expense', 'Travel', 'Airbnb', 'Lodging', 2289.15);
add(14, 'expense', 'Software', 'HubSpot', 'CRM', 100, 'qbo'); add(25, 'expense', 'Software', 'Smartlead', 'Cold email', 94, 'qbo');
add(1, 'revenue', 'Services revenue', 'Steel Horse Leather', 'Invoice #1001 — October services', 1150, 'qbo'); add(9, 'revenue', 'Services revenue', 'Vinyl Moon', 'Deposit on first drop', 1800);
add(3, 'owner_contribution', 'Owner contribution', 'Derek', 'fulfilment.com fee paid personally', 2667.8);
add(40, 'expense', 'Software', 'Storeleads', 'Lead lists', 250); add(38, 'expense', 'Software', 'Apollo.io', 'Cold outbound', 99); add(45, 'expense', 'Software', 'HubSpot', 'CRM', 95.34); add(59, 'expense', 'Marketing & outbound', 'Alex Makowski (lead-gen agency)', 'Wire + fee', 7525);
add(70, 'capex', 'Capex (racking, equipment)', 'Best Buy', 'Office setup', 1615.47); add(70, 'capex', 'Capex (racking, equipment)', 'Target', 'Office setup', 628); add(68, 'expense', 'Software', 'Storeleads', 'Lead lists', 175);

const sources = [['cold_email', 'Cold email (Smartlead)', 450, 0, 0, 0], ['cold_call', 'Cold calling', 0, 0, 0, 0], ['fulfill_com', 'Fulfill.com referral network', 249, 0, 50, 0.05], ['fulfilment_com', 'fulfilment.com (UK marketplace)', 0, 2667.8, 0, 0], ['agency', 'Lead-gen agency (Alex Makowski)', 0, 7500, 0, 0], ['referral', 'Referral partners', 0, 0, 0, 0], ['inbound', 'Website / Google Business', 0, 0, 0, 0], ['linkedin', 'LinkedIn', 0, 0, 0, 0], ['other', 'Other', 0, 0, 0, 0]]
  .map(([key, label, monthly_cost, one_time_cost, per_lead_cost, rev_share]) => ({ key, label, kind: 'manual', monthly_cost, one_time_cost, per_lead_cost, rev_share, integration_status: key === 'fulfill_com' ? 'planned' : 'none', notes: '' }));

const cos = ['Munro Shoes', 'Sea to Table', 'Sister Parish', 'Country Farms', 'Habitual', 'Cashmere Boutique', 'Reading Coffee Company', 'Teddy Stratford', 'Ancient Healing Teas', 'Sleep On It Kids', 'AttakPik', 'Costa Brazil', 'Brooklyn Candle Studio', 'Oak & Olive', 'Marina Moscone', 'Sadderday', 'Tamara Malas', 'Blue Bottle Supply', 'Glossy Goods', 'Kettle & Fire NJ'];
const lists = ['A1', 'A1', 'A1', 'B1', 'A3', 'C1', 'C2', 'A4', 'X0', 'A1'];
const stages = ['new', 'new', 'new', 'contacted', 'contacted', 'contacted', 'replied', 'call_booked', 'new', 'lost', 'dnc', 'quoted', 'signed'];
const leads = []; for (let i = 0; i < 120; i++) { const c = cos[i % cos.length] + (i >= cos.length ? ` ${Math.floor(i / cos.length) + 1}` : ''); const email = i % 3 ? null : `hello@${c.toLowerCase().replace(/[^a-z]/g, '')}.com`; leads.push({ id: uid(), source: i % 3 ? 'cold_call' : 'cold_email', filter_id: lists[i % lists.length], company: c, domain: `${c.toLowerCase().replace(/[^a-z]/g, '')}.com`, contact_name: i % 4 ? null : 'Jordan Lee', email, phone: `(201) 555-${String(1000 + i).slice(1)}`, city: ['Newark', 'Brooklyn', 'Princeton', 'Jersey City', 'Philadelphia'][i % 5], state: ['New Jersey', 'New York', 'New Jersey', 'New Jersey', 'Pennsylvania'][i % 5], est_sales_usd: 40000 + (i * 7919) % 260000, products: 20 + (i * 13) % 400, rank: 20000 + i * 311, plan: i % 6 ? null : 'Shopify Plus', categories: '/Apparel', stage: stages[i % stages.length], in_email: i % 3 === 0, in_calls: true, attempts: i % 4, last_outcome: i % 4 ? ['no_answer', 'voicemail', 'connected'][i % 3] : null, last_touch_at: i % 4 ? iso(i % 9) : null, next_action_at: i % 7 === 0 ? iso(1) : null, notes: i === 10 ? 'Wants quotes at 500 and 2,500 orders / mo. 29 SKUs, kitting, letter-rate mailers.' : null, tags: [], created_at: iso(10) }); }
leads[10].stage = 'replied'; leads[11].stage = 'replied'; leads[14].stage = 'dnc';
const sends = []; for (let i = 0; i < 60; i++) { const l = leads[(i * 3) % leads.length]; sends.push({ id: uid(), external_id: `s${i}`, lead_id: l.id, lead_email: l.email || `hello@${l.domain}`, lead_name: l.contact_name || l.company, campaign: '4039101 ShipBay — self-ship NJ', step: 1 + (i % 3), variant: String(7832806 + (i % 2)), subject: `quick one about ${l.company}'s shipping`, sent_at: iso(i % 6), opened: i % 2 === 0, open_count: i % 2, replied: false, bounced: i % 17 === 0, reply_type: i % 17 === 0 ? 'Bounce-back' : null, reply_body: null }); }
sends[0] = { ...sends[0], lead_id: leads[10].id, lead_email: 'euship@attakpik.com', lead_name: 'Mark Labbe', replied: true, reply_type: 'Positive', reply_at: iso(1), reply_body: 'Hey Derek,\n\nThanks for reaching out. We are looking at 3PL options for Q1. Can you send pricing at 500 orders a month and at 2,500? We have 29 SKUs, some kitting, and a lot goes out in letter-rate mailers. We also do some wholesale and FBA.\n\nMark' };
sends[1] = { ...sends[1], lead_id: leads[11].id, lead_email: 'david@livecostabrazil.com', lead_name: 'David Shamouelian', replied: true, reply_type: null, reply_at: iso(2), reply_body: 'Hi Derek — sure, happy to chat. Does Friday 9:30am work for a quick call?\n\nDavid' };
sends[0].read_at = iso(0.4);
sends[2] = { ...sends[2], lead_id: leads[14].id, lead_email: 'francesca@marinamoscone.com', lead_name: 'Francesca', replied: true, reply_type: 'Negative', reply_at: iso(3), reply_body: 'Please remove me from this list.' };
const calls = []; for (let i = 0; i < 48; i++) { const l = leads[i]; calls.push({ id: uid(), lead_id: l.id, started_at: iso((i % 5) * 0.4), ended_at: iso((i % 5) * 0.4), seconds: [20, 35, 190, 420][i % 4], outcome: ['no_answer', 'voicemail', 'gatekeeper', 'connected', 'no_answer', 'booked', 'wrong_number', 'no_answer'][i % 8], note: null, by_user: i % 3 === 0 ? '740c00d8-9056-49de-9649-4f23f01ffda5' : UID }); }
const sessions = [{ id: uid(), started_at: iso(0.2), ended_at: iso(0.1), seconds: 3800, by_user: UID }, { id: uid(), started_at: iso(1.2), ended_at: iso(1.1), seconds: 5400, by_user: UID }];
const strategies = [
  { id: uid(), name: 'Cold email — self-ship NJ brands', channel: 'cold_email', lists: ['A1'], status: 'active', hypothesis: 'Shopify brands within an hour of Hillsborough that still pack their own orders; local pickup + "only pay for what you use" is the hook.', target: '1%+ positive reply rate · 2 booked calls / week', monthly_cost: 450, started: day(3), notes: '', log: [{ at: iso(1), note: 'Two positives in the first 525 sends (AttakPik, Costa Brazil). Bounce rate 1.3%.' }], created_at: iso(3), updated_at: iso(1) },
  { id: uid(), name: 'Cold calling — Storeleads lists', channel: 'cold_call', lists: ['A1', 'A3', 'B1', 'C1', 'C2', 'A4', 'X0'], status: 'active', hypothesis: 'Same brands by phone; a founder picks up and a 3-minute conversation beats 5 emails.', target: '30+ dials / session · grade B or better on one list', monthly_cost: 250, started: day(0), notes: '', log: [], created_at: iso(0), updated_at: iso(0) },
  { id: uid(), name: 'Fulfill.com referral network', channel: 'fulfill_com', lists: [], status: 'active', hypothesis: 'Brands already shopping for a 3PL get matched to us; we pay per intro + 5% for 36 months.', target: '1 qualified intro / month that converts within 60 days', monthly_cost: 249, started: day(-1), notes: '', log: [], created_at: iso(1), updated_at: iso(1) },
  { id: uid(), name: 'Lead-gen agency (Alex Makowski)', channel: 'agency', lists: [], status: 'paused', hypothesis: 'Outsourced appointment setting.', target: 'Booked calls delivered vs the $7,500 paid', monthly_cost: 0, started: day(59), notes: '', log: [{ at: iso(5), note: 'No leads logged yet — chase for a status report.' }], created_at: iso(59), updated_at: iso(5) },
];

const meetings = [
  { id: uid(), external_id: 'gcal:1', source: 'google', name: 'Steel Horse — inbound walkthrough', starts_at: iso(-4.3), ends_at: iso(-4.26), status: 'active', invitee_name: 'Dave', invitee_email: 'dave@steelhorseleather.com', location: 'https://meet.google.com/qqq', lead_id: null, assigned_to: UID, all_day: false },
  { id: uid(), external_id: 'gcal:2', source: 'google', name: 'Racking delivery', starts_at: iso(-9), ends_at: null, status: 'active', invitee_name: null, invitee_email: null, location: '115 Stryker Ln', lead_id: null, assigned_to: UID, all_day: true },
  { id: uid(), external_id: 'ev1', source: 'calendly', name: 'ShipBay intro call', starts_at: iso(-1.2), ends_at: iso(-1.18), status: 'active', invitee_name: 'David Shamouelian', invitee_email: 'david@livecostabrazil.com', location: 'https://meet.google.com/abc-defg-hij', lead_id: leads[11].id, assigned_to: UID },
  { id: uid(), external_id: 'ev2', source: 'calendly', name: 'ShipBay intro call', starts_at: iso(-3), ends_at: iso(-2.98), status: 'active', invitee_name: 'Mark Labbe', invitee_email: 'euship@attakpik.com', location: 'https://meet.google.com/xyz', lead_id: leads[10].id, assigned_to: '740c00d8-9056-49de-9649-4f23f01ffda5' },
  { id: uid(), external_id: 'ev3', source: 'calendly', name: 'ShipBay intro call', starts_at: iso(2), ends_at: iso(1.98), status: 'active', invitee_name: 'Jordan Lee', invitee_email: 'hello@oakolive.com', location: null, lead_id: null, assigned_to: UID },
];
leads[10].answered_at = iso(0.5); leads[10].assigned_to = '740c00d8-9056-49de-9649-4f23f01ffda5'; leads[11].assigned_to = UID; leads[7].assigned_to = UID;
for (const l of leads) { if (['call_booked','quoted','signed'].includes(l.stage)) l.deal_value = 450 + (l.rank % 9) * 110; }
const recurring = [['Souled fulfillment services fee', 1351.23], ['Storeleads', 250], ['Fulfill.com account fee', 249], ['Claude', 150], ['HubSpot', 100], ['Pallet positions', 102.4], ['Apollo.io', 99], ['Smartlead', 94], ['Google Workspace', 49], ['Netlify', 20]].map(([item, amount]) => ({ id: uid(), item, category: 'Software', amount, starts: '2026-10-01', ends: null }));
const orgsStub = [
  { id: 'org1', name: 'Steel Horse Leather', slug: 'steel-horse', status: 'onboarding', contact_name: 'David', contact_email: 'dave@steelhorseleather.com', go_live_date: '2026-11-09', go_live_status: 'on_time', founding_account: true, total: 18, done: 11, last_activity: iso(0.3), sales_rep: 'Derek Harrison', sales_rep_id: UID, org_id: 'org1', created_at: iso(15) },
  { id: 'org2', name: 'Vinyl Moons', slug: 'vinyl-moons', status: 'onboarding', contact_name: 'Brandon Bogajewicz', contact_email: 'hello@vinylmoon.co', go_live_date: '2026-11-16', go_live_status: 'on_time', founding_account: false, total: 18, done: 2, last_activity: iso(0.1), sales_rep: 'Derek Harrison', sales_rep_id: UID, org_id: 'org2', created_at: iso(0.2) },
];
const TABLES = { sales_rep_settings: [], v_gmail_accounts: [{ user_id: UID, email: 'derekh@shipbay3pl.com', connected_at: iso(2), last_sync_at: iso(0.05), last_error: null, scopes: 'gmail.readonly gmail.send' }],
  gmail_messages: [
    { id: 'gm1', user_id: UID, gmail_id: 'a1', thread_id: 't1', from_email: 'brandon@vinylmoon.co', from_name: 'Brandon Bogajewicz', to_email: 'derekh@shipbay3pl.com', subject: 'Re: onboarding docs', snippet: 'Sent the SKU sheet over, let me know if the barcodes look right…', body: 'Hey Derek,\n\nSent the SKU sheet over, let me know if the barcodes look right. Also when do we start receiving?\n\nBrandon', at: iso(0.02), is_sent: false, lead_id: null, read_at: null, hidden: false },
    { id: 'gm2', user_id: UID, gmail_id: 'a2', thread_id: 't2', from_email: 'maya@northfork-candle.com', from_name: 'Maya Okafor', to_email: 'derekh@shipbay3pl.com', subject: 'Fulfillment for Q4?', snippet: 'Saw your site, we do about 900 orders a month out of Red Bank…', body: 'Hi,\n\nSaw your site, we do about 900 orders a month out of Red Bank and our garage is done. What would that run us?\n\nMaya', at: iso(0.3), is_sent: false, lead_id: null, read_at: null, hidden: false },
    { id: 'gm3', user_id: UID, gmail_id: 'a3', thread_id: 't3', from_email: 'derekh@shipbay3pl.com', from_name: null, to_email: 'dave@steelhorseleather.com', subject: 'Go-live Nov 9', snippet: 'Dave — pallets land Thursday…', body: 'Dave — pallets land Thursday, we scan Friday.\n\nDerek', at: iso(1.1), is_sent: true, lead_id: null, read_at: iso(1.1), hidden: false },
    { id: 'gm4', user_id: UID, gmail_id: 'a4', thread_id: 't4', from_email: 'billing@netlify.com', from_name: 'Netlify', to_email: 'derekh@shipbay3pl.com', subject: 'Your receipt', snippet: 'Thanks for your payment of $20.00', body: 'Thanks for your payment of $20.00', at: iso(2.2), is_sent: false, lead_id: null, read_at: iso(2), hidden: false },
  ], fin_recurring: recurring, v_onboarding_progress: orgsStub, sales_touches: [], fin_transactions: tx, fin_qbo_reports: [], fin_settings: [{ key: 'cash_on_hand', value: { amount: 0 } }, { key: 'sales_goals', value: { team: { dials_day: 60, dials_week: 300, emails_day: 150, emails_week: 750, booked_day: 1, booked_week: 5 }, reps: {}, bonus: { metric: 'booked', target: 10, payout: 500, period: 'month', message: "NO YOU'RE WEAK" } } }, { key: 'round_robin', value: { members: [UID, '740c00d8-9056-49de-9649-4f23f01ffda5'], next: 1 } }, { key: 'booking_link', value: { url: 'https://calendly.com/shipbay/intro' } }], sales_leads: leads, sales_sources: sources, sales_email_sends: sends, sales_calls: calls, sales_call_sessions: sessions, sales_strategies: strategies, profiles: [{ id: UID, email: 'derekh@shipbay3pl.com', full_name: 'Derek Harrison', role: 'shipbay_admin', is_owner: true, is_sales: true, org_id: null, active: true }, { id: '740c00d8-9056-49de-9649-4f23f01ffda5', email: 'xavierd@shipbay3pl.com', full_name: 'Xavier Delmonte', role: 'shipbay_admin', is_sales: true, active: true }, { id: SETTER, email: 'maya@shipbay3pl.com', full_name: 'Maya Torres', role: 'shipbay_setter', is_sales: false, is_owner: false, closer_id: XAVIER, org_id: null, active: true, last_seen_at: iso(0.01) }], orgs: orgsStub, sales_meetings: meetings };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(({ UID }) => {
    const s = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: 'derekh@shipbay3pl.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    localStorage.setItem('shipbay-auth', JSON.stringify(s)); sessionStorage.setItem('shipbay-owner-token', 'tok'); localStorage.setItem('shipbay-help:owner', '1');
  }, { UID: ME });
  await ctx.route(/\/auth\/v1\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: ME, email: 'derekh@shipbay3pl.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }) }));
  await ctx.route(/\/rest\/v1\/([a-z_]+)/, (route) => {
    const req = route.request(); const m = req.url().match(/\/rest\/v1\/([a-z_]+)/); const table = m[1]; const rows = TABLES[table] || [];
    const single = (req.headers()['accept'] || '').includes('object');
    const u = new URL(req.url()); let out = rows;
    for (const [k, v] of u.searchParams) { if (k === 'select' || k === 'order' || k === 'limit' || k === 'offset') continue; const [op, val] = v.split('.'); if (op === 'eq') out = out.filter((r) => String(r[k]) === val); if (op === 'is' && val === 'null') out = out.filter((r) => r[k] == null); }
    if (req.method() !== 'GET') { let sent = {}; try { sent = req.postDataJSON() || {}; } catch { /* none */ } if (Array.isArray(sent)) sent = sent[0] || {}; return route.fulfill({ status: 200, contentType: 'application/json', body: single ? JSON.stringify({ id: 'new-' + table, ...sent }) : '[]' }); }
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': `0-${out.length}/${out.length}` }, body: JSON.stringify(single ? out[0] || null : out) });
  });
  await ctx.route(/\/functions\/v1\/owner/, async (route) => {
    const b = route.request().postDataJSON?.() || {};
    const status = { passphrase_set: true, unlocked: true, qbo: { connected_at: iso(0.2), company_name: 'ShipBay 3PL', last_sync_at: iso(0.1), last_error: null }, smartlead_key_set: true, smartlead_campaigns: '4039101', qbo_keys_set: true, smartlead_last_sync: { at: iso(0.3) } };
    const campaign = { ok: true, campaigns: [{ id: '4039101', name: 'ShipBay — self-ship NJ brands', status: 'ACTIVE', daily_limit: 150, sent_today: 68, replied_today: 1, analytics: { sent: 525, unique_sent: 405, replies: 8, bounces: 7, total_leads: 551, completed: 12, in_progress: 380, not_started: 150, stopped: 9 } }] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b.action === 'status' ? { ...status, calendly_set: true, calendly_last_sync: { at: iso(0.1) } } : b.action === 'smartlead_campaign' ? campaign : { ok: true }) });
  });

  // --- appointment-setting stubs
  const slotList = []; { const base = new Date(); base.setHours(0, 0, 0, 0); for (let d = 1; d <= 6; d++) { const day = new Date(base); day.setDate(base.getDate() + d); if ([0, 6].includes(day.getDay())) continue; for (let m = 540; m <= 1000; m += 30) { if ((d * 7 + m) % 5 === 0) continue; const t = new Date(day); t.setMinutes(m); slotList.push({ slot: t.toISOString(), minutes: 20 }); } } }
  const TEAM_SCRIPT = "OPEN\nHi {first}, it's {me} at ShipBay in Hillsborough, New Jersey. Did I catch you with thirty seconds?\n\nWHY I'M CALLING\nWe pick, pack and ship orders for brands like {company}. No order minimums, no setup fee, and postage stays on your own carrier account. Orders in by 2pm Eastern go out the same day.\n\nASK (these are the debrief answers)\n1. Who ships your orders today: you, a 3PL, or Amazon?\n2. Roughly how many orders a month?\n3. What is the worst part of it right now: space, time, cost, or the holidays?\n\nBOOK IT\nThe next step is 20 minutes with {closer}. They price your actual month on the call. I have a couple of times open: which works?\n(Press \"Book a call\" while they are on the line.)";
  TABLES.sales_scripts = [{ id: 'sc1', owner_id: null, body: TEAM_SCRIPT, updated_at: iso(0.1) }]; TABLES.sales_availability = [];
  const up = (h, who, by, name, co, sent) => ({ id: uid(), external_id: 'portal:' + uid(), source: 'portal', name: 'Discovery call — ' + co, starts_at: new Date(Date.now() + h * 3600000).toISOString(), ends_at: new Date(Date.now() + h * 3600000 + 1200000).toISOString(), status: 'active', invitee_name: name, invitee_email: 'hello@' + co.toLowerCase().replace(/[^a-z]/g, '') + '.com', lead_id: null, assigned_to: who, booked_by: by, booked_at: iso(0.2), invite_sent_at: sent ? iso(0.2) : null, invite_error: sent ? null : 'No email on file for the prospect.' });
  meetings.push(up(19, XAVIER, SETTER, 'Priya Nair', 'Oak & Olive', true), up(43, XAVIER, SETTER, 'Tom Becker', 'Reading Coffee Company', true), up(67, XAVIER, SETTER, 'Ana Ruiz', 'Sleep On It Kids', false));
  if (AS === 'setter') { for (const c of calls.slice(0, 14)) c.by_user = SETTER; for (const l of leads) if (l.assigned_to === OWNER) l.assigned_to = null; }
  const person = (id, name, isSetter, closer, k) => ({ id, name, email: '', is_setter: isSetter, closer_id: closer, last_seen_at: iso(0.01),
    today: { dials: 41 * k | 0, connects: 9 * k | 0, booked: 2 * k | 0 }, range: { dials: 212 * k | 0, connects: 47 * k | 0, dm: 21 * k | 0, booked: 6 * k | 0, talk_seconds: 9400 * k | 0, last_call_at: iso(0.01) }, session_seconds: 61200 * k | 0,
    meetings: { booked: 7 * k | 0, canceled: 1, upcoming: 3 * k | 0, held: 3 * k | 0, no_show: 1, unmarked: k > 0.5 ? 1 : 0 },
    upcoming: meetings.filter((m) => m.booked_by === SETTER).map((m) => ({ id: m.id, starts_at: m.starts_at, name: m.name, invitee: m.invitee_name, closer: 'Xavier', invite_sent: !!m.invite_sent_at })),
    recent: calls.slice(0, 8).map((c, i) => ({ id: c.id, at: iso(0.01 + i * 0.01), outcome: c.outcome, result: null, seconds: c.seconds, note: i === 2 ? 'Owner in at 3, call back' : null, company: leads[i].company })) });
  const board = { days: 7, people: AS === 'setter' ? [person(SETTER, 'Maya Torres', true, XAVIER, 1)] : [person(SETTER, 'Maya Torres', true, XAVIER, 1), person('5e77e500-0000-4000-8000-000000000002', 'Jordan Pike', true, XAVIER, 0.6), person('5e77e500-0000-4000-8000-000000000003', 'Sam Ortiz', true, OWNER, 0.35), person(OWNER, 'Derek Harrison', false, null, 0.1), person(XAVIER, 'Xavier Delmonte', false, null, 0.05)] };
  await ctx.route(/\/rest\/v1\/rpc\/([a-z_]+)/, (route) => {
    const name = route.request().url().match(/\/rpc\/([a-z_]+)/)[1]; const b = route.request().postDataJSON?.() || {};
    const sb = (id, name, closer, k, given, un) => ({ id, name, closer_id: XAVIER, closer, calls: { dials: 212 * k | 0, connects: 47 * k | 0, dm: 21 * k | 0, today: 41 * k | 0, last_call_at: iso(0.01) }, meetings: { booked: 7 * k | 0, canceled: 1, booked_today: 2 * k | 0, upcoming: 3 * k | 0, held: 3 * k | 0, no_show: 1 }, session_seconds: 61200 * k | 0, leads: { given, untouched: un, working: (given - un) * 0.7 | 0, dead: (given - un) * 0.2 | 0, with_closer: 4 * k | 0, won: k === 1 ? 1 : 0 } });
    const score = { days: 7, me: AS === 'setter' ? SETTER : OWNER, setters: [sb(SETTER, 'Maya Torres', 'Xavier Delmonte', 1, 300, 88), sb('5e77e500-0000-4000-8000-000000000002', 'Jordan Pike', 'Xavier Delmonte', 0.6, 200, 91), sb('5e77e500-0000-4000-8000-000000000003', 'Sam Ortiz', 'Derek Harrison', 0.35, 100, 64)], pool: AS === 'setter' ? null : { total: 1200, lists: [{ list: 'B1', n: 299 }, { list: 'A3', n: 250 }, { list: 'C1', n: 203 }, { list: 'A1', n: 173 }] } };
    if (name === 'setter_scoreboard') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(score) });
    if (name === 'assign_leads') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assigned: b.p_count, asked: b.p_count, pool: 1200 - b.p_count }) });
    const out = name === 'open_slots' ? slotList : name === 'setter_board' ? board
      : name === 'book_meeting' ? { id: 'm-new', starts_at: b.p.starts_at, ends_at: b.p.starts_at, closer_name: 'Xavier Delmonte', invitee_email: b.p.invitee_email || null, status: 'active' }
      : name === 'log_call' ? { call_id: 'c-new', outcome: b.p.result === 'booked' ? 'booked' : 'no_answer', meeting_id: b.p.meeting_id || null } : null;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  const bookedResp = (b) => ({ ok: true, meeting: { id: 'm-new', starts_at: new Date(Date.now() + 26 * 3600000).toISOString(), closer_name: 'Xavier Delmonte', invitee_email: 'jordan@brooklyncandlestudio.com', status: 'active', source: 'calendly' }, host_name: 'Xavier Delmonte', setter_calendar: 'calendly', join_url: 'https://meet.google.com/abc-defg-hij' });
  await ctx.route(/\/functions\/v1\/appt/, (route) => { const b = route.request().postDataJSON?.() || {}; apptCalls.push(b.action + (b.event_uri ? ' ' + b.event_uri : ''));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b.action === 'calendly_link' ? { url: 'https://calendly.com/xavierd-shipbay3pl/intro', whose: 'Xavier Delmonte', own: true } : b.action === 'cancel' ? { ok: true } : bookedResp(b)) }); });
  const apptCalls = [];
  // Calendly's widget script, stubbed: draws where the page would be and reports what it was given
  await ctx.route(/assets\.calendly\.com\/assets\/external\/widget\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `window.Calendly = { initInlineWidget: function (o) { window.__cal = o; o.parentElement.innerHTML = '<div style="border:1.5px dashed #D9D6CF;border-radius:12px;padding:28px;min-height:420px;display:grid;place-content:center;gap:8px;text-align:center;color:#5A6473;font:600 15px Archivo"><div style="font-size:22px;color:#0F1B2A">Calendly page loads here</div><div>' + o.url.replace(/&/g, '&amp;') + '</div><div>name: ' + o.prefill.name + ' · email: ' + o.prefill.email + '</div><div>utm: ' + JSON.stringify(o.utm) + '</div></div>'; } };` }));
  for (const m of meetings) if (m.source === 'portal') { m.source = 'calendly'; m.reschedule_url = 'https://calendly.com/reschedulings/x'; m.location = 'https://meet.google.com/abc-defg-hij'; }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('CONSOLE', m.text().slice(0, 200)); });
  await page.goto('http://localhost:4173/'); await page.waitForTimeout(1400);
  fs.mkdirSync('shots', { recursive: true });
  const shot = (n) => page.screenshot({ path: `shots/${n}.png`, fullPage: false });
  const tab = async (t) => { await page.locator('.ownertabs .tabs button', { hasText: t }).first().click(); await page.waitForTimeout(900); };
  const calendlySays = () => page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://calendly.com', data: { event: 'calendly.event_scheduled', payload: { event: { uri: 'https://api.calendly.com/scheduled_events/EV123' }, invitee: { uri: 'https://api.calendly.com/scheduled_events/EV123/invitees/IN456' } } } })));
  if (AS === 'setter') {
    console.log('tabs:', (await page.locator('.ownertabs .tabs button').allInnerTexts()).join(' | '));
    await shot('60-calls-with-chain');
    await page.getByRole('button', { name: /^Calendar$/ }).last().click(); await page.waitForTimeout(1000);
    console.log('after Calendar button, tab on:', await page.locator('.ownertabs .tabs button.on').innerText());
    await shot('61-setter-calendar');
    await page.getByRole('button', { name: 'Book a call' }).click(); await page.waitForTimeout(500);
    await page.locator('.bookfind .search').fill('zzz nobody'); await page.waitForTimeout(300);
    await shot('62-calendar-book-a-call');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    await tab('Scoreboard'); await shot('63-setter-scoreboard');
    await tab('Settings'); await page.waitForTimeout(600); await shot('64-email-template');
    console.log('preview body:', JSON.stringify(await page.locator('.tplpreview pre').innerText()));
  } else {
    await page.locator('.sidenav .navitem', { hasText: /^CRM$/ }).click(); await page.waitForTimeout(1200);
    await tab('Setters'); await page.waitForTimeout(500); await shot('65-owner-leads-assign');
    await page.locator('.giverow select').first().selectOption('200'); await page.locator('.giverow .btn-sm.primary').first().click(); await page.waitForTimeout(700);
    console.log('after give:', await page.locator('.msg.ok').first().innerText());
    await shot('66-owner-after-give');
  }
  await browser.close(); srv.close(); console.log('done', AS);
})();
