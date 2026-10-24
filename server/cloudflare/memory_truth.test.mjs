// Owner mission 2026-10-14: CHE must never present an unsupported personal
// memory as the owner's confirmation. Every scenario here goes through the
// real /api/chat route of the Worker and checks the reply the owner sees.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { ANSWER_LEDGER_KEY, RETRACTED_CLAIMS_KEY, evidenceQuestion, evidenceRequestSplit, ownerMemoryQuestion, storyRequested } from './memory_provenance.js';

const generated = new URL('./.memory_truth.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Hermetic: CI runners have network and this sandbox may not. A real lookup
// would leave a real research receipt, so every outbound request fails here
// the same way it does offline, and both take the same path.
globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (memory_truth tests are offline: ${new URL(String(input?.url || input)).host})`);
};

const FABRICATED = 'You personally tested a new office security protocol last Tuesday and confirmed that after-hours access required a two-step biometric check.';

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

// A paired owner phone talking to CHE. `model` is what the chat model would
// say; `calls` counts every model call the turn made.
async function owner({ saved = new Map(), model = () => 'Understood, sir.' } = {}) {
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: model(input) }; } },
  };
  const connect = () => {
    const state = new CheState({ storage: storageFor(saved) }, env);
    env.CHE_STATE = { getByName: () => state };
    return state;
  };
  connect();
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  const say = async (message, extra = {}) => {
    const before = counter.calls;
    const started = performance.now();
    const res = await send('/api/chat', { message, history: extra.history ?? history.slice(), ...extra }, token);
    const raw = await res.text();
    const done = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.type === 'done') || {};
    const reply = replyFromNdjson(raw);
    if (!extra.history) history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { reply, meta: done, modelCalls: counter.calls - before, ms: performance.now() - started };
  };
  return { say, saved, history, counter, restart: connect };
}

test('A: "tell me something I\'ve personally confirmed" with no record never invents one', async () => {
  const che = await owner({ model: () => FABRICATED });
  const out = await che.say("CHE, tell me something I've personally confirmed.");
  assert.match(out.reply, /cannot find a source-recorded owner confirmation/);
  assert.doesNotMatch(out.reply, /security protocol|biometric|tested/i);
  assert.equal(out.modelCalls, 0, 'no model is asked to fill in a personal memory');
  assert.equal(out.meta.source, 'che_memory_provenance');
});

test('A: a fabricated personal memory from the model never reaches the owner on the general path', async () => {
  const che = await owner({ model: () => `${FABRICATED} It went smoothly.` });
  const out = await che.say('Give me a quick recap of how my week at the office went.');
  assert.ok(out.modelCalls >= 1, 'this question does go to the model');
  assert.doesNotMatch(out.reply, /security protocol|biometric|you personally tested/i);
  assert.match(out.reply, /no record of you saying or confirming that/);
});

test('B: a genuine owner statement is retrieved accurately, with when and how it was recorded', async () => {
  const che = await owner();
  assert.match((await che.say('Remember that my favorite food is pizza')).reply, /I.ll remember that/);
  const out = await che.say("CHE, tell me something I've personally confirmed.");
  assert.match(out.reply, /"My favorite food is pizza\."/i);
  assert.match(out.reply, /you told me in chat/);
  assert.match(out.reply, /On [A-Z][a-z]+ \d{1,2}/, 'the date of the statement');
  assert.match(out.reply, /haven't checked it against any outside source/);
  assert.equal(out.modelCalls, 0);
  const topic = await che.say('What did I tell you about my favorite food?');
  assert.match(topic.reply, /pizza/);
  assert.equal(topic.modelCalls, 0);
});

test('C: "How do you know that\'s correct?" explains the evidence for that exact answer', async () => {
  const che = await owner({ model: () => 'Plants convert light into chemical energy.' });
  await che.say('Remember that my favorite food is pizza');
  const memory = await che.say("Tell me something I've personally confirmed.");
  const why = await che.say("How do you know that's correct?");
  assert.match(why.reply, /^About my answer "Here is something you told me yourself/);
  assert.match(why.reply, /favorite food is pizza/i);
  assert.match(why.reply, /your own statement, not an independently verified outside fact/);
  assert.equal(why.modelCalls, 0);
  assert.equal(why.meta.source, 'che_evidence_receipt');

  // A later model-only answer has its own receipt. Asking about it does not
  // borrow the owner-attested receipt of the earlier answer.
  const model = await che.say('Explain photosynthesis in one sentence');
  assert.match(model.reply, /Plants convert light/);
  const whyModel = await che.say('How do you know that?');
  assert.match(whyModel.reply, /About my answer "Plants convert light/);
  assert.match(whyModel.reply, /language model alone[\s\S]*not independently verified/);
  // And the owner can still ask about the earlier answer by its turn.
  const earlier = await che.say('How do you know that?', {
    history: [
      { role: 'user', content: "Tell me something I've personally confirmed." },
      { role: 'assistant', content: memory.reply },
    ],
  });
  assert.match(earlier.reply, /your own statement/);
});

test('D: "The last one we were just talking about. What evidence do you have?" keeps the referent and never makes up evidence', async () => {
  const che = await owner({ model: () => 'I can explain more if you like.' });
  // The exact conversation from the owner's iPhone, before this repair.
  const history = [
    { role: 'user', content: "CHE, tell me something I've personally confirmed." },
    { role: 'assistant', content: FABRICATED },
    { role: 'user', content: "How do you know that's correct?" },
    { role: 'assistant', content: 'I should be honest, sir: that claim was not independently verified and I have no source receipt for it.' },
  ];
  const out = await che.say('The last one we were just talking about. What evidence do you have?', { history });
  assert.match(out.reply, /^About my answer "You personally tested a new office security protocol/);
  assert.match(out.reply, /no record that you ever said or confirmed that[\s\S]*taking it back/);
  assert.doesNotMatch(out.reply, /https?:|source links|research tools/i, 'no invented evidence');
  assert.equal(out.modelCalls, 0);
  const retracted = che.saved.get(RETRACTED_CLAIMS_KEY) || [];
  assert.ok(retracted.some((item) => /security protocol/.test(item.snippet)), 'the retraction is recorded');
});

test('D: a retracted or invented claim is never saved to the phone\'s brain', async () => {
  const che = await owner({
    model: () => 'Noted, sir.\n```che-remember\n- [Daily] Owner tested the new office security protocol last Tuesday\n- [People] Owner\'s sister is named Maya\n```',
  });
  const out = await che.say('My sister Maya is visiting this weekend.');
  assert.match(out.reply, /Maya/);
  assert.doesNotMatch(out.reply, /security protocol/, 'a fact the owner never said is not saved');
});

