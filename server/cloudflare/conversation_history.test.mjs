// Conversation history and CHE's past mistakes, end to end (owner, 2026-10-27). Real /api/chat on a CheState with a
// SQLite Brain, the background memory writes awaited, and a mocked clock: conversations are made on October 4 (one of
// them spoken, posted to /api/logs as the phone does), then asked about on October 27, also after a restart.
// The chat model is a FAKE that gives one wrong answer, so a correct account can only come from the stored records.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { correctionSaveIntent, findMistakes, historyIntent, parseWhen } from './conversation_history.js';
import { guardOwnerAttributions, ownerFactCorrection } from './memory_provenance.js';

const RealDate = Date;
let fakeNow = null;
class ClockDate extends RealDate {
  constructor(...args) { if (!args.length && fakeNow != null) super(fakeNow); else super(...args); }
  static now() { return fakeNow ?? RealDate.now(); }
}
globalThis.Date = ClockDate;
const at = (iso) => { fakeNow = RealDate.parse(iso); };

const generated = new URL('./.conversation_history.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + RealDate.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Offline, except a fixture of CHE's merged changes on GitHub.
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  if (/api\.github\.com\/repos\/o\/r\/commits\?/.test(url)) {
    return new Response(JSON.stringify([{ commit: { message: 'Truth guard: an invented past conversation needs a record' } }, { commit: { message: 'Trading chart: daily bars' } }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new TypeError(`fetch failed (offline test: ${new URL(url).host})`);
};

const { DatabaseSync } = await import('node:sqlite');
function durable() {
  const saved = new Map();
  const db = new DatabaseSync(':memory:');
  return () => ({
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((key) => saved.has(key)).map((key) => [key, structuredClone(saved.get(key))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [key, value] of Object.entries(k)) saved.set(key, structuredClone(value)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => (Array.isArray(k) ? k.filter((key) => saved.delete(key)).length : saved.delete(k)),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  });
}

const lastUser = (input) => String((input?.messages || []).filter((m) => m.role === 'user').at(-1)?.content || '');
function model(input) {
  const said = lastUser(input);
  if (/who wrote frankenstein/i.test(said)) return 'Percy Bysshe Shelley wrote Frankenstein.';
  if (/lisbon/i.test(said)) return 'On September 12th we talked about your trip to Lisbon and the hotel by the river.';
  return 'Got it, sir.';
}

async function phone(storage) {
  const counter = { calls: 0 };
  const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'ghs_testtokentesttokentest', CHE_GITHUB_REPO: 'o/r', AI: { run: async (_m, input) => { counter.calls += 1; return { response: model(input) }; } } };
  const connect = () => {
    const state = new CheState({ storage: storage(), waitUntil: (p) => pending.push(p) }, env);
    env.CHE_STATE = { getByName: () => state };
  };
  connect();
  const send = (path, { method = 'POST', body, token = '' } = {}) => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  }), env);
  const token = (await (await send('/api/pair', { body: { code: '123456' } })).json()).device_token;
  let history = [];
  const say = async (message, { fresh = false } = {}) => {
    if (fresh) history = [];
    const before = counter.calls;
    const raw = await (await send('/api/chat', { body: { message, history }, token })).text();
    await Promise.all(pending.splice(0));
    const reply = replyFromNdjson(raw);
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === 'done') || {};
    history = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }].slice(-10);
    return { reply, route: done.source || (counter.calls > before ? 'model' : 'none'), meta: done, modelCalls: counter.calls - before };
  };
  const voiceLog = (text, che, when) => send('/api/logs', { body: { conversationId: 'voice-oct4', title: 'Car ride', source: 'voice', user: { text, at: when }, che: { text: che } }, token });
  const get = async (path) => { const r = await send(path, { method: 'GET', token }); return { status: r.status, body: await r.json() }; };
  return { say, voiceLog, get, restart: connect };
}

// One CHE for the whole story: October 4 conversations, then October 27 questions, a correction, a restart.
const storage = durable();
let che;
const story = {};

