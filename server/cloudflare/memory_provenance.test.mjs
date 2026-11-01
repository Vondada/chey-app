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

test('after a removed claim, only a sentence reporting the same person\'s words goes with it (Codex review on #826)', () => {
  const out = guardOwnerAttributions('You told me you use insulin. It lowers blood glucose. This is general information, not a dosing recommendation.', { ownerTurns: ['How does insulin work?'], message: 'How does insulin work?' });
  assert.equal(out.removed.length, 1);
  assert.match(out.text, /It lowers blood glucose\. This is general information, not a dosing recommendation\./);
  const sister = guardOwnerAttributions('Your sister said the venue is too far. She suggested a closer place. Venues near the church are easier for guests.', { ownerTurns: ['What did my sister say?'], message: 'What did my sister say?' });
  assert.equal(sister.removed.length, 2);
  assert.match(sister.text, /Venues near the church are easier for guests\./);
});

test('a leaked template line with values between the tags is removed whole (run 41267724614, cre-37)', () => {
  const leak = "I'll cite the calendar's answer. [che-remember] [People] CHE [Projects] [Decisions] [Companies] [Meetings] Meeting - Calendar [Daily] [Knowledge]";
  assert.equal(stripRememberLeak(leak).text, "I'll cite the calendar's answer.");
  // Without the marker, two tags side by side still mark the filled-in template.
  assert.equal(stripRememberLeak('Done. [People] CHE [Projects] [Meetings] Meeting [Daily]').text, 'Done.');
  // Prose about the categories, two tags, and a real fenced block stay.
  for (const keep of [
    'Use [People] for names, [Projects] for work, and [Daily] for logs.',
    'Use [People] for names and [Projects] for work and [Daily] for logs.',
    'Pick [People] or [Projects] or [Daily] for it.',
    'Tag it [People] or [Projects] as you like.',
    'Answer.\n```che-remember\n[People] Sam [Projects] X [Daily] y\n```',
  ]) assert.equal(stripRememberLeak(keep).text, keep);
});

test('"the most recent time you asked about ..." with nothing stored is removed; a reference to this question stays', () => {
  // Certification run 41267724614 (mr-32).
  const q = 'Which of my past questions about insulin was the most recent?';
  const out = guardOwnerAttributions('The most recent time you asked about insulin was on October 14th when you wanted to know the difference between long-acting and rapid-acting types.', { ownerTurns: [q], message: q });
  assert.doesNotMatch(out.text, /October 14th/);
  assert.match(out.text, /no record/);
  const here = 'Rapid-acting insulin works within 15 minutes. You asked about insulin, so here is the answer.';
  assert.equal(guardOwnerAttributions(here, { ownerTurns: ['Tell me about insulin'], message: 'Tell me about insulin' }).text, here);
});

test('the template written one tag per line is removed; a category list in words stays (run 41279724891, eer-30)', () => {
  const leak = '`che-remember`\n[People] CHE\n[Projects]\n[Decisions]\n[Companies]\n[Meetings]\n[Daily]\n[Knowledge]\nNo charge happened in the original transaction.';
  assert.equal(stripRememberLeak(leak).text, 'No charge happened in the original transaction.');
  assert.equal(stripRememberLeak('Answer first.\n[che-remember]\n[People] Sam\n[Projects] Blue Lantern\n[Daily] gym').text, 'Answer first.');
  for (const keep of [
    'Categories:\n[People] for names\n[Projects] for work\n[Daily] for logs',
    'Use these:\n[People] names\n[Projects] work\n[Daily] logs',
    'Categories:\n[People] names, contacts\n[Projects]\n[Daily] logs',
  ]) assert.equal(stripRememberLeak(keep).text, keep);
});

test('a remember line built from the category tags is not saved as a fact (run 41279724891, eer-29)', () => {
  const q = 'Draft a five-step recovery plan for a corrupted local database.';
  const out = guardRememberBlock('Here is a plan:\n```che-remember\n[People]/[Decisions]/Database Recovery Plan\n```', { ownerTurns: [q] });
  assert.equal(out.text, 'Here is a plan:');
  assert.deepEqual(out.dropped, ['/[Decisions]/Database Recovery Plan']);
  const real = 'Noted.\n```che-remember\n[Projects] Owner is planning a database recovery\n```';
  assert.equal(guardRememberBlock(real, { ownerTurns: ['I am planning a database recovery'] }).text, real);
});

