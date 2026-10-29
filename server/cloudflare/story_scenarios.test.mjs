// Story scenarios through the real /api/chat route of the Worker. Three situations: a fictional hood-drama story,
// a roleplay inside one, and casual drama talk. An ordinary question is the control. The model is a fake that
// records the prompt it receives, so these tests check what CHE asks the model to do, not how the reply reads;
// real-model dialogue quality is a separate check that needs the owner's approval for paid calls.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

const generated = new URL('./.story_scenarios.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Offline, like the other chat tests: no outbound lookups.
globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (story scenario tests are offline: ${new URL(String(input?.url || input)).host})`);
};

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A paired owner phone. `reply` is what the fake model returns; every system prompt it was given is recorded.
async function owner(reply) {
  const prompts = [];
  const saved = new Map();
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { prompts.push(String(input.messages?.[0]?.content || '')); return { response: reply }; } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    return { reply: replyFromNdjson(raw), prompt: prompts.at(-1) || '' };
  };
  return { say };
}

const STORY_REPLY = 'Keisha: You really did that on the porch? Dee: Girl, sit down. Keisha: Don\'t tell me to sit.';

test('situation 1: a fictional hood-drama story gets the story rules and no summary lines', async () => {
  const che = await owner(STORY_REPLY);
  const out = await che.say('Tell me a short story about my cousin who got caught cheating on the block');
  assert.match(out.prompt, /MODE: STORY\./);
  assert.match(out.prompt, /DIALOGUE FIRST/);
  assert.match(out.prompt, /NO SPEECHES, NO LESSONS/);
  assert.doesNotMatch(out.prompt, /NEXT STEP:/, 'a story turn gets no next-step offer');
  assert.doesNotMatch(out.prompt, /ONE CONNECTED WORLD/, 'a story turn gets no made-across-rooms list');
  assert.equal(out.reply, STORY_REPLY);
});

test('situation 2: a roleplay inside a story speaks as the character, not as a narrator', async () => {
  const che = await owner('Dee: Keisha, get off my porch. Keisha: Make me, cuz.');
  const out = await che.say("Let's roleplay. You're my cousin Dee and I just walked up to your porch");
  assert.match(out.prompt, /MODE: ROLEPLAY\./);
  assert.match(out.prompt, /in first person, one turn at a time/);
  assert.match(out.prompt, /NO REPORT FORMAT/);
  assert.doesNotMatch(out.prompt, /NEXT STEP:/);
});

test('situation 3: casual drama talk gets short, natural replies, not a story or a summary', async () => {
  const che = await owner('Wait, the neighbor? Girl, I need the whole thing. Did she say it to his face?');
  const out = await che.say('Girl, you won\'t believe what Keisha did, she caught her man with the neighbor on Maple');
  assert.match(out.prompt, /MODE: DRAMA TALK\./);
  assert.match(out.prompt, /one to three short sentences/);
  assert.doesNotMatch(out.prompt, /MODE: STORY\./);
  assert.doesNotMatch(out.prompt, /NEXT STEP:/);
  assert.doesNotMatch(out.prompt, /ONE CONNECTED WORLD/);
});

test('control: an ordinary question keeps the normal rules, including the next-step offer', async () => {
  const che = await owner('Use the fast route. Want me to set it up?');
  const out = await che.say('What is the best way to organize my week?');
  assert.doesNotMatch(out.prompt, /STORY AND DRAMA CRAFT/);
  assert.match(out.prompt, /NEXT STEP:/);
});
