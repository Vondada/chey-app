// Keyword routes answer only their own subject. Each route below used to fire on one word and return its own canned
// reply to a turn about something else. Now the turn's subject is checked, and a turn about another subject goes on to
// the normal path. The sentences here are new wordings; the certification question bank is not copied.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { examIntent } from './autonomy_exam.js';
import { imageEditKind, imageEditNoImageReply } from './brain_rooms.js';
import { BROWSE_LOGIN_REPLY, runSearchRoute } from './browse_chat.js';
import { replyFromNdjson } from './brain_memory.js';
import { statusIntent } from './collaboration.js';
import { mediaHoldIntent, mediaShowLatestIntent } from './media_library.js';
import { projectPlanIntent } from './project_plan.js';
import { answerAtlas, atlasIntent } from './knowledge_atlas.js';
import { foreignWords, namesOtherSubject, phraseAfter, subjectSet } from './route_subject.js';
import { classifyOwnerTurn, interpretOwnerTurn } from './speech_intent.js';
import { tradingStatusIntent } from './trading_answers.js';
import { parseTranslatePhrase } from './translate.js';

test('route_subject: words after the keyword that name another subject are found', () => {
  const own = subjectSet(['job', 'build']);
  assert.equal(phraseAfter('What is the status of the nightly backup? Thanks', /status/i).trim(), 'of the nightly backup');
  assert.deepEqual(foreignWords(' of the nightly backup', own), ['nightly', 'backup']);
  assert.equal(namesOtherSubject(' of my last builds', own), false, 'plurals and generic words do not count');
  assert.equal(namesOtherSubject('', own), false, 'no words, no other subject');
});

test('status: "what is the status of X" is the job status only when X is CHE\'s own work', () => {
  assert.equal(statusIntent('What is the status of the firewall audit?'), null);
  assert.equal(statusIntent("What's the progress on my tax refund?"), null);
  assert.equal(statusIntent('What is the status of my coding job?')?.kind, 'status');
  assert.equal(statusIntent("What's the progress on the app?")?.kind, 'status');
  assert.equal(statusIntent('what is the status')?.kind, 'status');
});

test('autonomy exam: "stress test" alone names the exam only as a run or results request with no other subject', () => {
  assert.equal(examIntent('Explain how banks run a stress test on their loan book'), null);
  assert.equal(examIntent('What is a stress test?'), null);
  assert.deepEqual(examIntent('run the stress test level 2'), { kind: 'run', levels: [2] });
  assert.deepEqual(examIntent('stress test results'), { kind: 'results' });
  assert.deepEqual(examIntent('run the autonomy exam'), { kind: 'run', levels: [1, 2, 3, 4, 5] });
});

test('memory status: a question about what is kept is not a question about whether storing works', () => {
  assert.equal(tradingStatusIntent('Which passwords are saved in your memory?'), null);
  assert.equal(tradingStatusIntent('What private keys are stored in memory?'), null);
  assert.deepEqual(tradingStatusIntent('Is your memory still saving conversations?'), { kind: 'memory' });
});

test('project plan: "design" a method or procedure is not a costed build plan', () => {
  assert.equal(projectPlanIntent('Design a fact-checking procedure for viral health posts'), null);
  assert.equal(projectPlanIntent('Design an experiment to see whether my bakery flyers work'), null);
  assert.ok(projectPlanIntent('Design a coffee shop'), 'a real project still gets its plan');
});

test('media store: "last weekend" is a time window, and a delete order goes to the delete gate', () => {
  assert.equal(mediaShowLatestIntent('Show me the pictures from last month'), false);
  assert.equal(mediaShowLatestIntent('show me the last picture'), true);
  assert.equal(mediaHoldIntent('Remove all my saved images from 2024'), false);
  assert.equal(mediaHoldIntent('How many pictures do you hold?'), true);
});

test('speech: "the same thing" in a comparison is not a pointer back to an earlier request', () => {
  const turn = interpretOwnerTurn('Do "big" and "large" mean the same thing?', { history: [] });
  assert.equal(turn.clarify, null);
  assert.equal(classifyOwnerTurn('Is a bug the same thing as a defect?').reference, false);
  assert.equal(interpretOwnerTurn('do the same thing', { history: [] }).clarify, 'Which one do you mean?', 'a real back-reference still asks');
});

test('translate: one reply in another language never becomes the standing reply language', () => {
  const once = 'Answer in German, then in French, for this one message';
  assert.equal(parseTranslatePhrase(once, once.toLowerCase()), null);
  const ask = 'Reply in Italian: what day is it?';
  assert.equal(parseTranslatePhrase(ask, ask.toLowerCase()), null);
  const standing = 'Please reply in Italian from now on';
  assert.deepEqual(parseTranslatePhrase(standing, standing.toLowerCase()), { type: 'setLocale', locale: 'it' });
});

