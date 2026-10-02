import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, attemptFingerprint, diagnoseNoOp, focusView, jsonObject, literalTerms, loadLessons, prepareSelfUpdate, recordLesson } from './self_development.js';

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


test('jsonObject accepts strict, fenced, and harmlessly wrapped JSON', () => {
  assert.deepEqual(jsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(jsonObject('\`\`\`json\\n{"ok":true}\\n\`\`\`'), { ok: true });
  assert.deepEqual(jsonObject('Result follows: {"ok":true} done'), { ok: true });
  assert.equal(jsonObject('not json'), null);
});

test('applyEdits accepts numbered source excerpts but still rejects stale and ambiguous edits', () => {
  const src = new Map([['lib/a.dart', 'alpha\nbeta\ngamma\nalpha\n']]);
  const numbered = applyEdits(src, [{ path: 'lib/a.dart', find: '2| beta\n3| gamma', replace: 'B\nG' }]);
  assert.equal(numbered.sources.get('lib/a.dart'), 'alpha\nB\nG\nalpha\n');
  assert.match(applyEdits(src, [{ path: 'lib/a.dart', find: 'stale', replace: 'x' }]).error, /does not exist exactly/);
  assert.match(applyEdits(src, [{ path: 'lib/a.dart', find: 'alpha', replace: 'x' }]).error, /ambiguous/);
  assert.match(applyEdits(src, [{ path: 'lib/missing.dart', find: 'x', replace: 'y' }]).error, /not inspected/);
});

test('failed initial discovery automatically broadens and continues without owner source text', async () => {
  let recoveryCalls = 0;
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        if (system.includes('Source Recovery Architect')) {
          recoveryCalls++;
          return { response: '\`\`\`json\\n' + JSON.stringify({
            plan: 'Find the home widget from repository structure.',
            search_terms: ['Ready. Type or speak a request.'],
            paths: ['lib/main.dart'],
          }) + '\\n\`\`\`' };
        }
        if (system.includes('Architect')) {
          return { response: JSON.stringify({ plan: 'bad first guess', search_terms: ['missing-widget-token'], paths: ['lib/not_real.dart'] }) };
        }
        if (system.includes('Review')) {
          return { response: JSON.stringify({ approved: true, target_correct: true, notes: [], repair_instructions: '', lesson: '' }) };
        }
        return { response: JSON.stringify({
          summary: 'Recovered source and changed it',
          edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready, sir.'" }],
        }) };
      },
    },
  };
  const out = await prepareSelfUpdate(env, 'change the home interface wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(out.proposal.files.map((file) => file.path), ['lib/main.dart']);
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

test('oversized prompts are trimmed to fit a free engine instead of failing', async () => {
  const { fitToBudget } = await import('./ai_router.js');
  const input = { messages: [
    { role: 'system', content: 'IDENTITY: You are CHE. ' + 'rule '.repeat(20000) },
    ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(3000) })),
    { role: 'user', content: 'Good afternoon' },
  ] };
  const out = fitToBudget(input, 16000);
  const total = out.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= 17000, `trimmed to ${total}`);
  assert.match(out.messages[0].content, /^IDENTITY: You are CHE\./);
  assert.equal(out.messages[out.messages.length - 1].content, 'Good afternoon');
  assert.equal(fitToBudget({ messages: [{ role: 'user', content: 'hi' }] }, 16000).messages[0].content, 'hi');
});

test('router replaces retired Groq models with a current advertised model', async () => {
  const { routeText, resetRouterForTests, discoverKeylessModels } = await import('./ai_router.js');
  resetRouterForTests();
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://api.groq.com/openai/v1/models') {
      return new Response(JSON.stringify({ data: [
        { id: 'openai/gpt-oss-20b' },
        { id: 'openai/gpt-oss-120b' },
        { id: 'qwen/qwen3.8-27b' },
      ] }), { status: 200 });
    }
    if (u.includes('api.groq.com/openai/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      calls.push(body.model);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'current Groq model answered' } }] }), { status: 200 });
    }
    return new Response('{"error":{"message":"not used"}}', { status: 500 });
  };
  const env = {
    GROQ_API_KEY: 'g',
    CHE_GROQ_STRONG_MODEL: 'llama-3.3-70b-versatile',
    CHE_DISABLE_KEYLESS_AI: '1',
  };
  await discoverKeylessModels(fetcher, { force: true, env });
  const out = await routeText(
    env,
    '@cf/meta/llama-3.1-8b-instruct-fp8',
    { messages: [{ role: 'user', content: 'Analyze this attachment.' }], che_route: 'quality' },
    fetcher,
  );
  assert.equal(out.engine, 'groq');
  assert.equal(out.model, 'openai/gpt-oss-120b');
  assert.deepEqual(calls, ['openai/gpt-oss-120b']);
});


