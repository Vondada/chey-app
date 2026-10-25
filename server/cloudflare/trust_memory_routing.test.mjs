// Owner live test, 2026-10-25 (docs/failure_inventory/trust_memory_routing.md), replayed through the real /api/chat
// route on isolated in-memory storage (never the owner's CHE). What failed on the iPhone:
//   1. "Strawberry Sprite" was recalled, favorite food and favorite color were not, when asked together;
//   2. "Have we worked together before?" → "no record of previous collaboration";
//   3. "Save the phrase Silver Falcon 27" was acknowledged with no write receipt;
//   4. asked for it, CHE could give neither a record ID nor a timestamp;
//   5. "Show my last five missions" → "I have no access to mission history or job records";
//   6. recalled facts came with no source metadata.
// Every read route also names its outcome (retrieved / no_match / stored / storage_failed / permission_denied /
// tool_unavailable), and the model, which here would always answer wrongly, never gets to replace it.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { auditReply } from './hallucination_auditor.js';
import { explicitMemorySave, personalFactQuestion } from './personal_recall.js';
import { workHistoryIntent } from './activity_status.js';
import { agentMailboxReport } from './coding_history.js';
import { ownerMemorySearchIntent, ownerSearchTurn, ownerStatementCandidates } from './owner_recall.js';
import { RECALL_OUTCOMES } from './memory_provenance.js';

const generated = new URL('./.trust_memory_routing.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Hermetic: every outbound request fails unless a test installs its own GitHub stand-in.
const OFFLINE = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };
globalThis.fetch = OFFLINE;

const { DatabaseSync } = await import('node:sqlite');
const dbs = new WeakMap();
// `faults.sql`: every SQL call throws (the Durable Object's storage is down).
// `faults.put`: writes of CHE's data key fail.
function storageFor(saved, faults) {
  if (!dbs.has(saved)) dbs.set(saved, new DatabaseSync(':memory:'));
  const db = dbs.get(saved);
  return {
    sql: { exec: (q, ...p) => { if (faults.sql) throw new Error('SQLITE_IOERR: disk I/O error'); const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (k) => (Array.isArray(k)
      ? new Map(k.filter((key) => saved.has(key)).map((key) => [key, structuredClone(saved.get(key))]))
      : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => {
      const entries = k && typeof k === 'object' ? Object.entries(k) : [[k, v]];
      if (faults.put && entries.some(([key]) => key === 'che')) throw new Error('storage write failed');
      for (const [key, value] of entries) saved.set(key, structuredClone(value));
    },
    delete: async (k) => (Array.isArray(k) ? k.filter((key) => saved.delete(key)).length : saved.delete(k)),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A model that is always wrong: it claims saves, denies records and invents values. A stored answer never comes from it.
const lastUser = (input) => String((input?.messages || []).filter((m) => m.role === 'user').at(-1)?.content || '');
const WRONG = (input) => {
  const said = lastUser(input);
  if (/worked together|collaboration/i.test(said)) return "I can't find any record of previous collaboration between us.";
  if (/missions?|projects?|working on|jobs?/i.test(said)) return "I don't have access to mission history or job records.";
  if (/Silver Falcon|save|store/i.test(said)) return "I've saved that for you and I'll remember it.";
  if (/record id|timestamp/i.test(said)) return 'I stored it, but I cannot retrieve a record ID or timestamp.';
  if (/\?\s*$/.test(said)) return 'Your favorite drink is Coca-Cola and your favorite color is purple.';
  return 'Noted, sir.';
};

async function owner({ saved = new Map(), env: extra = {} } = {}) {
  const counter = { calls: 0 };
  const faults = { sql: false, put: false };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extra,
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: WRONG(input) }; } },
  };
  const connect = () => {
    const state = new CheState({ storage: storageFor(saved, faults), waitUntil: () => {} }, env);
    env.CHE_STATE = { getByName: () => state };
    return state;
  };
  connect();
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  // A family member's enrolled phone: a real paired device that is not the owner's.
  let guestToken = '';
  const guestDevice = async () => {
    if (guestToken) return guestToken;
    const tenant = await (await send('/api/platform/tenants', { name: 'Guest', role: 'family' }, token)).json();
    const invite = await (await send('/api/platform/enrollments', { access: 'private', tenant_id: tenant.tenant.id }, token)).json();
    guestToken = (await (await send('/api/enroll', { enrollment_token: invite.enrollment.token, device_name: 'guest' })).json()).device_token;
    return guestToken;
  };
  const turn = async (message, asOwner) => {
    const auth = asOwner ? token : await guestDevice();
    const before = counter.calls;
    const res = await send("/api/chat", { message, history: [] }, auth);
    const raw = await res.text();
    if (res.status !== 200) return { reply: (() => { try { return JSON.parse(raw).detail || raw; } catch (_) { return raw; } })(), meta: { status: res.status }, modelCalls: counter.calls - before };
    const done = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return {}; } }).find((item) => item.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before };
  };
  return {
    saved, faults,
    say: (message) => turn(message, true),
    guest: (message) => turn(message, false),
    restart: connect,
    // Plant records in CHE's own durable state, then start a new conversation over it.
    seed: async (fields) => { saved.set('che', { ...(saved.get('che') || {}), ...structuredClone(fields) }); connect(); },
  };
}