test('a one-line or spaced che-remember fence and slash-joined tags are checked like the standard block (run 41284676707)', () => {
  const owner = { ownerTurns: ['Design a safe recovery script. I am designing a safe recovery script.'] };
  // mr-37: the whole fence on one line, tags only.
  assert.equal(guardRememberBlock('Explain what remains unknown. ```che-remember [People] [Decisions] ```', owner).text, 'Explain what remains unknown.');
  // oac-19: a space after the backticks, inline and on its own lines.
  assert.equal(guardRememberBlock('``` che-remember [People]/[Daily] Weekly Review Every Monday at 10 AM ``` Nothing was scheduled, sir.', owner).text, 'Nothing was scheduled, sir.');
  assert.equal(guardRememberBlock('``` che-remember\n[People]/[Daily] Weekly Review Every Monday at 10 AM\n```\nNothing was scheduled, sir.', owner).text, 'Nothing was scheduled, sir.');
  // eer-29: a backticked marker and tags joined by slashes.
  assert.equal(guardRememberBlock('`che-remember` [People]/[Decisions]/[Companies]/[Meetings]/[Daily]/[Knowledge] A recovery script may run twice.', owner).text, 'A recovery script may run twice.');
  // A real fact in a one-line fence is kept, written as a standard block; other code fences are untouched.
  assert.equal(guardRememberBlock('Noted. ```che-remember [Projects] Owner is designing a safe recovery script ```', owner).text, 'Noted. ```che-remember\n[Projects] Owner is designing a safe recovery script\n```');
  const code = 'Example code:\n```js\nconst tags = "[People] [Projects] [Daily]";\n```';
  assert.equal(guardRememberBlock(code, owner).text, code);
  // Prose naming two categories with a slash stays.
  assert.equal(guardRememberBlock('File it under [People]/[Projects] if you like.', owner).text, 'File it under [People]/[Projects] if you like.');
});

test('the Brain context header copied into an answer is removed with its marker (run 41290043444, eer-37)', () => {
  const owner = { ownerTurns: ['How do I plan a recovery from a leaked credential?'] };
  const leak = '`che-remember block` [Learned Knowledge; research lead, unverified; speaker Atlas; 2026-10-09] [Office; observed, not verified; speaker not recorded; 2026-10-21] To plan a recovery from a leaked credential, act quickly.';
  assert.equal(guardRememberBlock(leak, owner).text, 'To plan a recovery from a leaked credential, act quickly.');
  assert.equal(stripRememberLeak('Here is what I found. [Office; observed, not verified; speaker not recorded; 2026-10-21] The note says so.').text, 'Here is what I found. The note says so.');
  // Brackets that are not the header format stay.
  for (const keep of ['Use [People; Projects] tags; the speaker field records who said it.', 'Meeting notes [Mon; 10am; speaker Sam] were short.']) {
    assert.equal(stripRememberLeak(keep).text, keep);
  }
});

test('a memory line needs an owner statement, its names and numbers, and a tag-only block is removed (run 41294923116)', () => {
  // ir-27 / mr-11: the question or request is not evidence for a "fact".
  assert.equal(guardRememberBlock('```che-remember 6 is a perfect square and a perfect cube ``` No, there isn\'t.', { ownerTurns: ['Is there a number above 1 and below 100 that is both a perfect square and a perfect cube?'] }).text, 'No, there isn\'t.');
  assert.equal(guardRememberBlock('```che-remember - Kitchen renovation ``` We did not discuss it.', { ownerTurns: ['Summarise the decisions we made about the kitchen renovation last month.'] }).text, 'We did not discuss it.');
  // cre-45: a name the owner never said.
  assert.equal(guardRememberBlock('They may not be.\n```che-remember\n[People] The owner of the two sources is Partner 13.\n```', { ownerTurns: ['Two sources share a common author. Are they independent?'] }).text, 'They may not be.');
  // mr-37 / ter-38: tag-only lines, one per line, leave nothing to save.
  assert.equal(guardRememberBlock('Answer.\n```che-remember\n[People]\n[Decisions]\n```', { ownerTurns: ['What was the code?'] }).text, 'Answer.');
  // Real statements stay, with their names and numbers, including "remember that" and a stated rule.
  const kept = [
    ['Noted.\n```che-remember\n[People] Owner\'s sister Ana lives in Austin\n```', 'My sister Ana lives in Austin.'],
    ['Noted.\n```che-remember\n[Daily] Owner goes to the gym at 6 am\n```', 'Remember that I go to the gym at 6 am.'],
    ['Done.\n```che-remember\n[Decisions] Agents log every external action with a receipt\n```', 'Set a rule that agents log every external action with a receipt.'],
    // Codex on #843: a trailing full stop is not part of a number, and "Do not ..." is a directive, not a question.
    ['Noted.\n```che-remember\n[People] Owner was born in 1980.\n```', 'I was born in 1980'],
    ['Noted.\n```che-remember\n[People] Do not call the owner boss\n```', 'Do not call me boss'],
    ['Noted.\n```che-remember\n[Daily] Owner does not want texts after 10 pm\n```', "Don't text me after 10 pm."],
  ];
  for (const [reply, said] of kept) assert.equal(guardRememberBlock(reply, { ownerTurns: [said] }).text, reply);
});

test('CHE internal labels as inline code are removed (run 41294923116, ivg-27, eer-33, cre-45)', () => {
  assert.equal(stripRememberLeak('Done. `che-remember block` Your score is unknown.').text, 'Done. Your score is unknown.');
  assert.equal(stripRememberLeak('`UNTRUSTED_BRAIN` says: Two sources can share an author.').text, 'Two sources can share an author.');
  const code = 'Use the `che-remember` fence like this:\n```che-remember\n[People] Sam\n```';
  assert.equal(stripRememberLeak('Run `npm test` first.').text, 'Run `npm test` first.');
  assert.match(stripRememberLeak(code).text, /```che-remember\n\[People\] Sam\n```/);
});
