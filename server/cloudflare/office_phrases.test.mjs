import { matchOfficePhrase, speakOfficeBoard } from './office_phrases.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const board = {
  started_today: 2, finished_today: 1, agents_working: 1,
  blockers: ['Knox: Blocked: tool not configured'],
  stalled: [{ agent: 'Nova', task: 'Deep research', detail: 'no update in a while' }],
  stripe: { connected: false, charges_cents: 0, refunds_cents: 0, net_cents: 0 },
  agents: [{ id: 'knox', name: 'Knox', status: 'Blocked: tool not configured' }],
};

test('office phrases include stalled', () => {
  assert.equal(matchOfficePhrase("What's happening in the Office?")?.type, 'happening');
  assert.equal(matchOfficePhrase('What did they build today?')?.type, 'builtToday');
  assert.equal(matchOfficePhrase('How much did we make today?')?.type, 'earnedToday');
  assert.equal(matchOfficePhrase("What's stalled?")?.type, 'stalled');
  assert.equal(matchOfficePhrase('Read this Office to me')?.type, 'readOffice');
  assert.equal(matchOfficePhrase('What is Knox doing?')?.agentId, 'knox');
  assert.equal(matchOfficePhrase('Stand down')?.type, 'standDown');
});

test('CHE speaks board and disconnected stripe is zero', () => {
  const said = speakOfficeBoard(board, { type: 'readOffice' });
  assert.match(said, /^CHE here/);
  assert.match(said, /Stripe not connected/);
  assert.match(said, /\$0\.00/);
  assert.match(said, /Stalled: Nova/);
  assert.match(speakOfficeBoard(board, { type: 'stalled' }), /Nova/);
  assert.match(speakOfficeBoard(board, { type: 'agentStatus', agentId: 'knox' }), /Knox/);
});

test('Iris hire, Fiverr scout, tonight pack, and Iris status phrases', () => {
  assert.equal(matchOfficePhrase('hire Iris')?.type, 'hireIris');
  assert.equal(matchOfficePhrase('Chay, hire Iris for Ad Studio')?.type, 'hireIris');
  assert.equal(matchOfficePhrase('hire Iris to draft tonight pack for Cafe Luna')?.task, 'draft tonight pack for Cafe Luna');
  const scout = matchOfficePhrase('scout Fiverr for AI ad buyers');
  assert.equal(scout?.type, 'fiverrScout');
  assert.equal(scout?.query, 'AI ad buyers');
  assert.equal(matchOfficePhrase('draft tonight pack for Cafe Luna')?.type, 'goal');
  assert.match(matchOfficePhrase('draft tonight pack for Cafe Luna')?.goal || '', /tonight pack.*Cafe Luna/i);
  assert.equal(matchOfficePhrase('What is Iris doing?')?.agentId, 'iris');
});

test('opportunity scout phrases (Pinterest / dropship / forever)', () => {
  const pin = matchOfficePhrase('scout Pinterest for printable planners');
  assert.equal(pin?.type, 'opportunityScout');
  assert.equal(pin?.channel, 'pinterest');
  assert.equal(matchOfficePhrase('scout dropship for POD merch')?.channel, 'dropship_middleman');
  assert.equal(matchOfficePhrase('forever opportunity scout for AI ads')?.type, 'opportunityScout');
  // Fiverr stays on dedicated path
  assert.equal(matchOfficePhrase('scout Fiverr for AI ads')?.type, 'fiverrScout');
});