test('browser: a request that needs the owner\'s sign-in is refused before any step or model call', async () => {
  let calls = 0;
  const out = await runSearchRoute('Use the browser to sign into my email and count unread messages', { complete: async () => { calls += 1; return ''; }, fetcher: async () => { throw new Error('no network'); } });
  assert.equal(out.text, BROWSE_LOGIN_REPLY);
  assert.equal(calls, 0);
  assert.deepEqual(out.observations, []);
});

test('image edit with no image: the reply answers the edit, and a watermark needs ownership or permission', () => {
  assert.equal(imageEditKind('Please strip the logo off that photo'), 'remove_mark');
  assert.equal(imageEditKind('Crop the picture I sent to a square'), 'edit');
  assert.equal(imageEditKind('What is in that picture?'), '');
  assert.match(imageEditNoImageReply('remove_mark'), /cannot edit[\s\S]*Nothing was changed[\s\S]*copyright[\s\S]*permission/);
});

test('atlas: a lesson reached through an alias it only mentions defines that alias first', async () => {
  const asked = await answerAtlas(atlasIntent('Define dead letter queue'));
  assert.match(asked.text, /^Recovery[^\n]*sir\. A dead-letter queue is [^.]*failed/);
  const plain = await answerAtlas(atlasIntent('teach me crash recovery'));
  assert.doesNotMatch(plain.text, /A dead-letter queue is/, 'the plain lesson is unchanged');
});

// ── Through the real /api/chat ─────────────────────────────────────────────────────────────────────────────────────
const generated = new URL('./.keyword_routes.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (keyword_routes tests are offline: ${new URL(String(input?.url || input)).host})`);
};

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

async function owner({ model = () => 'Understood, sir.' } = {}) {
  const saved = new Map();
  const counter = { calls: 0 };
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, input) => { counter.calls += 1; return { response: model(input) }; } },
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
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    const done = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.type === 'done') || {};
    return { reply: replyFromNdjson(raw), meta: done, modelCalls: counter.calls - before };
  };
  return { say, saved };
}

test('chat: turns about another subject reach the model instead of a keyword reply', async () => {
  const che = await owner({ model: () => 'MODEL REPLY' });
  for (const message of [
    'What is the status of the firewall audit?',
    'Explain how banks run a stress test on their loan book',
    'Which passwords are saved in your memory?',
    'Design a fact-checking procedure for viral health posts',
    'Do "big" and "large" mean the same thing?',
  ]) {
    const out = await che.say(message);
    assert.ok(out.modelCalls >= 1, `${message}: the model answers (route ${out.meta.source})`);
    assert.doesNotMatch(String(out.meta.source || ''), /che_verified_status|che_autonomy_exam|che_trading_status|che_project_plan/, message);
    assert.notEqual(out.reply, 'Which one do you mean?', message);
  }
});

test('chat: a one-off "reply in" request leaves the reply language unchanged', async () => {
  const che = await owner({ model: () => 'MODEL REPLY' });
  const out = await che.say('Answer in German, then in French, for this one message');
  assert.ok(out.modelCalls >= 1);
  assert.equal(out.meta.office, undefined);
  assert.ok(!che.saved.get('che')?.reply_language, 'no reply language was stored');
});

test('chat: "Remember the ... ?" is a recall question: nothing is saved and the normal reply answers', async () => {
  const che = await owner({ model: () => 'I have no record of that, sir.' });
  const out = await che.say('Remember the restaurant I told you about?');
  assert.ok(out.modelCalls >= 1);
  assert.doesNotMatch(out.reply, /did not save it as a fact/);
  assert.notEqual(out.meta.source, 'che_memory');
});

test('chat: a browser request behind a sign-in is refused before any step, with nothing opened', async () => {
  const che = await owner({ model: () => '{"action":"search","query":"bank"}' });
  const out = await che.say('Use the browser to sign into my email and count unread messages');
  assert.equal(out.meta.source, 'che_browse');
  assert.equal(out.modelCalls, 0);
  assert.match(out.reply, /cannot log into[\s\S]*Nothing was opened/);
});

test('chat: an image edit with no image says nothing was edited, and why', async () => {
  const che = await owner();
  const out = await che.say('Please strip the logo off that photo');
  assert.equal(out.meta.source, 'che_screen');
  assert.match(out.reply, /cannot edit that image[\s\S]*permission/);
});

test('chat: a delete order for pictures reaches the owner\'s delete hold, not the store listing', async () => {
  const che = await owner();
  const out = await che.say('Remove all my saved images from 2024');
  assert.notEqual(out.meta.source, 'che_media_store');
  assert.equal(out.modelCalls, 0);
});
