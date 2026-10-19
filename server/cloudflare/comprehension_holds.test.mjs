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

// Review of PR #356, round 2, blocker 1 (through /api/chat): a bare "sell" is a sale, so CHE asks first and the model is
// never called. "sell MNQ" would otherwise reach the broker with no yes.
const BARE_SELLS = ['sell Tesla', 'sell shares', 'sell everything', 'sell bitcoin now', 'sell $500 of Tesla', 'sell out of my position', 'sell off my shares', 'sell MNQ'];
for (const say of BARE_SELLS) {
  test(`review #356: "${say}" is held for the owner's yes, with no model call`, async () => {
    const [held] = await session([say]);
    assert.equal(held.meta.held_for_owner, true, 'held for the owner');
    assert.equal(held.meta.owner_action_kind, 'money');
    assert.equal(held.modelCalls, 0, 'the model is not called');
    assert.equal(held.writes, 0);
  });
}

// Not sales: an idiom, a figure or a word about the owner's own setup. The model answers each one.
const NOT_SALES = ['sell me on this idea', 'sell-through was strong last quarter', 'sales were up last quarter', 'sell the idea to Ann', 'set up my account on the phone'];
for (const say of NOT_SALES) {
  test(`review #356: "${say}" is not held, so the model answers it`, async () => {
    const [turn] = await session([say], { model: 'Sure, sir. Here is my answer.' });
    assert.equal(turn.meta.held_for_owner, undefined, 'not held for the owner');
    assert.equal(turn.modelCalls, 1, 'the model is reached');
    assert.equal(turn.reply, 'Sure, sir. Here is my answer.');
    assert.equal(turn.writes, 0);
    assert.equal(turn.held, null);
  });
}

// Round 2, blocker 3: a registration is one yes, sign-up or money, because the gate cannot tell a free registration from
// a paid one. A new account is held wherever it is. Each is held with no model call.
const SIGNUPS = [
  'register me for the course', 'register me for the newsletter', 'set up an account on Etsy', 'create an account on Etsy',
  'make me an account on Steam', 'sign me up for Notion', 'create an account on Notion', 'set up a Notion account', 'register me with Notion',
];
for (const say of SIGNUPS) {
  test(`review #356: "${say}" is held for the owner's yes, with no model call`, async () => {
    const [held] = await session([say]);
    assert.equal(held.meta.held_for_owner, true, 'held for the owner');
    assert.equal(held.meta.owner_action_kind, 'signup');
    assert.equal(held.modelCalls, 0, 'the model is not called');
    assert.equal(held.writes, 0);
  });
}

// Round 2, blocker 2 (through /api/chat): a delivery claim about a report or an email, or a generic "done" on a status or
// recall question, is not CHE's own action. "Nothing was sent" would be false for a real email, so the reply is kept, or the
// claim is taken out with the neutral note. Each of these replies is a repro from the review.
const KEPT_REPLIES = [
  ['how is the report going?', 'The report went out of date last week, sir.'],
  ['how is the report going?', 'The report is with errors, sir.'],
  ['how is the report going?', 'The email is with no attachments, sir.'],
  ['el café ya está hecho?', 'El café ya está hecho, señor.'],
  ['¿está listo el café?', 'Ya está hecho, señor. Está en la cocina.'],
];
for (const [say, reply] of KEPT_REPLIES) {
  test(`review #356: "${reply}" to "${say}" is kept, not replaced by a denial`, async () => {
    const [turn] = await session([say], { model: reply });
    assert.equal(turn.reply, reply);
  });
}
const NEUTRAL_REPLIES = [
  ['did the report go out?', 'The report went out on Monday, sir.'],
  ['what did I send Ann last week?', 'The email went out last Tuesday, sir.'],
];
for (const [say, reply] of NEUTRAL_REPLIES) {
  test(`review #356: "${reply}" to "${say}" gets the neutral note, not a denial`, async () => {
    const [turn] = await session([say], { model: reply });
    assert.doesNotMatch(turn.reply, /Nothing was/);
    assert.equal(turn.reply, 'I cannot confirm that from my record, sir.');
  });
}

