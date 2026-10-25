// Persistent mission proof (owner, 2026-10-25): ONE workflow, end to end, through the real Worker code.
//
// Started by a spoken/typed chat command on the owner's phone → queued on the objective graph and job queue in
// Durable Object storage → the phone goes away (no request is open) → the DO alarm runs step 1 → step 2 is cut off
// mid-step (the Worker instance is evicted while its model call is in flight) → a NEW CheState over the SAME
// storage (a restart) → the alarm sweeps the interrupted job and resumes step 2 from the graph's checkpoint,
// without re-running step 1 → the mission completes → its report is stored with a SHA-256 and a receipt → the
// endpoint the app polls when Commands reopens returns the result and the receipt.
//
// Offline: no network, a fake model, no paid service, no trade, no delete. See docs/CHE_MISSION_ENGINE_PROOF.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { buildMissionReport, missionArtifactKey, readMissionArtifact, sealMissionArtifact } from './mission_artifact.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.mission_engine_proof.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Durable Object storage over one Map that outlives every CheState instance, with the alarm it was asked for.
function durableStorage(saved, alarms) {
  return {
    get: async (key) => Array.isArray(key) ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))])) : saved.has(key) ? structuredClone(saved.get(key)) : undefined,
    put: async (key, value) => {
      if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; }
      saved.set(key, structuredClone(value));
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (at) => { alarms.push(Number(at)); },
    getAlarm: async () => alarms.at(-1) ?? null,
    deleteAlarm: async () => {},
  };
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const until = async (check, what) => {
  for (let i = 0; i < 400; i += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for ${what}`);
};

const PLAN_REPLY = 'Summary report: 1. Joe\'s Barbershop is in Phoenix. 2. It opens at 9 am. 3. Next: a booking page.';

test('one persistent mission: chat start → DO checkpoints → eviction mid-step → restart → alarm resumes → verified artifact → shown on reopen', async () => {
  const saved = new Map();
  const alarms = [];
  const inputs = [];
  // Step 2's model call hangs on the first Worker instance: that instance is "evicted" while the call is in flight.
  let evictOnPlan = true;
  const planCalls = { first: 0, second: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: {
      run: async (_model, input) => {
        inputs.push(input);
        const last = String(input.messages?.at(-1)?.content || '');
        if (/Write a numbered plan for/i.test(last)) {
          if (evictOnPlan) { planCalls.first += 1; return new Promise(() => {}); }
          planCalls.second += 1;
          return { response: PLAN_REPLY };
        }
        return { response: 'Here is the answer, sir.' };
      },
    },
  };
  const pending = [];
  let state;
  const boot = () => {
    state = new CheState({ storage: durableStorage(saved, alarms), waitUntil: (p) => pending.push(p) }, env);
    env.CHE_STATE = { getByName: () => state };
    return state;
  };
  boot();
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const settle = async () => { while (pending.length) await pending.shift(); };
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    await settle();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    return { done: events.find((e) => e.type === 'done') || {}, reply: replyFromNdjson(raw) };
  };
  const get = async (path) => (await send(path, null, token, 'GET')).json();

  // Data already in storage that the task reads: one confirmed owner memory, saved through chat.
  const remembered = await say('Remember that my business is Joe\'s Barbershop in Phoenix and it opens at 9 am.');
  assert.equal(remembered.done.source, 'che_memory', remembered.reply);

  // ── 1. Started from CHE on the phone by one spoken/typed sentence. ──────────────────────────────────────
  const started = await say('Run a workflow to che memory my business then che plan a one page summary report of my business');
  assert.equal(started.done.source, 'che_command_workflow', started.reply);
  assert.equal(started.done.ok, true, started.reply);
  assert.match(started.reply, /Started ".*", sir: 2 steps, 1 running now/);
  let data = saved.get('che');
  const mission = data.objectives[0];
  assert.equal(mission.source, 'command_workflow');
  assert.equal(mission.owner_authorized, true);
  assert.deepEqual(mission.nodes.map((n) => [n.command, n.status]), [['che-memory', 'running'], ['che-plan', 'pending']]);
  // Persisted in DO storage, with a wake-up scheduled: nothing depends on the phone's request staying open.
  assert.equal(data.jobs.filter((j) => j.objective_id === mission.id).length, 1);
  assert.ok(alarms.length > 0, 'the DO scheduled its alarm');

  // ── 2. The phone is closed: only the alarm drives the work from here. Step 1 runs on the alarm. ────────────
  await state.alarm();
  data = saved.get('che');
  let graph = data.objectives.find((o) => o.id === mission.id);
  const step1 = graph.nodes[0];
  assert.equal(step1.status, 'complete', JSON.stringify(step1.evidence));
  assert.match(step1.output, /Joe's Barbershop/);
  assert.equal(step1.verification.by, 'che_memory_provenance');
  const step1Job = data.jobs.find((j) => j.node_id === step1.id && j.objective_id === mission.id);
  assert.equal(step1Job.attempts, 1);
  assert.equal(graph.nodes[1].status, 'running', 'step 2 was queued as step 1 finished');

  // ── 3. Step 2 starts on the next alarm and the instance is evicted mid-step. ──────────────────────────────
  const evicted = state.alarm(); // never settles: its model call is in flight when the isolate goes away
  evicted.catch(() => {});
  await until(() => planCalls.first === 1, 'step 2 to reach its model call');
  data = saved.get('che');
  const step2Job = data.jobs.find((j) => j.objective_id === mission.id && j.node_id === graph.nodes[1].id);
  assert.equal(step2Job.status, 'running', 'checkpoint written before the model was called');
  assert.equal(step2Job.attempts, 1);
  graph = data.objectives.find((o) => o.id === mission.id);
  assert.equal(graph.nodes[0].status, 'complete', 'step 1 stays complete in the checkpoint');

  // ── 4. Restart: a brand-new CheState over the same storage. Time passes while nothing runs. ───────────────
  evictOnPlan = false;
  boot();
  const realNow = Date.now;
  try {
    // Six minutes later: the job has been "running" past its stale limit, so the alarm sweeps it back to queued.
    Date.now = () => realNow() + 6 * 60_000;
    await state.alarm();
    data = saved.get('che');
    const swept = data.jobs.find((j) => j.id === step2Job.id);
    assert.equal(swept.status, 'queued', 'the interrupted job is requeued, not lost and not dead-lettered');
    assert.ok(swept.retry_at > Date.now(), 'with a backoff');
    assert.ok(alarms.at(-1) <= swept.retry_at + 1, 'and the DO alarm is set for it');
    // Twenty minutes later the alarm fires again and resumes step 2 from the graph.
    Date.now = () => realNow() + 20 * 60_000;
    await state.alarm();
  } finally {
    Date.now = realNow;
  }
  await settle();

  // ── 5. Completed without redoing finished work. ──────────────────────────────────────────────────────────
  data = saved.get('che');
  graph = data.objectives.find((o) => o.id === mission.id);
  assert.equal(graph.status, 'complete', JSON.stringify(graph.nodes.map((n) => [n.id, n.status, n.evidence])));
  assert.equal(graph.nodes[1].output, PLAN_REPLY);
  assert.match(JSON.stringify(inputs.find((i) => /Write a numbered plan for/.test(String(i.messages?.at(-1)?.content)))?.messages), /Joe's Barbershop/, 'step 2 received step 1\'s result as data');
  const missionJobs = data.jobs.filter((j) => j.objective_id === mission.id);
  assert.equal(missionJobs.filter((j) => j.node_id === step1.id).length, 1, 'step 1 never got a second job');
  assert.equal(missionJobs.find((j) => j.node_id === step1.id).attempts, 1, 'step 1 ran exactly once');
  const resumed = missionJobs.find((j) => j.id === step2Job.id);
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.attempts, 2, 'step 2: the interrupted attempt plus the resumed one');
  assert.deepEqual(planCalls, { first: 1, second: 1 });

  // ── 6. A verified artifact: stored bytes hash to the recorded SHA-256, with a receipt. ───────────────────
  const artifact = graph.artifact;
  assert.ok(artifact?.sha256, 'the finished mission carries its artifact');
  assert.equal(artifact.key, missionArtifactKey(mission.id));
  assert.equal(artifact.verified, true);
  const expected = buildMissionReport(graph);
  assert.equal(artifact.sha256, sha256(expected), 'independent SHA-256 (node:crypto) matches');
  assert.match(expected, /Step 1: \/che-memory \(my business\)[\s\S]*Joe's Barbershop[\s\S]*Step 2: \/che-plan[\s\S]*Summary report/);
  const receipt = (saved.get('che_receipts') || []).find((r) => r.key === `mission_artifact:${mission.id}`);
  assert.ok(receipt, 'a mission_artifact receipt was recorded');
  assert.equal(receipt.sha256, artifact.sha256);
  assert.deepEqual(receipt.steps, graph.nodes.map((n) => n.id));

  // ── 7. CHE reopens (another restart) and the app's Commands refresh shows the result with its receipt. ────
  boot();
  const catalog = await get('/api/commands');
  const shown = catalog.missions.find((m) => m.id === mission.id);
  assert.equal(shown.status, 'complete');
  assert.deepEqual(shown.steps.map((s) => s.status), ['complete', 'complete']);
  assert.equal(shown.artifact.sha256, artifact.sha256);
  assert.equal(shown.artifact.verified, true);
  assert.match(shown.artifact.spoken, /^Result saved and verified: \d+ bytes, SHA-256 [0-9a-f]{12}\.$/);
  assert.match(shown.spoken, /2 of 2 steps done[\s\S]*Result saved and verified/);
  const opened = await get(`/api/commands/missions/artifact?id=${mission.id}`);
  assert.equal(opened.verified, true);
  assert.equal(opened.sha256, artifact.sha256);
  assert.equal(sha256(opened.text), artifact.sha256, 'the text the phone receives hashes to the receipt');
  assert.equal(opened.receipt.kind, 'mission_artifact');
  assert.equal(opened.receipt.sha256, artifact.sha256);
  // Without the owner's device token the result is not readable.
  assert.notEqual((await send(`/api/commands/missions/artifact?id=${mission.id}`, null, '', 'GET')).status, 200);
  // Asking by voice reads the same record (an explicit request, so it may speak).
  const status = await say('Mission status');
  assert.match(status.reply, /Result saved and verified, SHA-256 [0-9a-f]{12}/);
});

test('the artifact is re-hashed on read: changed bytes are reported unverified, and sealing is idempotent', async () => {
  const saved = new Map();
  const storage = durableStorage(saved, []);
  const objective = {
    id: 'm1', source: 'command_workflow', status: 'complete', workflow_name: 'Notes', objective: 'Workflow: Notes', created_at: '2026-10-25T00:00:00.000Z',
    nodes: [{ id: 's1', command: 'che-plan', input: 'x', status: 'complete', output: 'Plan.', verification: { by: 'model' } }],
  };
  const first = await sealMissionArtifact(storage, objective);
  assert.equal(first.verified, true);
  // Sealing again is a no-op: same artifact, one receipt.
  assert.equal(await sealMissionArtifact(storage, objective), first);
  assert.equal((await readMissionArtifact(storage, objective)).verified, true);
  const chunk = saved.get(`blob:${first.key}:0`);
  chunk[0] ^= 1;
  saved.set(`blob:${first.key}:0`, chunk);
  const tampered = await readMissionArtifact(storage, objective);
  assert.equal(tampered.verified, false);
  assert.notEqual(tampered.sha256, first.sha256);
  // An unfinished mission is never sealed.
  assert.equal((await sealMissionArtifact(storage, { ...objective, id: 'm2', status: 'active', artifact: null })).ok, false);
});