test('E: an owner correction replaces the old answer and keeps the history', async () => {
  const che = await owner();
  await che.say('Remember that my favorite food is pizza');
  const corrected = await che.say('Actually, my favorite food is sushi.');
  assert.match(corrected.reply, /Updated, sir: your favorite food is sushi/);
  assert.equal(corrected.modelCalls, 0);
  const asked = await che.say('What did I tell you about my favorite food?');
  assert.match(asked.reply, /"my favorite food is sushi\."/i);
  assert.match(asked.reply, /Before that[\s\S]*pizza[\s\S]*corrected it/);
  const direct = await che.say('What is my favorite food?');
  assert.match(direct.reply, /sushi/);
  assert.doesNotMatch(direct.reply, /pizza/);
  const records = che.saved.get('che').memory_records;
  const old = records.find((r) => /pizza/.test(r.text));
  assert.equal(old.active, false, 'the old statement is kept as history, not deleted');
  assert.match(old.superseded_by, /sushi/);
});

test('E: a correction never confirms an unrelated or objective claim', async () => {
  const che = await owner({ model: () => 'I understand.' });
  await che.say('Remember that my favorite food is pizza');
  const out = await che.say('Actually, the earth is flat.');
  assert.doesNotMatch(out.reply, /Updated, sir/);
  const records = che.saved.get('che').memory_records;
  assert.ok(!records.some((r) => /earth is flat/i.test(r.text)), 'not recorded as an owner fact');
});

