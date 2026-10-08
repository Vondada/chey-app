import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, attemptFingerprint, diagnoseNoOp, fallbackTreeCandidates, focusView, inspectRepositoryContext, isUiTask, jsonObject, jsonProblem, literalTerms, loadLessons, prepareSelfUpdate, rankSourcePaths, recordLesson, substantiveChange, unusedNewCode, wantsDocsOnly } from './self_development.js';

// Like the real lib/main.dart, MAIN imports the patch banner (so it is live code).
const MAIN = `import 'self_update/che_patch_banner.dart';\nclass Home {\n  String _statusBanner = 'Ready. Type or speak a request.';\n}\n`;
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


test('read-only collaboration grounding returns live SHA, real symbols and open PRs', async () => {
  const sha = 'a'.repeat(40);
  const files = {
    'lib/agents/che_war_room_screen.dart': 'class CheWarRoomScreen {}\nWidget buildWarRoom() => throw UnimplementedError();\n',
    'lib/agents/che_office_floor_screen.dart': 'class CheOfficeFloorScreen {}\n',
  };
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/heads/main')) return ok({ object: { sha } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    if (u.includes('/pulls?state=open')) return ok([{ number: 172, title: 'Conversation recall', head: { ref: 'claude/recall', sha: 'b'.repeat(40) }, base: { ref: 'main' } }]);
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m && files[m[1]]) return ok({ content: btoa(files[m[1]]), sha: 'blob-' + m[1] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const out = await inspectRepositoryContext(
    { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' },
    'inspect the War Room group chat and character state',
    fetcher,
  );
  assert.equal(out.ok, true);
  assert.equal(out.head_sha, sha);
  assert.equal(out.open_prs[0].number, 172);
  assert.ok(out.files.some((file) => file.path === 'lib/agents/che_war_room_screen.dart'));
  assert.ok(out.files.find((file) => file.path === 'lib/agents/che_war_room_screen.dart').symbols.includes('CheWarRoomScreen'));
});


test('collaboration grounding retries a transient GitHub read before succeeding', async () => {
  const sha = 'c'.repeat(40);
  let metadataReads = 0;
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.endsWith('/o/r')) {
      metadataReads++;
      if (metadataReads === 1) return { ok: false, status: 503, json: async () => ({ message: 'busy' }) };
      return ok({ default_branch: 'main' });
    }
    if (u.includes('/git/ref/heads/main')) return ok({ object: { sha } });
    if (u.includes('/git/trees/')) return ok({ tree: [{ type: 'blob', path: 'lib/agents/che_war_room_screen.dart' }] });
    if (u.includes('/contents/lib/agents/che_war_room_screen.dart')) return ok({ content: btoa('class CheWarRoomScreen {}\n'), sha: 'blob' });
    if (u.includes('/pulls?state=open')) return ok([]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const out = await inspectRepositoryContext(
    { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' },
    'War Room',
    fetcher,
  );
  assert.equal(out.ok, true);
  assert.equal(out.head_sha, sha);
  assert.equal(metadataReads, 2);
});

test('collaboration grounding reports genuine permission failure without asking for source', async () => {
  const fetcher = async () => ({ ok: false, status: 403, json: async () => ({ message: 'forbidden' }) });
  const out = await inspectRepositoryContext(
    { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' },
    'inspect current main',
    fetcher,
  );
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.equal(out.retryable, false);
  assert.match(out.detail, /repository metadata/i);
});

test('literalTerms pulls quoted on-screen text', () => {
  assert.deepEqual(literalTerms('make the banner "Ready. Type or speak" say hi'), ['Ready. Type or speak']);
});

test('UI classification uses the owner intent, not generic architecture/reference words', () => {
  assert.equal(isUiTask('Change the Ready banner text on the home screen.'), true);
  assert.equal(isUiTask('Redesign the agent architecture and workflow; reference docs mention UI screen design and text labels.'), true);
  assert.equal(isUiTask('Improve agent architecture, delegation, memory, research, retries, review, and workflow state management.'), false);
});

test('broad architecture requests infer real CHE source modules when code search has no exact phrase', () => {
  const paths = [
    'server/cloudflare/agent_runtime.js',
    'server/cloudflare/code_scout.js',
    'server/cloudflare/self_development.js',
    'server/cloudflare/self_update.js',
    'server/cloudflare/worker.js',
    'lib/rooms/che_theater_room.dart',
  ];
  const ranked = rankSourcePaths(
    paths,
    'Improve agent delegation, handoffs, parallel planning, memory RAG, research, coding review, retries and workflow reliability.',
    6,
  );
  assert.ok(ranked.includes('server/cloudflare/agent_runtime.js'));
  assert.ok(ranked.includes('server/cloudflare/self_development.js'));
  assert.ok(ranked.includes('server/cloudflare/code_scout.js'));
});

test('reference README UI words do not turn a broad owner architecture request into a UI job', async () => {
  const files = {
    'server/cloudflare/agent_runtime.js': "export function delegateAgent() { return 'ready'; }\n",
  };
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/search/code')) return ok({ items: [] });
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: 'abc' } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m && files[m[1]]) return ok({ content: btoa(files[m[1]]) });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const roles = [];
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        roles.push(system);
        if (system.includes('Architect')) {
          return { response: JSON.stringify({
            plan: 'Inspect the agent runtime.',
            search_terms: ['delegateAgent'],
            paths: ['server/cloudflare/agent_runtime.js'],
          }) };
        }
        if (system.includes('No-Change Verification Agent')) {
          return { response: JSON.stringify({ approved: true, notes: ['Verified.'], repair_instructions: '' }) };
        }
        return { response: JSON.stringify({
          no_change: true,
          summary: 'The requested agent capability is already present.',
          evidence: ['server/cloudflare/agent_runtime.js exports delegateAgent.'],
        }) };
      },
    },
  };
  const owner = 'Improve agent delegation, handoffs, parallel planning, memory, research, review, retries and workflow reliability.';
  const grounded = owner + '\n\nREFERENCE MATERIAL: this external README discusses UI screens, visual design, labels and text.';
  const out = await prepareSelfUpdate(env, grounded, fetcher, memoryStore(), { intentRequest: owner });
  assert.equal(out.status, 200, out.detail);
  assert.equal(out.already_satisfied, true);
  assert.ok(roles.some((system) => system.includes('CHE Software Architect')));
  assert.ok(!roles.some((system) => system.includes('CHE UI/UX Architect')));
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

test('jsonObject repairs Dart-flavoured engineer JSON without changing its meaning', () => {
  // Dart interpolation escape, raw newline inside a code string, trailing comma.
  const raw = '{"summary":"x","edits":[{"path":"lib/a.dart","find":"Text(\'\\$n\')","replace":"Text(\n  \'\\$n items\',\n)"},]}';
  const parsed = jsonObject(raw);
  assert.ok(parsed, 'repaired answer parses');
  assert.equal(parsed.edits[0].find, "Text('\\$n')");
  assert.equal(parsed.edits[0].replace, "Text(\n  '\\$n items',\n)");
  // Answers wrapped in prose with a fenced block in the middle.
  assert.deepEqual(jsonObject('Here is the fix:\n```json\n{"ok":true}\n```\nThanks'), { ok: true });
  // Valid JSON is untouched by the repair path.
  assert.deepEqual(jsonObject('{"a":"\\u0041\\n"}'), { a: 'A\n' });
});

test('jsonObject never completes truncated output, and jsonProblem says why it failed', () => {
  const cut = '{"summary":"x","edits":[{"path":"lib/a.dart","find":"a","replace":"b';
  assert.equal(jsonObject(cut), null);
  assert.match(jsonProblem(cut), /cut off/);
  assert.match(jsonProblem('no object here'), /no JSON object/);
  assert.match(jsonProblem(''), /empty/);
  assert.match(jsonProblem('{"a": nope}'), /not valid JSON/);
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
          // Wrong = the diff edits the patch-banner FILE (its header), not
          // merely shows main.dart's import of it as context.
          const wrong = /^--- lib\/self_update\/che_patch_banner\.dart/m.test(payload.diff);
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
    // As in the real Worker, the router imports the module (so it is live).
    'server/cloudflare/worker.js': "import { oldFlow } from './code_scout.js';\nexport default { fetch: () => oldFlow() };\n",
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


test('duplicate no-op strategies stop at the existing engineer budget without reaching review', async () => {
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
  assert.equal(recoveryCalls, 3, 'recovery stays at its existing stage ceiling');
  assert.equal(reviewCalls, 0, 'empty diffs never reach review');
  assert.equal(implementationCalls, 10, 'the existing engineer call ceiling remains bounded');
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


test('missing exact-find anchor is refreshed before recovery search and the next proposal uses current source', async () => {
  let mainReads = 0;
  let recoveryCalls = 0;
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/search/code')) return ok({ items: [] }); // recovery search deliberately cannot help
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: 'abc' } });
    if (u.includes('/git/trees/')) return ok({ tree: [{ type: 'blob', path: 'lib/main.dart' }] });
    if (u.includes('/contents/lib/main.dart?ref=')) {
      mainReads++;
      const source = mainReads === 1
        ? "class Home {\n  String status = 'Old inspected anchor';\n}\n"
        : "class Home {\n  String status = 'Fresh current anchor';\n}\n";
      return ok({ content: btoa(source) });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  let engineerCalls = 0;
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
            plan: 'Search elsewhere; intentionally omit the failed file.',
            search_terms: ['unrelated recovery term'],
            paths: [],
          }) };
        }
        if (system.includes('Architect')) return { response: JSON.stringify({
          plan: 'Inspect home status.',
          search_terms: ['Old inspected anchor'],
          paths: ['lib/main.dart'],
        }) };
        if (system.includes('Review')) return { response: JSON.stringify({
          approved: true, target_correct: true, notes: [], repair_instructions: '',
        }) };
        engineerCalls++;
        const inspected = JSON.stringify(payload.inspected || []);
        if (inspected.includes('Fresh current anchor')) return { response: JSON.stringify({
          summary: 'Use refreshed source',
          edits: [{ path: 'lib/main.dart', find: "'Fresh current anchor'", replace: "'Recovered, sir.'" }],
        }) };
        return { response: JSON.stringify({
          summary: 'Stale exact anchor',
          edits: [{ path: 'lib/main.dart', find: "'Anchor that never existed'", replace: "'Recovered, sir.'" }],
        }) };
      },
    },
  };

  const out = await prepareSelfUpdate(env, 'change the home status wording', fetcher, memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.ok(recoveryCalls >= 1, 'recovery planning still runs');
  assert.ok(mainReads >= 2, 'the failed anchor file is fetched again before recovery discovery');
  assert.ok(engineerCalls >= 2, 'a new implementation strategy is attempted');
  assert.match(out.proposal.files[0].content, /Recovered, sir/);
});


