// Capability Engine (owner, 2026-10-22): knowledge becomes capability only through a tested, verified implementation.
// 12 knowledge tests, 15 internal-capability tests, the capability-learning test, and the owner's spoken routes.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  populate, retrieve, extract, deriveProgram, runTool, acquire, useTool, rollbackTool, decideExecution, projectContext,
  learnFromOutcome, speakLearned, isStale, KnowledgeItems, defaultPolicy, policyIntent, applyPolicy, capabilityIdFor,
  capabilityIntent, inScope,
} from './capability_engine.js';
import { EXECUTION, PROMOTION_CHECKS, emptyRegistry, loadRegistry, register, recordCheck, promote, serving, speakCapability } from './capability_registry.js';
import { KnowledgeLibrary } from './knowledge_library.js';
import { replyFromNdjson } from './brain_memory.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

async function storage() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const kv = new Map();
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined),
    put: async (k, v) => { kv.set(k, structuredClone(v)); },
    delete: async (k) => kv.delete(k),
    kv,
  };
}

const CSV_DOC = `CSV files store tables as plain text. A CSV file is a table where each line is a row.
The first row is the header in most CSV files.
To convert CSV to JSON:
1. Split the text into lines.
2. Split each line by comma.
3. Trim each field.
4. The first row is the header.
5. Convert numeric values.
6. Output as JSON.
Example input: name,age\\nAda,36
Expected output: [{"name":"Ada","age":36}]
Only works for comma-separated files without quoted commas.
Fails if a row has more fields than the header.
JSON is a text format for objects and arrays. JSON is used by most web APIs.`;

const CAPTION_DOC = `Captions are short timed lines of text shown over a video.
To time captions:
1. Split the text into words.
2. Group the words into chunks of 3.
3. Time each chunk at 2 words per second.
Example input: one two three four
Expected output: [{"start":0,"end":1.5,"text":"one two three"},{"start":1.5,"end":2.5,"text":"four"}]
Captions are easier to read in short chunks.`;

const OCEAN_DOC = `Photorealistic water needs physically based light transport.
To render a photorealistic ocean:
1. Trace rays through the water surface.
2. Apply caustics from the refracted light.
Ray tracing is expensive and requires a GPU for real-time use.`;

const learnCsv = (s, extra = {}) => populate(s, { title: 'CSV primer', text: CSV_DOC, license: 'owner', ...extra });

// ─── Knowledge ───────────────────────────────────────────────────────────────

test('K1. a permitted source is indexed: the Knowledge Library keeps the source; facts, concepts and procedures are extracted', async () => {
  const s = await storage();
  const out = learnCsv(s);
  const ref = new KnowledgeLibrary(s).get(out.source);
  assert.equal(ref.access, 'indexed');
  const items = new KnowledgeItems(s).all();
  assert.ok(items.some((i) => i.layer === 'indexed' && i.kind === 'fact'));
  assert.ok(items.some((i) => i.layer === 'indexed' && i.kind === 'concept' && i.title === 'csv'));
  assert.equal(items.filter((i) => i.layer === 'procedure').length, 1);
  assert.match(populate(s, { title: 'Paid book', text: CSV_DOC, license: 'all rights reserved' }).error, /Only owner, public-domain or openly licensed/);
});

test('K2. indexed knowledge is retrievable later, by meaning words, without re-teaching', async () => {
  const s = await storage();
  learnCsv(s);
  const k = retrieve(s, emptyRegistry(), 'how do I turn a csv table into json?');
  assert.equal(k.procedures[0].item.title, 'convert CSV to JSON');
  assert.ok(k.facts.length > 0);
  assert.equal(k.domain, 'data');
  assert.equal(k.sufficient, true);
});

test('K3. knowledge is connected to related concepts', async () => {
  const s = await storage();
  learnCsv(s);
  const items = new KnowledgeItems(s).all();
  const proc = items.find((i) => i.layer === 'procedure');
  assert.ok(proc.links.length > 0);
  const linked = items.filter((i) => proc.links.includes(i.id));
  assert.ok(linked.some((i) => /csv|json/i.test(i.body)));
  assert.ok(linked.every((i) => i.links.includes(proc.id)), 'links go both ways');
});

test('K4. a procedure with applicability is derived: steps, inputs/outputs, limitations, failure modes, provenance', async () => {
  const s = await storage();
  learnCsv(s);
  const proc = new KnowledgeItems(s).all({ layer: 'procedure' })[0];
  assert.equal(proc.steps.length, 6);
  assert.deepEqual(proc.applicability.inputs, ['csv text']);
  assert.deepEqual(proc.applicability.outputs, ['json']);
  assert.match(proc.applicability.limitations[0], /without quoted commas/);
  assert.match(proc.applicability.failure_modes[0], /more fields than the header/);
  assert.equal(proc.provenance.title, 'CSV primer');
  assert.equal(proc.status, 'procedure', 'a procedure is not a capability');
});