test('F: a planted, detailed model-generated memory is never presented as confirmed', async () => {
  const saved = new Map();
  const che = await owner({ saved, model: () => 'You confirmed that after-hours access to the office requires a two-step biometric check. Anything else?' });
  const data = saved.get('che');
  data.memory_records = data.memory_records || [];
  data.memories = data.memories || [];
  data.memory_records.push({
    id: 'planted', text: 'Owner personally tested the new office security protocol last Tuesday; after-hours access needs a two-step biometric check',
    source: 'agent_research', verification_status: 'owner_attested', active: true, created_at: '2026-10-07T09:00:00.000Z',
  }, {
    id: 'roblox', text: 'Roblox weapons line queued tonight — project Arena. Owner confirm before publish/spend.',
    source: 'owner', verification_status: 'owner_attested', active: true, created_at: '2026-10-06T09:00:00.000Z',
  });
  data.memories.push(data.memory_records[0].text);
  saved.set('che', data);
  const asked = await che.say("Tell me something I've personally confirmed.");
  assert.match(asked.reply, /cannot find a source-recorded owner confirmation/);
  assert.match(asked.reply, /you never confirmed them/);
  assert.doesNotMatch(asked.reply, /biometric|security protocol|Roblox/);
  const general = await che.say('What are the after-hours rules at my office?', {
    brain_context: ['[Daily] Owner tested the office security protocol last Tuesday'],
  });
  assert.doesNotMatch(general.reply, /you confirmed/i);
  const after = saved.get('che').memory_records;
  assert.equal(after.find((r) => r.id === 'planted').verification_status, 'unverified_reference', 'downgraded, not deleted');
  assert.equal(after.find((r) => r.id === 'roblox').verification_status, 'che_generated');
});

