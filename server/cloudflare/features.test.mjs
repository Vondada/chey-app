import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToolUrl, planPluginCall, pluginManifests, runPluginTool } from './plugin_runtime.js';
import { classifyUpdate, isSelfUpdateEditablePath, isSelfUpdateReadablePath, openSelfUpdatePr, rollbackLastUpdate, scanUpdateContent, selfUpdateGitHubAccess, validateUpdateFiles } from './self_update.js';
import { accountSnapshot, parseStooqCsv, snapshot } from './markets.js';

const weather = pluginManifests({}).find((item) => item.id === 'weather');

test('plugin tool URLs only reach declared HTTPS hosts', () => {
  const [findPlace] = weather.tools;
  const ok = buildToolUrl(findPlace, { name: 'São Paulo & co' }, weather.permissions);
  assert.equal(ok.url, 'https://geocoding-api.open-meteo.com/v1/search?count=1&name=S%C3%A3o%20Paulo%20%26%20co');
  assert.match(buildToolUrl(findPlace, {}, []).error, /did not declare permission/);
  const tool = (url, method = 'GET') => ({ request: { method, url } });
  assert.match(buildToolUrl(tool('http://api.x.com/a'), {}, ['network:api.x.com']).error, /HTTPS/);
  assert.match(buildToolUrl(tool('https://127.0.0.1/a'), {}, ['network:127.0.0.1']).error, /local or private/);
  assert.match(buildToolUrl(tool('https://localhost/a'), {}, ['network:localhost']).error, /local or private/);
  assert.match(buildToolUrl(tool('https://api.x.com/a', 'POST'), {}, ['network:api.x.com']).error, /read-only GET/);
  assert.match(buildToolUrl(tool('https://u:p@api.x.com/a'), {}, ['network:api.x.com']).error, /Credentials/);
});

test('plugin runner returns capped data, blocks redirects, and plans at most one tool', async () => {
  const [findPlace] = weather.tools;
  const ok = await runPluginTool(findPlace, { name: 'Chicago' }, weather.permissions,
    async () => new Response('{"results":[{"latitude":41.8}]}', { status: 200 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.data.results[0].latitude, 41.8);
  const redirect = await runPluginTool(findPlace, { name: 'x' }, weather.permissions,
    async () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } }));
  assert.match(redirect.error, /redirect/);

  const tools = weather.tools.map((t) => ({ ...t, plugin: 'weather', permissions: weather.permissions }));
  const env = { AI: { run: async () => ({ response: 'Sure: {"plugin":"weather","tool":"find_place","params":{"name":"Chicago"}}' }) } };
  const choice = await planPluginCall(env, 'm', 'weather in chicago', tools);
  assert.equal(choice.tool.name, 'find_place');
  assert.deepEqual(choice.params, { name: 'Chicago' });
  const none = await planPluginCall({ AI: { run: async () => ({ response: 'NONE' }) } }, 'm', 'hi', tools);
  assert.equal(none, null);
});

