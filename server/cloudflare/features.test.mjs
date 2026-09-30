import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToolUrl, planPluginCall, pluginManifests, runPluginTool } from './plugin_runtime.js';
import { classifyUpdate, openSelfUpdatePr, rollbackLastUpdate, scanUpdateContent, validateUpdateFiles } from './self_update.js';
import { parseStooqCsv, snapshot } from './markets.js';

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

test('self-update accepts only complete Dart files under lib/', () => {
  assert.ok(validateUpdateFiles([{ path: 'lib/a/b.dart', content: 'x' }]).files);
  for (const path of ['pubspec.yaml', 'ios/Runner/Info.plist', 'lib/../x.dart', 'lib/a.js', '.github/workflows/x.yml']) {
    assert.ok(validateUpdateFiles([{ path, content: 'x' }]).error, path);
  }
  assert.ok(validateUpdateFiles([]).error);
  assert.ok(validateUpdateFiles([{ path: 'lib/a.dart' }]).error);
  assert.equal(classifyUpdate(['lib/a.dart']).delivery, 'shorebird_patch');
  assert.equal(classifyUpdate(['ios/Podfile']).delivery, 'full_rebuild');
});

test('self-update rejects secrets, native smuggling and oversized slices', () => {
  assert.match(scanUpdateContent('const k = "sk_live_abcdefghijklmnopqrstuvwxyz";', 'lib/a.dart') || '', /secret/);
  assert.match(scanUpdateContent('<?xml version="1.0"?><plist><dict></dict></plist>', 'lib/a.dart') || '', /native|entitlement|Info/);
  assert.ok(validateUpdateFiles([{ path: 'lib/a.dart', content: 'STRIPE_SECRET_KEY=sk_test_abcdefghijklmnopqrst' }]).error);
  assert.ok(validateUpdateFiles([{ path: 'lib/a.dart', content: '<?xml version="1.0"?><plist><dict></dict></plist>' }]).error);
  const many = Array.from({ length: 7 }, (_, i) => ({ path: `lib/f${i}.dart`, content: 'x' }));
  assert.match(validateUpdateFiles(many).error || '', /at most 6/);
});

function fakeGitHub() {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = url.replace('https://api.github.com/repos/o/r', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (method === 'GET' && path === '') return reply({ default_branch: 'main' });
    if (method === 'GET' && path.startsWith('/git/ref/heads/')) return reply({ object: { sha: 'base123' } });
    if (method === 'POST' && path === '/git/refs') return reply({}, 201);
    if (method === 'GET' && path.startsWith('/contents/lib/existing.dart?ref=base9')) {
      return reply({ sha: 's-old', content: Buffer.from('old code ✓').toString('base64') });
    }
    if (method === 'GET' && path.startsWith('/contents/lib/existing.dart')) return reply({ sha: 's1' });
    if (method === 'GET' && path.startsWith('/contents/lib/new.dart?ref=che%2Frollback-')) return reply({ sha: 's-new' });
    if (method === 'GET' && path.startsWith('/contents/')) return reply({ message: 'Not Found' }, 404);
    if (method === 'PUT' && path.startsWith('/contents/')) return reply({}, 201);
    if (method === 'DELETE' && path.startsWith('/contents/')) return reply({}, 200);
    if (method === 'POST' && path === '/pulls') return reply({ number: 7, html_url: 'https://github.com/o/r/pull/7' }, 201);
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
  assert.equal(result.status, 200);
  assert.equal(result.number, 7);
  assert.equal(result.delivery, 'shorebird_patch');
  assert.match(result.branch, /^che\/update-/);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.ok(puts.every((c) => c.body.branch === result.branch));
  assert.equal(puts[0].body.sha, 's1');
  assert.equal(Buffer.from(puts[0].body.content, 'base64').toString(), 'new ✓');
  assert.ok(!calls.some((c) => c.body?.branch === 'main'));
  const pr = calls.find((c) => c.method === 'POST' && c.path === '/pulls');
  assert.equal(pr.body.base, 'main');
  assert.equal(pr.body.head, result.branch);
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

import { resetRouterForTests, routeText, routedEnv } from './ai_router.js';

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
  assert.deepEqual(hits.map((h) => h.url.includes('generativelanguage.googleapis.com')), [true]);
  assert.equal(hits[0].model, 'gemini-3.8-flash');

  // Images never leave Cloudflare; text with no fallback keys explains itself.
  resetRouterForTests();
  const wrapped = routedEnv({ AI: { run: async (m) => ({ image: m }) } });
  assert.deepEqual(await wrapped.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt: 'x' }), { image: '@cf/black-forest-labs/flux-1-schnell' });
  await assert.rejects(
    routeText({ CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { throw new Error('4006 neurons'); } } }, 'm', input, fetcher),
    (error) => error.quota === true && /GROQ_API_KEY/.test(error.message),
  );

  // With zero keys, the keyless engine still answers (no Authorization sent).
  resetRouterForTests();
  const keyless = [];
  const answer = await routeText(
    { AI: { run: async () => { throw new Error('4006 neurons'); } } },
    '@cf/meta/llama-3.2-3b-instruct',
    input,
    async (url, init) => {
      keyless.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Keyless hello.' } }] }), { status: 200 });
    },
  );
  assert.equal(answer.response, 'Keyless hello.');
  assert.equal(answer.engine, 'pollinations:openai');
  assert.equal(keyless[0].url, 'https://text.pollinations.ai/openai');
  assert.equal(keyless[0].headers.Authorization, undefined);
  assert.equal(keyless[0].body.model, 'openai');

  // A busy keyless model is skipped for the next message; the next model answers.
  resetRouterForTests();
  const models = [];
  const rotating = async (url, init) => {
    const model = JSON.parse(init.body).model;
    models.push(model);
    if (model === 'openai') return new Response('{"error":"busy"}', { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: `from ${model}` } }] }), { status: 200 });
  };
  const noCf = { AI: { run: async () => { throw new Error('4006 neurons'); } } };
  assert.equal((await routeText(noCf, 'm', input, rotating)).response, 'from mistral');
  assert.equal((await routeText(noCf, 'm', input, rotating)).response, 'from mistral');
  assert.deepEqual(models, ['openai', 'openai', 'mistral', 'mistral'], '429 retries once, then rested model is not retried right away');

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
    CHE_GROQ_DAILY_TOKEN_LIMIT: '10',
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
  const result = await generateImage({ GEMINI_API_KEY: 'key', AI: {run: async () => {calls.push('flux'); throw new Error('quota');}} }, storage, {prompt:'A tree'}, async (url, init) => {
    calls.push('gemini');
    assert.equal(init.headers['x-goog-api-key'], 'key');
    return Response.json({candidates:[{content:{parts:[{inlineData:{data:'YQ==',mimeType:'image/png'}}]}}]});
  });
  assert.deepEqual(calls, ['flux', 'gemini']);
  assert.equal(result.status, 200); assert.equal(result.item.mime_type, 'image/png');
  assert.equal(result.item.engine, 'gemini-image');
});
