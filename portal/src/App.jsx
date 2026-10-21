import { useEffect, useState } from 'react';
import { supabase, forgetLocalSession, RECOVERY_LANDING, RESET_TOKEN } from './lib';
import { isAuthHost, isAppHost, splitMode, authUrl, handoffToApp, takeHandoff } from './hosts';
import Onboarding from './pages/Onboarding';
import Compliance from './pages/Compliance';
import ClientHome from './pages/ClientHome';
import ClientDocuments from './pages/ClientDocuments';
import ClientSettings from './pages/ClientSettings';
import Skus from './pages/Skus';
import Marketplaces from './pages/Marketplaces';
import ClientProducts from './pages/ClientProducts';
import Orders from './pages/Orders';
import Receiving from './pages/Receiving';
import PackShip from './pages/PackShip';
import Quotes from './pages/Quotes';
import ClientOrders from './pages/ClientOrders';
import AdminSettings from './pages/AdminSettings';
import { PageHelp } from './shared';

const STAFF = ['shipbay_admin', 'shipbay_staff'];

export default function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(null);

  const [handoffFailed, setHandoffFailed] = useState(false);
  const [recovery, setRecovery] = useState(RECOVERY_LANDING || !!RESET_TOKEN);
  const [resetFailed, setResetFailed] = useState(false);

  useEffect(() => {
    let booted = false;
    // Ignore auth events (incl. the INITIAL_SESSION=null that fires immediately) until the bootstrap below has settled;
    // otherwise dashboard. bounces to auth. before the handed-off session is stored → redirect loop.
    const { data: sub } = supabase.auth.onAuthStateChange((e, s) => { if (e === 'PASSWORD_RECOVERY') setRecovery(true); if (booted) setSession(s); });
    (async () => {
      if (RESET_TOKEN) { // our reset link: turn the one-time token into a session, then the new-password screen shows
        const { error } = await supabase.auth.verifyOtp({ token_hash: RESET_TOKEN, type: 'recovery' });
        if (error) { setRecovery(false); setResetFailed(true); }
      }
      const t = isAppHost ? takeHandoff() : null;
      if (t) {
        const { error } = await supabase.auth.setSession(t);
        if (error) setHandoffFailed(true);
      }
      const { data } = await supabase.auth.getSession();
      booted = true;
      setSession(data.session);
    })();
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setMe(null); return; }
    (async () => {
      const { data: p } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
      let orgName = null;
      if (p?.org_id) { const { data: o } = await supabase.from('orgs').select('name').eq('id', p.org_id).single(); orgName = o?.name ?? null; }
      setMe({ ...p, isStaff: STAFF.includes(p?.role), orgName });
    })();
  }, [session]);

  if (session === undefined) return null;
  // came in from a password-reset email: set the new password first, on whichever host the link opened
  if (recovery && session) return <SetPassword session={session} onDone={() => setRecovery(false)} />;
  if (isAuthHost) {
    // auth. never shows the app: a stored session is handed to dashboard. once the server confirms it is still valid
    if (session) return <AuthHandoff session={session} onInvalid={() => setSession(null)} />;
    return <SignIn note={resetFailed ? 'That reset link has expired or was already used. Enter your email and tap “Forgot password?” for a fresh one.' : undefined} />;
  }
  if (!session) {
    if (isAppHost) {
      if (handoffFailed) return <SignIn note="Your sign-in didn’t carry over. Please sign in again." />;
      window.location.replace(authUrl()); return null;
    }
    return <SignIn />;
  }
  return <Shell me={me} />;
}

function AuthHandoff({ session, onInvalid }) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { error } = await supabase.auth.getUser(session.access_token);
      if (cancelled) return;
      forgetLocalSession();
      if (error) onInvalid(); else handoffToApp(session);
    })();
    return () => { cancelled = true; };
  }, [session, onInvalid]);
  return null;
}

/* ---------- Password reset landing ---------- */
function SetPassword({ session, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setMsg(null);
    if (pw.length < 10) return setMsg({ kind: 'err', text: 'Use at least 10 characters.' });
    if (pw !== pw2) return setMsg({ kind: 'err', text: 'Those two don’t match.' });
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) { setBusy(false); return setMsg({ kind: 'err', text: error.message }); }
    setMsg({ kind: 'ok', text: 'Password updated — taking you in…' });
    const { data } = await supabase.auth.getSession();
    const s = data.session || session;
    if (isAuthHost) { forgetLocalSession(); handoffToApp(s); return; }
    onDone();
  };
  return (
    <div className="split">
      <aside className="brandside">
        <div>
          <a className="logo" href="https://www.shipbay3pl.com"><img src="/brand/06-horizontal-reverse.svg" alt="shipbay." /></a>
          <div className="tagline">shipbay.dashboard — client portal</div>
        </div>
        <h1>Choose a new password<em>.</em></h1>
        <p className="sub">You’re signed in as <b style={{ color: '#fff' }}>{session.user?.email}</b>. Pick a password you’ll remember and you’ll go straight to your dashboard.</p>
        <div className="foot">© 2026 shipbay. · 115 Stryker Ln, Unit 10, Hillsborough Township, NJ</div>
      </aside>
      <section className="formside">
        <div className="top">&nbsp;</div>
        <form className="formbox" onSubmit={submit}>
          <h2>New password<span className="dot">.</span></h2>
          <p className="lead">At least 10 characters. Use a mix you don’t use anywhere else.</p>
          {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
          <div className="field"><label htmlFor="npw">New password</label><input id="npw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus /></div>
          <div className="field"><label htmlFor="npw2">Confirm new password</label><input id="npw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></div>
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save password & continue'}</button>
        </form>
        <div className="legal">Didn’t request this? <a href="mailto:derekh@shipbay3pl.com">Let us know</a>.</div>
      </section>
    </div>
  );
}