test('no-op helpers fingerprint exact strategies and diagnose identical replacements', () => {
  const answer = { edits: [{ path: 'lib/a.dart', find: 'x', replace: 'x' }] };
  assert.equal(attemptFingerprint(answer), attemptFingerprint(structuredClone(answer)));
  assert.match(diagnoseNoOp(new Map([['lib/a.dart', 'x']]), answer), /identical/i);
});


test('self-development proposals retain the inspected GitHub base SHA', async () => {
  const env = {
    CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r',
    AI: { run: async (_model, input) => {
      const system = input.messages[0].content;
      if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'status', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] }) };
      if (system.includes('Review')) return { response: JSON.stringify({ approved: true, target_correct: true, notes: [] }) };
      return { response: JSON.stringify({ summary: 'change status', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready, sir.'" }] }) };
    } },
  };
  const out = await prepareSelfUpdate(env, 'change the home status wording', fakeGitHub(), memoryStore());
  assert.equal(out.status, 200, out.detail);
  assert.equal(out.proposal.expected_base_sha, 'abc');
});

test('deterministic tree fallback selects editable app source when search and planners miss', () => {
  const index = {
    editable_paths: [
      'server/cloudflare/worker.js',
      'lib/settings/account.dart',
      'lib/main.dart',
      'lib/chat/che_chat_screen.dart',
    ],
  };
  const picked = fallbackTreeCandidates('make a small improvement to the chat screen', index, [], 3);
  assert.equal(picked[0], 'lib/chat/che_chat_screen.dart');
  assert.ok(picked.includes('lib/main.dart'));
});

