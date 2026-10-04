// Regression: the live autonomy stress test (War Room "make the central
// table/orb feel alive"). Every attempt anchored edits on a CSS "orb" that
// does not exist, because the 8.7 KB War Room page was shown as windows that
// hid its real 3D table code; retries got only a generic "find not found";
// the owner's "Create the PR. Continue the original task…" ran as a NEW job;
// and the owner heard contradictory states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEdits, honestFailureMessage, looseLocate, nearestSource, packEvidence, prepareSelfUpdate, traceSourceGraph } from './self_development.js';
import { ownerEngineeringMessage, FAILURE_CLASS } from './recovery_policy.js';

const repo = new URL('../../', import.meta.url);
const WARROOM = 'assets/office3d/warroom.html'; // dead: nothing loads it
const AGENTS = 'assets/office3d/che3d-agents.js';
const SCREEN = 'lib/agents/che_war_room_screen.dart'; // live War Room screen
const SCENE = 'lib/widgets/che_native_scene_world.dart'; // live 3D renderer (the real table)
const FLOOR = 'lib/agents/che_office_floor_screen.dart'; // opens the War Room
const MAIN = 'lib/main.dart';
const real = (path) => readFileSync(new URL(path, repo), 'utf8');
const FILES = Object.fromEntries([WARROOM, AGENTS, SCREEN, SCENE, FLOOR, MAIN].map((path) => [path, real(path)]));
const TABLE_CORE = 'const tableCore = cylinder(.35,.45,.55,M.chrome,20); tableCore.position.set(0,.35,0); room.add(tableCore);';
const LIVE_TABLE = '            bottomRadius: 2.55,';
const REQUEST = 'Update the existing War Room in CHE. Find the current implementation yourself. Improve its immersive 3D-room feel and make the central table/orb feel more alive with subtle animation. Preserve the existing architecture and functionality.';

function fakeGitHub(files = FILES) {
  return async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/search/code')) {
      const q = decodeURIComponent(u.split('q=')[1] || '').split('" repo:')[0].replace(/^"/, '').toLowerCase();
      return ok({ items: Object.entries(files).filter(([, src]) => q && src.toLowerCase().includes(q)).map(([path]) => ({ path })) });
    }
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: 'abc' } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m && files[m[1]] !== undefined) return ok({ content: Buffer.from(files[m[1]]).toString('base64'), sha: `blob-${m[1]}` });
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function memoryStore() {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), m };
}

test('the War Room page is shown whole, so its real 3D table code is visible (not windows that hide it)', () => {
  const sources = new Map(Object.entries(FILES));
  const terms = ['war room', 'orb', 'table', 'animation', 'immersive'];
  // The real engineer budget (17000 input chars x 0.7) shows it whole.
  const evidence = packEvidence(sources, { terms, hits: new Map([[WARROOM, 4], [AGENTS, 2], [SCREEN, 1]]), budget: 11900 });
  const page = evidence.find((item) => item.path === WARROOM);
  assert.equal(page.whole_file, true);
  assert.ok(page.source.includes(TABLE_CORE));
  // Even a tight budget gives the target most of the room, table code included.
  const tight = packEvidence(sources, { terms, hits: new Map([[WARROOM, 4], [AGENTS, 2], [SCREEN, 1]]), budget: 8000 });
  assert.ok(tight.find((item) => item.path === WARROOM).source.includes('tableCore'));
  // An explicitly focused file wins too (e.g. after its anchor failed).
  const focused = packEvidence(sources, { terms, hits: new Map([[AGENTS, 4]]), budget: 20000, focus: [WARROOM] });
  assert.equal(focused.find((item) => item.path === WARROOM).whole_file, true);
});

