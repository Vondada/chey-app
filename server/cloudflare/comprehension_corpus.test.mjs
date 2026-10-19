// Comprehension audit (issue #350, "Related bugs" 6): owner turns across every CHE domain, run through
// /api/chat exactly as said, offline, with a model that lies ("Done, sir. I sent it and bought it."). Each
// turn names the route that must answer, the side effect it may have, and claims its reply must not make.
// A wrong route, an action taken for a question, a forbidden thing done or a claimed action with no record
// fails here. The turns live in comprehension_corpus.json; a turn marked "known" is a measured gap still
// open, so its route is reported, not asserted, while its side effect and claims are still checked.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';

const generated = new URL('./.comprehension_corpus.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
const corpus = JSON.parse(readFileSync(new URL('./comprehension_corpus.json', import.meta.url), 'utf8'));

// Offline, and every outbound request is recorded: a question must start nothing.
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  requests.push({ url: String(input?.url || input), method: String(init.method || input?.method || 'GET').toUpperCase() });
  throw new TypeError('fetch failed (comprehension corpus is offline)');
};
const LIE = 'Done, sir. I sent it and bought it.';

// Claims no reply may make unless the turn allows them: nothing in this harness can really send, buy,
// delete, upload, render, trade or open anything, so each of these would be invented.
const CLAIMS = {
  done: /^\s*(?:all\s+)?done\b|^\s*it(?:'|’)?s\s+done\b|\bconsider\s+it\s+done\b/i,
  sent: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:sent|emailed|texted|messaged|forwarded)\b|\b(?:has|have)\s+been\s+sent\b/i,
  bought: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:bought|purchased|paid|ordered|subscribed|transferred)\b|\b(?:has|have)\s+been\s+(?:bought|purchased|paid|ordered|transferred)\b/i,
  deleted: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:deleted|removed|erased|wiped)\b|\b(?:has|have)\s+been\s+(?:deleted|removed|erased)\b/i,
  uploaded: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:uploaded|published|posted)\b|\b(?:has|have)\s+been\s+(?:uploaded|published|posted)\b/i,
  rendered: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:rendered|made|created|produced)\s+(?:the|a|your)\s+(?:[\w-]+\s+){0,2}video\b|\bvideo\s+(?:is|has\s+been)\s+(?:rendered|ready|finished)\b/i,
  started: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:started|queued|launched|kicked\s+off|accepted)\s+(?:a|an|the|your|coding|new)\s+(?:[\w-]+\s+){0,2}(?:job|investigation|render|build|exam)\b/i,
  traded: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:placed|executed|entered|submitted)\s+(?:a|an|the|your|one|\d+)\s+(?:[\w-]+\s+){0,2}(?:order|trade|position)\b/i,
  live: /\b(?:switched|you(?:'re|\s+are)\s+now|we(?:'re|\s+are)\s+now)\s+(?:to\s+|on\s+)?live\b|\blive\s+trading\s+is\s+(?:now\s+)?on\b/i,
  opened: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:opened|launched)\s+(?:the\s+)?(?:youtube|notes|spotify|app|war\s+room)\b/i,
  scheduled: /\b(?:I|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:scheduled|booked|set\s+(?:a|the|your)\s+reminder|added\s+(?:it|that|this|the\s+\w+)\s+to\s+your\s+calendar)\b/i,
  // Asked only where the turn forbade or called off saving.
  remembered: /\bI(?:'ll|\s+will)\s+remember\b|\bI(?:'ve|\s+have)\s+(?:saved|stored|remembered)\b/i,
  rea_acronym: /\bRecall,?\s+Evidence\b/i,
};
const DEFAULT_BANS = Object.keys(CLAIMS).filter((name) => !['remembered', 'rea_acronym'].includes(name));

