// Social corrections (owner, 2026-10-26): tone corrections are read from real phrasing, and questions, quotes and
// hypotheticals are not treated as corrections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySocialCorrection } from './social_corrections.js';

test('Test A: "Chill, I\'m by my mama" asks for clean language, situational, with the owner-facing reply', () => {
  const r = classifySocialCorrection("Chill, I'm by my mama.");
  assert.equal(r.id, 'clean_language');
  assert.equal(r.scope, 'situational');
  assert.equal(r.patch.cleanLanguage, true);
  assert.equal(r.reply, 'Oh, my bad. Excuse my language.');
});

test('common corrections map to the expected change', () => {
  assert.equal(classifySocialCorrection("We're around company.").id, 'around_company');
  assert.equal(classifySocialCorrection('Keep it professional.').patch.formality, 8);
  assert.equal(classifySocialCorrection("Relax, it's just us.").patch.cleanLanguage, false);
  assert.equal(classifySocialCorrection("Don't talk to me like a robot.").patch.warmth, 8);
  assert.equal(classifySocialCorrection("You're doing too much.").patch.verbosity, 2);
  assert.equal(classifySocialCorrection('Be serious for a second.').id, 'serious_moment');
});

test('Test B: "from now on" makes a correction persistent; a one-off stays temporary', () => {
  assert.equal(classifySocialCorrection("From now on, don't talk to me like a robot.").scope, 'persistent');
  assert.equal(classifySocialCorrection('Be serious for a second.').scope, 'temporary');
});

test('questions about past instructions are not corrections (Test C/J guard)', () => {
  assert.equal(classifySocialCorrection('Remember how I told you to talk around my mama?'), null);
  assert.equal(classifySocialCorrection('Why are you being so formal?'), null);
});

test('quoted speech and hypotheticals are not corrections', () => {
  assert.equal(classifySocialCorrection('She said "keep it professional" in the meeting.'), null);
  assert.equal(classifySocialCorrection("If we were around company, keep it professional."), null);
});

test('ordinary messages and empty input return null', () => {
  assert.equal(classifySocialCorrection('What is the weather in Flagstaff?'), null);
  assert.equal(classifySocialCorrection(''), null);
  assert.equal(classifySocialCorrection(null), null);
});
