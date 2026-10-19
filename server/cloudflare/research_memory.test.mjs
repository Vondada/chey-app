import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addOwnerMemory,
  buildAgentTaskNodes,
  buildBrainGraph,
  distillResearchNote,
  hasSecretShape,
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

test('write-back keeps agent leads separate from owner-attested facts', () => {
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
  assert.equal(data.memories.length, 0, 'agent research must not become an owner-confirmed fact');
  assert.equal(out.memory_added, false);
  assert.equal(out.note.verification_status, 'unverified_research_lead');
  assert.ok(isSafeMemoryText(out.memory));
  assert.match(data.learned_knowledge[0], /Unverified research lead/);
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

// ─── Second review of #354: secret shapes ────────────────────────────────────
// Fixtures are built at run time from pieces, so no literal key, code or token sits in the repository.
const HEX_KEY_A = ['3f2a9c8e7d6b5a4f', '3e2d1c0b9a8f7e6d'].join(''); // 32 hex characters
const HEX_KEY_B = ['4f8a1c2e9b7d3f60', 'a5c8e1b4d9f2a7c3'].join(''); // 32 hex characters
const SLACK_WEBHOOK = ['https://hooks.slack.com/services/', 'T00000000/B00000000/', 'XXXXXXXXXXXXXXXXXXXXXXXX'].join('');
const PASS = ['Summer', '2026', '!'].join('');
const GROUPED_CODE = ['8F3K', '9LQ2', '7MZP', '4XWD'].join('-');
const RANDOM_PATH = ['Q7mZ2kP9', 'xL4vN8wR3tY6uB1c'].join('');
const BARE_SLACK = ['xoxb', '1234567890123', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
const TWILIO_AUTH = ['a1b2c3d4e5f6a7b8', 'c9d0e1f2a3b4c5d6'].join('');

test('secret shapes: long hex keys, webhook and link tokens, grouped codes and bare tokens are withheld (second review of #354)', () => {
  const secrets = [
    `The Fish key is ${HEX_KEY_A} — rotate it`,
    `Webhook URL ${SLACK_WEBHOOK}`,
    `The backup code is ${GROUPED_CODE}`,
    `The deploy key is ${HEX_KEY_B}`,
    `The deploy key is ${HEX_KEY_B.toUpperCase()}`,
    `The Twilio auth is ${TWILIO_AUTH}`,
    `Slack ${BARE_SLACK} is live`,
    `The recovery code is ${['ABCD', 'EFGH', 'IJKL', 'MNOP'].join('-')}`,
    `The recovery code is ${GROUPED_CODE.toLowerCase()}`,
    `Hook hooks.slack.com/services/${['T0/B0/', 'XXXXXXXXXXXXXXXXXXXXXXXX'].join('')}`,
    `Discord ${['https://discord.com/api/webhooks/', '123456789012345678/abcdefGHIJKL'].join('')} is set`,
    `See https://example.com/reset/${RANDOM_PATH} for the page`,
    `Open https://example.com/login?pw=${PASS} today`,
    `Clone https://vondada:${PASS}@github.com/Vondada/chey-app.git now`,
    `Credentials vondada:${PASS} for the test`,
    `The code is ${['1a2b3c4d5e6f', '7'].join('')}`,
    `The commit is ${['4acb3d97096606e878e462812571c34d851b704d', 'e'].join('')}`,
  ];
  for (const text of secrets) {
    assert.equal(isSafeMemoryText(text), false, text);
    assert.equal(hasSecretShape(text), true, text);
  }
});

test('ordinary commits, versions, figures, dates, slugs and links stay safe (second review of #354)', () => {
  const kept = [
    '+0.0125R', '-1.5%', '#350', 'PR 351', 'commit 4acb3d9', 'version v2.3.1', 'Build v2.3.1-rc1 passed',
    'Dated 2026-10-18', 'Deployed at 2026-10-18T21:00:00.000Z.', 'The meeting notes go on and on.',
    'The commit is 4acb3d970966 and 4acb3d97096606e878e462812571c34d851b704d', 'PR-351-READY tonight',
    'Next is brain-sync-follow-up-plan today', 'UUID 97d389bb-537b-425e-81c5-908ab17e5ce8 is fine',
    'See https://github.com/Vondada/chey-app/pull/351?ref=main',
    'See https://github.com/Vondada/chey-app/pull/354#issuecomment-1234567890',
    'See https://github.com/Vondada/chey-app/commit/4acb3d97096606e878e462812571c34d851b704d',
    'Read https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/ now',
    'See https://en.wikipedia.org/wiki/Amdahl%27s_law',
    'See https://www.fiverr.com/categories/graphics-design',
  ];
  for (const text of kept) {
    assert.equal(isSafeMemoryText(text), true, text);
    assert.equal(hasSecretShape(text), false, text);
  }
});

// ─── Third review of #354: the narrower code rule, Google document IDs, the broker key shape ──────
test('third review of #354: ordinary hyphenated words and Google document links are stored; the withheld codes, broker keys and link credentials stay withheld', () => {
  const PASS_SYM = ['Summer', '2026', '!'].join('');
  const PK_KEY = ['PK', 'Z9Y8X7W6V5U4T3S2R1Q'].join('');
  const DOC_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const kept = [
    'Keep the CHE-APP-V2-BETA plan in the drafts folder',
    'Form-1099-NEC-tax-2025 filed on time',
    'The iPhone-15-Pro-Max is the phone I want',
    'Sprint-12-week-3-retro notes are in the folder',
    `Here is the doc https://docs.google.com/document/d/${DOC_ID}/edit for Monday`,
    `Drive link https://drive.google.com/file/d/${DRIVE_ID}/view`,
  ];
  for (const text of kept) {
    assert.equal(isSafeMemoryText(text), true, text);
    assert.equal(hasSecretShape(text), false, text);
  }
  const withheld = [
    `The backup code is ${GROUPED_CODE}`,
    `The recovery code is ${['ABCD', 'EFGH', 'IJKL', 'MNOP'].join('-')}`,
    `The recovery code is ${GROUPED_CODE.toLowerCase()}`,
    `Result: the Alpaca key ${PK_KEY} was printed in the log.`,
    `Doc https://vondada:${PASS_SYM}@docs.google.com/document/d/${DOC_ID}/edit`,
    `Doc https://docs.google.com/document/d/${DOC_ID}/edit?pw=${PASS_SYM}`,
  ];
  for (const text of withheld) {
    assert.equal(isSafeMemoryText(text), false, text);
    assert.equal(hasSecretShape(text), true, text);
  }
});

// ─── Fourth review of #354: codes of any group length, and only Google's own document shapes ───────
test('fourth review of #354: 3- and 6-character code groups are withheld; Google document IDs after their own type are kept; a bare or random ID is withheld', () => {
  const PASS_SYM = ['Summer', '2026', '!'].join('');
  const DOC_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  // Built from pieces, so no literal key-shaped string sits in the repository (GitHub push protection).
  const STRIPE_LIKE = ['sk_live_', '4eC39HqLyjWDarjtT1zdp7dc'].join('');
  const SIX_GROUP = ['ABCDE1', 'FGHIJ2', 'KLMNO3', 'PQRST4'].join('-');
  const THREE_GROUP = ['AB1', 'CD2', 'EF3', 'GH4'].join('-');
  const withheld = [
    `Backup code ${SIX_GROUP} for the account`,
    `Backup code ${THREE_GROUP} for the account`,
    'Ship WARN-ERROR-FAIL-DONE tonight',
    `See https://docs.google.com/d/${STRIPE_LIKE} now`,
    `See https://docs.google.com/document/d/${RANDOM_PATH}/edit`,
    `Doc https://docs.google.com/document/d/${DOC_ID}/edit?pw=${PASS_SYM}`,
  ];
  for (const text of withheld) {
    assert.equal(isSafeMemoryText(text), false, text);
    assert.equal(hasSecretShape(text), true, text);
  }
  const kept = [
    `Here is the doc https://docs.google.com/document/d/${DOC_ID}/edit for Monday`,
    `Drive link https://drive.google.com/file/d/${DRIVE_ID}/view`,
    `Sheet https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=0`,
    `Folder https://drive.google.com/drive/folders/${DRIVE_ID}`,
    'Warn-Error-Fail-Done tonight',
    'Keep the CHE-APP-V2-BETA plan in the drafts folder',
    'Form-1099-NEC-tax-2025 filed on time',
    'The iPhone-15-Pro-Max is the phone I want',
    'Sprint-12-week-3-retro notes are in the folder',
  ];
  for (const text of kept) {
    assert.equal(isSafeMemoryText(text), true, text);
    assert.equal(hasSecretShape(text), false, text);
  }
});
