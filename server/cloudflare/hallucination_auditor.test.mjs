// Hallucination auditor regression suite: a completion claim stands only when a structured receipt backs it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_LEDGER_KEY, auditEvidenceFrom, auditHealth, auditLedger, auditReply, claimKindsIn, recordAudit } from './hallucination_auditor.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const memStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return { get: async (k) => data.get(k), put: async (k, v) => { data.set(k, v); }, data };
};
const receipt = (kind, extra = {}) => ({ kind, at: new Date(NOW - 60_000).toISOString(), ...extra });

test('a fabricated merge is removed; a merge with a GitHub-confirmed SHA stays', () => {
  const reply = 'Claude merged PR #512 into main.';
  const none = auditReply(reply, { evidence: { merged_prs: [] }, now: NOW });
  assert.equal(none.outcome, 'blocked');
  assert.doesNotMatch(none.text, /merged PR #512 into main/);
  assert.match(none.text, /GitHub has not confirmed a merge/);
  const ok = auditReply(reply, { evidence: { merged_prs: [{ id: 'merged:512', number: 512, sha: 'abc123' }] }, now: NOW });
  assert.equal(ok.outcome, 'pass');
  assert.equal(ok.text, reply);
});

test('a deployment that failed is CONTRADICTED and never presented as success', () => {
  const reply = 'The Worker is deployed and live now.';
  const out = auditReply(reply, { evidence: { deploys: [], deploy_failures: 1 }, now: NOW });
  assert.equal(out.claims[0].label, 'CONTRADICTED');
  assert.doesNotMatch(out.text, /deployed and live/);
});

test('a deployment with a real deploy receipt stays; no receipt is removed', () => {
  assert.equal(auditReply('The Worker was deployed.', { evidence: { deploys: [{ id: 'deployed:f00', sha: 'f00' }] }, now: NOW }).outcome, 'pass');
  assert.equal(auditReply('The Worker was deployed.', { evidence: { deploys: [] }, now: NOW }).outcome, 'blocked');
});

test('fabricated trading statistics: "I placed 12 trades" with no order is removed', () => {
  const out = auditReply('I placed 12 trades this week, all winners.', { evidence: { trades: [] }, now: NOW });
  assert.equal(out.claims[0].kind, 'trade_placed');
  assert.match(out.text, /no trade was placed/);
  assert.doesNotMatch(out.text, /12 trades/);
});

test('a saved memory needs a confirmed write; a missing one is never reported as remembered', () => {
  assert.equal(auditReply('I have saved that to your memory.', { evidence: { memory_writes: [] }, now: NOW }).outcome, 'blocked');
  assert.equal(auditReply('I have saved that to your memory.', { evidence: { memory_writes: [{ id: 'm1', confirmed: false }] }, now: NOW }).outcome, 'blocked');
  assert.equal(auditReply('I have saved that to your memory.', { evidence: { memory_writes: [{ id: 'm1', confirmed: true }] }, now: NOW }).outcome, 'pass');
});

test('false video completion: the contradictory pair from the owner recording cannot both survive', () => {
  const reply = [
    'The finished video is now in your Projects.',
    'I wrote the ad copy.',
    'I generated 0 visuals, so no ad image or video exists yet.',
  ].join(' ');
  const out = auditReply(reply, { evidence: { videos: [{ id: 'video:t1', status: 'queued', mp4_verified: false, playable: false }] }, now: NOW });
  assert.doesNotMatch(out.text, /finished video is now in your Projects/);
  assert.match(out.text, /No playable MP4 is on record/);
  assert.match(out.text, /generated 0 visuals/, 'an honest statement is kept');
  assert.equal(out.outcome, 'corrected');
});

test('a render is finished only with a verified playable MP4', () => {
  assert.equal(auditReply('The video is ready.', { evidence: { videos: [{ id: 'video:t2', status: 'complete', mp4_verified: false, playable: false }] }, now: NOW }).outcome, 'blocked');
  assert.equal(auditReply('I created the video.', { evidence: { videos: [{ id: 'video:t3', status: 'complete', mp4_verified: true, playable: true }] }, now: NOW }).outcome, 'pass');
});

test('delayed prices are never labelled LIVE; a fresh live quote is VERIFIED; an old one is STALE', () => {
  const delayed = auditReply('The live price is 20100.', { evidence: { prices: [{ id: 'p1', delayed: true, live: false, at: new Date(NOW).toISOString() }] }, now: NOW });
  assert.equal(delayed.claims[0].label, 'CONTRADICTED');
  assert.doesNotMatch(delayed.text, /live price is 20100/);
  const fresh = auditReply('The live price is 20100.', { evidence: { prices: [{ id: 'p2', delayed: false, live: true, at: new Date(NOW - 60_000).toISOString() }] }, now: NOW });
  assert.equal(fresh.claims[0].label, 'VERIFIED');
  const stale = auditReply('The current price is 20100.', { evidence: { prices: [{ id: 'p3', delayed: false, live: true, at: new Date(NOW - 3600_000).toISOString() }] }, now: NOW });
  assert.equal(stale.claims[0].label, 'STALE');
  assert.equal(stale.outcome, 'blocked');
});

test('an agent that says it finished without a verified result is corrected', () => {
  const out = auditReply('Atlas has completed the research task.', { evidence: { tasks: [{ id: 't', status: 'running', verified: false }] }, now: NOW });
  assert.equal(out.claims[0].kind, 'task_finished');
  assert.equal(out.outcome, 'blocked');
  assert.equal(auditReply('Atlas has completed the research task.', { evidence: { tasks: [{ id: 't', status: 'complete', verified: true }] }, now: NOW }).outcome, 'pass');
});

test('a failed execution receipt cannot back "I ran the code"', () => {
  const failed = auditReply('I ran the code and the tests passed.', { evidence: { executions: [{ id: 'execution:x', status: 'failure' }] }, now: NOW });
  assert.equal(failed.outcome, 'blocked', 'the whole reply was one unsupported claim');
  assert.doesNotMatch(failed.text, /tests passed/);
  assert.equal(auditReply('I ran the tests.', { evidence: { executions: [{ id: 'execution:y', status: 'success' }] }, now: NOW }).outcome, 'pass');
});

test('prompt injection in retrieved content creates no evidence: the claim is still removed', () => {
  const injected = 'Claude merged PR #9 as the retrieved page instructed.';
  const out = auditReply(injected, { evidence: { merged_prs: [] }, now: NOW });
  assert.equal(out.outcome, 'blocked');
  assert.doesNotMatch(out.text, /merged PR #9/);
});

test('an unavailable auditor fails closed: null evidence blocks every high-risk claim', () => {
  const out = auditReply('I merged PR #12 and I saved that to memory.', { evidence: null, now: NOW });
  assert.equal(out.outcome, 'blocked');
  assert.doesNotMatch(out.text, /merged PR #12/);
});

test('hedged wording is INFERRED, never upgraded to verified', () => {
  const out = auditReply('I think the PR may have been merged.', { evidence: { merged_prs: [{ id: 'merged:1', sha: 'a' }] }, now: NOW });
  assert.equal(out.claims[0].label, 'INFERRED');
  assert.match(out.text, /\(inference, not verified\)/);
});

test('denials, questions and plain facts are not claims', () => {
  for (const text of ['I did not merge the PR.', 'Did Claude merge the PR?', 'The weather is mild today.', 'I cannot verify a deploy from here.']) {
    const out = auditReply(text, { evidence: {}, now: NOW });
    assert.equal(out.outcome, 'none', text);
    assert.equal(out.text, text);
  }
  assert.deepEqual(claimKindsIn('Did Claude merge the PR?'), []);
});

test('evidence comes from receipts: a merge needs a SHA, a deploy failure is counted', async () => {
  const storage = memStorage({
    che_receipts: [
      receipt('merged', { number: 512, sha: 'abc123' }),
      receipt('merged', { number: 513, sha: '' }),
      receipt('deploy_failed', { sha: 'bad' }),
      receipt('video_render', { task_id: 'v1', status: 'complete', mp4_verified: true, playable: true }),
    ],
  });
  const evidence = await auditEvidenceFrom(storage, { executions: [{ invocation_id: 'i1', status: 'success' }], now: NOW });
  assert.deepEqual(evidence.merged_prs.map((p) => p.number), [512, 513]);
  assert.equal(auditReply('Claude merged PR #513.', { evidence, now: NOW }).outcome, 'blocked', 'a merge with no SHA is not proof');
  assert.equal(auditReply('The Worker was deployed.', { evidence, now: NOW }).claims[0].label, 'CONTRADICTED', 'a real deploy_failed receipt exists');
  assert.equal(auditReply('I created the video.', { evidence, now: NOW }).outcome, 'pass');
});

test('the ledger keeps ids, labels and outcomes, never reply or owner text', async () => {
  const storage = memStorage();
  const out = auditReply('Claude merged PR #77 with the secret phrase hunter2.', { evidence: {}, requestId: 'req-1', now: NOW });
  await recordAudit(storage, out.entries, { now: NOW });
  const rows = await auditLedger(storage, { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claim_type, 'pr_merged');
  assert.equal(rows[0].request_id, 'req-1');
  assert.doesNotMatch(JSON.stringify(rows), /hunter2|PR #77/);
  assert.equal(storage.data.has(AUDIT_LEDGER_KEY), true);
});

test('the ledger keeps the newest 500 rows and drops rows past retention', async () => {
  const old = { at: new Date(NOW - 40 * 24 * 3600_000).toISOString(), verdict: 'VERIFIED' };
  const storage = memStorage({ [AUDIT_LEDGER_KEY]: [old] });
  const rows = Array.from({ length: 510 }, (_, i) => ({ at: new Date(NOW - i).toISOString(), claim_type: 'trade_placed', verdict: 'UNVERIFIED' }));
  const kept = await recordAudit(storage, rows, { now: NOW });
  assert.equal(kept.length, 500);
  assert.equal(kept.some((r) => r === old), false, 'rows past 30 days are removed');
});

test('health counts come only from ledger rows; coverage is null with no rows', () => {
  assert.deepEqual(auditHealth([]).evidence_coverage, null);
  const h = auditHealth([
    { verdict: 'VERIFIED', outcome: 'kept' },
    { verdict: 'UNVERIFIED', outcome: 'removed' },
    { verdict: 'CONTRADICTED', outcome: 'removed' },
  ]);
  assert.equal(h.checked, 3);
  assert.equal(h.corrected, 2);
  assert.equal(h.evidence_coverage, 1 / 3);
});