test('no-op engineering pass re-inspects source and retries on a different provider pair', async () => {
  const mem = memoryStore();
  let implementCalls = 0;
  let recoveryCalls = 0;
  const providers = [];
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        if (system.includes('Source Recovery Architect')) {
          recoveryCalls++;
          return { response: JSON.stringify({
            plan: 'The first file was wrong; inspect the real home status source.',
            search_terms: ['Ready. Type or speak a request.'],
            paths: ['lib/main.dart'],
          }) };
        }
        if (system.includes('Architect')) {
          return { response: JSON.stringify({
            plan: 'Initial location guess.',
            search_terms: ['CHE updated. Restart to apply.'],
            paths: ['lib/self_update/che_patch_banner.dart'],
          }) };
        }
        if (system.includes('Review')) {
          return { response: JSON.stringify({
            approved: true,
            target_correct: true,
            notes: [],
            repair_instructions: '',
            lesson: '',
          }) };
        }
        implementCalls++;
        providers.push(input.che_provider);
        if (implementCalls <= 2) {
          return { response: JSON.stringify({
            summary: 'No-op first pass',
            edits: [{
              path: 'lib/self_update/che_patch_banner.dart',
              find: 'CHE updated. Restart to apply.',
              replace: 'CHE updated. Restart to apply.',
            }],
          }) };
        }
        return { response: JSON.stringify({
          summary: 'Recovered real target',
          edits: [{
            path: 'lib/main.dart',
            find: "'Ready. Type or speak a request.'",
            replace: "'Ready, sir.'",
          }],
        }) };
      },
    },
  };

  const out = await prepareSelfUpdate(env, 'change the home status wording', fakeGitHub(), mem);
  assert.equal(out.status, 200, out.detail);
  assert.ok(recoveryCalls >= 1, 'CHE should re-run source location after a no-op pass');
  assert.ok(providers.includes('groq') && providers.includes('cerebras'));
  assert.ok(providers.includes('gemini') || providers.includes('mistral'), 'retry should use a different provider pair');
  assert.deepEqual(out.proposal.files.map((f) => f.path), ['lib/main.dart']);
  assert.match(out.proposal.files[0].content, /'Ready, sir\.'/);
});


test('already-satisfied engineering request succeeds without fake no-op edits', async () => {
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        if (system.includes('No-Change Verification Agent')) {
          return { response: JSON.stringify({
            approved: true,
            notes: ['The inspected source already has the requested compare-delta workflow.'],
            repair_instructions: '',
          }) };
        }
        if (system.includes('Architect')) {
          return { response: JSON.stringify({
            plan: 'Verify existing repository research flow before changing it.',
            search_terms: ['Ready. Type or speak a request.'],
            paths: ['lib/main.dart'],
          }) };
        }
        return { response: JSON.stringify({
          no_change: true,
          summary: 'The requested capability is already present; changing it would duplicate working behavior.',
          evidence: ['lib/main.dart already contains the inspected capability path.'],
        }) };
      },
    },
  };
  const out = await prepareSelfUpdate(
    env,
    'Update your code: compare the current implementation and keep it when it is already equal or better.',
    fakeGitHub(),
    memoryStore(),
  );
  assert.equal(out.status, 200, out.detail);
  assert.equal(out.already_satisfied, true);
  assert.equal(out.approval_required, false);
  assert.ok(!out.proposal);
  assert.match(out.summary, /already present|duplicate/i);
  assert.ok(out.evidence.length >= 1);
});

test('broad architecture work can inspect and update Worker source', async () => {
  const files = {
    'lib/main.dart': MAIN,
    'server/cloudflare/code_scout.js': "export function oldFlow() { return 'old'; }\n",
  };
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/search/code')) {
      const q = decodeURIComponent(u.split('q=')[1] || '');
      const term = q.split('"')[1] || '';
      const items = Object.entries(files)
        .filter(([, src]) => src.includes(term))
        .map(([path]) => ({ path }));
      return ok({ items });
    }
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: 'abc' } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m && files[m[1]] != null) return ok({ content: btoa(files[m[1]]) });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        if (system.includes('Architect')) {
          return { response: JSON.stringify({
            plan: 'Improve the repository research workflow in the Worker.',
            search_terms: ['oldFlow'],
            paths: ['server/cloudflare/code_scout.js'],
          }) };
        }
        if (system.includes('Review')) {
          return { response: JSON.stringify({
            approved: true,
            target_correct: true,
            notes: [],
            repair_instructions: '',
            lesson: '',
          }) };
        }
        return { response: JSON.stringify({
          summary: 'Upgrade repository research workflow',
          edits: [{
            path: 'server/cloudflare/code_scout.js',
            find: "export function oldFlow() { return 'old'; }",
            replace: "export function oldFlow() { return 'compare-delta'; }",
          }],
        }) };
      },
    },
  };
  const out = await prepareSelfUpdate(
    env,
    'Update your code: improve the repository research architecture using compare delta integrate.',
    fetcher,
    memoryStore(),
  );
  assert.equal(out.status, 200, out.detail);
  assert.deepEqual(out.proposal.files.map((file) => file.path), ['server/cloudflare/code_scout.js']);
  assert.match(out.proposal.files[0].content, /compare-delta/);
});


