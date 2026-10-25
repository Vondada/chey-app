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

test('a requested story keeps its first-person narration (Codex review, #509)', () => {
  const story = 'I read the book by candlelight. Then I merged the PR in my dream.';
  const out = auditReply(story, { evidence: {}, now: NOW, fiction: true });
  assert.equal(out.outcome, 'none');
  assert.equal(out.text, story);
  assert.deepEqual(out.entries, []);
  assert.equal(auditReply(story, { evidence: {}, now: NOW }).outcome, 'blocked', 'the same text outside a story is still audited');
});

test('every claim type in one sentence is judged: a deploy receipt cannot carry a live-price claim (Codex review, #509)', () => {
  const out = auditReply('The Worker was deployed and the live price is 20100.', { evidence: { deploys: [{ id: 'deployed:f00', sha: 'f00' }], prices: [] }, now: NOW });
  assert.equal(out.outcome, 'blocked');
  assert.deepEqual(out.claims.map((c) => `${c.kind}:${c.label}`).sort(), ['live_price:UNVERIFIED', 'worker_deployed:VERIFIED']);
  assert.doesNotMatch(out.text, /live price is 20100/);
  assert.match(out.text, /cannot give a live price/);
  assert.equal(out.entries.length, 2, 'both claims are in the ledger');
  const both = auditReply('The Worker was deployed and the live price is 20100.', { evidence: { deploys: [{ id: 'deployed:f00', sha: 'f00' }], prices: [{ id: 'p', live: true, delayed: false, at: new Date(NOW).toISOString() }] }, now: NOW });
  assert.equal(both.outcome, 'pass');
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
      // Only the video_verified receipt (action_receipts.js, written after the real file check) proves a file.
      receipt('video_render', { task_id: 'v1', status: 'complete', mp4_verified: true, playable: true }),
      receipt('video_verified', { task_id: 'v1', status: 'complete', mp4_verified: true, playable: true }),
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

// ─── The two owner questions answered from records ────────────────────────────
import { knowVsGuessQuestion, knowVsGuessReply, memorySavedQuestion, memorySavedReply } from './hallucination_auditor.js';

test('"Did you save that memory?" is recognised in the owner\'s phrasings and nothing else', () => {
  for (const q of ['Did you save that memory?', 'did you save that?', 'Have you stored that memory, sir?', 'CHE, did you remember that?', 'Did you actually save it?']) assert.equal(memorySavedQuestion(q), true, q);
  for (const q of ['Did you save my notes?', 'Did you keep that fact?']) assert.equal(memorySavedQuestion(q), true, q);
  // "What did you save?" right after a memory write reads the same receipt (subject-loss audit, 2026-10-24).
  for (const q of ['What did you save?', 'what did you just remember', 'What did you store for me?']) assert.equal(memorySavedQuestion(q), true, q);
  // Codex review (#509): a file or document is not CHE's memory, so these are not memory-receipt questions.
  for (const q of ['Save that memory.', 'Did you save money on the order?', 'Remember my favorite drink is Sprite', 'Did you save the file?', 'Did you save my document?', 'Did you save the draft to Drive?', 'What did you save the file as?']) assert.equal(memorySavedQuestion(q), false, q);
});

test('a memory_saved receipt in the window answers yes with the record; none answers no', async () => {
  const none = await memorySavedReply(memStorage({ che_receipts: [] }), { now: NOW });
  assert.match(none.text, /^No, sir/);
  assert.equal(none.saved, null);
  const old = receipt('memory_saved', { at: new Date(NOW - 3600_000).toISOString(), record_id: 'old', text: 'x' });
  assert.match((await memorySavedReply(memStorage({ che_receipts: [old] }), { now: NOW })).text, /^No, sir/, 'an hour-old write is not this conversation');
  const fresh = receipt('memory_saved', { record_id: 'abcdef12-3456', text: 'My favorite drink is Sprite' });
  const yes = await memorySavedReply(memStorage({ che_receipts: [fresh] }), { now: NOW });
  assert.match(yes.text, /^Yes, sir\. I saved "My favorite drink is Sprite"/);
  assert.match(yes.text, /record abcdef12/);
});

test('a memory_saved receipt is auditor evidence only inside the conversation window', async () => {
  const storage = memStorage({ che_receipts: [receipt('memory_saved', { record_id: 'm1', text: 't' }), receipt('memory_saved', { at: new Date(NOW - 3600_000).toISOString(), record_id: 'm0', text: 't' })] });
  const evidence = await auditEvidenceFrom(storage, { now: NOW });
  assert.deepEqual(evidence.memory_writes.map((w) => w.id), ['memory:m1']);
  assert.equal(auditReply('I have saved that to your memory.', { evidence, now: NOW }).outcome, 'pass');
});

test('"what do you know versus what are you guessing?" is answered from owner records and the ledger', () => {
  for (const q of ['What do you know versus what are you guessing?', 'what do you know vs what are you assuming', 'What do you know for sure?', 'What are you guessing?']) assert.equal(knowVsGuessQuestion(q), true, q);
  assert.equal(knowVsGuessQuestion('Do you know my favorite drink?'), false);
  const records = [
    { text: 'My favorite drink is Sprite', source: 'owner_chat', verification_status: 'owner_attested', created_at: '2026-10-23T11:00:00Z' },
    { text: 'The owner likes jazz', source: 'inferred_text', verification_status: 'unverified', created_at: '2026-10-23T11:00:00Z' },
  ];
  const ledger = [{ at: new Date(NOW - 1000).toISOString(), verdict: 'VERIFIED', outcome: 'kept' }, { at: new Date(NOW - 1000).toISOString(), verdict: 'UNVERIFIED', outcome: 'removed' }];
  const out = knowVsGuessReply({ records, ledger, lastEvidence: { kind: 'owner_attested' }, now: NOW });
  assert.equal(out.owned, 1, 'only the owner-attested record counts as known');
  assert.match(out.text, /1 fact you told me yourself.*"My favorite drink is Sprite"/);
  assert.doesNotMatch(out.text, /jazz/);
  assert.match(out.text, /checked 2 claims: 1 verified, 0 labelled inference, 1 removed/);
  assert.match(out.text, /previous answer was built from your own records/);
  const empty = knowVsGuessReply({ records: [], ledger: [], now: NOW });
  assert.match(empty.text, /nothing yet in your own words/);
  assert.match(empty.text, /checked no completion claims/);
});

test('a text brief about a track is not read as generated audio (review of #534)', () => {
  const kept = auditReply("I've created a production brief for your track.");
  assert.match(kept.text, /production brief for your track/);
  assert.equal(kept.claims.some((c) => c.kind === 'audio_made'), false);
});

test('a real audio claim is still caught when a brief is mentioned as well (review of #534)', () => {
  const caught = auditReply("I've created a song and wrote a brief.");
  assert.equal(caught.claims.some((c) => c.kind === 'audio_made'), true);
});

test('a guest denial of record access is kept as written, while owners still get the records correction (review of #534)', () => {
  const denial = 'I cannot access your memory.';
  assert.equal(auditReply(denial, { ownerRecords: false }).text, denial);
  assert.notEqual(auditReply(denial).text, denial);
});

test('an agent research claim with no execution record is removed (owner test on iPhone, 2026-10-25)', () => {
  const r = auditReply('Mira researched the market and found three strong setups.', { evidence: {} });
  assert.equal(r.outcome, 'blocked');
  assert.doesNotMatch(r.text, /Mira researched/);
  assert.match(r.text, /No execution record shows an agent doing that work/);
  assert.equal(r.entries[0].claim_type, 'agent_research');
});

test('an agent research claim is kept when that agent has a verified, completed task', () => {
  const evidence = { agent_tasks: [{ id: 'task-1', status: 'complete', verified: true, agent_name: 'Mira' }] };
  const r = auditReply('Mira researched the market and wrote a short report.', { evidence });
  assert.equal(r.outcome, 'pass');
  assert.match(r.text, /Mira researched the market/);
});

test('a claim about one agent is not proved by another agent\'s task', () => {
  const evidence = { agent_tasks: [{ id: 'task-2', status: 'complete', verified: true, agent_name: 'Nova' }] };
  const r = auditReply('Atlas backtested the strategies.', { evidence });
  assert.equal(r.outcome, 'blocked');
  assert.doesNotMatch(r.text, /Atlas backtested/);
});

test('an unfinished or unverified agent task does not prove research', () => {
  const evidence = { agent_tasks: [
    { id: 't3', status: 'running', verified: false, agent_name: 'Atlas' },
    { id: 't4', status: 'complete', verified: false, agent_name: 'Atlas' },
  ] };
  assert.equal(auditReply('Atlas tested the setup.', { evidence }).outcome, 'blocked');
});

test('a hedged guess about agent work is not presented as a completed claim', () => {
  const r = auditReply('Nova may have checked the news already.', { evidence: {} });
  assert.equal(r.outcome, 'none');
  assert.equal(r.text, 'Nova may have checked the news already.');
});
