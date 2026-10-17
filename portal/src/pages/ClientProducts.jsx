// Client: their own product catalog, editable.
import SkuTable from '../SkuTable';

export default function ClientProducts({ me }) {
  if (!me?.org_id) return null;
  return (
    <>
      <div className="pagehead"><div><h1>Products<span className="dot">.</span></h1><p className="sub">Your SKUs as the warehouse knows them. Keep weights and dimensions current — they drive postage and packaging.</p></div></div>
      <SkuTable orgId={me.org_id} title="Catalog" />
    </>
  );
}
