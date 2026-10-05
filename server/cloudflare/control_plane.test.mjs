// Super-AI control plane: routing behavior proven through the real router.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resetRouterForTests, routeText } from './ai_router.js';

const store = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => m.set(k, structuredClone(v)), delete: async (k) => m.delete(k) };
};
const ok = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { total_tokens: 50 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const env = (extra = {}) => ({ CHE_DISABLE_KEYLESS_AI: '1', GROQ_API_KEY: 'g', ...extra });

test('an engine past 70% of its daily budget drains: another healthy engine answers first', async () => {
  resetRouterForTests();
  const now = Date.now();
  const storage = store({ 'ai_usage:cloudflare': { estimated_tokens: 750, reset_at: now + 3600_000 } });
  let cloudflareCalls = 0;
  const e = env({ CHE_CLOUDFLARE_DAILY_TOKEN_LIMIT: '1000', AI: { run: async () => { cloudflareCalls += 1; return { response: 'from cloudflare' }; } } });
  const out = await routeText(e, '@cf/meta/llama-3.1-8b-instruct-fp8', { messages: [{ role: 'user', content: 'hello there' }] }, async () => ok('from groq'), storage);
  assert.equal(out.engine, 'groq');
  assert.equal(cloudflareCalls, 0, 'the draining engine kept its reserve');
  // Below 70% the cheap default (Cloudflare first) is unchanged.
  resetRouterForTests();
  storage.m.set('ai_usage:cloudflare', { estimated_tokens: 100, reset_at: now + 3600_000 });
  const normal = await routeText(e, '@cf/meta/llama-3.1-8b-instruct-fp8', { messages: [{ role: 'user', content: 'hello there' }] }, async () => ok('from groq'), storage);
  assert.equal(normal.engine, 'cloudflare');
});

test('a sick engine is switched away from and the same request completes on another', async () => {
  resetRouterForTests();
  const storage = store();
  const e = env({ AI: { run: async () => { throw new Error('Workers AI 503 overloaded'); } } });
  const out = await routeText(e, '@cf/meta/llama-3.1-8b-instruct-fp8', { messages: [{ role: 'user', content: 'what time zones does Chicago use' }] }, async () => ok('Central Time.'), storage);
  assert.equal(out.engine, 'groq');
  assert.equal(out.response ?? out.choices?.[0]?.message?.content, 'Central Time.');
  const ledger = storage.m.get('che_reliability_ledger');
  assert.equal(ledger.rows[0].outcome, 'completed');
  assert.ok(ledger.rows[0].failovers >= 1, 'the failover is recorded');
});

import { cachedResearch, factKey, forgetKnowledge, knownAnswer, rememberOwnerFact, rememberKnowledge, recallKnowledge, VOLATILE_TTL_MS } from './knowledge_cache.js';
import { recordReliability, reliabilitySummary, speakReliability, sanitizeEvent } from './reliability_ledger.js';

test('verified owner facts answer with no engine; corrections, deletions and secrets are honoured', async () => {
  const s = store();
  await rememberOwnerFact(s, 'my Worker URL is https://old.example.dev', 1000);
  await rememberOwnerFact(s, 'my Worker URL is https://che.example.dev', 2000);
  const memories = ['my Worker URL is https://old.example.dev', 'my Worker URL is https://che.example.dev'];
  const known = await knownAnswer(s, "CHE, what's my Worker URL?", { now: 3000, memories });
  assert.equal(known.answer, 'Your worker url is https://che.example.dev, sir.');
  assert.equal(known.source, 'owner_memory');
  // Corrected some other way: the newest memory about it no longer says that value.
  assert.equal(await knownAnswer(s, "what's my worker url", { now: 3000, memories: [...memories, 'my worker url changed to https://new.example.dev'] }), null);
  // Deleted from memory: not spoken.
  assert.equal(await knownAnswer(s, "what's my worker url", { now: 3000, memories: [] }), null);
  // Forgotten on request.
  await forgetKnowledge(s, factKey('worker url'));
  assert.equal(await knownAnswer(s, "what's my worker url", { now: 3000, memories }), null);
  assert.equal(await rememberOwnerFact(s, 'my password is hunter2'), null);
  assert.equal(await rememberOwnerFact(s, 'my api key is sk-live-123'), null);
  assert.equal(JSON.stringify([...s.m.values()]).includes('hunter2'), false);
  assert.equal(await knownAnswer(s, 'what is the meaning of life', { memories }), null);
});

test('research is reused while valid, and stale volatile knowledge never overrides a fresh check', async () => {
  const s = store();
  let calls = 0;
  const research = (summary) => async () => { calls += 1; return { summary, sources: ['https://example.org/a'] }; };
  const t0 = Date.UTC(2026, 9, 5, 12);
  const first = await cachedResearch(s, 'Who designed the Eiffel Tower?', research('Gustave Eiffel\'s company.'), t0);
  assert.equal(first.summary, 'Gustave Eiffel\'s company.');
  const again = await cachedResearch(s, 'who designed the eiffel tower', research('should not be called'), t0 + 3600_000);
  assert.equal(again.cached, true);
  assert.equal(calls, 1, 'verified research is not repeated');
  // A volatile question: after 30 minutes the cache is stale and the
  // authoritative source is checked again; the fresh value replaces it.
  await cachedResearch(s, 'bitcoin price right now', research('BTC 60,000'), t0);
  const stale = await cachedResearch(s, 'bitcoin price right now', research('BTC 64,000'), t0 + VOLATILE_TTL_MS + 1);
  assert.equal(stale.summary, 'BTC 64,000');
  assert.equal((await recallKnowledge(s, 'research:bitcoin price right now', { now: t0 + VOLATILE_TTL_MS + 2 })).answer, 'BTC 64,000');
  // A failed fresh check never erases or fakes knowledge.
  const failed = await cachedResearch(s, 'weather today in Chicago', async () => ({ error: 'offline' }), t0);
  assert.equal(failed.error, 'offline');
  // Low-confidence entries are not trusted as answers.
  await rememberKnowledge(s, { key: 'research:x', answer: 'guess', confidence: 0.3 }, t0);
  assert.equal(await recallKnowledge(s, 'research:x', { now: t0 }), null);
});

test('the reliability ledger stores operations only: no prompts, replies, URLs or secrets', async () => {
  const s = store();
  await recordReliability(s, { kind: 'route', workflow: 'instant_answer', outcome: 'completed', engines: ['groq', 'https://evil.example/?k=sk-123'], est_tokens: 900, failovers: 1, prompt: 'my password is hunter2', reply: 'secret sk-live-abc', recovery_classes: ['provider_failover', 'sk-live-abc-1234567890123456789012345678901234567890'] });
  await recordReliability(s, { kind: 'retrieval', outcome: 'answered_from_memory', tokens_saved: 1500 });
  await recordReliability(s, { kind: 'job', outcome: 'completed' });
  await recordReliability(s, { kind: 'job', outcome: 'failed', owner_visible_failure: true });
  const raw = JSON.stringify(s.m.get('che_reliability_ledger'));
  for (const leak of ['hunter2', 'sk-live', 'sk-123', 'evil.example', 'prompt', 'reply']) assert.equal(raw.includes(leak), false, leak);
  const t = await reliabilitySummary(s);
  assert.equal(t.jobs_completed, 1);
  assert.equal(t.jobs_failed, 1);
  assert.equal(t.memory_answers, 1);
  assert.equal(t.tokens_saved, 1500);
  assert.equal(t.failovers, 1);
  assert.equal(t.recoveries, 1);
  assert.match(speakReliability(t), /1 jobs completed • 1 automatic recoveries • 1 provider failovers • 1 owner-visible failures • 1 answers from memory with no AI call • about 1,500 tokens saved/);
  assert.deepEqual(Object.keys(sanitizeEvent({ anything: 'x', prompt: 'p' })).sort(), ['at', 'engines', 'est_tokens', 'failovers', 'kind', 'latency_ms', 'outcome', 'owner_visible_failure', 'recovery_classes', 'retries', 'review', 'tests', 'tokens_saved', 'workflow']);
});

test('a route never stores the prompt in the ledger', async () => {
  resetRouterForTests();
  const s = store();
  await routeText(env({ AI: { run: async () => ({ response: 'ok' }) } }), '@cf/x', { messages: [{ role: 'user', content: 'my secret code word is pineapple-77' }] }, async () => ok('ok'), s);
  assert.equal(JSON.stringify(s.m.get('che_reliability_ledger')).includes('pineapple'), false);
});
