// Issue #345: the whole sentence is understood first, then carried as a compact frame that never loses
// a "don't", a time, a quantity, a condition or a name. The adversarial sentences are the issue's own.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { intentFrame } from './intent_frame.js';

const frame = (text) => intentFrame(text);

test('the issue\'s sentences: mode, actor, steps and every constraint survive', () => {
  const trip = frame("CHE, I want to go to Walmart tomorrow and buy apples, but don't order anything yet");
  assert.equal(trip.mode, 'plan');
  assert.equal(trip.actor, 'owner');
  assert.deepEqual(trip.steps, ['go to Walmart tomorrow', 'buy apples']);
  assert.deepEqual(trip.do_not, ["don't order anything yet"]);
  assert.deepEqual(trip.time, ['tomorrow']);
  assert.deepEqual(trip.needs_yes, [], 'the owner\'s own trip with ordering forbidden asks CHE to spend nothing');
  assert.equal(trip.lossless, true);

  assert.deepEqual(frame('I need apples at the store').needs_yes, []);
  const buy = frame('CHE, buy 3 apples online now');
  assert.equal(buy.mode, 'do');
  assert.deepEqual(buy.quantity, ['3']);
  assert.deepEqual(buy.needs_yes, ['money'], 'a purchase for CHE still needs the owner\'s yes');

  const list = frame("Add apples to the grocery list, but don't buy them");
  assert.deepEqual([list.steps, list.do_not, list.needs_yes], [['Add apples to the grocery list'], ["don't buy them"], []]);

  const cancelled = frame('Buy 2 apples at Walmart—actually, cancel that');
  assert.deepEqual([cancelled.mode, cancelled.steps, cancelled.needs_yes], ['cancel', [], []]);

  const directions = frame("Find a nearby store and give me directions; don't navigate or go anywhere yet");
  assert.deepEqual(directions.do_not, ["don't navigate or go anywhere yet"]);

  const reminder = frame('Make a reminder tomorrow at 8, not today');
  assert.deepEqual([reminder.steps, reminder.do_not, reminder.time], [['Make a reminder tomorrow at 8'], ['not today'], ['tomorrow', 'at 8']]);

  const draft = frame("Send a draft to Mike but don't send the email yet");
  assert.deepEqual([draft.steps, draft.do_not], [['Send a draft to Mike'], ["don't send the email yet"]]);

  assert.deepEqual(frame('Place a paper trade, not live').do_not, ['not live']);
  const explainOrder = frame('Explain a live order without submitting one');
  assert.deepEqual([explainOrder.mode, explainOrder.do_not], ['explain', ['without submitting one']]);
  const howTo = frame("Don't delete the draft; just explain how to delete it");
  assert.deepEqual([howTo.mode, howTo.do_not, howTo.needs_yes], ['explain', ["Don't delete the draft"], []]);

  const steps = frame("Chay email Sarah the report then text Mom that I'm running late, unless the meeting moved");
  assert.deepEqual(steps.steps, ['email Sarah the report', "text Mom that I'm running late, unless the meeting moved"]);
  assert.match(steps.compact, /Sarah[\s\S]*Mom[\s\S]*unless the meeting moved/);
});

test('a frame that would drop a constraint says so, and the full words are used', () => {
  // A name or number the steps cannot hold is reported missing rather than silently lost.
  const f = intentFrame('Remind Sam at 9');
  assert.equal(f.lossless, f.missing.length === 0);
  for (const text of ["CHE, I want to go to Walmart tomorrow and buy apples, but don't order anything yet", "Send a draft to Mike but don't send the email yet", 'Make a reminder tomorrow at 8, not today']) {
    const x = intentFrame(text);
    for (const word of ["don't", 'not', 'tomorrow', '8', 'Walmart', 'Mike']) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(text)) assert.match(x.compact, new RegExp(`\\b${word}\\b`, 'i'), `${word} in "${text}"`);
    }
  }
});

// Through /api/chat: a clear command after earlier conversation no longer pays for an extra reading
// model call, and the reading model can no longer rewrite it into something else.
const generated = new URL('./.intent_frame.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async () => { throw new TypeError('fetch failed (intent_frame tests are offline)'); };

async function owner(model) {
  const saved = new Map();
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { counter.calls += 1; return { response: model }; } },
  };
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k), deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const state = new CheState({ storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [{ role: 'user', content: 'How are the markets today?' }, { role: 'assistant', content: 'Markets are mixed, sir.' }];
  return {
    saved,
    say: async (message) => {
      const before = counter.calls;
      const raw = await (await send('/api/chat', { message, history }, token)).text();
      const lines = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
      // A clarification or a cancel is one JSON answer, not a stream.
      const done = lines.find((x) => x.type === 'done') || (lines.length === 1 ? lines[0] : {});
      return { reply: replyFromNdjson(raw) || done.reply || '', meta: done, modelCalls: counter.calls - before };
    },
  };
}

test('a clear command after earlier turns makes no reading-model call', async () => {
  // A reading model that would rewrite every turn into "switch to paper trading".
  const che = await owner('{"intent":"action","meaning":"switch to paper trading","confidence":0.9,"clarify":""}');
  const out = await che.say('CHE, switch to paper trading');
  assert.equal(out.meta.source, 'che_trading_desk');
  assert.equal(out.modelCalls, 0);
  // A clear question is answered as asked, never rewritten by the reading model.
  const recap = await che.say('Give me a quick recap of how my week at the office went.');
  assert.notEqual(recap.meta.source, 'che_trading_desk');
});

test('"Buy 2 apples at Walmart—actually, cancel that" drops it: no hold, nothing bought', async () => {
  const che = await owner('Understood, sir.');
  const out = await che.say('Buy 2 apples at Walmart—actually, cancel that');
  assert.match(out.reply, /dropped that/);
  assert.notEqual(out.meta.held_for_owner, true);
  assert.equal(che.saved.get('che:pending_owner_action') ?? null, null);
});

test('"Understood as": only a held or multi-step turn with a "don\'t" carries it, and only when nothing is lost', async () => {
  const { understoodAs } = await import('./intent_frame.js');
  assert.equal(understoodAs('CHE, buy 3 apples online now'), 'do: buy 3 apples online now | needs yes: money');
  assert.equal(understoodAs('Delete my last note.'), 'do: Delete my last note | needs yes: delete');
  assert.equal(understoodAs('Forget that my favorite color is blue.'), 'do: Forget that my favorite color is blue | needs yes: delete');
  assert.equal(understoodAs("CHE, I want to go to Walmart tomorrow and buy apples, but don't order anything yet"),
    "plan (owner): go to Walmart tomorrow; buy apples | not: don't order anything yet");
  for (const plain of ["What's the weather?", 'Tell me a joke', "Send a draft to Mike but don't send the email yet", 'Buy 2 apples at Walmart—actually, cancel that']) {
    assert.equal(understoodAs(plain), '', plain);
  }
});

test('through /api/chat: a hold and a multi-step plan carry understood_as; an ordinary turn does not', async () => {
  const che = await owner('Okay, sir.');
  const held = await che.say('CHE, buy 3 apples online now');
  assert.equal(held.meta.held_for_owner, true);
  assert.equal(held.meta.understood_as, 'do: buy 3 apples online now | needs yes: money');
  const plan = await che.say("CHE, I want to go to Walmart tomorrow and buy apples, but don't order anything yet");
  assert.equal(plan.meta.understood_as, "plan (owner): go to Walmart tomorrow; buy apples | not: don't order anything yet");
  assert.notEqual(plan.meta.held_for_owner, true);
  assert.equal((await che.say('Tell me a joke')).meta.understood_as, undefined);
});
