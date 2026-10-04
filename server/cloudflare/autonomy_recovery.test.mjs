// Regression: the live autonomy stress test (War Room "make the central
// table/orb feel alive"). Every attempt anchored edits on a CSS "orb" that
// does not exist, because the 8.7 KB War Room page was shown as windows that
// hid its real 3D table code; retries got only a generic "find not found";
// the owner's "Create the PR. Continue the original task…" ran as a NEW job;
// and the owner heard contradictory states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEdits, honestFailureMessage, looseLocate, nearestSource, packEvidence, prepareSelfUpdate } from './self_development.js';
import { ownerEngineeringMessage, FAILURE_CLASS } from './recovery_policy.js';

const repo = new URL('../../', import.meta.url);
const WARROOM = 'assets/office3d/warroom.html';
const AGENTS = 'assets/office3d/che3d-agents.js';
const SCREEN = 'lib/agents/che_war_room_screen.dart';
const real = (path) => readFileSync(new URL(path, repo), 'utf8');
const FILES = { [WARROOM]: real(WARROOM), [AGENTS]: real(AGENTS), [SCREEN]: real(SCREEN) };
const TABLE_CORE = 'const tableCore = cylinder(.35,.45,.55,M.chrome,20); tableCore.position.set(0,.35,0); room.add(tableCore);';
const REQUEST = 'Update the existing War Room in CHE. Find the current implementation yourself. Improve its immersive 3D-room feel and make the central table/orb feel more alive with subtle animation. Preserve the existing architecture and functionality.';

function fakeGitHub(files = FILES) {
  return async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/search/code')) {
      const q = decodeURIComponent(u.split('q=')[1] || '').replace(/"/g, '').split('+')[0].split(' repo:')[0].toLowerCase();
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
          return { response: JSON.stringify({ plan: 'Animate the central table core in the War Room 3D page.', search_terms: ['War Room', 'orb', 'table'], paths: [WARROOM, AGENTS, SCREEN] }) };
        }
        if (system.includes('Review')) return { response: JSON.stringify({ approved: true, target_correct: true, notes: ['Animates the real tableCore.'] }) };
        if (!payload.inspected) return { response: JSON.stringify({ plan: 'locate again', search_terms: ['tableCore'], paths: [WARROOM] }) };
        const page = (payload.inspected || []).find((item) => item.path === WARROOM);
        seen.push({ problem: String(payload.previous_attempt_problem || ''), whole: Boolean(page?.whole_file), sizes: (payload.inspected || []).map((i) => i.path + ':' + i.source.length + ':' + i.whole_file).join(' '), total: input.messages[1].content.length });
        const learned = /closest real code|most room/.test(payload.previous_attempt_problem || '');
        if (fixAfterFeedback && learned && page?.source.includes(TABLE_CORE)) {
          return { response: JSON.stringify({ summary: 'Subtle breathing pulse on the real table core.', edits: [{ path: WARROOM, find: TABLE_CORE, replace: `${TABLE_CORE}\n  tableCore.userData.pulse = true;` }] }) };
        }
        // The hallucinated strategy from production: a CSS orb that does not exist.
        return { response: JSON.stringify({ summary: 'Pulse the central orb CSS element.', edits: [{ path: WARROOM, find: `#orb { animation: pulse ${seen.length}s; }`, replace: '#orb { animation: breathe 4s infinite; }' }] }) };
      },
    },
  };
}

test('failure evidence flows into the next attempt, which fixes the real code and passes review', async () => {
  const seen = [];
  const out = await prepareSelfUpdate(warRoomEnv({ seen }), REQUEST, fakeGitHub(), memoryStore(), { intentRequest: REQUEST });
  assert.equal(out.status, 200, out.detail);
  assert.deepEqual(out.proposal.files.map((f) => f.path), [WARROOM]);
  assert.match(out.proposal.files[0].content, /tableCore\.userData\.pulse = true;/);
  const retry = seen.find((s) => /closest real code|most room/.test(s.problem));
  assert.ok(retry, 'the retry received the concrete previous failure');
  assert.equal(retry.whole, true, 'and saw the failed file whole');
  assert.match(retry.problem, /assets\/office3d\/warroom\.html/);
});

test('three failed passes stop (no loop), report what really happened, and keep usable evidence', async () => {
  const seen = [];
  const out = await prepareSelfUpdate(warRoomEnv({ fixAfterFeedback: false, seen }), REQUEST, fakeGitHub(), memoryStore(), { intentRequest: REQUEST });
  assert.equal(out.status, 422);
  assert.ok(seen.length <= 12, `bounded engineer calls, got ${seen.length}`);
  assert.equal(out.engineering_record.root_cause, 'edit_anchor');
  assert.match(out.owner_message, /edits did not match the current source of assets\/office3d\/warroom\.html/);
  assert.doesNotMatch(out.owner_message, /three materially different|passed independent review/);
  assert.match(out.engineering_record.feedback, /most room|closest real code/);
});

test('owner failure messages never claim what the record does not show', () => {
  assert.match(honestFailureMessage({ outcomes: [{ outcome: 'review_rejected' }], genuinePasses: 3 }), /tried 3 implementation passes and none passed independent review/);
  assert.match(honestFailureMessage({ outcomes: [{ outcome: 'no_diff' }], genuinePasses: 1 }), /could not produce a safe change in 1 implementation pass,/);
  assert.match(honestFailureMessage({ budgetStop: true, genuinePasses: 2 }), /engineering budget after 2/);
  assert.doesNotMatch(ownerEngineeringMessage(FAILURE_CLASS.INTERNAL), /three|review and validation/);
});
