// How the bridge reaches ShipBay's own database: its functions over the project's REST interface. As the signed-in user (their
// token, so every staff check in the database applies to them) or as the bridge (service key, for the two steps only the bridge may do).
export function postgrest({ url, anonKey, serviceKey, fetchImpl = fetch }) {
  const rpc = (apikey, bearer) => async (fn, args) => {
    if (!/^[a-z_]{1,60}$/.test(fn)) throw new Error('bad function name');
    const r = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey, authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(args || {}) });
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new Error((j && typeof j.message === 'string' && j.message) || 'The database refused the request.');
    return j;
  };
  return { user: (token) => ({ rpc: rpc(anonKey, token) }), service: { rpc: rpc(serviceKey, serviceKey) } };
}
