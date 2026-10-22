// Security Core inside CHE: the product layer (security_core_che.js) through the real Worker routes and chat.
// Offline: every outbound fetch fails, and the tests assert none was attempted where none should be.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { emptyRegistry, promote, recordCheck, register, PROMOTION_CHECKS } from './capability_registry.js';
import { replyFromNdjson } from './brain_memory.js';
import { CHE_LOCKDOWN_MECHANISMS, CORE_KEY } from './security_core_che.js';
import { SECURITY_KEY } from './security_intelligence.js';

const fetched = [];
globalThis.fetch = async (input) => { fetched.push(String(input?.url || input)); throw new TypeError('fetch failed (offline test)'); };
const GH_TOKEN = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c';

const generated = new URL('./.security_core_che.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; } saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key), list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
}
async function owner() {
  const saved = new Map();
  const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'Understood, sir.' }) } };
  const state = new mod.CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456', device_name: 'Owner iPhone' })).json()).device_token;
  const settle = async () => { while (pending.length) await pending.shift(); };
  return {
    saved, token, send,
    say: async (message) => { const raw = await (await send('/api/chat', { message, history: [] }, token)).text(); await settle(); let done = {}; try { done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || {}; } catch (_) {} return { reply: replyFromNdjson(raw), done, raw }; },
    post: async (p, b) => { const r = await send(p, b, token, 'POST'); return { status: r.status, body: await r.json() }; },
    get: async (p) => (await send(p, null, token, 'GET')).json(),
  };
}

// Seeds Security Intelligence (#464) state as the existing loops would have written it.
function seedLegacy(che, events) {
  che.saved.set(SECURITY_KEY, { v: 1, events, sessions: {}, nonces: {}, counters: {}, quarantine: [], audit: [] });
}
const now = () => new Date().toISOString();

test('C1. the Security page state comes from the portable core: version, thirteen engines, configured name, no hard-coded brand', async () => {
  const che = await owner();
  const view = await che.get('/api/security/core');
  assert.match(view.core.version, /^\d+\.\d+\.\d+$/);
  assert.equal(view.core.engines.length, 13);
  assert.equal(view.core.product_name, 'Security');
  assert.ok(!JSON.stringify(view).includes('CHE Security'));
  assert.match(view.spoken, /no system can be made unhackable/);
});

test('C2. only the paired owner can read or change security; an unpaired caller is refused', async () => {
  const che = await owner();
  const r = await che.send('/api/security/core', null, '', 'GET');
  assert.ok([401, 403].includes(r.status));
  const p = await che.send('/api/security/core/lockdown/preview', {}, 'not-a-token', 'POST');
  assert.ok([401, 403].includes(p.status));
});

test('C3. chain of command: owner → CHE → Security → specialists, with Atlas separate', async () => {
  const che = await owner();
  const { agent } = await che.get('/api/security/core');
  assert.deepEqual(agent.chain.slice(0, 3).map((c) => c.name), ['Owner', 'CHE', 'Security']);
  assert.ok(agent.chain.slice(3).every((c) => c.reports_to === 'security'));
  assert.deepEqual(agent.separate.map((s) => s.name), ['Atlas']);
  assert.ok(['MONITORING', 'SECURED'].includes(agent.state.state));
});

test('C4. Security Intelligence events are mirrored into the core bus once, and a serious one opens an incident', async () => {
  const che = await owner();
  seedLegacy(che, [
    { id: 'e1', at: now(), type: 'unexpected_deploy', severity: 'high', classification: 'suspicious', evidence: 'The live Worker reports commit abc, which is not on main.', source: 'deploy' },
    { id: 'e2', at: now(), type: 'new_device', severity: 'info', classification: 'benign', evidence: '1 device paired.', source: 'devices' },
  ]);
  const a = await che.get('/api/security/core');
  const b = await che.get('/api/security/core');
  const store = che.saved.get(CORE_KEY);
  assert.equal(store.tenants.owner.events.filter((e) => e.event_id.startsWith('si_')).length, 2);
  assert.equal(b.defense.active.length, 1);
  assert.equal(a.defense.active[0].incident_id, b.defense.active[0].incident_id, 'no duplicate incident');
  assert.equal(b.agent.state.state, 'INVESTIGATING');
  assert.equal(b.protection.state, 'INVESTIGATING');
  assert.equal(b.sections.threats[0].event_type, 'che.unexpected_deploy');
});

