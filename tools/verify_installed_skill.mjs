// On-demand acceptance: actual CHE chat dispatch + real skills.sh/GitHub calls.
// --local uses ephemeral storage; otherwise use a paired device token supplied
// in the environment. Tokens and pairing data are never printed or saved.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { replyFromNdjson } from '../server/cloudflare/brain_memory.js';

let chat;
if (process.argv.includes('--local')) {
  const generated = new URL('../server/cloudflare/.skills.acceptance.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('../server/cloudflare/worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  ));
  let mod;
  try { mod = await import(generated.href); } finally { unlinkSync(generated); }
  const values = new Map();
  const env = { CHE_PAIR_CODE: 'local-acceptance-only', AI: { run: async () => { throw new Error('Skill execution must use the adapter, not a model'); } } };
  const state = new mod.CheState({ storage: { get: async (k) => values.get(k), put: async (k, v) => values.set(k, v), setAlarm: async () => {} } }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => mod.default.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const paired = await (await send('/api/pair', { code: env.CHE_PAIR_CODE })).json();
  assert.ok(paired.device_token, 'Ephemeral local pairing failed');
  chat = (message) => send('/api/chat', { message }, paired.device_token);
} else {
  const base = new URL(process.env.CHE_BASE_URL || 'https://chey-app.henryjavoni.workers.dev');
  assert.equal(base.protocol, 'https:');
  assert.equal(base.hostname, 'chey-app.henryjavoni.workers.dev', 'Do not send a device token to another host');
  assert.ok(process.env.CHE_DEVICE_TOKEN, 'Set CHE_DEVICE_TOKEN locally for a paired owner device; never paste it in chat');
  chat = (message) => fetch(new URL('/api/chat', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CHE_DEVICE_TOKEN}` },
    body: JSON.stringify({ message }), redirect: 'error', signal: AbortSignal.timeout(60000),
  });
}
const response = await chat('Find a skill for React testing');
assert.equal(response.status, 200, `CHE HTTP ${response.status}`);
const raw = await response.text();
const done = raw.trim().split('\n').map((line) => JSON.parse(line)).find((frame) => frame.type === 'done');
assert.equal(done?.source, 'che_installed_skills');
assert.equal(done?.ok, true);
assert.equal(done?.skill_receipt?.skill, 'find-skills');
assert.ok(done.skill_receipt.result_count > 0, 'Live index returned no candidates');
console.log(JSON.stringify({ scope: process.argv.includes('--local') ? 'local CHE Worker, real upstream APIs' : 'production CHE Worker', receipt: done.skill_receipt, reply: replyFromNdjson(raw) }, null, 2));
