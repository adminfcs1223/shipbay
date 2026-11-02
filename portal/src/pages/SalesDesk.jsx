// Sales — the CRM, in HubSpot's clothes. Same data and rules as before (reps see their own leads + the untouched pool);
// HubSpot is the record underneath and the two stay in sync.
import Hub from './hub/Hub';

export default function SalesDesk({ me, go }) {
  if (!me?.is_sales && !me?.is_owner) return <div className="card"><div className="empty">Ask Derek to add you to the sales team (Admin → Team).</div></div>;
  return <Hub me={me} status={null} refreshStatus={() => {}} rep nav={go} />;
}
