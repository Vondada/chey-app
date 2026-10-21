// Owner report (2026-10-21): two read-only reasoning questions about CHE's own coding architecture
// came back as a raw "VERIFIED I inspected…" file index, with no answer. Replayed here through /api/chat
// with GitHub stubbed, so the source inspection really runs; the reasoning model's answer is what must reach the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const generated = new URL('./.coding_architecture_analysis.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

export const OWNER_QUESTION = 'Based on the coding architecture you inspected, explain the three biggest weaknesses preventing you from completing coding projects autonomously. For each weakness, identify the responsible system, explain why it fails, and recommend a concrete repair. Answer in plain English, not a file list. Stay in EXPLORE mode. Do not create a coding job or modify files.';

const SOURCE = {
  'server/cloudflare/coding_runtime.js': 'export class CheCodingRuntime {\n  async createSession({ jobId = "" } = {}) { return { status: 202, job_id: jobId }; }\n}\n',
  'server/cloudflare/self_development.js': 'export async function inspectRepositoryContext(env, request) {\n  return { ok: true };\n}\n',
  'server/cloudflare/code_scout.js': 'export function repositoryInspectionIntent(message) {\n  return Boolean(message);\n}\n',
};
const HEAD = 'a'.repeat(40);

// GitHub stub for the reads the inspection makes; any workflow dispatch is recorded, never answered as success.
function githubStub(record) {
  return async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com/repos/Vondada/chey-app')) return new Response('{}', { status: 404 });
    const path = u.slice('https://api.github.com/repos/Vondada/chey-app'.length);
    if ((init.method || 'GET') !== 'GET') { record.dispatches.push(path); return new Response('{}', { status: 204 }); }
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '' || path === '/') return json({ default_branch: 'main' });
    if (path.startsWith('/git/ref/heads/')) return json({ object: { sha: HEAD } });
    if (path.startsWith('/git/trees/')) return json({ tree: Object.keys(SOURCE).map((p) => ({ type: 'blob', path: p })) });
    if (path.startsWith('/contents/')) {
      const file = decodeURIComponent(path.slice('/contents/'.length).split('?')[0]);
      if (!SOURCE[file]) return json({ message: 'Not Found' }, 404);
      return json({ content: Buffer.from(SOURCE[file]).toString('base64'), sha: 'b'.repeat(40), type: 'file' });
    }
    if (path.startsWith('/pulls')) return json([]);
    return json({ message: 'Not Found' }, 404);
  };
}

async function owner(modelReply, record) {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app',
    AI: { run: async (model, input) => { record.models.push({ model, input }); return modelReply === null ? { response: '' } : { response: modelReply }; } },
  };
  const state = new worker.CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.default.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  return {
    say: async (message) => {
      const res = await post('/api/chat', { message, agent_mode: 'full' }, token);
      const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { status: res.status, reply: lines.filter((l) => l.type === 'delta').map((l) => l.delta).join(''), done: lines.find((l) => l.type === 'done') || {} };
    },
  };
}

const ANALYSIS = [
  '1. The coding runtime waits on a runner that may never claim the job, so a queued job can sit with no owner-visible failure. Responsible system: coding_runtime.js, CheCodingRuntime.createSession. Repair: record a claim deadline and report it as blocked.',
  '2. Repository questions are routed to the file index before the reasoning model is asked. Responsible system: code_scout.js, repositoryInspectionIntent. Repair: answer analytical questions from the source excerpts.',
  '3. The owner-facing answer has no check that a stated job or PR exists. Responsible system: worker.js, answerTerminalChatOnly. Repair: run the execution-claim guard on every model reply.',
].join('\n');

function withFakeGithub(t, record) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = githubStub(record);
  t.after(() => { globalThis.fetch = realFetch; });
}