test('self-update reads broadly but writes only owner-approved source lanes', () => {
  for (const path of [
    'lib/a/b.dart',
    'test/a_test.dart',
    'integration_test/flow_test.dart',
    'server/cloudflare/code_scout.js',
    'server/cloudflare/code_scout.test.mjs',
    'assets/office3d/office.html',
    'web/index.html',
    'docs/SELF_UPDATE.md',
    'ios/Runner/AppDelegate.swift',
    'android/app/src/main/kotlin/com/example/MainActivity.kt',
  ]) {
    assert.equal(isSelfUpdateEditablePath(path), true, path);
    assert.ok(validateUpdateFiles([{ path, content: path.endsWith('.dart') ? 'void main() {}' : 'x' }]).files, path);
  }
  for (const path of ['pubspec.yaml', 'ios/Runner/Info.plist', '.github/workflows/x.yml']) {
    assert.equal(isSelfUpdateReadablePath(path), true, path);
    assert.equal(isSelfUpdateEditablePath(path), false, path);
    assert.ok(validateUpdateFiles([{ path, content: 'x' }]).error, path);
  }
  for (const path of ['lib/../x.dart', 'lib/a.js', '.env', 'keys/private.pem']) {
    assert.equal(isSelfUpdateEditablePath(path), false, path);
  }
  assert.ok(validateUpdateFiles([]).error);
  assert.ok(validateUpdateFiles([{ path: 'lib/a.dart' }]).error);
  assert.equal(classifyUpdate(['lib/a.dart']).delivery, 'shorebird_patch');
  assert.equal(classifyUpdate(['server/cloudflare/a.js']).delivery, 'worker_deploy');
  assert.equal(classifyUpdate(['lib/a.dart', 'server/cloudflare/a.js']).delivery, 'worker_and_shorebird');
  assert.equal(classifyUpdate(['assets/office3d/office.html']).delivery, 'full_rebuild');
  assert.equal(classifyUpdate(['test/a_test.dart', 'docs/a.md']).delivery, 'source_only');
});

test('self-update rejects secrets, native smuggling and oversized slices', () => {
  assert.match(scanUpdateContent('const k = "sk_live_abcdefghijklmnopqrstuvwxyz";', 'lib/a.dart') || '', /secret/);
  assert.match(scanUpdateContent('<?xml version="1.0"?><plist><dict></dict></plist>', 'lib/a.dart') || '', /native|entitlement|Info/);
  assert.ok(validateUpdateFiles([{ path: 'lib/a.dart', content: 'STRIPE_SECRET_KEY=sk_test_abcdefghijklmnopqrst' }]).error);
  assert.ok(validateUpdateFiles([{ path: 'lib/a.dart', content: '<?xml version="1.0"?><plist><dict></dict></plist>' }]).error);
  const many = Array.from({ length: 13 }, (_, i) => ({ path: `lib/f${i}.dart`, content: 'void main() {}' }));
  assert.match(validateUpdateFiles(many).error || '', /at most 12/);
});

function fakeGitHub() {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = url.replace('https://api.github.com/repos/o/r', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (method === 'GET' && path === '') return reply({ default_branch: 'main', permissions: { pull: true, push: true } });
    if (method === 'GET' && path.startsWith('/git/ref/heads/che')) return reply({ message: 'Not Found' }, 404);
    if (method === 'GET' && path.startsWith('/git/ref/heads/')) return reply({ object: { sha: 'base123' } });
    if (method === 'POST' && path === '/git/refs') return reply({ ref: body.ref, object: { sha: body.sha } }, 201);
    if (method === 'GET' && path === '/git/commits/base123') return reply({ sha: 'base123', tree: { sha: 'tree-base' } });
    if (method === 'POST' && path === '/git/trees') return reply({ sha: 'tree-new' }, 201);
    if (method === 'POST' && path === '/git/commits') return reply({ sha: 'commit-new' }, 201);
    if (method === 'GET' && path.startsWith('/contents/lib/existing.dart?ref=base123')) {
      return reply({ sha: 's1', content: Buffer.from('old code ✓').toString('base64') });
    }
    if (method === 'GET' && path.startsWith('/contents/lib/existing.dart?ref=base9')) {
      return reply({ sha: 's-old', content: Buffer.from('old code ✓').toString('base64') });
    }
    if (method === 'GET' && path.startsWith('/contents/lib/existing.dart')) return reply({ sha: 's1' });
    if (method === 'GET' && path.startsWith('/contents/lib/new.dart?ref=che%2Frollback-')) return reply({ sha: 's-new' });
    if (method === 'GET' && path.startsWith('/contents/')) return reply({ message: 'Not Found' }, 404);
    if (method === 'PUT' && path.startsWith('/contents/')) return reply({ commit: { sha: `commit-${calls.length}` } }, 201);
    if (method === 'DELETE' && path.startsWith('/contents/')) return reply({}, 200);
    if (method === 'POST' && path === '/pulls') return reply({ number: 7, html_url: 'https://github.com/o/r/pull/7', head: { sha: 'pr-head' } }, 201);
    if (method === 'GET' && path.startsWith('/pulls?state=closed')) {
      return reply([{ number: 5, merged_at: '2026-01-01', head: { ref: 'che/update-abc' }, base: { sha: 'base9' } }]);
    }
    if (method === 'GET' && path.startsWith('/pulls/5/files')) {
      return reply([{ filename: 'lib/existing.dart', status: 'modified' }, { filename: 'lib/new.dart', status: 'added' }]);
    }
    return reply({ message: `unexpected ${method} ${path}` }, 500);
  };
  return { calls, fetcher };
}

