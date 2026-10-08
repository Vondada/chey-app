import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHttpStatus,
  cooldownMsFor,
  makeEngineError,
  parseRetryAfter,
  sanitizeOwnerText,
} from './che_errors.js';
import { capacityMode, shouldHoldCapacity, noteProviderOutcome } from './provider_health_store.js';
import { buildBootstrapPacket, buildCapabilityRegistry, bootstrapPrompt, CHE_IDENTITY } from './che_maturity.js';
import { resetRouterForTests, routeText } from './ai_router.js';

test('classifies provider HTTP failures', () => {
  assert.equal(classifyHttpStatus(401), 'authentication_required');
  assert.equal(classifyHttpStatus(402), 'permanent_provider_failure');
  assert.equal(classifyHttpStatus(404, 'model not found'), 'model_retired');
  assert.equal(classifyHttpStatus(429), 'retryable_provider_error');
  assert.equal(classifyHttpStatus(500), 'retryable_provider_error');
  assert.equal(classifyHttpStatus(0, 'ENOSPC no space left on device'), 'retryable_provider_error');
});

test('honors Retry-After and does not leak raw dumps to the owner', () => {
  assert.equal(parseRetryAfter('12'), 12000);
  assert.equal(cooldownMsFor('authentication_required', 401), 3_600_000);
  const error = makeEngineError({
    category: 'temporary_cloud_unavailable',
    diagnostic: 'All AI engines failed (Groq 404 llama-3.3-70b-versatile | Pollinations ENOSPC)',
    configured: true,
  });
  assert.equal(error.owner_safe, true);
  assert.doesNotMatch(error.message, /All AI engines failed|ENOSPC|llama-3.3/);
  assert.match(sanitizeOwnerText('All AI engines failed (huge dump)'), /still working on that/i);
  assert.doesNotMatch(sanitizeOwnerText('All AI engines failed (huge dump)'), /engine|route|provider/i, 'the owner never hears about engines');
});

test('network outage wording never claims an on-phone fallback can finish cloud work', () => {
  const error = makeEngineError({ category: 'network_offline', diagnostic: 'fetch failed', configured: true });
  assert.match(error.message, /saved the job/i);
  assert.match(error.message, /resume it automatically/i);
  assert.doesNotMatch(error.message, /keep going with what I have on this phone/i);
});

test('internal provider failover is silent in owner chat', () => {
  assert.equal(sanitizeOwnerText("One moment, sir. I'm switching to a backup engine."), '');
  assert.equal(sanitizeOwnerText('Switching to another provider.'), '');
  assert.equal(sanitizeOwnerText('The backup model is Gemini.'), 'The backup model is Gemini.');
  assert.equal(
    sanitizeOwnerText('The backup provider is available, so we can continue.'),
    'The backup provider is available, so we can continue.',
  );
});

test('final owner replies can be sanitized without truncation', () => {
  const reply = 'A complete answer. '.repeat(20);
  assert.equal(sanitizeOwnerText(reply), reply.slice(0, 280));
  assert.equal(sanitizeOwnerText(reply, { truncate: false }), reply);
});

test('capacity reserve holds background work before owner chat', () => {
  // Owner policy: engines drain at 70% of their daily budget.
  assert.equal(capacityMode(69, 100), 'normal');
  assert.equal(capacityMode(70, 100), 'reserve');
  assert.equal(capacityMode(85, 100), 'reserve');
  assert.equal(shouldHoldCapacity({ used: 85, limit: 100, ownerChat: false }), true);
  assert.equal(shouldHoldCapacity({ used: 69, limit: 100, ownerChat: true }), false);
  assert.equal(shouldHoldCapacity({ used: 70, limit: 100, ownerChat: true }), true);
  assert.equal(shouldHoldCapacity({ used: 100, limit: 100, ownerChat: true, emergency: true }), true);
});

