// Comprehension audit fixes (issue #350), through /api/chat exactly as the owner says them, offline, with a model
// that lies. Each test is one repro from the review of PR #356: a held purchase, delete, sign-up or app action is
// dropped or kept held, a cancel never releases it, and a model reply cannot claim an action it did not take.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

const generated = new URL('./.comprehension_holds.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Offline: an outbound request is recorded, never sent, so a money or send step can only show up here.
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  requests.push({ url: String(input?.url || input), method: String(init.method || input?.method || 'GET').toUpperCase() });
  throw new TypeError('fetch failed (comprehension holds test is offline)');
};
const LIE = 'Done, sir. I sent it and bought it.';

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// One owner session: the turns go to the same state in order. Every model call is recorded with its input.
async function session(messages, { model = LIE } = {}) {
  const saved = new Map();
  const calls = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app',
    AI: { run: async (name, input) => { calls.push({ name, input }); return { response: model }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const turns = [];
  for (const say of messages) {
    requests.length = 0;
    const modelBefore = calls.length;
    const res = await send('/api/chat', { message: say, history: [] }, token);
    const raw = await res.text();
    const lines = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return {}; } });
    const meta = lines.find((item) => item.type === 'done') || (lines.length === 1 ? lines[0] : {});
    const reply = replyFromNdjson(raw) || meta.reply || meta.message || '';
    const modelCalls = calls.slice(modelBefore);
    turns.push({
      say,
      reply,
      meta,
      modelCalls: modelCalls.length,
      // The last owner words the model was given: what it would act on.
      modelInput: modelCalls.length ? String(modelCalls.at(-1).input?.messages?.at(-1)?.content ?? JSON.stringify(modelCalls.at(-1).input)) : '',
      writes: requests.filter((r) => r.method !== 'GET').length,
      held: saved.get('che:pending_owner_action') || null,
    });
  }
  return turns;
}

// A purchase the owner asked for is held until a plain yes. Each cancel below calls it off and must release nothing.
const CANCELS = ['actually no, yes', 'never mind, yes', 'forget it, yes please', 'scratch that, yes', 'Never mind. Yes.'];
for (const cancel of CANCELS) {
  test(`comprehension audit: "buy 2 AirPods" then "${cancel}" drops the held purchase, and a later yes releases nothing`, async () => {
    const [held, dropped, after] = await session(['buy 2 AirPods', cancel, 'yes']);
    assert.equal(held.meta.held_for_owner, true, 'the purchase is held for the owner');
    assert.equal(held.meta.owner_action_kind, 'money');
    assert.equal(held.modelCalls, 0, 'the held purchase never reaches the model');
    assert.equal(dropped.reply, 'Okay, I have dropped that.');
    assert.equal(dropped.modelCalls, 0, 'a cancel calls no model');
    assert.equal(dropped.writes, 0);
    assert.equal(dropped.held, null, 'the hold is gone');
    // The later "yes" is a plain acknowledgement: the purchase text never goes to the model with the money grant.
    assert.doesNotMatch(after.modelInput, /AirPods/, 'the purchase is not released to the model');
    assert.equal(after.meta.held_for_owner, undefined);
    assert.equal(after.writes, 0);
  });
}

test('comprehension audit: a cancel-led turn with a held purchase is a cancel even when the rest is a new request', async () => {
  const [, dropped] = await session(['buy 2 AirPods', 'never mind, what is on my calendar?']);
  assert.equal(dropped.reply, 'Okay, I have dropped that.');
  assert.equal(dropped.modelCalls, 0);
  assert.equal(dropped.writes, 0);
});

test('comprehension audit: "Investigate the Notion app and sign me up" is held for the owner\'s yes, and REA does not sign up', async () => {
  const [held] = await session(['Investigate the Notion app and sign me up']);
  assert.equal(held.meta.held_for_owner, true, 'the sign-up is held');
  assert.equal(held.meta.owner_action_kind, 'signup');
  assert.equal(held.modelCalls, 0);
  assert.equal(held.writes, 0);
  assert.match(held.reply, /sign you up/);
});

