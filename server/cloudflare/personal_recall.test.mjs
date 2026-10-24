// Owner (2026-10-21): recall answers a personal fact only from a stored statement that asserts it. Questions, requests,
// hypotheticals, guesses, quotes and fiction are never facts; the wake prefix is stripped; nothing is invented.
import assert from 'node:assert/strict';
import test from 'node:test';
import { activeFactSubject, answerPersonalFact, isQuestionLike, ownerAssertion, ownerFactTurn, personalFactQuestion, stripWake } from './personal_recall.js';

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
    { subject: 'favorite food', subjectWords: ['favorite', 'food'], value: 'pizza', text: 'my favorite food is pizza', confidence: 'high' },
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

// Owner's calendar is America/Chicago (CDT in summer, CST in winter). Stored instants stay UTC.
import { ownerDay, spokenStoredDate as spokenDate } from './personal_recall.js';

test('a statement stored late on October 21 in Louisiana is dated October 21, not the UTC day October 22', () => {
  // 2026-10-22T02:30Z is 9:30 p.m. CDT on October 21 (Louisiana local).
  assert.equal(spokenDate({ created_at: '2026-10-22T02:30:00Z' }), 'October 21, 2026');
  assert.deepEqual(ownerDay(new Date('2026-10-22T02:30:00Z')), { year: 2026, month: 10, day: 21 });
});

test('midnight crosses on the owner calendar, not UTC: 04:59Z is still the previous Chicago day in CDT', () => {
  assert.equal(spokenDate({ created_at: '2026-10-22T04:59:59Z' }), 'October 21, 2026');
  assert.equal(spokenDate({ created_at: '2026-10-22T05:00:00Z' }), 'October 22, 2026');
});

test('CST in winter: 05:30Z on January 15 is 11:30 p.m. January 14 in Louisiana', () => {
  assert.equal(spokenDate({ created_at: '2027-01-15T05:30:00Z' }), 'January 14, 2027');
  assert.equal(spokenDate({ created_at: '2027-01-15T06:30:00Z' }), 'January 15, 2027');
});

test('daylight-saving transition: the offset changes on the owner calendar, the stored instant does not', () => {
  // DST began 2026-03-08 at 2:00 a.m. CST (08:00Z). Before: UTC-6; after: UTC-5.
  assert.equal(spokenDate({ created_at: '2026-03-08T06:30:00Z' }), 'March 8, 2026');
  assert.equal(spokenDate({ created_at: '2026-03-08T05:59:00Z' }), 'March 7, 2026');
  assert.equal(spokenDate({ created_at: '2026-03-08T06:00:00Z' }), 'March 8, 2026');
  // Still CST at 07:30Z (1:30 a.m. CST); CDT from 08:00Z (3:00 a.m. CDT). The same Chicago day either side.
  assert.equal(spokenDate({ created_at: '2026-03-08T07:30:00Z' }), 'March 8, 2026');
  assert.equal(spokenDate({ created_at: '2026-03-08T08:30:00Z' }), 'March 8, 2026');
});

test('an unreadable stamp gives no date rather than an invented one', () => {
  assert.equal(spokenDate({ created_at: 'not a date' }), '');
  assert.equal(spokenDate({}), '');
});

// ─── The fact under discussion (owner recording, 2026-10-24: "No, strawberry Sprite." after "Your favorite drink is Sprite.") ───
const ASKED = { role: 'user', content: "What's my favorite drink?" };
const ANSWERED = { role: 'assistant', content: 'Your favorite drink is Sprite. You told me that on October 23, 2026.' };
const NO_RECORD = { role: 'assistant', content: "I don't have a record of your favorite drink, sir, so I don't know it. Tell me and I'll remember it." };

test('the subject under discussion is read from CHE\'s own answer, her "no record" reply, or the owner\'s question', () => {
  assert.deepEqual(activeFactSubject([ASKED, ANSWERED]), { subject: 'favorite drink', words: ['favorite', 'drink'], value: 'Sprite', from: 'assistant', index: -1 });
  assert.equal(activeFactSubject([ASKED, NO_RECORD]).value, '');
  assert.equal(activeFactSubject([ASKED]).subject, 'favorite drink');
  assert.equal(activeFactSubject([{ role: 'user', content: 'Open the chart' }, { role: 'assistant', content: 'The chart is open.' }]), null);
  // Only the newest topic counts: an older fact never captures a later remark.
  assert.equal(activeFactSubject([ASKED, ANSWERED, { role: 'user', content: 'open my calendar' }, { role: 'assistant', content: 'Your calendar is open, sir.' }, { role: 'user', content: 'thanks' }, { role: 'assistant', content: 'Of course.' }]), null);
});