test('self-update opens a PR on a new branch and never touches main', async () => {
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
  assert.equal((await openSelfUpdatePr({}, { summary: 'x', files: [] })).status, 503);
  const { calls, fetcher } = fakeGitHub();
  const result = await openSelfUpdatePr(env, {
    summary: 'Add a settings toggle',
    files: [{ path: 'lib/existing.dart', content: 'new ✓' }, { path: 'lib/new.dart', content: 'x' }],
  }, fetcher);
  assert.equal(result.status, 200, result.detail);
  assert.equal(result.number, 7);
  assert.equal(result.delivery, 'shorebird_patch');
  assert.equal(result.commit_sha, 'pr-head');
  assert.equal(result.base, 'main');
  assert.match(result.branch, /^che\/update-/);
  // One atomic commit on top of the verified base; no per-file writes.
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  const tree = calls.find((c) => c.method === 'POST' && c.path === '/git/trees');
  assert.equal(tree.body.base_tree, 'tree-base');
  assert.deepEqual(tree.body.tree.map((item) => item.path), ['lib/existing.dart', 'lib/new.dart']);
  assert.equal(tree.body.tree[0].content, 'new ✓');
  const commit = calls.find((c) => c.method === 'POST' && c.path === '/git/commits');
  assert.deepEqual(commit.body.parents, ['base123']);
  const ref = calls.find((c) => c.method === 'POST' && c.path === '/git/refs');
  assert.equal(ref.body.ref, `refs/heads/${result.branch}`);
  assert.equal(ref.body.sha, 'commit-new');
  assert.ok(!calls.some((c) => c.body?.branch === 'main' || c.body?.ref === 'refs/heads/main'));
  const pr = calls.find((c) => c.method === 'POST' && c.path === '/pulls');
  assert.equal(pr.body.base, 'main');
  assert.equal(pr.body.head, result.branch);
  assert.equal(pr.body.draft, true);
});

test('GitHub self-update access reports the real configured repository', async () => {
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
  const ok = await selfUpdateGitHubAccess(env, async () =>
    new Response(JSON.stringify({ default_branch: 'main', permissions: { pull: true, push: true } }), { status: 200 }));
  assert.equal(ok.status, 200);
  assert.equal(ok.connected, true);
  assert.equal(ok.repository, 'o/r');
  assert.equal(ok.can_push_reported, true);

  const denied = await selfUpdateGitHubAccess(env, async () =>
    new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 }));
  assert.equal(denied.status, 403);
  assert.match(denied.detail, /Resource not accessible/);
});

