import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyModelReading, classifyOwnerTurn, clearInterpretationCache, clipKeepingLimits, correctSpokenTerms,
  expandSlang, interpretOwnerTurn, interpretWithModel, parseReading, phoneticKey,
} from './speech_intent.js';

const COMPLETION = /\b(done|sent|deleted|opened|merged|published|finished)\b/i;
const user = (text) => ({ role: 'user', content: text });
const assistant = (text) => ({ role: 'assistant', content: text });

// ---- Mispronounced technology names -------------------------------------

test('"Showbird" next to build words is corrected to Shorebird and the change is reported', () => {
  const out = correctSpokenTerms('The Showbird patch failed on my phone');
  assert.equal(out.text, 'The Shorebird patch failed on my phone');
  assert.deepEqual(out.changes, [{ heard: 'Showbird', meant: 'Shorebird' }]);
});

test('"size store" with install words is corrected to SideStore', () => {
  const out = correctSpokenTerms('Can you check if the size store app is installed');
  assert.match(out.text, /SideStore app is installed/);
});

test('a sound-alike tech name is fixed from context when no exact alias exists', () => {
  assert.match(correctSpokenTerms('the cloudflair build is stuck').text, /Cloudflare build is stuck/);
});

test('the same sounds in ordinary sentences are left alone', () => {
  assert.equal(correctSpokenTerms('I saw a showbird at the zoo').text, 'I saw a showbird at the zoo');
  assert.equal(correctSpokenTerms('I went to the size store on Main Street').text, 'I went to the size store on Main Street');
});

test('"Shay" or "Chay" addressing CHE is corrected, but not mid-sentence', () => {
  assert.equal(correctSpokenTerms('Shay, what is the status').text, 'CHE, what is the status');
  assert.equal(correctSpokenTerms('Hey chay what is up').text, 'Hey CHE what is up');
  assert.equal(correctSpokenTerms('The chay tea was good').text, 'The chay tea was good');
});

test('spoken brand names with spaces become their written form', () => {
  assert.equal(correctSpokenTerms('ask chat gpt and you tube').text, 'ask ChatGPT and YouTube');
});

test('phonetic keys treat spelling variants as one sound', () => {
  assert.equal(phoneticKey('phone'), phoneticKey('fone'));
  assert.notEqual(phoneticKey('grok'), phoneticKey('gemini'));
});

// ---- Slang and informal English -----------------------------------------

test('slang is expanded only for understanding', () => {
  assert.equal(expandSlang('lemme see if u can fix it pls'), 'let me see if you can fix it please');
});

test('"I wanna check the build" is an action request', () => {
  assert.equal(classifyOwnerTurn('I wanna check the Shorebird build').kind, 'action');
});

test('"lemme send Sam a quick note" is an action request, not a question', () => {
  assert.equal(classifyOwnerTurn('lemme send Sam a quick note').kind, 'action');
});

// ---- Incomplete and interrupted requests --------------------------------

test('a rambling, unfinished request is not guessed at or turned into a question', () => {
  const out = interpretOwnerTurn('so the thing with the uh the');
  assert.equal(out.kind, 'unclear');
  assert.equal(out.clarify, null);
  assert.equal(out.text, 'so the thing with the uh the');
});

test('an interruption that calls the request off is dropped without running anything', () => {
  const out = interpretOwnerTurn('send the build to Sam, actually never mind');
  assert.equal(out.kind, 'cancel');
  assert.equal(out.clarify, 'Okay, I have dropped that.');
  assert.equal(out.passthrough, true);
  assert.doesNotMatch(out.clarify, COMPLETION);
});

test('a bare "never mind" or "forget it" cancels, while a plain "no" stays a no', () => {
  assert.equal(classifyOwnerTurn('never mind', { hasHeldAction: true }).kind, 'cancel');
  assert.equal(classifyOwnerTurn('forget it').kind, 'cancel');
  assert.equal(classifyOwnerTurn('no').kind, 'no');
  assert.equal(interpretOwnerTurn('never mind', { hasHeldAction: true }).clarify, 'Okay, I have dropped that.');
});

test('a self-correction is recognised and not turned into a new request', () => {
  const out = interpretOwnerTurn('okay so the build, wait, I meant the Shorebird build');
  assert.equal(out.kind, 'correction');
  assert.equal(out.clarify, null);
});

test('a plain "no" passes through to the reply, without being turned into a request', () => {
  const out = interpretOwnerTurn('no');
  assert.equal(out.kind, 'no');
  assert.equal(out.passthrough, true);
  assert.equal(out.text, 'no');
});

