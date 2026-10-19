// Cancelling a queued coding job by voice or typing (owner, 2026-10-19: "Cancel that fake commit by
// Che", about job c2987a73 that CHE wrongly queued from a question). Everything runs through the real
// Worker's /api/chat and /api/job/cancel, offline, with the jobs as the store keeps them.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const generated = new URL('./.coding_cancel.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const HELD_KEY = 'che:pending_owner_action';

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A paired owner phone; `inputs` keeps every model call.
async function owner() {
  const saved = new Map();
  const inputs = [];
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { inputs.push(input); return { response: 'Here is the answer, sir.' }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const chatAs = async (who, message, history = []) => {
    const before = inputs.length;
    const res = await send('/api/chat', { message, history }, who);
    const raw = await res.text();
    await settle();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = held?.message || replyFromNdjson(raw);
    const route = held?.held_for_owner ? 'held' : held?.clarification ? 'clarification' : done.source || (inputs.length > before ? 'model' : 'none');
    return { raw, held, done, reply, route, modelCalls: inputs.length - before };
  };
  const say = (message, history = []) => chatAs(token, message, history);
  const guest = async () => {
    const tenant = await (await send('/api/platform/tenants', { name: 'Guest', role: 'family' }, token)).json();
    const invite = await (await send('/api/platform/enrollments', { access: 'private', tenant_id: tenant.tenant.id }, token)).json();
    return (await (await send('/api/enroll', { enrollment_token: invite.enrollment.token, device_name: 'guest' })).json()).device_token;
  };
  const jobs = () => structuredClone(saved.get('che').jobs);
  const job = (id) => jobs().find((j) => j.id === id);
  const seed = (list) => { saved.get('che').jobs = structuredClone(list); };
  return { say, chatAs, send, token, saved, inputs, guest, jobs, job, seed };
}

// The job the owner asked about, and a second job he did authorize. Store order is newest first.
const FAKE = 'c2987a73-4f1e-4b8a-9d2c-1a2b3c4d5e6f';
const REAL = '5b1e09aa-7c3d-4e2f-8a1b-2c3d4e5f6a7b';
const codingJob = (id, request, fields = {}) => ({
  id, kind: 'self_development', title: `Code: ${request}`.slice(0, 100), prompt: request, request,
  status: 'queued', attempts: 0, retry_count: 0, retry_at: Date.now() + 3_600_000, result: '', error: '',
  dead_letter: false, dead_letter_at: null, idempotency_key: `job:self_development:${id}`,
  created_at: '2026-10-19T12:00:00.000Z', updated_at: '2026-10-19T12:00:00.000Z', ...fields,
});
const fakeJob = (fields) => codingJob(FAKE, 'Which of those features could improve your app?', { created_at: '2026-10-19T12:05:00.000Z', updated_at: '2026-10-19T12:05:00.000Z', ...fields });
const realJob = (fields) => codingJob(REAL, 'Add a dark mode switch to the Office screen, with a VoiceOver label and a spoken confirmation when it changes', fields);
const ACCEPTED = 'I accepted coding job c2987a73, sir. It is queued, not running yet. Ask "coding status" anytime.';
const HISTORY = [
  { role: 'user', content: 'Which of those features could improve your app?' },
  { role: 'assistant', content: ACCEPTED },
];

test('the owner\'s exact words cancel the queued job CHE just accepted; his other queued job is untouched', async () => {
  const che = await owner();
  che.seed([fakeJob(), realJob()]);
  const before = che.job(REAL);
  const out = await che.say('Cancel that fake commit by Che', HISTORY);
  assert.equal(out.route, 'che_coding_cancel', out.reply);
  assert.equal(out.reply, 'I cancelled coding job c2987a73, sir. It had not started, so nothing was committed.');
  assert.equal(out.modelCalls, 0);
  assert.equal(out.done.ok, true);
  assert.equal(out.done.cancelled, true);
  assert.equal(out.done.background_job_id, FAKE);
  assert.equal(out.done.background_job_status, 'cancelled', 'read back from the store');
  const cancelled = che.job(FAKE);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled_by, 'owner');
  assert.equal(cancelled.cancelled_via, 'chat');
  assert.ok(Date.parse(cancelled.cancelled_at) > 0, 'when it was cancelled');
  assert.equal(cancelled.request, 'Which of those features could improve your app?', 'the record is kept, nothing deleted');
  assert.equal(che.jobs().length, 2);
  assert.deepEqual(che.job(REAL), before, 'the authorized job stays queued and untouched');
  // Not a delete: no money/delete hold was asked for or stored.
  assert.equal(out.held, null);
  assert.equal(che.saved.get(HELD_KEY) ?? null, null);
});

