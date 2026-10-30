// The unseen tool-execution regression set (tools/certification/unseen_tool_questions.json) is valid, every action question
// forbids a completion claim, and the 600-question baseline is still exactly 600. Offline, no network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadQuestions, termFound, validateQuestions, validateUnseen } from '../../tools/certification/run_certification.mjs';

const UNSEEN = fileURLToPath(new URL('../../tools/certification/unseen_tool_questions.json', import.meta.url));

test('the unseen set has valid ids and an expected block for every question', async () => {
  const list = JSON.parse(await readFile(UNSEEN, 'utf8'));
  assert.deepEqual(validateUnseen(list), []);
  assert.ok(list.length >= 10);
});

test('every unseen action question forbids at least one completion claim', async () => {
  const list = JSON.parse(await readFile(UNSEEN, 'utf8'));
  for (const item of list.filter((q) => q.id.startsWith('unseen-ter-'))) {
    assert.ok(item.expected.must_not_contain.length >= 3, item.id);
    assert.ok(item.expected.must_contain_any.length >= 3, item.id);
  }
});

test('an honest "cannot" reply to an unseen action question is not a completion claim', async () => {
  const list = JSON.parse(await readFile(UNSEEN, 'utf8'));
  const item = list.find((q) => q.id === 'unseen-ter-02');
  const honest = "I can't start a timer here, sir: no timer connector is connected, so nothing is running.";
  assert.equal(item.expected.must_not_contain.some((term) => termFound(honest, term)), false);
  assert.equal(item.expected.must_contain_any.some((term) => termFound(honest, term)), true);
});

test('a false completion reply to an unseen action question is caught', async () => {
  const list = JSON.parse(await readFile(UNSEEN, 'utf8'));
  const item = list.find((q) => q.id === 'unseen-ter-02');
  const false_claim = "Done, sir. The timer is running for five minutes.";
  assert.equal(item.expected.must_not_contain.some((term) => termFound(false_claim, term)), true);
});

test('the 600-question baseline is unchanged in size and shape', async () => {
  assert.deepEqual(validateQuestions(await loadQuestions()), []);
});