test('owner question: the reasoning answer reaches the owner, grounded in the inspected source, and no job starts', async (t) => {
  const record = { models: [], dispatches: [] };
  withFakeGithub(t, record);
  const che = await owner(ANALYSIS, record);
  const { status, reply, done } = await che.say(OWNER_QUESTION);
  console.log('ANSWER>>>', reply);
  assert.equal(status, 200);
  assert.equal(done.source, 'che_repository_analysis', 'answered by the analysis route');
  assert.doesNotMatch(reply, /^VERIFIED|I inspected/m, 'no raw inspection receipt is the answer');
  assert.match(reply, /coding_runtime\.js/, 'the answer names real source the model was given');
  assert.match(reply, /weakness|repair/i);
  const prompt = JSON.stringify(record.models.at(-1)?.input || {});
  assert.match(prompt, /createSession/, 'the reasoning model received the real source excerpt');
  assert.deepEqual(record.dispatches, [], 'no coding job or workflow was dispatched');
});

test('owner question: when the reasoning model returns nothing, the owner is told so, not given a file index', async (t) => {
  const record = { models: [], dispatches: [] };
  withFakeGithub(t, record);
  const che = await owner(null, record);
  const { reply, done } = await che.say(OWNER_QUESTION);
  console.log('NO-MODEL>>>', reply);
  assert.equal(done.source, 'che_repository_analysis');
  assert.doesNotMatch(reply, /VERIFIED|I inspected/, 'a source listing is never sent in place of an answer');
  assert.match(reply, /did not return an answer|cannot give that analysis/);
  assert.match(reply, /Nothing was changed/);
  assert.deepEqual(record.dispatches, []);
});

test('a plain request for the file list still gets the verified list', async (t) => {
  const record = { models: [], dispatches: [] };
  withFakeGithub(t, record);
  const che = await owner(ANALYSIS, record);
  const { reply, done } = await che.say('Show me the files in your coding runtime.');
  assert.match(reply, /VERIFIED|I inspected/, 'an explicit listing request keeps the list');
  assert.deepEqual(record.dispatches, []);
});

test('the second read-only form, "How does your memory code work?", is answered from the source too', async (t) => {
  const record = { models: [], dispatches: [] };
  withFakeGithub(t, record);
  const che = await owner(ANALYSIS, record);
  const { reply, done } = await che.say('How does your memory code work? Explain it in plain English, do not create a job.');
  assert.equal(done.source, 'che_repository_analysis');
  assert.doesNotMatch(reply, /^VERIFIED/m);
  assert.deepEqual(record.dispatches, []);
});

test('review fix: reasoning wins over a listing phrase; a historical trigger needs a real historical cue', async (t) => {
  const { analyticalRepositoryQuestion, repositoryInspectionIntent } = await import('./code_scout.js');
  assert.equal(analyticalRepositoryQuestion('Explain why the coding runtime stalls, not as a file list.'), true);
  assert.equal(analyticalRepositoryQuestion('Explain why the coding runtime stalls and list the files involved.'), true);
  assert.equal(analyticalRepositoryQuestion('Explain why my last coding job failed and recommend a repair.'), true);
  assert.equal(analyticalRepositoryQuestion('Show me the files in your coding runtime.'), false);
  assert.equal(repositoryInspectionIntent('List the weaknesses in your coding architecture and explain each.'), true, 'an architecture question about CHE reaches the inspection');
});

test('review fix: an analysis that names the commit it read keeps its answer', async (t) => {
  const record = { models: [], dispatches: [] };
  withFakeGithub(t, record);
  const che = await owner(`1. The runtime waits on a runner. Repair: record a claim deadline. Read at commit ${HEAD}.`, record);
  const { reply, done } = await che.say(OWNER_QUESTION);
  assert.equal(done.source, 'che_repository_analysis');
  assert.match(reply, /claim deadline/, 'the analysis is not replaced for quoting a hash');
  assert.match(reply, new RegExp(HEAD));
});

test('review fix: a real execution claim in the analysis is still removed', async (t) => {
  const record = { models: [], dispatches: [] };
  withFakeGithub(t, record);
  const che = await owner(`I ran the coding runtime and the job completed successfully at commit ${HEAD}.`, record);
  const { reply } = await che.say(OWNER_QUESTION);
  assert.match(reply, /cannot verify/i);
  assert.doesNotMatch(reply, /job completed successfully/);
  assert.deepEqual(record.dispatches, []);
});

