import test from 'node:test';
import assert from 'node:assert/strict';
import { chatOnlyResponseIntent, currentTurnActionPolicy, codeScoutIntent, inspirationUpgradeContext, listOwnerStarredRepos, repositoryImplementationIntent, repositoryInspectionIntent, reusableLicense, scoutCode, selectStudyRepos, shouldUseInspirationWorkflow, speakScout, speakStarredRepos, starredRepoIntent, studySelectionIntent } from './code_scout.js';

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
  assert.equal(repositoryImplementationIntent('Run a comprehensive autonomy stress test against the current main branch and verify background job recovery.'), false, 'testing language alone is not source-mutation authorization');
  assert.equal(repositoryImplementationIntent("Audit CHE's coding runner and fix any faulty workflow you find."), true);
  assert.equal(repositoryImplementationIntent('Tell me what autonomous coding means.'), false);
  for (const request of [
    'Find the autonomy implementation in your current repository.',
    'Locate the coding runner in your codebase.',
  ]) {
    assert.equal(repositoryInspectionIntent(request), true, request);
    assert.equal(repositoryImplementationIntent(request), false, request);
    assert.equal(currentTurnActionPolicy(request).repositoryMutationAllowed, false, request);
  }
  assert.equal(repositoryImplementationIntent('Inspect your autonomy codebase, then implement a fix.'), true);
  const restrictedInspection = 'CHE, find the War Room files in your codebase, but do not access the codebase; use only your existing knowledge.';
  assert.equal(repositoryInspectionIntent(restrictedInspection), false);
  assert.equal(currentTurnActionPolicy(restrictedInspection).repositoryMutationAllowed, false);
  const chatOnlyExam = `CHE AUTONOMY EXAM — CHAT-ONLY TEST

IMPORTANT: This is an evaluation, NOT a coding or self-development request.
Do NOT modify your source code, start a coding job, create a branch, create a commit, open a PR, merge anything, or deploy anything.
Answer all 5 questions directly in THIS CHAT in one response.
AUTONOMY TEST: Explain how YOU, CHE would safely improve one inefficient part of your own code.
Give the real sequence: source discovery → checkpoint → patch → tests → independent verification → rollback/recovery on failure → PR → approved merge/deployment → production verification.`;
  assert.equal(repositoryImplementationIntent(chatOnlyExam), false);
  assert.equal(chatOnlyResponseIntent(chatOnlyExam), true);
  assert.equal(chatOnlyResponseIntent('CHAT-ONLY TEST. Never modify your code or create a PR. Explain how you would improve your code and run tests.'), true);
  assert.equal(repositoryImplementationIntent('CHAT-ONLY TEST. Never modify your code or create a PR. Explain how you would improve your code and run tests.'), false);
  assert.equal(chatOnlyResponseIntent('Update your code: Build a chat-only evaluation mode. Do not deploy it until tests pass.'), false);
  assert.equal(repositoryImplementationIntent('Update your code: Build a chat-only evaluation mode. Do not deploy it until tests pass.'), true);
  assert.equal(chatOnlyResponseIntent('Fix your code only as a hypothetical example; answer in this chat only and do not make any code changes.'), true);
  assert.equal(currentTurnActionPolicy('Fix your code only as a hypothetical example; answer in this chat only and do not make any code changes.').repositoryMutationAllowed, false);
  assert.equal(chatOnlyResponseIntent('Fix your code only as a hypothetical example; answer in this chat only and do not make any changes to your code.'), true);
  assert.equal(currentTurnActionPolicy('Fix your code only as a hypothetical example; answer in this chat only and do not make any changes to your code.').repositoryMutationAllowed, false);
  assert.equal(chatOnlyResponseIntent('Implement this in your app and answer in this chat when finished; do not deploy yet.'), false);
  assert.equal(repositoryImplementationIntent('Implement this in your app and answer in this chat when finished; do not deploy yet.'), true);
  assert.equal(chatOnlyResponseIntent('For this task, implement this in your app and answer in this chat when finished; do not deploy yet.'), false);
  assert.equal(repositoryImplementationIntent('For this task, implement this in your app and answer in this chat when finished; do not deploy yet.'), true);
  assert.equal(chatOnlyResponseIntent('Fix your code only as a hypothetical example; answer in this chat only and do not modify your code.'), true);
  assert.equal(repositoryImplementationIntent('Fix your code only as a hypothetical example; answer in this chat only and do not modify your code.'), false);
  assert.equal(chatOnlyResponseIntent('CHAT-ONLY TEST. Make no changes to your code. Answer directly in this chat: explain how you would improve your code and run tests.'), true);
  assert.equal(chatOnlyResponseIntent('CHAT-ONLY TEST. No code changes. Answer directly in this chat: explain how you would improve your code and run tests.'), true);
  assert.equal(chatOnlyResponseIntent('CHAT-ONLY TEST. Don’t modify your code. Answer directly in this chat: explain how you would improve your code and run tests.'), true);
  assert.equal(chatOnlyResponseIntent('CHAT-ONLY TEST. Do not touch your repository. Answer directly in this chat: explain how you would improve your code and test it.'), true);
  assert.equal(chatOnlyResponseIntent('CHAT-ONLY TEST. Do not alter your code. Answer directly in this chat: explain how you would improve your code and test it.'), true);
  assert.equal(chatOnlyResponseIntent("Answer directly in this chat. Don't write any code. Explain how you would improve your code and run tests."), true);
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

