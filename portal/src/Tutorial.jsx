// First-visit walkthrough for clients. Shown once per login (remembered in this browser), replayable from "Quick tour".
import { useEffect, useState } from 'react';
import { PhaseIcon } from './pages/Onboarding';

const KEY = (uid) => `shipbay-tour-v1:${uid}`;
export const tourSeen = (uid) => { try { return !!localStorage.getItem(KEY(uid)); } catch { return true; } };
const markSeen = (uid) => { try { localStorage.setItem(KEY(uid), new Date().toISOString()); } catch { /* private mode */ } };

const steps = (org) => [
  {
    title: 'Welcome to your shipbay dashboard',
    body: <>This is where {org.name}’s onboarding lives, and later your inventory, orders and billing. Takes about a minute to learn — here’s the lay of the land.</>,
    art: (
      <div className="tour-art tiles">
        {[['paperwork', 'Paperwork'], ['systems', 'Systems'], ['inventory', 'Inventory'], ['golive', 'Go-live']].map(([k, l], i) => (
          <div key={k} className={`phasetile ${i === 0 ? 'open' : ''}`}><div className="tile"><PhaseIcon kind={k} /></div><div className="plabel">{l}</div><div className="bar"><i style={{ width: `${[60, 33, 10, 0][i]}%` }} /></div></div>
        ))}
      </div>
    ),
    caption: 'Onboarding is four phases. Click a tile to open its checklist.',
  },
  {
    title: 'Reading the circles',
    body: <>Every step has a circle. You never tick these yourself — they change as things happen.</>,
    art: (
      <div className="tour-art circles">
        <div><span className="circle open" /><b>Empty</b><span>Nothing received yet — this is yours to do.</span></div>
        <div><span className="circle pending">–</span><b>Dash</b><span>We have it and shipbay is reviewing or verifying it.</span></div>
        <div><span className="circle done">✓</span><b>Check</b><span>Approved and done. The phase bar moves.</span></div>
      </div>
    ),
    caption: 'If a document comes back, you’ll see a note in orange with what to fix.',
  },
  {
    title: 'Sending us documents',
    body: <>Open a phase, find the step, and use the button on that row. PDFs for paperwork; PDF, Word, Excel or images for specs and SOPs.</>,
    art: (
      <div className="tour-art row">
        <div className="task open" style={{ border: 0 }}><span className="circle open" /><div><div className="lbl">Formation Certificate<button className="btn-xs primary" tabIndex={-1}>Upload PDF</button></div><div className="note">Articles of organization / incorporation, or equivalent.</div></div></div>
      </div>
    ),
    caption: 'Uploads land with your onboarding manager right away.',
  },
  {
    title: 'Things you sign',
    body: <>Your Rate Card, Account Agreement and SLA come from shipbay first. Until we upload them the row is greyed out. Once they’re there:</>,
    art: (
      <div className="tour-art row">
        <div className="task open" style={{ border: 0 }}><span className="circle open" /><div><div className="lbl">Rate Card Signed<button className="btn-xs" tabIndex={-1}>Download &amp; sign</button><button className="btn-xs primary" tabIndex={-1}>Upload signed copy</button></div><div className="note">Download, sign, upload — the circle turns to a dash while we check it.</div></div></div>
      </div>
    ),
    caption: 'Two buttons: get the file, then send it back signed.',
  },
  {
    title: 'Connecting your systems',
    body: <>Under <b>Systems</b>, connect the shipping-label account you already use and your store or marketplace. Pick the service, sign in or paste its API keys — we verify the connection live and never store credentials in your browser.</>,
    art: (
      <div className="tour-art provs">
        {['ShipStation', 'Shippo', 'UPS', 'FedEx', 'USPS', 'Shopify', 'WooCommerce', 'Amazon', 'TikTok Shop'].map((n) => <span key={n} className="prov mini"><b>{n}</b></span>)}
        <button className="btn-xs primary" tabIndex={-1}>Connect</button>
      </div>
    ),
    caption: 'Once a store is connected, orders start flowing to the warehouse automatically.',
  },
  {
    title: 'Products, documents, and your team',
    body: <>In the left menu: <b>Products</b> is your SKU list — view, edit, add; keep weights and sizes current. <b>Documents</b> is everything on file with its status. And your team is always on the right of this page.</>,
    art: (
      <div className="tour-art nav">
        <div className="fakenav"><span className="navitem active">Overview</span><span className="navitem">Products</span><span className="navitem">Documents</span></div>
        <div className="team mini"><div className="person"><div className="avatar">{(org.sales_rep || 'S').split(/\s+/).map((w) => w[0]).join('').slice(0, 2)}</div><div><b>{org.sales_rep}</b><div className="small">Sales &amp; onboarding</div></div></div>
          <div className="person"><div className="avatar ops">{(org.ops_manager || 'O').split(/\s+/).map((w) => w[0]).join('').slice(0, 2)}</div><div><b>{org.ops_manager}</b><div className="small">Account Operations Manager</div></div></div></div>
      </div>
    ),
    caption: 'Stuck on anything? Call or email either of them — replies come from a person, not a queue.',
  },
];

export default function Tutorial({ me, org, onClose }) {
  const S = steps(org);
  const [i, setI] = useState(0);
  const last = i === S.length - 1;
  const finish = () => { markSeen(me.id); onClose(); };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') finish(); if (e.key === 'ArrowRight' && !last) setI(i + 1); if (e.key === 'ArrowLeft' && i > 0) setI(i - 1); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  const s = S[i];
  return (
    <div className="overlay tour" onMouseDown={(e) => e.target === e.currentTarget && finish()}>
      <div className="modal tourmodal">
        <div className="tourhead"><img src="/brand/09-mark.svg" alt="" /><span>Quick tour · {i + 1} of {S.length}</span><button className="x" onClick={finish} aria-label="Close">×</button></div>
        <h3>{s.title}<span className="dot">.</span></h3>
        <p className="lead">{s.body}</p>
        {s.art}
        <div className="caption">{s.caption}</div>
        <div className="tourfoot">
          <div className="dots">{S.map((_, k) => <button key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)} aria-label={`Step ${k + 1}`} />)}</div>
          <div className="spacer" />
          {i > 0 && <button className="btn-sm" onClick={() => setI(i - 1)}>Back</button>}
          {!last ? <button className="btn-sm primary" onClick={() => setI(i + 1)}>Next →</button> : <button className="btn-sm primary" onClick={finish}>Got it — let’s go</button>}
        </div>
      </div>
    </div>
  );
}
