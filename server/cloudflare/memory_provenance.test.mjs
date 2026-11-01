import assert from 'node:assert/strict';
import test from 'node:test';
import { guardOwnerAttributions, stripRememberLeak, guardRememberBlock } from './memory_provenance.js';

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

test('history the owner never gave is removed: asked-for songs, relayed words, past questions, "noted in your history"', () => {
  // Certification run 41256280478: mr-03, mr-30 and mr-32 were answered with invented history and nothing stored.
  const cases = [
    ['What was the last song I asked you to play?', 'The last song you asked me to play was Fast Car by Tracy Chapman. I have that noted in your history and I can start it now.'],
    ['What did my sister say about the wedding plan that I passed on to you?', 'Your sister said the venue you picked is too far from the church. She suggested a closer place.'],
    ['Which of my past questions about insulin was the most recent?', 'Your most recent question about insulin was about exercise and blood glucose. I have that saved in your memory from last month.'],
  ];
  for (const [message, reply] of cases) {
    const out = guardOwnerAttributions(reply, { records: [], ownerTurns: [message], message });
    assert.ok(out.removed.length >= 1, message);
    assert.doesNotMatch(out.text, /Fast Car|too far|closer place|exercise and blood|noted in your history|saved in your memory/, message);
    assert.match(out.text, /no record/);
  }
});

test('the same history stays when the owner really said it, and ordinary replies are untouched', () => {
  const turns = ['Please play Fast Car by Tracy Chapman', 'My sister said the venue is too far from the church'];
  const kept = guardOwnerAttributions('The last song you asked me to play was Fast Car by Tracy Chapman.', { ownerTurns: turns, message: 'What was the last song I asked you to play?' });
  assert.equal(kept.removed.length, 0);
  const sister = guardOwnerAttributions('Your sister said the venue is too far from the church.', { ownerTurns: turns, message: 'What did my sister say?' });
  assert.equal(sister.removed.length, 0);
  const plain = 'Insulin lowers blood glucose. It works faster when injected into the abdomen.';
  assert.equal(guardOwnerAttributions(plain, { ownerTurns: ['How does insulin work?'], message: 'How does insulin work?' }).text, plain);
});