test('generic autonomous request falls back to real editable source instead of discovery 422', async () => {
  let implementationCalls = 0;
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        const payload = JSON.parse(input.messages[1].content);
        if (system.includes('Source Recovery Architect')) {
          return { response: JSON.stringify({ plan: 'No confident path.', search_terms: ['not-present-anywhere'], paths: [] }) };
        }
        if (system.includes('Architect')) {
          return { response: JSON.stringify({ plan: 'Inspect repository.', search_terms: ['also-not-present'], paths: [] }) };
        }
        if (system.includes('Review')) {
          return { response: JSON.stringify({ approved: true, target_correct: true, notes: [], repair_instructions: '' }) };
        }
        implementationCalls++;
        const inspected = payload.inspected || [];
        assert.ok(inspected.some((item) => item.path === 'lib/main.dart'), 'fallback must inspect a real editable source file');
        return { response: JSON.stringify({
          summary: 'Small real improvement',
          edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready and listening, sir.'" }],
        }) };
      },
    },
  };

  const out = await prepareSelfUpdate(
    env,
    'make one small real improvement to the app',
    fakeGitHub(),
    memoryStore(),
  );
  assert.equal(out.status, 200, out.detail);
  assert.ok(implementationCalls >= 1);
  assert.deepEqual(out.proposal.files.map((file) => file.path), ['lib/main.dart']);
});