test('three-pass hard stop never repeats an identical no-op strategy', async () => {
  let implementationCalls = 0;
  let recoveryCalls = 0;
  let reviewCalls = 0;
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        if (system.includes('Source Recovery Architect')) {
          recoveryCalls++;
          return { response: JSON.stringify({
            plan: 'Re-read the same verified target and choose a different strategy.',
            search_terms: ['Ready. Type or speak a request.'],
            paths: ['lib/main.dart'],
          }) };
        }
        if (system.includes('Architect')) {
          return { response: JSON.stringify({
            plan: 'Inspect the home status.',
            search_terms: ['Ready. Type or speak a request.'],
            paths: ['lib/main.dart'],
          }) };
        }
        if (system.includes('Review')) {
          reviewCalls++;
          return { response: JSON.stringify({ approved: true, target_correct: true, notes: [] }) };
        }
        implementationCalls++;
        return { response: JSON.stringify({
          summary: 'Identical no-op',
          edits: [{
            path: 'lib/main.dart',
            find: "'Ready. Type or speak a request.'",
            replace: "'Ready. Type or speak a request.'",
          }],
        }) };
      },
    },
  };

  const out = await prepareSelfUpdate(env, 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 422);
  assert.match(out.detail, /exact implementation strategy was already attempted/i);
  assert.equal(recoveryCalls, 2, 'only the two boundaries between three rounds run recovery');
  assert.equal(reviewCalls, 0, 'empty diffs never reach review');
  assert.equal(implementationCalls, 6, 'three bounded rounds with two engineers each');
});

test('recovery re-fetches an already-inspected target before retrying', async () => {
  let mainReads = 0;
  let recoveryCalls = 0;
  const files = {
    'lib/main.dart': MAIN,
  };
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/search/code')) return ok({ items: [{ path: 'lib/main.dart' }] });
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: 'abc' } });
    if (u.includes('/git/trees/')) return ok({ tree: [{ type: 'blob', path: 'lib/main.dart' }] });
    if (u.includes('/contents/lib/main.dart?ref=')) {
      mainReads++;
      const source = mainReads === 1
        ? MAIN
        : "class Home {\n  String _statusBanner = 'Fresh from GitHub';\n}\n";
      return ok({ content: btoa(source) });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        const payload = JSON.parse(input.messages[1].content);
        if (system.includes('Source Recovery Architect')) {
          recoveryCalls++;
          return { response: JSON.stringify({
            plan: 'Re-read the already-inspected home source.',
            search_terms: ['Fresh from GitHub'],
            paths: ['lib/main.dart'],
          }) };
        }
        if (system.includes('Architect')) {
          return { response: JSON.stringify({
            plan: 'Inspect home status.',
            search_terms: ['Ready. Type or speak a request.'],
            paths: ['lib/main.dart'],
          }) };
        }
        if (system.includes('Review')) {
          return { response: JSON.stringify({
            approved: true,
            target_correct: true,
            notes: [],
            repair_instructions: '',
          }) };
        }
        const inspected = JSON.stringify(payload.inspected || []);
        if (inspected.includes('Fresh from GitHub')) {
          return { response: JSON.stringify({
            summary: 'Edit freshly re-fetched source',
            edits: [{
              path: 'lib/main.dart',
              find: "'Fresh from GitHub'",
              replace: "'Recovered, sir.'",
            }],
          }) };
        }
        return { response: JSON.stringify({
          summary: 'Force first-pass no-op',
          edits: [{
            path: 'lib/main.dart',
            find: "'Ready. Type or speak a request.'",
            replace: "'Ready. Type or speak a request.'",
          }],
        }) };
      },
    },
  };

  const out = await prepareSelfUpdate(env, 'change the home status wording', fetcher, memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.equal(recoveryCalls, 1);
  assert.ok(mainReads >= 2, 'recovery must fetch an already-inspected file again');
  assert.match(out.proposal.files[0].content, /Recovered, sir/);
});

test('no-op helpers fingerprint exact strategies and diagnose identical replacements', () => {
  const answer = { edits: [{ path: 'lib/a.dart', find: 'x', replace: 'x' }] };
  assert.equal(attemptFingerprint(answer), attemptFingerprint(structuredClone(answer)));
  assert.match(diagnoseNoOp(new Map([['lib/a.dart', 'x']]), answer), /identical/i);
});
