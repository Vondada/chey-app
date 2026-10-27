// The project manager's routes through the real Worker (worker.js → project_library.js): a paired owner device asks
// for the same Roblox game twice and gets one project, not two identical "tonight" cards; the library, state change
// and Roblox recovery answer through /api/projects/*; the deploy's counts-only audit opens only with its probe token.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

async function loadWorker() {
  const generated = new URL('./.project_routes.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  try { return await import(`${generated.href}?t=${Date.now()}`); } finally { try { unlinkSync(generated); } catch (_) {} }
}

test('one Roblox project per request, cards, state receipts, recovery and the counts-only deploy audit', async () => {
  const { default: worker, CheState } = await loadWorker();
  const saved = new Map();
  const storage = { get: async (k) => (saved.has(k) ? structuredClone(saved.get(k)) : undefined), put: async (k, v) => saved.set(k, structuredClone(v)),
    delete: async (k) => saved.delete(k), list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_VOICE_PROBE_TOKEN: 'e'.repeat(64) };
  const state = new CheState({ id: { name: 'owner' }, storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  try {
    const call = (path, { method = 'GET', body, token = '', headers = {} } = {}) => worker.fetch(new Request(`https://che.example${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
    const token = (await (await call('/api/pair', { method: 'POST', body: { code: '123456' } })).json()).device_token;
    assert.ok(token);
    const first = await (await call('/api/office/roblox', { method: 'POST', body: { task: 'obby with a sword shop', catalog: 'game' }, token })).json();
    const again = await (await call('/api/office/roblox', { method: 'POST', body: { task: 'obby with a sword shop', catalog: 'game' }, token })).json();
    const other = await (await call('/api/office/roblox', { method: 'POST', body: { task: 'tycoon with pets', catalog: 'game' }, token })).json();
    assert.equal(again.project_id, first.project_id, 'asking again continues the same project');
    assert.notEqual(other.project_id, first.project_id);

    const lib = await (await call('/api/projects/library', { token })).json();
    const roblox = lib.cards.filter((c) => c.category === 'roblox');
    assert.equal(roblox.length, 2);
    const obby = roblox.find((c) => c.id === first.project_id);
    assert.equal(obby.copies, 1);
    assert.equal(obby.tasks.length, first.jobs.length + again.jobs.length, 'both requests\' crew tasks are on the one card');
    assert.ok(obby.history.some((e) => e.event === 'Asked again: crew tasks added to this project'));

    const archived = await (await call('/api/projects/state', { method: 'POST', body: { id: other.project_id, state: 'archived' }, token })).json();
    assert.equal(archived.ok, true); assert.equal(archived.receipt.stored, true);
    const rec = await (await call('/api/projects/roblox', { token })).json();
    assert.equal(rec.projects.length, 2);
    assert.ok(rec.projects.every((p) => p.verified === false && p.scripts.length === 0), 'no crew has written Luau yet in this test');
    assert.match(rec.spoken, /None has been playtested in Roblox Studio/);
    assert.equal((await call(`/api/projects/roblox/place.rbxlx?id=${first.project_id}`, { token })).status, 404, 'no scripts, no place file');

    assert.equal((await call('/api/projects/library')).status, 401, 'no device, no projects');
    assert.equal((await call('/api/projects/probe/audit')).status, 404);
    assert.equal((await call('/api/projects/probe/audit', { headers: { 'X-CHE-Memory-Probe': 'f'.repeat(64) } })).status, 404);
    const audit = await (await call('/api/projects/probe/audit', { headers: { 'X-CHE-Memory-Probe': 'e'.repeat(64) } })).json();
    assert.equal(audit.roblox.cards, 2); assert.equal(audit.roblox.stored_copies, 2); assert.equal(audit.roblox.playtested, 0);
    assert.equal(audit.creative.archived, 1);
    assert.ok(!JSON.stringify(audit).includes('sword'), 'counts only: no request text in the public deploy log');
  } finally { globalThis.fetch = original; }
});
