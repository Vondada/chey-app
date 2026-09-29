// End-to-end Office wiring through the real Worker routes: permission flags,
// Codex work packets, CHE-only chat, unprompted blocker speech, and the
// Office voice phrases after the wake word.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const generated = new URL('./.office_wiring.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
let CheState;
try {
  ({ default: worker, CheState } = await import(`${generated.href}?test=${Date.now()}`));
} finally {
  try { unlinkSync(generated); } catch (_) {}
}

async function office(envExtra = {}) {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', AI: { run: async () => ({ response: 'Done.' }) }, ...envExtra };
  const state = new CheState({ storage: {
    get: async (key) => (saved.has(key) ? JSON.parse(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, JSON.stringify(value)),
    delete: async (key) => saved.delete(key),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const raw = (path, init) => worker.fetch(new Request(`https://che.example${path}`, init), env);
  const token = (await (await raw('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }),
  })).json()).device_token;
  const send = (path, method = 'GET', body) => raw(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const say = async (message, extra = {}) => {
    const text = await (await send('/api/chat', 'POST', { message, ...extra })).text();
    return text.trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.type === 'delta').map((e) => e.delta).join('');
  };
  const board = async () => (await (await send('/api/office/today')).json()).board;
  const stored = () => JSON.parse(saved.get('che'));
  return { send, say, board, stored };
}

test('/api/chat refuses owner messages not addressed to CHE and any agent sender', async () => {
  const o = await office();
  let r = await o.send('/api/chat', 'POST', { message: 'hi', to: 'knox' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).detail, 'owner_talks_to_che_only');
  r = await o.send('/api/chat', 'POST', { message: 'status update', from: 'knox', to: 'owner' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).detail, 'agents_report_to_che_only');
});

test('a goal that asks an agent to merge is blocked by permission flags before it runs', async () => {
  const o = await office({ CODEX_OWNER_TOKEN: 'tok-test-only' });
  const plan = await (await o.send('/api/office/goals', 'POST', { goal: 'merge the checkout code into main' })).json();
  const knox = plan.jobs.find((j) => j.agent === 'Knox');
  assert.ok(knox, JSON.stringify(plan));
  assert.equal(knox.status, 'blocked');
  assert.match(knox.blocker, /Knox cannot merge code/);
  assert.match(plan.reply, /^CHE here\./);
});

test('direct agent tasks with a money or merge kind are refused with 403', async () => {
  const o = await office();
  await o.board(); // staffs the La Agencia roster
  const knox = o.stored().team.find((a) => a.name === 'Knox');
  for (const kind of ['merge', 'spend', 'payout']) {
    const r = await o.send(`/api/agents/${knox.id}/task`, 'POST', { task: 'do it', kind });
    assert.equal(r.status, 403, kind);
  }
});

test('Codex jobs get a persisted work packet with their own thread and workspace; no token leaks', async () => {
  const secret = 'codex-owner-secret-for-test';
  const o = await office({ CODEX_OWNER_TOKEN: secret });
  const plan = await (await o.send('/api/office/goals', 'POST', { goal: 'build the checkout page' })).json();
  const job = plan.jobs.find((j) => j.agent === 'Knox');
  assert.ok(job, JSON.stringify(plan));
  const packets = (await (await o.send('/api/office/packets')).json()).packets;
  const packet = packets.find((p) => p.job_id === job.id);
  assert.ok(packet);
  assert.equal(packet.thread_id, `office/knox/${job.id}`);
  assert.equal(packet.workspace, `codex-ws/knox/${job.id}`);
  assert.equal(packet.status, 'running');
  const everything = JSON.stringify([plan, packets, await o.board(), o.stored()]);
  assert.ok(!everything.includes(secret), 'owner Codex token never leaves the Worker env');
});

test('without Codex the packet and job are honestly blocked', async () => {
  const o = await office();
  const plan = await (await o.send('/api/office/goals', 'POST', { goal: 'build the checkout page' })).json();
  const job = plan.jobs.find((j) => j.agent === 'Knox');
  assert.equal(job.status, 'blocked');
  assert.equal(job.blocker, 'Blocked: tool not configured (Codex)');
  const packet = (await (await o.send('/api/office/packets')).json()).packets.find((p) => p.job_id === job.id);
  assert.equal(packet.status, 'Blocked: tool not configured (Codex)');
});

test('CHE announces a new blocker unprompted, once', async () => {
  const o = await office();
  const first = await o.board();
  assert.ok(first.che_announcements.some((l) => /Knox cannot start until Codex is connected on the Worker/.test(l)),
    JSON.stringify(first.che_announcements));
  for (const line of first.che_announcements) assert.ok(line.startsWith('CHE here.'));
  const second = await o.board();
  assert.deepEqual(second.che_announcements, []);
});

test('the six Office phrases work after the wake word, spoken by CHE', async () => {
  const o = await office();
  await o.board();
  const lines = [
    'Hey Chay, what\'s happening in the Office?',
    'Chay what did they build today',
    'CHE, how much did we make today?',
    'Chay read this Office to me',
    'Hey Chay what is Knox doing?',
  ];
  for (const line of lines) {
    const reply = await o.say(line);
    assert.match(reply, /^CHE here\./, line);
  }
  assert.match(await o.say('CHE, how much did we make today?'), /Stripe not connected\. Earned today \$0\.00\./);
  assert.match(await o.say('Hey Chay what is Knox doing?'), /Knox — Blocked: tool not configured \(Codex\)/);
  assert.match(await o.say('Chay, stand down'), /^CHE here\. Office standing down\./);
});