test('rollback is a real revert of only the last CHE update', async () => {
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/pulls?state=closed')) {
      return new Response(JSON.stringify([
        { number: 6, merged_at: '2026-01-02', head: { ref: 'feature/other' }, node_id: 'PR_other' },
        { number: 5, merged_at: '2026-01-01', head: { ref: 'che/update-abc' }, node_id: 'PR_5' },
      ]));
    }
    if (url === 'https://api.github.com/graphql') {
      return new Response(JSON.stringify({ data: { revertPullRequest: { revertPullRequest: { number: 9, url: 'https://github.com/o/r/pull/9' } } } }));
    }
    return new Response('{}', { status: 500 });
  };
  const result = await rollbackLastUpdate(env, fetcher);
  assert.equal(result.status, 200);
  assert.equal(result.rolls_back, 5);
  assert.equal(result.number, 9);
  const mutation = calls.find((c) => c.url.endsWith('/graphql')).body;
  assert.match(mutation.query, /revertPullRequest/);
  assert.equal(mutation.variables.id, 'PR_5');
  // No file contents are ever written directly.
  assert.ok(!calls.some((c) => c.url.includes('/contents/')));

  const conflicted = await rollbackLastUpdate(env, async (url) => (url.endsWith('/graphql')
    ? new Response(JSON.stringify({ errors: [{ message: 'merge conflict' }] }))
    : fetcher(url)));
  assert.equal(conflicted.status, 409);
  assert.match(conflicted.detail, /merge conflict/);
});

test('plugin responses are capped while streaming', async () => {
  const [findPlace] = weather.tools;
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(4096).fill(65)); },
    cancel() { cancelled = true; },
  });
  const result = await runPluginTool(findPlace, { name: 'x' }, weather.permissions,
    async () => new Response(endless, { status: 200 }));
  assert.equal(result.data.length, 12000);
  assert.ok(cancelled, 'stream cancelled at the cap');
  assert.ok(pulled < 10);
});

test('markets parse delayed candles and label unavailable data honestly', async () => {
  const csv = 'Date,Open,High,Low,Close,Volume\n2026-09-24,10,12,9,11,1\n2026-09-25,11,13,10,12.1,1\n';
  assert.equal(parseStooqCsv(csv).length, 2);
  assert.deepEqual(parseStooqCsv('No data'), []);
  const fetcher = async (url) => {
    if (url.includes('stooq')) return new Response(csv, { status: 200 });
    if (url.includes('coingecko')) return new Response('{"bitcoin":{"usd":65000,"usd_24h_change":1.5}}', { status: 200 });
    return new Response('', { status: 500 });
  };
  const snap = await snapshot({}, fetcher);
  const spx = snap.quotes.find((q) => q.symbol === '^spx');
  assert.equal(spx.status, 'delayed');
  assert.equal(spx.price, 12.1);
  assert.ok(Math.abs(spx.change_pct - 10) < 1e-9);
  assert.equal(snap.quotes.find((q) => q.symbol === 'BTC').status, 'live');
  assert.equal(snap.quotes.find((q) => q.symbol === 'ETH').status, 'unavailable');
  assert.equal(snap.live, false);
});

import { deleteMedia, generateImage, listMedia, readBlob, upscaleImage } from './media.js';

function memStorage() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    raw: m,
  };
}

test('broker account snapshot is read-only and never invents a balance', async () => {
  const disconnected = await accountSnapshot({}, async () => { throw new Error('should not fetch'); });
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.live, false);
  assert.equal(disconnected.balance, undefined);

  let sent;
  const live = await accountSnapshot(
    { CHE_BROKER_URL: 'https://broker.example/api', CHE_BROKER_TOKEN: 'secret' },
    async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({
        account: {
          account_name: 'Funded',
          currency: 'USD',
          balance: 25123.45,
          equity: 25200,
          buying_power: 50100,
        },
      }), { status: 200 });
    },
  );
  assert.deepEqual(sent, { tool: 'account_snapshot', mode: 'read_only' });
  assert.equal(live.connected, true);
  assert.equal(live.live, true);
  assert.equal(live.balance, 25123.45);
  assert.equal(live.equity, 25200);
  assert.equal(live.buying_power, 50100);
});

