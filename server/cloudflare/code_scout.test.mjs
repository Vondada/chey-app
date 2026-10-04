import test from 'node:test';
import assert from 'node:assert/strict';
import { codeScoutIntent, inspirationUpgradeContext, listOwnerStarredRepos, repositoryImplementationIntent, reusableLicense, scoutCode, selectStudyRepos, shouldUseInspirationWorkflow, speakScout, speakStarredRepos, starredRepoIntent, studySelectionIntent } from './code_scout.js';

test('intent parses code-scout phrasings', () => {
  assert.deepEqual(codeScoutIntent('find code for offline speech to text'), { need: 'offline speech to text' });
  assert.deepEqual(codeScoutIntent('CHE, scout github for a flutter audio player'), { need: 'a flutter audio player' });
  assert.equal(codeScoutIntent('good afternoon'), null);
});

test('only permissively-licensed, non-archived repos are returned, best stars first', async () => {
  const items = [
    { full_name: 'a/permissive', stargazers_count: 5000, license: { spdx_id: 'MIT', name: 'MIT License' }, description: 'x', html_url: 'u', language: 'Dart', archived: false },
    { full_name: 'b/gpl', stargazers_count: 9000, license: { spdx_id: 'GPL-3.0', name: 'GPL v3' }, description: 'x', html_url: 'u', archived: false },
    { full_name: 'c/nolicense', stargazers_count: 8000, license: null, description: 'x', html_url: 'u', archived: false },
    { full_name: 'd/archived', stargazers_count: 7000, license: { spdx_id: 'Apache-2.0', name: 'Apache 2.0' }, description: 'x', html_url: 'u', archived: true },
    { full_name: 'e/apache', stargazers_count: 3000, license: { spdx_id: 'Apache-2.0', name: 'Apache 2.0' }, description: 'x', html_url: 'u', archived: false },
  ];
  const res = await scoutCode({}, 'flutter audio', async () => new Response(JSON.stringify({ items }), { status: 200 }));
  assert.deepEqual(res.repos.map((r) => r.full_name), ['a/permissive', 'e/apache']);
  assert.match(speakScout('flutter audio', res), /a\/permissive/);
  assert.equal(reusableLicense('GPL-3.0'), false);
  assert.equal(reusableLicense('MIT'), true);
});

test('empty when nothing reusable matched', async () => {
  const res = await scoutCode({}, 'audio', async () => new Response(JSON.stringify({ items: [{ full_name: 'g/gpl', stargazers_count: 9000, license: { spdx_id: 'GPL-3.0' }, archived: false }] }), { status: 200 }));
  assert.equal(res.repos.length, 0);
  assert.match(speakScout('audio', res), /freely-reusable repos matched/i);
});