test('a missing anchor returns the real nearest code with line numbers; a re-indented anchor still applies; ambiguity is never guessed', () => {
  const sources = new Map([[WARROOM, FILES[WARROOM]]]);
  const bad = applyEdits(sources, [{ path: WARROOM, find: '.orb { animation: none; } /* central table orb */', replace: 'x' }]);
  assert.match(bad.error, /does not exist exactly/);
  assert.match(bad.error, /closest real code/);
  assert.equal(bad.anchor_path, WARROOM);
  const near = nearestSource(FILES[WARROOM], 'const table = cylinder table tableCore orb');
  assert.ok(near.text.includes('tableCore'), near.text);
  assert.match(near.text, /^\d+\| /);

  const reindented = applyEdits(sources, [{ path: WARROOM, find: `      ${TABLE_CORE}   `, replace: `${TABLE_CORE}\n  tableCore.userData.pulse = true;` }]);
  assert.equal(reindented.error, undefined);
  assert.match(reindented.sources.get(WARROOM), /tableCore\.userData\.pulse = true;/);

  const twice = new Map([['a.js', 'x = 1;\n  y = 2;\nx = 1;\n  y = 2;\n']]);
  assert.equal(looseLocate(twice.get('a.js'), 'x = 1;\ny = 2;'), null, 'two loose matches: refuse');
  assert.match(applyEdits(twice, [{ path: 'a.js', find: 'x  =  1;\ny = 2;', replace: 'z' }]).error, /does not exist exactly/);
});

function warRoomEnv({ fixAfterFeedback = true, seen = [] } = {}) {
  return {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        const payload = JSON.parse(input.messages[1].content);
        if (system.includes('Architect')) {
          // The production planners: name-matched the dead HTML page.
          return { response: JSON.stringify({ plan: 'Animate the War Room table/orb.', search_terms: ['War Room', 'orb', 'table'], paths: [WARROOM, SCREEN] }) };
        }
        if (system.includes('Review')) return { response: JSON.stringify({ approved: true, target_correct: true, notes: ['Animates the live War Room table.'] }) };
        if (!payload.inspected) return { response: JSON.stringify({ plan: 'locate again', search_terms: ['warRoom'], paths: [SCENE] }) };
        const scene = (payload.inspected || []).find((item) => item.path === SCENE);
        const problem = String(payload.previous_attempt_problem || '');
        seen.push({ problem, discovery: payload.discovery, sceneVisible: Boolean(scene?.source.includes('bottomRadius: 2.55')) });
        if (fixAfterFeedback && /closest real code/.test(problem) && scene?.source.includes('bottomRadius: 2.55')) {
          return { response: JSON.stringify({ summary: 'Subtle glow on the live War Room table.', edits: [{ path: SCENE, find: LIVE_TABLE, replace: '            bottomRadius: 2.55, // War Room table (breathing glow)' }] }) };
        }
        if (/is dead/.test(problem)) {
          // Moves to the live file, but anchors on text that is not there.
          return { response: JSON.stringify({ summary: 'Pulse the table mesh.', edits: [{ path: SCENE, find: `final warRoomTable = CylinderGeometry(radius: 2.5); // table ${seen.length}`, replace: 'x' }] }) };
        }
        // The production hallucination: a CSS orb in the dead page.
        return { response: JSON.stringify({ summary: 'Pulse the central orb CSS element.', edits: [{ path: WARROOM, find: `#orb { animation: pulse ${seen.length}s; }`, replace: '#orb { animation: breathe 4s infinite; }' }] }) };
      },
    },
  };
}

test('the code graph finds the LIVE War Room (screen -> native 3D scene) and marks the name-matched HTML page dead', async () => {
  const index = { paths: Object.keys(FILES) };
  const graph = await traceSourceGraph({ CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' }, {
    index, request: REQUEST, seeds: [WARROOM, SCREEN], read: async (p) => FILES[p] ?? null, fetcher: fakeGitHub(),
  });
  const byPath = Object.fromEntries(graph.files.map((f) => [f.path, f]));
  assert.equal(byPath[WARROOM].live, false);
  assert.equal(byPath[SCREEN].live, true);
  assert.equal(byPath[SCENE].live, true, 'reached through the screen\'s import');
  assert.deepEqual(byPath[SCENE].callers, [SCREEN]);
  assert.ok(byPath[SCREEN].callers.includes(FLOOR));
  assert.deepEqual(graph.dead.includes(WARROOM), true);
  assert.equal(graph.contradiction, false, 'a live War Room exists, so no contradiction');
});

