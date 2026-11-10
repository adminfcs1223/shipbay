// CRM — the salesperson's desk: pipeline, contacts, calendar, quotes, onboarding, bonus, settings — scoped to this rep.
// Dialing and the reply inbox live under Appt. Setting (Derek, 2026-11-10): setters dial and book; closers work the pipeline here.
import Sales, { CRM_TABS } from './owner/Sales';

export default function SalesDesk({ me, go }) {
  if (!me?.is_sales && !me?.is_owner) return <div className="card"><div className="empty">Ask Derek to add you to the sales team (Owner → Team).</div></div>;
  return (
    <div className="owner">
      <div className="pagehead">
        <div><h1>CRM<span className="dot">.</span></h1></div>
      </div>
      <Sales me={me} status={null} refreshStatus={() => {}} rep nav={go} tabs={CRM_TABS} />
    </div>
  );
}
