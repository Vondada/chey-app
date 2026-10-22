// CHE's tone and reply provenance through /api/chat (owner, 2026-10-22). A live reply read: "I'm using Soul v1 (4898af92).
// The Soul version used to shape this response is indeed the one I mentioned... The engine that answered your question
// is CHE itself". A fake model cannot show tone, so these tests check what tone is made of: the canonical Soul and its
// style guidance reach every model prompt path (fast, fallback, rescue, voice), provenance comes from routing data
// (never "CHE itself"), and deterministic facts, tool results and receipts stay byte-identical whatever the Soul says.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { guardEngineClaims, guardSoulClaims, loadSoul, replyProvenanceQuestion, saveSoul } from './soul.js';

const generated = new URL('./.soul_tone.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const offline = async (input) => { throw new TypeError(`offline (${new URL(String(input?.url || input)).host})`); };
globalThis.fetch = offline;

const FAST = '@cf/meta/llama-3.2-3b-instruct';
const STRONG = '@cf/meta/llama-3.1-8b-instruct-fp8';
const OWNER_REPORT = "I'm using Soul v1 (4898af92). The Soul version used to shape this response is indeed the one I mentioned, and it did influence the response. The engine that answered your question is CHE itself, with no other agents involved in this conversation.";

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A paired owner phone. `model(name, input)` is the fake engine; every call is recorded with the model asked for and
// the system prompt it received.
async function owner({ saved = new Map(), model = () => 'Sure thing, sir.', extraEnv = {} } = {}) {
  const calls = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extraEnv,
    AI: { run: async (name, input) => {
      calls.push({ model: name, system: String(input?.messages?.[0]?.content || '') });
      return { response: model(name, input) };
    } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, extra = {}) => {
    const before = calls.length;
    const raw = await (await send('/api/chat', { message, history: [], ...extra }, token)).text();
    const items = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = items.find((i) => i.type === 'done') || {};
    const reply = items.filter((i) => i.type === 'delta').map((i) => i.delta).join('') || done.message || '';
    return { reply, meta: done, steps: items.filter((i) => i.type === 'step').map((i) => i.text), calls: calls.slice(before) };
  };
  return { say, send, token, saved, calls, env };
}

// What every model prompt that writes an owner-facing reply must carry.
function assertSoulPrompt(system, version = 0) {
  assert.match(system, new RegExp(`SOUL v${version} \\([0-9a-f]{8}\\)`), 'the canonical Soul block');
  assert.match(system, /calls the owner "sir" naturally, not in every sentence/);
  assert.match(system, /not a help desk and not a compliance report/, 'style guidance against report-like phrasing');
  assert.match(system, /Say each thing once/, 'style guidance against repetition');
  assert.match(system, /reuse the same opener, closer or offer/);
  assert.match(system, /never a forced joke or slang/);
  assert.match(system, /Tone never changes a fact, number, quoted tool result, receipt, permission or a money\/delete hold/);
}

async function plantMemory(saved) {
  const data = saved.get('che') || {};
  data.memory_records = [...(data.memory_records || []), {
    id: 'food', text: 'My favorite food is pizza', source: 'owner_chat', verification_status: 'owner_attested', active: true, created_at: '2026-10-20T15:00:00.000Z',
  }];
  saved.set('che', data);
}

test('1. a casual factual question: the model prompt carries the Soul and its style guidance; the engine is named from routing', async () => {
  const che = await owner({ model: () => 'Canberra, sir. Most people guess Sydney.' });
  const out = await che.say("What's the capital of Australia?");
  assert.equal(out.calls.length, 1);
  assertSoulPrompt(out.calls[0].system);
  assert.equal(out.reply, 'Canberra, sir. Most people guess Sydney.', 'an ordinary reply is not rewritten');
  assert.equal(out.meta.soul.soul_applied, true);
  assert.equal(out.meta.served_by.provider, 'cloudflare', 'the provider the router really used');
  assert.equal(out.meta.served_by.model, FAST);
  assert.equal(out.meta.served_by.fallback, false);
  // The old prompt told the model to end every answer with an offer: the same "Want me to…?" every time.
  assert.doesNotMatch(out.calls[0].system, /end with ONE short offer of the single best next step/);
  assert.match(out.calls[0].system, /never repeat the offer from your last reply/);
  assert.match(out.calls[0].system, /never say the engine or model was "CHE itself"/);
});

test('2. a personality question reaches the model with the Soul; the owner\'s reported reply is corrected, not repeated', async () => {
  const che = await owner({ model: () => OWNER_REPORT });
  const out = await che.say("What's your personality? Who are you?");
  assert.equal(out.calls.length, 1);
  assertSoulPrompt(out.calls[0].system);
  assert.doesNotMatch(out.reply, /CHE itself/);
  assert.doesNotMatch(out.reply, /4898af92|Soul v1\b/, 'a Soul version the model invented is corrected to the real one');
  assert.match(out.reply, new RegExp(`Soul v0 \\(${out.meta.soul.hash}\\)`));
  assert.match(out.reply, /This reply came from Cloudflare Workers AI, model @cf\/meta\//);
  assert.match(out.reply, new RegExp(out.meta.served_by.model.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
});

test('3. a repo status question is answered by the verified-status handler: no model, facts identical under any Soul', async () => {
  const saved = new Map();
  const che = await owner({ saved });
  const before = await che.say("What's the status of the repo?");
  assert.equal(before.calls.length, 0, 'no model call');
  assert.equal(before.meta.source, 'che_verified_status');
  await saveSoul(storageFor(saved), { traits: { playfulness: 10, warmth: 10, formality: 0 } });
  const after = await che.say("What's the status of the repo?");
  assert.equal(after.calls.length, 0);
  assert.equal(after.reply, before.reply, 'the Soul never rewrites a deterministic status');
  assert.equal(after.meta.soul.soul_applied, false);
  assert.equal(after.meta.soul.version, 1);
});

test('4. memory recall: the owner\'s own fact and its date come back byte-identical, with no model, under any Soul', async () => {
  const saved = new Map();
  const che = await owner({ saved });
  await plantMemory(saved);
  const before = await che.say("What's my favorite food?");
  assert.equal(before.calls.length, 0);
  assert.match(before.reply, /pizza/);
  assert.match(before.reply, /October 20, 2026/);
  await saveSoul(storageFor(saved), { traits: { playfulness: 10, verbosity: 10 }, text: 'Be extra playful.' });
  const after = await che.say("What's my favorite food?");
  assert.equal(after.reply, before.reply);
  assert.equal(after.calls.length, 0);
});

test('5. a fallback model answers: the Soul reaches the fallback prompt too, and provenance names the fallback', async () => {
  const che = await owner({ model: (name) => {
    if (name === FAST) throw Object.assign(new Error('fast engine down'), { status: 500 });
    return 'Paris, sir.';
  } });
  const out = await che.say("What's the capital of France?");
  assert.equal(out.reply, 'Paris, sir.');
  const tried = out.calls.map((c) => c.model);
  assert.ok(tried.includes(FAST) && tried.includes(STRONG), `both engines were tried: ${tried.join(', ')}`);
  for (const call of out.calls) assertSoulPrompt(call.system);
  assert.equal(out.meta.served_by.model, STRONG);
  assert.equal(out.meta.served_by.provider, 'cloudflare');
  assert.equal(out.meta.served_by.fallback, true);
  assert.equal(out.meta.soul.soul_applied, true);

  const asked = await che.say('Which engine answered that, and which Soul shaped it?');
  assert.equal(asked.calls.length, 0, 'provenance comes from the routing record, not a model');
  assert.equal(asked.meta.source, 'che_reply_provenance');
  assert.equal(asked.meta.engine, 'no model (deterministic)');
  assert.doesNotMatch(asked.reply, /CHE itself/);
  assert.match(asked.reply, new RegExp(`Cloudflare Workers AI, model ${STRONG.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}, a fallback`));
  assert.match(asked.reply, new RegExp(`Soul v0 \\(${out.meta.soul.hash}\\) was in its prompt`));
});

test('5b. the rescue model (both chat engines busy) gets the same Soul prompt and is named as a fallback', async () => {
  let n = 0;
  const che = await owner({ model: () => {
    n += 1;
    if (n <= 2) throw Object.assign(new Error('engine busy 503'), { status: 503 });
    return 'Still here, sir.';
  } });
  const out = await che.say('Tell me something nice.');
  assert.equal(out.reply, 'Still here, sir.');
  assert.equal(out.calls.length, 3, 'fast, strong, then the rescue call');
  for (const call of out.calls) assertSoulPrompt(call.system);
  assert.equal(out.meta.served_by.route, 'rescue');
  assert.equal(out.meta.served_by.provider, 'cloudflare');
  assert.equal(out.meta.served_by.fallback, true);
  assert.equal(out.meta.soul.soul_applied, true);
});

test('6. a deterministic handler keeps its facts, makes no model call, and provenance says "no model (deterministic)"', async () => {
  const che = await owner();
  const first = await che.say('/status');
  assert.equal(first.calls.length, 0);
  assert.equal(first.meta.soul.soul_applied, false);
  const asked = await che.say('What model answered that?');
  assert.equal(asked.calls.length, 0);
  assert.match(asked.reply, /one of my own handlers \(che_command\): no model \(deterministic\)/);
  assert.doesNotMatch(asked.reply, /CHE itself/);
  // Before any reply there is no record, and CHE says so instead of guessing.
  const fresh = await owner();
  const none = await fresh.say('Which engine answered that?');
  assert.match(none.reply, /don't have a routing record/);
  assert.equal(none.calls.length, 0);
});

test('7. tool results and receipts are presented byte-identical, whatever the Soul says', async () => {
  const SHA = 'a27d319b0f684781eb2669f482e6d3fd1457d4e8';
  const HEAD = '87079b30521dde3a42355a3dac2c107974809959';
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    if (url.includes('/pulls/356')) return new Response(JSON.stringify({ number: 356, merged: true, state: 'closed', head: { sha: HEAD }, merge_commit_sha: SHA, html_url: 'https://github.com/Vondada/chey-app/pull/356' }));
    if (url.includes('/check-runs')) return new Response(JSON.stringify({ check_runs: [] }));
    return new Response('{}', { status: 503 });
  };
  try {
    const saved = new Map();
    const che = await owner({ saved, extraEnv: { CHE_GITHUB_TOKEN: 'fixture-not-secret', CHE_GITHUB_REPO: 'Vondada/chey-app' } });
    const before = await che.say('Can you check PR #356?');
    assert.equal(before.calls.length, 0);
    assert.equal(before.meta.source, 'che_github_verification');
    assert.ok(before.reply.includes(SHA), 'the merge commit is quoted exactly');
    assert.equal(before.meta.execution_receipts[0].verified_response.number, 356);
    await saveSoul(storageFor(saved), { traits: { warmth: 10, playfulness: 10, formality: 0, verbosity: 10 }, text: 'Joke around a lot.' });
    const after = await che.say('Can you check PR #356?');
    assert.equal(after.reply, before.reply, 'the receipt text is byte-identical under a different Soul');
    // Everything the receipt says about the result (its per-call ids and times naturally differ).
    const strip = (r) => ({ kind: r.kind, status: r.status, operation: r.operation, source: r.source, error: r.error, verified_response: r.verified_response });
    assert.deepEqual(after.meta.execution_receipts.map(strip), before.meta.execution_receipts.map(strip));
  } finally {
    globalThis.fetch = offline;
  }
});

test('7b. the engine guard changes only the self-engine sentence: numbers and receipts in a model reply are untouched', () => {
  const receipt = 'Receipt rcpt_8f2a: sent 3 emails at 14:05, total $12.40, ID 98-7731.';
  const reply = `Done, sir. ${receipt} The engine that answered is CHE itself.`;
  const out = guardEngineClaims(reply, { provider: 'groq', model: 'llama-3.3-70b-versatile', fallback: true });
  assert.ok(out.text.includes(receipt), 'receipt byte-identical');
  assert.equal(out.text, `Done, sir. ${receipt} This reply came from Groq, model llama-3.3-70b-versatile.`);
  assert.equal(guardEngineClaims(receipt, { provider: 'groq', model: 'x' }).text, receipt);
  for (const plain of ['CHE itself is a Flutter app with a Worker.', 'The model of the car is a 2019 Civic.', 'I did it myself, sir.', 'I myself generated the image you asked for.', 'The model I trust myself is the one with receipts.']) {
    assert.equal(guardEngineClaims(plain, { provider: 'groq', model: 'x' }).text, plain, plain);
  }
});

test('7c. a Soul version the model states is checked against the real one; other numbers are left alone', async () => {
  const profile = await loadSoul(storageFor(new Map()));
  const { text } = guardSoulClaims('Soul v1 (4898af92) is on. Your balance is $1,204.55 across 3 accounts.', profile);
  assert.match(text, /^Soul v0 \([0-9a-f]{8}\) is on\. Your balance is \$1,204\.55 across 3 accounts\.$/);
  // A real earlier version from the owner's history is a fact, not an error.
  const storage = storageFor(new Map());
  const saved = await saveSoul(storage, { traits: { warmth: 9 } });
  const history = 'Soul v0 was the built-in one; you changed it to Soul v1.';
  assert.equal(guardSoulClaims(history, saved).text, history);
});

test('provenance questions are recognised; advice about models is not', () => {
  for (const ask of ['Which engine answered that?', 'What model answered you just now?', 'Which Soul version shaped that reply, and which engine answered it?', 'What model are you using?', 'Who wrote that answer?']) {
    assert.ok(replyProvenanceQuestion(ask), ask);
  }
  for (const ask of ['What model should I use for coding?', "What's the best engine for images?", 'Which model is better, GPT or Gemini?', 'Explain soul music to me', 'What engine does a Tesla have?', 'Which model answered the most questions in the benchmark?']) {
    assert.equal(replyProvenanceQuestion(ask), null, ask);
  }
});

test('the realtime voice session carries the same canonical Soul as typed chat', async () => {
  const sent = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (url.includes('openai.com')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ value: 'ek_test', client_secret: { value: 'ek_test' } })); }
    throw new TypeError('offline');
  };
  try {
    const che = await owner({ extraEnv: { CHE_OPENAI_API_KEY: 'sk-fixture', CHE_ALLOW_PAID_AI: '1' } });
    await che.send('/api/live/token', { guarded_output: true }, che.token);
    assert.equal(sent.length, 1, 'the session was requested');
    assertSoulPrompt(sent[0].session.instructions);
  } finally {
    globalThis.fetch = offline;
  }
});

test('a guest gets no provenance record and no owner Soul data', async () => {
  const che = await owner();
  const res = await che.send('/api/chat', { message: 'Which engine answered that?', history: [] }, '');
  const raw = await res.text();
  assert.doesNotMatch(raw, /che_reply_provenance|SOUL v/);
});