test('K5. a project automatically retrieves the relevant knowledge from the brain', async () => {
  const s = await storage();
  learnCsv(s);
  populate(s, { title: 'Captions', text: CAPTION_DOC, license: 'owner' });
  const ctx = projectContext(s, emptyRegistry(), { id: 'p1', title: 'Client spreadsheet export', goal: 'convert the CSV export to JSON' });
  assert.equal(ctx.procedures[0].item.title, 'convert CSV to JSON');
  assert.ok(!ctx.procedures.some((p) => /caption/i.test(p.item.title)), 'only what applies');
});

test('K6. a verified project result populates the brain and a later project retrieves it; unverified results are not stored', async () => {
  const s = await storage();
  assert.equal(learnFromOutcome(s, { verified: false, method: 'guess' }).ok, false);
  const r = learnFromOutcome(s, { verified: true, project_id: 'p1', title: 'Sunset palette', method: 'Sunset palette: warm orange sky gradient over teal water worked for beach promos', files: ['cover.png'] }, { policy: { ...defaultPolicy(), memory: { ...defaultPolicy().memory, method_only: true } } });
  assert.equal(r.ok, true);
  assert.ok(!r.item.body.includes('cover.png'), '"remember the method, not the files"');
  const later = retrieve(s, emptyRegistry(), 'sunset palette for a beach promo', { project_id: 'p2' });
  assert.equal(later.outcomes[0].item.title, 'Sunset palette');
});

test('K7. private project and client knowledge stays in its scope', async () => {
  const s = await storage();
  populate(s, { title: 'Acme notes', text: 'The Acme launch uses a blue palette. The Acme launch is on Friday.', license: 'owner', scope: 'project-only', project_id: 'acme' });
  populate(s, { title: 'Client B', text: 'Client B pricing is confidential and uses tier three rates.', license: 'owner', client_id: 'client-b' });
  assert.ok(retrieve(s, emptyRegistry(), 'acme launch palette', { project_id: 'acme' }).facts.length > 0);
  assert.equal(retrieve(s, emptyRegistry(), 'acme launch palette', { project_id: 'other' }).facts.length, 0);
  assert.equal(retrieve(s, emptyRegistry(), 'client b pricing', {}).facts.length, 0);
  assert.equal(inScope({ scope: 'security-restricted' }, {}), false);
});

test('K8. conflicting knowledge is marked and both versions are kept; nothing is silently overwritten', async () => {
  const s = await storage();
  populate(s, { title: 'Old manual', text: 'The default render port is 8080 on every install.', license: 'owner' });
  const out = populate(s, { title: 'New blog', text: 'The default render port is 9090 since version two.', license: 'cc_by' });
  assert.equal(out.conflicts.length, 1);
  const facts = new KnowledgeItems(s).all({ layer: 'indexed' }).filter((i) => /render port/.test(i.body));
  assert.equal(facts.length, 2);
  assert.ok(facts.every((f) => f.conflicts.length === 1));
  assert.ok(retrieve(s, emptyRegistry(), 'default render port').conflicts.length >= 1);
});

test('K9. outdated knowledge is identified', async () => {
  const s = await storage();
  populate(s, { title: 'Old', text: 'The legacy export uses tab separated values everywhere.', license: 'owner' }, { now: '2025-01-01T00:00:00Z' });
  const k = retrieve(s, emptyRegistry(), 'legacy export tab separated', {}, Date.parse('2026-10-22'));
  assert.ok(k.stale.length > 0);
  assert.equal(isStale({ freshness: { last_reviewed: '2026-10-01' } }, Date.parse('2026-10-22')), false);
});

test('K10. CHE distinguishes indexed information from a verified capability', async () => {
  const s = await storage();
  learnCsv(s);
  const before = speakLearned(retrieve(s, await loadRegistry(s), 'csv json'));
  assert.match(before, /Indexed: \d+ facts/);
  assert.match(before, /Procedures I can retrieve: convert CSV to JSON/);
  assert.match(before, /None of that is a verified capability yet/);
  await acquire(s, 'convert CSV to JSON');
  const after = speakLearned(retrieve(s, await loadRegistry(s), 'csv json'));
  assert.match(after, /Verified capabilities: Convert CSV to JSON/);
});

