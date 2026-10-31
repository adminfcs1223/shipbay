// Sales — the salesperson's desk. Same CRM as the owner's Sales section, scoped to this rep: their own leads and
// booked calls, plus the shared pool of untouched leads to call. Everything they touch becomes theirs.
import Sales from './owner/Sales';

export default function SalesDesk({ me, go }) {
  if (!me?.is_sales && !me?.is_owner) return <div className="card"><div className="empty">Ask Derek to add you to the sales team (Owner → Team).</div></div>;
  return (
    <div className="owner">
      <div className="pagehead">
        <div><h1>Sales<span className="dot">.</span></h1><p className="sub">Your pipeline, your replies, your booked calls — and the shared pool of untouched leads.</p></div>
      </div>
      <Sales me={me} status={null} refreshStatus={() => {}} rep nav={go} />
    </div>
  );
}