test('cancel by id, typed or spoken, and by "the last coding job"', async () => {
  const che = await owner();
  che.seed([fakeJob(), realJob()]);
  const byId = await che.say('Cancel coding job c2987a73');
  assert.equal(byId.route, 'che_coding_cancel');
  assert.match(byId.reply, /^I cancelled coding job c2987a73, sir\./);
  assert.equal(che.job(FAKE).status, 'cancelled');
  assert.equal(che.job(REAL).status, 'queued');
  // Again: it says what the store holds, and changes nothing.
  const again = await che.say('cancel job c2987a73');
  assert.equal(again.reply, 'Coding job c2987a73 was already cancelled, sir. Nothing changed.');
  assert.equal(again.done.ok, false);
  // A spoken id with spaces and capitals, after "hey CHE".
  const spoken = await che.say('Hey CHE, please cancel job 5B1E 09AA.');
  assert.equal(spoken.route, 'che_coding_cancel');
  assert.match(spoken.reply, /^I cancelled coding job 5b1e09aa, sir\./);
  assert.equal(che.job(REAL).status, 'cancelled');
  // A reason said after it is not a second request.
  che.seed([fakeJob(), realJob()]);
  const reason = await che.say('Cancel that fake commit by Che, it was a question.', HISTORY);
  assert.match(reason.reply, /^I cancelled coding job c2987a73, sir\./);
  assert.equal(che.job(REAL).status, 'queued');
  const missing = await che.say('cancel coding job deadbee1');
  assert.equal(missing.reply, "I can't find coding job deadbee1 in my records, sir. Nothing was cancelled.");

  // "The last coding job": the one CHE last accepted, else the newest queued one.
  const last = await owner();
  last.seed([fakeJob(), realJob()]);
  const newest = await last.say('Cancel the last coding job');
  assert.match(newest.reply, /^I cancelled coding job c2987a73, sir\./, 'the newest queued job');
  assert.equal(last.job(REAL).status, 'queued');
  const named = await owner();
  named.seed([fakeJob(), realJob()]);
  const accepted = await named.say('cancel the last coding job', [{ role: 'assistant', content: 'I accepted coding job 5b1e09aa, sir. It is queued, not running yet. Ask "coding status" anytime.' }]);
  assert.match(accepted.reply, /^I cancelled coding job 5b1e09aa, sir\./, 'the job named in CHE\'s acceptance');
  assert.equal(named.job(FAKE).status, 'queued');
  // The command itself, as the Commands page runs it.
  const slash = await owner();
  slash.seed([fakeJob(), realJob()]);
  const run = await slash.say('/che-cancel-job c2987a73');
  assert.equal(run.route, 'che_coding_cancel');
  assert.equal(slash.job(FAKE).status, 'cancelled');
  assert.equal(slash.job(REAL).status, 'queued');
});