test('art studio: real images with versions, draft opt-in, honest upscaling', async () => {
  const storage = memStorage();
  const calls = [];
  const env = {
    AI: { run: async (model, input) => { calls.push({ model, input }); return { image: Buffer.from('JPEGDATA').toString('base64') }; } },
  };
  const made = await generateImage(env, storage, { prompt: 'A neon studio at night' });
  assert.equal(made.status, 200);
  assert.equal(calls[0].model, '@cf/black-forest-labs/flux-1-schnell');
  assert.equal(calls[0].input.steps, 8, 'highest quality by default');
  assert.equal(made.item.version, 1);
  assert.equal(Buffer.from(await readBlob(env, storage, made.item)).toString(), 'JPEGDATA');

  const variation = await generateImage(env, storage, { mode: 'variation', parent_id: made.item.id });
  assert.equal(variation.item.root_id, made.item.id);
  assert.equal(variation.item.version, 2);
  assert.match(variation.item.prompt, /Fresh variation/);
  const refine = await generateImage(env, storage, { mode: 'refine', parent_id: variation.item.id, prompt: 'warmer light', draft: true });
  assert.equal(refine.item.version, 3);
  assert.equal(calls[2].input.steps, 4, 'draft only when asked');
  assert.equal((await listMedia(storage)).length, 3);

  assert.equal((await generateImage(env, storage, { prompt: '' })).status, 400);
  assert.equal((await generateImage(env, storage, { mode: 'variation', parent_id: 'nope' })).status, 404);
  assert.equal((await generateImage({}, storage, { prompt: 'x' })).status, 503);

  const up = await upscaleImage(env, storage, made.item.id);
  assert.equal(up.status, 409);
  assert.match(up.detail, /CHE_UPSCALE_URL/);
  const upEnv = { ...env, CHE_UPSCALE_URL: 'https://up.example/x' };
  const upscaled = await upscaleImage(upEnv, storage, made.item.id,
    undefined, async () => new Response('{"url":"https://cdn.example/big.jpg"}', { status: 200 }));
  assert.equal(upscaled.item.mode, 'upscale');
  assert.equal(upscaled.item.url, 'https://cdn.example/big.jpg');
  assert.equal(upscaled.item.version, 4);

  assert.equal((await deleteMedia(env, storage, made.item.id)).status, 200);
  assert.ok(!storage.raw.has(`media:${made.item.id}`));
});

test('art studio prefers the owner image connector', async () => {
  const storage = memStorage();
  const env = { CHE_IMAGE_GEN_URL: 'https://img.example/gen', AI: { run: async () => { throw new Error('should not run'); } } };
  const made = await generateImage(env, storage, { prompt: 'logo' },
    async () => new Response('{"url":"https://img.example/out.png"}', { status: 200 }));
  assert.equal(made.item.url, 'https://img.example/out.png');
  assert.equal(made.item.engine, 'Your image connector');
});

import { resetRouterForTests, routeText, routedEnv, routerProviderIds } from './ai_router.js';