test('K11 + K12. CHE says which knowledge informed a result, and reuses a learned method in a later project', async () => {
  const s = await storage();
  learnCsv(s);
  const built = await acquire(s, 'convert CSV to JSON', { ctx: { project_id: 'p1' } });
  assert.equal(built.ok, true);
  const used = await s.get('che:last_knowledge_used');
  assert.equal(used.sources[0].title, 'CSV primer');
  const again = await acquire(s, 'convert CSV to JSON', { ctx: { project_id: 'p2' } });
  assert.equal(again.reused, true, 'not re-taught, not rebuilt');
  const run = await useTool(s, built.capability.capability_id, 'city,pop\nOslo,700000');
  assert.equal(run.output, '[{"city":"Oslo","pop":700000}]');
});

// ─── Internal capability ─────────────────────────────────────────────────────

test('C1. a missing capability is detected, and nothing is claimed', async () => {
  const s = await storage();
  const out = await acquire(s, 'convert CSV to JSON');
  assert.deepEqual([out.ok, out.gap], [false, true]);
  assert.match(out.said, /no indexed procedure .* I have not built anything/);
  assert.equal(serving(await loadRegistry(s), capabilityIdFor('convert CSV to JSON')), null);
});

test('C2. internal implementation feasibility is evaluated: steps CHE cannot implement need a reviewed code change', async () => {
  const s = await storage();
  populate(s, { title: 'Ocean rendering', text: OCEAN_DOC, license: 'owner' });
  const out = await acquire(s, 'render a photorealistic ocean');
  assert.equal(out.needs_code_change, true);
  assert.ok(out.unmapped.some((u) => /Trace rays/.test(u)));
  assert.match(out.said, /reviewed code change, not something I can claim now/);
  assert.equal(deriveProgram(['Split the text into lines.', 'Output as JSON.']).feasible, true);
});

test('C3–C9. a candidate internal tool is created, sandboxed, functionally and security tested, produces real verified output and is registered', async () => {
  const s = await storage();
  learnCsv(s);
  const out = await acquire(s, 'convert CSV to JSON', { sample: 'a,b\n1,x' });
  assert.equal(out.ok, true);
  const cap = (await loadRegistry(s)).capabilities[out.capability.capability_id];
  assert.ok(cap.history.some((h) => h.event === 'registered') && cap.history.some((h) => h.event === 'promoted'), 'C3 candidate → promoted');
  for (const c of PROMOTION_CHECKS) assert.equal(cap.checks[c].ok, true, c);
  assert.match(cap.checks.functional.evidence, /1\/1 examples reproduced/, 'C5');
  assert.match(cap.checks.security.evidence, /no network, storage or credential access/, 'C6');
  assert.match(cap.checks.output.evidence, /real output \[\{"a":1,"b":"x"\}\]/, 'C7/C8');
  assert.equal(cap.status, 'VERIFIED', 'C9');
  assert.equal(cap.execution, EXECUTION.INTERNAL);
  assert.deepEqual(cap.permissions.network, []);
  // C4: the sandbox only runs pure primitives within its limits.
  assert.match(runTool([['fetch', 'https://x']], 'a').error, /unknown primitive/);
  assert.match(runTool([['lines']], 'x'.repeat(300_000)).error, /input too large/);
  assert.match(runTool(Array(41).fill(['trim']), 'a').error, /too many steps/);
  assert.match(runTool([['constructor']], 'a').error, /unknown primitive/, 'no prototype access');
});

test('C10. a verified capability is reused later and becomes AVAILABLE through real use', async () => {
  const s = await storage();
  populate(s, { title: 'Caption timing', text: CAPTION_DOC, license: 'cc_by' });
  const built = await acquire(s, 'time captions');
  assert.equal(built.ok, true, built.said);
  const r = await useTool(s, built.capability.capability_id, 'hello there my good friend');
  assert.deepEqual(r.output, [{ start: 0, end: 1.5, text: 'hello there my' }, { start: 1.5, end: 2.5, text: 'good friend' }]);
  const cap = (await loadRegistry(s)).capabilities[built.capability.capability_id];
  assert.equal(cap.status, 'AVAILABLE');
  assert.equal(cap.runs, 1);
  assert.ok(new KnowledgeItems(s).all({ layer: 'experience' }).some((i) => i.status === 'verified'), 'the run is experience');
});