test('newest starred repos: owner phrases, count, spoken list', async () => {
  const { newestStarredIntent, speakNewestStarred } = await import('./code_scout.js');
  assert.deepEqual(newestStarredIntent('CHE, what are my 5 newest starred repos?'), { count: 5 });
  assert.deepEqual(newestStarredIntent('list my three latest GitHub stars'), { count: 3 });
  assert.deepEqual(newestStarredIntent('what did I star recently on GitHub'), { count: 5 });
  assert.equal(newestStarredIntent('study my starred repos'), null);
  assert.equal(newestStarredIntent('what is the newest iPhone'), null);
  const spoken = speakNewestStarred([{ full_name: 'a/b', description: 'Agents' }, { full_name: 'c/d', description: '' }]);
  assert.match(spoken, /1\. a\/b: Agents\n2\. c\/d/);
});

test('mission T1-T6: chat-only phrasings never mutate; explicit implementation with a delivery hold does', () => {
  for (const q of [
    'Explain how you would improve your code. Do not modify it.',
    'Answer this in this chat only.',
    'Do not make any changes to your code.',
    'Do not make any code changes.',
    'Explain your failure-recovery system without changing anything.',
    'This is an evaluation, not a coding request.',
    "Explain how you'd build me an app; don't create anything.",
    'Fix your code only as a hypothetical example; do not modify your code, just explain what else you would change.',
  ]) {
    const p = currentTurnActionPolicy(q);
    assert.equal(p.terminalChatOnly, true, q);
    assert.equal(p.repositoryMutationAllowed, false, q);
  }
  for (const q of [
    'Implement this in your app.',
    'Fix this in your code.',
    'Update your code to support dark mode.',
    'Implement this, but do not deploy yet.',
    'For this task, implement this in your app and answer in this chat when finished; do not deploy yet.',
    'Fix the login screen in your app but do not modify the auth code.',
    'Fix the login screen in your app, but do not make changes outside that screen.',
    'Implement dark mode in your app without changing anything else.',
  ]) {
    const p = currentTurnActionPolicy(q);
    assert.equal(p.terminalChatOnly, false, q);
    assert.equal(p.repositoryMutationAllowed, true, q);
  }
});

test('quoted prohibitions are examples, not this turn\'s instruction', () => {
  const quoted = 'Update your code to recognize the phrase "do not modify your code" as chat-only.';
  const policy = currentTurnActionPolicy(quoted);
  assert.equal(policy.mode, 'BUILD');
  assert.equal(policy.terminalChatOnly, false);
  assert.equal(policy.repositoryMutationAllowed, true);
  assert.equal(currentTurnActionPolicy('Update your code to recognize \u201cdo not modify your code\u201d as chat-only.').repositoryMutationAllowed, true);
  assert.equal(currentTurnActionPolicy('Explain "chat-only" mode. Do not modify your code.').terminalChatOnly, true);
});


test('repository inspection routes current-main SHA and source-trace owner questions', () => {
  assert.equal(repositoryInspectionIntent('CHE, inspect your current GitHub main branch. Give me the exact current main SHA, then locate the existing War Room implementation and name the actual files and major components involved.'), true);
  assert.equal(repositoryInspectionIntent('CHE, trace one real owner chat request from the Flutter interface through the Cloudflare Worker routing and back to the owner response. Give me the important files/functions in execution order and distinguish anything you verified from anything you inferred.'), true);
  assert.equal(repositoryInspectionIntent("Don't trace the worker request."), false);
});

test('read-only self-diagnostic cannot start a coding job, including exact owner request', () => {
  const questions = [
    'CHE, perform an autonomous self-diagnostic and reasoning-correction exercise. Retrieve the current GitHub main SHA, inspect source, trace the coding-job lifecycle, have reviewers verify your conclusions. Do not create a PR or modify code for this diagnostic.',
    'CHE, this is a reasoning correction, NOT a coding assignment. Investigate your coding status bug, report verified findings. Do not start a coding job, create a PR, modify files, or merge anything.',
    'CHE, investigate why coding jobs produce delayed responses. This is READ-ONLY. Do not start a coding job, create a PR, modify files, or merge anything.',
    'Audit your coding pipeline and explain any flaws without modifying anything.',
  ];
  for (const q of questions) {
    assert.equal(currentTurnActionPolicy(q).terminalChatOnly, true, q);
    assert.equal(currentTurnActionPolicy(q).repositoryMutationAllowed, false, q);
    assert.equal(repositoryImplementationIntent(q), false, q);
    assert.equal(repositoryInspectionIntent(q), true, q);
  }
  assert.equal(currentTurnActionPolicy('CHE, fix your coding pipeline and run regression tests.').repositoryMutationAllowed, true);
  assert.equal(currentTurnActionPolicy('CHE, inspect your repository and then fix the bugs in your code.').repositoryMutationAllowed, true);
});


