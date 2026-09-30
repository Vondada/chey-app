import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOpportunityFitTask,
  buildOpportunityScoutTask,
  emptyOpportunityNote,
  normalizeOpportunityChannel,
  parseOpportunityScoutPhrase,
  speakOpportunityScoutPlan,
} from './opportunity_scout.js';
import { matchOfficePhrase } from './office_phrases.js';

test('channels normalize and shortlist blocks outbound spend', () => {
  assert.equal(normalizeOpportunityChannel('Pinterest'), 'pinterest');
  assert.equal(normalizeOpportunityChannel('drop shipping'), 'dropship_middleman');
  assert.equal(normalizeOpportunityChannel('forever'), 'multi');
  const note = emptyOpportunityNote('printable planners', 'pinterest');
  assert.equal(note.owner_confirm_required, true);
  assert.equal(note.outbound_allowed, false);
  assert.equal(note.auto_message, false);
  assert.equal(note.auto_buy_inventory, false);
  assert.equal(note.spend_without_confirm, false);
  assert.match(note.note_template, /never auto-message\/bid\/buy\/spend\/Stripe/i);
  assert.match(note.note_template, /maximize legal money-making/i);
});

test('scout tasks never authorize message, buy, or spend', () => {
  const task = buildOpportunityScoutTask('AI mockups', 'pinterest');
  assert.match(task, /pinterest/);
  assert.match(task, /Do NOT message/i);
  assert.match(task, /purchase inventory/i);
  assert.match(buildOpportunityFitTask('POD merch', 'dropship_middleman'), /do not send/i);
  assert.match(buildOpportunityFitTask('POD merch', 'dropship_middleman'), /Owner must confirm/i);
});

test('phrases match forever / Pinterest / dropship opportunity scout', () => {
  const pin = matchOfficePhrase('scout Pinterest for printable planners');
  assert.equal(pin?.type, 'opportunityScout');
  assert.equal(pin?.channel, 'pinterest');
  assert.match(pin?.query || '', /printable planners/i);

  const mid = matchOfficePhrase('scout dropship for print on demand merch');
  assert.equal(mid?.type, 'opportunityScout');
  assert.equal(mid?.channel, 'dropship_middleman');

  const forever = matchOfficePhrase('forever opportunity scout for AI ads');
  assert.equal(forever?.type, 'opportunityScout');
  assert.ok(forever?.channel);

  // Dedicated Fiverr phrase stays on the existing path.
  assert.equal(matchOfficePhrase('scout Fiverr for AI ad buyers')?.type, 'fiverrScout');

  const said = speakOpportunityScoutPlan(
    [{ agent: 'Atlas', task: 'Scout', blocker: '' }],
    'planners',
    'pinterest',
  );
  assert.match(said, /Opportunity scout queued on pinterest/i);
  assert.match(said, /will not auto-message, bid, buy, spend, or charge Stripe/i);

  assert.equal(parseOpportunityScoutPhrase('hello', 'hello'), null);
});