test('the owner\'s short correction, in every spoken and typed form, names the fact under discussion', () => {
  for (const said of ['No, strawberry Sprite.', 'no strawberry sprite', 'It’s strawberry Sprite.', 'its strawberry sprite', 'Actually, it\'s strawberry Sprite', 'CHE, no, strawberry Sprite', 'Strawberry Sprite.', 'strawberry Sprite, not Sprite', 'I said strawberry Sprite', 'Wrong, it should be strawberry Sprite']) {
    const out = ownerFactTurn(said, { history: [ASKED, ANSWERED] });
    assert.equal(out?.kind, 'correction', said);
    assert.match(out.statement, /^my favorite drink is strawberry sprite$/i, said);
    assert.equal(out.previous, 'Sprite');
  }
});

test('a value given after "I don\'t have a record" is the fact itself; a plain value with no fact under discussion is nothing', () => {
  assert.equal(ownerFactTurn('Pizza.', { history: [{ role: 'user', content: 'what is my favorite food?' }, { role: 'assistant', content: "I don't have a record of your favorite food, sir, so I don't know it." }] }).statement, 'my favorite food is Pizza');
  assert.equal(ownerFactTurn('No, strawberry Sprite.', { history: [] }), null);
  assert.equal(ownerFactTurn('Pizza.', { history: [{ role: 'user', content: 'open the chart' }, { role: 'assistant', content: 'Done.' }] }), null);
});

test('a question, an order, a pointer or a call-off is never a correction of the fact', () => {
  for (const said of ['What about my favorite food?', 'Open the chart', 'cancel that', 'No, cancel that', 'yes', 'okay', 'the other one', 'No, delete it', 'Is it Sprite?', 'No, read my mailbox']) {
    assert.equal(ownerFactTurn(said, { history: [ASKED, ANSWERED] }), null, said);
  }
});

test('"that\'s not what I meant" / "fix that" asks for the right value and changes nothing; the same value is confirmed, not re-saved', () => {
  for (const said of ["That's not what I meant.", 'Fix that.', 'Wrong.', 'No, that\'s not right']) {
    const out = ownerFactTurn(said, { history: [ASKED, ANSWERED] });
    assert.equal(out.kind, 'clarify', said);
    assert.match(out.text, /favorite drink stored as Sprite/);
  }
  const same = ownerFactTurn('No, Sprite.', { history: [ASKED, ANSWERED] });
  assert.equal(same.kind, 'clarify');
  assert.match(same.text, /That is what I have, sir: your favorite drink is Sprite/);
  // With no fact under discussion, the interpreter keeps handling "fix that".
  assert.equal(ownerFactTurn('Fix that.', { history: [{ role: 'user', content: 'open the chart' }, { role: 'assistant', content: 'Done.' }] }), null);
});

test('"no, the one I just told you" takes the value from the owner\'s own recent turn, or asks when there is none', () => {
  const told = [{ role: 'user', content: 'my favorite drink is strawberry Sprite' }, { role: 'assistant', content: 'Noted.' }, ASKED, ANSWERED];
  assert.equal(ownerFactTurn('No, the one I just told you.', { history: told }).statement, 'my favorite drink is strawberry Sprite');
  assert.equal(ownerFactTurn('Like I just said.', { history: told }).statement, 'my favorite drink is strawberry Sprite');
  const none = ownerFactTurn('No, the one I just told you.', { history: [ASKED, ANSWERED] });
  assert.equal(none.kind, 'clarify');
  assert.match(none.text, /don't see the value in your recent messages/);
});

test('the long form still goes through the record-matched correction', () => {
  const records = [{ id: 'm1', text: 'my favorite drink is Sprite', source: 'owner_chat', verification_status: 'owner_attested', active: true }];
  const out = ownerFactTurn('No, my favorite drink is strawberry Sprite.', { records, history: [] });
  assert.deepEqual(out, { kind: 'correction', statement: 'my favorite drink is strawberry Sprite', short: false });
});