/* ---------- Sign-in (ported from site/portal.html) ---------- */
function SignIn({ note }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(true);
  const [msg, setMsg] = useState(note ? { kind: 'err', text: note } : null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (!error && isAuthHost) return; // stay busy; the session event mounts AuthHandoff, which carries it to dashboard.
    setBusy(false);
    if (error) setMsg({ kind: 'err', text: error.message === 'Invalid login credentials' ? 'That email and password don’t match. Try again or reset your password.' : error.message });
  };
  const reset = async () => {
    if (!email.trim()) return setMsg({ kind: 'err', text: 'Enter your work email first, then tap “Forgot password?”' });
    setBusy(true);
    const { data, error } = await supabase.functions.invoke('password-reset', { body: { action: 'request', email: email.trim() } });
    setBusy(false);
    setMsg(error ? { kind: 'err', text: 'Couldn’t send the reset email just now — try again in a minute.' } : { kind: 'ok', text: data?.message || 'If that email has a shipbay login, a reset link is on its way.' });
  };

  return (
    <div className="split">
      <aside className="brandside">
        <div>
          <a className="logo" href="https://www.shipbay3pl.com"><img src="/brand/06-horizontal-reverse.svg" alt="shipbay." /></a>
          <div className="tagline">shipbay.dashboard — client portal</div>
        </div>
        <h1>Your whole operation,<br />one dashboard<em>.</em></h1>
        <p className="sub">Live inventory, orders, and itemized billing across your shipbay warehouse — synced straight from your store.</p>
        <div className="mock" aria-hidden="true">
          <div className="mh"><b>shipbay.dashboard</b><span className="pill">PRODUCT PREVIEW</span></div>
          <div className="mstats">
            <div className="ms"><b>2,847</b><small>Orders today</small></div>
            <div className="ms"><b>14,208</b><small>Units on hand</small></div>
            <div className="ms"><b>99.8%</b><small>Accuracy — 30d</small></div>
          </div>
        </div>
        <div className="foot">© 2026 shipbay. · 115 Stryker Ln, Hillsborough Township, NJ</div>
      </aside>

      <section className="formside">
        <div className="top">New to shipbay?&nbsp;<a href="https://www.shipbay3pl.com/book">Book a free consultation →</a></div>
        <form className="formbox" onSubmit={submit}>
          <h2>Sign in to your portal<span className="dot">.</span></h2>
          <p className="lead">Track orders, inventory, and billing for your brand.</p>
          {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
          <div className="field"><label htmlFor="email">Work email</label><input id="email" type="email" placeholder="you@yourbrand.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></div>
          <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" placeholder="••••••••••" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></div>
          <div className="row-between">
            <label><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in</label>
            <button type="button" className="linkbtn" onClick={reset}>Forgot password?</button>
          </div>
          <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to shipbay.dashboard'}</button>
          <div className="signup-note"><b>Don’t have a login yet?</b> Portal access is created by your onboarding manager when your brand goes live with shipbay — or <a href="https://www.shipbay3pl.com/book" style={{ color: 'var(--orange-soft)', fontWeight: 600 }}>book a consultation</a> to get started.</div>
        </form>
        <div className="legal">Trouble signing in? <a href="mailto:derekh@shipbay3pl.com">Contact us</a> · <a href="https://www.shipbay3pl.com">shipbay</a></div>
      </section>
    </div>
  );
}

/* ---------- Signed-in app: left nav column + content ---------- */
const svg = (d) => <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
const Ico = {
  onboarding: svg(<><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>),
  home: svg(<><path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/></>),
  documents: svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></>),
  skus: svg(<><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></>),
  settings: svg(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>),
  markets: svg(<><path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 11v9h14v-9"/><path d="M9 20v-5h6v5"/></>),
  compliance: svg(<><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></>),
  orders: svg(<><path d="M4 4h16v16H4z"/><path d="M4 9h16"/><path d="M9 13h6"/></>),
  receiving: svg(<><path d="M3 12l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M12 14v6"/><path d="M9 17l3 3 3-3"/></>),
  pack: svg(<><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/><path d="M7.5 5l9 4"/></>),
  admin: svg(<><path d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0z"/><path d="M4 21v-1a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v1"/><path d="M19 3v4M17 5h4"/></>),
  quotes: svg(<><path d="M12 2v20"/><path d="M17 6.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.5 5 3 5 1.3 5 3.5-2.2 3.5-5 3.5-5-1.3-5-3"/></>),
};
// Grouped so the station screens sit together, client admin together, and setup at the bottom.
const STAFF_NAV = [
  { group: 'Warehouse' },
  { key: 'orders', label: 'Orders', icon: Ico.orders, page: Orders, brandFirst: true },
  { key: 'receiving', label: 'Receiving', icon: Ico.receiving, page: Receiving, brandFirst: true },
  { key: 'pack', label: 'Pack & Ship', icon: Ico.pack, page: PackShip, brandFirst: true },
  { group: 'Clients' },
  { key: 'onboarding', label: 'Onboarding', icon: Ico.onboarding, page: Onboarding },
  { key: 'quotes', label: 'Quotes', icon: Ico.quotes, page: Quotes },
  { key: 'compliance', label: 'Documents review', icon: Ico.compliance, page: Compliance },
  { key: 'skus', label: 'SKUs', icon: Ico.skus, page: Skus },
  { key: 'settings', label: 'Client settings', icon: Ico.settings, page: ClientSettings },
  { group: 'Setup' },
  { key: 'markets', label: 'Integrations', icon: Ico.markets, page: Marketplaces },
  { key: 'admin', label: 'Admin settings', icon: Ico.admin, page: AdminSettings, adminOnly: true },
];
const CLIENT_NAV = [
  { group: 'Your account' },
  { key: 'home', label: 'Overview', icon: Ico.home, page: ClientHome },
  { key: 'corders', label: 'Orders', icon: Ico.orders, page: ClientOrders },
  { key: 'products', label: 'Products', icon: Ico.skus, page: ClientProducts },
  { key: 'documents', label: 'Documents', icon: Ico.documents, page: ClientDocuments },
];

function Shell({ me }) {
  const nav = (!me ? [] : me.isStaff ? STAFF_NAV : CLIENT_NAV).filter((n) => !n.adminOnly || me?.role === 'shipbay_admin');
  const items = nav.filter((n) => n.key);
  const [page, setPage] = useState(null);
  const [params, setParams] = useState({});
  // the brand the station screens are scoped to; chosen once, kept while moving between Orders / Receiving / Pack & Ship
  const [brand, setBrandState] = useState(() => { try { return localStorage.getItem('shipbay-brand') || null; } catch { return null; } });
  const [brandName, setBrandName] = useState(null);
  const setBrand = (id) => { setBrandState(id); try { if (id) localStorage.setItem('shipbay-brand', id); else localStorage.removeItem('shipbay-brand'); } catch { /* ignore */ } };
  useEffect(() => { if (!brand) { setBrandName(null); return; } supabase.from('orgs').select('name').eq('id', brand).single().then(({ data }) => setBrandName(data?.name || null)); }, [brand]);
  const go = (key, p = {}) => { if (p.org) setBrand(p.org); setParams(p); setPage(key); };
  useEffect(() => { if (!page && items.length) setPage(items[0].key); }, [items.length, page]);
  const active = items.find((n) => n.key === page);
  const Page = active?.page;
  const signOut = async () => { await supabase.auth.signOut(); if (splitMode) window.location.replace(authUrl()); };

  return (
    <div className="app">
      <aside className="sidenav">
        <a className="logo" href="/"><img src="/brand/06-horizontal-reverse.svg" alt="shipbay." /></a>
        <div className="tagline">shipbay.dashboard</div>
        {nav.map((n, i) => n.group
          ? <div key={`g${i}`} className="section">{n.group}</div>
          : <button key={n.key} className={`navitem ${page === n.key ? 'active' : ''}`} onClick={() => go(n.key)}>{n.icon}{n.label}</button>)}
        {me?.isStaff && (
          <div className="brandchip">
            <small>Working in</small>
            {brand ? <><b>{brandName || '…'}</b><button onClick={() => setBrand(null)} title="Back to all brands">×</button></> : <b className="all">All brands</b>}
          </div>
        )}
        <div className="me">
          {me && <><b>{me.full_name || me.email}</b>{me.orgName || me.email}<br /><span className="role">{me.isStaff ? 'shipbay staff' : 'client'}</span></>}
          <br /><button onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        {Page ? <>
          <PageHelp page={page} />
          <Page key={page} me={me} go={go} params={params} brand={brand} setBrand={setBrand} />
        </> : (
          <div className="stage">
            <div className="blank">
              <img className="mark" src="/brand/09-mark.svg" alt="" />
              <h2>Your dashboard is being set up<span className="dot">.</span></h2>
              <p>{me?.isStaff ? 'Ops screens are coming online here.' : 'Your onboarding manager will light this up as your brand goes live with shipbay.'}</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
