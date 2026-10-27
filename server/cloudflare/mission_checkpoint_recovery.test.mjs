// Mission checkpoint recovery, the failure side (reliability lane rel-infra-app, 2026-10-25). mission_engine_proof
// covers one eviction that resumes. Here a step is cut off EVERY time it runs (a model call that never returns, a CPU
// limit, an isolate eviction): the job queue's checkpoint must bound the attempts, dead-letter the job, mark the
// mission step failed (never "done"), keep the finished step finished, and tell the owner the truth when he asks.
// Offline: fake model, no network.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.mission_checkpoint_recovery.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState, MAX_JOB_ATTEMPTS } = mod;

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

const until = async (check, what) => {
  for (let i = 0; i < 400; i += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for ${what}`);
};

test('a mission step that is cut off on every attempt is bounded, failed (never done), and reported honestly; step 1 is never re-run', async () => {
  const saved = new Map();
  const alarms = [];
  let planCalls = 0;
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: {
      run: async (_model, input) => {
        const last = String(input.messages?.at(-1)?.content || '');
        if (/Write a numbered plan for/i.test(last)) { planCalls += 1; return new Promise(() => {}); }
        return { response: 'Here is the answer, sir.' };
      },
    },
  };
  const pending = [];
  let state;
  const boot = () => {
    state = new CheState({ storage: durableStorage(saved, alarms), waitUntil: (p) => pending.push(p) }, env);
    env.CHE_STATE = { getByName: () => state };
  };
  boot();
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const settle = async () => { while (pending.length) await pending.shift(); };
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    await settle();
    const done = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).find((e) => e.type === 'done') || {};
    return { done, reply: replyFromNdjson(raw) };
  };

  await say('Remember that my business is Joe\'s Barbershop in Phoenix and it opens at 9 am.');
  const started = await say('Run a workflow to che memory my business then che plan a one page summary report of my business');
  assert.equal(started.done.source, 'che_command_workflow', started.reply);
  const missionId = saved.get('che').objectives[0].id;
  const mission = () => saved.get('che').objectives.find((o) => o.id === missionId);
  const jobsFor = (nodeId) => saved.get('che').jobs.filter((j) => j.objective_id === missionId && j.node_id === nodeId);

  await state.alarm(); // step 1 runs and completes
  const step1 = mission().nodes[0];
  assert.equal(step1.status, 'complete');

  // Every run of step 2 is cut off. Each cycle: the alarm starts it (it hangs), the instance dies, a restart, time
  // passes past the stale limit, and the next alarm sweeps it. The engine must stop on its own.
  const realNow = Date.now;
  let clock = 0;
  try {
    for (let cycle = 0; cycle < 40; cycle += 1) {
      const before = planCalls;
      Date.now = () => realNow() + clock;
      const run = state.alarm();
      run.catch(() => {});
      // Either the step reached its model call (and hangs), or nothing was runnable this alarm.
      await Promise.race([until(() => planCalls > before, 'step 2 model call').catch(() => {}), run]);
      boot(); // the isolate that was running it is gone
      clock += 21 * 60_000; // well past the 5-minute stale limit and any backoff
      if (mission().status !== 'running' && !saved.get('che').jobs.some((j) => j.objective_id === missionId && ['queued', 'running'].includes(j.status))) break;
    }
    Date.now = () => realNow() + clock;
    await state.alarm(); // one more sweep, so a job left "running" by the last cycle is judged too
    await settle();
  } finally {
    Date.now = realNow;
  }

  const graph = mission();
  const step2 = graph.nodes[1];
  const step2Jobs = jobsFor(step2.id);
  // Bounded: every job stops at the attempt ceiling, and the recovery ladder stops too.
  assert.ok(step2Jobs.every((j) => Number(j.attempts) <= MAX_JOB_ATTEMPTS), JSON.stringify(step2Jobs.map((j) => j.attempts)));
  assert.ok(step2Jobs.every((j) => j.status !== 'running' && j.status !== 'queued'), 'nothing is left "running" forever');
  assert.ok(step2Jobs.some((j) => j.dead_letter === true), 'the interrupted job was dead-lettered, not retried forever');
  assert.ok(planCalls <= step2Jobs.length * MAX_JOB_ATTEMPTS, `${planCalls} model calls for ${step2Jobs.length} job(s)`);
  // Never reported as done.
  assert.notEqual(step2.status, 'complete');
  assert.notEqual(graph.status, 'complete');
  assert.ok(!graph.artifact, 'no verified result is sealed for a mission that did not finish');
  // Finished work is kept: step 1 ran once and is still complete.
  assert.equal(graph.nodes[0].status, 'complete');
  assert.equal(jobsFor(step1.id).length, 1);
  assert.equal(jobsFor(step1.id)[0].attempts, 1);

  // The owner asks: the answer comes from the record, says the step did not finish, and never claims a result.
  boot();
  const status = await say('Mission status');
  assert.doesNotMatch(status.reply, /2 of 2 steps done|Result saved and verified/, status.reply);
  assert.match(status.reply, /1 of 2 steps done, 0 running, 1 failed/, status.reply);
});
