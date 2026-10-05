import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOWS, planWorkflow, selectWorkflow, assessTask, chooseKnownAnswer, inferenceDecision, engineCapacityState, shouldSwitchEngine, drainOrder, ownerNotificationPolicy, dedupeEvidence, minimalContext, condenseHistory, estimateTokens } from './workflow_governor.js';

test('all ten workflows route deterministically to the cheapest capable one', () => {
  const cases = [
    [{ text: 'What is my Worker URL?' }, WORKFLOWS.INSTANT],
    [{ text: 'thanks CHE' }, WORKFLOWS.INSTANT],
    [{ text: 'Walk me through the trade-offs of a system-wide architecture redesign for the voice pipeline' }, WORKFLOWS.DEEP_REASONING],
    [{ text: 'Change the button label on the home screen to Start' }, WORKFLOWS.FAST_CODING],
    [{ text: 'Implement a redesign of the memory system across the codebase with a migration plan' }, WORKFLOWS.DEEP_CODING],
    [{ text: 'The app crashes when I open the War Room; find the root cause' }, WORKFLOWS.BUG_HUNT],
    [{ text: 'continue', resume_checkpoint: true }, WORKFLOWS.RECOVERY],
    [{ text: 'Research the latest provider limits' }, WORKFLOWS.RESEARCH],
    [{ text: 'What is the bitcoin price right now' }, WORKFLOWS.RESEARCH],
    [{ text: 'Have the whole team work on this in parallel' }, WORKFLOWS.MULTI_AGENT],
    [{ text: 'Deploy the database migration to production' }, WORKFLOWS.WAR_ROOM],
    [{ text: 'Rotate the leaked keys and revoke the credentials' }, WORKFLOWS.WAR_ROOM],
    [{ text: 'answer this', offline: true }, WORKFLOWS.DEGRADED],
    [{ text: 'hello' }, WORKFLOWS.DEGRADED, { healthy_engines: 0 }],
  ];
  for (const [input, expected, ctx] of cases) assert.equal(selectWorkflow(input, ctx), expected, input.text);
  assert.equal(new Set(cases.map((c) => c[1])).size, 10, 'every workflow is reachable');
});

test('talking about trades or code is not high stakes; acting on them is', () => {
  assert.notEqual(selectWorkflow({ text: 'how are my trades doing' }), WORKFLOWS.WAR_ROOM);
  assert.notEqual(selectWorkflow({ text: 'explain what a worker class is' }), WORKFLOWS.WAR_ROOM);
  assert.equal(selectWorkflow({ text: 'Sell all my contracts now' }), WORKFLOWS.WAR_ROOM);
});

test('scores are cheap numbers and the plan carries tier and review', () => {
  const s = assessTask({ text: 'Should I refactor the entire router? Not sure.' }, { engine_health: 0.9 });
  for (const k of ['complexity', 'risk', 'uncertainty', 'parallelism', 'freshness', 'engine_health']) assert.ok(s[k] >= 0 && s[k] <= 1, k);
  assert.ok(s.est_tokens > 0);
  const war = planWorkflow({ text: 'Deploy the database migration to production' });
  assert.equal(war.tier, 'strong');
  assert.equal(war.cross_check, true);
  assert.equal(planWorkflow({ text: 'hi' }).tier, 'small');
  assert.equal(planWorkflow({ text: 'hi' }).retrieval_first, true);
});

test('known information bypasses inference; low confidence, expired and stale facts do not', () => {
  const candidates = [
    { source: 'research_library', found: true, value: 'library answer', verified_at: 100 },
    { source: 'active_conversation', found: true, value: 'conversation answer', verified_at: 100 },
  ];
  assert.equal(chooseKnownAnswer(candidates)?.value, 'conversation answer');
  assert.equal(inferenceDecision(candidates).use_engine, false);
  assert.equal(inferenceDecision([]).use_engine, true);
  assert.equal(chooseKnownAnswer([{ source: 'knowledge_cache', found: true, value: 'old', verified_at: 100 }], { now: 1000, freshnessMs: 100 }), null);
  assert.equal(chooseKnownAnswer([{ source: 'knowledge_cache', found: true, value: 'x', confidence: 0.5 }]), null);
  assert.equal(chooseKnownAnswer([{ source: 'knowledge_cache', found: true, value: 'x', expires_at: 50 }], { now: 100 }), null);
});

test('engines drain at seventy percent and the order switches before exhaustion', () => {
  assert.equal(engineCapacityState({ utilization: 0.40, health: 1 }), 'healthy');
  assert.equal(engineCapacityState({ utilization: 0.60, health: 1 }), 'caution');
  assert.equal(engineCapacityState({ utilization: 0.70, health: 1 }), 'draining');
  assert.equal(engineCapacityState({ utilization: 0.10, health: 0.3 }), 'draining', 'a sick engine drains too');
  assert.equal(engineCapacityState({ utilization: 1, health: 1 }), 'offline');
  assert.equal(engineCapacityState({ utilization: 0.75, health: 1 }, 0.9), 'caution', 'provider-specific drain point');
  assert.equal(shouldSwitchEngine('draining'), true);
  const states = { a: 'draining', b: 'healthy', c: 'offline', d: 'caution' };
  assert.deepEqual(drainOrder(['a', 'b', 'c', 'd'], (x) => states[x]), ['b', 'd', 'a', 'c']);
});

