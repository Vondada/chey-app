import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';
import { auditSignificance, brainReviewIntent, buildDailyReview, latestReview, ownerScore, recordAudit, runBrainMaintenance, speakReview } from './brain_audit.js';

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

const T0 = '2026-10-16T22:00:00.000Z';
const NOW = '2026-10-17T07:07:00.000Z';

function seed(store) {
  store.put({ id: 'conv:a', kind: 'conversation', region: BRAIN_REGIONS.conversations, path: 'Chat/2026-10-16', title: 'Trading bot', body: 'You said: what about the bot\nCHE answered: it is paused.', verification: 'owner_attested' }, { now: '2026-10-16T23:00:00.000Z' });
  store.put({ id: 'conv:b', kind: 'correction', region: BRAIN_REGIONS.conversations, path: 'Corrections', title: 'Ana not Anna', body: 'You said: my sister is Ana, not Anna.\nCHE answered: Noted, sir.', verification: 'owner_attested' }, { now: '2026-10-16T23:30:00.000Z' });
  store.put({ id: 'conv:c', kind: 'correction', region: BRAIN_REGIONS.conversations, path: 'Corrections', title: 'Lisbon not Porto', body: 'You said: she lives in Lisbon, not Porto.\nCHE answered: Corrected.', verification: 'owner_attested' }, { now: '2026-10-17T01:00:00.000Z' });
  store.put({ id: 'mem:1', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Family', title: 'Sister', body: 'My sister Ana lives in Lisbon.', verification: 'owner_attested' }, { origin: 'iphone', now: '2026-10-17T02:00:00.000Z' });
  store.put({ id: 'task:1', kind: 'task', region: BRAIN_REGIONS.tasks, path: 'Historical', title: 'Research silver', body: 'Status: failed', source: { kind: 'team_task', status: 'failed' }, verification: 'unverified_reference' }, { now: '2026-10-17T03:00:00.000Z' });
  store.put({ id: 'task:2', kind: 'task', region: BRAIN_REGIONS.tasks, path: 'Historical', title: 'Draft thumbnails', body: 'Status: failed', source: { kind: 'team_task', status: 'failed' }, verification: 'unverified_reference' }, { now: '2026-10-17T03:10:00.000Z' });
  store.put({ id: 'task:3', kind: 'task', region: BRAIN_REGIONS.tasks, path: 'Historical', title: 'Summarize mail', body: 'Status: done', source: { kind: 'team_task', status: 'done' }, verification: 'unverified_reference' }, { now: '2026-10-17T03:20:00.000Z' });
  store.put({ id: 'note:h', kind: 'note', region: BRAIN_REGIONS.trading, path: 'Ideas', title: 'Silver may rise next week', body: 'The momentum signal suggests silver rises next week.', verification: 'hypothesis' }, { now: '2026-10-17T04:00:00.000Z' });
  store.put({ id: 'phone:q1', kind: 'queued_request', region: BRAIN_REGIONS.tasks, path: 'Queued offline', title: 'send the report to Claude', body: 'Queued, not run (offline): send the report to Claude', verification: 'unknown', source: { kind: 'queued_request', status: 'queued' } }, { origin: 'iphone', now: '2026-10-17T05:00:00.000Z' });
  // Old, significant, never verified: the auditor should flag it, not change it.
  store.put({ id: 'note:old', kind: 'decision', region: BRAIN_REGIONS.business, path: 'Decisions', title: 'Price thumbnails at 25 dollars', body: 'Decision: thumbnails are priced at 25 dollars each from October.', verification: 'unverified_reference', created_at: '2026-09-01T00:00:00.000Z' }, { now: '2026-09-01T00:00:00.000Z' });
}

test('the auditor re-scores with explained reasons, leaves owner scores alone, and flags old unverified significant records', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  seed(store);
  // Simulate a record stored under older rules: strip its significance.
  storage.sql.exec("UPDATE brain_records SET significance = '{}' WHERE id = 'conv:b'");
  const owner = ownerScore(store, 'note:h', 0.95, { reason: 'I want to watch silver', now: NOW });
  assert.equal(owner.outcome, 'reassessed');
  assert.equal(store.get('note:h').significance.owner_score, 0.95);
  assert.equal(store.get('note:h').significance.owner_reason, 'I want to watch silver');
  const revBefore = store.get('note:h').rev;

  const audit = auditSignificance(store, { now: NOW });
  assert.equal(audit.available, true);
  assert.equal(audit.examined, 10);
  assert.ok(audit.changed >= 1, 'the stripped record was re-scored');
  assert.equal(store.get('conv:b').significance.auditor, 'rules_v1');
  assert.ok(store.get('conv:b').significance.reasons.includes('a correction of something CHE got wrong'));
  assert.equal(store.get('note:h').rev, revBefore, 'an owner-scored record is not rewritten by the auditor');
  assert.equal(audit.top[0].id, 'note:h');
  assert.equal(audit.top[0].auditor, 'owner');
  assert.equal(audit.flagged.length, 1);
  assert.equal(audit.flagged[0].id, 'note:old');
  assert.match(audit.flagged[0].reason, /unverified reference for 46 days/);
  const again = auditSignificance(store, { now: NOW });
  assert.equal(again.changed, 0, 'a second pass changes nothing');
  assert.equal(ownerScore(store, 'nope', 0.5).outcome, 'missing');
  assert.equal(ownerScore(store, 'note:h', 'high').outcome, 'rejected');
});

test('the daily review is built from real activity only, labels every section, and is not written for an empty day', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  const empty = buildDailyReview(store, { now: NOW, since: T0 });
  assert.equal(empty.written, false);
  assert.match(empty.reason, /No Brain activity/);
  assert.equal(store.status().records, 0, 'nothing was written for show');

  seed(store);
  const result = runBrainMaintenance(store, { now: NOW, since: T0 });
  assert.equal(result.review.written, true);
  assert.equal(result.audit.written, true);
  const review = store.get('review:brain:2026-10-17');
  assert.equal(review.region, BRAIN_REGIONS.audits);
  assert.equal(review.verification, 'verified_source');
  assert.equal(review.source.computed, true);
  for (const label of ['FACT', 'INFERENCE', 'HYPOTHESIS', 'RECOMMENDATION', 'INTERPRETATION', 'UNKNOWN']) {
    assert.match(review.body, new RegExp(`^${label}$`, 'm'), `${label} section present`);
  }
  assert.match(review.body, /1 conversation with the owner kept word for word\./);
  assert.match(review.body, /2 corrections from the owner\./);
  assert.match(review.body, /1 owner memory saved\./);
  assert.match(review.body, /3 agent tasks touched: 1 done, 2 failed, 0 still live\./);
  assert.match(review.body, /2 records came from the phone\./);
  assert.match(review.body, /Most agent work failed today \(2 of 3\); rule: failed > done\./);
  assert.match(review.body, /corrected CHE 2 times; rule: two or more/);
  assert.match(review.body, /Silver may rise next week \(hypothesis, not a fact\)\./);
  assert.match(review.body, /1 request queued offline has not run; nothing was sent or spent\./);
  assert.match(review.body, /1 significant record has been unverified for over 14 days; the first: Price thumbnails at 25 dollars\./);
  assert.match(review.body, /INTERPRETATION\n- A day where the agents struggled more than they delivered\. \(an interpretation, not a fact\)/);
  assert.match(review.body, /Anything that happened outside the Brain/);
  assert.doesNotMatch(review.body, /Whether the phone synced today/, 'phone records arrived, so that is not unknown');
  assert.ok(review.links.some((l) => l.type === 'discovered_by_audit' && l.to === 'conv:b'));
  assert.ok(review.links.some((l) => l.type === 'requires_verification' && l.to === 'note:old'));
  assert.match(result.review.speech, /^Good morning, sir\. Your Brain review for 2026-10-17\./);
  assert.match(result.review.speech, /My reading, which is only a reading:/);
  assert.deepEqual(result.review.counts, { conversations: 1, corrections: 2, memories: 1, lessons: 0, tasks: 3, tasks_done: 1, tasks_failed: 2, queued: 1, open_conflicts: 0, flagged: 1 });

  const audit = store.get('audit:2026-10-17');
  assert.equal(audit.kind, 'audit');
  assert.match(audit.body, /10 records examined/);
  assert.match(audit.body, /Needs verification:/);
  const latest = latestReview(store);
  assert.equal(latest.review.id, 'review:brain:2026-10-17');
  assert.equal(latest.audit.id, 'audit:2026-10-17');

  // The same morning twice: the review is rewritten in place (same id), nothing duplicated.
  const second = runBrainMaintenance(store, { now: NOW, since: T0 });
  assert.equal(second.review.written, true);
  assert.equal(store.status().by_kind.daily_review, 1);
  assert.equal(store.status().by_kind.audit, 1);
});

