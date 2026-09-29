import { matchOfficePhrase, speakOfficeBoard } from './office_phrases.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const board = {
  started_today: 2, finished_today: 1, agents_working: 1,
  blockers: ['Knox: Blocked: tool not configured'],
  stripe: { connected: false, charges_cents: 0, refunds_cents: 0, net_cents: 0 },
  agents: [{ id: 'knox', name: 'Knox', status: 'Blocked: tool not configured' }],
};

test('six office phrases', () => {
  assert.equal(matchOfficePhrase("What's happening in the Office?")?.type, 'happening');
  assert.equal(matchOfficePhrase('What did they build today?')?.type, 'builtToday');
  assert.equal(matchOfficePhrase('How much did we make today?')?.type, 'earnedToday');
  assert.equal(matchOfficePhrase('Read this Office to me')?.type, 'readOffice');
  assert.equal(matchOfficePhrase('What is Knox doing?')?.agentId, 'knox');
  assert.equal(matchOfficePhrase('Stand down')?.type, 'standDown');
});

test('CHE speaks board and disconnected stripe is zero', () => {
  const said = speakOfficeBoard(board, { type: 'readOffice' });
  assert.match(said, /^CHE here/);
  assert.match(said, /Stripe not connected/);
  assert.match(said, /\$0\.00/);
  assert.match(speakOfficeBoard(board, { type: 'agentStatus', agentId: 'knox' }), /Knox/);
});