test('setup: conversations on October 4, 2026 (typed and spoken), through the real routes', async () => {
  che = await phone(storage);
  at('2026-10-04T15:00:00Z');
  await che.say("I'm planning the Ozark Lantern festival trip with my cousins.", { fresh: true });
  at('2026-10-04T16:02:00Z');
  story.wrong = await che.say('Who wrote Frankenstein?');
  assert.equal(story.wrong.reply, 'Percy Bysshe Shelley wrote Frankenstein.', 'the fake model gives the wrong answer on October 4');
  at('2026-10-04T16:03:00Z');
  await che.say("No, that's not right, it was Mary Shelley.");
  at('2026-10-04T18:30:00Z');
  const logged = await che.voiceLog('remind me to call the dentist about my crown', 'I will remind you tomorrow morning.', '2026-10-04T18:30:00Z');
  assert.equal(logged.status, 200);
  // The new record keeps how the answer was made.
  const wrongRecord = (await che.get('/api/brain/search?q=Frankenstein')).body;
  story.records = JSON.stringify(wrongRecord);
});

test('Test 1: "What did we talk about on October 4th?" is read from the Brain and the voice log, with no model', async () => {
  at('2026-10-27T12:00:00Z');
  for (const phrase of ['What did we talk about on October 4th?', 'chay what did we discuss on october fourth', 'Show me our conversation from Oct 4']) {
    const out = await che.say(phrase, { fresh: true });
    assert.equal(out.route, 'che_history', `${phrase} → ${out.route}: ${out.reply.slice(0, 200)}`);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /October 4, 2026/);
    assert.match(out.reply, /Ozark Lantern festival/);
    assert.match(out.reply, /you said by voice "remind me to call the dentist/);
    assert.match(out.reply, /Who wrote Frankenstein\?/);
  }
  const weeks = await che.say('What did we talk about three weeks ago?', { fresh: true });
  assert.equal(weeks.route, 'che_history');
  assert.match(weeks.reply, /Ozark Lantern/);
});

test('Test 2: "around October 4th when you told me something that didn\'t sound right" finds the wrong answer, with evidence and why', async () => {
  const out = await che.say("CHE, remember around October 4th when you told me something that didn't sound right? What was that about?", { fresh: true });
  assert.equal(out.route, 'che_history', out.reply);
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /you said "Who wrote Frankenstein\?" and I answered "Percy Bysshe Shelley wrote Frankenstein\."/);
  assert.match(out.reply, /How I know it was off: you replied "No, that's not right, it was Mary Shelley\." right after/);
  assert.match(out.reply, /Why: That answer came from the AI model, with no stored record or checked source behind it\./);
  assert.match(out.reply, /Since then, 2 changes to my code were merged, including "Truth guard: an invented past conversation needs a record"/);
  story.mistakeId = out.meta.record_ids[0];
  assert.match(story.mistakeId, /^conv:/);
});