test('a running, finished or failed job is not cancelled, and the reply says so', async () => {
  const che = await owner();
  che.seed([fakeJob({ status: 'running', attempts: 1 })]);
  const running = await che.say('Cancel that coding job', HISTORY);
  assert.equal(running.route, 'che_coding_cancel');
  assert.equal(running.reply, 'Coding job c2987a73 is running, sir, so I did not cancel it. I can only cancel a coding job that has not started. Say "coding status" to hear its progress.');
  assert.equal(running.done.ok, false);
  assert.equal(running.done.background_job_status, 'running');
  assert.equal(che.job(FAKE).status, 'running');
  assert.equal(che.job(FAKE).cancelled_at, undefined);
  for (const [status, said] of [['complete', /already finished/], ['failed', /already failed/]]) {
    che.seed([fakeJob({ status })]);
    const out = await che.say('Cancel that fake commit by Che', HISTORY);
    assert.match(out.reply, said);
    assert.match(out.reply, /Nothing changed\.$/);
    assert.equal(che.job(FAKE).status, status);
  }
  // Nothing queued: said plainly, and the running job is named.
  che.seed([realJob({ status: 'running' })]);
  const none = await che.say('cancel that coding job');
  assert.equal(none.reply, "No coding job is waiting in the queue, sir, so nothing was cancelled. Coding job 5b1e09aa is running, and I can't cancel a running job.");
  // A queued job that already ran once is cancelled, without claiming nothing was committed.
  che.seed([fakeJob({ attempts: 1, retry_count: 1 })]);
  const retry = await che.say('cancel coding job c2987a73');
  assert.equal(retry.reply, 'I cancelled coding job c2987a73, sir. It had already run once and was waiting to retry, so I stopped the retry. Anything those attempts pushed was not removed.');
});

test('a guest is refused, and nothing changes', async () => {
  const che = await owner();
  che.seed([fakeJob(), realJob()]);
  const before = che.jobs();
  const guest = await che.guest();
  for (const words of ['Cancel that fake commit by Che', 'cancel coding job c2987a73', 'Cancel the last coding job', '/che-cancel-job c2987a73']) {
    const out = await che.chatAs(guest, words, HISTORY);
    assert.match(out.reply, /^Only the CHE owner can (?:cancel coding jobs|run commands)/, words);
    assert.equal(out.modelCalls, 0, words);
  }
  const http = await che.send('/api/job/cancel', { id: FAKE }, guest);
  assert.equal(http.status, 403);
  assert.deepEqual(che.jobs(), before, 'no job changed');
});

test('two queued jobs and an unclear "that": a numbered list, nothing cancelled; then "2" cancels the second only', async () => {
  const che = await owner();
  che.seed([fakeJob(), realJob()]);
  const asked = await che.say('cancel that coding job');
  assert.equal(asked.route, 'che_coding_cancel');
  assert.equal(asked.reply, '2 coding jobs are queued, sir, so I won\'t guess which one you mean. '
    + '1. c2987a73: "Which of those features could improve your app?" '
    + '2. 5b1e09aa: "Add a dark mode switch to the Office screen, with a VoiceOver label and a spoken" '
    + 'Which coding job should I cancel? Say its number. Nothing was cancelled yet.');
  assert.deepEqual(asked.done.choices, [FAKE, REAL]);
  assert.equal(che.job(FAKE).status, 'queued');
  assert.equal(che.job(REAL).status, 'queued');
  const history = [{ role: 'user', content: 'cancel that coding job' }, { role: 'assistant', content: asked.reply }];
  const picked = await che.say('2', history);
  assert.equal(picked.route, 'che_coding_cancel');
  assert.match(picked.reply, /^I cancelled coding job 5b1e09aa, sir\. It had not started, so nothing was committed\.$/);
  assert.equal(che.job(REAL).status, 'cancelled');
  assert.equal(che.job(FAKE).status, 'queued', 'the first one is untouched');
  // A spoken number word works too; one that is not on the list cancels nothing.
  const word = await owner();
  word.seed([fakeJob(), realJob()]);
  assert.match((await word.say('number one', history)).reply, /^I cancelled coding job c2987a73, sir\./);
  assert.equal(word.job(REAL).status, 'queued');
  const off = await owner();
  off.seed([fakeJob(), realJob()]);
  assert.match((await off.say('5', history)).reply, /^There is no number 5 on that list, sir\./);
  assert.deepEqual(off.jobs().map((j) => j.status), ['queued', 'queued']);
});