test('C5. the Cyber World shows only real systems, each with a real status; the vault is on the phone and unknown to the server', async () => {
  const che = await owner();
  const { world } = await che.get('/api/security/core');
  const ids = world.nodes.map((n) => n.id);
  for (const id of ['worker', 'repository', 'capabilities', 'vault', 'egress']) assert.ok(ids.includes(id), id);
  assert.ok(world.nodes.some((n) => n.kind === 'device' && n.label === 'Owner iPhone'));
  assert.equal(world.simulated, false);
  assert.ok(world.nodes.every((n) => n.simulated === false));
  assert.equal(world.nodes.find((n) => n.id === 'vault').status, 'unknown');
  assert.equal(world.nodes.find((n) => n.id === 'repository').status, 'unknown', 'GitHub not configured');
  assert.deepEqual(world.pulses, [], 'no real open events, so nothing animates');
});

test('C6. a real open event pulses the node it concerns', async () => {
  const che = await owner();
  seedLegacy(che, [{ id: 'e9', at: now(), type: 'pairing_failures', severity: 'high', classification: 'suspicious', evidence: '12 wrong pairing codes.', source: 'pairing' }]);
  const { world } = await che.get('/api/security/core');
  assert.equal(world.pulses.length, 1);
  assert.equal(world.pulses[0].node, 'worker');
  assert.equal(world.nodes.find((n) => n.id === 'worker').status, 'alert');
});

test('C7. Run Security Check records the check and moves readiness; nothing outside CHE is contacted', async () => {
  const che = await owner();
  fetched.length = 0;
  const before = await che.get('/api/security/core');
  assert.equal(before.readiness.components.find((c) => c.id === 'recent_check').status, 'unknown');
  const r = await che.post('/api/security/core/check', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.readiness.components.find((c) => c.id === 'recent_check').status, 'pass');
  assert.ok(typeof r.body.readiness.score === 'number');
  assert.match(r.body.readiness.how, /not immunity/);
  assert.deepEqual(fetched, [], 'no GitHub token configured, so no request was made');
});

test('C8. drills are labelled SIMULATION, kept apart from real state, and never change the real agent state or animation', async () => {
  const che = await owner();
  const before = await che.get('/api/security/core');
  const r = await che.post('/api/security/core/simulate', { scenario: 'pairing_flood' });
  assert.equal(r.status, 200);
  assert.equal(r.body.label, 'SIMULATION');
  assert.equal(r.body.touched_real_systems, false);
  const after = await che.get('/api/security/core');
  assert.equal(after.simulations.recent[0].label, 'SIMULATION');
  assert.equal(after.defense.active.length, before.defense.active.length);
  assert.equal(after.agent.state.state, before.agent.state.state);
  assert.deepEqual(after.world.pulses, before.world.pulses);
  assert.equal((await che.post('/api/security/core/simulate', { scenario: 'real_attack' })).status, 404);
});

test('C9. incident replay works for a drill and for a real incident, and the owner can move a real incident forward only', async () => {
  const che = await owner();
  const sim = (await che.post('/api/security/core/simulate', { scenario: 'leaked_credential' })).body;
  const rs = await che.post('/api/security/core/replay', { incident_id: sim.incident.incident_id });
  assert.equal(rs.body.replay.label, 'SIMULATION');
  assert.equal(rs.body.replay.frames.at(-1).stage, 'RESOLVED');
  seedLegacy(che, [{ id: 'x1', at: now(), type: 'unknown_tokens', severity: 'high', classification: 'suspicious', evidence: '25 unknown tokens.', source: 'auth' }]);
  const inc = (await che.get('/api/security/core')).defense.active[0];
  assert.equal((await che.post('/api/security/core/incident/advance', { incident_id: inc.incident_id, stage: 'INVESTIGATING', note: 'Checked the auth counters.' })).status, 200);
  assert.equal((await che.post('/api/security/core/incident/advance', { incident_id: inc.incident_id, stage: 'TRIAGED', note: 'back' })).status, 409);
  const rr = await che.post('/api/security/core/replay', { incident_id: inc.incident_id });
  assert.equal(rr.body.replay.label, 'REAL EVENT');
  assert.deepEqual(rr.body.replay.frames.map((f) => f.stage), ['DETECTED', 'INVESTIGATING']);
});

