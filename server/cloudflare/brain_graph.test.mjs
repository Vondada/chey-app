import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBrainGraph, enrichNoteForBrain, listMemoryNotes } from './research_memory.js';

test('memory_notes are unlimited for Brain listing', () => {
  const data = { memory_notes: [] };
  for (let i = 0; i < 120; i++) {
    data.memory_notes.push({ id: `n${i}`, title: `Note ${i}`, bullets: [`b${i}`], kind: 'knowledge' });
  }
  assert.equal(listMemoryNotes(data).length, 120);
});

test('buildBrainGraph links cluster mates and kinds', () => {
  const parent = enrichNoteForBrain(
    { id: 'p1', title: 'ML clustering job', bullets: ['silhouette 0.7'], created_at: new Date().toISOString() },
    { kind: 'ml_eval', metrics: { silhouette: 0.7 } },
  );
  const c0 = enrichNoteForBrain(
    { id: 'c0', title: 'Cluster 0', bullets: ['3 items'] },
    { kind: 'clustering', cluster_id: '0', related: ['p1'] },
  );
  const c0b = enrichNoteForBrain(
    { id: 'c0b', title: 'Cluster 0 mate', bullets: ['also 0'] },
    { kind: 'clustering', cluster_id: '0', related: ['p1'] },
  );
  const data = { memory_notes: [parent, c0, c0b], learned_knowledge: ['Never invent metrics.'] };
  const g = buildBrainGraph(data);
  assert.ok(g.nodes.length >= 4);
  assert.ok(g.links.some((l) => l.relation === 'cluster' || l.relation === 'explicit'));
  assert.equal(g.counts.memory_notes, 3);
});