test('review pipeline receives fetched source and never asks owner to supply repository code', async () => {
  let reviewerSawSource = false;
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        const payload = JSON.parse(input.messages[1].content);
        if (system.includes('Architect')) {
          return { response: JSON.stringify({ plan: 'Improve current status wording.', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] }) };
        }
        if (system.includes('Review')) {
          const inspected = payload.inspected_source || [];
          reviewerSawSource = reviewerSawSource || inspected.some((item) =>
            item.path === 'lib/main.dart' && String(item.source || '').includes('Ready. Type or speak a request.')
          );
          if (!inspected.length) {
            return { response: JSON.stringify({
              approved: false,
              target_correct: false,
              notes: ['Unable to inspect the current repository because source code was not provided.'],
              repair_instructions: 'Provide source code.',
            }) };
          }
          return { response: JSON.stringify({ approved: true, target_correct: true, notes: ['Verified against fetched source.'], repair_instructions: '' }) };
        }
        return { response: JSON.stringify({
          summary: 'Small real improvement',
          edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready and listening, sir.'" }],
        }) };
      },
    },
  };

  const out = await prepareSelfUpdate(
    env,
    'make one small real improvement to the app',
    fakeGitHub(),
    memoryStore(),
  );
  assert.equal(out.status, 200, out.detail);
  assert.equal(reviewerSawSource, true);
  assert.equal(out.approval_required, true);
  assert.deepEqual(out.proposal.files.map((file) => file.path), ['lib/main.dart']);
});


test('substance check ignores multiline and HTML comment-only edits', () => {
  const dartBefore = 'class A {\n  /*\n  old explanation\n  */\n  int value = 1;\n}\n';
  const dartAfter = 'class A {\n  /*\n  new explanation\n  */\n  int value = 1;\n}\n';
  const htmlBefore = '<div>real</div>\n<!--\nold note\n-->\n';
  const htmlAfter = '<div>real</div>\n<!--\nnew note\n-->\n';
  assert.equal(substantiveChange(new Map([['lib/a.dart', dartBefore]]), [{ path: 'lib/a.dart', content: dartAfter }]), false);
  assert.equal(substantiveChange(new Map([['web/a.html', htmlBefore]]), [{ path: 'web/a.html', content: htmlAfter }]), false);
  assert.equal(substantiveChange(new Map([['lib/a.dart', dartBefore]]), [{ path: 'lib/a.dart', content: dartAfter.replace('int value = 1;', 'int value = 2;') }]), true);
});

test('docs-only intent accepts normal action verbs without hiding mixed code work', () => {
  for (const request of ['fix the README typo', 'create setup documentation', 'add comments explaining setup', 'update docs for the API route']) {
    assert.equal(wantsDocsOnly(request), true, request);
  }
  assert.equal(wantsDocsOnly('rebuild the Brain room and update the README'), false);
  assert.equal(wantsDocsOnly('fix the feature according to the README'), false);
});


test('docs-only classifier rejects mixed feature requests with arbitrary nouns', () => {
  assert.equal(wantsDocsOnly('fix login and update docs'), false);
  assert.equal(wantsDocsOnly('add dark mode and update README'), false);
  assert.equal(wantsDocsOnly('update docs and fix onboarding'), false);
  assert.equal(wantsDocsOnly('fix login according to the README'), false);
  assert.equal(wantsDocsOnly('fix the README typo'), true);
  assert.equal(wantsDocsOnly('create setup documentation'), true);
});


test('docs-only classifier treats comma ampersand and while as mixed-clause separators', () => {
  assert.equal(wantsDocsOnly('fix login, update docs'), false);
  assert.equal(wantsDocsOnly('add dark mode & update README'), false);
  assert.equal(wantsDocsOnly('fix onboarding while updating documentation'), false);
  assert.equal(wantsDocsOnly('update README, comments, and setup notes'), true);
});

