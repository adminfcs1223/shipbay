// Pieces every ops screen shares: the "How this works" help strip, the brand picker (brand-first screens), the brand bar.
import { useEffect, useState } from 'react';
import { supabase } from './lib';
import { HELP } from './help';

/* ---------- Quick help: collapsed by default after the first look, per screen, per browser ---------- */
const hkey = (k) => `shipbay-help:${k}`;
export function PageHelp({ page }) {
  const h = HELP[page];
  const [open, setOpen] = useState(() => { try { return !localStorage.getItem(hkey(page)); } catch { return true; } });
  if (!h) return null;
  const toggle = () => { const n = !open; setOpen(n); try { if (!n) localStorage.setItem(hkey(page), '1'); else localStorage.removeItem(hkey(page)); } catch { /* ignore */ } };
  return (
    <div className={`help ${open ? 'open' : ''}`}>
      <button className="helphead" onClick={toggle} aria-expanded={open}>
        <span className="q">?</span><b>How {h.title} works</b><span className="what">{h.what}</span><span className="chev">{open ? '▴' : '▾'}</span>
      </button>
      {open && <ol>{h.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
    </div>
  );
}

/* ---------- Brands: one hook, one card grid ---------- */
export function useBrands() {
  const [orgs, setOrgs] = useState(null);
  const reload = async () => { const { data } = await supabase.from('orgs').select('id, name, status, go_live_status, shopify_domain, order_channels, packing_slip').order('name'); setOrgs(data || []); };
  useEffect(() => { reload(); }, []);
  return [orgs, reload];
}

/** Grid of brand cards. `stats(org)` returns [[label, value, hot?], …] shown on the card. */
export function BrandPicker({ orgs, onPick, stats, title = 'Pick a brand', hint, extra }) {
  if (orgs === null) return <div className="card"><div className="empty">Loading brands…</div></div>;
  if (!orgs.length) return <div className="card"><div className="empty">No brands yet — start one under Onboarding.</div></div>;
  return (
    <div className="brandpick">
      <div className="lbl">{title}{hint && <span className="sm"> · {hint}</span>}</div>
      <div className="brandgrid">
        {orgs.map((o) => { const st = stats ? stats(o) : []; return (
          <button key={o.id} className="brandcard" onClick={() => onPick(o.id)}>
            <div className="bname">{o.name}</div>
            <div className="bmeta">{o.go_live_status === 'live' || o.status === 'live' ? <span className="tag live">live</span> : <span className="tag founding">onboarding</span>}{channelsLabel(o)}</div>
            {st.length > 0 && <div className="bstats">{st.map(([l, v, hot]) => <div key={l}><b className={hot ? 'hot' : ''}>{v}</b><small>{l}</small></div>)}</div>}
            {extra && extra(o)}
          </button>
        ); })}
      </div>
    </div>
  );
}
export const CHANNELS = [['veeqo', 'Veeqo'], ['shopify', 'Shopify'], ['manual', 'Manual / keyed in']];
export function channelsLabel(o) {
  const c = o?.order_channels || {};
  const on = CHANNELS.filter(([k]) => c[k] && k !== 'manual').map(([, l]) => l);
  return <span className="sm"> · orders via {on.length ? on.join(' + ') : 'manual entry'}</span>;
}

/** Breadcrumb for a brand-scoped screen: "All brands › Steel Horse Leather" + right-side actions. */
export function BrandBar({ org, onBack, children, label = 'All brands' }) {
  return (
    <div className="brandbar">
      <button className="crumb" onClick={onBack}>‹ {label}</button>
      <span className="sep">›</span>
      <b>{org?.name || '…'}</b>
      <div className="spacer" />
      {children}
    </div>
  );
}
