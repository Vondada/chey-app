// RAG regression evaluations (owner, 2026-10-20): the owner's own failed questions and misleading
// fixtures, replayed through the real /api/chat with an in-memory SQLite Brain and a fake GitHub.
// A: "how is PR 374 related" answered from the owner's own earlier question instead of GitHub.
// B: "what music preferences have I told you" listed an Atlas coding report as the owner's words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const generated = new URL('./.rag_eval.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

// Offline except a fake GitHub API holding PR 374 (the real one: Trading Room ledgers).
const PR374 = {
  number: 374, title: 'Trading Room: trade records by source, one card per ledger, never summed', state: 'closed',
  merged: true, head: { sha: 'a'.repeat(40) }, merge_commit_sha: '502cf47'.padEnd(40, '0'), merged_at: '2026-10-20T06:10:00Z', created_at: '2026-10-20T05:00:00Z', html_url: 'https://github.com/Vondada/chey-app/pull/374',
  body: 'Splits the Trading Room into one card per ledger (simulation, forward paper journal, broker).',
};
const PR374_FILES = ['server/cloudflare/trading_ledgers.js', 'server/cloudflare/trading_ledgers.test.mjs', 'lib/trading/che_trading_room.dart'];
let githubReads = 0;
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.github.com/repos/Vondada/chey-app/pulls/')) {
    githubReads += 1;
    if (/\/pulls\/374\/files/.test(url)) return json(PR374_FILES.map((filename) => ({ filename })));
    if (/\/pulls\/374$/.test(url)) return json(PR374);
    return json({ message: 'Not Found' }, 404);
  }
  throw new TypeError(`fetch failed (rag_eval tests are offline: ${new URL(url).host})`);
};

function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ model = () => 'Here is the answer, sir.' } = {}) {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app',
    AI: { run: async (_model, opts = {}) => { calls += 1; return { response: model(opts) }; } },
  };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  // RAGDBG=1 prints each turn (route and reply) while measuring before/after.
  const say = async (message, { as = token } = {}) => { const r = await say0(message, { as }); if (process.env.RAGDBG) console.error("DBG", JSON.stringify({ message, route: r.route, reply: r.reply.slice(0, 900) })); return r; };
  const say0 = async (message, { as = token } = {}) => {
    const before = calls;
    const res = await send('/api/chat', { message, history: history.slice(-8) }, as);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('');
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { status: res.status, reply, done, route: done.source || (calls > before ? 'model' : 'none'), modelCalls: calls - before };
  };
  const seedMemory = async (records) => {
    await say('Hello CHE.');
    const data = saved.get('che');
    data.memory_records = [...(data.memory_records || []), ...records];
    saved.set('che', data);
  };
  return { say, seedMemory, saved };
}

const R = (id, text, extra = {}) => ({ id, text, source: 'owner_chat', verification_status: 'owner_attested', active: true, created_at: '2026-10-10T09:00:00.000Z', ...extra });
const ATLAS_REPORT = R('atlas', 'Atlas report Oct 11: I refactored the coding queue, cut music room latency by 40%, and the owner preference engine now caches results.', { created_at: '2026-10-11T09:00:00.000Z' });

test('Eval 1 (failure A): PR 374 relationships come from GitHub and the Brain, never from the owner\'s own question', sqlite, async () => {
  const che = await owner();
  const q = 'What is PR 374 related to in the Brain? Tell me which rooms it connects to and how you know.';
  await che.say(q); // the first ask becomes a conversation record: the misleading fixture
  const out = await che.say(q);
  assert.equal(out.route, 'che_brain_rooms');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /From GitHub \(verified\), pull request #374/);
  assert.match(out.reply, /Trading Room/);
  assert.match(out.reply, /trading_ledgers\.js/);
  assert.doesNotMatch(out.reply, /Tell me which rooms it connects to/, 'the owner\'s question is not its own evidence');
});

