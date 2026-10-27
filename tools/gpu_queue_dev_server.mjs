// Test helper: CHE's real GPU queue routes (server/cloudflare/gpu_queue.js) on a local port with in-memory storage,
// so tools/test_che_gpu_worker.py can run the Colab worker end to end. Not deployed anywhere.
//   node tools/gpu_queue_dev_server.mjs  -> prints {"port":..., "token":...}
// Owner routes need no auth here; POST /__advance {ms} moves the queue's clock (to expire a lease).
// CHE_TEST_OIDC_JWKS='{"keys":[...]}' makes that JWKS the answer to GitHub's OIDC key URL, so a test can sign its own
// github_cpu worker tokens (aud che-creation-engine, repository Vondada/chey-app, the creation workflow on main).
import http from 'node:http';
import { GpuQueue, gpuOwnerRoute, gpuWorkerRoute } from '../server/cloudflare/gpu_queue.js';

const m = new Map();
const storage = { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k),
  list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
let offset = 0;
const now = () => Date.now() + offset;
const token = await new GpuQueue(storage, now).createToken();
const testJwks = process.env.CHE_TEST_OIDC_JWKS || '';
// Offline: only the OIDC key URL answers (with the test JWKS); anything else (a GitHub dispatch) is refused.
const fetcher = async (url) => (testJwks && String(url).startsWith('https://token.actions.githubusercontent.com/')
  ? new Response(testJwks, { status: 200, headers: { 'Content-Type': 'application/json' } })
  : new Response('{"message":"offline dev server"}', { status: 503 }));

const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = `http://127.0.0.1${req.url}`; const path = new URL(url).pathname;
  if (path === '/__advance') { offset += JSON.parse(raw.toString() || '{}').ms || 0; res.end('{}'); return; }
  if (path === '/__media') { res.end(JSON.stringify((m.get('media:index') || m.get('media') || []).length ?? 0)); return; }
  const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
  let out = await gpuWorkerRoute({ storage, env: {}, now, fetcher }, path, request);
  if (!out) out = await gpuOwnerRoute({ storage, now, fetcher }, path, request, raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw.toString()) : {});
  if (!out) { res.statusCode = 404; res.end('{}'); return; }
  res.statusCode = out.status; res.setHeader('Content-Type', 'application/json'); res.end(Buffer.from(await out.arrayBuffer()));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, token })));