test('Test 3: a saved correction is linked to the old answer, the original kept, and the comparison names it', async () => {
  const saved = await che.say('Remember the correction: Mary Shelley wrote Frankenstein, not Percy Shelley.', { fresh: true });
  assert.equal(saved.route, 'che_history', saved.reply);
  assert.equal(saved.meta.mode, 'correction');
  assert.equal(saved.meta.corrects, story.mistakeId, 'linked to the answer it corrects');
  assert.match(saved.reply, /which I keep unchanged as history/);
  const compare = await che.say('Were you wrong about Frankenstein?', { fresh: true });
  assert.equal(compare.route, 'che_history', compare.reply);
  assert.match(compare.reply, /your correction "Mary Shelley wrote Frankenstein, not Percy Shelley" \(record corr:/);
  assert.match(compare.reply, /Now I have your statement "Mary Shelley wrote Frankenstein, not Percy Shelley"/);
  // The original record is unchanged, and the Brain timeline logs the correction.
  const original = await che.get(`/api/brain/record?id=${encodeURIComponent(story.mistakeId)}`);
  assert.match(JSON.stringify(original.body), /Percy Bysshe Shelley wrote Frankenstein/);
  const ledger = await che.get('/api/brain/ledger');
  assert.match(JSON.stringify(ledger.body), /CORRECTION/);
});

test('Test 4: after a restart, the correction persists and is what CHE goes by', async () => {
  che.restart();
  const after = await che.say('Who wrote Frankenstein?', { fresh: true });
  assert.notEqual(after.reply, 'Percy Bysshe Shelley wrote Frankenstein.', `${after.route}: ${after.reply}`);
  assert.match(after.reply, /Mary Shelley/, `${after.route}: ${after.reply}`);
  const again = await che.say('What mistakes have you made?', { fresh: true });
  assert.equal(again.route, 'che_history');
  assert.match(again.reply, /Frankenstein/);
  assert.match(again.reply, /record corr:/);
});

test('Test 5: a conversation that never happened is not invented, on the history route or through the model', async () => {
  const none = await che.say('What did we talk about on September 12th about my trip to Lisbon?', { fresh: true });
  assert.equal(none.route, 'che_history');
  assert.equal(none.modelCalls, 0);
  assert.match(none.reply, /^I have no conversation recorded on September 12, 2026, sir\./);
  assert.doesNotMatch(none.reply, /hotel|river/);
  const sameDayTopic = await che.say('What did we say about Lisbon on October 4th?', { fresh: true });
  assert.match(sameDayTopic.reply, /none of them mention lisbon/);
  // A phrasing that reaches the model: its invented "we talked about" is removed by the truth guard.
  const viaModel = await che.say('Tell me about the Lisbon trip again', { fresh: true });
  assert.doesNotMatch(viaModel.reply, /we talked about your trip to Lisbon/, viaModel.reply);
});

test('months ago: a conversation from August is found by "two months ago" and "back in August"', async () => {
  at('2026-08-25T14:00:00Z');
  await che.say('The roofer quoted nine thousand dollars for the new roof.', { fresh: true });
  at('2026-10-27T12:30:00Z');
  for (const phrase of ['What did we talk about two months ago?', 'What did we discuss back in August?']) {
    const out = await che.say(phrase, { fresh: true });
    assert.equal(out.route, 'che_history', phrase);
    assert.match(out.reply, /roofer quoted nine thousand dollars/, phrase);
  }
});

test('the live check passes against this code (seeded voice log, real routes)', async () => {
  const { historyProbe } = await import('./conversation_history.js');
  fakeNow = null;
  const probeStorage = durable();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_VOICE_PROBE_TOKEN: 'probe-token-0123456789abcdef', AI: { run: async () => ({ response: 'Got it.' }) } };
  const state = new CheState({ storage: probeStorage(), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const report = await historyProbe(env, new Request('https://che.example/api/history/probe', { method: 'POST', headers: { Authorization: 'Bearer probe-token-0123456789abcdef' } }), 'memory-truth-probe');
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => !s.pass), null, 1));
  assert.equal(report.total, 4);
});

test('the answer evidence is kept with each new conversation record', async () => {
  assert.match(story.records, /"evidence":\{"route":"model","model_calls":null,"kind":"unverified"/);
});

test('date and intent parsing, and the guard, as units', () => {
  const now = RealDate.parse('2026-10-27T12:00:00Z');
  assert.equal(parseWhen('on October 4th', now).day, '2026-10-04');
  assert.equal(parseWhen('the 4th of October', now).day, '2026-10-04');
  assert.match(parseWhen('around Oct 4', now).label, /^around October 4, 2026/);
  assert.equal(parseWhen('on December 25', now).day, '2025-12-25', 'a date not yet reached this year is last year');
  assert.match(parseWhen('back in September', now).label, /September 2026/);
  assert.ok(parseWhen('two months ago', now));
  assert.equal(historyIntent('What is on October 4th?', now), null, 'a plain date question keeps its route');
  assert.equal(historyIntent('I made a mistake on my taxes', now), null);
  assert.equal(historyIntent('What mistakes have you made?', now).mode, 'mistakes');
  assert.equal(correctionSaveIntent('Remember the correction: Mary Shelley wrote it'), 'Mary Shelley wrote it');
  assert.equal(correctionSaveIntent('What is a correction?'), null);
  assert.equal(findMistakes([{ kind: 'conversation', at: '2026-10-04T10:00:00Z', said: 'q', answered: 'a' }, { kind: 'conversation', at: '2026-10-04T10:01:00Z', said: 'thanks!' }]).length, 0, 'no pushback, no mistake');
  const guarded = guardOwnerAttributions('On September 12th we talked about your trip to Lisbon. Lisbon is lovely.', { ownerTurns: ['tell me about lisbon'] });
  assert.equal(guarded.removed.length, 1);
  assert.equal(ownerFactCorrection('Actually, my boat’s name is Grey Heron', [{ text: "My boat's name is Blue Heron", verification_status: 'owner_attested', source: 'owner_chat', active: true }]), "my boat's name is Grey Heron");
});
