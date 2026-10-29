// The model copies the Soul's trait labels into replies ("Warmth: That's great"). They are settings, never CHE's words.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripSoulLabels } from './soul.js';

test('a leading trait label is removed from the reply', () => {
  assert.equal(stripSoulLabels("Warmth: That's great, sir! It's wonderful."), "That's great, sir! It's wonderful.");
  assert.equal(stripSoulLabels('Directness: This weekend, sir, let us plan.'), 'This weekend, sir, let us plan.');
});

test('a label copied onto its own line in the middle of a reply is removed', () => {
  assert.equal(stripSoulLabels('Sure thing.\nInitiative: Want a list?'), 'Sure thing.\nWant a list?');
});

test('ordinary text that only mentions a trait is left alone', () => {
  assert.equal(stripSoulLabels('Your warmth toward him is real.'), 'Your warmth toward him is real.');
  assert.equal(stripSoulLabels('Detail: the record shows the date.'), 'Detail: the record shows the date.');
  assert.equal(stripSoulLabels('Plain reply.'), 'Plain reply.');
  assert.equal(stripSoulLabels(''), '');
});

test('the Worker strips labels from every chat reply it returns', () => {
  const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(worker, /stripPhoneSoul, stripSoulLabels \} from '\.\/soul\.js';/);
  assert.match(worker, /return \{ \.\.\.answer, response: stripSoulLabels\(reply\)/);
});
