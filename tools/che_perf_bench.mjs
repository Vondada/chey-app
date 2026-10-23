#!/usr/bin/env node
// CHE performance benchmark: times the real Worker (worker.js) locally with a fake model and no network.
// Measures cold import of worker.js, then each benchmark turn through /api/chat and the GETs the app polls:
// median handler time over repeated warm runs, and the storage operations each one performs.
//
//   node tools/che_perf_bench.mjs [--worker DIR] [--runs N] [--json]
//
// The budgets in tools/che_perf_budget.json are checked by che_perf_budget.test.mjs (CI). See docs/CHE_PERFORMANCE.md.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const workerDir = resolve(opt('--worker', resolve(here, '../server/cloudflare')));
const RUNS = Math.max(1, Number(opt('--runs', 15)));

// Typical owner turns: each lands on a different deterministic route or the model path.
export const TURNS = [
  { id: 'greeting', message: 'Good morning CHE' },
  { id: 'memory', message: 'What is my favorite food?' },
  { id: 'trading_status', message: 'How is paper trading going?' },
  { id: 'command', message: '/status' },
  { id: 'model', message: 'Write me two sentences about the ocean' },
];
// GETs the app makes on launch and on its refresh paths (lib/home_state, rooms).
export const GETS = ['/api/state', '/api/health', '/api/jobs', '/api/brain/ledger', '/api/security', '/api/workflows'];

export async function bench({ dir = workerDir, runs = RUNS, memories = Number(process.env.CHE_BENCH_MEMORIES || 300) } = {}) {
  globalThis.fetch = async () => new Response('{"error":"offline bench"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const mute = () => { console.log = console.warn = console.error = () => {}; };
  const unmute = () => Object.assign(console, quiet);

  const generated = resolve(dir, `.perfbench.${process.pid}.${Date.now()}.generated.mjs`);
  writeFileSync(generated, readFileSync(resolve(dir, 'worker.js'), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  ));
  let mod;
  const t0 = performance.now();
  mute();
  try { mod = await import(pathToFileURL(generated).href); } finally { unmute(); try { unlinkSync(generated); } catch (_) {} }
  const importMs = performance.now() - t0;

  const saved = new Map();
  const ops = { get: 0, che_reads: 0, put: 0, che_writes: 0, delete: 0, list: 0, sql: 0, put_bytes: 0 };
  const { DatabaseSync } = await import('node:sqlite');
  const sqlDb = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec: (q, ...p) => { ops.sql++; const stmt = sqlDb.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (k) => { ops.get++; if (k === 'che' || (Array.isArray(k) && k.includes('che'))) ops.che_reads++; return Array.isArray(k)
      ? new Map(k.filter((key) => saved.has(key)).map((key) => [key, structuredClone(saved.get(key))]))
      : (saved.has(k) ? structuredClone(saved.get(k)) : undefined); },
    put: async (k, v) => {
      ops.put++;
      if (k === 'che' || (k && typeof k === 'object' && 'che' in k)) ops.che_writes++;
      if (k && typeof k === 'object') for (const [key, value] of Object.entries(k)) { ops.put_bytes += JSON.stringify(value ?? null).length; saved.set(key, structuredClone(value)); }
      else { ops.put_bytes += JSON.stringify(v ?? null).length; saved.set(k, structuredClone(v)); }
    },
    delete: async (k) => { ops.delete++; return Array.isArray(k) ? k.filter((key) => saved.delete(key)).length : saved.delete(k); },
    list: async ({ prefix = '' } = {}) => { ops.list++; return new Map([...saved].filter(([k]) => k.startsWith(prefix))); },
    setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
  const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'The ocean is wide. It is deep.' }) } };
  const state = new mod.CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.local${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);

  mute();
  const token = (await (await call('/api/pair', { code: '123456' })).json()).device_token;
  // A lived-in brain: owner memories and chat history, so routes read realistic state sizes.
  const data = (await storage.get('che')) || {};
  data.memory_records = Array.from({ length: memories }, (_, i) => ({ id: `m${i}`, active: true, kind: 'fact', text: `Owner fact number ${i} about projects and preferences`, created_at: new Date(Date.now() - i * 3.6e6).toISOString() }));
  data.memory_records.push({ id: 'food', active: true, kind: 'preference', text: 'My favorite food is pizza', created_at: new Date().toISOString() });
  await storage.put('che', data);
  unmute();

  const measure = async (fn) => {
    const times = [];
    let opsPer = null;
    for (let r = 0; r < runs + 1; r++) {
      const before = { ...ops };
      const s = performance.now();
      mute();
      try { const res = await fn(); await res.text(); } finally { unmute(); }
      await Promise.allSettled(pending.splice(0));
      const ms = performance.now() - s;
      const delta = Object.fromEntries(Object.keys(ops).map((k) => [k, ops[k] - before[k]]));
      if (r === 0) continue; // first run warms per-isolate caches
      times.push(ms);
      opsPer = opsPer || delta;
    }
    times.sort((a, b) => a - b);
    return { median_ms: +times[Math.floor(times.length / 2)].toFixed(2), p95_ms: +times[Math.min(times.length - 1, Math.floor(times.length * 0.95))].toFixed(2), storage_ops: opsPer };
  };

  const turns = {};
  for (const t of TURNS) turns[t.id] = await measure(() => call('/api/chat', { message: t.message, history: [] }, token));
  const gets = {};
  for (const g of GETS) gets[g] = await measure(() => call(g, null, token, 'GET'));
  return { worker_bytes: readFileSync(resolve(dir, 'worker.js')).length, import_ms: +importMs.toFixed(1), runs, memories, turns, gets };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(resolve(workerDir, 'worker.js'))) { console.error(`no worker.js in ${workerDir}`); process.exit(2); }
  const out = await bench();
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`worker.js ${out.worker_bytes} bytes, cold import ${out.import_ms} ms, ${out.runs} warm runs each`);
    for (const [k, v] of [...Object.entries(out.turns).map(([k, v]) => [`chat:${k}`, v]), ...Object.entries(out.gets)]) {
      const o = v.storage_ops;
      console.log(`${k.padEnd(22)} median ${String(v.median_ms).padStart(7)} ms  p95 ${String(v.p95_ms).padStart(7)} ms  get ${o.get} (che ${o.che_reads}) put ${o.put} (che ${o.che_writes}) sql ${o.sql} list ${o.list} put_bytes ${o.put_bytes}`);
    }
  }
  process.exit(0);
}