test('substance check keeps CSS https URLs as executable style content', () => {
  const before = '.hero { background-image: url(https://cdn.example.com/old.png); }\n';
  const after = '.hero { background-image: url(https://cdn.example.com/new.png); }\n';
  assert.equal(substantiveChange(new Map([['web/site.css', before]]), [{ path: 'web/site.css', content: after }]), true);
  const commentOnly = '.hero {\n  /* old note */\n  background: black;\n}\n';
  const commentOnlyAfter = '.hero {\n  /* new note */\n  background: black;\n}\n';
  assert.equal(substantiveChange(new Map([['web/site.css', commentOnly]]), [{ path: 'web/site.css', content: commentOnlyAfter }]), false);
});


test('docs-only classifier treats shared verbs with non-doc targets as mixed implementation', () => {
  assert.equal(wantsDocsOnly('update README and login flow'), false);
  assert.equal(wantsDocsOnly('fix docs and dark mode'), false);
  assert.equal(wantsDocsOnly('update README and comments'), true);
});

test('HTML substance strips script comments but preserves URL changes', () => {
  const commentBefore = '<script>\n// old note\nconst ready = true;\n</script>\n';
  const commentAfter = '<script>\n// new note\nconst ready = true;\n</script>\n';
  assert.equal(substantiveChange(
    new Map([['assets/office3d/view.html', commentBefore]]),
    [{ path: 'assets/office3d/view.html', content: commentAfter }],
  ), false);

  const urlBefore = '<img src="https://cdn.example.com/old.png">\n';
  const urlAfter = '<img src="https://cdn.example.com/new.png">\n';
  assert.equal(substantiveChange(
    new Map([['assets/office3d/view.html', urlBefore]]),
    [{ path: 'assets/office3d/view.html', content: urlAfter }],
  ), true);
});


test('docs-only classifier recognizes document verbs and documentation filenames', () => {
  assert.equal(wantsDocsOnly('document the API'), true);
  assert.equal(wantsDocsOnly('fix README.md typo'), true);
  assert.equal(wantsDocsOnly('update docs/setup.md'), true);
  assert.equal(wantsDocsOnly('update README.md and login flow'), false);
  assert.equal(wantsDocsOnly('update docs/setup.md. Fix login'), false);
});


test('Copilot: HTML comments do not alter script/style strings and script comments stay non-substantive', () => {
  const before = [
    '<div data-note="<!-- literal -->">x</div>',
    '<script>',
    'const marker = "<!-- literal -->";',
    '// old explanation',
    'const url = "https://cdn.example.com/a.js";',
    '</script>',
    '<style>',
    '.x::after { content: "<!-- literal -->"; }',
    '</style>',
  ].join('\n');
  const commentOnly = before.replace('// old explanation', '// new explanation');
  const realStringChange = before.replace('<!-- literal -->";', '<!-- changed -->";');
  assert.equal(substantiveChange(new Map([['web/a.html', before]]), [{ path: 'web/a.html', content: commentOnly }]), false);
  assert.equal(substantiveChange(new Map([['web/a.html', before]]), [{ path: 'web/a.html', content: realStringChange }]), true);
});

test('Copilot: executable string whitespace changes remain substantive', () => {
  const before = 'const label = "hello world";\n';
  const after = 'const label = "hello  world";\n';
  assert.equal(substantiveChange(new Map([['server/a.js', before]]), [{ path: 'server/a.js', content: after }]), true);
});

test('Copilot: docs-only classification checks every mutation action', () => {
  assert.equal(wantsDocsOnly('fix README and enable login'), false);
  assert.equal(wantsDocsOnly('update docs, support OAuth'), false);
  assert.equal(wantsDocsOnly('create setup documentation and configure login'), false);
  assert.equal(wantsDocsOnly('fix README typo and update docs/setup.md'), true);
});

test('Copilot: feature mutation verbs around docs references never count as docs-only', () => {
  for (const request of [
    'enable login according to the README',
    'support OAuth per documentation',
    'configure login based on the guide',
    'wire login using the docs',
    'connect OAuth per README',
  ]) {
    assert.equal(wantsDocsOnly(request), false, request);
  }
});

