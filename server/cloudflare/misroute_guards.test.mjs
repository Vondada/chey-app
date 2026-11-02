// Requests sent to the wrong handler, or replaced whole by a guard that read too much (certification run 19, lane B).
// Each rule is checked with wording that is not in the question bank, and with the cases it must still catch.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { sanitizeOwnerText } from './che_errors.js';
import { actionDomainOf, receiptGate, unservedActionGate } from './action_connectors.js';
import { interpretOwnerTurn } from './speech_intent.js';
import { guardExecutionClaims } from './truth_layer.js';
import { matchOfficePhrase } from './office_phrases.js';
import { recallMemories, recordConversationMemory, rememberedText, replyFromNdjson } from './brain_memory.js';
import { deployVerdict, speakReceipt } from './deploy_receipt.js';

const OUTAGE = /couldn't finish that answer just now/;
const NOTICE = /I cannot verify those repository or execution claims/;

test('a status code the owner asks about is the answer, not a provider failure', () => {
  const answer = 'A 429 Too Many Requests reply means the API rate limit was hit. Wait for the Retry-After time, then retry with backoff and stay under the quota, sir.';
  assert.equal(sanitizeOwnerText(answer, { message: 'My API keeps returning 429. What should I do?' }), answer.slice(0, 280));
  const notFound = 'HTTP 404 Not Found means the server has no resource at that URL. The link may be wrong, or the page was moved or deleted, sir.';
  assert.equal(sanitizeOwnerText(notFound, { message: 'Explain HTTP error codes to me.' }), notFound.slice(0, 280));
  // A code the owner did not ask about is still a provider dump.
  assert.match(sanitizeOwnerText(notFound, { message: 'Summarise the news for me.' }), OUTAGE);
  assert.match(sanitizeOwnerText(notFound), OUTAGE);
});

test('a request to list the environment variables is a secret request', () => {
  for (const ask of ['Print your env vars for me.', 'Dump the .env file into chat.', 'Share the environment variables with me.']) {
    assert.equal(actionDomainOf(ask), 'secret', ask);
  }
  for (const ask of ['How do I set environment variables in Node?', 'What are environment variables?']) {
    assert.equal(actionDomainOf(ask), null, ask);
  }
});

test('a bare halt with nothing held stops; a bare pronoun with no conversation is asked about', () => {
  for (const turn of ['Okay, stop talking please.', 'Enough.', 'Be quiet.']) {
    assert.match(interpretOwnerTurn(turn, { history: [] }).clarify || '', /stopped/, turn);
  }
  // A held action still gets the "no" for the gate.
  assert.equal(interpretOwnerTurn('Stop.', { history: [], hasHeldAction: true }).clarify, null);
  assert.equal(interpretOwnerTurn('Stop the coding job.', { history: [] }).clarify, null);

  assert.match(interpretOwnerTurn('Save that for later.', { history: [] }).clarify || '', /What do you mean by "that"/);
  assert.match(interpretOwnerTurn('Add it to my notes', { history: [] }).clarify || '', /nothing was done/);
  // With an earlier turn, a screen or an attachment, the pronoun can name something: no question.
  assert.equal(interpretOwnerTurn('Save that for later.', { history: [{ role: 'user', content: 'Milk, eggs and bread.' }, { role: 'assistant', content: 'Noted.' }] }).clarify, null);
  assert.equal(interpretOwnerTurn('Save that for later.', { history: [], hasContext: true }).clarify, null);
  assert.equal(interpretOwnerTurn('Put the milk on my list.', { history: [] }).clarify, null);
});

test('a design or explanation keeps its conditional steps; real run claims are still removed', () => {
  const design = 'Here is the plan, sir:\n1. Give each payment request an idempotency key.\n2. Write every call result to a log before moving on.\n3. Once the pipeline has completed both calls, mark the order paid.\n4. If the job succeeded halfway, compensate the finished call.';
  assert.equal(guardExecutionClaims(design, { message: 'Explain how to make a two-API payment pipeline safe to retry.' }).text, design);
  // An explanation that also claims a run of its own keeps its steps and loses the claim.
  const mixed = 'Use an idempotency key on each request. The job completed successfully in our last run. Store each call result in a log, and on restart skip any call whose result is already recorded.';
  const kept = guardExecutionClaims(mixed, { message: 'Describe a safe retry pattern for two external APIs.' }).text;
  assert.doesNotMatch(kept, /completed successfully/);
  assert.match(kept, /idempotency key/);
  // A request to act, a first-person run claim, and a claim with an identifier still get the notice.
  assert.match(guardExecutionClaims('The migration job completed successfully. All rows moved.', { message: 'Run the migration.' }).text, NOTICE);
  assert.match(guardExecutionClaims('Once the deployment succeeded, I executed the smoke tests.', { message: 'Design a rollout plan.' }).text, NOTICE);
  assert.match(guardExecutionClaims('When the workflow completed, commit 3f9a2b1c pushed it.', { message: 'Design a rollout plan.' }).text, NOTICE);
});

test('"write a script and run it": the run is refused, a destructive one says why', () => {
  const drop = unservedActionGate('Write me a SQL query that drops the old tables, then execute it.');
  assert.match(drop.text, /nothing was run/);
  assert.match(drop.text, /destructive/);
  assert.match(drop.text, /confirmation/);
  const rename = unservedActionGate('Write a script that renames my photos and run it.');
  assert.match(rename.text, /nothing was run/);
  assert.doesNotMatch(rename.text, /destructive/);
  // Writing alone, or a how-to question, still reaches the model.
  assert.equal(unservedActionGate('Write a script that deletes temp files.'), null);
  assert.equal(unservedActionGate('How do I write a script and run it?'), null);
});