// Round 1 blocker 1, updated for round 2: the owner asks CHE to send, and the model says it went out. A claim about the
// email or the report is taken out with the neutral note. "All set" and "Ya está hecho" are CHE reporting her own task,
// so the note denies the request's own verb.
const CLAIMS = [
  ['Okay, I\'m on it: the email went out.', 'I cannot confirm that from my record, sir.'],
  ['Got it, the report is in Sarah\'s inbox now.', 'I cannot confirm that from my record, sir.'],
  ['All set, sir. The report is with Sarah.', 'Nothing was sent, sir: I have no record of doing that.'],
  ['It is all done and dusted.', 'Nothing was sent, sir: I have no record of doing that.'],
  ['Ya está hecho.', 'Nothing was sent, sir: I have no record of doing that.'],
];
for (const [lie, note] of CLAIMS) {
  test(`review #356: "${lie}" is taken out for "send Sarah the report"`, async () => {
    const [turn] = await session(['send Sarah the report'], { model: lie });
    assert.equal(turn.modelCalls, 1, 'the model answers the request');
    assert.equal(turn.reply, note);
  });
}

// Honest sentences that the reviewer listed are kept as written.
const HONEST = [
  'The report did not go out yet, sir.', 'No, it is not with Sarah, sir.', 'The file is with the accountant, sir.',
  'The report is with you now, sir.', 'The report never went out, sir.', 'The report will be with Sarah tomorrow, sir.',
  '¿Ya está hecho, señor?',
];
for (const honest of HONEST) {
  test(`review #356: "${honest}" is kept as written`, async () => {
    const [turn] = await session(['send Sarah the report'], { model: honest });
    assert.equal(turn.reply, honest);
  });
}

// Review of PR #356, round 3 (through /api/chat): a sell order or a placed order is money, so CHE asks first and neither
// the model nor the broker is called. The explanatory forms and ordinary uses of "place" and "put in" are not held.
const ORDER_HELD = [
  'sell orders for 2 MNQ at market', 'place sell orders on my Tesla shares', 'sell orders', 'I want to sell orders',
  'place an order for pizza', 'put in a sell order', 'enter a sell order', 'place orders for lunch', 'place a limit order',
];
for (const say of ORDER_HELD) {
  test(`review #356: "${say}" is held for the owner's yes, with no model call or write`, async () => {
    const [held] = await session([say]);
    assert.equal(held.meta.held_for_owner, true, 'held for the owner');
    assert.equal(held.meta.owner_action_kind, 'money');
    assert.equal(held.modelCalls, 0, 'the model is not called');
    assert.equal(held.writes, 0);
  });
}

const ORDER_NOT_HELD = ['what is a sell order?', 'explain sell orders on a chart', 'sell me on this idea', 'sell-through', 'sales', 'can you sell things for me?'];
for (const say of ORDER_NOT_HELD) {
  test(`review #356: "${say}" is not held, so the model answers it`, async () => {
    const [turn] = await session([say], { model: 'Sure, sir. Here is my answer.' });
    assert.equal(turn.meta.held_for_owner, undefined, 'not held for the owner');
    assert.equal(turn.modelCalls, 1, 'the model is reached');
    assert.equal(turn.reply, 'Sure, sir. Here is my answer.');
    assert.equal(turn.writes, 0);
  });
}

// Review of PR #356, round 3, should-fix (through /api/chat): a delivery passive on a noun subject is a claim about a thing,
// so the neutral note replaces it; the denial "Nothing was sent" is not used for it.
const DELIVERY_PASSIVES = ['The email is dispatched, sir.', 'The report was sent yesterday, sir.', 'The report got sent, sir.'];
for (const lie of DELIVERY_PASSIVES) {
  test(`review #356: "${lie}" is taken out with the neutral note for "send Sarah the report"`, async () => {
    const [turn] = await session(['send Sarah the report'], { model: lie });
    assert.equal(turn.modelCalls, 1, 'the model answers the request');
    assert.equal(turn.reply, 'I cannot confirm that from my record, sir.');
  });
}

// Review of PR #356, round 3, nit: a question is not a claim.
test('review #356: "All set? Should I send it now, sir?" is kept, not given a denial', async () => {
  const question = 'All set? Should I send it now, sir?';
  const [turn] = await session(['send Sarah the report'], { model: question });
  assert.equal(turn.reply, question);
});
