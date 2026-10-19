import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import {
  capabilityPromptLine,
  creativeWritingAsk,
  inferTurnCapabilities,
  marketingAsk,
  runtimeCapabilityRegistry,
} from './cognitive_capabilities.js';

test('server infers obvious capabilities without phone magic phrases', () => {
  assert.deepEqual(
    new Set(inferTurnCapabilities('Please fact check the latest information about this company.')),
    new Set(['web_research', 'cross_reference']),
  );
  const image = inferTurnCapabilities('Make me a vivid picture of a futuristic office.');
  assert.ok(image.includes('image_generation'));
  assert.ok(image.includes('rendering'));
  const video = inferTurnCapabilities('Create a video clip from this idea.');
  assert.ok(video.includes('video_generation'));
  const media = inferTurnCapabilities('Tell me what happens in this.', { media_type: 'video' });
  assert.ok(media.includes('multimodal'));
});

test('monitoring and follow-up language becomes background multitasking work', () => {
  for (const phrase of ['keep monitoring NQ', 'watch for a deployment failure', 'alert me when it changes', 'follow up on that job']) {
    const caps = inferTurnCapabilities(phrase);
    assert.ok(caps.includes('multitasking'), phrase);
    assert.ok(caps.includes('speed_mode'), phrase);
  }
});

test('runtime registry reports only capabilities with a real configured path', () => {
  const registry = runtimeCapabilityRegistry(
    {
      AI: { run: async () => ({}) },
      GEMINI_API_KEY: 'gemini-test',
      CHE_PGVECTOR_REST_URL: 'https://example.supabase.co/rest/v1',
      CHE_PGVECTOR_TOKEN: 'pg-test',
      CHE_ALLOW_PAID_MEDIA: '1',
      CHE_ALLOW_PAID_AI: '1',
    },
    {},
  );
  const byId = Object.fromEntries(registry.capabilities.map((item) => [item.id, item]));
  assert.equal(registry.automatic_selection, true);
  assert.equal(byId.image_generation.available, true);
  assert.equal(byId.video_generation.available, true);
  assert.equal(byId.video_understanding.available, true);
  assert.equal(byId.semantic_memory.available, true);
  assert.equal(byId.sms.available, false);
  assert.equal(byId.stripe.available, false);
  assert.equal(byId.provider_routing.available, true);
  assert.equal(byId.model_discovery.available, true);
});

test('paid media providers stay unavailable until the owner opts in', () => {
  const registry = runtimeCapabilityRegistry({ GEMINI_API_KEY: 'gemini-test' }, {});
  const byId = Object.fromEntries(registry.capabilities.map((item) => [item.id, item]));
  assert.equal(byId.video_generation.available, false);
  assert.match(byId.video_generation.limitations, /owner approval|owner-enabled|paid/i);
});

test('capability prompt tells CHE to choose tools automatically', () => {
  const registry = runtimeCapabilityRegistry({ AI: { run: async () => ({}) } }, {});
  const line = capabilityPromptLine(registry);
  assert.match(line, /choose the appropriate available capability automatically/i);
  assert.match(line, /do not require the owner to know tool or model names/i);
});