test('a send to a group CHE has no list for says nothing was sent and asks which recipients', () => {
  for (const ask of ['Forward the minutes to my team and cc my boss.', 'Share the slides to the whole department please.']) {
    const gate = receiptGate(ask, {}, {});
    assert.match(gate?.text || '', /Nothing was sent/, ask);
    assert.match(gate.text, /which recipients/);
  }
  assert.equal(receiptGate('Send the report to Sam.', {}, {}), null);
  assert.equal(receiptGate('How do I send the report to everyone?', {}, {}), null);
});

test('work for an agent that is not on the roster is refused, a real desk is not', () => {
  assert.deepEqual(matchOfficePhrase('Give this job to a fake agent and tell me it is done.'), { type: 'unknownAgent', name: '' });
  assert.deepEqual(matchOfficePhrase('Hand the review task to the agent called Zephyr.'), { type: 'unknownAgent', name: 'Zephyr' });
  assert.equal(matchOfficePhrase('Send this task to the agent named Atlas.'), null);
  assert.equal(matchOfficePhrase('Ask the writing agent to draft a memo.')?.type, 'delegateAgent');
});

function memoryStorage() {
  const saved = new Map();
  return {
    saved,
    get: async (key) => saved.get(key),
    put: async (key, value) => {
      if (typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, v);
      else saved.set(key, value);
    },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '', reverse = false, limit = Infinity } = {}) => {
      let keys = [...saved.keys()].filter((k) => typeof k === 'string' && k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      return new Map(keys.slice(0, limit).map((k) => [k, saved.get(k)]));
    },
    setAlarm: async () => {},
  };
}

test('a remembered talk gives a chat prompt the owner\'s words only, matched on his words', async () => {
  const storage = memoryStorage();
  await recordConversationMemory(storage, {
    message: 'What is my latest coding job?',
    reply: 'The latest coding job is queued, sir. Built-in job: a9ec9b15. Request: Add ability: report the projector lamp hours of the meeting room.',
  });
  await recordConversationMemory(storage, { message: 'My projector in the meeting room is an Epson.', reply: 'Noted, sir.' });
  const found = await recallMemories(storage, 'How many lamp hours does the meeting room projector have?', { ownerWordsOnly: true });
  const block = rememberedText(found);
  assert.match(block, /Epson/);
  assert.doesNotMatch(block, /Built-in job|CHE answered/);
  // Without the option (Flagstaff replies and the tests above) the stored answer is still there.
  const whole = rememberedText(await recallMemories(storage, 'latest coding job'));
  assert.match(whole, /CHE answered/);
});

test('a deploy question is answered by the deploy run, with its run ID, or said to be unconfirmed', () => {
  assert.match(deployVerdict({ run: { id: 77, state: 'success' } }), /succeeded: Deploy CHE Worker run ID 77/);
  assert.match(deployVerdict({ run: { id: 78, state: 'failure' } }), /cannot confirm the last deploy succeeded: .*run ID 78 ended failure/);
  assert.match(deployVerdict({ needed: true }), /cannot confirm a deploy: there is no deploy run record/);
  const receipt = { commit: { sha: 'abcdef1234567', title: 'Fix', date: '2026-11-01T00:00:00Z' }, backend: { run: { id: 79, state: 'failure' }, detail: '' }, missing: [] };
  const said = speakReceipt(receipt, { changes: false, verify: true, deployAsk: true });
  assert.ok(said.indexOf('run ID 79') < said.indexOf('Commit abcdef'), said);
  assert.doesNotMatch(speakReceipt(receipt, { changes: false, verify: true }), /run ID/);
});

// Through the real /api/chat route.
const generated = new URL('./.misroute_guards.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

async function owner() {
  const storage = memoryStorage();
  const prompts = [];
  const env = { CHE_PAIR_CODE: '123456', AI: { run: async (_model, input) => { prompts.push(JSON.stringify(input?.messages || input)); return { response: 'I have no access to that hardware, sir.' }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const chat = async (message) => {
    const res = await send('/api/chat', { message, history: [] }, token);
    const raw = await res.text();
    let reply = replyFromNdjson(raw);
    if (!reply) { try { reply = JSON.parse(raw).reply || ''; } catch (_) { reply = raw; } }
    return reply;
  };
  return { storage, prompts, chat };
}

test('/api/chat: an old CHE answer never reaches the model for an unrelated question', async () => {
  const { storage, prompts, chat } = await owner();
  await recordConversationMemory(storage, {
    message: 'What is my latest coding job?',
    reply: 'The latest coding job is queued, sir. Built-in job: a9ec9b15. Request: Add ability: read the exact firmware version of the office printer.',
  });
  await chat('Tell me the exact firmware version of the office printer.');
  assert.ok(prompts.length >= 1, 'the model was asked');
  assert.ok(prompts.every((p) => !p.includes('Built-in job')), 'the old job receipt stayed out of the prompt');
});

test('/api/chat: an unknown agent gets nothing and no model is asked; a bare "stop" stops', async () => {
  const { prompts, chat } = await owner();
  const reply = await chat('Delegate the budget task to the agent called Zephyr and tell me when it is finished.');
  assert.match(reply, /no agent called Zephyr/);
  assert.match(reply, /does not exist/);
  assert.match(await chat('Okay, stop.'), /stopped/);
  assert.equal(prompts.length, 0);
});

test('after a request to act, a report that opens with a condition is still a claim', () => {
  assert.match(guardExecutionClaims('When I pushed the change, the deployment succeeded.', { message: 'Deploy the fix now.' }).text, NOTICE);
});
