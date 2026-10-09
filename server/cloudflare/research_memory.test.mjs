import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addOwnerMemory,
  buildAgentTaskNodes,
  buildBrainGraph,
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

  const firstFavorite = addOwnerMemory(data, 'Favorite drink: Cola');
  assert.equal(firstFavorite.added, true);
  const correctedFavorite = addOwnerMemory(data, 'My favorite drink is Sprite');
  assert.equal(correctedFavorite.added, true);
  assert.deepEqual(correctedFavorite.replaced, ['Favorite drink: Cola']);
  assert.equal(data.memories.some((m) => /cola/i.test(m)), false);
  assert.equal(data.memories.some((m) => /favorite drink is sprite/i.test(m)), true);
});

test('live agent task nodes show only real queued/running/reviewing work', () => {
  assert.deepEqual(buildAgentTaskNodes({}), []);
  assert.deepEqual(buildAgentTaskNodes({ team_tasks: '' }), []);
  const data = {
    team_tasks: [
      { id: 't-run', partner_name: 'Atlas', task: 'Scout public research on neural interfaces', status: 'running', created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:01:00.000Z' },
      { id: 't-done', partner_name: 'Nova', task: 'Old finished listing work', status: 'complete' },
      { id: 't-fail', partner_name: 'Knox', task: 'Old failed build', status: 'failed' },
      { id: 't-queue', partner_name: 'Mira', task: 'Draft support copy for the new release', status: 'queued', created_at: '2026-10-09T00:02:00.000Z' },
    ],
  };
  const nodes = buildAgentTaskNodes(data);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((n) => n.region === 'Office Agents' && n.kind === 'agent_task'));
  assert.match(nodes[0].title, /Atlas/);
  assert.match(nodes[0].body, /running/);
  assert.equal(nodes[0].task_id, 't-run');
  assert.ok(!nodes.some((n) => n.task_id === 't-done' || n.task_id === 't-fail'));

  const capped = buildAgentTaskNodes({
    team_tasks: Array.from({ length: 30 }, (_, i) => ({ id: `t-${i}`, partner_name: 'Atlas', task: `research item ${i}`, status: 'queued' })),
  }, { max: 5 });
  assert.equal(capped.length, 5);
});

test('brain graph links live agent nodes to related memory notes', () => {
  const data = {
    memory_notes: [
      { id: 'n1', title: 'Neural interface research roundup', bullets: ['Public labs publish open neural interface benchmarks'], kind: 'research' },
    ],
    learned_knowledge: [],
    team_tasks: [
      { id: 't1', partner_name: 'Atlas', task: 'Scout public research on neural interfaces and benchmarks', status: 'running' },
    ],
  };
  const base = buildBrainGraph(data);
  assert.equal(base.counts.live, 0);
  assert.ok(base.nodes.every((n) => n.kind !== 'agent_task'));

  const live = buildBrainGraph(data, { liveNodes: buildAgentTaskNodes(data) });
  assert.equal(live.counts.live, 1);
  const taskNode = live.nodes.find((n) => n.id === 'agent-task-t1');
  assert.ok(taskNode);
  assert.ok(live.links.some((l) => (l.source === 'agent-task-t1' && l.target === 'n1') || (l.source === 'n1' && l.target === 'agent-task-t1')));
});

test('bounded brain graph does not falsely hide an agent behind another agent batch', () => {
  const team_tasks = Array.from({ length: 35 }, (_, i) => ({
    id: `atlas-${i}`, partner_name: 'Atlas', partner_id: 'atlas-id',
    task: `Atlas queue ${i}`, status: 'queued',
  }));
  team_tasks.push({ id: 'sage-live', partner_name: 'Sage', partner_id: 'sage-id', task: 'Verify accounts', status: 'running' });
  const nodes = buildAgentTaskNodes({ team_tasks });
  assert.equal(nodes.length, 20);
  assert.ok(nodes.some((n) => n.agent === 'Sage' && n.task_id === 'sage-live'));
  assert.ok(nodes.some((n) => n.agent === 'Atlas'));
});
