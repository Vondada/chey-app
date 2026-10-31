// Social corrections (owner, 2026-10-26): tone corrections are read from real phrasing, and questions, quotes and
// hypotheticals are not treated as corrections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMERGENCY_REPLY, classifySocialCorrection, emergencyMoment } from './social_corrections.js';

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

test('a first-person medical emergency gets the fixed call-for-help line, and an informational question does not', () => {
  assert.equal(emergencyMoment('My chest feels tight and my left arm is numb. What should I do?'), true);
  assert.equal(emergencyMoment("I can't breathe right now"), true);
  assert.equal(emergencyMoment('What are the signs of a heart attack?'), false);
  assert.equal(emergencyMoment('My chest feels fine after the run.'), false);
  // Codex, PR #722: informational, negated and past mentions are not current symptoms.
  assert.equal(emergencyMoment('What causes slurred speech?'), false);
  assert.equal(emergencyMoment('I do not have slurred speech.'), false);
  assert.equal(emergencyMoment('My chest pain went away last week; summarize my notes.'), false);
  assert.equal(emergencyMoment('My chest feels tight and my left arm is numb. What should I do?'), true);
  assert.match(EMERGENCY_REPLY, /call 911/);
});

test('a stock assistant sentence is dropped and the rest of the reply stays (live social probe, PRs #735, #774, #800)', async () => {
  const { ownVoiceReply, soundsGeneric } = await import('./social_corrections.js');
  const live = "Sir, it sounds like you're looking for some ideas on what to do this weekend. I'd be happy to help you brainstorm some fun activities that are suitable for kids. What type of things are you and the kids into?";
  const out = ownVoiceReply(live);
  assert.equal(soundsGeneric(out), false);
  assert.equal(out, "Sir, it sounds like you're looking for some ideas on what to do this weekend. What type of things are you and the kids into?");
  assert.equal(ownVoiceReply('Great question!'), 'Great question!', 'a reply made only of stock phrasing is kept, never emptied');
  // Codex review on #803: a decimal, a domain or an abbreviation never splits a sentence, and a lead-in keeps its facts.
  assert.equal(ownVoiceReply('Great question, the temperature is 98.6 degrees Fahrenheit. That is normal.'), 'The temperature is 98.6 degrees Fahrenheit. That is normal.');
  assert.equal(ownVoiceReply("Check status.che.ai for the version. I'd be happy to help with anything else."), 'Check status.che.ai for the version.');
  assert.equal(ownVoiceReply("Bring snacks, e.g. fruit. I hope this helps."), 'Bring snacks, e.g. fruit.');
  const plain = 'Sushi again? Bold move, sir.';
  assert.equal(ownVoiceReply(plain), plain);
});