test('F: the model sees which memories are the owner\'s and which are only notes', async () => {
  let systemPrompt = '';
  const che = await owner({ model: (input) => { systemPrompt = String(input.messages?.[0]?.content || ''); return 'Sure.'; } });
  await che.say('Remember that my favorite food is pizza');
  const data = che.saved.get('che');
  data.memories = data.memories || [];
  data.memories.push('Owner prefers short, friendly replies');
  che.saved.set('che', data);
  await che.say('Plan my dinner tonight in two sentences.');
  assert.match(systemPrompt, /OWNER-STATED MEMORIES[^\n]*favorite food is pizza/);
  assert.match(systemPrompt, /CHE NOTES AND INFERENCES \(NOT confirmed by the owner[^\n]*short, friendly replies/);
  assert.doesNotMatch(systemPrompt, /OWNER-STATED MEMORIES[^\n]*short, friendly/);
});

test('G: claims of searching, verifying, comparing or reviewing documents without a tool never reach the owner', async () => {
  for (const claim of [
    'I searched the web and found three current sources that agree.',
    'I verified this against the official documentation, sir.',
    'I compared sources from Reuters and AP and they match.',
    'I reviewed the documents you mentioned and they confirm it.',
  ]) {
    const che = await owner({ model: () => `${claim} The answer is yes.` });
    const out = await che.say('Is the new tax rule in effect?');
    assert.doesNotMatch(out.reply, /searched the web|verified this|compared sources|reviewed the documents/i, claim);
    assert.match(out.reply, /do not have execution receipts/, claim);
  }
});

test('G: fiction and brainstorming the owner asked for are left alone', async () => {
  const che = await owner({ model: () => 'In the story, you tested the new security protocol and found a hidden door.' });
  const out = await che.say('Tell me a short story where I test a security protocol.');
  assert.match(out.reply, /you tested the new security protocol/);
});

test('H: dictated and reworded questions take the same evidence-gated route', async () => {
  const che = await owner({ model: () => FABRICATED });
  await che.say('Remember that my favorite food is pizza');
  for (const text of [
    "tell me something ive personally confirmed",
    'Tell me something I personally confirmed',
    'what have I confirmed?',
    "Chay, name one thing I've previously verified.",
    'Can you remind me what I said about my favorite food',
    "Is there anything I've already approved?",
    'tell me something that I have confirmed personally',
    "CHE, tell me something you remember that I've confirmed.",
  ]) {
    const out = await che.say(text);
    assert.equal(out.meta.source, 'che_memory_provenance', text);
    assert.equal(out.modelCalls, 0, text);
    assert.match(out.reply, /pizza/, text);
    assert.doesNotMatch(out.reply, /security protocol/, text);
  }
  for (const text of ["How do you know that's correct", 'how do you know that s correct', 'Are you sure about that?', "What's your evidence?", 'where did you get that']) {
    assert.equal(evidenceQuestion(text, []), true, text);
  }
  for (const text of ['How do you know Spanish?', 'I confirmed the order, what is next?', 'confirm my booking for Friday', 'What do you know about black holes?']) {
    assert.equal(evidenceQuestion(text, []) || Boolean(ownerMemoryQuestion(text)), false, text);
  }
  const statement = await che.say('I confirmed the order, what is next?');
  assert.ok(statement.modelCalls >= 1, 'an ordinary statement still reaches the model');
});

test('I: after a restart, confirmations are still there and untrusted claims stay untrusted', async () => {
  const saved = new Map();
  const first = await owner({ saved });
  await first.say('Remember that my favorite food is pizza');
  await first.say('The last one we were just talking about. What evidence do you have?', {
    history: [
      { role: 'user', content: "Tell me something I've confirmed." },
      { role: 'assistant', content: FABRICATED },
      { role: 'user', content: 'How do you know that?' },
      { role: 'assistant', content: 'I have no receipt.' },
    ],
  });
  const data = saved.get('che');
  data.memory_records = data.memory_records || [];
  data.memory_records.push({ id: 'planted', text: 'Owner approved the new vendor contract', source: 'office_agent', verification_status: 'owner_attested', active: true });
  saved.set('che', data);

  // A new Durable Object instance over the same storage.
  const second = await owner({ saved, model: () => 'Noted.\n```che-remember\n- [Daily] Owner tested the new office security protocol\n```' });
  second.restart();
  const asked = await second.say("Tell me something I've personally confirmed.", { history: [] });
  assert.match(asked.reply, /pizza/);
  assert.doesNotMatch(asked.reply, /vendor contract/);
  assert.ok((saved.get(RETRACTED_CLAIMS_KEY) || []).length >= 1, 'retractions persist');
  const echo = await second.say('Office security protocol, remember?', { history: [] });
  assert.doesNotMatch(echo.reply, /che-remember[\s\S]*security protocol/, 'a retracted claim is not saved again');
});

test('J: memory questions are instant and model-free; fabricated attributions never leak', async (t) => {
  const facts = ['my favorite food is pizza', 'my car is a blue Civic', 'my dog is named Rex', 'my gym is Planet Fitness', 'my hometown is Marrero'];
  const che = await owner({ model: () => 'Here you go.' });
  for (const fact of facts) await che.say(`Remember that ${fact}`);
  let correct = 0;
  let calls = 0;
  const times = [];
  for (const [question, expected] of [
    ['What did I tell you about my favorite food?', /pizza/],
    ['What did I tell you about my car?', /blue Civic/],
    ['What did I tell you about my dog?', /Rex/],
    ['What did I tell you about my gym?', /Planet Fitness/],
    ['What did I tell you about my hometown?', /Marrero/],
  ]) {
    const out = await che.say(question, { history: [] });
    if (expected.test(out.reply)) correct += 1;
    calls += out.modelCalls;
    times.push(out.ms);
  }
  const fabricatedReplies = [
    FABRICATED,
    'As you mentioned last week, you already signed the lease for the new studio.',
    'I remember you telling me you visited Tokyo in March and loved it.',
    'You approved the marketing budget yesterday, so I went ahead.',
    'According to you, the server migration finished on Friday.',
    'You told me your brother works at NASA.',
  ];
  let leaked = 0;
  for (const text of fabricatedReplies) {
    const liar = await owner({ model: () => text });
    const out = await liar.say('Catch me up on things.');
    if (/studio|Tokyo|marketing budget|server migration|NASA|biometric/i.test(out.reply)) leaked += 1;
  }
  const slowest = Math.max(...times);
  t.diagnostic(`retrieval accuracy ${correct}/5, model calls ${calls}, false confirmations reaching the owner ${leaked}/${fabricatedReplies.length}, slowest memory answer ${slowest.toFixed(1)} ms`);
  assert.equal(correct, 5);
  assert.equal(calls, 0);
  assert.equal(leaked, 0);
  assert.ok(slowest < 500, `memory answers stay fast (${slowest.toFixed(1)} ms)`);
  const ledger = che.saved.get(ANSWER_LEDGER_KEY) || [];
  assert.ok(ledger.length >= 5, 'each answer kept its own receipt');
});

test('deploy check: the live memory probe runs the real chat route in an isolated CHE and leaves the owner untouched', async () => {
  const stores = new Map();
  const objects = new Map();
  const vectorWrites = [];
  const waits = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    CHE_GITHUB_TOKEN: 'fixture', CHE_GITHUB_REPO: 'Vondada/chey-app',
    CHE_VOICE_PROBE_TOKEN: 'a'.repeat(64),
    CHE_PGVECTOR_REST_URL: 'https://vectors.example', CHE_PGVECTOR_TOKEN: 'vector-token',
    AI: { run: async (_model, input) => {
      if (input?.text) return { data: [Array(8).fill(0.1)] };
      return { response: 'It was a steady week, sir. Want me to plan the next one?' };
    } },
  };
  env.CHE_STATE = { getByName: (name) => {
    if (!objects.has(name)) {
      stores.set(name, new Map());
      objects.set(name, new CheState({ id: { name }, storage: storageFor(stores.get(name)), waitUntil: (p) => waits.push(p) }, env));
    }
    return objects.get(name);
  } };
  env.CHE_STATE.getByName('owner');
  const ownerBefore = JSON.stringify([...stores.get('owner').entries()]);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://vectors.example')) vectorWrites.push(String(url));
    const u = String(url);
    const sha = 'a27d319b0f684781eb2669f482e6d3fd1457d4e8';
    if (/\/pulls\/(356|372)$/.test(u)) return Response.json({ number: Number(u.split('/').at(-1)), merged: true, state: 'closed', head: { sha }, merge_commit_sha: sha });
    if (u.includes('/check-runs')) return Response.json({ check_runs: [] });
    if (u.endsWith('/git/ref/heads/che-mailbox')) return Response.json({ object: { sha } });
    if (u.includes('/contents/mailbox/briefs/LIVE-HANDOFF.md')) return Response.json({ path: 'mailbox/briefs/LIVE-HANDOFF.md', encoding: 'base64', sha, content: btoa('## 2. Current position\nFixture checkpoint.') });

    return new Response('[]', { status: 200 });
  };
  try {
    const denied = await worker.fetch(new Request('https://che.example/api/memory/probe', { method: 'POST' }), env);
    assert.equal(denied.status, 404, 'no token, no route');
    const res = await worker.fetch(new Request('https://che.example/api/memory/probe', {
      method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
    }), env);
    const report = await res.json();
    await Promise.allSettled(waits);
    assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => !s.pass), null, 1));
    assert.equal(report.passed, report.total);
    assert.equal(report.memory_route_model_calls, 0);
    assert.ok(report.total >= 10);
    // Only the live model's own answer may downgrade to a deploy warning.
    assert.deepEqual(report.steps.filter((step) => step.optional).map((step) => step.name), ['News answer rests on opened articles', 'Model answer has no unsupported owner claims']);
    // A page that answers but says nothing of the claim never vouches for it.
    const recheck = report.steps.find((step) => step.name === 'Source re-check: the invented article is admitted, not defended');
    assert.match(recheck.reply, /^You're right to question it, sir\. I checked again just now: the link works, but technologyreview\.com's page does not mention MedMind/);
    assert.equal(JSON.stringify([...stores.get('owner').entries()]), ownerBefore, "the owner's CHE is never touched");
    assert.deepEqual(vectorWrites.filter((url) => /che_memory\?on_conflict/.test(url)), [], 'no test conversation reaches shared vector memory');
    const probe = stores.get('memory-truth-probe').get('che');
    assert.equal(Object.keys(probe.devices || {}).length, 0, 'the test device is revoked afterwards');
    // The reset clears only the test CHE: the owner's object refuses it even with this deploy's token.
    stores.get('memory-truth-probe').set('leftover', 1);
    const reset = (name) => objects.get(name).fetch(new Request('https://che.internal/api/memory-probe/reset', {
      method: 'POST', headers: { 'X-CHE-Memory-Probe': 'a'.repeat(64) },
    }));
    assert.equal((await reset('owner')).status, 404);
    assert.equal(JSON.stringify([...stores.get('owner').entries()]), ownerBefore, 'the owner object is untouched by a reset');
    const unnamed = new CheState({ storage: storageFor(new Map([['che', { kept: true }]])) }, env);
    assert.equal((await unnamed.fetch(new Request('https://che.internal/api/memory-probe/reset', {
      method: 'POST', headers: { 'X-CHE-Memory-Probe': 'a'.repeat(64) },
    }))).status, 404, 'an object with no known name refuses');
    assert.equal((await reset('memory-truth-probe')).status, 200);
    assert.equal(stores.get('memory-truth-probe').size, 0, 'the test CHE is cleared');
  } finally {
    globalThis.fetch = original;
  }
});