test('C10. lockdown preview lists CHE\'s real lockdown effects and changes nothing', async () => {
  const che = await owner();
  const r = await che.post('/api/security/core/lockdown/preview', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.preview.effects.map((e) => e.id), CHE_LOCKDOWN_MECHANISMS.map((m) => m.id));
  assert.ok(r.body.preview.unaffected.some((k) => /vault/.test(k)));
  assert.equal(r.body.preview.requires_confirmation, true);
  assert.equal((await che.get('/api/security/core')).protection.locked_down, false);
});

test('C11. lockdown turns on only with the preview token and an explicit confirmation, and is verified', async () => {
  const che = await owner();
  const { preview } = (await che.post('/api/security/core/lockdown/preview', {})).body;
  assert.equal((await che.post('/api/security/core/lockdown/confirm', { token: preview.token })).body.reason, 'explicit_confirmation_required');
  assert.equal((await che.post('/api/security/core/lockdown/confirm', { token: 'nope', confirm: true })).body.reason, 'preview_token_mismatch');
  assert.equal((await che.get('/api/security/core')).protection.locked_down, false);
  const ok = await che.post('/api/security/core/lockdown/confirm', { token: preview.token, confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.locked, true);
  const view = await che.get('/api/security/core');
  assert.equal(view.protection.locked_down, true);
  assert.ok(view.sections.threats.length >= 0);
  assert.equal((await che.post('/api/security/core/lockdown/confirm', { token: preview.token, confirm: true })).body.reason, 'preview_token_mismatch', 'a preview is used once');
});

test('C12. "what\'s my security status" answers by voice from the core with no model call and no overclaim', async () => {
  const che = await owner();
  const r = await che.say("CHE, what's my security status?");
  assert.equal(r.done.source, 'che_security');
  assert.equal(r.done.model_calls, 0);
  assert.match(r.reply, /Security is (monitoring|secured)/i);
  assert.match(r.reply, /no system can be made unhackable/);
  assert.doesNotMatch(r.reply, /you are unhackable|100% secure/i);
});

test('C13. "preview lockdown" by voice lists the effects and leaves CHE running', async () => {
  const che = await owner();
  const r = await che.say('preview lockdown');
  assert.equal(r.done.source, 'che_security');
  assert.match(r.reply, /1\. Chat to remote AI engines pauses/);
  assert.match(r.reply, /Nothing has changed yet/);
  const next = await che.say('security status');
  assert.equal(next.done.source, 'che_security', 'not locked down: chat still runs');
  assert.match(next.reply, /Lockdown is off/);
});

test('C14. "run a security drill" is spoken as a SIMULATION and touches nothing real', async () => {
  const che = await owner();
  const r = await che.say('run a security drill for pairing');
  assert.equal(r.done.source, 'che_security');
  assert.match(r.reply, /^SIMULATION/);
  assert.match(r.reply, /touched no real system/);
  const view = await che.get('/api/security/core');
  assert.equal(view.defense.active.length, 0);
  assert.equal(view.simulations.recent.length, 1);
});

test('C15. readiness, team and incidents answer by voice from real state', async () => {
  const che = await owner();
  await che.post('/api/security/core/check', {});
  const r = await che.say("what's my security readiness");
  assert.match(r.reply, /Security readiness is \d+ out of 100/);
  assert.match(r.reply, /1\. Security check in the last day: pass/);
  const t = await che.say('who is on my security team');
  assert.match(t.reply, /you, then me, then Security/);
  assert.match(t.reply, /Atlas is separate/);
  const i = await che.say('show open incidents');
  assert.match(i.reply, /No open security incidents/);
});

test('C16. the security veto blocks capability promotion even when every check was recorded', () => {
  const reg = emptyRegistry();
  register(reg, { capability_id: 'wide_tool', permissions: { network: ['*'] } });
  for (const c of PROMOTION_CHECKS) recordCheck(reg, 'wide_tool', c, { ok: true, evidence: 'ok' });
  const r = promote(reg, 'wide_tool');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'security_veto');
  assert.match(r.vetoed.join(), /wildcard network/);
  assert.equal(reg.capabilities.wide_tool.status, 'REJECTED');
  register(reg, { capability_id: 'narrow_tool', permissions: { network: ['api.example.com'] } });
  for (const c of PROMOTION_CHECKS) recordCheck(reg, 'narrow_tool', c, { ok: true, evidence: 'ok' });
  assert.equal(promote(reg, 'narrow_tool').ok, true);
});

