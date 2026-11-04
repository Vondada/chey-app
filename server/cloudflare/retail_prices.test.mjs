// Shop price lookups (retail_prices.js). Certification run 24 (41491194768), ter-32: "Look up the price of coffee in
// three shops and compare them." got three invented chain prices from the model. No tool reads shop prices, so the
// reply says so and quotes no figure; market prices and other questions are not taken.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { retailPriceReply, retailPriceRequest, retailPriceTurn } from './retail_prices.js';

const TER32 = 'Look up the price of coffee in three shops and compare them.';

test('a shop price lookup is recognised, with its item; market prices and other questions are not', () => {
  assert.deepEqual(retailPriceRequest(TER32), { item: 'coffee' });
  assert.deepEqual(retailPriceRequest('Compare milk prices at three supermarkets near me.'), { item: 'milk' });
  assert.deepEqual(retailPriceRequest('How much is a latte at a few local cafes?'), { item: '' });
  for (const q of [
    'What is the price of MNQ right now?',
    'Compare the price of SPY and QQQ.',
    'Why is coffee more expensive in shops than at home?',
    "Don't look up the price of coffee in three shops.",
    'Add coffee to my shopping list.',
    'Tell me a story about three shops.',
    // Codex on #928: an explicit research ask goes to the research route, which can cite published prices.
    'Research and compare current coffee prices at three shops in Seattle: Starbucks, Dunkin and Peets. Use web sources.',
    'Search the web for the price of coffee at three cafes in Seattle.',
  ]) assert.equal(retailPriceRequest(q), null, q);
});

test('Codex on #928: a turn with an attachment (menus) goes on to the attachment reader', () => {
  assert.equal(retailPriceTurn('Compare coffee prices at three shops using the attached menus.', { attachment: { type: 'image/jpeg', data: 'x' } }), null);
  assert.ok(retailPriceTurn(TER32, {}));
});

test('the reply names the item, says nothing was looked up, and contains no price figure', () => {
  const text = retailPriceReply({ item: 'coffee' });
  assert.match(text, /^I can't look up coffee prices at shops, sir/);
  assert.match(text, /I looked nothing up and I won't guess figures/);
  assert.doesNotMatch(text, /\$\s?\d|\d+\.\d{2}|\b\d+\s*(?:cents?|dollars?)\b/i);
});

// Through the real /api/chat, with a model that would invent prices if it were asked.
const generated = new URL('./.retail_prices.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

function storageMap() {
  const saved = new Map();
  let alarm = null;
  return {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}

test('/api/chat: ter-32 gets the honest answer, the model is never asked, and no price appears', async () => {
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls += 1; return { response: 'Starbucks charges $3.45, Dunkin $2.89 and Peet\'s $3.25.' }; } } };
  const state = new CheState({ storage: storageMap(), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const out = (await (await post('/api/chat', { message: TER32, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const text = out.filter((f) => f.type === 'delta').map((f) => f.delta).join('');
  assert.match(text, /^I can't look up coffee prices at shops, sir/);
  assert.doesNotMatch(text, /\$\s?\d/);
  assert.equal(out.find((f) => f.type === 'done').source, 'che_retail_prices');
  assert.equal(modelCalls, 0);
});
