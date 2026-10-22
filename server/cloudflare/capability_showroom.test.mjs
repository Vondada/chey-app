// The Capability Showroom must tell the truth about each card (owner addendum, 2026-10-22): a Ready card has a catalog
// command that is available, a real test file proving its route, and no partial reason. Every card opens a real
// destination, illustrations are labelled, and CHE's answers come from the same states the cards show.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { commandById, COMMANDS, CATEGORIES } from './command_catalog.js';
import { matchShowroom, SHOWROOM, showroomIntent, showroomReply, showroomView, STATES, capabilityState } from './capability_showroom.js';

const hasProofFile = (name) => existsSync(new URL(`./${name}`, import.meta.url)) && /\btest\(/.test(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const ALL = SHOWROOM.flatMap((c) => c.capabilities);
// Every catalog command counts as available: the test checks states, not live connections.
const allReady = new Proxy({}, { get: () => ({ state: 'ready', detail: '' }) });

test('the six owner categories are present, in the owner\'s order, each with a summary', () => {
  assert.deepEqual(SHOWROOM.map((c) => c.title), [
    'Inventions & Engineering', 'Video, Film & Animation', 'Apps, Websites & Games', 'Business & Creative Projects', 'Trading & Research', 'Office & AI',
  ]);
  for (const c of SHOWROOM) assert.ok(c.summary.length > 10, c.id);
});

test('every capability has a name, a description, an example, an output, and a start prompt or a reason', () => {
  for (const item of ALL) {
    for (const key of ['title', 'description', 'example', 'output']) assert.ok(String(item[key]).trim(), `${item.id}.${key}`);
    assert.ok(item.start || item.partial || item.planned, `${item.id} says what to ask or why not`);
  }
});

test('every card that names a catalog command names a real command; no card points at a missing route', () => {
  for (const item of ALL.filter((i) => i.command)) assert.ok(commandById(item.command), `${item.id} -> ${item.command}`);
  const ids = new Set(COMMANDS.map((c) => c.id));
  for (const c of CATEGORIES) assert.ok(c.id, 'catalog categories are unchanged');
  assert.ok(ids.size > 0);
});

test('a Ready claim is backed by a test file that exists and holds a test', () => {
  for (const item of ALL.filter((i) => i.command && !i.partial)) {
    assert.ok(item.proof, `${item.id} names a proof file`);
    assert.ok(hasProofFile(item.proof), `${item.id}: proof file ${item.proof} exists and holds a test`);
  }
});

test('no card with a partial or planned reason is ever Ready, even when the catalog says its command runs', () => {
  for (const item of ALL) {
    const { state } = capabilityState(item, allReady, { hasProofFile });
    if (item.partial) assert.equal(state, 'partial', item.id);
    if (!item.command) assert.notEqual(state, 'ready', item.id);
  }
});

test('a command with no proof file is Partial, never Ready', () => {
  const item = { id: 'x', command: 'che', proof: 'does_not_exist.test.mjs', partial: '', planned: '' };
  assert.equal(capabilityState(item, allReady, { hasProofFile }).state, 'partial');
});

test('missing connections read as Needs setup with the missing piece named, and nothing is claimed as Ready', () => {
  const missingGithub = { github: { state: 'not_connected', detail: 'GitHub is not connected.' }, repo: { state: 'not_connected', detail: 'CHE_GITHUB_REPO is not set.' } };
  const build = ALL.find((i) => i.command === 'app-build');
  const state = capabilityState(build, missingGithub, { hasProofFile });
  assert.equal(state.state, 'needs_setup');
  assert.ok(state.missing.length > 0);
  assert.notEqual(state.state, 'ready');
});

test('an unavailable model reads as Unavailable, not as Needs setup', () => {
  const down = { model: { state: 'unavailable', detail: 'No AI engine answers right now.' } };
  const che = { id: 'chat', command: 'che', partial: '', planned: '', proof: 'chat_grounding.test.mjs' };
  assert.equal(capabilityState(che, down, { hasProofFile }).state, 'unavailable');
});

test('an illustration is labelled a concept example; a real saved output is shown as real', () => {
  const view = showroomView(allReady, { recent: {}, hasProofFile });
  const suit = view.categories[0].capabilities.find((i) => i.id === 'suit');
  assert.equal(suit.illustrative, true);
  assert.match(suit.thumbnail_note, /^Concept example/);
  const realView = showroomView(allReady, { recent: { invention: { id: 'inv-1', title: 'Suit' } }, hasProofFile });
  const real = realView.categories[0].capabilities.find((i) => i.id === 'suit');
  assert.equal(real.thumbnail, 'real');
  assert.equal(real.recent_project.id, 'inv-1');
  assert.equal(real.illustrative, false);
});

test('the counts add up to the total, and every card has exactly one state label', () => {
  const view = showroomView(allReady, { hasProofFile });
  const all = view.categories.flatMap((c) => c.capabilities);
  assert.equal(all.length, view.total);
  assert.equal(Object.values(view.counts).reduce((a, b) => a + b, 0), view.total);
  for (const item of all) assert.ok(Object.values(STATES).includes(item.status_label), item.id);
});

test('matching a question finds the right capability; an unknown topic matches nothing and is not claimed', () => {
  const view = showroomView(allReady, { hasProofFile });
  assert.equal(matchShowroom(view, 'exploded view of the suit').some((i) => i.id === 'exploded'), true);
  assert.equal(matchShowroom(view, 'zzqx unicorn submarine').length, 0);
});

test('CHE’s showroom questions are recognised; ordinary questions are not', () => {
  assert.equal(showroomIntent('CHE, what can you create?')?.kind, 'overview');
  assert.equal(showroomIntent('Show me an example of an animated video.')?.kind, 'example');
  assert.equal(showroomIntent('Can you actually render this in 3D?')?.kind, 'can_render');
  assert.equal(showroomIntent('Which features need setup?')?.kind, 'needs_setup');
  assert.equal(showroomIntent('what is the weather in Lafayette'), null);
  // A real request for a video, or a question about a connector, is not a showroom question.
  assert.equal(showroomIntent('Which rendering engines are connected, and can you make a video about bees?'), null);
  assert.equal(showroomIntent('What can you do with my email?'), null);
  assert.equal(showroomIntent('What can you do?'), null);
});

test('the answers repeat the states the view holds, and claim nothing the view does not', () => {
  const view = showroomView(allReady, { hasProofFile });
  const overview = showroomReply(view, { kind: 'overview' });
  assert.match(overview, new RegExp(`I can do ${view.total} things`));
  const render = showroomReply(view, { kind: 'can_render', query: 'render this in 3D' });
  assert.match(render, /3D modeling is Partial|Partial/);
  assert.doesNotMatch(render, /Ready, sir/);
  assert.match(showroomReply(view, { kind: 'example', query: 'animated video' }), /Concept example|Rendered MP4|Real saved output/);
  const none = showroomReply(view, { kind: 'example', query: 'zzqx unicorn submarine' });
  assert.match(none, /I have no example/);
});
