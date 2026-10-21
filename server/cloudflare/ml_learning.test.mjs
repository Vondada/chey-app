// ML grades the owner can trust: real labeled data, held-out scoring, honest refusals when data is missing,
// stored runs that survive a Worker restart, and the owner's own sentence answered through /api/chat.
// The dataset is a fixture of real repository files (server/cloudflare/fixtures/ml/repo_files_labeled.json),
// with labels taken from each file's area. No demo examples are scored anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  classificationMetrics,
  mlProjectFromResult,
  mlResultsReply,
  parseMlPhrase,
  runClassificationJob,
  runClusteringJob,
  stratifiedSplit,
} from './ml_studio.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ml/repo_files_labeled.json', import.meta.url), 'utf8'));
const examples = fixture.examples;

const generated = new URL('./.ml_learning.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
try { worker = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } };
}

async function storageFor() {
  const saved = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, saved.get(x)])) : saved.get(k)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const sql = await sqlStorage();
  if (sql) storage.sql = sql;
  return storage;
}

// A paired owner on the given storage. Building a new CheState on the same storage is a Worker restart.
async function owner(storage) {
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => ({ response: 'I do not know.' }) },
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
    api: async (path, body) => {
      const res = await post(path, body, token);
      return { status: res.status, body: await res.json() };
    },
  };
}

test('the held-out split scores every label with two or more examples, and names the ones it cannot score', () => {
  const items = [
    { id: 'a1', label: 'a' }, { id: 'a2', label: 'a' }, { id: 'a3', label: 'a' }, { id: 'a4', label: 'a' },
    { id: 'b1', label: 'b' }, { id: 'b2', label: 'b' },
    { id: 'c1', label: 'c' },
  ];
  const { train, test, untested_labels } = stratifiedSplit(items, 0.25);
  assert.deepEqual(untested_labels, ['c'], 'a single example cannot be scored, so it is named');
  assert.equal(test.filter((e) => e.label === 'a').length, 1);
  assert.equal(test.filter((e) => e.label === 'b').length, 1);
  const trainIds = new Set(train.map((e) => e.id));
  for (const e of test) assert.equal(trainIds.has(e.id), false, 'no held-out example is also trained on');
  assert.equal(train.length + test.length, items.length);
});

test('a classification grade on the real repository dataset: counts, held-out size, and metrics that recompute', async () => {
  const result = await runClassificationJob({}, { examples, holdout: 0.25, dataset_name: fixture.description.slice(0, 40) });
  assert.equal(result.ok, true);
  assert.equal(result.dataset.n, 36);
  assert.deepEqual(result.dataset.label_counts, { 'worker-js': 12, 'flutter-dart': 12, 'docs-md': 12 });
  assert.equal(result.train_n, 27, 'three held-out examples per label');
  assert.equal(result.test_n, 9);
  assert.deepEqual(result.dataset.untested_labels, []);

  // Recompute accuracy and the confusion matrix from the saved predictions, independently of the metric code.
  const correct = result.predictions.filter((p) => p.truth === p.pred).length;
  assert.equal(result.metrics.accuracy, correct / result.test_n);
  const matrix = result.metrics.confusion_matrix;
  assert.equal(matrix.matrix.flat().reduce((a, b) => a + b, 0), result.test_n);
  matrix.labels.forEach((label, i) => {
    const rowTotal = matrix.matrix[i].reduce((a, b) => a + b, 0);
    assert.equal(rowTotal, result.predictions.filter((p) => p.truth === label).length, `row ${label} is its held-out support`);
  });
  // The recorded measurement on this fixture, deterministic: 5 of 9 held-out files correct.
  assert.equal(correct, 5);
  assert.match(matrix.summary, /^5\/9 correct$/);
});

test('a clustering grade on the same files: cluster sizes add up and the scores are in range', async () => {
  const result = await runClusteringJob({}, { examples: examples.map((e) => e.text), k: 3, dataset_name: 'repo_files_labeled' });
  assert.equal(result.ok, true);
  assert.equal(result.metrics.n, 36);
  const sizes = Object.values(result.metrics.cluster_sizes);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 36);
  assert.ok(result.metrics.silhouette >= -1 && result.metrics.silhouette <= 1);
  assert.ok(result.metrics.inertia > 0);
  assert.equal(result.assignments.length, 36);
});