test('AI router falls through free engines when Cloudflare quota is used up', async () => {
  resetRouterForTests();
  let cfCalls = 0;
  const env = {
    AI: { run: async () => { cfCalls += 1; throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); } },
    GROQ_API_KEY: 'g',
    GEMINI_API_KEY: 'm',
  };
  const hits = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    hits.push({ url, model: body.model, auth: init.headers.Authorization });
    if (url.includes('groq')) return new Response('{"error":{"message":"rate limit"}}', { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'From Gemini.' } }] }), { status: 200 });
  };
  const input = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 };
  const first = await routeText(env, '@cf/meta/llama-3.2-3b-instruct', input, fetcher);
  assert.equal(first.response, 'From Gemini.');
  assert.equal(first.engine, 'gemini');
  assert.equal(hits[0].model, 'openai/gpt-oss-20b');
  assert.equal(hits[0].auth, 'Bearer g');
  assert.deepEqual(
    hits.map((h) => new URL(h.url).hostname),
    ['api.groq.com', 'api.groq.com', 'generativelanguage.googleapis.com'],
    'Groq retries once with its fast model, then Gemini is attempted',
  );
  assert.equal(hits[1].model, 'openai/gpt-oss-20b');

  // Cloudflare is skipped for the rest of the day; Groq rests after its 429.
  hits.length = 0;
  const second = await routeText(env, '@cf/meta/llama-3.1-8b-instruct-fp8', input, fetcher);
  assert.equal(second.response, 'From Gemini.');
  assert.equal(cfCalls, 1);
  // Resting Groq model is skipped; other Groq models (own limits) may be tried, then Gemini answers.
  assert.ok(hits.at(-1).url.includes('generativelanguage.googleapis.com'));
  assert.ok(!hits.some((h) => h.model === 'openai/gpt-oss-120b' || h.model === 'openai/gpt-oss-20b'));
  assert.equal(hits.at(-1).model, 'gemini-3.8-flash');

  // Images never leave Cloudflare; text with no fallback keys explains itself.
  resetRouterForTests();
  const wrapped = routedEnv({ AI: { run: async (m) => ({ image: m }) } });
  assert.deepEqual(await wrapped.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt: 'x' }), { image: '@cf/black-forest-labs/flux-1-schnell' });
  await assert.rejects(
    routeText({ CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { throw new Error('4006 neurons'); } } }, 'm', input, fetcher),
    (error) => error.quota === true
      && error.retryable === true
      && /working free AI provider key/i.test(error.message)
      && !/All AI engines failed/i.test(error.message),
  );

  // Auth-required services must never be treated as anonymous fallbacks.
  resetRouterForTests();
  let anonymousCalls = 0;
  await assert.rejects(
    routeText(
      { AI: { run: async () => { throw new Error('4006 neurons'); } } },
      '@cf/meta/llama-3.2-3b-instruct',
      input,
      async () => {
        anonymousCalls += 1;
        return new Response('{"error":"should not be called"}', { status: 500 });
      },
    ),
    (error) => error.retryable === true
      && /temporarily unavailable|working free AI provider key/i.test(error.message)
      && !/All AI engines failed|pollinations|llm7/i.test(error.message),
  );
  assert.equal(anonymousCalls, 0);
  assert.ok(!routerProviderIds().some((id) => /^pollinations:|^llm7$/.test(id)));

  // Every free-tier key the owner adds joins the rotation in order.
  resetRouterForTests();
  const order = [];
  const allBusy = async (url) => {
    order.push(new URL(url).hostname);
    return new Response('{"error":"busy"}', { status: 429 });
  };
  await assert.rejects(routeText({
    CHE_DISABLE_KEYLESS_AI: '1',
    CEREBRAS_API_KEY: 'c', MISTRAL_API_KEY: 'm', GITHUB_MODELS_TOKEN: 'gh', SAMBANOVA_API_KEY: 's', HF_TOKEN: 'h',
  }, 'm', input, allBusy));
  assert.deepEqual(order, [
    'api.cerebras.ai', 'api.cerebras.ai',
    'api.mistral.ai', 'api.mistral.ai',
    'models.github.ai', 'models.github.ai',
    'api.sambanova.ai', 'api.sambanova.ai',
    'router.huggingface.co', 'router.huggingface.co',
  ]);
});