test('C17. access control lists CHE\'s agents, tools, apps and devices with least-privilege findings', async () => {
  const che = await owner();
  const reg = emptyRegistry();
  register(reg, { capability_id: 'wide_tool', permissions: { network: ['*'] } });
  che.saved.set('che:capabilities_v1', reg);
  che.saved.set('che:allowed_apps', ['spotify']);
  const { access } = await che.get('/api/security/core');
  const kinds = new Set(access.principals.map((p) => p.kind));
  for (const k of ['agent', 'tool', 'app', 'device']) assert.ok(kinds.has(k), k);
  assert.ok(access.principals.some((p) => p.id === 'app:spotify'));
  assert.ok(access.review.findings.some((f) => f.id === 'tool:wide_tool' && f.severity === 'high'));
});

test('C18. security knowledge: pasted secrets are redacted, private knowledge never promotes, shared knowledge loses device names', async () => {
  const che = await owner();
  const priv = (await che.post('/api/security/core/knowledge/capture', { title: 'Phone incident', body: `key ${GH_TOKEN}`, portability: 'CUSTOMER_PRIVATE' })).body.item;
  assert.ok(!JSON.stringify(che.saved.get(CORE_KEY)).includes(GH_TOKEN));
  assert.equal((await che.post('/api/security/core/knowledge/advance', { id: priv.knowledge_id, step: 'generalize', lesson: 'x' })).status, 409);
  const item = (await che.post('/api/security/core/knowledge/capture', { title: 'Pairing guesses', portability: 'SHARED_SECURITY' })).body.item;
  const id = item.knowledge_id;
  await che.post('/api/security/core/knowledge/advance', { id, step: 'generalize', lesson: 'Owner iPhone saw many wrong pairing codes; rate limits held.' });
  const stripped = (await che.post('/api/security/core/knowledge/advance', { id, step: 'strip' })).body.item;
  assert.doesNotMatch(stripped.general.lesson, /Owner iPhone/);
  assert.equal((await che.post('/api/security/core/knowledge/advance', { id, step: 'review' })).status, 200);
  assert.equal((await che.post('/api/security/core/knowledge/advance', { id, step: 'test', reviewer_note: 'Owner reviewed.' })).status, 200);
  const p = await che.post('/api/security/core/knowledge/advance', { id, step: 'promote' });
  assert.equal(p.body.item.stage, 'PROMOTED');
  const view = await che.get('/api/security/core');
  assert.equal(view.knowledge.shared.length, 1);
  assert.equal(view.knowledge.shared[0].tenant_id, undefined);
});

test('C19. security categories are registered in CHE\'s Brain (Knowledge Library)', async () => {
  const che = await owner();
  const { knowledge } = await che.get('/api/security/core');
  assert.ok(knowledge.registered_in.includes('knowledge_library'));
  assert.ok(knowledge.categories.some((c) => c.id === 'security_threats'));
});

test('C20. a password typed in chat never reaches the security state, events or the page', async () => {
  const che = await owner();
  await che.say('my password is Tr0ub4dor&3x please remember');
  await che.post('/api/security/core/check', {});
  const view = await che.get('/api/security/core');
  assert.ok(!JSON.stringify(view).includes('Tr0ub4dor&3x'));
  assert.ok(!JSON.stringify(che.saved.get(CORE_KEY) || {}).includes('Tr0ub4dor&3x'));
});

test('C21. policy refuses probing a system CHE does not own, and offensive actions', async () => {
  const che = await owner();
  assert.equal((await che.post('/api/security/core/policy/evaluate', { verb: 'port scan', target: 'stranger.example' })).body.allowed, false);
  assert.equal((await che.post('/api/security/core/policy/evaluate', { verb: 'hack back', target: 'worker' })).body.policy, 'defensive_only');
  assert.equal((await che.post('/api/security/core/policy/evaluate', { verb: 'scan', target: 'worker' })).body.allowed, true);
});

