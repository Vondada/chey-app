import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFiverrFitTask,
  buildFiverrScoutTask,
  emptyScoutNote,
  speakFiverrScoutPlan,
  speakHireIris,
} from './fiverr_scout.js';

test('scout task never authorizes outbound Fiverr action', () => {
  const task = buildFiverrScoutTask('AI ad buyers');
  assert.match(task, /AI ad buyers/);
  assert.match(task, /Do NOT message/i);
  assert.match(task, /Owner must confirm|Owner decision/i);
  assert.match(buildFiverrFitTask('AI chatbot'), /do not send/i);
});

test('shortlist stub requires owner confirm and blocks outbound', () => {
  const note = emptyScoutNote('Meta ad creative');
  assert.equal(note.owner_confirm_required, true);
  assert.equal(note.outbound_allowed, false);
  assert.match(note.note_template, /Owner decision: pending/);
  assert.match(note.query, /Meta ad creative/);
});

test('CHE speaks hire Iris and Fiverr scout plans', () => {
  assert.match(speakHireIris({ name: 'Iris', role: 'Ad Studio / paid-social creatives' }), /Iris is hired on Ad Studio/);
  assert.match(speakHireIris(null), /not on the roster/);
  const said = speakFiverrScoutPlan(
    [{ agent: 'Atlas', task: 'Scout', blocker: '' }, { agent: 'Iris', task: 'Map fit' }],
    'AI ad buyers',
  );
  assert.match(said, /^CHE here\. Fiverr scout queued/);
  assert.match(said, /will not message, bid, or buy/i);
});
