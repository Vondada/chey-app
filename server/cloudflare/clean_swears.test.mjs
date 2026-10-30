// A clean-language turn never carries a swear word, even one the model repeats from earlier turns (live social probe,
// Test 5 turn 2: "your earlier mention of almost losing your 'shit'"). Offline, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cleanLanguageReply, hasProfanity } from './social_corrections.js';

test('the live Test 5 reply loses its swear word and keeps the rest', () => {
  const reply = `Sir, I don't have any real-time traffic updates, but your earlier mention of almost losing your "shit" implies it was pretty bad.`;
  const clean = cleanLanguageReply(reply);
  assert.equal(hasProfanity(clean), false);
  assert.equal(clean, `Sir, I don't have any real-time traffic updates, but your earlier mention of almost losing your "stuff" implies it was pretty bad.`);
});

test('each swear word maps to a plain word, matched case-insensitively', () => {
  assert.equal(cleanLanguageReply('That was FUCKING bad, damn it, bullshit.'), 'That was freaking bad, darn it, nonsense.');
  assert.equal(cleanLanguageReply('What an asshole. Get off your ass.'), 'What an jerk. Get off your butt.');
  assert.equal(hasProfanity(cleanLanguageReply('motherfucker, you crap, bitch, dick, pussy, bastard')), false);
});

test('a reply with no swear word is returned unchanged, and words that only contain one are kept', () => {
  const clean = 'Sir, that assessment is fine. Shipping the classic class of tests.';
  assert.equal(cleanLanguageReply(clean), clean);
  assert.equal(cleanLanguageReply('Assess the grass and the classroom.'), 'Assess the grass and the classroom.');
});

test('the Worker applies the swap to a clean-language turn after the truth pipeline', () => {
  const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(worker, /if \(social\?\.clean\) reply = cleanLanguageReply\(reply\);/);
  const verify = worker.indexOf('reply = verified.text;');
  const swap = worker.indexOf('if (social?.clean) reply = cleanLanguageReply(reply);');
  assert.ok(verify > 0 && swap > verify, 'the swap follows the truth pipeline');
});
