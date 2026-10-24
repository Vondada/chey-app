// Receipt-backed answers through the real routes: "what trades did you execute?" from the journal and order
// receipts with no model call, and the phone's install report as the only install evidence.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { RECEIPTS_KEY } from './truth_layer.js';

const generated = new URL('./.truth_receipts_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (truth_receipts_chat tests are offline: ${new URL(String(input?.url || input)).host})`); };

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

async function owner({ saved = new Map(), model = () => 'I placed 12 trades this week on MNQ, all winners, for +$4,200.' } = {}) {
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: model(input) }; } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = counter.calls;
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before };
  };
  return { say, send, token, saved };
}

test('"What trades did you execute?" is answered from the journal and order receipts, never from the lying model', async () => {
  const che = await owner();
  const none = await che.say('What trades did you execute?');
  assert.equal(none.meta.source, 'che_trading_live');
  assert.equal(none.modelCalls, 0);
  assert.doesNotMatch(none.reply, /12 trades|4,200/);
  assert.match(none.reply, /Orders I actually sent in the last 7 days: none/);

  che.saved.set(RECEIPTS_KEY, [{ kind: 'paper_order_placed', key: 'alpaca_paper:o1', order_id: 'o1abcdefgh', account: 'paper', symbol: 'AAPL', side: 'buy', qty: 1, at: new Date().toISOString() }]);
  const some = await che.say('Did you place any trades today?');
  assert.equal(some.meta.source, 'che_trading_live');
  assert.equal(some.modelCalls, 0);
  assert.match(some.reply, /1 on Alpaca PAPER \(last: buy 1 AAPL, order o1abcdef\)/);
});

test('POST /api/device/installed writes one receipt per build for the owner only', async () => {
  const che = await owner();
  const guest = await che.send('/api/device/installed', { version: '1.4.1', build: '7' });
  assert.equal(guest.status, 401, 'an unpaired caller cannot claim an install');
  const bad = await che.send('/api/device/installed', { version: '', build: '7' }, che.token);
  assert.equal(bad.status, 400);
  const ok = await che.send('/api/device/installed', { version: '1.4.1025342820', build: '3956317271501', patch: '7' }, che.token);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.receipt.version, '1.4.1025342820');
  await che.send('/api/device/installed', { version: '1.4.1025342820', build: '3956317271501', patch: '7' }, che.token);
  const receipts = (che.saved.get(RECEIPTS_KEY) || []).filter((r) => r.kind === 'device_install');
  assert.equal(receipts.length, 1, 'the same build reported twice is one receipt');
  assert.equal(receipts[0].confirmed, true);
});