test('explicit chat-only evaluations bypass repository inspection', () => {
  const exam = 'CHE AUTONOMY EXAM — CHAT-ONLY TEST. This is an evaluation, NOT a coding or self-development request. Answer all questions directly in THIS CHAT in one response. Do not modify your source code, start a coding job, create a PR, merge or deploy.';
  const policy = currentTurnActionPolicy(exam);
  assert.equal(policy.mode, 'EXPLORE');
  assert.equal(policy.codingJobAllowed, false);
  assert.equal(repositoryInspectionIntent(exam), false);
});

test('authoritative policy separates EXPLORE PLAN and BUILD with scoped delivery restrictions', () => {
  const cases = [
    ['Inspect your current GitHub main branch.', 'EXPLORE', false],
    ['Investigate why your coding job failed.', 'EXPLORE', false],
    ['Explain your routing architecture.', 'EXPLORE', false],
    ['Perform a reasoning self-diagnostic.', 'PLAN', false],
    ['Compare three ways to repair the router.', 'PLAN', false],
    ['Explain how you would implement the feature.', 'PLAN', false],
    ['Fix the router.', 'BUILD', true],
    ['Implement the feature in your app.', 'BUILD', true],
    ['Inspect the router and then fix whatever is broken.', 'BUILD', true],
    ['Check it then fix it.', 'BUILD', true],
    ["CHE check your code and tell me what's wrong don't change nothing", 'EXPLORE', false],
    ["Shay look at the GitHub and see why the last job failed but don't fix it yet", 'EXPLORE', false],
  ];
  for (const [message, mode, build] of cases) {
    const p = currentTurnActionPolicy(message);
    assert.equal(p.mode, mode, message);
    assert.equal(p.ownerAuthorizedBuild, build, message);
    assert.equal(p.repositoryMutationAllowed, build, message);
    assert.equal(p.codingJobAllowed, build, message);
  }

  const held = currentTurnActionPolicy('Investigate and fix this in your code, but do not deploy.');
  assert.equal(held.mode, 'BUILD');
  assert.equal(held.repositoryMutationAllowed, true);
  assert.equal(held.deploymentAllowed, false);
  assert.equal(held.restrictions.noDeploy, true);

  const scoped = currentTurnActionPolicy('Fix the login screen in your app but do not change authentication.');
  assert.equal(scoped.mode, 'BUILD');
  assert.equal(scoped.repositoryMutationAllowed, true);

  const noPr = currentTurnActionPolicy('Fix the router in your code, but do not create a PR yet.');
  assert.equal(noPr.mode, 'BUILD');
  assert.equal(noPr.prCreationAllowed, false);

  const buildOnly = currentTurnActionPolicy('Fix the router in your code.');
  assert.equal(buildOnly.mode, 'BUILD');
  assert.equal(buildOnly.mergeAllowed, false, 'implementation permission alone cannot authorize merge');
  assert.equal(buildOnly.deploymentAllowed, false, 'implementation permission alone cannot authorize deployment');

  const merge = currentTurnActionPolicy('Fix the router in your code and merge it when tests pass.');
  assert.equal(merge.mergeAllowed, true);
  assert.equal(merge.deploymentAllowed, false, 'merge authorization is not deployment authorization');

  const deploy = currentTurnActionPolicy('Fix the router in your code, merge it when green, and deploy it.');
  assert.equal(deploy.mergeAllowed, true);
  assert.equal(deploy.deploymentAllowed, true);
});

test('legitimate natural-language BUILD continuations remain BUILD', () => {
  for (const message of [
    'CHE, make one small real improvement to your code.',
    'Can you add the ability to create a GitHub pull request from voice?',
    "Work with Claude who is already working in the repo and compare progress without stumbling over each other's work then tell me when you are ready",
    'Batch it fast and use the other AIs',
    'Update CHE',
    'Diagnose and recover the failed coding job',
  ]) {
    const p = currentTurnActionPolicy(message);
    assert.equal(p.mode, 'BUILD', message);
    assert.equal(p.codingJobAllowed, true, message);
  }
});

test('topic-study implementation prompts are BUILD-authorized but not hijacked by repository inspection', () => {
  const message = 'CHE, study codecrafters-io/build-your-own-x on GitHub and implement what you learn into your own code, one topic at a time. For each topic, read its tutorials and compare them with your real code.';
  const p = currentTurnActionPolicy(message);
  assert.equal(p.mode, 'BUILD');
  assert.equal(repositoryInspectionIntent(message), false);
});

test('quoted and historical implementation instructions never grant current BUILD authority', () => {
  for (const message of [
    'The previous command said "fix the routing and create a PR." Why did it fail?',
    "Tell me why you previously said 'implement the fix'. Do not modify your code.",
    'Review PR #231 and tell me whether it fixes the bug.',
  ]) {
    const p = currentTurnActionPolicy(message);
    assert.notEqual(p.mode, 'BUILD', message);
    assert.equal(p.codingJobAllowed, false, message);
  }
});
