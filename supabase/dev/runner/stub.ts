// What the "bridge-smoke" slot holds whenever no test run is in progress: nothing. Deploy with verify_jwt on.
// (Edge Functions cannot be deleted through the tools used here; Derek can delete the slot in the dashboard.)
Deno.serve(() => new Response(JSON.stringify({ ok: false, error: 'retired', message: 'This test runner has been retired.' }), { status: 410, headers: { 'content-type': 'application/json' } }));