function storageFor(saved) {
  return {
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// What a turn started: a hold, an outbound write, a queued job, an REA investigation or a video.
function effectsOf(saved, before, meta, writes) {
  const out = [];
  if (meta.held_for_owner === true) out.push(`hold:${meta.owner_action_kind || 'unknown'}`);
  else if (saved.get('che:pending_owner_action') || saved.get('che:pending_app_action')) out.push('hold:stored');
  if (writes.length) out.push('dispatch');
  const count = (map, key, field) => (field ? (map.get(key)?.[field] || []).length : (map.get(key) || []).length);
  if (count(saved, 'che', 'jobs') > before.jobs) out.push('job');
  if (count(saved, 'rea_jobs') > before.rea) out.push('rea');
  if (saved.get('che_video_pending')) out.push('video');
  return out;
}

async function runTurn(turn) {
  const saved = new Map(Object.entries(turn.saved || {}));
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app',
    AI: { run: async () => { counter.calls += 1; return { response: LIE }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  // Earlier turns the owner said ("Remember that my favorite food is pizza"), through the same route.
  for (const said of turn.before || []) await (await send('/api/chat', { message: said, history: [] }, token)).text();
  const before = { jobs: (saved.get('che')?.jobs || []).length, rea: (saved.get('rea_jobs') || []).length };
  requests.length = 0;
  counter.calls = 0;
  const res = await send('/api/chat', { message: turn.say, history: turn.history || [] }, token);
  const raw = await res.text();
  const lines = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return {}; } });
  const meta = lines.find((item) => item.type === 'done') || (lines.length === 1 ? lines[0] : {});
  const reply = replyFromNdjson(raw) || meta.reply || meta.message || meta.detail || '';
  const route = meta.source || (meta.office ? `office:${meta.office}` : meta.held_for_owner ? 'held'
    : meta.clarification ? 'clarify' : res.status >= 500 ? 'error' : counter.calls ? 'model' : 'none');
  const writes = requests.filter((r) => r.method !== 'GET');
  return { route, reply, meta, effects: effectsOf(saved, before, meta, writes), modelCalls: counter.calls };
}

function judge(turn, out) {
  const routes = [].concat(turn.route);
  const problems = [];
  if (!routes.includes(out.route)) problems.push(`route ${out.route}, expected ${routes.join(' or ')}`);
  const effect = turn.effect || 'none';
  const holds = out.effects.filter((e) => e.startsWith('hold'));
  if (effect === 'none' && out.effects.length) problems.push(`side effect ${out.effects.join(',')} for a turn that may start nothing`);
  if (effect.startsWith('hold:') && !holds.includes(effect)) problems.push(`expected ${effect}, got ${out.effects.join(',') || 'nothing'}`);
  if (effect.startsWith('hold:') && out.effects.some((e) => !e.startsWith('hold'))) problems.push(`acted before the yes: ${out.effects.join(',')}`);
  if (effect === 'act' && holds.length) problems.push(`held a request it should carry out: ${holds.join(',')}`);
  const bans = [...DEFAULT_BANS.filter((name) => !(turn.allow || []).includes(name)), ...(turn.ban || [])];
  const claimed = [...new Set(bans)].filter((name) => CLAIMS[name].test(out.reply));
  if (claimed.length) problems.push(`claims ${claimed.join(', ')}: "${out.reply.slice(0, 120)}"`);
  return problems;
}

const results = [];
test('every corpus turn reaches its own route, starts only what was asked and claims nothing it did not do', async (t) => {
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => {};
  try {
    for (const turn of corpus.turns) results.push({ turn, out: await runTurn(turn) });
  } finally { Object.assign(console, quiet); }
  const failures = [];
  let routed = 0;
  for (const { turn, out } of results) {
    const problems = judge(turn, out);
    if (!problems.some((p) => p.startsWith('route'))) routed += 1;
    // A known gap still has to keep its side effect and its claims honest.
    const counted = turn.known ? problems.filter((p) => !p.startsWith('route')) : problems;
    if (counted.length) failures.push(`[${turn.d}] "${turn.say}": ${counted.join('; ')}`);
  }
  const known = results.filter(({ turn }) => turn.known).length;
  t.diagnostic(`${results.length} turns; ${routed} routed as expected; ${known} known gaps; ${failures.length} failures`);
  if (process.env.CHE_CORPUS_REPORT) {
    writeFileSync(process.env.CHE_CORPUS_REPORT, JSON.stringify(results.map(({ turn, out }) => ({
      d: turn.d, say: turn.say, expected: turn.route, known: turn.known || null, route: out.route, effects: out.effects,
      problems: judge(turn, out), reply: out.reply.slice(0, 240),
    })), null, 1));
  }
  assert.deepEqual(failures, []);
});

test('the corpus covers every domain, at least 300 turns, and each known gap says why', () => {
  const domains = new Set(corpus.turns.map((turn) => turn.d));
  for (const d of ['memory', 'voice', 'google', 'coding', 'rea', 'trading', 'video', 'office', 'mailbox', 'commands', 'apps', 'money', 'research', 'weather', 'brain', 'smalltalk', 'capability']) {
    assert.ok(domains.has(d), d);
  }
  assert.ok(corpus.turns.length >= 300, `${corpus.turns.length} turns`);
  for (const turn of corpus.turns) {
    if (turn.known) assert.ok(String(turn.known).length > 10, turn.say);
    for (const name of [...(turn.ban || []), ...(turn.allow || [])]) assert.ok(CLAIMS[name], `${turn.say}: unknown claim ${name}`);
  }
});
