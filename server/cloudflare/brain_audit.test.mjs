import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAIN_REGIONS, CheBrainStore } from './brain_store.js';
import { auditSignificance, brainReviewIntent, buildDailyReview, isBookkeeping, latestReview, ownerScore, recordAudit, runBrainMaintenance, speakReview } from './brain_audit.js';

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
  const yes = ['Read me my brain review', 'che, what did your audit find this morning?', 'morning review please', "what's in today's brain review", 'brain review', 'daily review',
    'review my brain', 'brain audit please', 'read my review', 'did your audit find anything', 'what did you conclude last night', 'read me the audit', 'show me the review',
    'tell me the review', 'what did the review say about silver', 'what is my brain review', 'read todays review', "read today's review", 'what did your auditor conclude',
    'brain conclusions', 'significance audit', 'what did your review find', 'what happened yesterday in my brain', 'any conclusions from the brain', 'what did the brain audit flag',
    'which records need verification', 'is there a review today', 'tell me today’s audit', 'what did you learn last night'];
  for (const text of yes) assert.equal(brainReviewIntent(text), true, text);
  // Owner-memory questions, work on the review, reviews of other things, generic reports and summaries: not the review.
  const no = ['review my code', 'what did the coding job do', 'delete the brain review', 'review the trading plan', 'how was your night', 'read me my messages',
    "how's my brain doing", "what's the review of the trading plan", 'audit the brain code', 'morning brief', 'give me the morning report', 'daily report',
    'morning summary please', "what's the daily summary", 'give me the review of my website', "what's the audit of my spending", 'what have I told you about my brain review',
    'did I ask you for a brain review yesterday', 'what did I say about the morning review', 'run the review again', 'regenerate the brain review', 'rebuild the brain review',
    'the nightly report', "last night's summary", 'code review please', 'good morning che', 'morning', 'read this', 'read aloud', 'brain status', 'brain conflicts', 'show the audit log',
    // Unrelated questions that merely contain a trigger word go to research or the model, never to the review.
    'what have you learned about brain computer interfaces', 'did you find anything about brain fog supplements', "what's the significance of what happened in Lisbon",
    'what happened to my brain scan appointment', 'what did you find about the brain tumor study', 'research what scientists found about the brain this year',
    'what is the review from the client', 'show me the review John left on Google', 'schedule my daily review at 9', 'when is my morning review meeting',
    'read me the audit from the accountant', 'what did you learn last night about silver', 'is there a review today on Yelp', 'tell me the review score',
    'what is my review at work', 'give me the review my boss wrote', 'learn brain anatomy', 'brain verification', "what's in the review of my brain scan"];
  for (const text of no) assert.equal(brainReviewIntent(text), false, text);
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

test('the Brain\'s own bookkeeping is never a day\'s activity: no review writes itself, and the model\'s nightly review is never read out as the Brain review', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  seed(store);
  const first = runBrainMaintenance(store, { now: NOW, since: T0 });
  assert.equal(first.review.written, true);
  // The next morning, exactly 24 hours on: yesterday's own review and audit are the only records touched since.
  const sameClock = runBrainMaintenance(store, { now: '2026-10-18T07:07:00.000Z', since: NOW });
  assert.equal(sameClock.review.written, false, 'yesterday\'s review is not today\'s activity');
  // The model's nightly review, projected from the state blob (review:<time>, model_opinion), is bookkeeping too.
  store.put({ id: 'review:2026-10-18T07:09:00.000Z', kind: 'daily_review', region: BRAIN_REGIONS.audits, path: 'Nightly reviews', title: 'Nightly review 2026-10-18', body: 'The model thinks the day went well.', source: { kind: 'nightly_review' }, verification: 'model_opinion' }, { now: '2026-10-18T07:09:30.000Z' });
  const next = runBrainMaintenance(store, { now: '2026-10-18T07:10:00.000Z', since: '2026-10-17T07:08:00.000Z' });
  assert.equal(next.review.written, false, 'a projected model review is not activity');
  assert.equal(store.get('review:brain:2026-10-18'), null);
  const latest = latestReview(store);
  assert.equal(latest.review.id, 'review:brain:2026-10-17', 'the computed review, not the model\'s');
  assert.equal(latest.review.verification, 'verified_source');
  assert.match(speakReview(latest), /^Your Brain review for 2026-10-17, sir/);
  for (const id of ['review:brain:2026-10-17', 'audit:2026-10-17', 'review:2026-10-18T07:09:00.000Z']) assert.equal(isBookkeeping(store.get(id)), true, id);
  assert.equal(isBookkeeping(store.get('mem:1')), false);
});

