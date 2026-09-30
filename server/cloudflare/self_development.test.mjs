import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, focusView, literalTerms, loadLessons, prepareSelfUpdate, recordLesson } from './self_development.js';

const MAIN = `class Home {\n  String _statusBanner = 'Ready. Type or speak a request.';\n}\n`;
const PATCH = `const t = Text('CHE updated. Restart to apply.');\n`;

function memoryStore() {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), m };
}

function fakeGitHub() {
  const files = { 'lib/main.dart': MAIN, 'lib/self_update/che_patch_banner.dart': PATCH };
  return async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/search/code')) {
      const q = decodeURIComponent(u.split('q=')[1]);
      const items = Object.entries(files).filter(([, src]) => src.includes(q.split('"')[1])).map(([path]) => ({ path }));
      return ok({ items });
    }
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: 'abc' } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m) return ok({ content: btoa(files[m[1]]) });
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('literalTerms pulls quoted on-screen text', () => {
  assert.deepEqual(literalTerms('make the banner "Ready. Type or speak" say hi'), ['Ready. Type or speak']);
});

test('applyEdits requires exact, unique find text', () => {
  const src = new Map([['lib/a.dart', 'x\ny\nx\n']]);
  assert.match(applyEdits(src, [{ path: 'lib/a.dart', find: 'x', replace: 'z' }]).error, /more than once/);
  assert.match(applyEdits(src, [{ path: 'lib/a.dart', find: 'nope', replace: 'z' }]).error, /does not exist/);
  assert.equal(applyEdits(src, [{ path: 'lib/a.dart', find: 'y', replace: 'Y' }]).sources.get('lib/a.dart'), 'x\nY\nx\n');
});

test('focusView shows numbered windows around hits in big files', () => {
  const big = Array.from({ length: 3000 }, (_, i) => (i === 1500 ? "String s = 'Ready now';" : `// filler line ${i} ................`)).join('\n');
  const view = focusView(big, ['Ready now']);
  assert.equal(view.whole, false);
  assert.match(view.text, /1501\| String s = 'Ready now';/);
});

test('lessons persist and seed lessons remember the PR #73 mistake', async () => {
  const mem = memoryStore();
  await recordLesson(mem, 'mistake', 'Never do X.');
  await recordLesson(mem, 'mistake', 'Never do X.');
  const lessons = await loadLessons(mem);
  assert.equal(lessons.filter((l) => l.text === 'Never do X.').length, 1);
  assert.ok(lessons.some((l) => /PR #73/.test(l.text)));
});

test('team edits the real Ready banner, and a wrong-target patch is rejected and learned', async () => {
  const mem = memoryStore();
  let implementCalls = 0;
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        if (system.includes('Architect')) {
          return { response: JSON.stringify({ plan: 'change status banner', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/self_update/che_patch_banner.dart'] }) };
        }
        if (system.includes('Review')) {
          const payload = JSON.parse(input.messages[1].content);
          const wrong = payload.diff.includes('che_patch_banner');
          return { response: JSON.stringify(wrong
            ? { approved: false, target_correct: false, notes: ['Edited the update banner, not the Ready banner.'], lesson: 'Edit the widget showing the exact text the owner named.' }
            : { approved: true, target_correct: true, notes: [] }) };
        }
        implementCalls++;
        const edit = implementCalls === 1
          ? { path: 'lib/self_update/che_patch_banner.dart', find: 'CHE updated. Restart to apply.', replace: 'Ready, sir.' }
          : { path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready, sir.'" };
        return { response: JSON.stringify({ summary: 'Ready banner', edits: [edit] }) };
      },
    },
  };
  const out = await prepareSelfUpdate(env, 'make the Ready banner say Ready, sir', fakeGitHub(), mem);
  assert.equal(out.status, 200, out.detail);
  assert.deepEqual(out.proposal.files.map((f) => f.path), ['lib/main.dart']);
  assert.match(out.proposal.files[0].content, /'Ready, sir\.'/);
  const saved = mem.m.get('che_team_lessons');
  assert.ok(saved.some((l) => l.kind === 'mistake' && /exact text/.test(l.text)));
  assert.ok(saved.some((l) => l.kind === 'location' && /lib\/main\.dart/.test(l.text)));
});

test('crew uses different engines per pair, shares a team board, and reviewers settle disagreements', async () => {
  const seen = [];
  let reviewCalls = 0;
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        const payload = JSON.parse(input.messages[1].content);
        seen.push({ who: system.split(',')[0].replace('You are ', ''), provider: input.che_provider, chat: payload.team_chat?.length || 0 });
        if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'p', search_terms: ['Ready. Type or speak a request.'], paths: [] }) };
        if (system.includes('Review')) {
          reviewCalls++;
          // First pass: Sage approves, Mira rejects; after talking, both approve.
          const disagree = reviewCalls <= 2 && system.includes('Mira');
          return { response: JSON.stringify({ approved: !disagree, target_correct: true, notes: [disagree ? 'Check voice label.' : 'Fine.'] }) };
        }
        return { response: JSON.stringify({ summary: 's', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready, sir.'" }] }) };
      },
    },
  };
  const out = await prepareSelfUpdate(env, 'make the Ready banner say Ready, sir', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  const providerOf = (name) => seen.find((s) => s.who === name)?.provider;
  assert.notEqual(providerOf('Knox'), providerOf('Nova'));
  assert.ok(!['groq', 'cerebras'].includes(providerOf('Mira')));
  assert.ok(seen.filter((s) => s.who === 'Sage' || s.who === 'Mira').some((s) => s.chat > 2), 'reviewers read the team board');
  assert.ok(out.discussion.some((m) => /Mira/.test(m.from) && /APPROVE/.test(m.msg)));
  assert.deepEqual(out.team, ['Atlas', 'Iris', 'Knox', 'Nova', 'Sage', 'Mira']);
});

test('paid AI engines stay off unless the owner opts in', async () => {
  const { paidAllowed } = await import('./ai_router.js');
  assert.equal(paidAllowed({ CHE_OPENAI_API_KEY: 'k' }), false);
  assert.equal(paidAllowed({ CHE_ALLOW_PAID_AI: '1' }), true);
});