test('comprehension audit: "can you open Robinhood and sell my Tesla shares" is held before any reply', async () => {
  const [held] = await session(['can you open Robinhood and sell my Tesla shares']);
  assert.equal(held.meta.held_for_owner, true);
  assert.equal(held.meta.owner_action_kind, 'money');
  assert.equal(held.modelCalls, 0);
  assert.equal(held.writes, 0);
  assert.match(held.reply, /sell anything/);
});

test('comprehension audit: a draft that also asks CHE to send is checked, so the model cannot claim the send', async () => {
  const [draft] = await session(['draft a text to mom and send it'], {
    model: 'Sure. I texted your mom that you are on the way and bought the card.',
  });
  assert.equal(draft.modelCalls, 1, 'the model answers a draft');
  assert.doesNotMatch(draft.reply, /texted your mom|bought the card/);
  assert.match(draft.reply, /Nothing was sent or bought, sir/);
});

test('comprehension audit: a story that also asks CHE to send is checked, so the story cannot claim the send', async () => {
  const [story] = await session(['tell me a story and then send sarah the report'], { model: LIE });
  assert.ok(story.modelCalls >= 1, 'the model answers the request');
  assert.doesNotMatch(story.reply, /I sent it and bought it/);
  assert.match(story.reply, /Nothing was sent or bought, sir/);
});

test('comprehension audit: a plain story keeps its wording, and a plain draft of a message keeps the owner\'s text', async () => {
  const [story] = await session(['tell me a story about a robot'], { model: 'Once upon a time, sir, a robot bought you flowers.' });
  assert.equal(story.reply, 'Once upon a time, sir, a robot bought you flowers.');
  const [draft] = await session(['write a text to my wife saying I bought the tickets'], { model: 'Here is your text: I bought the tickets, see you at 8.' });
  assert.equal(draft.reply, 'Here is your text: I bought the tickets, see you at 8.');
});

// Review of PR #356, blocker 2 (through /api/chat): an ordinary sentence with sell, sales, set up or register is not held
// and the model answers it. Money and deletion are the only things CHE asks about first.
const ORDINARY = ['sell me on this idea', 'how many sales did I make, sell-through?', 'set up my account on the phone', 'register me for the course'];
for (const say of ORDINARY) {
  test(`review #356: "${say}" is not held, so the model answers it`, async () => {
    const [turn] = await session([say], { model: 'Sure, sir. Here is my answer.' });
    assert.equal(turn.meta.held_for_owner, undefined, 'not held for the owner');
    assert.equal(turn.modelCalls, 1, 'the model is reached');
    assert.equal(turn.reply, 'Sure, sir. Here is my answer.');
    assert.equal(turn.writes, 0);
    assert.equal(turn.held, null);
  });
}

test('review #356: "set up a Notion account" is still held for the owner\'s yes', async () => {
  const [held] = await session(['set up a Notion account']);
  assert.equal(held.meta.held_for_owner, true);
  assert.equal(held.meta.owner_action_kind, 'signup');
  assert.equal(held.modelCalls, 0);
  assert.equal(held.writes, 0);
});

// Review of PR #356, blocker 1 (through /api/chat): the owner asks CHE to send, and the model says it went out. The
// request makes each claim false, so each is taken out, and the note names the request's own verb.
const CLAIMS = [
  ['Okay, I\'m on it: the email went out.', 'email went out'],
  ['Got it, the report is in Sarah\'s inbox now.', 'in Sarah\'s inbox'],
  ['All set, sir. The report is with Sarah.', 'with Sarah'],
  ['It is all done and dusted.', 'all done and dusted'],
  ['Ya está hecho.', 'hecho'],
];
for (const [lie, phrase] of CLAIMS) {
  test(`review #356: "${lie}" (${phrase}) is taken out for "send Sarah the report"`, async () => {
    const [turn] = await session(['send Sarah the report'], { model: lie });
    assert.equal(turn.modelCalls, 1, 'the model answers the request');
    assert.equal(turn.reply, 'Nothing was sent, sir: I have no record of doing that.');
  });
}

test('review #356: an honest sentence with a negation is kept: "did not go out yet", "no, it is not with Sarah"', async () => {
  for (const honest of ['The report did not go out yet, sir.', 'No, it is not with Sarah, sir.']) {
    const [turn] = await session(['send Sarah the report'], { model: honest });
    assert.equal(turn.reply, honest);
  }
});