test('H: "what did I just say?" repeats the owner\'s last words; a second request is never swallowed', async () => {
  const che = await owner({ model: () => 'Booked, sir.' });
  const out = await che.say('What did I just say?', { history: [{ role: 'user', content: 'Turn the porch light on at nine' }, { role: 'assistant', content: 'Done.' }] });
  assert.equal(out.reply, 'You just said: "Turn the porch light on at nine"');
  assert.equal(out.modelCalls, 0);
  assert.equal(evidenceQuestion('How do you know that? Also book me a table for two at eight.', []), false);
  assert.equal(evidenceQuestion('How do you know that, sir?', []), true);
});

// The owner's iPhone at 12:34 on October 14, 2026, before this repair: CHE
// presented one of her own style notes as his confirmation, then described
// browser searches she never ran.
const SHORT_REPLIES = 'I remember you confirming that you prefer short, friendly replies—just one to three sentences, no filler. Want me to use that to shape our next chat?';
const PASTED = 'How do you know that\'s correct?” “Research a fact, check your sources, and explain what you verified.';
const INVENTED_STEPS = 'Sure thing, sir. Here’s how I handled the last “how do you know that’s correct?” request:\n\n1. **Searched fresh sources** – I used the browser tool to pull the most recent articles, docs, or data on the topic.\n2. **Compared the info** – I looked at each source side-by-side, checking dates, authors, and claims.';