// The change CHE built on Oct 3 from a pasted explanation: a cache and two
// methods nothing ever calls. It compiled and passed review; it delivered nothing.
const OFFICE_STORE_BEFORE = [
  "import 'package:flutter/foundation.dart';",
  'class CheOfficeStore extends ChangeNotifier {',
  '  CheOfficeStore();',
  "  static const cheId = 'che';",
  '  List<CheAgent> get agents => _agents;',
  '}',
].join('\n');
const OFFICE_STORE_DEAD = OFFICE_STORE_BEFORE
  .replace('class CheOfficeStore extends', [
    'extension CheOfficeStoreIndex on CheOfficeStore {',
    '  void updateAgentCache(List<CheAgent> agents) {',
    '    _agentCache.clear();',
    '    for (final agent in agents) {',
    '      _agentCache[agent.id] = agent;',
    '    }',
    '  }',
    '',
    '  CheAgent? getAgent(String id) => _agentCache[id];',
    '}',
    '',
    'class CheOfficeStore extends',
  ].join('\n'))
  .replace('  CheOfficeStore();', '  final Map<String, CheAgent> _agentCache = {};\n  CheOfficeStore();');

test('new code that nothing calls is not an implementation', () => {
  const path = 'lib/agents/che_office_store.dart';
  const before = new Map([[path, OFFICE_STORE_BEFORE]]);
  const after = new Map([[path, OFFICE_STORE_DEAD]]);
  assert.deepEqual(unusedNewCode(before, after, [{ path, content: OFFICE_STORE_DEAD }]).map((u) => u.name), ['updateAgentCache', 'getAgent']);

  // Wired in: the same methods called from the real flow pass.
  const screen = 'lib/agents/che_office_screen.dart';
  const caller = "void refresh(CheOfficeStore store) { store.updateAgentCache(store.agents); final che = store.getAgent('che'); }";
  const wired = new Map([[path, OFFICE_STORE_DEAD], [screen, caller]]);
  const callerBefore = new Map([[path, OFFICE_STORE_BEFORE], [screen, "void refresh(CheOfficeStore store) { }"]]);
  assert.deepEqual(unusedNewCode(callerBefore, wired, [{ path, content: OFFICE_STORE_DEAD }, { path: screen, content: caller }]), []);
});

test('overrides, lifecycle methods, tests and named requests are not flagged as dead code', () => {
  const path = 'lib/ui/panel.dart';
  const before = 'class Panel extends StatelessWidget {\n}';
  const after = 'class Panel extends StatelessWidget {\n  @override\n  Widget build(BuildContext context) {\n    return const SizedBox();\n  }\n  void initState() {\n  }\n}';
  assert.deepEqual(unusedNewCode(new Map([[path, before]]), new Map([[path, after]]), [{ path, content: after }]), []);
  const testPath = 'server/cloudflare/x.test.mjs';
  const testFile = "function helperOnlyHere() {\n  return 1;\n}";
  assert.deepEqual(unusedNewCode(new Map(), new Map([[testPath, testFile]]), [{ path: testPath, content: testFile }]), []);
  const js = 'server/cloudflare/util.js';
  const jsAfter = 'export function formatSpokenTime(date) {\n  return String(date);\n}';
  assert.deepEqual(unusedNewCode(new Map([[js, '']]), new Map([[js, jsAfter]]), [{ path: js, content: jsAfter }]).map((u) => u.name), ['formatSpokenTime']);
  assert.deepEqual(unusedNewCode(new Map([[js, '']]), new Map([[js, jsAfter]]), [{ path: js, content: jsAfter }], 'Add an exported formatSpokenTime helper'), [], 'the owner asked for that exact helper');
  const route = 'server/cloudflare/worker.js';
  const routeAfter = "import { formatSpokenTime } from './util.js';\nconst reply = formatSpokenTime(new Date());";
  assert.deepEqual(unusedNewCode(new Map([[js, ''], [route, '']]), new Map([[js, jsAfter], [route, routeAfter]]), [{ path: js, content: jsAfter }, { path: route, content: routeAfter }]), []);
});

test('content scan finds source by text and identifiers without any model call', async () => {
  const { identifierVariants, scoreSourceContent, contentScan } = await import('./self_development.js');
  assert.deepEqual(identifierVariants('voice button'), ['voiceButton', 'VoiceButton', 'voice_button']);
  assert.equal(scoreSourceContent("Text('Ready to talk')", ['Ready to talk']), 5);
  assert.equal(scoreSourceContent("Text('READY TO TALK')", ['Ready to talk']), 3);
  assert.equal(scoreSourceContent('class VoiceButton extends StatelessWidget {}', ['voice button']), 2);
  assert.equal(scoreSourceContent('nothing here', ['voice button']), 0);

  const files = {
    'lib/home/che_home_chat.dart': "Semantics(label: 'Talk to CHE')",
    'lib/main.dart': 'void main() {}',
  };
  const fetcher = async (url) => {
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1] || '');
    if (!(path in files)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ content: Buffer.from(files[path]).toString('base64'), sha: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ctx = { env: { CHE_GITHUB_REPO: 'o/r', CHE_GITHUB_TOKEN: 't' }, diagnostics: [] };
  const index = { head_sha: 'abc', paths: Object.keys(files), editable_paths: Object.keys(files) };
  const hits = await contentScan(ctx, index, 'fix the talk to che button on chat', ['Talk to CHE'], fetcher);
  assert.deepEqual([...hits.keys()], ['lib/home/che_home_chat.dart']);
});