test('Eval 2 (failure B): music preferences list only the owner\'s music statements, each with its source', async () => {
  const che = await owner();
  await che.seedMemory([
    R('rnb', 'I love 90s R&B, especially Brandy and Jodeci.'),
    R('jazz', 'I listen to jazz when I work late.', { created_at: '2026-10-12T09:00:00.000Z' }),
    ATLAS_REPORT,
    R('coffee', 'I take my coffee black.'),
  ]);
  const out = await che.say('What music preferences have I told you? Give me the source of each one.');
  assert.equal(out.route, 'che_memory_provenance');
  assert.match(out.reply, /R&B/);
  assert.match(out.reply, /jazz/);
  assert.doesNotMatch(out.reply, /refactored the coding queue/);
  assert.doesNotMatch(out.reply, /coffee/);
  assert.doesNotMatch(out.reply, /give me the source of each one/i);
});

test('Eval 3: an Atlas report the owner pasted is never presented as the owner\'s own statement', async () => {
  const che = await owner();
  await che.seedMemory([ATLAS_REPORT]);
  const out = await che.say('What did I tell you about music room latency?');
  assert.equal(out.route, 'che_memory_provenance');
  assert.match(out.reply, /Atlas/);
  assert.doesNotMatch(out.reply, /^You (told|said)/);
  assert.doesNotMatch(out.reply, /your own statement/);
});

test('Eval 4: a follow-up keeps the subject of the previous question', sqlite, async () => {
  const che = await owner();
  await che.say('What is PR 374 related to in the Brain?');
  const out = await che.say('Which files did it change?');
  assert.match(out.reply, /trading_ledgers\.js/);
});

test('Eval 5: no record means an honest no-record answer, not a guess', async () => {
  const che = await owner({ model: () => 'You told me your favorite boat is a red catamaran.' });
  await che.seedMemory([R('rnb', 'I love 90s R&B.')]);
  const out = await che.say('What did I tell you about my favorite boat?');
  assert.doesNotMatch(out.reply, /catamaran/);
  assert.match(out.reply, /(don't|do not) have any record|cannot find/i);
});

test('Eval 6: an exact trade symbol is answered from the ledgers, deterministically', sqlite, async () => {
  const che = await owner();
  const out = await che.say('What does the Trading Room know about MNQ?');
  assert.equal(out.route, 'che_brain_rooms');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /Live ledgers/);
});

test('Eval 7: an AI\'s claim that a PR merged is not a receipt; GitHub decides', sqlite, async () => {
  const che = await owner();
  await che.seedMemory([R('claim', 'Atlas report: PR 999 merged and deployed to production.', { source: 'agent_research', verification_status: 'unverified' })]);
  const out = await che.say('What is PR 999 related to in the Brain?');
  assert.match(out.reply, /does not exist|could not read/i);
  assert.doesNotMatch(out.reply, /From GitHub \(verified\)/);
});

test('Eval 8: a pull request that does not exist on GitHub is reported as not existing', sqlite, async () => {
  const che = await owner();
  const before = githubReads;
  const out = await che.say('How is PR 4242 related to the Trading Room?');
  assert.ok(githubReads > before, 'GitHub was actually read');
  assert.match(out.reply, /pull request #4242 does not exist/);
});

test('Eval 9: an unpaired caller gets nothing from memory or the Brain', async () => {
  const che = await owner();
  await che.seedMemory([R('rnb', 'I love 90s R&B.')]);
  const out = await che.say('What music preferences have I told you?', { as: 'not-a-device-token' });
  assert.equal(out.status, 401);
  assert.doesNotMatch(out.reply, /R&B/);
});

test('Eval 10: a corrected memory answers with the newer statement and names the correction', async () => {
  const che = await owner();
  await che.seedMemory([
    R('old', 'My favorite music is country.', { active: false, superseded_by: 'new', superseded_at: '2026-10-15T09:00:00.000Z' }),
    R('new', 'My favorite music is 90s R&B.', { created_at: '2026-10-15T09:00:00.000Z' }),
    R('dup', 'My favorite music is 90s R&B.', { created_at: '2026-10-15T09:00:01.000Z' }),
  ]);
  const out = await che.say('What have I told you about my favorite music?');
  assert.equal(out.route, 'che_memory_provenance');
  assert.match(out.reply, /90s R&B/);
  assert.match(out.reply, /you corrected it/, 'the outdated statement is named as corrected, not presented as current');
  assert.equal((out.reply.match(/90s R&B/g) || []).length, 1, 'a duplicated statement is said once');
});