// ---- References to previous conversation and follow-up questions --------

test('"fix it" resolves to the earlier request, and the resolution is visible in the text', () => {
  const out = interpretOwnerTurn('fix it', { history: [user('The Shorebird patch failed on my iPhone'), assistant('Got it.')] });
  assert.equal(out.kind, 'followup');
  assert.equal(out.clarify, null);
  assert.equal(out.text, 'About the earlier request, "The Shorebird patch failed on my iPhone": fix it');
  assert.equal(out.referent, 'The Shorebird patch failed on my iPhone');
});

test('"do the same thing" repeats the earlier request without asking', () => {
  const out = interpretOwnerTurn('do the same thing', { history: [user('Send Sam the update')] });
  assert.equal(out.clarify, null);
  assert.match(out.text, /Send Sam the update": do the same thing$/);
});

test('"what about now?" keeps the topic of the question before it', () => {
  const out = interpretOwnerTurn('what about now?', { history: [user("What's the weather in Lisbon?"), assistant('Mild, around 20.')] });
  assert.equal(out.clarify, null);
  assert.match(out.text, /What's the weather in Lisbon\?": what about now\?$/);
});

test('"why?" keeps the topic of the last request', () => {
  const out = interpretOwnerTurn('why?', { history: [user('The build failed on the phone')] });
  assert.equal(out.kind, 'followup');
  assert.match(out.text, /The build failed on the phone": why\?$/);
});

test('a full new question does not drag in the old topic', () => {
  const out = interpretOwnerTurn('why did the build fail', { history: [user('Show my Shorebird builds')] });
  assert.equal(out.kind, 'question');
  assert.equal(out.text, 'why did the build fail');
  assert.equal(out.referent, '');
});

test('a topic change is kept as it is, with no old referent attached', () => {
  const out = interpretOwnerTurn("What's the weather in Lisbon tomorrow?", { history: [user('Show my Shorebird builds')] });
  assert.equal(out.text, "What's the weather in Lisbon tomorrow?");
  assert.equal(out.referent, '');
});

// ---- Ambiguity: ask one short question only when it matters -------------

test('"fix it" with nothing earlier asks one short question instead of guessing', () => {
  const out = interpretOwnerTurn('fix it', { history: [] });
  assert.equal(out.clarify, 'Which one do you mean?');
  assert.equal(out.passthrough, false);
});

test('a bare "why?" with no earlier turn goes to the reply instead of asking which one', () => {
  const out = interpretOwnerTurn('Why', { history: [] });
  assert.equal(out.clarify, null);
  assert.equal(out.text, 'Why');
});

test('a bare "yes" with nothing to confirm goes to the reply unchanged, asking nothing', () => {
  const out = interpretOwnerTurn('yes', { history: [] });
  assert.equal(out.passthrough, true);
  assert.equal(out.clarify, null);
  assert.equal(out.text, 'yes');
});

// ---- Confirmation before consequential actions --------------------------

test('"delete that one" with no name asks which one before anything is touched', () => {
  const out = interpretOwnerTurn('delete that one', { history: [user('show my notes')] });
  assert.equal(out.consequential, true);
  assert.equal(out.clarify, 'Which one should I delete? Tell me its name first.');
  assert.doesNotMatch(out.clarify, COMPLETION);
});

test('an explicit consequential request is not second-guessed by a question', () => {
  const out = interpretOwnerTurn('buy me the Shorebird book');
  assert.equal(out.consequential, true);
  assert.equal(out.clarify, null);
});

test('"yes" right after CHE asked to confirm an action releases that action, once', () => {
  const history = [
    user('clean up the old stuff'),
    assistant('Just to be sure, do you want me to delete the old notes? Say yes, or tell me what you mean.'),
  ];
  const out = interpretOwnerTurn('yes', { history });
  assert.equal(out.text, 'delete the old notes');
});

test('"yes" while a request is held is passed through for the owner gate to release', () => {
  const out = interpretOwnerTurn('yes', { history: [user('delete my notes')], hasHeldAction: true });
  assert.equal(out.passthrough, true);
  assert.equal(out.text, 'yes');
});

test('an acknowledgement after a request never repeats that request', () => {
  for (const ack of ['okay', 'yes', 'cool', 'do it']) {
    const out = interpretOwnerTurn(ack, { history: [user('Send Sam the update'), assistant('Sent.')] });
    assert.equal(out.text, ack, `"${ack}" must not re-run the earlier request`);
    assert.doesNotMatch(out.text, /Send Sam/);
  }
});

// ---- Model layer for what the rules cannot read -------------------------

test('a model reading adds a likely meaning for an unclear request, without executing it', async () => {
  clearInterpretationCache();
  const rule = interpretOwnerTurn('that phone stuff thing from before the other day');
  const reading = await interpretWithModel({
    runText: async () => '{"intent":"action","meaning":"open the Shorebird status on the phone","confidence":0.8,"clarify":""}',
    text: 'that phone stuff thing from before the other day',
  });
  const out = applyModelReading(rule, reading);
  assert.equal(out.modelRead, true);
  assert.equal(out.kind, 'action');
  assert.match(out.text, /\(Likely meaning from context: open the Shorebird status on the phone\)$/);
});

test('an unreadable model answer is ignored and the rule reading stands', async () => {
  clearInterpretationCache();
  const rule = interpretOwnerTurn('that phone stuff thing from before the other day');
  const reading = await interpretWithModel({ runText: async () => 'I think you mean the phone', text: 'that phone stuff thing from before the other day' });
  assert.equal(reading, null);
  assert.equal(applyModelReading(rule, reading), rule);
});

test('a low-confidence model reading asks one question instead of proceeding', () => {
  const rule = interpretOwnerTurn('the thing on the phone with the app');
  const reading = parseReading('{"intent":"unclear","meaning":"","confidence":0.3,"clarify":"Do you mean the phone or the app"}');
  const out = applyModelReading(rule, reading);
  assert.equal(out.clarify, 'Do you mean the phone or the app?');
  assert.equal(out.text, rule.text);
});

test('a model reading that would act on money or deletion becomes a confirmation question', () => {
  const rule = interpretOwnerTurn('clean up the old stuff');
  const reading = { intent: 'action', meaning: 'delete the old notes', confidence: 0.9, clarify: '' };
  const out = applyModelReading(rule, reading);
  assert.equal(out.consequential, true);
  assert.equal(out.clarify, 'Just to be sure, do you want me to delete the old notes? Say yes, or tell me what you mean.');
  assert.equal(out.text, rule.text);
});

test('a model reading that claims something was done is never used', () => {
  const rule = interpretOwnerTurn('the thing from before');
  const reading = { intent: 'action', meaning: 'I already deleted the notes', confidence: 0.99, clarify: '' };
  assert.equal(applyModelReading(rule, reading), rule);
});

test('model readings are cached and time out, so a slow engine cannot stall a turn', async () => {
  clearInterpretationCache();
  let calls = 0;
  const runText = async () => { calls++; return '{"intent":"chitchat","meaning":"small talk","confidence":0.9,"clarify":""}'; };
  await interpretWithModel({ runText, text: 'same unclear words here' });
  await interpretWithModel({ runText, text: 'same unclear words here' });
  assert.equal(calls, 1);
  const slow = await interpretWithModel({ runText: () => new Promise(() => {}), text: 'never answers', timeoutMs: 20 });
  assert.equal(slow, null);
});

test('model JSON is parsed strictly: unknown intents and out-of-range confidence are rejected', () => {
  assert.equal(parseReading('{"intent":"delete","meaning":"x","confidence":0.9}'), null);
  assert.equal(parseReading('{"intent":"action","meaning":"x","confidence":2}'), null);
  assert.equal(parseReading('no json here'), null);
});

test('no clarifying question ever claims an action happened', () => {
  const cases = [
    interpretOwnerTurn('fix it', { history: [] }),
    interpretOwnerTurn('yes', { history: [] }),
    interpretOwnerTurn('delete that one', { history: [user('show my notes')] }),
    interpretOwnerTurn('send the build to Sam, actually never mind'),
  ];
  for (const out of cases) if (out.clarify) assert.doesNotMatch(out.clarify, COMPLETION);
});

// ---- Bounded text never loses the owner's limits (issue #345) -----------

const LATE = "but don't email Mark until Friday";
const NOT_SHOWN = / … \[(\d+) characters not shown\] … /g;
// A long request whose last clause holds the limit, and no limit words before it.
const LONG_ASK = 'Send the weekly report to the whole team with the charts from the dashboard, '
  + 'and add the summary of what changed in the review, '.repeat(6) + LATE;

test('a bounded owner sentence keeps its start, its late "don\'t", its conditions, dates and amounts, and marks the rest', () => {
  const long = 'Send the weekly report to the whole team with the charts from the dashboard, '
    + 'and add the summary of what changed in the review, '.repeat(12)
    + 'unless Sarah asks for the draft first, attach the $40 invoice from October 3, '
    + 'and include the slides from the planning session, '.repeat(8) + `${LATE}.`;
  const out = clipKeepingLimits(long, 300);
  assert.ok(out.length < 420, `bounded near the limit, got ${out.length}`);
  assert.match(out, /^Send the weekly report to the whole team/);
  assert.match(out, /unless Sarah asks for the draft first/);
  assert.match(out, /\$40 invoice from October 3/);
  assert.ok(out.endsWith(`${LATE}.`), out);
  // The marker says exactly how much is not shown: shown text plus hidden counts is the original.
  const hidden = [...out.matchAll(NOT_SHOWN)].reduce((sum, m) => sum + Number(m[1]), 0);
  assert.ok(hidden > 0);
  assert.equal(out.replace(NOT_SHOWN, '  ').length + hidden, long.length);
  assert.equal(clipKeepingLimits('Send it, but not today.', 300), 'Send it, but not today.', 'short text is untouched');
});

test('one long unpunctuated sentence keeps its first words and its last ones around a visible marker', () => {
  const speech = 'okay so ' + 'the launch review notes for the whole team '.repeat(20) + LATE;
  const out = clipKeepingLimits(speech, 200);
  assert.ok(out.length <= 260, `got ${out.length}`);
  assert.match(out, /^okay so the launch review/);
  assert.ok(out.endsWith(LATE), out);
  assert.match(out, NOT_SHOWN);
  // Pasted figures are bounded too: dates and amounts give way before the late limit does.
  const rows = clipKeepingLimits('row 1, '.repeat(2000) + LATE, 300);
  assert.ok(rows.length <= 340, `got ${rows.length}`);
  assert.ok(rows.endsWith(LATE), rows);
});

test('"do it again" after a long request carries its whole last clause, not the first 200 characters', () => {
  assert.ok(LONG_ASK.length > 300);
  const out = interpretOwnerTurn('do it again', { history: [user(LONG_ASK), assistant('Done, sir.')] });
  assert.equal(out.clarify, null);
  assert.equal(out.referent, LONG_ASK);
  assert.ok(out.text.endsWith(`${LATE}": do it again`), out.text);
});

test('an earlier turn longer than 2,000 characters still reaches the referent with its last words', () => {
  const huge = 'Send the weekly report to the whole team, ' + 'and add the summary of what changed in the review, '.repeat(50) + LATE;
  assert.ok(huge.length > 2500);
  const out = interpretOwnerTurn('fix it', { history: [user(huge), assistant('Got it.')] });
  assert.match(out.text, /but don't email Mark until Friday": fix it$/);
});

test('a long consequential reading is asked about whole, so the question names the late limit and a yes keeps it', () => {
  const owner = 'the old stuff in the shared folder from the spring launch with all the drafts and the duplicate exports, but do not email Mark until Friday';
  const rule = interpretOwnerTurn(owner);
  assert.equal(rule.kind, 'unclear');
  const meaning = 'delete the old drafts and the duplicate exports in the shared spring launch folder, and do not email Mark about it until Friday';
  assert.ok(meaning.length > 120);
  const out = applyModelReading(rule, { intent: 'action', meaning, confidence: 0.9, clarify: '' });
  assert.equal(out.clarify, `Just to be sure, do you want me to ${meaning}? Say yes, or tell me what you mean.`);
  const yes = interpretOwnerTurn('yes', { history: [user(owner), assistant(out.clarify)] });
  assert.equal(yes.text, meaning, 'the yes releases the whole meaning, with "until Friday"');
});

test('a reading that leaves out the owner\'s "don\'t" gets his own words back in the confirmation question', () => {
  const owner = 'the old stuff in the shared folder from the spring launch with all the drafts, but don\'t email Mark until Friday';
  const rule = interpretOwnerTurn(owner);
  assert.equal(rule.kind, 'unclear');
  const out = applyModelReading(rule, { intent: 'action', meaning: 'delete the old drafts in the shared spring launch folder', confidence: 0.9, clarify: '' });
  assert.equal(out.clarify, "Just to be sure, do you want me to delete the old drafts in the shared spring launch folder, but don't email Mark until Friday? Say yes, or tell me what you mean.");
  const yes = interpretOwnerTurn('yes', { history: [user(owner), assistant(out.clarify)] });
  assert.match(yes.text, /don't email Mark until Friday$/);
});

test('a model meaning over its bound keeps its late limit, marked', () => {
  const meaning = 'send the weekly report to the whole team with the charts from the dashboard, '
    + 'and add the summary of what changed in the review, '.repeat(8) + LATE;
  const reading = parseReading(JSON.stringify({ intent: 'action', meaning, confidence: 0.9, clarify: '' }));
  assert.ok(reading.meaning.endsWith(LATE), reading.meaning);
  assert.match(reading.meaning, NOT_SHOWN);
});

test('the reading model sees the late "don\'t" of an earlier long turn, not only its first 160 characters', async () => {
  clearInterpretationCache();
  let sent = '';
  await interpretWithModel({
    runText: async (messages) => { sent = messages[1].content; return '{"intent":"chitchat","meaning":"","confidence":0.9,"clarify":""}'; },
    text: 'the same as that thing from before',
    history: [user(LONG_ASK), assistant('Done, sir.')],
  });
  assert.match(sent, /but don't email Mark until Friday/);
});

test('a long limit clause keeps its "don\'t" when the text is bounded (review of #352)', () => {
  const sent = clipKeepingLimits('Draft the reply to Sarah about the quarterly budget review meeting next week with the updated numbers from finance and do not send it to anyone until I have read the whole thing myself tonight', 160);
  assert.match(sent, /do not send it/);
  const starred = clipKeepingLimits('Clean up my old photo albums from the trip and the party but never remove the ones I starred last year', 80);
  assert.match(starred, /never remove/);
  assert.match(starred, /characters not shown\]$/, 'what was left out at the end is marked');
});

test('comprehension audit: a cancel calls off only what it points back to', () => {
  // "Forget that X" asks CHE to forget a memory (a delete the gate holds), and "don't forget" asks her to remember.
  for (const text of ['Forget that my favorite color is blue.', 'forget that i park on level 3', "Don't forget that my mom's birthday is June 3rd.", 'dont forget it']) {
    assert.notEqual(interpretOwnerTurn(text).kind, 'cancel', text);
  }
  // A leading cancel drops the earlier thing; the new question is what is read and routed.
  const next = interpretOwnerTurn("Never mind that, what's my favorite food?");
  assert.equal(next.text, "what's my favorite food?");
  assert.equal(next.clarify, null);
  assert.equal(interpretOwnerTurn('forget it, just tell me the weather').text, 'just tell me the weather');
  assert.equal(interpretOwnerTurn("never mind the weather, what's on my calendar?").text, "what's on my calendar?");
  assert.equal(interpretOwnerTurn('never mind whats my favorite food').text, 'whats my favorite food');
  assert.equal(interpretOwnerTurn('never mind the weather').clarify, 'Okay, I have dropped that.');
  // Still cancelled: alone, at the end, or mid-turn.
  for (const text of ['never mind', 'Forget that.', 'oh forget that', 'scratch that', 'Remember that I hate mushrooms. Actually, cancel that.',
    'Buy 2 apples at Walmart—actually, cancel that', 'Pay my rent, actually never mind.', 'Buy apples, actually no, buy oranges']) {
    assert.equal(interpretOwnerTurn(text).clarify, 'Okay, I have dropped that.', text);
  }
});

// Comprehension audit, review of PR #356 (issue #350): with an action held, a turn that opens with a cancel calls it
// off. The words after it are never a yes that releases the hold.
test('review #356: a cancel-led turn with a held action is a cancel, never a yes', () => {
  for (const said of ['actually no, yes', 'never mind, yes', 'forget it, yes please', 'scratch that, yes', 'Never mind. Yes.']) {
    const held = interpretOwnerTurn(said, { hasHeldAction: true });
    assert.equal(held.kind, 'cancel', said);
    assert.equal(held.passthrough, true, said);
    assert.equal(held.clarify, 'Okay, I have dropped that.', said);
    assert.equal(held.text.includes('yes') && held.kind === 'yes', false, said);
  }
  assert.equal(classifyOwnerTurn('never mind that, what is on my calendar?', { hasHeldAction: true }).kind, 'cancel');
  // With nothing held, the same words keep their meaning: a plain yes is an acknowledgement, a cancel is a cancel.
  assert.equal(classifyOwnerTurn('never mind, yes', { hasHeldAction: false }).kind, 'yes');
  assert.equal(classifyOwnerTurn('yes, never mind', { hasHeldAction: true }).kind, 'cancel');
  // A plain yes still releases the hold, so the cancel rule does not turn real yeses into cancels.
  assert.equal(classifyOwnerTurn('yes', { hasHeldAction: true }).kind, 'yes');
});
