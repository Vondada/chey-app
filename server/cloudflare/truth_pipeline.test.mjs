// Truth pipeline: the guard order is fixed, every stage's removal reaches the one ledger, and a stage that throws
// fails closed (the reply still reaches the auditor, and null evidence blocks completion claims).
import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_LEDGER_KEY } from './hallucination_auditor.js';
import { TRUTH_STAGE_ORDER, TRUTH_STAGES, replySteps, verifyReply } from './truth_pipeline.js';

const memStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return { get: async (k) => data.get(k), put: async (k, v) => { data.set(k, v); }, data };
};
const auditor = TRUTH_STAGES.find((s) => s.name === 'auditor');
const baseCtx = (storage) => ({ storage, body: {}, data: {}, env: {}, rawMessage: 'hello', message: 'hello', skillResults: [] });

test('the stage order is exactly the order worker.js ran before the pipeline existed', () => {
  assert.deepEqual([...TRUTH_STAGE_ORDER], [
    'truth_layer', 'research_actions', 'owner_actions', 'citations', 'grounding', 'asset_truth', 'capability_gap',
    'attribution', 'agent_task', 'answer_receipt', 'wake_text', 'pretend_tool_call', 'execution_claims', 'auditor',
    'engine_claims', 'vision_note',
  ]);
  assert.equal(new Set(TRUTH_STAGE_ORDER).size, TRUTH_STAGE_ORDER.length, 'no duplicate stage names');
  for (const stage of TRUTH_STAGES) assert.equal(typeof stage.run, 'function', stage.name);
});

test('each stage\'s removal lands in the ledger under that stage\'s name, with one request id', async () => {
  const storage = memStorage();
  const stages = [
    { name: 'alpha', run: (reply) => ({ text: reply.replace(' A', ''), removed: [{ rule: 'r1', sentence: 'A' }] }) },
    { name: 'beta', run: (reply) => ({ text: reply, removed: ['B'] }) },
    { name: 'gamma', run: (reply) => ({ text: reply, removed: [] }) },
    auditor,
  ];
  const out = await verifyReply('Hello A there.', { ...baseCtx(storage), requestId: 'req-7' }, { stages });
  assert.equal(out.text, 'Hello there.');
  const rows = storage.data.get(AUDIT_LEDGER_KEY);
  assert.deepEqual(rows.map((r) => r.claim_type), ['alpha:r1', 'beta']);
  assert.ok(rows.every((r) => r.request_id === 'req-7' && r.outcome === 'removed' && r.verdict === 'UNVERIFIED'));
  assert.doesNotMatch(JSON.stringify(rows), /Hello|there/, 'the ledger never holds reply text');
  assert.equal(out.audit.outcome, 'none');
});

test('a stage that throws is skipped and the reply still reaches the auditor', async () => {
  const storage = memStorage();
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const stages = [
      { name: 'boom', run: () => { throw new Error('stage exploded'); } },
      { name: 'after', run: (reply) => ({ text: `${reply} (after ran)`, removed: [] }) },
      auditor,
    ];
    const out = await verifyReply('Claude merged PR #42 into main.', { ...baseCtx(storage), requestId: 'req-8' }, { stages });
    assert.ok(logs.some((l) => l.startsWith('CHE truth stage boom failed')), 'the failure is logged');
    assert.doesNotMatch(out.text, /merged PR #42/, 'the unbacked claim is removed by the auditor');
    assert.match(out.text, /after ran/, 'later stages still ran');
    assert.equal(out.audit.outcome, 'corrected');
    assert.ok(storage.data.get(AUDIT_LEDGER_KEY).some((r) => r.claim_type === 'pr_merged'));
  } finally {
    console.log = original;
  }
});

test('an unavailable auditor fails closed: completion claims are blocked and earlier removals still recorded', async () => {
  const storage = memStorage();
  const original = console.log;
  console.log = () => {};
  try {
    // loadReceipts swallows storage errors, so the evidence build is broken another way: a malformed tool-result list.
    const stages = [{ name: 'alpha', run: (reply) => ({ text: reply, removed: ['x'] }) }, auditor];
    const out = await verifyReply('The Worker was deployed. The sky is blue.', { ...baseCtx(storage), skillResults: { malformed: true } }, { stages });
    assert.doesNotMatch(out.text, /was deployed/);
    assert.match(out.text, /sky is blue/);
    assert.equal(out.audit.outcome, 'unavailable');
    assert.deepEqual(storage.data.get(AUDIT_LEDGER_KEY).map((r) => r.claim_type), ['alpha']);
  } finally {
    console.log = original;
  }
});

