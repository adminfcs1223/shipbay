// Edge Function host for the temporary movement test runner (runner.js). shipbay-nexus-dev ONLY. NOT DEPLOYED.
// As shipped in the repository the gate below is closed: every request gets a bare 404.
// At deploy: GATE.sha256 = the SHA-256 of a fresh random token (the token itself is never stored), GATE.notAfter = one hour ahead.
// Deploy with verify_jwt off (the gate is the token) into the "bridge-smoke" slot; put the inert stub back when the run is over.
// deno-lint-ignore-file no-explicit-any
import { makeRunner } from './runner.js';

const GATE = { sha256: 'CLOSED', notAfter: 0 };
Deno.serve(makeRunner({ env: Deno.env.toObject(), fetchImpl: fetch, gate: GATE, defer: (p: Promise<unknown>) => (globalThis as any).EdgeRuntime?.waitUntil?.(p) }));
