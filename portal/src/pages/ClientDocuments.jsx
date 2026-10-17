// Client-facing Documents: everything on file for their account, grouped, with status.
import { useEffect, useState } from 'react';
import { supabase } from '../lib';

const GROUPS = [
  ['Account paperwork', ['intake_form', 'w9', 'formation_cert', 'rate_card', 'agreement', 'sla', 'insurance', 'resale_cert']],
  ['Operations', ['packaging_spec', 'returns_rules', 'packing_sops', 'routing_guide', 'sku_catalog']],
  ['Other', ['other']],
];
const STATUS = { pending: ['In review', 'pending'], approved: ['Approved', 'approved'], rejected: ['Needs a new copy', 'rejected'] };
const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const size = (b) => (!b ? '' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export default function ClientDocuments({ me }) {
  const [docs, setDocs] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!me?.org_id) return;
    supabase.from('documents').select('*').eq('org_id', me.org_id).order('created_at', { ascending: false }).then(({ data }) => setDocs(data || []));
  }, [me?.org_id]);
  const view = async (d) => {
    const { data, error } = await supabase.storage.from('client-docs').createSignedUrl(d.storage_path, 600);
    if (error) return setErr(error.message);
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  const grouped = GROUPS.map(([title, kinds]) => [title, (docs || []).filter((d) => kinds.includes(d.kind))]).filter(([, l]) => l.length);
  const stray = (docs || []).filter((d) => !GROUPS.some(([, k]) => k.includes(d.kind)));
  if (stray.length) grouped.push(['Other', stray]);

  return (
    <>
      <div className="pagehead"><div><h1>Documents<span className="dot">.</span></h1><p className="sub">Everything on file for your account. Upload new items from the Overview checklist.</p></div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="card doccard">
        {docs === null ? <div className="empty">Loading…</div> : docs.length === 0 ? <div className="empty">Nothing on file yet — your paperwork will show up here as it comes in.</div> : grouped.map(([title, list]) => (
          <div key={title} className="docgroup">
            <div className="grouplabel">{title}</div>
            <table className="doctable">
              <tbody>
                {list.map((d) => {
                  const st = d.for_signature ? ['Awaiting your signature', 'pending'] : STATUS[d.status] || ['On file', 'approved'];
                  return (
                    <tr key={d.id}>
                      <td><b>{d.title.replace(/ — .*$/, '')}</b><div className="small">{fmt(d.created_at)}{d.size_bytes ? ` · ${size(d.size_bytes)}` : ''}</div></td>
                      <td><span className={`pill ${st[1]}`}>{st[0]}</span>{d.status === 'rejected' && d.review_note && <div className="small warn">{d.review_note}</div>}</td>
                      <td className="r"><button className="viewdoc" onClick={() => view(d)}>Open</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  );
}
