// Owner report (2026-10-22, iPhone): "CHE, what's my favorite food? Tell me how you know that, and whether you actually
// have a memory of me saying it…" answered "I don't have a record of your favorite food? Tell me how you know that".
// Root causes: the subject swallowed the follow-up instructions after the question mark, and the memory cap dropped the
// oldest owner statements. These tests keep both fixed, through the parser, the stored records and a restart.
import assert from 'node:assert/strict';
import test from 'node:test';
import { addOwnerMemory, boundMemoryRecords } from './research_memory.js';
import { auditMemoryProvenance } from './memory_provenance.js';
import { answerPersonalFact, personalFactQuestion, recallPersonalFact, statementsFromBrain } from './personal_recall.js';

const OWNER_QUESTION = 'CHE, what\'s my favorite food? Tell me how you know that, and whether you actually have a memory of me saying it. Don\'t guess, and don\'t use this question as proof.';

function pizzaSaved(id = 'pizza-1') {
  const data = {};
  const added = addOwnerMemory(data, 'my favorite food is pizza', { id, source: 'owner_chat', scope: 'owner', confidence: 1 });
  assert.equal(added.added, true);
  return data;
}

// What a restart does: the stored state is written as JSON, read back, and audited on load (worker.js loadData).
function restart(data) {
  const revived = JSON.parse(JSON.stringify(data));
  auditMemoryProvenance(revived);
  return revived;
}

test('the owner\'s exact question asks only for the fact: the subject stops at the question mark', () => {
  const q = personalFactQuestion(OWNER_QUESTION);
  assert.equal(q.subject, 'favorite food');
  assert.deepEqual(q.words, ['favorite', 'food']);
  assert.equal(q.learn, true, 'it asks how CHE knows, so the answer says where it came from');
});

test('the owner\'s exact question recalls the stored pizza fact with its source, and never echoes the instructions', () => {
  const data = pizzaSaved();
  const out = answerPersonalFact(data, personalFactQuestion(OWNER_QUESTION), []);
  assert.equal(out.kind, 'owner_attested');
  assert.match(out.answer, /^Your favorite food is pizza\./);
  assert.match(out.answer, /I learned it from you in this chat\./);
  assert.doesNotMatch(out.answer, /don't have a record|Tell me how you know|food\?/);
  assert.deepEqual(out.records, ['pizza-1']);
});

test('simple questions and natural paraphrases of the same subject recall the pizza fact', () => {
  const data = pizzaSaved();
  for (const message of [
    'what\'s my favorite food?',
    'What is my favorite food',
    'CHE, what is my favorite food?',
    'tell me my favorite food',
    'do you know my favorite food?',
    'what\'s my favourite food?',
  ]) {
    const out = answerPersonalFact(data, personalFactQuestion(message), []);
    assert.equal(out.kind, 'owner_attested', message);
    assert.match(out.answer, /Your favorite food is pizza\./, message);
  }
});

test('a paraphrase that does not name the stored subject is not guessed at: it is a miss, not a made-up answer', () => {
  const data = pizzaSaved();
  assert.equal(personalFactQuestion('what do I like to eat?'), null);
  const drink = answerPersonalFact(data, personalFactQuestion('what\'s my favorite drink?'), []);
  assert.equal(drink.kind, 'none');
  assert.doesNotMatch(drink.answer, /pizza/);
});

test('an older fact survives after the history cap has been passed by many later records', () => {
  const data = pizzaSaved();
  data.memory_records[0].created_at = '2025-03-02T12:00:00.000Z';
  for (let i = 0; i < 520; i += 1) {
    addOwnerMemory(data, `Public repository note ${i}: a project the owner starred`, { source: 'github_stars', confidence: 1 });
  }
  assert.ok(data.memory_records.length <= 400, 'the history stays bounded');
  assert.ok(data.memory_records.some((r) => r.text === 'my favorite food is pizza'), 'the owner\'s own statement is never dropped');
  const out = answerPersonalFact(data, personalFactQuestion(OWNER_QUESTION), []);
  assert.match(out.answer, /Your favorite food is pizza\./);
});

test('the cap trims only what the owner did not say; owner statements are kept in order', () => {
  const owner = Array.from({ length: 3 }, (_, i) => ({ id: `o${i}`, text: `my fact ${i} is yes`, verification_status: 'owner_attested' }));
  const other = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, text: `note ${i}`, verification_status: 'unverified_reference' }));
  const merged = [owner[0], other[0], owner[1], ...other.slice(1), owner[2]];
  const bounded = boundMemoryRecords(merged, 5);
  assert.deepEqual(bounded.map((r) => r.id), ['o0', 'o1', 'x8', 'x9', 'o2'].sort((a, b) => merged.findIndex((r) => r.id === a) - merged.findIndex((r) => r.id === b)));
  assert.equal(bounded.filter((r) => r.verification_status === 'owner_attested').length, 3);
});

test('a restart keeps the owner\'s fact: stored JSON reloads, is audited, and still answers the exact question', () => {
  const data = pizzaSaved();
  const after = restart(data);
  const out = answerPersonalFact(after, personalFactQuestion(OWNER_QUESTION), []);
  assert.equal(out.kind, 'owner_attested');
  assert.match(out.answer, /Your favorite food is pizza\./);
  assert.equal(after.memory_records[0].verification_status, 'owner_attested');
});

test('a fact the owner said in chat and that exists only in the Brain is recalled after a restart', () => {
  const brainRecord = {
    id: 'chat-brain-1',
    verification: 'owner_attested',
    source: { kind: 'owner_chat' },
    created_at: '2026-10-01T18:00:00.000Z',
    body: 'You said: my favorite food is pizza\nCHE answered: Noted.',
  };
  const brain = JSON.parse(JSON.stringify([brainRecord]));
  assert.equal(statementsFromBrain(brain).length, 1);
  const found = recallPersonalFact({}, personalFactQuestion(OWNER_QUESTION), brain);
  assert.equal(found.value, 'pizza');
  assert.equal(found.id, 'chat-brain-1');
});

test('a newer statement of the same subject answers; the older one stays on record, unchanged', () => {
  const data = pizzaSaved();
  addOwnerMemory(data, 'my favorite food is sushi', { source: 'owner_chat', confidence: 1 });
  const out = answerPersonalFact(restart(data), personalFactQuestion(OWNER_QUESTION), []);
  assert.match(out.answer, /Your favorite food is sushi\./);
  assert.ok(data.memory_records.some((r) => r.text === 'my favorite food is pizza' && r.active === false), 'superseded, not deleted');
});