const minuteOf = (iso) => new Date(Date.parse(iso)).toISOString().slice(0, 16);

test('Silver Falcon 27: the save quotes the read-back record id and time, and the same record answers id, time and source later', async () => {
  const che = await owner();
  const saved = await che.say('Save the phrase Silver Falcon 27');
  assert.equal(saved.meta.source, 'che_memory');
  assert.equal(saved.meta.outcome, RECALL_OUTCOMES.STORED);
  assert.equal(saved.modelCalls, 0, 'the model never says "saved"');
  const receipt = saved.meta.memory_receipt;
  assert.match(receipt.record_id, /^[0-9a-f-]{36}$/);
  // The record really is in storage, with the text and time the reply quotes.
  const stored = che.saved.get('che').memory_records.find((r) => r.id === receipt.record_id);
  assert.ok(stored, 'the acknowledged record exists in storage');
  assert.match(stored.text, /Silver Falcon 27/);
  assert.ok(saved.reply.includes(`record ${receipt.record_id}`), saved.reply);
  assert.ok(saved.reply.includes(minuteOf(stored.created_at).replace('T', ' at ')), saved.reply);
  assert.doesNotMatch(saved.reply, /I've saved that for you/);

  che.restart();
  const meta = await che.say('What is the record ID and timestamp for Silver Falcon 27?');
  assert.equal(meta.meta.source, 'che_memory_search');
  assert.equal(meta.meta.outcome, RECALL_OUTCOMES.RETRIEVED);
  assert.equal(meta.modelCalls, 0);
  assert.ok(meta.reply.includes(`record ${receipt.record_id}`), meta.reply);
  assert.ok(meta.reply.includes(`stored ${minuteOf(stored.created_at).replace('T', ' ')} UTC`), meta.reply);
  assert.match(meta.reply, /source: your own words in chat, owner-confirmed/);
  assert.doesNotMatch(meta.reply, /cannot retrieve a record ID/);

  const again = await che.say('Do you remember Silver Falcon 27?');
  assert.match(again.reply, /^Yes, sir\. I have it saved/);
  assert.ok(again.reply.includes(receipt.record_id), again.reply);
});

test('a write that cannot be read back is never acknowledged: storage_failed, and no "I will remember"', async () => {
  const che = await owner();
  che.faults.put = true;
  const out = await che.say('Save the phrase Silver Falcon 27');
  assert.equal(out.meta.source, 'che_memory');
  assert.equal(out.meta.ok, false);
  assert.equal(out.meta.outcome, RECALL_OUTCOMES.STORAGE_FAILED);
  assert.match(out.reply, /could not (?:verify the memory write|save that)/);
  assert.doesNotMatch(out.reply, /I’ll remember|I've saved|record [0-9a-f]{8}/);
  assert.equal(out.meta.memory_receipt, undefined);
});

test('favorite food, drink and color asked together: each answered, with its source, from the stored statements', async () => {
  const che = await owner();
  await che.say('My favorite drink is Strawberry Sprite');
  await che.say('My favorite food is lasagna');
  await che.say('My favorite color is teal');
  che.restart();
  for (const ask of ['What are my favorite food, drink and color?', 'What is my favorite food, favorite drink, and favorite color?']) {
    const out = await che.say(ask);
    assert.equal(out.meta.source, 'che_personal_recall', ask);
    assert.equal(out.modelCalls, 0, ask);
    assert.equal(out.meta.outcome, RECALL_OUTCOMES.RETRIEVED, ask);
    assert.match(out.reply, /favorite food is lasagna/i, ask);
    assert.match(out.reply, /favorite drink is Strawberry Sprite/i, ask);
    assert.match(out.reply, /favorite color is teal/i, ask);
    assert.match(out.reply, /Source: your own words in chat/, ask);
    assert.doesNotMatch(out.reply, /Coca-Cola|purple|no record/i, ask);
    assert.equal(out.meta.recall_receipts.length, 3, ask);
    for (const r of out.meta.recall_receipts) { assert.ok(r.record_id, ask); assert.ok(Date.parse(r.stored_at), ask); }
  }
  const why = await che.say('What is my favorite drink, and where did you learn that?');
  assert.match(why.reply, /^Your favorite drink is Strawberry Sprite\./);
  assert.match(why.reply, /Record \S+ in (?:the Brain|memory records), stored \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, source: your own words in chat/);
  assert.doesNotMatch(why.reply, /favorite and|no record/i);
  const source = await che.say('Where did you get my favorite drink from?');
  assert.equal(source.meta.source, 'che_personal_recall');
  assert.match(source.reply, /Strawberry Sprite[\s\S]*source: your own words in chat/);
});

test('a correction wins (teal, then orange), alone and in a several-subject question', async () => {
  const che = await owner();
  await che.say('My favorite color is teal');
  await che.say('My favorite food is lasagna');
  await che.say('Actually, my favorite color is orange');
  che.restart();
  const one = await che.say('What is my favorite color?');
  assert.match(one.reply, /^Your favorite color is orange\b/);
  const both = await che.say('What are my favorite food and color?');
  assert.match(both.reply, /favorite color is orange/);
  assert.doesNotMatch(both.reply, /favorite color is teal/);
});

test('no matching record and an unreadable store get different replies and outcomes', async () => {
  const che = await owner();
  const none = await che.say('What is my favorite flower?');
  assert.equal(none.meta.source, 'che_personal_recall');
  assert.equal(none.meta.outcome, RECALL_OUTCOMES.NO_MATCH);
  assert.match(none.reply, /^I don't have a record of your favorite flower/);
  assert.doesNotMatch(none.reply, /couldn't read/);
  const searched = await che.say('Search my memory for Silver Falcon');
  assert.equal(searched.meta.outcome, RECALL_OUTCOMES.NO_MATCH);

  // A Brain that cannot be read while memory records can: the search says which store it could not read, the outcome
  // is storage_failed, and the recent-memories list says the Brain was not included. Never "no record" alone.
  const throwing = { init: () => true, rows: () => { throw new Error('SQLITE_IOERR'); }, get: () => { throw new Error('SQLITE_IOERR'); }, list: () => { throw new Error('SQLITE_IOERR'); }, search: () => { throw new Error('SQLITE_IOERR'); } };
  const ledger = new Map();
  const kv = { get: async (k) => ledger.get(k), put: async (k, v) => { ledger.set(k, v); } };
  const partial = await ownerSearchTurn(kv, { memory_records: [] }, throwing, { term: 'Silver Falcon' });
  assert.equal(partial.meta.outcome, RECALL_OUTCOMES.STORAGE_FAILED);
  assert.match(partial.text, /couldn't read Brain \(synced from the phone\) just now[\s\S]*not readable right now/);
  assert.ok(ownerStatementCandidates(throwing, 'favorite flower').unreadable);
  assert.ok(ownerStatementCandidates(null, 'favorite flower').unreadable);
  const recent = await ownerSearchTurn(kv, { memory_records: [] }, throwing, { recent: true, limit: 5 });
  assert.equal(recent.meta.outcome, RECALL_OUTCOMES.STORAGE_FAILED);
  assert.match(recent.text, /couldn't read my Brain store[\s\S]*failed read, not an empty memory/);

  // The whole store failing is a temporary failure that says nothing was saved: never "no record".
  che.faults.sql = true;
  che.restart();
  const down = await che.say('What is my favorite flower?');
  assert.equal(down.meta.status, 503);
  assert.match(down.reply, /couldn't finish that just now[\s\S]*Nothing was saved/);
  assert.doesNotMatch(down.reply, /don't have a record/);
});

test('"What are my recent memories?" lists the newest records with id, time and source; an empty store says empty', async () => {
  const empty = await owner();
  const nothing = await empty.say('What are my recent memories?');
  assert.equal(nothing.meta.source, 'che_memory_search');
  assert.equal(nothing.meta.outcome, RECALL_OUTCOMES.NO_MATCH);
  assert.match(nothing.reply, /no memories stored yet[\s\S]*empty store, not a read failure/);

  const che = await owner();
  await che.say('My favorite drink is Strawberry Sprite');
  const saved = await che.say('Save the phrase Silver Falcon 27');
  che.restart();
  const out = await che.say('What are my recent memories?');
  assert.equal(out.meta.source, 'che_memory_search');
  assert.equal(out.meta.outcome, RECALL_OUTCOMES.RETRIEVED);
  assert.equal(out.modelCalls, 0);
  assert.ok(out.reply.includes(saved.meta.memory_receipt.record_id), out.reply);
  assert.match(out.reply, /Strawberry Sprite/);
  assert.match(out.reply, /stored \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, source: your own words in chat/);
  assert.doesNotMatch(out.reply, /I don't have a record of your recent memories/);
});

const day = (n) => new Date(Date.UTC(2026, 9, n, 12)).toISOString();
const SEEDED = {
  projects: [
    { id: 'proj-aaaa1111', title: 'Roblox blade arena', type: 'game', status: 'active', created_at: day(10), updated_at: day(20) },
    { id: 'proj-bbbb2222', title: 'Bakery ad campaign', status: 'done', created_at: day(5), updated_at: day(6) },
    { id: 'proj-cccc3333', title: 'Studio vocal chain', status: 'active', created_at: day(12), updated_at: day(22) },
    { id: 'proj-dddd4444', title: 'Old landing page', status: 'archived', created_at: day(1), updated_at: day(2) },
  ],
  objectives: [
    { id: 'mission-0001-aaaa', objective: 'Audit September 22 trades', status: 'complete', created_at: day(18), nodes: [{ id: 'n1', status: 'complete' }, { id: 'n2', status: 'complete' }] },
    { id: 'mission-0002-bbbb', objective: 'Build the crypto stream', status: 'active', created_at: day(23), nodes: [{ id: 'n1', status: 'complete' }, { id: 'n2', status: 'ready' }] },
  ],
  jobs: [{ id: 'job-77777777', kind: 'coding', title: 'Fix chart cast crash', status: 'complete', pr_number: 395, created_at: day(21), updated_at: day(21) }],
};

test('"What were our last three projects?", "Show my last five missions.", "Have we worked together before?" read the stored records', async () => {
  const che = await owner();
  await che.seed(SEEDED);
  const projects = await che.say('What were our last three projects?');
  assert.equal(projects.meta.source, 'che_work_history');
  assert.equal(projects.meta.outcome, RECALL_OUTCOMES.RETRIEVED);
  assert.equal(projects.modelCalls, 0);
  assert.deepEqual(projects.meta.record_ids, ['proj-cccc3333', 'proj-aaaa1111', 'proj-bbbb2222'], 'newest three, newest first');
  assert.match(projects.reply, /1\. "Studio vocal chain"[\s\S]*2\. "Roblox blade arena"[\s\S]*3\. "Bakery ad campaign"/);
  assert.match(projects.reply, /1 older not listed/);
  assert.doesNotMatch(projects.reply, /Old landing page|no access/i);

  const missions = await che.say('Show my last five missions.');
  assert.equal(missions.meta.source, 'che_work_history');
  assert.deepEqual(missions.meta.record_ids, ['mission-0002-bbbb', 'mission-0001-aaaa']);
  assert.match(missions.reply, /"Build the crypto stream" \(mission mission-0002-bbbb, active, 1 of 2 steps done/);
  assert.doesNotMatch(missions.reply, /don't have access/);

  const together = await che.say('Have we worked together before?');
  assert.equal(together.meta.source, 'che_work_history');
  assert.match(together.reply, /^Yes, sir\./);
  assert.match(together.reply, /PR #395/);
  assert.doesNotMatch(together.reply, /no record of previous collaboration/i);

  const empty = await owner();
  const none = await empty.say('Show my last five missions.');
  assert.equal(none.meta.outcome, RECALL_OUTCOMES.NO_MATCH);
  assert.match(none.reply, /no missions stored yet[\s\S]*not missing access/);
});

test('a guest asking for mission history is refused as permission_denied, never answered by the model', async () => {
  const che = await owner();
  await che.seed(SEEDED);
  const out = await che.guest('Show my last five missions.');
  assert.equal(out.meta.outcome, RECALL_OUTCOMES.PERMISSION_DENIED);
  assert.equal(out.modelCalls, 0);
  assert.doesNotMatch(out.reply, /Build the crypto stream|don't have access/);
});

// A GitHub stand-in serving the che-mailbox branch: Claude's thread and the live handoff.
function githubMailbox({ fail = false } = {}) {
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
  const sha = 'a'.repeat(40);
  const thread = [
    { id: 'claude-old', at: '2026-10-24T10:00:00Z', from: 'claude', to: 'che', text: 'Older note about PR 400.' },
    { id: 'che-1', at: '2026-10-25T01:00:00Z', from: 'che', to: 'claude', text: 'What are you doing?' },
    { id: 'claude-2026-10-25-rel', at: '2026-10-25T09:30:00Z', from: 'claude', to: 'che', text: 'Working on the reliability lanes: trust, markets-studio, infra-app.' },
  ].map((m) => JSON.stringify(m)).join('\n');
  const handoff = '# LIVE HANDOFF\n\n## 2. Current position\n\n**Claude, 2026-10-25 ~06:00 UTC — reliability mission on claude/che-reliability.**\n- lanes running\n\n**Codex, 2026-10-24 — release checkpoint.**\n\n## 3. Queue\n';
  return async (input) => {
    const url = new URL(String(input?.url || input));
    if (url.host !== 'api.github.com') throw new TypeError(`offline: ${url.host}`);
    if (fail) return new Response('{"message":"Server Error"}', { status: 500 });
    if (url.pathname.endsWith('/git/ref/heads/che-mailbox')) return Response.json({ object: { sha } });
    if (url.pathname.endsWith('/contents/mailbox/claude.jsonl')) return Response.json({ path: 'mailbox/claude.jsonl', sha: 'b'.repeat(40), encoding: 'base64', content: b64(thread) });
    if (url.pathname.endsWith('/contents/mailbox/briefs/LIVE-HANDOFF.md')) return Response.json({ path: 'mailbox/briefs/LIVE-HANDOFF.md', sha: 'c'.repeat(40), encoding: 'base64', content: b64(handoff) });
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
}
const GITHUB = { CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'example/che-test' };

test('"What is Claude currently working on?" quotes Claude\'s newest mailbox message and handoff entry, labelled as its own report', async () => {
  globalThis.fetch = githubMailbox();
  try {
    const che = await owner({ env: GITHUB });
    const out = await che.say('What is Claude currently working on?');
    assert.equal(out.meta.source, 'che_coding_history');
    assert.equal(out.meta.outcome, RECALL_OUTCOMES.RETRIEVED);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /message claude-2026-10-25-rel, written 2026-10-25 09:30 UTC\): "Working on the reliability lanes/);
    assert.match(out.reply, /live handoff \(che-mailbox aaaaaaa\): "Claude, 2026-10-25 ~06:00 UTC — reliability mission/);
    assert.match(out.reply, /That is Claude's own report, not something I verified\./);
    assert.doesNotMatch(out.reply, /Older note|Codex, 2026-10-24|Nothing is running|don't have access/);
    assert.ok(out.meta.record_ids.includes('mailbox:claude:claude-2026-10-25-rel'));
  } finally { globalThis.fetch = OFFLINE; }
});

test('Claude\'s work with no mailbox credentials is tool_unavailable; a GitHub failure is storage_failed; neither is "nothing"', async () => {
  const che = await owner();
  const missing = await che.say('What is Claude currently working on?');
  assert.equal(missing.meta.outcome, RECALL_OUTCOMES.TOOL_UNAVAILABLE);
  assert.match(missing.reply, /live mailbox reader isn't connected/);
  assert.doesNotMatch(missing.reply, /Nothing is running/);
  globalThis.fetch = githubMailbox({ fail: true });
  try {
    const failing = await owner({ env: GITHUB });
    const out = await failing.say('What is Claude currently working on?');
    assert.equal(out.meta.outcome, RECALL_OUTCOMES.STORAGE_FAILED);
    assert.match(out.reply, /couldn't read Claude's mailbox thread on GitHub just now \(Mailbox read failed \(500\)/);
  } finally { globalThis.fetch = OFFLINE; }
  // The pure report agrees: an empty thread with no handoff entry is a read that found nothing.
  assert.equal(agentMailboxReport('claude', { messages: [] }, null).outcome, RECALL_OUTCOMES.NO_MATCH);
});

test('the final audit removes a model\'s "no access to mission history" and catches an unbacked "I\'ve saved that"', () => {
  const denial = auditReply("I don't have access to mission history or job records. Anything else, sir?");
  assert.doesNotMatch(denial.text, /don't have access to mission history/);
  assert.ok(denial.claims.some((c) => c.kind === 'records_denied'));
  const collab = auditReply("I can't find any record of previous collaboration between us.");
  assert.ok(collab.claims.some((c) => c.kind === 'records_denied'));
  const save = auditReply("I've saved that for you and I'll remember it.");
  assert.ok(save.claims.some((c) => c.kind === 'memory_saved'), 'a save claim with no receipt is audited');
  assert.doesNotMatch(save.text, /I've saved that for you/);
});

test('routing words: explicit saves, recent memories, history questions and multi-subject favorites, with near misses', () => {
  assert.equal(explicitMemorySave('Please save Silver Falcon 27 to your memory.'), 'Silver Falcon 27');
  assert.equal(explicitMemorySave('Store the code phrase Silver Falcon 27'), 'Code phrase: Silver Falcon 27');
  assert.equal(explicitMemorySave('Save the phrase Silver Falcon 27'), 'Phrase: Silver Falcon 27');
  for (const no of ['save the file', 'add milk to the shopping list', 'Remember my password is hunter2', 'Can you remember what I said?', 'Store the car in the garage']) {
    assert.equal(explicitMemorySave(no), null, no);
  }
  assert.deepEqual(ownerMemorySearchIntent('What are my recent memories?'), { recent: true, term: '', limit: 5 });
  assert.equal(ownerMemorySearchIntent('Show my last three memories').limit, 3);
  assert.deepEqual(workHistoryIntent('What were our last three projects?'), { kind: 'projects', limit: 3 });
  assert.deepEqual(workHistoryIntent('Show my last five missions.'), { kind: 'missions', limit: 5 });
  assert.equal(workHistoryIntent('Have we worked together before?').kind, 'collaboration');
  assert.equal(workHistoryIntent('Show me the project'), null);
  assert.deepEqual(personalFactQuestion('What are my favorite food, drink and color?').parts.map((p) => p.subject), ['favorite food', 'favorite drink', 'favorite color']);
  assert.equal(personalFactQuestion('What is my favorite drink, and where did you learn that?').parts, undefined);
});
