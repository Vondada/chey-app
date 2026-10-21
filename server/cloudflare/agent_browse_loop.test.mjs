// The browsing loop: one step at a time, every app step through the gate, answers only from pages she read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchRegistry, runBrowseLoop } from './agent_browse_loop.js';

// A planner that follows a fixed script; each call returns the next action.
function scripted(actions) {
  let i = 0;
  return async () => actions[i++] ?? null;
}
const PAGE = 'https://example.org/pizza';
const page = { ok: true, url: PAGE, text: 'Pizza is the owner\'s favorite food in this article.' };
const executor = async (action) => {
  if (action.type === 'open') return { ok: true, url: action.url, text: 'Pizza is the favorite food.' };
  if (action.type === 'read') return page;
  return { ok: true, url: PAGE, text: '' };
};
const search = (rows) => {
  const reg = createSearchRegistry();
  reg.register({ id: 'test', name: 'Test search', search: async () => rows });
  return reg;
};
// The owner grants the app these tests browse in; every page step is gated.
const GRANT = { app: "Web", grants: ["Web"] };
const ROWS = [{ title: 'Pizza', url: PAGE, snippet: 'Pizza page' }];

test('a search result alone is not an answer: the loop cannot finish on it', async () => {
  const planner = scripted([
    { type: 'search', query: 'favorite food' },
    { type: 'finish', answer: 'Pizza.', cite: [PAGE] },
  ]);
  const r = await runBrowseLoop({ question: 'favorite food?', planner, executor, search: search(ROWS) });
  assert.equal(r.status, 'not_found', 'no page was read, so nothing to answer from');
});

test('after reading a page, the answer cites that page and is returned with its source', async () => {
  const planner = scripted([
    { type: 'search', query: 'favorite food' },
    { type: 'open', url: PAGE },
    { type: 'finish', answer: 'Pizza, according to the page.', cite: [PAGE] },
  ]);
  const r = await runBrowseLoop({ question: 'favorite food?', planner, executor, search: search(ROWS), ...GRANT });
  assert.equal(r.status, 'answered');
  assert.deepEqual(r.sources, [PAGE]);
});

test('an answer that cites a page she did not read is refused as uncited', async () => {
  const planner = scripted([
    { type: 'open', url: PAGE },
    { type: 'finish', answer: 'Sushi.', cite: ['https://elsewhere.example/x'] },
  ]);
  const r = await runBrowseLoop({ question: 'q', planner, executor, ...GRANT });
  assert.equal(r.status, 'uncited');
});

test('with no search provider connected, the loop says so and can still finish honestly', async () => {
  const planner = async ({ observations }) => (observations.length === 0
    ? { type: 'search', query: 'q' }
    : { type: 'finish', answer: 'x', cite: [] });
  const r = await runBrowseLoop({ question: 'q', planner, executor, search: createSearchRegistry() });
  assert.equal(r.status, 'not_found');
  assert.match(r.reason, /No page was read/);
});

test('the search limit stops more searches', async () => {
  let calls = 0;
  const reg = createSearchRegistry();
  reg.register({ id: 'n', search: async () => { calls++; return []; } });
  const planner = scripted([...Array(10)].map((_, i) => ({ type: 'search', query: `q${i}` })));
  await runBrowseLoop({ question: 'q', planner, executor, search: reg, limits: { maxSteps: 10, maxSearches: 2, maxTextChars: 100 } });
  assert.equal(calls, 2);
});

test('an app the owner has not granted is refused and the loop stops', async () => {
  const planner = scripted([{ type: 'open', url: 'https://tiktok.com' }]);
  const r = await runBrowseLoop({ question: 'q', planner, executor, app: 'TikTok', grants: ['Gmail'] });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /no permission to act in TikTok/);
});

test('a purchase click is held for the owner, and nothing is clicked', async () => {
  let ran = false;
  const planner = scripted([{ type: 'click', label: 'Place order' }]);
  const r = await runBrowseLoop({ question: 'q', planner, executor: async () => { ran = true; return { ok: true }; }, app: 'Shop', grants: ['Shop'] });
  assert.equal(r.status, 'held');
  assert.equal(r.kind, 'spend');
  assert.equal(ran, false);
});

test('a typed password must come from the vault', async () => {
  const planner = scripted([{ type: 'type', label: 'Password', secret: true, text: 'hunter2' }]);
  const r = await runBrowseLoop({ question: 'q', planner, executor, app: 'Instagram', grants: ['Instagram'] });
  assert.equal(r.status, 'refused');
});

test('the loop asks the owner when the planner says so', async () => {
  const planner = scripted([{ type: 'ask_owner', reason: 'The page needs a verification code.' }]);
  const r = await runBrowseLoop({ question: 'q', planner, executor });
  assert.equal(r.status, 'needs_owner');
  assert.match(r.reason, /verification code/);
});

test('a planner that never finishes stops at the step limit', async () => {
  const planner = async () => ({ type: 'read' });
  const r = await runBrowseLoop({ question: 'q', planner, executor, ...GRANT, limits: { maxSteps: 3, maxSearches: 1, maxTextChars: 100 } });
  assert.equal(r.status, 'budget_exhausted');
  assert.equal(r.steps.length, 3);
});

test('a planner that returns nothing stops with no_plan', async () => {
  const r = await runBrowseLoop({ question: 'q', planner: async () => null, executor });
  assert.equal(r.status, 'no_plan');
});

test('the search registry takes only real providers and returns the first when none is named', () => {
  const reg = createSearchRegistry();
  assert.throws(() => reg.register({ id: '', search() {} }), /needs an id/);
  assert.throws(() => reg.register({ id: 'x' }), /needs an id/);
  assert.equal(reg.pick(), null);
  reg.register({ id: 'a', name: 'A', search: async () => [] });
  reg.register({ id: 'b', name: 'B', search: async () => [] });
  assert.equal(reg.pick().id, 'a');
  assert.equal(reg.pick('b').id, 'b');
  assert.deepEqual(reg.list(), [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
});

test('creating an account is held for the owner, and nothing is submitted', async () => {
  let ran = false;
  const planner = scripted([{ type: 'click', label: 'Create account' }]);
  const r = await runBrowseLoop({ question: 'sign up', planner, executor: async () => { ran = true; return { ok: true }; }, app: 'TikTok', grants: ['TikTok'] });
  assert.equal(r.status, 'held');
  assert.equal(r.kind, 'signup');
  assert.equal(ran, false);
});

test('a page that asks for a code stops the loop for the owner; CHE does not type a guess', async () => {
  const captchaPage = async () => ({ ok: true, url: 'https://app.example/verify', text: 'Enter the 6-digit verification code we sent to you.' });
  const planner = scripted([{ type: 'open', url: 'https://app.example/verify' }, { type: 'type', label: 'Code', text: '123456' }]);
  const r = await runBrowseLoop({ question: 'sign up', planner, executor: captchaPage, app: 'App', grants: ['App'] });
  assert.equal(r.status, 'needs_owner');
  assert.match(r.reason, /human check/);
  assert.equal(r.steps.length, 1, 'the loop stopped before the planner\x27s typed guess ran');
});

test('a CAPTCHA page stops the loop the same way', async () => {
  const captcha = async () => ({ ok: true, url: 'https://app.example/x', text: 'Confirm you are not a robot' });
  const planner = scripted([{ type: 'read' }]);
  const r = await runBrowseLoop({ question: 'q', planner, executor: captcha, app: 'App', grants: ['App'] });
  assert.equal(r.status, 'needs_owner');
});