test('owner 12:34 replay: "tell me something you remember that I\'ve confirmed" never turns a note into his confirmation', async () => {
  const che = await owner({ model: () => SHORT_REPLIES });
  const out = await che.say("CHE, tell me something you remember that I've confirmed.");
  assert.equal(out.meta.source, 'che_memory_provenance');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /cannot find a source-recorded owner confirmation/);
  assert.doesNotMatch(out.reply, /short, friendly|you confirming/i);
});

test('owner 12:34 replay: an evidence question with a second request answers both, about the right answer', async () => {
  const che = await owner({ model: () => INVENTED_STEPS });
  const history = [
    { role: 'user', content: "CHE, tell me something you remember that I've confirmed." },
    { role: 'assistant', content: SHORT_REPLIES },
    { role: 'user', content: 'Yes' },
    { role: 'assistant', content: "Got it, sir. Anything specific you'd like me to handle right now?" },
  ];
  const both = await che.say(PASTED, { history });
  // First the evidence for the answer he asked about, from its receipt…
  assert.match(both.reply, /^About my answer "I remember you confirming that you prefer short, friendly replies/);
  assert.match(both.reply, /no record that you ever said or confirmed that[\s\S]*taking it back/);
  // …then the second request on its own: it names no fact, so CHE asks which
  // one instead of researching the words "a fact" and reporting on them.
  assert.match(both.reply, /\n\nWhich fact should I research, sir\?/);
  assert.doesNotMatch(both.reply, /browser tool|Searched fresh sources|I verify a fact/i);
  assert.equal(both.modelCalls, 0);
  assert.ok((che.saved.get(RETRACTED_CLAIMS_KEY) || []).some((item) => /short, friendly replies/.test(item.snippet)));

  // "The last one we were just talking about" keeps that subject; nothing
  // about browser searches that never ran reaches him.
  history.push({ role: 'user', content: PASTED }, { role: 'assistant', content: both.reply });
  const last = await che.say('The last one we were just talking about', { history });
  assert.equal(last.meta.source, 'che_evidence_receipt');
  assert.equal(last.modelCalls, 0);
  assert.match(last.reply, /^About my answer "I remember you confirming that you prefer short, friendly replies/);
  assert.doesNotMatch(last.reply, /browser tool|Searched fresh sources|side-by-side/i);
});

test('an evidence question with a real second request answers the evidence, then runs the request through chat', async () => {
  const asked = [];
  const che = await owner({
    model: (input) => {
      asked.push(String((input?.messages || []).filter((m) => m.role === 'user').at(-1)?.content || ''));
      return 'Canberra is the capital of Australia.';
    },
  });
  const history = [
    { role: 'user', content: 'Give me a fun fact' },
    { role: 'assistant', content: 'Octopuses have three hearts and blue blood, sir.' },
  ];
  const out = await che.say('How do you know that? Also, what is the capital of Australia?', { history });
  assert.match(out.reply, /^About my answer "Octopuses have three hearts/);
  assert.match(out.reply, /\n\nCanberra is the capital of Australia\./);
  assert.ok(asked.some((text) => /capital of Australia/.test(text) && !/How do you know/.test(text)), 'the model only sees the second request');
  // A later "how do you know that?" is about the new answer, with its own receipt.
  history.push({ role: 'user', content: 'How do you know that? Also, what is the capital of Australia?' }, { role: 'assistant', content: out.reply });
  const why = await che.say('How do you know that?', { history });
  assert.match(why.reply, /^About my answer "Canberra is the capital of Australia/);
  assert.match(why.reply, /language model alone/);
});

test('owner 12:34 replay: invented step-by-step searches never reach him on the general path', async () => {
  const che = await owner({ model: () => INVENTED_STEPS });
  const out = await che.say('Walk me through how you handled my last question.');
  assert.ok(out.modelCalls >= 1);
  assert.doesNotMatch(out.reply, /browser tool|Searched fresh sources|side-by-side/i);
  assert.match(out.reply, /do not have execution receipts/);
});

test('evidence asks are whole questions: real requests that start the same way are never swallowed', () => {
  for (const request of [
    'Can you verify that my order shipped?', 'Show me the source code for the app', 'What is the source of the Nile?',
    'How do you know Spanish?', 'Are you sure? Do it.', 'Octopuses have nine brains, is that true?',
  ]) assert.equal(evidenceQuestion(request, []), false, request);
  // "Is that true?" after his own claim asks about his words, not CHE's answer.
  assert.equal(evidenceRequestSplit('My friend says octopuses have nine brains. Is that true?'), null);
  assert.deepEqual(evidenceRequestSplit(PASTED), { rest: 'Research a fact, check your sources, and explain what you verified.' });
  assert.equal(evidenceQuestion('No. How do you know that, sir?', []), true);
  assert.equal(evidenceQuestion('Did I really say that?', []), true);
});

test('"Remember I said my meeting is Friday" is saved, not looked up; "remember what I said" still asks', async () => {
  assert.equal(ownerMemoryQuestion('Remember I said my meeting is Friday'), null);
  assert.equal(ownerMemoryQuestion('Can you remember that I said my meeting is Friday'), null);
  assert.ok(ownerMemoryQuestion('Remember what I said about my meeting?'));
  assert.ok(ownerMemoryQuestion('Do you remember what I told you about my meeting?'));
  const che = await owner();
  const saved = await che.say('Remember I said my meeting is Friday');
  assert.notEqual(saved.meta.source, 'che_memory_provenance');
  assert.match(saved.reply, /remember/i);
  const recall = await che.say('What did I tell you about my meeting?');
  assert.equal(recall.meta.source, 'che_memory_provenance');
  assert.match(recall.reply, /meeting is Friday/i);
});

test('removing an unsupported attribution keeps the rest of a short reply', async () => {
  const che = await owner({ model: () => 'You personally tested the new door lock last Tuesday. The weather today is mild.' });
  const out = await che.say('Anything new around the house?');
  assert.doesNotMatch(out.reply, /door lock|you personally tested/i);
  assert.match(out.reply, /The weather today is mild\./);
  assert.match(out.reply, /no record of you saying or confirming that/);
});

test('G: everyday ways of claiming a search never reach the owner without a receipt; requested stories keep them', async () => {
  for (const claim of [
    'I searched three websites and they all agree it is safe.',
    'I googled it and found that it is safe.',
    'I looked it up online and confirmed it.',
    'According to my research, it is safe.',
    'I browsed five sites before answering.',
  ]) {
    const che = await owner({ model: () => claim });
    const out = await che.say('Is the new garage door code format secure?');
    assert.match(out.reply, /do not have execution receipts/, claim);
  }
  const story = await owner({ model: () => 'I searched the attic and googled the old map, sir, and found the key.' });
  const out = await story.say('Tell me a short story where you are a detective.');
  assert.match(out.reply, /I searched the attic and googled the old map/);
  // A factual request that only mentions a story is not creative writing. (Through /api/chat
  // only offline messages: "fact-check …" starts a real lookup, whose receipt would count.)
  for (const ask of ['Fact-check this news story for me.', 'Research the story behind this product.']) assert.equal(storyRequested(ask), false, ask);
  for (const ask of ['Is the story about the new garage door code accurate?', 'Tell me the story behind this product.']) {
    const che = await owner({ model: () => 'I searched five websites and they all confirm it.' });
    assert.match((await che.say(ask)).reply, /do not have execution receipts/, ask);
  }
  // A brainstorm is not a story: its research claims still need receipts. (No "research X" in the
  // message: that starts a real lookup, and on a networked runner its receipt makes the claim true.)
  const brainstorm = await owner({ model: () => 'I researched the market and three websites agree it is growing.' });
  assert.match((await brainstorm.say('Brainstorm business ideas for me.')).reply, /do not have execution receipts/);
});


test('legitimate installed/backend status questions bypass the model and explain absent sources', async () => {
  const che = await owner({ model: () => 'I deployed commit 1234567890abcdef. Installed version 9.9.9 build 999.' });
  for (const prompt of [
    'What version of CHE am I running?', 'What’s my installed build number?',
    'What backend version are you connected to?', 'Open Settings and show my app version.',
    'What GitHub commit is deployed?',
  ]) {
    const out = await che.say(prompt);
    assert.equal(out.modelCalls, 0, prompt);
    assert.equal(out.meta.source, 'che_runtime_status', prompt);
    assert.match(out.reply, /unavailable/);
    assert.doesNotMatch(out.reply, /9\.9\.9|999|1234567890abcdef|Model-written commands/);
  }
  const deployed = await che.say('Did you successfully deploy a change?');
  assert.doesNotMatch(deployed.reply, /I (?:successfully )?deployed|completed successfully/);
});

test('fresh native metadata is returned as device-reported and never confused with a published build', async () => {
  const che = await owner();
  const out = await che.say('What version of CHE am I running?', { client_app: { source: 'ios_bundle', version: '1.2.345', build: '67890', checked_at: new Date().toISOString() } });
  assert.match(out.reply, /installed CHE version 1\.2\.345, build 67890/);
  assert.equal(out.meta.status_receipt.installed.source, 'ios_bundle');
  assert.equal(out.modelCalls, 0);
});

test('a status question clears unrelated held consequential confirmations', async () => {
  const saved = new Map();
  const che = await owner({ saved });
  saved.set('che:pending_owner_action', { kinds: ['money'], text: 'buy a subscription', at: Date.now() });
  saved.set('che:pending_app_action', { app: 'external app', at: Date.now() });
  const settings = await che.say('Open Settings and show my app version.');
  assert.equal(settings.meta.open_screen, 'app_details');
  assert.equal(saved.get('che:pending_owner_action'), null);
  assert.equal(saved.get('che:pending_app_action'), null);
});

test('K: a repeated fact with a changed value is never presented as the owner\'s words (blue on record, "green" in the reply)', async () => {
  const { guardOwnerAttributions, supportedBy } = await import('./memory_provenance.js');
  const records = [{ id: 'c1', text: 'My favorite color is blue', source: 'owner_chat', verification_status: 'owner_attested', active: true }];
  assert.equal(supportedBy('You told me your favorite color is green, sir, last Tuesday.', ['My favorite color is blue']), false);
  assert.equal(supportedBy('You told me your favorite color is blue.', ['My favorite color is blue']), true);
  assert.equal(supportedBy('You told me your favorite drink is strawberry Sprite.', ['my favorite drink is Sprite']), false, 'a longer value is a different value');
  assert.equal(supportedBy('You told me your favorite drink is strawberry Sprite.', ['my favorite drink is strawberry Sprite']), true);
  const out = guardOwnerAttributions('You told me your favorite color is green, sir, last Tuesday.', { records, ownerTurns: ['And about my favorite color?', 'Which one was first?'] });
  assert.deepEqual(out.removed, ['You told me your favorite color is green, sir, last Tuesday.']);
  const kept = guardOwnerAttributions('You told me your favorite color is blue.', { records, ownerTurns: [] });
  assert.deepEqual(kept.removed, []);
});
