// Owner mission 2026-10-14: CHE must never present an unsupported personal
// memory as the owner's confirmation. Every scenario here goes through the
// real /api/chat route of the Worker and checks the reply the owner sees.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { ANSWER_LEDGER_KEY, RETRACTED_CLAIMS_KEY, evidenceQuestion, ownerMemoryQuestion } from './memory_provenance.js';

const generated = new URL('./.memory_truth.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

const FABRICATED = 'You personally tested a new office security protocol last Tuesday and confirmed that after-hours access required a two-step biometric check.';

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
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
      objects.set(name, new CheState({ storage: storageFor(stores.get(name)), waitUntil: (p) => waits.push(p) }, env));
    }
    return objects.get(name);
  } };
  env.CHE_STATE.getByName('owner');
  const ownerBefore = JSON.stringify([...stores.get('owner').entries()]);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://vectors.example')) vectorWrites.push(String(url));
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
    assert.ok(report.total >= 8);
    assert.equal(JSON.stringify([...stores.get('owner').entries()]), ownerBefore, "the owner's CHE is never touched");
    assert.deepEqual(vectorWrites.filter((url) => /che_memory\?on_conflict/.test(url)), [], 'no test conversation reaches shared vector memory');
    const probe = stores.get('memory-truth-probe').get('che');
    assert.equal(Object.keys(probe.devices || {}).length, 0, 'the test device is revoked afterwards');
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