test('failed-job diagnosis is deterministic and recovery phrases are recognized', async () => {
  const { diagnoseFailure, recoveryRequestIntent, engineeringRecord } = await import('./self_development.js');
  assert.equal(diagnoseFailure({ outcomes: [{ outcome: 'invalid_json' }, { outcome: 'invalid_json' }, { outcome: 'review_rejected' }] }).root_cause, 'invalid_output');
  assert.equal(diagnoseFailure({ outcomes: [{ outcome: 'edit_failed' }], feedback: 'find text does not exist exactly' }).root_cause, 'edit_anchor');
  assert.equal(diagnoseFailure({ outcomes: [{ outcome: 'review_rejected' }] }).root_cause, 'review_rejected');
  const rec = engineeringRecord({ request: 'r', failedStrategies: [{ engineer: 'Knox', outcome: 'review_rejected', why: 'no', prior: true }, { engineer: 'Nova', outcome: 'review_rejected', why: 'yes' }], fingerprints: ['a'], outcomes: [], files: ['lib/a.dart'] });
  assert.deepEqual(rec.failed_strategies.map((s) => s.engineer), ['Nova'], 'prior (seeded) strategies are not double-counted');
  for (const p of ['Diagnose and recover the failed coding job', 'retry the last failed job', 'reopen the engineering record']) assert.ok(recoveryRequestIntent(p), p);
  for (const p of ['update your code: add dark mode', 'what is a failed state']) assert.ok(!recoveryRequestIntent(p), p);
});

