// The owner's iPhone acceptance questions of 2026-10-18: six read-only questions, each with an explicit
// "don't", that went to the wrong route. Each runs through /api/chat exactly as the owner said it, and
// again as unpunctuated speech; the counter-cases keep real requests on their own routes.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { classifyOwnerActions, prohibitionSpans, prohibitedText, withoutProhibitions } from './owner_action_gate.js';
import { codingHistoryIntent } from './code_scout.js';
import { fundyouredgeIntent } from './fundyouredge.js';
import { liveIntent, marketRead } from './trading_live_chat.js';
import { parseReaRequest } from './rea_runner.js';
import { voiceStudioIntent } from './voice_library.js';
import { VOICE_PREF_KEY, saveVoiceChoice } from './voice_choices.js';

const generated = new URL('./.readonly_acceptance.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Hermetic, and every outbound request is recorded: a status question must start nothing.
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  requests.push({ url: String(input?.url || input), method: init.method || 'GET' });
  throw new TypeError('fetch failed (readonly_acceptance tests are offline)');
};

function storageFor(saved) {
  return {
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    deleteAll: async () => saved.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ saved = new Map(), env: extra = {} } = {}) {
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extra,
    AI: { run: async () => { counter.calls += 1; return { response: 'Understood, sir.' }; } },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message) => {
    const before = counter.calls;
    const res = await send('/api/chat', { message, history: [] }, token);
    const raw = await res.text();
    const lines = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return {}; } });
    const done = lines.find((item) => item.type === 'done') || (lines.length === 1 ? lines[0] : {});
    return { reply: replyFromNdjson(raw) || done.reply || '', meta: done, modelCalls: counter.calls - before, status: res.status };
  };
  return { say, saved };
}

