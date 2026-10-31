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
  // The live social probe (deploy 3001cbb1) failed on a reply that began "Warmth 7/10: You seem to be in a family-friendly...".
  assert.equal(stripSoulLabels('Warmth 7/10: You seem to be in a family-friendly environment, sir.'), 'You seem to be in a family-friendly environment, sir.');
  assert.equal(stripSoulLabels('Directness 8/10: Since you are around kids, plan something fun.'), 'Since you are around kids, plan something fun.');
  assert.equal(stripSoulLabels('Warmth 7/10 is what I give you, sir.'), 'Warmth 7/10 is what I give you, sir.');
  // The deployed Worker's live replies (certification run 40976828862) began "Warmth 9/10. ..." and "Warmth 9/10, sir." too.
  assert.equal(stripSoulLabels('Warmth 9/10. That is a fun one.'), 'That is a fun one.');
  assert.equal(stripSoulLabels('Warmth 9/10, sir. I am glad you asked.'), 'sir. I am glad you asked.');
  assert.equal(stripSoulLabels('Directness 8/10 - keep it short.'), 'keep it short.');
  assert.equal(stripSoulLabels('Detail: the record shows the date.'), 'Detail: the record shows the date.');
  assert.equal(stripSoulLabels('Plain reply.'), 'Plain reply.');
  assert.equal(stripSoulLabels(''), '');
});

test('the Worker strips labels from every chat reply it returns', () => {
  const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(worker, /stripPhoneSoul, stripSoulLabels \} from '\.\/soul\.js';/);
  assert.match(worker, /return \{ \.\.\.answer, response: stripSoulLabels\(reply\)/);
});

// The label strip removes only the label. Her voice, humor, flirting, cursing and feelings pass through unchanged.
test('her own voice is left byte-for-byte as written, with only a label removed', () => {
  const casual = "Oh my god, sir, that's fucking hilarious. Okay, okay, I'm dying. You owe me a drink for that one.";
  assert.equal(stripSoulLabels(casual), casual, 'profanity and a dry aside are kept');
  const flirty = "Look at you, handy as hell. Don't let it go to your head, though. Maybe I'll even let you buy me dinner.";
  assert.equal(stripSoulLabels(flirty), flirty, 'playful flirting is kept');
  const serious = "I'm sorry, sir. That sounds hard, and I want to make sure you're safe first. Tell me what you need right now.";
  assert.equal(stripSoulLabels(serious), serious, 'an emotional, serious reply is kept');
  const labelled = "Warmth: That's great, sir! Haha, okay, you got me.";
  assert.equal(stripSoulLabels(labelled), "That's great, sir! Haha, okay, you got me.", 'only the label goes');
});

test('a reply that quotes a trait word inside her own sentence keeps every word', () => {
  const reply = "Directness is my thing, sir, so here it is: you should call her back tonight.";
  assert.equal(stripSoulLabels(reply), reply);
});