test('tiered grounding maps a named utility, its caller and adjacent test', async () => {
  const sha = 'd'.repeat(40);
  const files = {
    'lib/util/che_message_split.dart': 'List<String> cheSplitMessage(String value) => [value];\n',
    'lib/chat/che_chat.dart': "import '../util/che_message_split.dart';\nvoid send(String text) { cheSplitMessage(text); }\n",
    'test/che_message_split_test.dart': "import '../lib/util/che_message_split.dart';\nvoid main() { cheSplitMessage('hi'); }\n",
  };
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/heads/main')) return ok({ object: { sha } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    if (u.includes('/pulls?state=open')) return ok([]);
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m && files[m[1]]) return ok({ content: btoa(files[m[1]]), sha: 'blob-' + m[1] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const out = await inspectRepositoryContext(
    { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' },
    'inspect che message split utility and its callers and tests',
    fetcher,
  );
  assert.equal(out.ok, true);
  assert.ok(out.files.some((file) => file.path === 'lib/util/che_message_split.dart'));
  assert.ok(out.files.some((file) => file.path === 'lib/chat/che_chat.dart'));
  assert.ok(out.files.some((file) => file.path === 'test/che_message_split_test.dart'));
  assert.ok(out.files.find((file) => file.path === 'lib/chat/che_chat.dart').references.includes('lib/util/che_message_split.dart'));
});

test('tiered grounding keeps existing War Room architecture in a broad complex request', async () => {
  const sha = 'e'.repeat(40);
  const files = {
    'lib/agents/che_office_floor_screen.dart': "import 'che_war_room_screen.dart';\nclass CheOfficeFloorScreen {}\nvoid openProject() { const CheWarRoomScreen(); }\n",
    'lib/agents/che_war_room_screen.dart': 'class CheWarRoomScreen { const CheWarRoomScreen(); }\nclass CheWarRoomController {}\n',
    'test/che_war_room_screen_test.dart': "import '../lib/agents/che_war_room_screen.dart';\nvoid main() { const CheWarRoomScreen(); }\n",
    'server/cloudflare/worker.js': "async function handleRequest(request) { if (new URL(request.url).pathname === '/api/office/war-room') return new Response('ok'); }\n",
    'server/cloudflare/agent_runtime.js': "export function agentState() { return 'working'; }\n",
    'lib/home_state/security.dart': 'class SecuritySession {}\n',
    'lib/rooms/che_live_chart.dart': 'class CheLiveChart {}\n',
  };
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/heads/main')) return ok({ object: { sha } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    if (u.includes('/pulls?state=open')) return ok([]);
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m && files[m[1]]) return ok({ content: btoa(files[m[1]]), sha: 'blob-' + m[1] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const out = await inspectRepositoryContext(
    { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' },
    'Design a production-ready complicated coding plan covering architecture security accessibility planning review parallel workflows for the War Room group chat and character state.',
    fetcher,
  );
  assert.equal(out.ok, true);
  const paths = out.files.map((file) => file.path);
  assert.ok(paths.includes('lib/agents/che_war_room_screen.dart'), 'existing War Room implementation cannot be crowded out');
  assert.ok(paths.includes('lib/agents/che_office_floor_screen.dart'), 'War Room caller must remain grounded');
  assert.ok(paths.includes('test/che_war_room_screen_test.dart'), 'adjacent War Room test must be grounded');
  assert.ok(paths.includes('server/cloudflare/worker.js'), 'Worker routing evidence must remain grounded');
  assert.ok(out.files.find((file) => file.path === 'lib/agents/che_office_floor_screen.dart').references.includes('lib/agents/che_war_room_screen.dart'));
});


test('reviewer outage on the final genuine pass checkpoints the candidate and resumes review without another implementation pass', async () => {
  let implementationCalls = 0;
  let reviewersAvailable = false;
  const env = {
    CHE_GITHUB_TOKEN: 't',
    CHE_GITHUB_REPO: 'o/r',
    AI: {
      run: async (_model, input) => {
        const system = input.messages[0].content;
        if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'change banner', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] }) };
        if (system.includes('Source Recovery Architect')) return { response: JSON.stringify({ plan: 'same verified target', search_terms: ['Ready. Type or speak a request.'], paths: ['lib/main.dart'] }) };
        if (system.includes('Review')) {
          if (!reviewersAvailable) return { response: '' };
          return { response: JSON.stringify({ approved: true, target_correct: true, notes: [], repair_instructions: '', lesson: '' }) };
        }
        implementationCalls++;
        return { response: JSON.stringify({ summary: 'Ready banner', edits: [{ path: 'lib/main.dart', find: "'Ready. Type or speak a request.'", replace: "'Ready, sir.'" }] }) };
      },
    },
  };

  const first = await prepareSelfUpdate(env, 'make the Ready banner say Ready, sir', fakeGitHub(), memoryStore(), {
    checkpoint: { genuine_passes: 2, fingerprints: [], failed_strategies: [], resumes: 0, round_offset: 2, faults_used: {} },
  });
  assert.equal(first.status, 503, first.detail);
  assert.equal(first.checkpoint.genuine_passes, 3, 'the third implementation pass stays consumed');
  assert.ok(first.checkpoint.pending_review?.changed_files?.length, 'the valid candidate survives the reviewer outage');
  const callsAfterCandidate = implementationCalls;

  reviewersAvailable = true;
  const resumed = await prepareSelfUpdate(env, 'make the Ready banner say Ready, sir', fakeGitHub(), memoryStore(), { checkpoint: first.checkpoint });
  assert.equal(resumed.status, 200, resumed.detail);
  assert.equal(implementationCalls, callsAfterCandidate, 'resume retries review only; it does not grant a fourth implementation pass');
  assert.match(resumed.proposal.files[0].content, /Ready, sir/);
});

test('grounding answers a quoted phrase with the real file and line, and lists every path for the reply guard', async () => {
  const sha = 'd'.repeat(40);
  const files = {
    'server/cloudflare/worker.js': 'const a = 1;\n// "mission status": the durable objective graphs, spoken.\nif (/mission status/i.test(m)) speak();\n',
    'lib/main.dart': 'void main() {}\n',
  };
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/heads/main')) return ok({ object: { sha } });
    if (u.includes('/git/trees/')) return ok({ tree: Object.keys(files).map((path) => ({ type: 'blob', path })) });
    if (u.includes('/pulls?state=open')) return ok([]);
    const m = /\/contents\/(.+)\?ref=/.exec(u);
    if (m && files[m[1]]) return ok({ content: btoa(files[m[1]]), sha: 'blob-' + m[1] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const out = await inspectRepositoryContext({ CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' }, 'Which file answers the voice command "mission status"?', fetcher);
  assert.equal(out.exact_search, 'found');
  assert.deepEqual(out.exact_matches.map((m) => [m.path, m.line]), [['server/cloudflare/worker.js', 2], ['server/cloudflare/worker.js', 3]]);
  assert.deepEqual(out.all_paths.sort(), Object.keys(files).sort());
});