test('C11. a failed candidate is rejected and never presented or run as available', async () => {
  const s = await storage();
  populate(s, { title: 'Wrong doc', text: CSV_DOC.replace('"age":36', '"age":"thirty-six"'), license: 'owner' });
  const out = await acquire(s, 'convert CSV to JSON');
  assert.equal(out.rejected, true);
  assert.deepEqual(out.failed, ['functional']);
  assert.match(out.said, /rejected and I cannot claim it/);
  const reg = await loadRegistry(s);
  assert.equal(reg.capabilities[out.capability.capability_id].status, 'REJECTED');
  assert.equal(serving(reg, out.capability.capability_id), null);
  assert.match((await useTool(s, out.capability.capability_id, 'a,b\n1,2')).said, /do not have a verified tool/);
  assert.match(speakCapability(reg.capabilities[out.capability.capability_id]), /rejected, not a working capability/);
});

test('C12 + C15. internal-only mode blocks external fallbacks; external dependencies need the owner\'s approval', () => {
  const r = emptyRegistry();
  const pass = (id) => { for (const c of PROMOTION_CHECKS) recordCheck(r, id, c, { ok: true }); promote(r, id); };
  register(r, { id: 'video.text_to_video', name: 'Text to video', description: 'generate video from text', execution: EXECUTION.EXTERNAL_PAID }); pass('video.text_to_video');
  register(r, { id: 'video.render_owner', name: 'Render video', description: 'render video timeline', execution: EXECUTION.OWNER_COMPUTE }); pass('video.render_owner');
  const policy = applyPolicy(defaultPolicy(), policyIntent('Use only your internal capabilities'));
  const internal = decideExecution(r, 'generate a video', policy);
  assert.equal(internal.capability.capability_id, 'video.render_owner', 'internal/owner compute first');
  register(r, { id: 'only.ext', name: 'Clone voice', description: 'clone a voice', execution: EXECUTION.EXTERNAL_FREE }); pass('only.ext');
  const blocked = decideExecution(r, 'clone a voice', policy);
  assert.equal(blocked.ok, false);
  assert.match(blocked.said, /internal-only mode is on/);
  const approval = decideExecution(r, 'clone a voice', defaultPolicy());
  assert.equal(approval.blocked[0].needs_approval, true, 'C15');
  assert.equal(decideExecution(r, 'clone a voice', { ...defaultPolicy(), approved_external: ['only.ext'] }).ok, true);
});

test('C13. capability limitations are reported accurately', async () => {
  const s = await storage();
  learnCsv(s);
  const out = await acquire(s, 'convert CSV to JSON');
  assert.match(speakCapability(out.capability), /Limits: Only works for comma-separated files without quoted commas/);
});

test('C14. an improved candidate is tested against the old examples, promoted, and can be rolled back', async () => {
  const s = await storage();
  learnCsv(s);
  const v1 = await acquire(s, 'convert CSV to JSON');
  const id = v1.capability.capability_id;
  // A failing improvement leaves version 1 serving.
  const badDoc = populate(s, { title: 'Bad update', text: CSV_DOC.replace('5. Convert numeric values.\n', '').replace('To convert CSV to JSON:', 'To convert CSV to JSON v2:'), license: 'owner' });
  const bad = await acquire(s, 'convert CSV to JSON', { rebuild: true, procedure: badDoc.procedures[0] });
  assert.equal(bad.ok, false);
  assert.equal(serving(await loadRegistry(s), id).version, 1);
  assert.equal((await useTool(s, id, 'n\n5')).output, '[{"n":5}]', 'version 1 still runs');
  // A passing rebuild becomes version 3 (2 was rejected), then rolls back to the last verified one.
  const good = await acquire(s, 'convert CSV to JSON', { rebuild: true });
  assert.equal(good.ok, true, good.said);
  assert.equal(serving(await loadRegistry(s), id).version, 3);
  assert.equal((await rollbackTool(s, id)).ok, true);
  assert.equal(serving(await loadRegistry(s), id).version, 1);
  assert.equal((await useTool(s, id, 'n\n7')).output, '[{"n":7}]');
});

test('capability learning, end to end: gap → learn → feasibility → build → sandbox → verify → register → reuse', async () => {
  const s = await storage();
  const gap = await acquire(s, 'time captions');
  assert.equal(gap.gap, true);
  populate(s, { title: 'Caption timing', text: CAPTION_DOC, license: 'owner' });
  const built = await acquire(s, 'time captions');
  assert.equal(built.ok, true);
  assert.match(built.said, /Built and verified an internal tool: Time captions\..* no external service or key/);
  const reused = await acquire(s, 'time captions');
  assert.equal(reused.reused, true);
  assert.equal((await useTool(s, built.capability.capability_id, 'a b c d e f')).output.length, 2);
});