test('a held purchase: "never mind" still drops it and cancels no job; a coding-job cancel replaces it and buys nothing', async () => {
  const che = await owner();
  che.seed([fakeJob()]);
  const hold = await che.say('buy me the Shorebird book', HISTORY);
  assert.equal(hold.route, 'held');
  const history = [...HISTORY, { role: 'user', content: 'buy me the Shorebird book' }, { role: 'assistant', content: hold.reply }];
  const dropped = await che.say('never mind', history);
  assert.equal(dropped.reply, 'Okay, I have dropped that.');
  assert.equal(che.saved.get(HELD_KEY) ?? null, null, 'the hold is dropped');
  assert.equal(che.job(FAKE).status, 'queued', 'no job was cancelled');
  // A bare "cancel that" while a purchase is held still means the purchase, even right after CHE accepted a job.
  await che.say('buy me the Shorebird book', HISTORY);
  assert.ok(che.saved.get(HELD_KEY));
  const bare = await che.say('cancel that', HISTORY);
  assert.equal(bare.reply, 'Okay, I have dropped that.');
  assert.equal(che.job(FAKE).status, 'queued');
  // Naming the coding job cancels the job; the held purchase is not bought, and a later yes releases nothing.
  await che.say('buy me the Shorebird book', HISTORY);
  const named = await che.say('Cancel that fake commit by Che', history);
  assert.equal(named.route, 'che_coding_cancel');
  assert.equal(named.reply, 'I cancelled coding job c2987a73, sir. It had not started, so nothing was committed.');
  assert.equal(che.job(FAKE).status, 'cancelled');
  assert.equal(che.saved.get(HELD_KEY) ?? null, null, 'like any other turn, it replaces the held purchase');
  const before = che.inputs.length;
  const yes = await che.say('yes');
  assert.notEqual(yes.route, 'held');
  const asked = che.inputs.slice(before).map((input) => String(input.messages?.at(-1)?.content || ''));
  assert.ok(!asked.some((text) => /Shorebird book/.test(text)), 'a later yes releases no purchase');
});

test('right after CHE accepts a job, a bare "cancel that" cancels it instead of claiming a drop', async () => {
  const che = await owner();
  che.seed([fakeJob()]);
  const out = await che.say('cancel that', HISTORY);
  assert.equal(out.route, 'che_coding_cancel');
  assert.match(out.reply, /^I cancelled coding job c2987a73, sir\./);
  // With no coding job in CHE's last reply it keeps its old meaning.
  const other = await owner();
  other.seed([fakeJob()]);
  const plain = await other.say('cancel that', [{ role: 'assistant', content: 'Here is the answer, sir.' }]);
  assert.notEqual(plain.route, 'che_coding_cancel');
  assert.equal(other.job(FAKE).status, 'queued');
});

test('other "cancel" sentences keep their routes and never touch a coding job', async () => {
  const che = await owner();
  che.seed([fakeJob()]);
  for (const words of ['never mind', 'cancel my 3pm meeting', 'cancel the trade', 'cancel the run', 'Should I cancel the coding job?',
    "Don't cancel the coding job", 'what is the coding status', 'Cancel that fake commit by Che and buy milk']) {
    const out = await che.say(words);
    assert.notEqual(out.route, 'che_coding_cancel', words);
    assert.equal(che.job(FAKE).status, 'queued', words);
  }
});

test('POST /api/job/cancel still cancels only a queued job and keeps the record, now with who and when', async () => {
  const che = await owner();
  che.seed([fakeJob(), realJob({ status: 'running' })]);
  const res = await che.send('/api/job/cancel', { id: FAKE }, che.token);
  assert.equal(res.status, 200);
  const { job } = await res.json();
  assert.equal(job.id, FAKE);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.cancelled_by, 'owner');
  assert.equal(job.cancelled_via, 'api');
  assert.equal(che.job(FAKE).status, 'cancelled');
  const running = await che.send('/api/job/cancel', { id: REAL }, che.token);
  assert.equal(running.status, 200);
  assert.equal((await running.json()).job.status, 'running', 'a running job is returned unchanged');
  assert.equal(che.job(REAL).status, 'running');
  const missing = await che.send('/api/job/cancel', { id: 'nope' }, che.token);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).detail, 'Background job not found.');
});