test('recoverable failures stay quiet; owner, security, data, money and exhaustion surface', () => {
  assert.equal(ownerNotificationPolicy({ recoverable: true }).notify, false);
  for (const flag of ['owner_action_required', 'security_risk', 'data_integrity_risk', 'financial_action', 'destructive_action', 'recovery_exhausted', 'safety_critical']) {
    assert.equal(ownerNotificationPolicy({ recoverable: true, [flag]: true }).notify, true, flag);
  }
  assert.equal(ownerNotificationPolicy({}).notify, true, 'unknown failures are never hidden');
});

test('evidence dedupe never drops system, short, image or unique messages, and keeps turns alternating', () => {
  const big = 'x'.repeat(500);
  const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] };
  const msgs = [
    { role: 'system', content: big }, { role: 'system', content: big },
    { role: 'user', content: 'yes' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'yes' },
    { role: 'assistant', content: big }, image, { role: 'assistant', content: big }, { role: 'user', content: 'go' },
  ];
  const out = dedupeEvidence(msgs);
  assert.equal(out.filter((m) => m.role === 'system').length, 2);
  assert.equal(out.filter((m) => m.content === 'yes').length, 2);
  assert.ok(out.includes(image));
  // Dropping either copy here would join two user turns, so both stay.
  assert.equal(out.filter((m) => m.content === big && m.role === 'assistant').length, 2);
  // Back-to-back identical evidence is sent once.
  assert.equal(dedupeEvidence([{ role: 'user', content: big }, { role: 'user', content: big }, { role: 'assistant', content: 'ok' }]).length, 2);
  for (let i = 1; i < out.length; i += 1) if (out[i].role !== 'system') assert.notEqual(out[i].role, out[i - 1].role, 'no two same-role turns in a row');
  const joined = dedupeEvidence([{ role: 'user', content: 'a' }, { role: 'assistant', content: big }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: big }]);
  assert.equal(joined.length, 4, 'here the earlier copy can go without joining turns');
  for (let i = 1; i < joined.length; i += 1) assert.notEqual(joined[i].role, joined[i - 1].role);
  assert.deepEqual(minimalContext(['abc', 'abc', 'de', 'toolong'], 5), ['abc', 'de']);
});

test('review fixes: chores and household problems are not war rooms or bug hunts', () => {
  assert.notEqual(selectWorkflow({ text: 'send the data file to Bob' }), WORKFLOWS.WAR_ROOM);
  assert.notEqual(selectWorkflow({ text: 'delete the old photos from my account' }), WORKFLOWS.WAR_ROOM);
  assert.notEqual(selectWorkflow({ text: 'my wifi is not working' }), WORKFLOWS.BUG_HUNT);
  assert.equal(selectWorkflow({ text: 'the app is not working after the update' }), WORKFLOWS.BUG_HUNT);
  assert.equal(selectWorkflow({ text: 'transfer $500 to savings' }), WORKFLOWS.WAR_ROOM);
});

test('context-rot defense: old turns condense to constraints, decisions, failures and SHAs without AI; recent turns stay verbatim', () => {
  const history = [
    { role: 'user', content: 'Never touch che_browser.dart. The objective is a faster voice reply.' },
    { role: 'assistant', content: 'Understood. I tried caching the prompt and it failed the latency test.' },
    { role: 'user', content: 'Nice weather today.' },
    { role: 'assistant', content: 'It is lovely.' },
    { role: 'user', content: 'Main is at commit 576bb09, base your work on that head.' },
    ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `recent ${i}` })),
  ];
  const out = condenseHistory(history, { keep: 12 });
  assert.equal(out.turns.length, 12);
  assert.equal(out.turns[0].content, 'recent 0');
  assert.equal(out.dropped, 5);
  assert.match(out.condensed, /Owner: Never touch che_browser\.dart\./);
  assert.match(out.condensed, /objective is a faster voice reply/);
  assert.match(out.condensed, /CHE: .*tried caching the prompt and it failed/);
  assert.match(out.condensed, /576bb09/);
  assert.doesNotMatch(out.condensed, /weather|lovely/, 'completed small talk is not carried');
  assert.equal(condenseHistory(history.slice(-4)).condensed, '', 'short conversations are untouched');
  const huge = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Never do thing number ${i}.` }));
  const bounded = condenseHistory(huge, { keep: 4, maxCondensedChars: 300 });
  assert.ok(bounded.condensed.length < 450);
  assert.match(bounded.condensed, /thing number 55/, 'the newest constraints win when over budget');
  assert.equal(estimateTokens('abcd'.repeat(10)), 10);
});


test('context-rot defense preserves the tail of long recent owner turns', () => {
  const long = 'A'.repeat(2600) + ' FINAL CONSTRAINT: never deploy without review.';
  const out = condenseHistory([{ role: 'user', content: long }, { role: 'assistant', content: 'Understood.' }], { keep: 12, maxTurnChars: 2000 });
  assert.equal(out.turns[0].content, long, 'recent owner turns are not clipped at 2,000 characters');
  assert.match(out.turns[0].content, /FINAL CONSTRAINT: never deploy without review\.$/);
});