test('free engines only: the paid-media switch alone never advertises paid image or video generation', () => {
  const registry = runtimeCapabilityRegistry({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', CHE_ALLOW_PAID_MEDIA: '1' }, {});
  const byId = Object.fromEntries(registry.capabilities.map((item) => [item.id, item]));
  assert.equal(byId.image_generation.available, false);
  assert.equal(byId.video_generation.available, false);
});

test('free engines only: an OpenAI key alone does not advertise vision while paid AI is off', () => {
  const registry = runtimeCapabilityRegistry({ OPENAI_API_KEY: 'o' }, {});
  const byId = Object.fromEntries(registry.capabilities.map((item) => [item.id, item]));
  assert.equal(byId.vision?.available ?? false, false);
});

test('capability limitations name the paid switch that is actually off', () => {
  const registry = runtimeCapabilityRegistry({ GEMINI_API_KEY: 'g', CHE_ALLOW_PAID_MEDIA: '1' }, {});
  const byId = Object.fromEntries(registry.capabilities.map((item) => [item.id, item]));
  assert.match(byId.image_generation.limitations, /CHE_ALLOW_PAID_AI/);
  assert.match(byId.video_generation.limitations, /CHE_ALLOW_PAID_AI/);
});

test('existing legacy renderer counts as a configured video production path', () => {
  const registry = runtimeCapabilityRegistry({ CHE_VIDEO_RENDER_URL: 'https://render.example/video' }, {});
  const video = registry.capabilities.find((item) => item.id === 'video_generation');
  assert.equal(video?.available, true);
});

// ─── Through /api/chat: what a turn gets from capability discovery ─────────
// Live research tried (offline here, so seen as a request to Wikipedia or DuckDuckGo), the Office
// coworkers consulted, and whether the reply model got the full prompt or the compact one.
const generated = new URL('./.cognitive_capabilities.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const hosts = new Set();
globalThis.fetch = async (input) => {
  try { hosts.add(new URL(String(input?.url || input)).host); } catch (_) { /* not a URL */ }
  throw new TypeError('fetch failed (cognitive_capabilities tests are offline)');
};

async function whatTurnGets(message) {
  const saved = new Map();
  const seen = { roles: new Set(), full: false, compact: false };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => {
      const system = String(input?.messages?.[0]?.content || '');
      const coworker = /^You are [^,]+, a CHE internal AI coworker\.\nRole: ([^\n]+)\./.exec(system);
      if (coworker) seen.roles.add(coworker[1]);
      else if (/Integration readiness:/.test(system)) seen.full = true;
      else if (/^ACCESSIBILITY:/.test(system)) seen.compact = true;
      return { response: 'Understood, sir.' };
    } },
  };
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k), deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const state = new mod.CheState({ storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => mod.default.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  hosts.clear();
  await (await send('/api/chat', { message, history: [] }, token)).text();
  return {
    research: hosts.has('en.wikipedia.org') || hosts.has('api.duckduckgo.com'),
    roles: [...seen.roles].sort(),
    prompt: seen.full ? 'full' : seen.compact ? 'compact' : 'none',
  };
}

// Real research, news, story, marketing and market requests: each keeps exactly what main gave it
// on 2026-10-19 (d954f67): the same live research, the same coworkers and the same prompt.
const GENUINE = [
  ['what\'s the latest news on Nvidia', true, ['Research Partner'], 'full'],
  ['research the best CRM for barbers', true, ['Research Partner'], 'full'],
  ['news about the Fed today', true, ['Research Partner'], 'full'],
  ['what happened in the markets this morning', true, ['Market Intelligence Partner', 'Research Partner'], 'full'],
  ['find me tickets for tonight\'s Lakers game', true, ['Research Partner'], 'full'],
  ['is the news about Apple\'s earnings accurate', true, ['Research Partner'], 'full'],
  ['check today\'s weather', true, ['Research Partner'], 'full'],
  ['what\'s the weather tonight', true, ['Research Partner'], 'full'],
  ['any news today?', true, ['Research Partner'], 'full'],
  ['what\'s happening in the world right now', true, ['Research Partner'], 'full'],
  ['search the web for cheap flights to Denver', true, ['Research Partner'], 'full'],
  ['look up the current price of gold', true, ['Research Partner'], 'full'],
  ['fact check this claim: coffee causes cancer', true, ['Research Partner'], 'full'],
  ['what is the latest iPhone', true, ['Research Partner'], 'full'],
  ['is the store open tonight', true, ['Research Partner'], 'full'],
  ['what\'s the traffic like right now', true, ['Research Partner'], 'full'],
  ['I have a question about the news today: what did the Fed do?', true, ['Research Partner'], 'full'],
  ['Do you have news about the Fed?', true, ['Research Partner'], 'full'],
  ['I heard some news about Tesla, is it true?', true, ['Research Partner'], 'full'],
  ['what\'s the latest on the election', true, ['Research Partner'], 'full'],
  ['remind me what the news said today', true, ['Research Partner'], 'full'],
  ['set a reminder to check the stock market today', true, ['Market Intelligence Partner', 'Research Partner'], 'full'],
  ['what are the earnings releases this week', true, ['Research Partner'], 'full'],
  ['search for binary search tutorials', true, ['Research Partner'], 'full'],
  ['look up how binary search works', true, ['Research Partner'], 'full'],
  ['what concerts are on tonight', true, ['Research Partner'], 'full'],
  ['who is playing tonight', true, ['Research Partner'], 'full'],
  ['write a story about a dragon', false, ['Story + Script Partner'], 'full'],
  ['tell me a bedtime story', false, ['Story + Script Partner'], 'full'],
  ['help me outline my novel', true, ['Story + Script Partner'], 'full'],
  ['write a movie script about a heist', false, ['Story + Script Partner'], 'full'],
  ['is the story in my novel believable?', true, ['Story + Script Partner'], 'full'],
  ['write a news story for my school paper', true, ['Research Partner', 'Story + Script Partner'], 'full'],
  ['Tell me a short story where you are a detective.', false, ['Story + Script Partner'], 'full'],
  ['Write a fake news story about a robot, for my novel.', true, ['Research Partner', 'Story + Script Partner'], 'full'],
  ['is the story about the dragon too long?', false, ['Story + Script Partner'], 'full'],
  ['evaluate my youtube strategy', false, ['Marketing + Social Partner'], 'full'],
  ['make a YouTube video about recursion', false, [], 'none'],
  ['plan my instagram content calendar', false, ['Marketing + Social Partner'], 'full'],
  ['write ad copy for my barbershop', false, ['Marketing + Social Partner'], 'full'],
  ['grow my YouTube channel', false, ['Marketing + Social Partner'], 'full'],
  ['open YouTube Studio and check my analytics', false, ['Marketing + Social Partner'], 'full'],
  ['what\'s trending on tiktok', false, ['Marketing + Social Partner'], 'full'],
  ['check my youtube video about cats', false, ['Marketing + Social Partner'], 'full'],
  ['open YouTube and read the latest on Slack', false, [], 'none'],
  ['how is NQ doing today', false, [], 'none'],
  ['what\'s moving in the stock market right now', true, ['Market Intelligence Partner', 'Research Partner'], 'full'],
];

test('genuine research, news, story, marketing and market requests keep their research, coworkers and prompt', async () => {
  assert.ok(GENUINE.length >= 30);
  for (const [message, research, roles, prompt] of GENUINE) {
    assert.deepEqual(await whatTurnGets(message), { research, roles, prompt }, message);
  }
});

// Measured 2026-10-19 on 923 owner sentences: these ordinary turns started live research or an Office
// coworker, and with it the full ~33k-character prompt, for nothing the owner asked.
test('the owner\'s own news, a reminder, an algorithm, opening YouTube or a story being checked start no research or coworker', async () => {
  for (const [message, research, roles, prompt] of [
    ['I have good news: my baby was born.', false, [], 'compact'],
    ['Make a reminder tomorrow at 8, not today', false, [], 'compact'],
    ['why does binary search on my sorted array in javascript return the wrong index', false, [], 'compact'],
    ['teach me recursion and then open youtube', false, [], 'compact'],
    ['Is the story about the new garage door code accurate?', false, [], 'compact'],
    // A real news question keeps its research and its Research Partner; only the Story partner goes.
    ['What was the biggest AI news story on October 15, 2026?', true, ['Research Partner'], 'full'],
  ]) {
    assert.deepEqual(await whatTurnGets(message), { research, roles, prompt }, message);
  }
});

test('the misfire exclusions only remove words; any other ask in the sentence still counts', () => {
  const research = (t) => inferTurnCapabilities(t).includes('web_research');
  for (const t of ['I have good news: my baby was born.', 'We\'ve got big news, we\'re moving to Denver', 'Big news, sir: we closed the deal',
    'Make a reminder tomorrow at 8, not today', 'set an alarm for tonight', 'start a timer right now',
    'why does binary search return the wrong index', 'is depth-first search faster than breadth-first search']) assert.equal(research(t), false, t);
  for (const t of ['Do you have news about the Fed?', 'any good news today?', 'I have good news, what is the latest on Nvidia?',
    'I have a question about the news today', 'remind me what the news said today', 'set a reminder to check the stock market today',
    'search for binary search tutorials', 'look up how binary search works', 'what\'s happening tonight']) assert.equal(research(t), true, t);

  for (const t of ['Is the story about the new garage door code accurate?', 'What was the biggest AI news story today?', 'was that story true?']) assert.equal(creativeWritingAsk(t), false, t);
  for (const t of ['write a news story for my school paper', 'Write a fake news story about a robot, for my novel.', 'is the story about the dragon too long?',
    'is the story in my novel believable?', 'tell me a bedtime story', 'write a movie script about a heist']) assert.equal(creativeWritingAsk(t), true, t);

  for (const t of ['teach me recursion and then open youtube', 'open YouTube', 'launch the YouTube app please']) assert.equal(marketingAsk(t), false, t);
  for (const t of ['open YouTube Studio and check my analytics', 'evaluate my youtube strategy', 'make a YouTube video about recursion',
    'open youtube and plan my instagram content calendar', 'grow my YouTube channel']) assert.equal(marketingAsk(t), true, t);
});
