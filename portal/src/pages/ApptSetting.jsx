// Appt. Setting — where a new salesperson starts (Derek, 2026-11-10): dial the queue, send your email after the call,
// answer replies, book calls for the closers. Nothing else. Same data and rules as the CRM, scoped to the signed-in rep.
import Sales, { APPT_TABS } from './owner/Sales';

export default function ApptSetting({ me, go }) {
  if (!me?.is_sales && !me?.is_owner) return <div className="card"><div className="empty">Ask Derek to add you to the sales team (Owner → Team).</div></div>;
  return (
    <div className="owner">
      <div className="pagehead">
        <div><h1>Appt. Setting<span className="dot">.</span></h1></div>
      </div>
      <Sales me={me} status={null} refreshStatus={() => {}} rep nav={go} tabs={APPT_TABS} initial="calls" />
    </div>
  );
}