test('the owner\'s policies are read deterministically and ordinary sentences are not', () => {
  for (const [words, check] of [
    ['Use only your internal capabilities', (p) => p.set.internal_only === true],
    ['Do not call any external API', (p) => p.set.no_external_api === true],
    ['Do not use paid APIs', (p) => p.set.no_paid === true],
    ['Do not send this project outside CHE', (p) => p.set.no_export_projects[0] === '*'],
    ['Remember the method, not the private files', (p) => p.memory.method_only === true],
    ['Keep this knowledge inside this project', (p) => p.memory.project_scope_default === true],
    ['Require my approval before installing external code', (p) => p.set.require_approval_external_code === true],
    ['turn off internal-only mode', (p) => p.set.internal_only === false],
  ]) assert.ok(check(policyIntent(words)), words);
  for (const words of ['What is an API?', 'internal memo for the team', 'use my internal template']) assert.equal(policyIntent(words), null, words);
  assert.equal(capabilityIntent('CHE, what can you actually do?').action, 'capabilities');
  assert.equal(capabilityIntent('what did you learn about csv files').topic, 'csv files');
  assert.equal(capabilityIntent('build an internal tool to convert csv to json').operation, 'convert csv to json');
  assert.equal(extract('To do it:\n1. Split the text into lines.').procedures[0].steps.length, 1);
});

// ─── Through the Worker ──────────────────────────────────────────────────────

const generated = new URL('./.capability_engine.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function owner() {
  const st = await storage();
  const pending = [];
  let modelCalls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { modelCalls++; return { response: 'A model answer.' }; } } };
  const ctx = { storage: { ...st, list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null }, waitUntil: (p) => pending.push(p) };
  const state = new mod.CheState(ctx, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return {
    st, token, send, calls: () => modelCalls,
    say: async (message) => {
      const before = modelCalls;
      const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
      while (pending.length) await pending.shift();
      let done = {};
      try { done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || JSON.parse(raw); } catch (_) { done = {}; }
      return { reply: replyFromNdjson(raw) || done.reply || '', route: done.source, done, model_calls: modelCalls - before };
    },
    post: async (p, b) => { const r = await send(p, b, token); return { status: r.status, body: await r.json() }; },
    get: async (p) => (await send(p, null, token, 'GET')).json(),
  };
}

test('Worker: learn → "what did you learn" → build by voice → "what can you actually do" → "which knowledge informed that", all without a model call', async () => {
  const che = await owner();
  assert.equal((await che.post('/api/capability-engine/learn', { title: 'CSV primer', text: CSV_DOC, license: 'owner' })).status, 200);
  const learned = await che.say('What did you learn about CSV to JSON?');
  assert.equal(learned.route, 'che_capability_engine');
  assert.match(learned.reply, /None of that is a verified capability yet/);
  assert.equal((await che.say('What can you actually do?')).reply, 'I have no verified internal capabilities registered yet. Anything I can only describe is not something I claim to do.');
  const built = await che.say('Build an internal tool to convert CSV to JSON');
  assert.match(built.reply, /Built and verified an internal tool: Convert CSV to JSON/);
  assert.match((await che.say('What can you actually do?')).reply, /1\. Convert CSV to JSON, inside CHE, verified, not used yet/);
  assert.match((await che.say('Which knowledge informed that?')).reply, /from: CSV primer/);
  const run = await che.post('/api/capability-engine/use', { id: built.done.capability_id, input: 'x,y\n1,2' });
  assert.equal(run.body.output, '[{"x":1,"y":2}]');
  const view = await che.get('/api/capability-engine');
  assert.equal(view.capabilities[0].status, 'AVAILABLE');
  assert.ok(view.knowledge.procedure >= 1 && view.knowledge.indexed >= 1);
  assert.equal(view.knowledge_used.capability, built.done.capability_id);
  for (const t of [learned, built]) assert.equal(t.model_calls, 0);
  assert.notEqual((await che.send('/api/capability-engine', null, '', 'GET')).status, 200, 'owner only');
});

test('Worker: internal-only mode is enforced at the model path and the paid picture engines, and is said honestly', async () => {
  const che = await owner();
  const on = await che.say('Use only your internal capabilities');
  assert.match(on.reply, /Internal-only mode is on/);
  const snap = await che.st.get('ai_routing');
  assert.deepEqual([snap.policy.internal_only, snap.policy.local_only], [true, true]);
  // The model path may not leave the owner's own hardware: with no local model, nothing external answers.
  const essay = await che.say('Write me a short essay about the ocean');
  assert.equal(essay.model_calls, 0, 'no external or cloud model was called');
  assert.doesNotMatch(essay.reply, /A model answer/);
  const off = await che.say('Turn off internal-only mode');
  assert.match(off.reply, /Internal-only mode is off/);
  assert.equal((await che.st.get('ai_routing')).policy.internal_only, false);
});