test('an early response ends the pipeline and is returned as-is', async () => {
  const marker = { kind: 'response' };
  const stages = [
    { name: 'first', run: (reply) => ({ text: `${reply}!`, removed: [] }) },
    { name: 'early', run: () => ({ text: 'ignored', removed: [], earlyResponse: marker }) },
    { name: 'never', run: () => { throw new Error('must not run'); } },
  ];
  const out = await verifyReply('Hi', { ...baseCtx(memStorage()) }, { stages });
  assert.equal(out.earlyResponse, marker);
  assert.equal(out.text, 'Hi!');
});

test('steps come from this turn\'s real Office and tool results only', () => {
  const steps = replySteps({
    createdPartners: [{ name: 'Nova', role: 'Writer' }],
    officeResults: [{ partner_id: 'p1', partner_name: 'Atlas', role: 'Research', error: '' }, { partner_id: 'p2', partner_name: 'Knox', role: 'Security', error: 'timeout' }],
    officePeerReview: true,
    skillResults: [{ ok: true, plugin: 'gmail', tool: 'read' }, { ok: false, plugin: 'drive', tool: 'list', error: 'denied' }],
  });
  assert.deepEqual(steps.map((s) => s.text), [
    'Added Nova (Writer) to the Office', '✓ Atlas delivered (Research)', 'Knox couldn’t finish', '✓ Cross-checked the team’s findings',
    '✓ Used gmail · read', 'drive · list failed: denied',
  ]);
  assert.deepEqual(replySteps({}), []);
});

test('Codex (#511): a failed disproven-claim write never lets the unsanitized reply through', async () => {
  const storage = memStorage();
  const original = console.log;
  const originalFetch = globalThis.fetch;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  // The guard opens the cited link itself; here the site answers 404, so the citation is a newly broken one.
  globalThis.fetch = async () => new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } });
  try {
    const citations = TRUTH_STAGES.find((s) => s.name === 'citations');
    const self = { recordDisprovenClaims: async () => { throw new Error('storage is down'); } };
    const research = { sources: [], articles: [] };
    const reply = 'The sky is blue. See https://example.com/missing for the full report.';
    const out = await verifyReply(reply, { ...baseCtx(storage), self, research, disproven: [], rawMessage: 'what colour is the sky', message: 'what colour is the sky' }, { stages: [citations] });
    assert.doesNotMatch(out.text, /example\.com\/missing/, 'the broken citation is removed even though the bookkeeping threw');
    assert.notEqual(out.text, reply, 'the guard\'s sanitized result is what goes on, not the original reply');
    assert.ok(logs.some((l) => l.startsWith('CHE disproven claims not recorded')), 'the failed write is logged, not fatal');
  } finally {
    console.log = original;
    globalThis.fetch = originalFetch;
  }
});

test('Codex (#511): the auditor stage keeps a story the owner asked for, in both its normal and fallback paths', async () => {
  const story = 'I read the book under a tree. The birds sang.';
  const asked = 'Write a short first-person story about reading a book.';
  const normal = await verifyReply(story, { ...baseCtx(memStorage()), rawMessage: asked, message: asked }, { stages: [auditor] });
  assert.equal(normal.text, story);
  const original = console.log;
  console.log = () => {};
  try {
    const fallback = await verifyReply(story, { ...baseCtx(memStorage()), rawMessage: asked, message: asked, skillResults: { malformed: true } }, { stages: [auditor] });
    assert.equal(fallback.text, story, 'the unavailable-auditor path honours the same exemption');
    assert.equal(fallback.audit.outcome, 'unavailable');
  } finally {
    console.log = original;
  }
  const factual = await verifyReply(story, { ...baseCtx(memStorage()), rawMessage: 'did you read the book', message: 'did you read the book' }, { stages: [auditor] });
  assert.doesNotMatch(factual.text, /I read the book/, 'without a story request the claim still needs a receipt');
});
