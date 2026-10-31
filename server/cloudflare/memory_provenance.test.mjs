import assert from 'node:assert/strict';
import test from 'node:test';
import { stripRememberLeak, guardRememberBlock } from './memory_provenance.js';

// Certification run 41222062110 (ir-40, csd-25): the remember instruction and its tag names leaked into answers.
test('a leaked che-remember instruction or tag row is removed; a real fence and ordinary brackets stay', () => {
  assert.equal(stripRememberLeak('Che-remember block, one fact per line, tagged [Mathematics]. The square root of 2 is irrational.').text, 'The square root of 2 is irrational.');
  assert.equal(stripRememberLeak('Che-remember It is the answer. [People] It is the answer. [Projects] [Decisions] [Companies] [Meetings]').text, 'It is the answer. It is the answer.');
  const fenced = 'Noted, sir.\n\n```che-remember\n[People] Owner likes tea\n```';
  assert.equal(stripRememberLeak(fenced).text, fenced);
  assert.equal(stripRememberLeak('Your projects are [Alpha] and [Beta].').text, 'Your projects are [Alpha] and [Beta].');
  // Codex on #816: an ordinary bracketed list survives, and code keeps its indentation.
  assert.equal(stripRememberLeak('Use these labels in order: [Alpha] [Beta] [Gamma].').text, 'Use these labels in order: [Alpha] [Beta] [Gamma].');
  const code = '```python\nfor row in rows:\n    if row:\n        print(row)\n```';
  assert.equal(stripRememberLeak(`Che-remember block, one fact per line. Here is the loop:\n\n${code}`).text, `Here is the loop:\n\n${code}`);
  assert.equal(guardRememberBlock('Che-remember block, one fact per line. Two plus two is four.').text, 'Two plus two is four.');
});