test('a re-score is bookkeeping about a record, not activity on it: updated_at and author stay, only the revision moves', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  seed(store);
  const before = store.get('mem:1');
  assert.equal(before.origin, 'iphone');
  storage.sql.exec("UPDATE brain_records SET significance = '{}' WHERE id = 'mem:1'");
  const audit = auditSignificance(store, { now: '2026-11-20T07:07:00.000Z' });
  assert.ok(audit.changed >= 1);
  const after = store.get('mem:1');
  assert.equal(after.rev, before.rev + 1, 'replicas pick the score up through the revision');
  assert.equal(after.updated_at, before.updated_at, 'the record was not touched today');
  assert.equal(after.origin, 'iphone', 'the author stays the phone');
  assert.equal(after.significance.auditor, 'rules_v1');
  const quiet = buildDailyReview(store, { now: '2026-11-20T07:07:00.000Z', since: '2026-11-19T07:07:00.000Z' });
  assert.equal(quiet.written, false, 'a month-old record re-scored today is not today\'s activity');
});

test('the review boundary is persisted: a cron that fires earlier than last night\'s own writes finds no activity, and real activity is still found', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  seed(store);
  // Night 1 at 07:07: the nightly's own projection wrote records seconds before the review.
  store.put({ id: 'mem:proj', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Memory', title: 'Projected', body: 'A memory the projection brought in.', verification: 'owner_attested', created_at: '2026-10-16T12:00:00.000Z' }, { now: '2026-10-17T07:06:59.500Z' });
  const first = runBrainMaintenance(store, { now: NOW });
  assert.equal(first.review.written, true);
  assert.equal(store.meta('brain_review_since'), NOW);
  // Night 2 fires two minutes earlier than night 1 and nothing happened in between.
  const early = runBrainMaintenance(store, { now: '2026-10-18T07:05:00.000Z' });
  assert.equal(early.review.written, false, 'last night\'s writes are not today\'s activity');
  assert.equal(store.get('review:brain:2026-10-18'), null);
  // Then a real exchange, and the next morning (also early) writes a review of exactly that.
  store.put({ id: 'conv:new', kind: 'conversation', region: BRAIN_REGIONS.conversations, path: 'Chat/2026-10-18', title: 'Good morning', body: 'You said: good morning\nCHE answered: good morning, sir.', verification: 'owner_attested' }, { now: '2026-10-18T09:00:00.000Z' });
  const next = runBrainMaintenance(store, { now: '2026-10-19T07:05:00.000Z' });
  assert.equal(next.review.written, true);
  assert.match(store.get('review:brain:2026-10-19').body, /^- 1 Brain record changed since 2026-10-17 07:07 UTC\.$/m);
  assert.match(store.get('review:brain:2026-10-19').body, /1 conversation with the owner kept word for word\./);
  assert.equal(store.meta('brain_review_since'), '2026-10-19T07:05:00.000Z');
});

test('records brought in by projection or backfill are not the day\'s conversations, and the headline count is the real count, not the page size', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  // The nightly backfill imports 2 100 old conversations tonight (created months ago), plus one real exchange today.
  for (let i = 0; i < 2100; i++) {
    store.put({ id: `conv:old${i}`, kind: 'conversation', region: BRAIN_REGIONS.conversations, path: 'Chat/2026-06-01', title: `Old talk ${i}`, body: `You said: old ${i}\nCHE answered: yes.`, verification: 'owner_attested', created_at: '2026-06-01T10:00:00.000Z', source: { kind: 'owner_chat', full_text: false } }, { now: '2026-10-17T07:06:00.000Z' });
  }
  store.put({ id: 'conv:today', kind: 'conversation', region: BRAIN_REGIONS.conversations, path: 'Chat/2026-10-17', title: 'Today', body: 'You said: hello\nCHE answered: hello, sir.', verification: 'owner_attested' }, { now: '2026-10-17T06:00:00.000Z' });
  const result = buildDailyReview(store, { now: NOW, since: T0 });
  assert.equal(result.written, true);
  const body = store.get('review:brain:2026-10-17').body;
  assert.match(body, /^- 2101 Brain records changed since 2026-10-16 22:00 UTC \(details below from the newest 2000\)\.$/m, 'the real count, with the page it details');
  assert.match(body, /older records \(created before this window\) were rewritten or brought in: edits, imports or backfill, not new events\./);
  assert.match(body, /^- 1 conversation with the owner kept word for word\.$/m);
  assert.doesNotMatch(body, /busy day of conversation/);
  assert.equal(result.counts.conversations, 1);
});