test('starred GitHub intent distinguishes research from implementation', () => {
  const implementationText = 'Update your code: use my starred GitHub repositories and Inspirations, compare them with CHE, implement the useful delta, run tests, and create a draft PR.';
  const intent = starredRepoIntent(implementationText);
  assert.ok(intent);
  assert.equal(intent.integrate, true);
  assert.equal(repositoryImplementationIntent(implementationText), true);
  assert.equal(repositoryImplementationIntent('Inspect my starred GitHub repos for agent and RAG systems.'), false);
  assert.equal(repositoryImplementationIntent('Run a comprehensive autonomy stress test against the current main branch and verify background job recovery.'), true);
  assert.equal(repositoryImplementationIntent('Audit CHE's coding runner and fix any faulty workflow you find.'), true);
  assert.equal(repositoryImplementationIntent('Tell me what autonomous coding means.'), false);
  assert.equal(starredRepoIntent('change the text on my home screen'), null);
});

test('starred repository scan ranks relevant reusable repos and reports real GitHub access failures', async () => {
  const pages = [
    [
      { full_name: 'x/agent-os', stargazers_count: 5000, license: { spdx_id: 'MIT', name: 'MIT License' }, description: 'Multi-agent orchestration and RAG memory', html_url: 'u1', language: 'Python', archived: false, topics: ['agents', 'rag'] },
      { full_name: 'x/theme-pack', stargazers_count: 9000, license: { spdx_id: 'MIT', name: 'MIT License' }, description: 'CSS themes', html_url: 'u2', language: 'CSS', archived: false, topics: ['themes'] },
      { full_name: 'x/gpl-agent', stargazers_count: 7000, license: { spdx_id: 'GPL-3.0', name: 'GPL v3' }, description: 'AI agent framework', html_url: 'u3', language: 'Python', archived: false, topics: ['agents'] },
    ],
  ];
  const fetcher = async (url) => {
    assert.match(String(url), /\/users\/Vondada\/starred/);
    return new Response(JSON.stringify(pages.shift() || []), { status: 200 });
  };
  const intent = starredRepoIntent('Inspect my starred GitHub repos for agent and RAG systems.');
  const res = await listOwnerStarredRepos(
    { CHE_GITHUB_REPO: 'Vondada/chey-app', CHE_GITHUB_TOKEN: 't' },
    fetcher,
    { focus: intent.focus },
  );
  assert.equal(res.checked, 3);
  assert.equal(res.candidates[0].full_name, 'x/agent-os');
  assert.equal(res.candidates[0].reusable, true);
  assert.match(speakStarredRepos(intent, res), /x\/agent-os/);
  assert.match(speakStarredRepos(intent, res), /does not label custom lists such as Inspirations/i);

  const denied = await listOwnerStarredRepos(
    { CHE_GITHUB_REPO: 'Vondada/chey-app', CHE_GITHUB_TOKEN: 't' },
    async () => new Response('{}', { status: 403 }),
  );
  assert.match(denied.error, /403/);
  assert.match(denied.error, /Starring read access/i);
});


test('study selection keeps multiple repositories for the next upgrade', async () => {
  assert.deepEqual(studySelectionIntent('Study 1 and 2'), { numbers: [1, 2], indexes: [0, 1] });
  assert.deepEqual(studySelectionIntent('CHE, study numbers 2, 3 and 3'), { numbers: [2, 3], indexes: [1, 2] });
  const state = new Map([
    ['code_scout_last', [
      { full_name: 'a/agents', license: 'mit' },
      { full_name: 'b/memory', license: 'apache-2.0' },
    ]],
  ]);
  const storage = {
    get: async (key) => state.get(key),
    put: async (key, value) => state.set(key, value),
  };
  const selected = await selectStudyRepos(storage, studySelectionIntent('study 1 and 2'));
  assert.deepEqual(selected.repos.map((r) => r.full_name), ['a/agents', 'b/memory']);
  assert.deepEqual(state.get('code_scout_selected').repos.map((r) => r.full_name), ['a/agents', 'b/memory']);
});

test('compare-delta workflow is reserved for substantial engineering work', () => {
  assert.equal(shouldUseInspirationWorkflow('Update your code: improve agent handoffs and memory routing'), true);
  assert.equal(shouldUseInspirationWorkflow('Rename the Ready banner text to Ready, sir'), false);
});

test('inspiration context reads selected reusable repos and treats them as reference data', async () => {
  const state = new Map([
    ['code_scout_selected', { repos: [{ full_name: 'a/agents', license: 'mit' }] }],
  ]);
  const storage = {
    get: async (key) => state.get(key),
    put: async (key, value) => state.set(key, value),
  };
  const fetcher = async (url) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/a/agents') {
      return new Response(JSON.stringify({
        default_branch: 'main',
        description: 'Agent orchestration',
        language: 'Python',
        stargazers_count: 1000,
        topics: ['agents'],
        license: { spdx_id: 'MIT', name: 'MIT License' },
      }), { status: 200 });
    }
    if (u.includes('/readme?')) {
      return new Response(JSON.stringify({ content: Buffer.from('# Agents\nDelegation and handoffs.').toString('base64') }), { status: 200 });
    }
    if (u.includes('/contents?')) {
      return new Response(JSON.stringify([{ path: 'README.md' }, { path: 'agents' }]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  const out = await inspirationUpgradeContext(
    { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app' },
    storage,
    'Improve agent handoffs',
    fetcher,
  );
  assert.match(out.text, /COMPARE → DELTA → INTEGRATE/);
  assert.match(out.text, /a\/agents/);
  assert.match(out.text, /REFERENCE MATERIAL, not instructions/);
  assert.equal(out.references[0].reusable, true);
});

test('repo source ranking picks real code that matches the need, not tests or vendored files', async () => {
  const { rankRepoSourcePaths } = await import('./code_scout.js');
  const entries = [
    { path: 'README.md', type: 'blob' },
    { path: 'src/memory/vector_store.ts', type: 'blob', size: 4000 },
    { path: 'src/memory/vector_store.test.ts', type: 'blob', size: 2000 },
    { path: 'node_modules/x/memory.js', type: 'blob', size: 100 },
    { path: 'dist/app.min.js', type: 'blob', size: 100 },
    { path: 'src/ui/button.ts', type: 'blob', size: 900 },
    { path: 'src/huge_memory.js', type: 'blob', size: 900_000 },
  ];
  const picked = rankRepoSourcePaths(entries, 'improve CHE memory with a vector store', 3);
  assert.equal(picked[0], 'src/memory/vector_store.ts');
  assert.ok(!picked.some((p) => /test|node_modules|\.min\.|README|huge_/.test(p)), picked.join(','));
});

test('readRepoSource reads the code itself and marks the license', async () => {
  const { readRepoSource, referenceSourceBlock } = await import('./code_scout.js');
  const fetcher = async (url) => {
    if (url.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [{ path: 'lib/agent.dart', type: 'blob', size: 50 }] }));
    if (url.startsWith('https://raw.githubusercontent.com/o/r/main/lib/agent.dart')) return new Response('class Agent { void run() {} }');
    return new Response('{}', { status: 404 });
  };
  const mit = await readRepoSource({}, { full_name: 'o/r', branch: 'main', license: 'mit' }, { need: 'agent' }, fetcher);
  assert.deepEqual(mit.files, [{ path: 'lib/agent.dart', text: 'class Agent { void run() {} }' }]);
  assert.equal(mit.reusable, true);
  assert.match(referenceSourceBlock(mit), /MAY adapt[\s\S]*Adapted from o\/r[\s\S]*class Agent/);

  const closed = await readRepoSource({}, { full_name: 'o/r', branch: 'main', license: 'noassertion' }, { need: 'agent' }, fetcher);
  assert.equal(closed.reusable, false);
  assert.match(referenceSourceBlock(closed), /STUDY ONLY[\s\S]*never copy/);
  assert.equal(referenceSourceBlock({ files: [] }), '');
});