test('C22. "open security" by voice opens the SECURITY page and says its state', async () => {
  const che = await owner();
  const r = await che.say('open security');
  assert.equal(r.done.source, 'che_security');
  assert.equal(r.done.open_screen, 'security');
  assert.match(r.reply, /^Opening Security, sir\. Security is/);
});

test('C23. the core store stays under the storage value limit, and trimmed legacy events are not mirrored again', async () => {
  const { fitStore, syncLegacyEvents, loadCore } = await import('./security_core_che.js');
  const store = await loadCore({ get: async () => undefined });
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const sec = { events: Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, at: new Date(t0 + (200 - i) * 60_000).toISOString(), type: 'unknown_tokens', severity: 'medium', classification: 'suspicious', evidence: 'x'.repeat(280), source: 'auth' })) };
  syncLegacyEvents(store, sec);
  assert.ok(fitStore(store) <= 100_000);
  assert.equal(JSON.stringify(store).length <= 100_000, true);
  const before = store.tenants.owner.events.length;
  assert.equal(syncLegacyEvents(store, sec), 0, 'nothing older than the watermark comes back');
  assert.equal(store.tenants.owner.events.length, before);
  sec.events.unshift({ id: 'new', at: new Date(t0 + 300 * 60_000).toISOString(), type: 'new_device', severity: 'info', classification: 'benign', evidence: 'one', source: 'devices' });
  assert.equal(syncLegacyEvents(store, sec), 1);
});

test('C24. security knowledge and resolved incidents are filed in the Brain Ledger under Security, timestamped and without secrets', async () => {
  const { BrainLedger } = await import('./brain_ledger.js');
  const che = await owner();
  const priv = (await che.post('/api/security/core/knowledge/capture', { title: 'Phone incident', body: `key ${GH_TOKEN}`, portability: 'CUSTOMER_PRIVATE', category: 'security_incidents' })).body.item;
  await che.post('/api/security/core/knowledge/advance', { id: priv.knowledge_id, step: 'generalize', lesson: 'x' });
  const shared = (await che.post('/api/security/core/knowledge/capture', { title: 'Pairing guesses', portability: 'SHARED_SECURITY', category: 'security_threats' })).body.item;
  for (const [step, extra] of [['generalize', { lesson: 'Many wrong pairing codes mean guessing; rate limits held.' }], ['strip', {}], ['review', {}], ['test', { reviewer_note: 'ok' }], ['promote', {}]]) {
    await che.post('/api/security/core/knowledge/advance', { id: shared.knowledge_id, step, ...extra });
  }
  seedLegacy(che, [{ id: 'r1', at: now(), type: 'unknown_tokens', severity: 'high', classification: 'suspicious', evidence: '25 unknown tokens.', source: 'auth' }]);
  const inc = (await che.get('/api/security/core')).defense.active[0];
  await che.post('/api/security/core/incident/advance', { incident_id: inc.incident_id, stage: 'RESOLVED', note: 'Tokens rotated.' });
  const rows = await new BrainLedger({ get: async (k) => che.saved.get(k), put: async () => {} }).query({ category: 'Security', limit: 50 });
  const mine = rows.filter((r) => String(r.source_reference).startsWith('security_core:'));
  assert.ok(mine.length >= 4, `ledger rows: ${mine.length}`);
  assert.ok(mine.every((r) => r.category === 'Security' && r.timestamp));
  assert.ok(mine.some((r) => r.subcategory === 'Incidents' && /^Incident resolved/.test(r.title)));
  assert.ok(mine.some((r) => r.subcategory === 'Threat Detection' && r.event_type === 'KNOWLEDGE_UPDATED' && /Promoted/.test(r.summary)));
  assert.ok(mine.some((r) => r.event_type === 'REJECTED' && r.knowledge_scope === 'private'));
  assert.ok(!JSON.stringify(rows).includes(GH_TOKEN));
  const { knowledge } = await che.get('/api/security/core');
  assert.ok(knowledge.registered_in.includes('brain_ledger'));
});