test('the review never recommends a voice route that does not exist, speaks real lines that start like a placeholder, and counts only requests still queued', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  seed(store);
  store.put({ id: 'note:none', kind: 'note', region: BRAIN_REGIONS.trading, path: 'Ideas', title: 'None of the agents can trade yet', body: 'A hypothesis about readiness.', verification: 'hypothesis' }, { now: '2026-10-17T04:30:00.000Z' });
  store.put({ id: 'phone:q2', kind: 'queued_request', region: BRAIN_REGIONS.tasks, path: 'Queued offline', title: 'already sent', body: 'Sent later.', verification: 'unknown', source: { kind: 'queued_request', status: 'sent' } }, { origin: 'iphone', now: '2026-10-17T05:30:00.000Z' });
  // A conflict: the phone edits rev 1 after the cloud moved on.
  store.put({ id: 'mem:c', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Memory', title: 'C', body: 'Cloud one.', verification: 'owner_attested' }, { now: '2026-10-17T05:40:00.000Z' });
  store.put({ id: 'mem:c', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Memory', title: 'C', body: 'Cloud two.', verification: 'owner_attested' }, { now: '2026-10-17T05:41:00.000Z' });
  const clash = store.apply({ type: 'put', record: { id: 'mem:c', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Memory', title: 'C', body: 'Phone one.', verification: 'owner_attested' }, base_rev: 1 }, { origin: 'iphone', now: '2026-10-17T05:42:00.000Z' });
  assert.equal(clash.outcome, 'conflict');
  const result = runBrainMaintenance(store, { now: NOW, since: T0 });
  const body = store.get('review:brain:2026-10-17').body;
  assert.match(body, /Settle the 1 open conflict in the Brain screen's Conflicts list; both copies are kept until you choose\./);
  assert.doesNotMatch(body, /say "brain conflicts"/);
  assert.match(body, /1 request queued offline has not run/, 'the sent one is not counted');
  const speech = speakReview(latestReview(store));
  assert.match(speech, /Hypotheses, not facts: .*None of the agents can trade yet/);
  assert.ok(result.review.written);
});

test('the auditor reaches every record over the nights through a persisted cursor', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const store = new CheBrainStore(storage);
  for (let i = 0; i < 1200; i++) {
    store.put({ id: `note:${i}`, kind: 'note', region: BRAIN_REGIONS.learned, path: 'Facts', title: `Fact ${i}`, body: `Learned fact ${i}.`, verification: 'unverified_reference' }, { now: '2026-10-10T00:00:00.000Z' });
  }
  storage.sql.exec("UPDATE brain_records SET significance = '{}'");
  let changed = 0;
  for (const night of ['2026-10-17T07:07:00.000Z', '2026-10-18T07:07:00.000Z', '2026-10-19T07:07:00.000Z']) {
    const audit = auditSignificance(store, { now: night, limit: 500 });
    assert.equal(audit.examined, 500);
    changed += audit.changed;
  }
  assert.equal(changed, 1200, 'three nights of 500 cover all 1200 once');
  assert.equal(Number(storage.sql.exec("SELECT COUNT(*) AS n FROM brain_records WHERE significance = '{}'")[0].n), 0);
  assert.equal(auditSignificance(store, { now: '2026-10-20T07:07:00.000Z', limit: 500 }).changed, 0);
});
