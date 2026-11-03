// Run 25 (certification 41657004307): every Gemini 429 benched Gemini for an hour, so the 8B model wrote 102 of the 176
// quality-route answers. A per-minute limit now rests Gemini for the delay Google asks for; a daily quota still rests
// it for an hour. Offline: a fake fetch plays Gemini and a fake Workers AI binding plays Cloudflare.
import assert from 'node:assert/strict';
import test from 'node:test';
import { geminiQuotaRestMs, quotaHint, resetRouterForTests, routeText } from './ai_router.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const chat = (text) => json({ choices: [{ message: { content: text } }], usage: { total_tokens: 10 } });
const limited = (quotaId, delay) => json([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `You exceeded your current quota. Please retry in ${delay}.`, details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay.replace(/\.\d+/, '') },
] } }], 429);

test('the 429 body says how long to wait and whether the quota is daily', () => {
  assert.deepEqual(quotaHint({ error: { message: 'Please retry in 37.2s.' } }), { retryAfterMs: 37200, quotaDaily: false });
  assert.equal(quotaHint({ error: { details: [{ retryDelay: '20s' }] } }, 5000).retryAfterMs, 5000, 'a Retry-After header wins');
  assert.equal(geminiQuotaRestMs(quotaHint([{ error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: '37s' }] } }])), 37_000);
  assert.equal(geminiQuotaRestMs(quotaHint([{ error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '12s' }] } }])), 3_600_000);
  assert.equal(geminiQuotaRestMs(quotaHint({ error: { message: 'quota exceeded' } })), 3_600_000, 'no hint: an hour, as before');
  assert.equal(geminiQuotaRestMs({ retryAfterMs: 7_200_000 }), 15 * 60_000, 'capped at 15 minutes');
});

async function twoTurns(quotaId, { slowMs = 0, laterMs = 25_000 } = {}) {
  resetRouterForTests();
  const env = { GEMINI_API_KEY: 'test-key', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Cloudflare answer.' }) } };
  // Turn 1: every Gemini model answers 429 (each has its own limit). Turn 2: Gemini answers.
  let turn = 1;
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const fetcher = async (url) => {
    if (!String(url).includes('generativelanguage')) return json({ error: 'offline test' }, 503);
    if (turn === 1) { skew += slowMs; return limited(quotaId, '20.5s'); } // a slow 429: the clock moves while it is in flight
    return chat('Gemini answer.');
  };
  const ask = () => routeText(env, '@cf/meta/llama-3.1-8b-instruct-fp8', { che_route: 'quality', messages: [{ role: 'user', content: 'Why do retries need backoff?' }] }, fetcher);
  try {
    const first = await ask();
    turn = 2;
    skew = laterMs;
    return { first: first.engine, second: (await ask()).engine };
  } finally { Date.now = realNow; }
}

test('after a per-minute 429, the next quality answer 25 seconds later comes from Gemini again', async () => {
  const out = await twoTurns('GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
  assert.equal(out.first, 'cloudflare');
  assert.equal(out.second, 'gemini', 'the model that was limited answers again');
});

test('after a daily-quota 429, that Gemini model stays rested for the hour', async () => {
  const out = await twoTurns('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  assert.equal(out.first, 'cloudflare');
  // Each Gemini model has its own daily quota, so another one may answer; the limited one does not.
  assert.notEqual(out.second, 'gemini');
});

test('the rest starts when the 429 arrives, not when routing began (Codex review)', async () => {
  // The 429 took 15 seconds to arrive; 25 seconds after routing began is only 10 after it, inside the 20-second delay.
  const out = await twoTurns('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', { slowMs: 15_000 });
  assert.notEqual(out.second, 'gemini');
  const later = await twoTurns('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', { slowMs: 15_000, laterMs: 40_000 });
  assert.equal(later.second, 'gemini');
});
