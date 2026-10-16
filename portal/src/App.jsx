import { useEffect, useState } from 'react';
import { supabase, forgetLocalSession } from './lib';
import { isAuthHost, isAppHost, splitMode, authUrl, handoffToApp, takeHandoff } from './hosts';
import Onboarding from './pages/Onboarding';
import ClientHome from './pages/ClientHome';
import ClientDocuments from './pages/ClientDocuments';

const STAFF = ['shipbay_admin', 'shipbay_staff'];

export default function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(null);

  const [handoffFailed, setHandoffFailed] = useState(false);

  useEffect(() => {
    let booted = false;
    // Ignore auth events (incl. the INITIAL_SESSION=null that fires immediately) until the bootstrap below has settled;
    // otherwise dashboard. bounces to auth. before the handed-off session is stored → redirect loop.
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { if (booted) setSession(s); });
    (async () => {
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
  if (isAuthHost) {
    // auth. never shows the app: a stored session is handed to dashboard. once the server confirms it is still valid
    if (session) return <AuthHandoff session={session} onInvalid={() => setSession(null)} />;
    return <SignIn />;
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
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: authUrl() });
    setMsg(error ? { kind: 'err', text: error.message } : { kind: 'ok', text: 'Check your inbox — a reset link is on its way.' });
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
};
const STAFF_NAV = [
  { key: 'onboarding', label: 'Onboarding', icon: Ico.onboarding, page: Onboarding },
];
const CLIENT_NAV = [
  { key: 'home', label: 'Overview', icon: Ico.home, page: ClientHome },
  { key: 'documents', label: 'Documents', icon: Ico.documents, page: ClientDocuments },
];

function Shell({ me }) {
  const nav = !me ? [] : me.isStaff ? STAFF_NAV : CLIENT_NAV;
  const [page, setPage] = useState(null);
  useEffect(() => { if (!page && nav.length) setPage(nav[0].key); }, [nav.length, page]);
  const active = nav.find((n) => n.key === page);
  const Page = active?.page;
  const signOut = async () => { await supabase.auth.signOut(); if (splitMode) window.location.replace(authUrl()); };

  return (
    <div className="app">
      <aside className="sidenav">
        <a className="logo" href="/"><img src="/brand/06-horizontal-reverse.svg" alt="shipbay." /></a>
        <div className="tagline">shipbay.dashboard</div>
        {nav.length > 0 && <div className="section">{me?.isStaff ? 'Operations' : 'Your account'}</div>}
        {nav.map((n) => (
          <button key={n.key} className={`navitem ${page === n.key ? 'active' : ''}`} onClick={() => setPage(n.key)}>{n.icon}{n.label}</button>
        ))}
        <div className="me">
          {me && <><b>{me.full_name || me.email}</b>{me.orgName || me.email}<br /><span className="role">{me.isStaff ? 'shipbay staff' : 'client'}</span></>}
          <br /><button onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        {Page ? <Page me={me} /> : (
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