test('too little labeled data is explained, with the counts, and no metric is produced', async () => {
  const few = await runClassificationJob({}, { examples: examples.slice(0, 3) });
  assert.equal(few.ok, false);
  assert.match(few.detail, /3 labeled/);
  assert.match(few.detail, /Not enough labeled examples to grade honestly/);
  assert.equal(few.metrics, undefined);

  const oneLabel = await runClassificationJob({}, { examples: examples.filter((e) => e.label === 'docs-md').slice(0, 8) });
  assert.equal(oneLabel.ok, false, 'one label cannot be graded against another');
  assert.match(oneLabel.detail, /docs-md 8/);
});

test('the owner words are read as a results request or a run request, and a run is never started with no data', () => {
  const show = parseMlPhrase(
    'CHE, evaluate your ML learning system and show me the actual results.',
    'che, evaluate your ml learning system and show me the actual results.',
  );
  assert.equal(show?.type, 'mlJob');
  assert.equal(show?.kind, 'results');
  assert.equal(parseMlPhrase('Run classification on my labels', 'run classification on my labels')?.kind, 'classification');
  assert.equal(parseMlPhrase('Show me the results of the trading lab', 'show me the results of the trading lab'), null, 'no ML cue, no ML route');
});

test('the results reply says when no evaluation exists, and reports a stored run with its dataset', async () => {
  assert.match(mlResultsReply([]), /No ML evaluation has been run/);
  const run = await runClassificationJob({}, { examples, holdout: 0.25, dataset_name: 'repo_files_labeled' });
  const project = mlProjectFromResult(run, 'grade the repository files');
  assert.equal(project.dataset.source, 'repo_files_labeled');
  const reply = mlResultsReply([project]);
  assert.match(reply, /55\.6 percent on 9 held-out examples/);
  assert.match(reply, /Dataset: repo_files_labeled, 36 examples/);
});

test('through /api/chat: no data means no grade, and "show me the actual results" reports only what is stored', async (t) => {
  const storage = await storageFor();
  const che = await owner(storage);

  const none = await che.say('CHE, evaluate your ML learning system and show me the actual results.');
  assert.match(none.reply, /No ML evaluation has been run/);
  assert.doesNotMatch(none.reply, /percent|accuracy/i, 'no grade is invented');

  const runNoData = await che.say('CHE, run classification on my labels.');
  assert.match(runNoData.reply, /No ML run started/);
  assert.doesNotMatch(runNoData.reply, /percent|accuracy/i, 'the demo set is never graded');
  assert.equal(runNoData.done.model_calls ?? 0, 0, 'an ML command is answered without the model');

  const denied = await che.api('/api/ml/run', { kind: 'classification', examples: examples.slice(0, 3) });
  assert.equal(denied.status, 400);
  assert.match(denied.body.detail, /Not enough labeled examples/);

  const stored = await che.api('/api/ml/run', { kind: 'classification', examples, holdout: 0.25, dataset_name: 'repo_files_labeled' });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.result.metrics.n, 9);
  assert.equal(stored.body.project.dataset.n, 36);

  const shown = await che.say('CHE, evaluate your ML learning system and show me the actual results.');
  assert.match(shown.reply, /1 stored ML run/);
  assert.match(shown.reply, /55\.6 percent on 9 held-out examples/);
  assert.match(shown.reply, /repo_files_labeled, 36 examples/);
});

test('a stored run is still there after a Worker restart on the same storage', async (t) => {
  const storage = await storageFor();
  const first = await owner(storage);
  await first.api('/api/ml/run', { kind: 'classification', examples, holdout: 0.25, dataset_name: 'repo_files_labeled' });

  const restarted = await owner(storage);
  const shown = await restarted.say('CHE, evaluate your ML learning system and show me the actual results.');
  assert.match(shown.reply, /1 stored ML run/, 'the run survives a restart');
  assert.match(shown.reply, /55\.6 percent/);
});
