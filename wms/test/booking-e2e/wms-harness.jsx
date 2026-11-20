// The real WMS Receive screen with the app's own data loading (wms_brands + wms_pallets), signed in as the synthetic floor login.
import { StrictMode, useEffect, useState } from 'react'; import { createRoot } from 'react-dom/client';
import '../../src/wms.css'; import { supabase } from '../../src/lib.js'; import Receive from '../../src/Receive.jsx';
function H() {
  const [orgs, setOrgs] = useState(null); const [pallets, setPallets] = useState(null);
  useEffect(() => { Promise.all([supabase.rpc('wms_brands'), supabase.from('wms_pallets').select('*').order('received_at', { ascending: false }).limit(1000)]).then(([o, p]) => { setOrgs(o.data || []); setPallets(p.data || []); }); }, []);
  const merge = (rows) => setPallets((cur) => { const m = new Map((cur || []).map((r) => [r.id, r])); rows.forEach((r) => m.set(r.id, { ...m.get(r.id), ...r })); return [...m.values()]; });
  return <Receive me={JSON.parse(import.meta.env.VITE_ME)} orgs={orgs} pallets={pallets} brandName={(id) => orgs?.find((o) => o.id === id)?.name || ''} merge={merge} open={() => {}} />;
}
createRoot(document.getElementById('root')).render(<StrictMode><H /></StrictMode>);
