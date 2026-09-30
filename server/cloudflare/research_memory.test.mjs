import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addOwnerMemory,
  distillResearchNote,
  isResearchStyleJob,
  isSafeMemoryText,
  listMemoryNotes,
  writeResearchMemoryNote,
} from './research_memory.js';

test('research-style detection covers Atlas/Iris scout kinds', () => {
  assert.equal(isResearchStyleJob({ kind: 'fiverr_scout' }, { name: 'Atlas' }), true);
  assert.equal(isResearchStyleJob({ kind: 'opportunity_scout' }, { name: 'Iris' }), true);
  assert.equal(isResearchStyleJob({ kind: 'merge' }, { name: 'Knox', role: 'Security' }), false);
  assert.equal(
    isResearchStyleJob(
      { task: 'Scout Pinterest for printable planners', kind: '' },
      { name: 'Atlas', role: 'Research' },
    ),
    true,
  );
});

test('distill opportunity note keeps channel/offer/why/URL and rejects secrets', () => {
  const distilled = distillResearchNote({
    result: [
      'Channel: pinterest',
      'Offer: printable wedding planner pack',
      'Why: seasonal search demand on wedding boards',
      'URL: https://www.pinterest.com/search/pins/?q=wedding%20planner',
      'Confidence: medium',
    ].join('\n'),
    task: { id: 't1', kind: 'opportunity_scout', task: 'Scout Pinterest for planners' },
    agent: { name: 'Atlas', role: 'Research' },
  });
  assert.equal(distilled.ok, true);
  assert.equal(distilled.note.kind, 'opportunity');
  assert.match(distilled.note.channel, /pinterest/i);
  assert.match(distilled.note.offer, /planner/i);
  assert.match(distilled.note.why, /demand|wedding/i);
  assert.match(distilled.note.url, /^https:\/\/www\.pinterest\.com/);
  assert.ok(distilled.note.bullets.some((b) => /Owner gate/i.test(b)));
  assert.ok(distilled.note.owner_confirm_required);

  const blocked = distillResearchNote({
    result: 'Password: hunter2 and api_key sk-test should never be stored as a scout note.',
    task: { kind: 'opportunity_scout', task: 'scout' },
    agent: { name: 'Atlas' },
  });
  assert.equal(blocked.ok, false);
});

test('write-back updates memories + memory_notes via shared add path', () => {
  const data = { memories: [], memory_notes: [], learned_knowledge: [] };
  const agent = { name: 'Iris', role: 'Ad Studio', memory_refs: [] };
  const out = writeResearchMemoryNote(data, {
    result: [
      'Channel: fiverr',
      'Offer: Tonight Pack for salons',
      'Why: buyer briefs asking for Meta ad creatives',
      'URL: https://www.fiverr.com/categories/graphics-design',
      'Next: ask owner before any message.',
    ].join('\n'),
    task: { id: 'job-1', kind: 'fiverr_scout', task: 'Fiverr scout shortlist for: AI ads' },
    agent,
  });
  assert.equal(out.written, true);
  assert.equal(listMemoryNotes(data).length, 1);
  assert.ok(data.memories.length >= 1);
  assert.ok(isSafeMemoryText(data.memories[0]));
  assert.ok(data.learned_knowledge.length >= 1);
  assert.ok(agent.memory_refs.includes(out.note.id));

  assert.equal(addOwnerMemory(data, 'password is secret').added, false);
  assert.equal(addOwnerMemory(data, 'Likes concise status updates').added, true);
});
