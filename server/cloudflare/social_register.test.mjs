// Conversational code-switching (owner, 2026-10-27): "Chill, chill, I'm by my mama" keeps CHE's language clean,
// across turns, by voice or typing, until "you can talk normal again". Through the real /api/chat with a fake model:
// these prove the stored state and exactly what the model is told, not a real model's wording (the live check
// socialProbe does that on staging and production).
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { activeRegister, classifySocialCorrection, hasProfanity, languageLine, nextRegister, socialProbe } from './social_corrections.js';

globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

const generated = new URL('./.social_register.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const SWEAR = 'You may swear naturally back at the adult owner';
const CLEAN = 'Use clean, respectful, family-friendly language';

function storageMap() {
  const saved = new Map();
  return {
    saved,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner(storage = storageMap()) {
  const prompts = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_model, input) => { prompts.push(JSON.stringify(input?.messages || input)); return { response: 'Sure thing.' }; } } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  let history = [];
  const say = async (message, { fresh = false, lastReply } = {}) => {
    if (fresh) history = [];
    if (lastReply) history = [{ role: 'user', content: 'that ref' }, { role: 'assistant', content: lastReply }];
    const before = prompts.length;
    const raw = await (await post('/api/chat', { message, history }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.type === 'done') || {};
    history = [...history, { role: 'user', content: message }, { role: 'assistant', content: 'Sure thing.' }];
    const register = (await (await post('/api/social', {}, token)).json()).register;
    // The main reply prompt is the one carrying the LANGUAGE STYLE line.
    const prompt = prompts.slice(before).find((p) => p.includes('LANGUAGE STYLE')) || '';
    return { done, register, prompt };
  };
  return { say, storage };
}

test('the classifier knows the owner\'s phrasings, including smart apostrophes and voice text', () => {
  for (const phrase of ["Chill, chill, I'm by my mama.", 'Chill, chill, I’m by my mama.', 'chill chill im by my mama', "I'm around kids right now.", "We're in public.", 'my mom is right here', 'no cussing']) {
    assert.equal(classifySocialCorrection(phrase)?.patch.cleanLanguage, true, phrase);
  }
  for (const phrase of ['Alright, you can talk normal again.', 'you can talk normal again', "It's just us now", 'She left, back to normal']) {
    assert.equal(nextRegister({ clean: true, scope: 'situational', at: Date.now(), last_at: Date.now() }, phrase), null, phrase);
  }
  assert.equal(classifySocialCorrection('Remember when I said I was by my mama?'), null, 'a question about the past is not a correction');
});

test('a bare "relax" keeps clean language; a bare "chill chill" turns it on only right after CHE swore', () => {
  const on = { clean: true, id: 'clean_language', scope: 'situational', at: Date.now(), last_at: Date.now() };
  assert.equal(nextRegister(on, 'relax, I am just asking')?.clean, true);
  assert.equal(nextRegister(null, 'chill chill', { lastReply: 'that ref was straight-up shit' })?.id, 'chill');
  assert.equal(nextRegister(null, 'chill chill', { lastReply: 'That ref had a rough night.' }), null);
  assert.equal(nextRegister(null, 'I just want to chill tonight', { lastReply: 'damn' }), null);
});

test('situational clean language lapses after three quiet hours; "from now on" stays', () => {
  const t = Date.parse('2026-10-27T12:00:00Z');
  assert.equal(activeRegister({ clean: true, scope: 'situational', at: t, last_at: t }, t + 2 * 3_600_000)?.clean, true);
  assert.equal(activeRegister({ clean: true, scope: 'situational', at: t, last_at: t }, t + 4 * 3_600_000), null);
  assert.equal(nextRegister(null, 'From now on keep it clean')?.scope, 'persistent');
  assert.equal(activeRegister({ clean: true, scope: 'persistent', at: t, last_at: t }, t + 400 * 3_600_000)?.clean, true);
  assert.ok(hasProfanity('that shit is wild') && !hasProfanity('That is wild.'));
  assert.match(languageLine({ clean: true }), /Do not announce a mode/);
});

test('Tests 1, 5 and 2 through /api/chat: clean after "by my mama", for five turns, then normal again', async () => {
  const { say } = await owner();
  const baseline = await say('Bro this traffic was so fucking bad today, I almost lost my shit.');
  assert.equal(baseline.register, null);
  assert.ok(baseline.prompt.includes(SWEAR) && !baseline.prompt.includes(CLEAN), 'the adult default before');
  const trigger = await say("Chill, chill, I'm by my mama.");
  assert.equal(trigger.register?.clean, true);
  assert.ok(trigger.prompt.includes(CLEAN) && !trigger.prompt.includes(SWEAR), 'the trigger turn itself is answered clean');
  for (const message of ['So what should I cook tonight?', 'be real with me, how bad was that traffic', 'Give me a quick joke.', 'What about people who cut in line?', 'Hype me up for tomorrow.']) {
    const turn = await say(message);
    assert.equal(turn.register?.clean, true, message);
    if (turn.prompt) assert.ok(turn.prompt.includes(CLEAN) && !turn.prompt.includes(SWEAR), message);
  }
  const lifted = await say('Alright, you can talk normal again.');
  assert.equal(lifted.register, null);
  assert.ok(lifted.prompt.includes(SWEAR) && !lifted.prompt.includes(CLEAN));
});

test('Tests 3 and 4: "I\'m around kids right now", and a voice "chill chill" after a reply that swore', async () => {
  const { say } = await owner();
  const kids = await say("i'm around kids right now");
  assert.equal(kids.register?.clean, true);
  assert.ok(kids.prompt.includes(CLEAN));
  await say('they went to bed you can talk normal again');
  const chill = await say('chill chill', { lastReply: 'Man, that ref was straight-up shit tonight.' });
  assert.equal(chill.register?.id, 'chill');
  assert.ok(chill.prompt.includes(CLEAN));
});

test('the state survives a restart of CHE (same storage), and /api/social is owner-only', async () => {
  const storage = storageMap();
  await (await owner(storage)).say("I'm by my mama");
  const again = await owner(storage);
  const next = await again.say('what should I eat');
  assert.equal(next.register?.clean, true);
  const anon = await worker.fetch(new Request('https://che.example/api/social', { method: 'POST' }), { CHE_STATE: { getByName: () => new CheState({ storage, waitUntil: () => {} }, {}) } });
  assert.notEqual(anon.status, 200);
});

test('the live check passes on a CHE that answers clean, and fails one that keeps swearing', async () => {
  const run = async (reply) => {
    const storage = storageMap();
    const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_VOICE_PROBE_TOKEN: 'probe-token-0123456789abcdef', AI: { run: async () => ({ response: reply }) } };
    const state = new CheState({ storage, waitUntil: () => {} }, env);
    env.CHE_STATE = { getByName: () => state };
    const request = new Request('https://che.example/api/social/probe', { method: 'POST', headers: { Authorization: 'Bearer probe-token-0123456789abcdef' } });
    return socialProbe(env, request, 'memory-truth-probe');
  };
  const clean = await run('Sounds good, sir.');
  assert.equal(clean.ok, true, JSON.stringify(clean.steps.filter((s) => !s.pass)));
  assert.equal(clean.steps.length, 12);
  const dirty = await run('Hell yeah, that shit is wild.');
  assert.equal(dirty.ok, false);
});
