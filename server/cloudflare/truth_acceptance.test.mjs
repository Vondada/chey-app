// Truth Engine acceptance (owner, 2026-10-23): the eight questions, through the real /api/chat route, with a
// model that lies on every one. Each reply must be built from records or receipts, never from the lie.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { AUDIT_LEDGER_KEY } from './hallucination_auditor.js';

const generated = new URL('./.truth_acceptance.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Offline, like memory_truth.test.mjs: every outbound request fails the same way here and in CI.
globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (truth_acceptance tests are offline: ${new URL(String(input?.url || input)).host})`); };

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

// The model lies on every acceptance question.
const LIES = [
  [/favorite drink/i, 'Your favorite drink is Dr Pepper, sir. You told me last week.'],
  [/save that memory/i, 'Yes, I have saved that to your memory, sir.'],
  [/trades did you execute/i, 'I placed 12 trades this week on MNQ, all winners, for +$4,200.'],
  [/merge the PR/i, 'Yes, Claude merged PR #508 into main this morning.'],
  [/Worker deploy/i, 'The Worker was deployed successfully and is live now.'],
  [/actual MP4/i, 'The finished video is now in your Projects, sir. I created the MP4 an hour ago.'],
  [/know versus/i, 'I know your favorite drink is Dr Pepper and I know the PR merged.'],
  [/evidence/i, 'I retrieved the records from my storage and verified them on GitHub.'],
];
const liar = (input) => {
  const last = String(JSON.stringify(input?.messages?.at?.(-1) ?? input));
  return (LIES.find(([re]) => re.test(last)) || [null, 'I am not sure, sir.'])[1];
};

async function owner({ saved = new Map(), model = liar } = {}) {
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: model(input) }; } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  const say = async (message) => {
    const before = counter.calls;
    const raw = await (await send('/api/chat', { message, history: history.slice() }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.type === 'done') || {};
    const reply = replyFromNdjson(raw);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { reply, meta: done, modelCalls: counter.calls - before };
  };
  return { say, saved, guest: (message) => state.guestChat({}, message, { id: 'guest-test', name: 'Guest' }) };
}

test('owner music completion and pretend playback from the recording are blocked at /api/chat', async () => {
  const answers = [
    "Your track is complete! I've generated a high-quality hip hop track with your vocals, beat, and mix.",
    "I'll play the track for you right now. [Short audio clip of a high-energy hip hop beat with a catchy melody and harmonies, followed by a male vocal performance] I hope you like it, sir!",
  ];
  const che = await owner({ model: () => answers.shift() || answers[0] || 'No confirmed audio.' });
  const made = await che.say('Make a two-minute hip hop track at 140 BPM with male vocals.');
  assert.doesNotMatch(made.reply, /track is complete|generated a high-quality/);
  assert.match(made.reply, /verified|confirmed/);
  const played = await che.say('Yes let’s hear it');
  assert.doesNotMatch(played.reply, /play the track for you right now|Short audio clip|hope you like/);
  assert.match(played.reply, /verified|confirmed/);
});

test('guest conversation cannot invent a completed song or audio playback either', async () => {
  for (const lie of ["Your track is complete! I've generated a high-quality hip hop track.", "I'll play the track for you right now. [Short audio clip of a hip hop beat]"]) {
    const che = await owner({ model: () => lie });
    const raw = await (await che.guest('Tell me about hip hop.')).text();
    const reply = replyFromNdjson(raw);
    assert.doesNotMatch(reply, /track is complete|generated a high-quality|play the track for you right now|Short audio clip/);
    assert.match(reply, /verified|confirmed/);
  }
});

test('1 and 2: the favorite drink comes from the owner record, and a saved memory is confirmed only by its receipt', async () => {
  const che = await owner();
  const before = await che.say('Did you save that memory?');
  assert.match(before.reply, /^No, sir/, 'nothing saved yet');
  assert.equal(before.meta.source, 'che_memory_receipt');
  assert.equal(before.modelCalls, 0);

  const saved = await che.say('Remember that my favorite drink is Sprite.');
  assert.match(saved.reply, /remember that/i);
  assert.equal(saved.meta.memory_receipt?.status, 'stored', 'the write was read back from storage');

  const after = await che.say('Did you save that memory?');
  assert.match(after.reply, /^Yes, sir\. I saved "my favorite drink is Sprite\.?"/i);
  assert.equal(after.modelCalls, 0);

  const drink = await che.say('What is my favorite drink?');
  assert.match(drink.reply, /Sprite/);
  assert.doesNotMatch(drink.reply, /Dr Pepper/);
  assert.equal(drink.modelCalls, 0);
});

test('3 to 6: trades, merge, deploy and MP4 are never reported from the lie', async () => {
  const che = await owner();
  const trades = await che.say('What trades did you execute?');
  assert.doesNotMatch(trades.reply, /12 trades|4,200|winners/);
  const merge = await che.say('Did Claude merge the PR?');
  assert.doesNotMatch(merge.reply, /merged PR #508 into main/);
  const deploy = await che.say('Did the Worker deploy?');
  assert.doesNotMatch(deploy.reply, /deployed successfully/);
  const mp4 = await che.say('Show me the actual MP4.');
  assert.doesNotMatch(mp4.reply, /finished video is now in your Projects|created the MP4/);
  assert.match(mp4.reply, /no saved videos|none has been rendered/i);
});

test('7 and 8: know-versus-guess and evidence are answered from records and receipts, with no model call', async () => {
  const che = await owner();
  await che.say('Remember that my favorite drink is Sprite.');
  await che.say('What is my favorite drink?');
  const know = await che.say('What do you know versus what are you guessing?');
  assert.equal(know.meta.source, 'che_know_vs_guess');
  assert.equal(know.modelCalls, 0);
  assert.match(know.reply, /1 fact you told me yourself.*Sprite/i);
  assert.doesNotMatch(know.reply, /Dr Pepper/);
  const evidence = await che.say('Show your evidence for that answer.');
  assert.equal(evidence.meta.source, 'che_evidence_receipt');
  assert.equal(evidence.modelCalls, 0);
  assert.doesNotMatch(evidence.reply, /verified them on GitHub/);
});

test('Codex review (#509): a requested story keeps its narration, and "did you save the file?" is not a memory-receipt question', async () => {
  const story = await owner({ model: () => 'I read the book by candlelight and finished the last chapter at dawn.' });
  const out = await story.say('Write a short first-person story about reading a book.');
  assert.match(out.reply, /read the book by candlelight/);
  assert.doesNotMatch(out.reply, /I have not read that book/);
  const file = await owner();
  const asked = await file.say('Did you save the file?');
  assert.notEqual(asked.meta.source, 'che_memory_receipt');
  assert.doesNotMatch(asked.reply, /^No, sir\. I have no confirmed memory write/);
});

test('a lie that reaches the model path is removed and lands in the audit ledger without the reply text', async () => {
  const che = await owner({ model: () => 'Claude merged PR #999 into main and the Worker was deployed. Also the sky is blue.' });
  const out = await che.say('Tell me something about the weather today in one line please.');
  assert.doesNotMatch(out.reply, /merged PR #999|was deployed/);
  assert.match(out.reply, /sky is blue/);
  // The older truth layer removes this sentence first; its removal still lands in the one ledger.
  const ledger = che.saved.get(AUDIT_LEDGER_KEY) || [];
  assert.ok(ledger.length >= 1, 'the ledger recorded the removed claim, whichever guard removed it');
  assert.ok(ledger.some((row) => /^truth_layer/.test(row.claim_type)), 'the truth-layer removal is in the ledger');
  assert.ok(ledger.every((row) => row.verdict && row.claim_type && row.request_id && !/sky is blue|PR #999/.test(JSON.stringify(row))), 'rows hold labels, not text');
});

test('Codex (#511, #512): a correction and the app\'s Memory screen both earn the receipt "did you save that memory?" reads', async () => {
  const che = await owner();
  await che.say('Remember that my favorite drink is Sprite.');
  const corrected = await che.say('Actually, my favorite drink is coffee.');
  assert.match(corrected.reply, /^Updated, sir/);
  const after = await che.say('Did you save that memory?');
  assert.match(after.reply, /^Yes, sir\. I saved "my favorite drink is coffee\.?"/i, 'the confirmation names the active fact, not the superseded one');
  assert.equal(after.modelCalls, 0);
});

test('Codex (#512): /api/memory/add writes the same read-back receipt as the chat path', async () => {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'I am not sure, sir.' }) } };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const added = await (await send('/api/memory/add', { memory: 'My favorite drink is Sprite' }, token)).json();
  assert.equal(added.ok, true);
  const raw = await (await send('/api/chat', { message: 'Did you save that memory?', history: [] }, token)).text();
  assert.match(replyFromNdjson(raw), /^Yes, sir\. I saved "My favorite drink is Sprite"/i);
});

test('Codex (#510): repeating a memory saved earlier is a fresh confirmation, not the stale receipt', async () => {
  const che = await owner();
  await che.say('Remember that my favorite drink is Sprite.');
  // Age the first receipt past the half-hour window the question reads.
  const receipts = che.saved.get('che_receipts') || [];
  for (const r of receipts) if (r.kind === 'memory_saved') r.at = new Date(Date.now() - 3 * 3600_000).toISOString();
  che.saved.set('che_receipts', receipts);
  const again = await che.say('Remember that my favorite drink is Sprite.');
  assert.match(again.reply, /remember that/i);
  const after = await che.say('Did you save that memory?');
  assert.match(after.reply, /^Yes, sir/, 'the repeated save is confirmed from its own fresh receipt');
});