test('a quiet day after a busy one writes nothing new', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  seed(store);
  runBrainMaintenance(store, { now: NOW, since: T0 });
  const before = store.status().seq;
  const next = runBrainMaintenance(store, { now: '2026-10-18T07:07:00.000Z', since: '2026-10-17T07:08:00.000Z' });
  assert.equal(next.review.written, false);
  assert.equal(next.audit.written, false);
  assert.equal(store.status().seq, before, 'no record was touched');
  assert.equal(recordAudit(store, { available: false }).written, false);
});

test('the review intent takes the owner’s ways of asking and nothing else; the spoken review reads the stored record', async (t) => {
  for (const yes of ['Read me my brain review', 'che, what did your audit find this morning?', 'morning review please', "what's in today's brain review", 'brain review', 'daily review']) {
    assert.equal(brainReviewIntent(yes), true, yes);
  }
  for (const no of ['review my code', 'what did the coding job do', 'delete the brain review', 'review the trading plan', 'how was your night', 'read me my messages']) {
    assert.equal(brainReviewIntent(no), false, no);
  }
  assert.match(speakReview({ review: null, audit: null }), /no Brain review yet/);
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  seed(store);
  runBrainMaintenance(store, { now: NOW, since: T0 });
  const speech = speakReview(latestReview(store));
  assert.match(speech, /^Your Brain review for 2026-10-17, sir, from the records alone\./);
  assert.match(speech, /Facts: .*2 corrections from the owner\./);
  assert.match(speech, /Inferences, each from a stated rule: Most agent work failed today/);
  assert.match(speech, /Hypotheses, not facts: Silver may rise next week/);
  assert.match(speech, /My reading, which is only a reading: A day where the agents struggled/);
  assert.match(speech, /Unknown: /);
  assert.match(speech, /flagged 1 record for verification\.$/);
});