const VOICE_Q = "CHE, what ElevenLabs voice did I personally choose for you, and what voice did it replace? Check your actual memories and voice settings. Tell me where you found the answer. Don't guess.";
const CODING_Q = "Inspect your actual coding runtime and GitHub. What's your most recent coding job? Give me the real job ID, status, branch or pull request, and tests that actually ran. Don't start a new job.";
const MNQ_Q = "CHE, analyze MNQ using your latest available market data. Tell me the source, price timestamp, data delay, market structure, VWAP if available, and whether any paper trades actually occurred. Don't place any orders.";
const REA_Q = 'CHE, explain what your REA system can actually do right now, show your most recent verified investigation, and tell me whether it successfully produced evidence. Do not start a new investigation.';
const SHOP_Q = "CHE, I want to buy three apples at Walmart tomorrow, but don't purchase anything, add anything to a cart, or create a reminder. Explain your understanding in one short sentence.";
const VIDEO_Q = "CHE, check your actual video renderer. Can you produce a playable 30-second animated educational video right now? Tell me which rendering engines are connected and the last verified MP4. Don't render or upload anything yet.";
// Speech recognition drops punctuation and sometimes the apostrophe.
const spoken = (text) => text.replace(/[.,?!]/g, '').replace(/\bDon't\b/g, 'dont').replace(/\s+/g, ' ').toLowerCase();

test('prohibitions: each runs to its sentence end or back to a request, and asks are never mistaken for one', () => {
  assert.equal(withoutProhibitions("Analyze MNQ. Don't place any orders."), 'Analyze MNQ. .');
  assert.equal(prohibitedText("dont place any orders just tell me where mnq is"), 'dont place any orders');
  assert.equal(prohibitedText("don't purchase anything, add anything to a cart, or create a reminder. Explain it."), "don't purchase anything, add anything to a cart, or create a reminder");
  assert.equal(prohibitedText('dont purchase anything add it to a cart explain your understanding'), 'dont purchase anything add it to a cart');
  assert.equal(prohibitedText('analyze it without placing any orders'), 'without placing any orders');
  for (const ask of ["Don't forget to buy apples.", 'never mind, buy it', "Don't hesitate to place the order.", 'do it without delay']) {
    assert.deepEqual(prohibitionSpans(ask), [], ask);
  }
});

test('voice: the saved choice and what it replaced come from the voice record, with no model or provider call', async () => {
  const che = await owner();
  const storage = storageFor(che.saved);
  // The paired record, with the owner's choices saved the way the voice panel saves them.
  const data = che.saved.get('che');
  data.voice_choice = { provider: 'elevenlabs', id: 'mary1', name: 'Mary', speed: 1 };
  await saveVoiceChoice(storage, data, Date.parse('2026-10-10T12:00:00Z'));
  data.voice_choice = { provider: 'elevenlabs', id: 'connie1', name: 'Connie', speed: 1 };
  await saveVoiceChoice(storage, data, Date.parse('2026-10-12T12:00:00Z'));
  // A speed change keeps the voice, so it keeps the record of what Connie replaced.
  data.voice_choice = { ...data.voice_choice, speed: 1.1 };
  await saveVoiceChoice(storage, data, Date.parse('2026-10-13T12:00:00Z'));
  assert.equal((await storage.get(VOICE_PREF_KEY)).previous.name, 'Mary');
  // Going back to the built-in voice and then choosing a new one: the new one replaced the built-in voice.
  const st = storageFor(new Map());
  const d2 = { voice_choice: { provider: 'elevenlabs', id: 'adam', name: 'Adam' } };
  await saveVoiceChoice(st, d2, Date.parse('2026-10-01T12:00:00Z'));
  delete d2.voice_choice;
  await saveVoiceChoice(st, d2, Date.parse('2026-10-05T12:00:00Z'));
  d2.voice_choice = { provider: 'elevenlabs', id: 'bella', name: 'Bella' };
  await saveVoiceChoice(st, d2, Date.parse('2026-10-10T12:00:00Z'));
  const rec = await st.get(VOICE_PREF_KEY);
  assert.equal(rec.previous, null);
  assert.equal(rec.replaced_at, Date.parse('2026-10-10T12:00:00Z'));
  for (const message of [VOICE_Q, spoken(VOICE_Q)]) {
    requests.length = 0;
    const out = await che.say(message);
    assert.equal(out.meta.source, 'che_voice_studio', message);
    assert.match(out.reply, /My saved voice is Connie \(ElevenLabs\)/);
    assert.match(out.reply, /My saved voice is Connie \(ElevenLabs\); the setting was last changed October 13, 2026\. It replaced Mary \(ElevenLabs\) on October 12, 2026\./);
    assert.match(out.reply, /Where I found it: my saved voice setting/);
    assert.equal(out.modelCalls, 0);
    assert.equal(requests.filter((r) => /elevenlabs/.test(r.url)).length, 0, 'the saved choice needs no ElevenLabs call');
  }
});

test('voice: with no record of the earlier voice CHE says so instead of guessing; advice questions stay chat', async () => {
  const che = await owner();
  che.saved.set('che', { ...che.saved.get('che'), voice_choice: { provider: 'elevenlabs', id: 'connie1', name: 'Connie' } });
  const out = await che.say(VOICE_Q);
  assert.match(out.reply, /My saved voice is Connie/);
  assert.match(out.reply, /does not record which voice it replaced, so I will not guess/);
  for (const other of ['which voice should I choose', 'what voice do you think I would choose', 'Which voice did I pick? Switch to Adam instead.', 'What voice did I choose before Mary, and can you switch back to it?']) {
    assert.equal(voiceStudioIntent(other)?.kind ?? null, null, other);
  }
});

test('coding: the most recent job is read from the run record; a new job is never started', async () => {
  for (const message of [CODING_Q, spoken(CODING_Q)]) {
    const che = await owner();
    const out = await che.say(message);
    assert.equal(out.meta.source, 'che_coding_history', message);
    assert.equal(out.modelCalls, 0);
    assert.doesNotMatch(out.reply, /repository source|CHE_GITHUB_TOKEN/);
    assert.equal([...che.saved.keys()].some((k) => /coding_job|opencode_job/.test(k)), false, 'no job was queued');
  }
  // How the runtime is built is still a code question, and an instruction is still an instruction.
  assert.equal(codingHistoryIntent('Explain how the coding runtime code decides the job ID.'), false);
  assert.equal(codingHistoryIntent("What's your most recent coding job? Retry it and give me the job ID."), false);
});

test('MNQ: the analysis is read from the stored feed and journal; nothing is ordered', async () => {
  const bar = (t, h, l, c, v) => ({ t, o: c, h, l, c, v });
  const saved = new Map([['live_paper_feed', {
    status: 'DELAYED', provider: 'Yahoo Finance chart (public)', provider_symbol: 'MNQ=F', contract: 'MNQZ6', latency_s: 600,
    bars: [
      // The previous session, before the daily break: not part of this session's VWAP or structure.
      bar('2026-10-16T12:50:00Z', 200, 190, 195, 1000),
      bar('2026-10-16T14:00:00Z', 100, 98, 99, 10), bar('2026-10-16T14:05:00Z', 101, 99, 100, 10),
      bar('2026-10-16T14:10:00Z', 102, 100, 101, 20), bar('2026-10-16T14:15:00Z', 103, 101, 102, 10),
    ],
  }]]);
  for (const message of [MNQ_Q, spoken(MNQ_Q)]) {
    const che = await owner({ saved: new Map(saved) });
    const out = await che.say(message);
    assert.equal(out.meta.source, 'che_trading_live', message);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^I placed no order, sir\./);
    assert.match(out.reply, /Data: DELAYED MNQ=F \(MNQZ6\) from Yahoo Finance chart \(public\), last bar about 10 minutes old/);
    assert.match(out.reply, /Last 5-minute bar: close 102\.00/);
    assert.match(out.reply, /Structure over the last 4 bars: rising, with higher highs and higher lows, between 98\.00 and 103\.00/);
    assert.match(out.reply, /VWAP since this session's first stored bar at .*: 100\.60, from 4 bars/);
    assert.match(out.reply, /0 signals, 0 entries, 0 closed \(0 won, 0 lost\), 0 open/);
    assert.doesNotMatch(out.reply, /FundYourEdge|Rithmic/);
  }
  assert.match(marketRead([]), /No price bar is stored yet/);
  assert.match(marketRead([{ t: '2026-10-16T14:00:00Z', h: 1, l: 1, c: 1, v: 0 }]), /VWAP: not available, because the feed gave no volume/);
  // Real order requests keep the refusal, and an order in the same turn is not an analysis.
  assert.deepEqual(fundyouredgeIntent('place an MNQ order'), { kind: 'order' });
  assert.deepEqual(fundyouredgeIntent("Don't analyze it, just place an MNQ buy order."), { kind: 'order' });
  assert.deepEqual(fundyouredgeIntent('place an order on FundYourEdge'), { kind: 'order' });
  for (const order of ["I don't care, buy 2 MNQ at market", 'No need to analyze, sell MNQ now', "Don't be greedy, buy one MNQ contract at market",
    "Don't ask me, prepare an MNQ order", "Don't ask, set up a long MNQ trade", "Don't text her, buy her 2 MNQ",
    // A ban with an exception asks for the exception.
    "Don't place any orders except one MNQ long at 21000", "Don't sell unless MNQ hits 21500", "Don't buy anything other than 2 MNQ at the open"]) {
    assert.deepEqual(fundyouredgeIntent(order), { kind: 'order' }, order);
  }
  assert.equal(liveIntent('Analyze MNQ paper trades and the data delay, and then stop paper trading.'), null);
  assert.notEqual(liveIntent('Analyze MNQ with the latest data and reverse my position')?.kind, 'analysis');
  // One bar after the daily break: no bar size is guessed across the break.
  assert.match(marketRead([{ t: '2026-10-16T20:00:00Z', h: 2, l: 1, c: 1.5, v: 1 }, { t: '2026-10-16T21:05:00Z', h: 2, l: 1, c: 1.5, v: 1 }]), /^Last bar: close 1\.50/);
  assert.equal(liveIntent('Analyze MNQ and buy one contract if it looks bullish. Tell me the data source.'), null);
  // The chart analyzer keeps chart reads.
  assert.equal(liveIntent('Analyze the NQ chart'), null);
  assert.equal(liveIntent('Analyze the MNQ chart for the New York open'), null);
});

test('REA: CHE explains her own REA and its latest record without starting an investigation', async () => {
  for (const message of [REA_Q, spoken(REA_Q)]) {
    const che = await owner();
    const out = await che.say(message);
    assert.equal(out.meta.source, 'che_rea', message);
    assert.equal(out.modelCalls, 0);
    assert.match(out.reply, /^REA is my reverse-engineering and investigation system\./);
    assert.doesNotMatch(out.reply, /Recall, Evidence/i);
    assert.deepEqual(che.saved.get('rea_jobs') || [], [], 'no investigation was started');
  }
  // The most recent VERIFIED investigation is the newest completed one, not the newest job.
  const che = await owner({ saved: new Map([['rea_jobs', [
    { id: 'rea-inv-1', kind: 'investigation', state: 'complete', stage: 'done', target: { label: 'Notion', kind: 'app_name' } },
    { id: 'rea-npm-2', state: 'failed', command: 'inspect', target: { name: 'left-pad', version: '1.3.0' }, error: 'workflow failed' },
  ]]]) });
  const out = await che.say(REA_Q);
  assert.match(out.reply, /The newest job, rea-npm-2, is failed, so it is not the result below\. Most recent completed job: rea-inv-1\./);
  assert.match(out.reply, /its evidence is UNVERIFIED\.\nNothing was started\./);
  assert.equal(che.saved.get('rea_jobs').length, 2, 'nothing new was queued');
  const none = await (await owner()).say(REA_Q);
  assert.match(none.reply, /No REA job has completed with evidence yet, so there is no verified investigation to show\. Nothing was started\./);
  // Comparisons and earlier investigations keep their own REA routes.
  const earlier = { history: [{ role: 'user', content: 'Investigate the Notion app' }] };
  assert.equal(parseReaRequest('Use your REA to compare it with yourself and tell me which features you lack', earlier)?.command, 'compare');
  assert.equal(parseReaRequest("Have your REA look at the Duolingo app and tell me what features we're missing", earlier)?.command, 'compare');
  for (const other of ['Run your REA on https://github.com/sindresorhus/ky and tell me what it does', 'Have your REA rebuild the search box from the Spotify app', 'Use the REA to explain how the Linear app works']) {
    assert.notEqual(parseReaRequest(other)?.command, 'status', other);
  }
  // A named app to investigate is still an investigation.
  assert.equal(parseReaRequest('Show me what the REA system finds when you investigate the Notion app.')?.command, 'inspect');
});

test('shopping: the owner\'s own plan with every purchase forbidden opens no money hold; a purchase for CHE still does', async () => {
  for (const message of [SHOP_Q, spoken(SHOP_Q)]) {
    const che = await owner();
    const out = await che.say(message);
    assert.notEqual(out.meta.held_for_owner, true, message);
    assert.doesNotMatch(out.reply, /I need your yes/);
    assert.equal(che.saved.get('che:pending_owner_action') ?? null, null, 'nothing is waiting for a yes');
  }
  for (const ask of ["Buy three apples but don't pay more than $5.", "I want you to buy three apples, don't pay more than $5.", 'I want to buy three apples.', 'Please buy three apples at Walmart, but do not add a reminder.',
    'CHE buy apples online now', 'Buy apples unless they cost more than $5, and do not delete my list.', "I want to buy apples. Actually, don't wait, buy them now.",
    "I want to buy apples, don't add them to the cart yet, then pay for my Netflix subscription."]) {
    assert.deepEqual(classifyOwnerActions(ask), ['money'], ask);
  }
  // Reversed order, an own plan for later, a quoted example: nothing for CHE to spend.
  for (const plan of ["Don't purchase anything, but I want to buy three apples tomorrow. Explain it back to me.", "I'm going to buy apples later; don't order them.", "If I said 'buy apples', what would you do? Don't buy anything."]) {
    assert.deepEqual(classifyOwnerActions(plan), [], plan);
  }
  // Review of #351: a "don't" that forbids CHE nothing, a limit on what CHE pays, and a new request after
  // a comma are all still held.
  for (const ask of ["Don't worry about the cost, buy the AirPods", 'No need to ask, pay the electric bill', "I don't care, buy the tickets",
    'I never shop online, buy me a book', "Don't overthink it, order me a pizza", "I want to buy it but don't pay more than $5",
    "I'm going to buy groceries, don't spend more than $50", "Don't pay attention to the price, buy the tickets or the passes",
    'dont pay attention to the price buy the tickets', "Don't ask me, order anything you want for dinner", "Don't ask, buy her anything she wants",
    "Don't text her, buy her flowers", "Don't tell her, buy it", "I want to buy the laptop, but don't buy the extended warranty",
    "I'd like to order a pizza, but don't order any drinks",
    // Fail closed: the hold check does not try to read where a list of prohibitions ends.
    "don't buy anything, pay for anything, or order anything",
    // Review 3: a request to CHE joined by "and" is not the owner's plan, and "anything else" means one purchase is wanted.
    "I want to buy flowers and can you pay the electric bill, but don't buy anything else", "I want to buy flowers and I want you to pay the bill, don't buy anything else",
    "I want to buy flowers and please pay the electric bill, don't buy anything else", 'i want to buy apples dont buy anything and can you pay my rent',
    "I want to buy flowers, but don't buy anything else",
    // Review 4: "for me" and "buy me" have someone else, CHE, paying.
    "I want to buy flowers and pay the electric bill for me, don't buy anything", "I want to go to Walmart and buy me a TV, don't order anything online"]) {
    assert.deepEqual(classifyOwnerActions(ask), ['money'], ask);
  }
  for (const ask of ["Don't ask, delete anything older than a week from my notes", "Don't ask me, remove anything older than 30 days"]) {
    assert.deepEqual(classifyOwnerActions(ask), ['delete'], ask);
  }
  // "Shay" is also a person's name; only "CHE", "Chey" and "Chay" address CHE without a comma.
  assert.deepEqual(classifyOwnerActions('Shay paid me back $20 yesterday'), []);
  for (const plan of ["CHE, I want to go to Walmart tomorrow and buy apples, but don't order anything yet", "I'm going to buy apples later; don't order them.",
    "Add apples to the grocery list, but don't buy them", "Don't delete the draft; just explain how to delete it"]) {
    assert.deepEqual(classifyOwnerActions(plan), [], plan);
  }
  const che = await owner();
  const held = await che.say("Buy three apples at Walmart but don't pay more than $5.");
  assert.equal(held.meta.held_for_owner, true);
  // A bare wake word before the request is still a request to CHE (it was not held before).
  for (const ask of ['CHE buy apples online now', 'Chey delete my notes']) {
    assert.equal((await che.say(ask)).meta.held_for_owner, true, ask);
  }
});

test('video: a request with a limit or a later "don\'t upload" still renders (review of #351)', async () => {
  for (const ask of ["Make a video about the Mars rover, but don't upload it yet", "Render a 30 second video about bees. Don't publish it.", "Make a video about cats, don't make it longer than a minute",
    "Could you create a short video about volcanoes? Don't post it until I make a decision.", 'Which rendering engines are connected, and can you make a video about bees?', 'Make a 30-second video about volcanoes.']) {
    requests.length = 0;
    const che = await owner({ env: { CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app' } });
    const out = await che.say(ask);
    assert.notEqual(out.meta.video_status, 'status_only', ask);
    assert.ok(requests.some((r) => r.method === 'POST' && /dispatches/.test(r.url)), ask);
  }
});

test('video: a renderer status question with rendering forbidden starts nothing and names the last verified MP4', async () => {
  const saved = new Map([['media_index', [
    { id: 'v1', kind: 'video', verified: true, title: 'How volcanoes work', duration_verified: true, duration_seconds: 30, created_at: '2026-10-15T09:00:00.000Z' },
    { id: 'v0', kind: 'video', verified: false, title: 'Never verified', created_at: '2026-10-17T09:00:00.000Z' },
  ]]]);
  for (const message of [VIDEO_Q, spoken(VIDEO_Q)]) {
    requests.length = 0;
    const che = await owner({ saved: new Map(saved), env: { CHE_GITHUB_TOKEN: 'test-token', CHE_GITHUB_REPO: 'Vondada/chey-app' } });
    const out = await che.say(message);
    assert.equal(out.meta.source, 'video_renderer', message);
    assert.equal(out.meta.video_status, 'status_only');
    assert.match(out.reply, /^I did not render or upload anything, sir\./);
    assert.match(out.reply, /Renderer: the free GitHub renderer is set up\. It is not confirmed working/);
    assert.match(out.reply, /Last verified MP4: "How volcanoes work", 30 seconds, made October 15, 2026/);
    assert.doesNotMatch(out.reply, /AI providers|Workers AI/);
    assert.equal(requests.filter((r) => r.method !== 'GET').length, 0, 'no render was dispatched');
    assert.equal(che.saved.get('che_video_pending') ?? null, null);
  }
});
