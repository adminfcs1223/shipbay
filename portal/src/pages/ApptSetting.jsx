// Appt. Setting — where a new salesperson starts (Derek, 2026-11-10): dial the queue with the script open, book the call
// on the closer's calendar while the prospect is on the line, send your email after the call, answer replies. Nothing else.
// Setters (role shipbay_setter) see only this; closers and the owner get it next to the CRM.
import Sales, { APPT_TABS } from './owner/Sales';

export default function ApptSetting({ me, go }) {
  if (!me?.is_sales && !me?.is_owner && me?.role !== 'shipbay_setter') return <div className="card"><div className="empty">Ask Derek to add you to the sales team (Owner → Team).</div></div>;
  return (
    <div className="owner">
      <div className="pagehead">
        <div><h1>Appt. Setting<span className="dot">.</span></h1></div>
      </div>
      <Sales me={me} status={null} refreshStatus={() => {}} rep nav={go} tabs={APPT_TABS} initial="calls" />
    </div>
  );
}