test('failure evidence flows into each retry: dead file -> live file -> exact anchor, then review passes', async () => {
  const seen = [];
  const out = await prepareSelfUpdate(warRoomEnv({ seen }), REQUEST, fakeGitHub(), memoryStore(), { intentRequest: REQUEST });
  assert.equal(out.status, 200, out.detail);
  assert.deepEqual(out.proposal.files.map((f) => f.path), [SCENE], 'the live renderer, never the dead page');
  assert.match(out.proposal.files[0].content, /War Room table \(breathing glow\)/);
  assert.ok(seen.some((s) => /is dead/.test(s.problem) && s.problem.includes(SCENE)), 'the dead-file gate named the live implementation');
  const anchorRetry = seen.find((s) => /closest real code/.test(s.problem));
  assert.ok(anchorRetry?.sceneVisible, 'the retry saw the real table code');
  assert.ok(seen[0].discovery.dead_files.includes(WARROOM));
  assert.ok(seen[0].discovery.live_files.some((f) => f.path === SCENE));
});

test('three failed passes stop (no loop), report what really happened, and keep usable evidence', async () => {
  const seen = [];
  const out = await prepareSelfUpdate(warRoomEnv({ fixAfterFeedback: false, seen }), REQUEST, fakeGitHub(), memoryStore(), { intentRequest: REQUEST });
  assert.equal(out.status, 422);
  assert.ok(seen.length <= 12, `bounded engineer calls, got ${seen.length}`);
  assert.doesNotMatch(out.owner_message, /three materially different|passed independent review/);
  assert.ok(out.engineering_record.failed_strategies.some((f) => f.outcome === 'dead_file'));
  assert.match(out.engineering_record.feedback, /closest real code|is dead/);
});

test('owner failure messages never claim what the record does not show', () => {
  assert.match(honestFailureMessage({ outcomes: [{ outcome: 'review_rejected' }], genuinePasses: 3 }), /tried 3 implementation passes and none passed independent review/);
  assert.match(honestFailureMessage({ outcomes: [{ outcome: 'no_diff' }], genuinePasses: 1 }), /could not produce a safe change in 1 implementation pass,/);
  assert.match(honestFailureMessage({ budgetStop: true, genuinePasses: 2 }), /engineering budget after 2/);
  assert.doesNotMatch(ownerEngineeringMessage(FAILURE_CLASS.INTERNAL), /three|review and validation/);
});

test('Discovery Contradiction: when every file named after the feature is dead, discovery broadens to its code spellings', async () => {
  const files = {
    'lib/main.dart': "import 'rooms/che_rooms_hub.dart';\nvoid main() {}\n",
    'lib/rooms/che_rooms_hub.dart': "class CheRoomsHub { final mode = SceneMode.tradingFloor; }\n",
    'assets/trading_floor.html': '<div id="floor">old trading floor page</div>\n',
  };
  const index = { paths: Object.keys(files) };
  const g = await traceSourceGraph({ CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' }, {
    index, request: 'Make the Trading Floor brighter.', seeds: ['assets/trading_floor.html'], read: async (p) => files[p] ?? null, fetcher: fakeGitHub(files),
  });
  assert.deepEqual(g.dead, ['assets/trading_floor.html']);
  assert.equal(g.contradiction, true);
  assert.match(g.notes.join(' '), /Discovery contradiction/);
  assert.ok(g.files.some((f) => f.path === 'lib/rooms/che_rooms_hub.dart' && /^trading.?floor$/i.test(f.found_by || '')), 'found the live code by its identifier spelling');
});

test('an asset loaded by a built path is never called dead', async () => {
  const files = {
    'lib/main.dart': "import 'rooms/che_room_loader.dart';\nvoid main() {}\n",
    'lib/rooms/che_room_loader.dart': "class CheRoomLoader { String asset(String room) => 'assets/rooms/$room.html'; }\n",
    'assets/rooms/garden.html': '<div>garden</div>\n',
  };
  const g = await traceSourceGraph({ CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' }, {
    index: { paths: Object.keys(files) }, request: 'Make the garden page greener.', seeds: ['assets/rooms/garden.html'], read: async (p) => files[p] ?? null, fetcher: fakeGitHub(files),
  });
  assert.equal(g.files.find((f) => f.path === 'assets/rooms/garden.html').live, null);
  assert.deepEqual(g.dead, []);
});