test('bootstrap packet keeps CHE identity across engines', () => {
  const capabilities = buildCapabilityRegistry({
    chat: { available: true },
    stripe: { available: false },
    local_inference: { available: true },
  });
  const packet = buildBootstrapPacket({
    request: 'What can you do?',
    project: { goal: 'Stabilize CHE', status: 'active' },
    health: { cloud: 'degraded', local_brain: 'ready' },
    capabilities,
    memory: ['CHE is pronounced Chay'],
    compact: true,
  });
  assert.equal(packet.identity.name, 'CHE');
  assert.equal(packet.identity.pronounced, 'Chay');
  assert.ok(packet.identity.office_agents.includes('Nova'));
  const prompt = bootstrapPrompt(packet, { small: true });
  assert.match(prompt, /Office Boss/);
  assert.match(prompt, /What can you do/);
  assert.equal(CHE_IDENTITY.office_role, 'Office Boss');
});

test('401 marks provider unavailable without retrying it on the next turn', async () => {
  resetRouterForTests();
  const storage = {
    raw: new Map(),
    async get(key) { return this.raw.get(key) ?? null; },
    async put(key, value) { this.raw.set(key, value); },
  };
  const hits = [];
  const fetcher = async (url) => {
    hits.push(new URL(url).hostname);
    if (url.includes('groq')) return new Response('{"error":{"message":"missing api key"}}', { status: 401 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Gemini ok' } }] }), { status: 200 });
  };
  const input = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 40, che_owner_chat: true };
  const first = await routeText({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm' }, 'm', input, fetcher, storage);
  assert.equal(first.response, 'Gemini ok');
  const groqHits = hits.filter((h) => h.includes('groq')).length;
  hits.length = 0;
  const second = await routeText({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm' }, 'm', input, fetcher, storage);
  assert.equal(second.response, 'Gemini ok');
  assert.equal(hits.filter((h) => h.includes('groq')).length, 0, '401 Groq stays in cooldown');
  assert.ok(groqHits >= 1);
});

test('500 short-circuits the sick engine and continues', async () => {
  resetRouterForTests();
  const hits = [];
  const fetcher = async (url) => {
    hits.push(new URL(url).hostname);
    if (url.includes('groq')) return new Response('{"error":"ENOSPC no space left on device"}', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'next engine' } }] }), { status: 200 });
  };
  const input = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 40 };
  const answer = await routeText({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm' }, 'm', input, fetcher);
  assert.equal(answer.response, 'next engine');
  assert.equal(hits.filter((h) => h.includes('groq')).length, 1);
});

test('retired Groq model 404 refreshes to a listed replacement', async () => {
  resetRouterForTests();
  const models = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
  const used = [];
  const fetcher = async (url, init) => {
    if (url.includes('/openai/v1/models') || url.endsWith('/v1/models') || url.includes('generativelanguage') && url.includes('/models')) {
      return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
    }
    const body = JSON.parse(init.body || '{}');
    used.push(body.model);
    if (body.model === 'llama-3.3-70b-versatile') {
      return new Response('{"error":{"message":"model not found"}}', { status: 404 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: `from ${body.model}` } }] }), { status: 200 });
  };
  const answer = await routeText(
    { GROQ_API_KEY: 'g', CHE_GROQ_FAST_MODEL: 'llama-3.3-70b-versatile' },
    'm',
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: 40 },
    fetcher,
  );
  assert.match(answer.response, /from /);
  assert.ok(!used.includes('llama-3.3-70b-versatile') || used.some((id) => models.includes(id)));
});

test('health store records last working model', () => {
  const health = {};
  noteProviderOutcome(health, 'groq', { ok: true, model: 'openai/gpt-oss-20b', latencyMs: 120 });
  assert.equal(health.groq.last_working_model, 'openai/gpt-oss-20b');
  noteProviderOutcome(health, 'groq', { ok: false, status: 429, category: 'retryable_provider_error' });
  assert.equal(health.groq.last_status, 429);
  assert.ok(health.groq.score < 1);
});
