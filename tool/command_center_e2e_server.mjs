#!/usr/bin/env node
// End-to-end harness for the Command Center: CHE's real Worker code
// (server/cloudflare/worker.js) behind a local HTTP port, so the Flutter
// test (test/che_command_center_e2e_test.dart) drives the real page against
// the real routes, objective graph and job queue.
//
// Offline and deterministic: outbound requests fail like they do with no
// network, storage is in memory, and the language model is a fixed fake.
// It pairs one phone and prints {"url","token"} (and writes it to --out).
//
//   node tool/command_center_e2e_server.mjs --out /tmp/che_e2e.json &
//   CHE_E2E_URL=… CHE_E2E_TOKEN=… flutter test test/che_command_center_e2e_test.dart
import http from 'node:http';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const workerDir = new URL('../server/cloudflare/', import.meta.url);
const generated = new URL(`./.e2e.${process.pid}.generated.mjs`, workerDir);
writeFileSync(generated, readFileSync(new URL('worker.js', workerDir), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
));
let mod;
try { mod = await import(generated.href); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (e2e is offline: ${new URL(String(input?.url || input)).host})`); };

// The fake model answers by what was asked, so results are checkable.
function model(input) {
  const last = JSON.stringify(input?.messages?.slice(-1) || '');
  if (/numbered plan/i.test(last)) return 'Plan: 1. Pick the niche. 2. Build the booking page. 3. Test it with five clients.';
  if (/proposal/i.test(last)) return 'Proposal: 5 page site, two weeks, 800 dollars.';
  return 'Here is the answer, sir.';
}

const saved = new Map();
const storage = {
  get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
  put: async (key, value) => saved.set(key, structuredClone(value)),
  delete: async (key) => saved.delete(key),
  list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
  setAlarm: async () => {},
  deleteAlarm: async () => {},
};
const env = {
  CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
  AI: { run: async (_model, input) => ({ response: model(input) }) },
};
const state = new CheState({ storage, waitUntil: (p) => Promise.resolve(p).catch(() => null) }, env);
env.CHE_STATE = { getByName: () => state };

const paired = await worker.fetch(new Request('http://e2e.local/api/pair', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }),
}), env);
const { device_token: token } = await paired.json();

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const request = new Request(`http://e2e.local${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
      ...(body && !['GET', 'HEAD'].includes(req.method) ? { body } : {}),
    });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: String(error?.message || error) }));
  }
});

// Durable Object alarms run the job queue in production; here a timer does.
let working = false;
setInterval(async () => {
  if (working) return;
  working = true;
  try { await state.processJobs(); } catch (_) { /* reported through job state */ } finally { working = false; }
}, 250).unref?.();

server.listen(0, '127.0.0.1', () => {
  const info = { url: `http://127.0.0.1:${server.address().port}`, token };
  const out = process.argv.indexOf('--out');
  if (out > 0 && process.argv[out + 1]) writeFileSync(process.argv[out + 1], JSON.stringify(info));
  console.log(JSON.stringify(info));
});