test('AI router stores daily usage budgets and puts a fast free engine before paid fallback for casual turns', async () => {
  resetRouterForTests();
  const storage = memStorage();
  const calls = [];
  let cfCalls = 0;
  const env = {
    AI: { run: async () => { cfCalls += 1; throw new Error('4006 neurons'); } },
    CHE_ALLOW_PAID_AI: '1', CHE_OPENAI_API_KEY: 'paid',
    GROQ_API_KEY: 'free',
    CHE_GROQ_DAILY_TOKEN_LIMIT: '1000',
  };
  const input = { messages: [{ role: 'user', content: 'hey what\'s up' }], max_tokens: 120 };
  const fetcher = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.includes('groq')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Doing good, sir. What do you need?' } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Paid fallback.' } }],
    }), { status: 200 });
  };

  const first = await routeText(env, '@cf/meta/llama-3.2-3b-instruct', input, fetcher, storage);
  assert.equal(first.engine, 'groq');
  assert.equal(new URL(calls[0].url).hostname, 'api.groq.com');
  const usage = storage.raw.get('ai_usage:groq');
  assert.ok(usage.estimated_tokens >= 9);
  assert.ok(usage.reset_at > Date.now());

  calls.length = 0;
  // Groq is now at 99% of its daily allowance: the next call must move on.
  storage.raw.get('ai_usage:groq').estimated_tokens = 990;
  const second = await routeText(env, '@cf/meta/llama-3.2-3b-instruct', input, fetcher, storage);
  assert.equal(second.engine, 'openai');
  assert.equal(new URL(calls[0].url).hostname, 'api.openai.com');
  assert.equal(cfCalls, 1, 'Cloudflare remains rested after its real quota error');
});


test('AI router compacts old conversation history before provider calls', async () => {
  resetRouterForTests();
  const sent = [];
  const messages = [
    { role: 'system', content: 'Keep answers concise.' },
    ...Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `message-${i} ${'x'.repeat(40)}`,
    })),
  ];
  const input = { messages, max_tokens: 120 };
  const result = await routeText(
    { GROQ_API_KEY: 'g' },
    '@cf/meta/llama-3.2-3b-instruct',
    input,
    async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    },
  );
  assert.equal(result.engine, 'groq');
  const outbound = sent[0].messages;
  assert.equal(outbound[0].role, 'system');
  assert.match(outbound[1].content, /Earlier conversation summary/);
  assert.equal(outbound.length, 12, 'system + one summary + last 10 conversation messages');
  assert.equal(outbound.at(-1).content.startsWith('message-13'), true);
  assert.ok(JSON.stringify(outbound).length < JSON.stringify(messages).length);
});


test('image relay falls from FLUX to Gemini and keeps the returned MIME type', async () => {
  const storage = memStorage(); const calls = [];
  const result = await generateImage({ GEMINI_API_KEY: 'key', CHE_ALLOW_PAID_MEDIA: '1', CHE_ALLOW_PAID_AI: '1', AI: {run: async () => {calls.push('flux'); throw new Error('quota');}} }, storage, {prompt:'A tree'}, async (url, init) => {
    calls.push('gemini');
    assert.equal(init.headers['x-goog-api-key'], 'key');
    return Response.json({candidates:[{content:{parts:[{inlineData:{data:'YQ==',mimeType:'image/png'}}]}}]});
  });
  assert.deepEqual(calls, ['flux', 'gemini']);
  assert.equal(result.status, 200); assert.equal(result.item.mime_type, 'image/png');
  assert.equal(result.item.engine, 'gemini-image');
});

test('secret scan is baseline-relative and ignores obvious test fixtures', () => {
  const fixture = "const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };\n";
  assert.equal(scanUpdateContent(fixture, 'server/cloudflare/worker.test.mjs'), null, 'a one-letter fixture is not a secret');
  assert.match(scanUpdateContent("CHE_GITHUB_TOKEN = 'ghx_abcdefghijklmnopqrstuvwx'", 'a.js') || '', /secret/);
  const existing = 'const k = "sk_live_abcdefghijklmnopqrstuvwxyz";\n';
  assert.equal(scanUpdateContent(`${existing}// new line\n`, 'a.js', existing), null, 'a pre-existing string is not the edit\'s doing');
  assert.match(scanUpdateContent(`${existing}const k2 = "sk_live_zzzzzzzzzzzzzzzzzzzzzz";\n`, 'a.js', existing) || '', /secret/, 'a new secret is still refused');
  assert.match(scanUpdateContent(`${existing}console.log("sk_live_abcdefghijklmnopqrstuvwxyz");\n`, 'a.js', existing) || '', /secret/, 'a second copy of an existing secret is refused');
});
