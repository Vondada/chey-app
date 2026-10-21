// Owner (2026-10-21): recall answers a personal fact only from a stored statement that asserts it. Questions, requests,
// hypotheticals, guesses, quotes and fiction are never facts; the wake prefix is stripped; nothing is invented.
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerPersonalFact, isQuestionLike, ownerAssertion, personalFactQuestion, stripWake } from './personal_recall.js';

const brainSaid = (id, said, extra = {}) => ({
  id, verification: 'owner_attested', source: { kind: 'owner_chat' }, created_at: '2026-10-21T18:00:00.000Z',
  body: `You said: ${said}\nCHE answered: whatever`, ...extra,
});

test('the owner\'s own question is never a fact: it is not recalled as "You told me"', () => {
  const question = 'CHE, what is my favorite food, and where did you learn it?';
  const brain = [brainSaid('conv:1', question)];
  const out = answerPersonalFact({}, personalFactQuestion('what is my favorite food, and where did you learn it?'), brain);
  assert.equal(out.kind, 'none');
  assert.match(out.answer, /^I don't have a record of your favorite food, sir/);
  assert.doesNotMatch(out.answer, /You told me|learn it\?/);
});

test('questions, requests, hypotheticals, guesses, quotes and fiction are never facts', () => {
  for (const text of [
    'what is my favorite food?',
    'CHE, what is my favorite food?',
    'Can you tell me my favorite food?',
    'Remember what my favorite food is?',
    'if my favorite food is pizza, what should I eat?',
    'I think my favorite food is pizza',
    'maybe my favorite food is pizza',
    'you told me my favorite food is pizza',
    'CHE answered: my favorite food is pizza',
    'write a story where my favorite food is pizza',
  ]) {
    assert.equal(ownerAssertion(text), null, text);
  }
  assert.equal(isQuestionLike('what is my favorite food, and where did you learn it?'), true);
});

test('a plain statement asserts its subject and value, with the wake prefix stripped', () => {
  assert.deepEqual(
    ownerAssertion('CHE, remember that my favorite food is pizza.'),
    { subject: 'favorite food', subjectWords: ['favorite', 'food'], value: 'pizza', text: 'my favorite food is pizza' },
  );
  assert.equal(ownerAssertion('Chay: my favorite food is pizza').value, 'pizza');
  assert.equal(ownerAssertion('Shay, my favorite food is pizza').value, 'pizza');
  assert.equal(ownerAssertion('my Worker URL is https://example.com').subject, 'Worker URL');
});

test('the wake prefix is stripped from a personal question, in every spelling', () => {
  for (const prefix of ['CHE, ', 'Chay ', 'chey, ', 'Shay: ']) {
    const q = personalFactQuestion(`${prefix}what is my favorite food?`);
    assert.deepEqual(q && q.words, ['favorite', 'food'], prefix);
  }
  assert.equal(stripWake('  CHE,  Chay  hello '), 'hello');
});

test('the newest stored statement of the asked subject is quoted as the subject and value, with its date', () => {
  const data = { memory_records: [{ id: 'mem:1', text: 'my favorite food is pizza', verification_status: 'owner_attested', source: 'owner_chat', created_at: '2026-10-21T18:00:00.000Z' }] };
  const out = answerPersonalFact(data, personalFactQuestion('what is my favorite food?'), []);
  assert.equal(out.kind, 'owner_attested');
  assert.equal(out.answer, 'Your favorite food is pizza. You told me that on October 21, 2026.');
  assert.deepEqual(out.records, ['mem:1']);
});

test('a favorite drink never answers a favorite food question', () => {
  const data = { memory_records: [{ id: 'mem:2', text: 'my favorite drink is Sprite', verification_status: 'owner_attested', source: 'owner_chat', created_at: '2026-10-21T18:00:00.000Z' }] };
  const out = answerPersonalFact(data, personalFactQuestion('what is my favorite food?'), []);
  assert.equal(out.kind, 'none');
});

test('older question records are skipped at recall and never deleted: a real statement still answers', () => {
  const brain = [brainSaid('conv:old', 'what is my favorite food?'), brainSaid('conv:new', 'my favorite food is pizza')];
  const out = answerPersonalFact({}, personalFactQuestion('what is my favorite food?'), brain);
  assert.equal(out.answer, 'Your favorite food is pizza. You told me that on October 21, 2026.');
  assert.equal(brain.length, 2, 'the question record is still stored');
});