// Owner report (2026-10-21): "CHE, investigate Creator Studio read-only" was answered by the no-tools model with
// five nonexistent app/services files, a "pylint" run that passed, and dependencies. None of those is evidence.
const CREATOR_STUDIO_QUESTION = 'CHE, investigate Creator Studio read-only. Tell me which files you read, what the code does, and whether any tests or lint checks passed. Do not change anything.';
const FABRICATED = 'Creator Studio is handled by app/services/media.py, app/services/video_list.py and app/services/database.py. Authentication is in app/services/auth.py, routed from app/routes.py. I ran pylint on app/services/media.py and it passed with no warnings. The class MediaService stores uploads. The dependencies are pandas, sqlite3, google-cloud-storage and flask_login.';

test('creator studio: an investigation of a named room reads the source; the model never answers from its own file names', async (t) => {
  const record = { models: [], dispatches: [] };
  withFakeGithub(t, record);
  const che = await owner(FABRICATED, record);
  const { reply, done } = await che.say(CREATOR_STUDIO_QUESTION);
  assert.notEqual(done.source, 'model', 'the investigation no longer reaches the model without a tool');
  for (const path of ['app/services/media.py', 'app/services/video_list.py', 'app/services/database.py', 'app/services/auth.py', 'app/routes.py']) {
    assert.doesNotMatch(reply, new RegExp(path.replace(/[.]/g, '\\.')), `fabricated path ${path} must not reach the owner`);
  }
  assert.doesNotMatch(reply, /pylint|pandas|sqlite3|flask_login|google-cloud-storage|MediaService/);
  assert.deepEqual(record.dispatches, [], 'a read-only investigation starts no job');
});

test('creator studio: "show me my creator studio" is not a source investigation', async () => {
  const { repositoryInspectionIntent } = await import('./code_scout.js');
  assert.equal(repositoryInspectionIntent('CHE, investigate Creator Studio read-only. Which files implement it?'), true);
  assert.equal(repositoryInspectionIntent('Show me my creator studio.'), false);
  assert.equal(repositoryInspectionIntent('Open Creator Studio.'), false);
  const { analyticalRepositoryQuestion } = await import('./code_scout.js');
  assert.equal(analyticalRepositoryQuestion('CHE, investigate Creator Studio read-only. Tell me which files you read, what the code does, and whether any tests passed.'), true, 'what the code does is an explanation, not a listing');
});

test('creator studio: a general question that names fabricated files is refused on the model path', async () => {
  const record = { models: [], dispatches: [] };
  const che = await owner(FABRICATED, record);
  const { reply, done } = await che.say('Which files make up Creator Studio?');
  assert.notEqual(done.source, 'che_repository_inspection', 'no source read ran for this question');
  assert.doesNotMatch(reply, /app\/services|pylint|pandas/);
  assert.match(reply, /cannot verify/i);
});

test('creator studio: source claims are judged against the paths the read returned', async () => {
  const { guardExecutionClaims } = await import('./truth_layer.js');
  const verified = new Set(['server/cloudflare/worker.js']);
  assert.equal(guardExecutionClaims('It is in server/cloudflare/worker.js.', { verifiedPaths: verified }).removed.length, 0, 'a path the read returned is kept');
  assert.equal(guardExecutionClaims('It is in app/services/media.py.', { verifiedPaths: verified }).removed.length, 1, 'a path the read did not return is removed');
  assert.equal(guardExecutionClaims('It is in app/services/media.py.', {}).removed.length, 1, 'with no read, any named file is removed');
  assert.equal(guardExecutionClaims('See https://example.com/v1/data.json for the spec.').removed.length, 0, 'a URL is not a repository path');
  assert.equal(guardExecutionClaims('Pylint passed with no warnings.').removed.length, 1, 'a lint result with no run is removed');
  assert.equal(guardExecutionClaims('The dependencies are pandas and sqlite3.').removed.length, 1, 'an unverified dependency is removed');
  assert.equal(guardExecutionClaims('The class MediaService stores uploads.').removed.length, 1, 'a class name with no read is removed');
  assert.equal(guardExecutionClaims('Creator Studio is a room where you make videos.').removed.length, 0, 'ordinary product talk stays');
});
