#!/usr/bin/env node
// Replays owner turns through CHE's real /api/chat route, locally, with a fake
// model and no network. Prints one compact block per turn: the route that
// answered (done.source, or "model"), model calls, time and the reply the
// owner would see. Turns may carry expectations; any miss exits 1.
//
//   node .claude/skills/che-debug/scripts/replay_chat.mjs case.json [--json] [--network] [--verbose]
//
// Case format: .claude/skills/che-debug/reference/replay-format.md
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Worker of the checkout this runs in (a worktree included), else the
// one next to this script.
function workerDirectory() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top && existsSync(resolve(top, 'server/cloudflare/worker.js'))) return resolve(top, 'server/cloudflare');
  } catch (_) { /* not in a git checkout */ }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../server/cloudflare');
}
const workerDir = workerDirectory();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const casePath = args.find((a) => !a.startsWith('--'));

function fail(message) {
  console.error(`replay_chat: ${message}`);
  process.exit(2);
}

if (!casePath) fail('usage: replay_chat.mjs case.json [--json] [--network] [--verbose]');
let spec;
try {
  spec = JSON.parse(readFileSync(casePath, 'utf8'));
} catch (error) {
  fail(`cannot read ${casePath}: ${error.message}`);
}
if (!Array.isArray(spec.turns) || !spec.turns.length) fail('the case needs a non-empty "turns" array');

// The fake model: one fixed reply, a list consumed in order, or regex rules
// matched against the last user message the model was given.
function modelReply(input, n) {
  const m = spec.model ?? 'Understood, sir.';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return String(m[Math.min(n, m.length - 1)] ?? '');
  const last = String((input?.messages || []).filter((x) => x.role === 'user').at(-1)?.content || '');
  const rule = (m.rules || []).find((r) => new RegExp(r.when, 'i').test(last));
  return String(rule ? rule.reply : (m.default ?? 'Understood, sir.'));
}

// Offline by default: every outbound request is refused and its host noted.
const blockedHosts = new Set();
const turnHosts = new Set();
if (!flag('--network')) {
  globalThis.fetch = async (url) => {
    let host;
    try { host = new URL(String(url?.url || url)).host; } catch (_) { host = String(url).slice(0, 60); }
    blockedHosts.add(host);
    turnHosts.add(host);
    return new Response('{"error":"offline replay"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  };
}
const quiet = !flag('--verbose');
const realLog = { log: console.log, warn: console.warn, error: console.error };
const mute = () => { if (quiet) console.log = console.warn = console.error = () => {}; };
const unmute = () => Object.assign(console, realLog);

// worker.js imports DurableObject from the Workers runtime; the copy swaps in
// a stand-in. It sits next to worker.js so its relative imports resolve.
const generated = resolve(workerDir, `.replay.${process.pid}.${Date.now()}.generated.mjs`);
let mod;
try {
  writeFileSync(generated, readFileSync(resolve(workerDir, 'worker.js'), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  ));
  mute();
  mod = await import(pathToFileURL(generated).href);
} catch (error) {
  unmute();
  fail(`could not load worker.js: ${error.message}`);
} finally {
  unmute();
  try { unlinkSync(generated); } catch (_) { /* already gone */ }
}

const saved = new Map();
const storage = {
  get: async (k) => (saved.has(k) ? structuredClone(saved.get(k)) : undefined),
  put: async (k, v) => { saved.set(k, structuredClone(v)); },
  delete: async (k) => saved.delete(k),
  list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
  setAlarm: async () => {},
  deleteAlarm: async () => {},
};
let modelCalls = 0;
const env = {
  CHE_PAIR_CODE: '123456',
  CHE_DISABLE_KEYLESS_AI: '1',
  AI: { run: async (_model, input) => ({ response: modelReply(input, modelCalls++) }) },
};
const state = new mod.CheState({ storage, waitUntil: () => {} }, env);
env.CHE_STATE = { getByName: () => state };
const send = (path, body, token = '') => mod.default.fetch(new Request(`https://che.local${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}), env);

mute();
const pairing = await (await send('/api/pair', { code: '123456' })).json().catch(() => ({}));
unmute();
const token = spec.owner === false ? '' : pairing.device_token;
if (spec.owner !== false && !token) fail('local pairing failed');
if (Array.isArray(spec.records) && spec.records.length) {
  const data = (await storage.get('che')) || {};
  data.memory_records = [...(data.memory_records || []), ...spec.records.map((r, i) => ({
    id: r.id || `replay-${i}`, active: true, created_at: new Date().toISOString(), ...r,
  }))];
  await storage.put('che', data);
}

const history = Array.isArray(spec.history) ? spec.history.slice() : [];
const results = [];
let misses = 0;
for (const [i, raw] of spec.turns.entries()) {
  const turn = typeof raw === 'string' ? { message: raw } : raw;
  const before = modelCalls;
  turnHosts.clear();
  const started = performance.now();
  mute();
  let reply = '';
  let done = {};
  let status = 0;
  try {
    const res = await send('/api/chat', { message: turn.message, history: turn.history ?? history.slice(-20), ...(turn.body || {}) }, token);
    status = res.status;
    const text = await res.text();
    const frames = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    reply = frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('').trim() || String(frames.find((f) => f.message || f.detail)?.message || frames.find((f) => f.detail)?.detail || '');
    done = frames.find((f) => f.type === 'done') || {};
  } catch (error) {
    reply = `(request failed: ${error.message})`;
  }
  unmute();
  const row = {
    turn: i + 1, message: turn.message, status, route: done.source || (modelCalls > before ? 'model' : 'none'),
    model_calls: modelCalls - before, ms: Math.round(performance.now() - started), reply,
    ...(turnHosts.size ? { refused_hosts: [...turnHosts] } : {}),
  };
  const expect = turn.expect || {};
  const problems = [];
  if (expect.route && row.route !== expect.route) problems.push(`route ${row.route}, expected ${expect.route}`);
  if (Number.isInteger(expect.model_calls) && row.model_calls !== expect.model_calls) problems.push(`model_calls ${row.model_calls}, expected ${expect.model_calls}`);
  if (expect.match && !new RegExp(expect.match, 'i').test(reply)) problems.push(`reply does not match /${expect.match}/`);
  if (expect.not && new RegExp(expect.not, 'i').test(reply)) problems.push(`reply matches forbidden /${expect.not}/`);
  if (Object.keys(expect).length) row.check = problems.length ? `FAIL: ${problems.join('; ')}` : 'PASS';
  if (problems.length) misses += 1;
  results.push(row);
  if (turn.history === undefined) history.push({ role: 'user', content: turn.message }, { role: 'assistant', content: reply });
}

if (flag('--json')) {
  console.log(JSON.stringify({ turns: results, blocked_hosts: [...blockedHosts], failed_expectations: misses }, null, 2));
} else {
  const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s)).replace(/\s+/g, ' ');
  for (const r of results) {
    console.log(`${r.turn}. route=${r.route} model_calls=${r.model_calls} ${r.ms}ms${r.status && r.status !== 200 ? ` http=${r.status}` : ''}${r.check ? ` ${r.check}` : ''}`);
    console.log(`   > ${clip(r.message, 110)}`);
    console.log(`   < ${clip(r.reply, 320)}`);
    if (r.refused_hosts) console.log(`   (offline: refused ${r.refused_hosts.join(', ')})`);
  }
  if (results.some((r) => r.check)) console.log(`${results.filter((r) => r.check === 'PASS').length}/${results.filter((r) => r.check).length} expectations met`);
}
process.exit(misses ? 1 : 0);
