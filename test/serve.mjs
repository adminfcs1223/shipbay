// Local stand-in for the Netlify site, for the browser test only: serves public/ and routes /api/nexus/* to the real
// function, which talks to the stand-in Nexus. Nothing here reaches the network.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { makeHandler } from '../netlify/functions/nexus.mjs'; import { makeStub } from './stub-nexus.mjs';
const here = path.dirname(new URL(import.meta.url).pathname); const pub = path.join(here, '../public');
const stub = makeStub(); const handle = makeHandler({ env: { NEXUS_STAGING_API_KEY: stub.key, PREVIEW_PASSCODE: process.env.PREVIEW_PASSCODE || 'preview-passcode-123' }, fetchImpl: stub.fetchImpl });
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/nexus')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handle(new Request('http://127.0.0.1:4610' + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(await r.text());
  }
  const f = path.join(pub, req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(pub) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)], 'content-security-policy': CSP }); fs.createReadStream(f).pipe(res);
}).listen(4610, '127.0.0.1', () => console.log('READY'));
