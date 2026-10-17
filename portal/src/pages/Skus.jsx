// Staff: view and edit any client's SKU catalog.
import { useEffect, useState } from 'react';
import { supabase } from '../lib';
import SkuTable from '../SkuTable';

export default function Skus() {
  const [orgs, setOrgs] = useState([]);
  const [sel, setSel] = useState('');
  useEffect(() => {
    supabase.from('orgs').select('id, name, status').in('status', ['onboarding', 'active', 'paused']).order('name').then(({ data }) => { setOrgs(data || []); setSel((s) => s || data?.[0]?.id || ''); });
  }, []);
  const org = orgs.find((o) => o.id === sel);
  return (
    <>
      <div className="pagehead">
        <div><h1>SKUs<span className="dot">.</span></h1><p className="sub">Each client’s product catalog — what the warehouse picks, packs and counts.</p></div>
        <select className="orgpick" value={sel} onChange={(e) => setSel(e.target.value)}>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      </div>
      {org && <SkuTable orgId={org.id} title={`${org.name} — catalog`} staff />}
    </>
  );
}
