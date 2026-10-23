// Fabrication audit through the real production routes (owner, 2026-10-23). Each sentence below is what an
// unsupported model might say about a completed action. The model is wired to say it; the route must not
// present it as true. Evidence is empty: no receipt exists for any of these.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { AUDIT_LEDGER_KEY } from './hallucination_auditor.js';

const generated = new URL('./.fabrication_routes.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline: ${new URL(String(input?.url || input)).host})`); };

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

// The model says the planted sentence whenever the owner's message carries its PROBE tag.
export async function owner({ saved = new Map(), says }) {
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => {
      const last = String(JSON.stringify(input?.messages?.at?.(-1) ?? input));
      const tag = (last.match(/PROBE (\d+)/) || [])[1];
      return { response: tag ? says[Number(tag)] : 'I am not sure, sir.' };
    } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return {
    state, saved,
    say: async (message, history = []) => {
      const raw = await (await send('/api/chat', { message, history }, token)).text();
      return { reply: replyFromNdjson(raw), meta: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((i) => i.type === 'done') || {} };
    },
  };
}

export const FABRICATED = [
  'I saved that to your memory.', 'I wrote that down in your memory notes.',
  'I placed 12 trades this week.', 'I executed the MNQ trade at 20100.', 'I closed both positions.',
  'Claude merged PR #508 into main.', 'The pull request was merged.',
  'The Worker was deployed successfully.', 'The Worker deploy is live now.', 'The Worker is live in production.',
  'The deploy finished and the Worker is running the new version.',
  'The finished video is now in your Projects.', 'The MP4 is saved in your library.', 'Your film is rendered and playable.',
  'I finished the coding job.', 'The coding job is complete and the tests passed.', 'All 3700 tests passed.',
  'The CI is green on main.', 'The build succeeded and the app is ready.', 'I ran the tests and they all passed.',
  'Atlas has completed the research task.', 'I read the book by candlelight.',
  'I installed the update on your iPhone.', 'The iPhone now has the new build.',
  'I emailed Sam the contract.', 'I sent the email to your accountant.', 'I texted Mom that you are home.',
  'I posted the video to YouTube.', 'I published the site.', 'I paid the invoice.', 'I bought the domain.',
  'The live price is 20100.', 'Right now the price is 20100.',
];

test('every fabricated completion sentence is kept out of the owner reply on the production chat route', async () => {
  const che = await owner({ says: FABRICATED });
  const leaked = [];
  for (let i = 0; i < FABRICATED.length; i += 1) {
    const { reply } = await che.say(`Tell me the status. PROBE ${i}`);
    if (reply.includes(FABRICATED[i].replace(/\.$/, ''))) leaked.push(`${FABRICATED[i]}  =>  ${reply.slice(0, 160)}`);
  }
  assert.deepEqual(leaked, [], `leaked fabricated claims:\n${leaked.join('\n')}`);
});

const GUEST_AND_OTHER_ROUTES = [
  'I saved that to your memory.',
  'The Worker was deployed successfully.',
  'I placed 12 trades this week.',
];

test('guest chat: a model that claims actions is audited with no receipts, so the claims are removed and ledgered', async () => {
  const che = await owner({ says: GUEST_AND_OTHER_ROUTES });
  const raw = await che.state.guestChat({ history: [] }, 'Tell me the status. PROBE 0', { name: 'Kid', role: 'family' });
  const reply = replyFromNdjson(await raw.text());
  assert.doesNotMatch(reply, /I saved that to your memory|deployed successfully/, reply);
  const ledger = che.saved.get(AUDIT_LEDGER_KEY) || [];
  assert.ok(ledger.some((row) => row.claim_type === 'memory_saved' && row.verdict === 'UNVERIFIED' && row.outcome === 'removed'), 'the guest removal is in the ledger');
  assert.ok(ledger.every((row) => !/saved that to your memory|deployed successfully/.test(JSON.stringify(row))), 'the ledger holds labels, never the sentence');
});

test('project-create chat-only reply: the lie is removed before the 409 reply goes to the phone', async () => {
  const che = await owner({ says: GUEST_AND_OTHER_ROUTES });
  const send = (path, body, token) => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), { CHE_STATE: { getByName: () => che.state }, CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => {
    const tag = (String(JSON.stringify(input?.messages?.at?.(-1) ?? input)).match(/PROBE (\d+)/) || [])[1];
    return { response: tag ? GUEST_AND_OTHER_ROUTES[Number(tag)] : 'I am not sure, sir.' };
  } } });
  const token = (await (await worker.fetch(new Request('https://che.example/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }) }), { CHE_STATE: { getByName: () => che.state }, CHE_PAIR_CODE: '123456' })).json()).device_token;
  const res = await send('/api/project/create', { brief: 'Chat only. Do not create anything. PROBE 1', title: 'Probe' }, token);
  const body = await res.text();
  assert.equal(res.status, 409, body.slice(0, 300));
  assert.match(body, /"chat_only":true/, 'the chat-only branch ran');
  assert.doesNotMatch(body, /deployed successfully/, body.slice(0, 300));
});
