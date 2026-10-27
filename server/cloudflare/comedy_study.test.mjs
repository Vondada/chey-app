// Study assignments (owner, 2026-10-27): "go study the entire Martin series and The Fresh Prince of Bel-Air ... learn
// what makes them funny". Through the real /api/chat and alarm with a fake Wikipedia (the episode-guide wikitext format)
// and a fake model: the plan, coverage by method, lessons in the Brain, retrieval after a restart, the originality
// guard and the humor line. The live check (studyProbe) runs the same steps on staging with the real network and model.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { copiesSource, parseEpisodes, seasonPages, studyIntent, studyProbe } from './comedy_study.js';

const MARTIN_LIST = `==Series overview==
==Episodes==
===Season 1 (1992–93)===
{{Episode table |background=#123 |overall= |season= |title= |airdate= |episodes=
{{Episode list
 |EpisodeNumber=1
 |EpisodeNumber2=1
 |Title=Martin's on the Move
 |OriginalAirDate={{Start date|1992|8|27}}
 |ShortSummary=Martin plans a romantic dinner for Gina, but his friends keep turning up uninvited and the evening escalates into chaos.
}}
{{Episode list
 |EpisodeNumber=2
 |EpisodeNumber2=2
 |Title=[[Talkin' Trash]]
 |OriginalAirDate={{Start date|1992|9|3}}
 |ShortSummary=Martin and Pam trade insults all week until a charity event forces them to work together.
}}
}}
===Season 2 (1993–94)===
{{Episode list
 |EpisodeNumber=3
 |EpisodeNumber2=1
 |Title=Baby You Can Drive My Car
 |OriginalAirDate={{Start date|1993|8|26}}
 |ShortSummary=Martin's pride in his car becomes a running gag after Tommy borrows it.
}}`;
const FRESH_LIST = `The episodes are listed on season pages.
{{:The Fresh Prince of Bel-Air season 1}}
{{:The Fresh Prince of Bel-Air season 2}}`;
const FRESH_S1 = `{{Episode list
 |EpisodeNumber=1
 |EpisodeNumber2=1
 |Title=The Fresh Prince Project
 |ShortSummary=Will arrives at his rich relatives' mansion and clashes with Uncle Phil, whose formality makes a perfect foil.
}}`;
const FRESH_S2 = `{{Episode list
 |EpisodeNumber=26
 |EpisodeNumber2=1
 |Title=Did the Earth Move for You?
 |ShortSummary=Will and Carlton fumble an earthquake drill; Carlton's earnestness sets up every punchline.
}}`;

const wikiCalls = [];
function fakeWiki(url) {
  const u = new URL(String(url));
  const p = Object.fromEntries(u.searchParams);
  wikiCalls.push(p.list === 'search' ? `search:${p.srsearch}` : `${p.action || p.prop}:${p.page || p.titles}`);
  const body = (() => {
    if (p.list === 'search') {
      if (/martin/i.test(p.srsearch)) return { query: { search: [{ title: 'Martin Lawrence' }, { title: 'Martin (TV series)' }, { title: 'List of Martin episodes' }] } };
      if (/fresh prince/i.test(p.srsearch)) return { query: { search: [{ title: 'The Fresh Prince of Bel-Air' }, { title: 'List of The Fresh Prince of Bel-Air episodes' }] } };
      return { query: { search: [] } };
    }
    if (p.action === 'parse') {
      const pages = { 'List of Martin episodes': MARTIN_LIST, 'List of The Fresh Prince of Bel-Air episodes': FRESH_LIST, 'The Fresh Prince of Bel-Air season 1': FRESH_S1, 'The Fresh Prince of Bel-Air season 2': FRESH_S2 };
      return pages[p.page] ? { parse: { title: p.page, wikitext: pages[p.page] } } : { error: { code: 'missingtitle' } };
    }
    if (p.prop === 'revisions') {
      const pages = { 'The Fresh Prince of Bel-Air season 1': FRESH_S1, 'The Fresh Prince of Bel-Air season 2': FRESH_S2 };
      return { query: { pages: p.titles.split('|').map((title) => (pages[title] ? { title, revisions: [{ slots: { main: { content: pages[title] } } }] } : { title, missing: true })) } };
    }
    if (p.prop === 'extracts') return { query: { pages: [{ extract: `${p.titles} is an American sitcom known for its ensemble cast, physical comedy and rapid insults between friends.` }] } };
    return {};
  })();
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  if (url.startsWith('https://en.wikipedia.org/')) return fakeWiki(url);
  return new Response('{"error":"offline test"}', { status: 503 });
};

const generated = new URL('./.comedy_study.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageMap() {
  const saved = new Map();
  let alarm = null;
  return {
    saved,
    get alarmAt() { return alarm; },
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async (at) => { alarm = at; },
    getAlarm: async () => alarm,
    deleteAlarm: async () => { alarm = null; },
  };
}

// The fake model: lesson JSON for the study prompt (one lesson copies its source, and must be dropped), plain chat otherwise.
const LESSON_LIST = [
  { technique: 'Escalation', principle: 'Start with a small problem and let each new arrival make it a little worse, so the payoff feels earned.', use_when: 'a story is already going sideways', stop_when: 'the other person is actually stressed', seen_in: ["Martin's on the Move"] },
  { technique: 'Insult banter between friends', principle: 'Trade quick, affectionate jabs only with people who know you love them; the warmth underneath is what makes it land.', use_when: 'the relationship is close and relaxed', stop_when: 'a jab touches something they are sensitive about', seen_in: ["Talkin' Trash"] },
  { technique: 'Copycat', principle: 'Martin plans a romantic dinner for Gina, but his friends keep turning up uninvited', use_when: 'never', stop_when: 'always' },
  { technique: 'The straight-laced foil', principle: 'Pair loose energy with someone formal and earnest; the contrast writes the joke for you.', use_when: 'teasing a serious plan', stop_when: 'the plan really matters to them', seen_in: ['The Fresh Prince Project'] },
];
// The copied "lesson" is offered only while Martin's summaries are in front of the model.
const lessonsFor = (text) => JSON.stringify({ lessons: LESSON_LIST.filter((l) => l.technique !== 'Copycat' || /romantic dinner/.test(text)) });

async function che(storage = storageMap(), { name = '' } = {}) {
  const prompts = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', CHE_VOICE_PROBE_TOKEN: 'probe-token-0123456789abcdef0123456789',
    AI: { run: async (_m, input) => { const text = JSON.stringify(input?.messages || input); prompts.push(text); return { response: /study comedy craft/.test(text) ? lessonsFor(text) : 'Burned rice again? At this point the smoke detector is your sous-chef, sir.' }; } } };
  const state = new CheState({ storage, waitUntil: () => {}, ...(name ? { id: { name } } : {}) }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, history = []) => {
    const started = Date.now();
    const raw = await (await post('/api/chat', { message, history }, token)).text();
    const frames = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
    return { ms: Date.now() - started, done: frames.find((f) => f.type === 'done') || {}, reply: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('') };
  };
  return { say, state, storage, env, prompts };
}

const REQUEST = 'Hey Jay, go study the entire Martin series and The Fresh Prince of Bel-Air. Learn what makes them funny, how the characters joke, their timing, their sarcasm, and how they interact. Then develop your own natural sense of humor.';

test('the owner\'s request is understood: two shows, a humor goal; status, stop, resume and lessons by voice', () => {
  assert.deepEqual(studyIntent(REQUEST), { action: 'start', subjects: ['Martin', 'The Fresh Prince of Bel-Air'], goal: 'humor' });
  assert.equal(studyIntent("How's your studying going?").action, 'status');
  assert.equal(studyIntent('stop studying').action, 'stop');
  assert.equal(studyIntent('resume studying').action, 'resume');
  assert.equal(studyIntent('What did you learn about comedy?').action, 'lessons');
  assert.equal(studyIntent('I need to study for my exam tonight'), null, 'no humor goal: not a comedy study');
  assert.equal(studyIntent('That show was funny'), null);
});

test('episode guides: Episode list templates, season pages and the originality guard', () => {
  const eps = parseEpisodes(MARTIN_LIST, 'Martin');
  assert.deepEqual(eps.map((e) => [e.season, e.number, e.title]), [[1, 1, "Martin's on the Move"], [1, 2, "Talkin' Trash"], [2, 1, 'Baby You Can Drive My Car']]);
  assert.match(eps[0].summary, /romantic dinner/);
  assert.deepEqual(seasonPages(FRESH_LIST), ['The Fresh Prince of Bel-Air season 1', 'The Fresh Prince of Bel-Air season 2']);
  assert.equal(copiesSource('Martin plans a romantic dinner for Gina, but his friends keep turning up', MARTIN_LIST), true);
  assert.equal(copiesSource('Let each new arrival make the problem worse.', MARTIN_LIST), false);
});

test('end to end: plan, background passes with real-format sources, coverage by method, Brain lessons, retrieval after a restart', async () => {
  wikiCalls.length = 0;
  const storage = storageMap();
  let c = await che(storage);
  const start = await c.say(REQUEST);
  assert.equal(start.done.source, 'che_study');
  assert.equal(start.done.model_calls, 0);
  assert.match(start.reply, /Martin and The Fresh Prince of Bel-Air/);
  assert.match(start.reply, /reading summaries, not watching/);
  assert.ok(storage.alarmAt, 'the alarm is armed for the background work');
  // The alarm runs the passes; one is interrupted by a restart (a new CheState over the same storage) midway.
  for (let i = 0; i < 2; i += 1) { await storage.put('study:wake', Date.now() - 1); await c.state.alarm(); }
  c = await che(storage);
  for (let i = 0; i < 6; i += 1) { await storage.put('study:wake', Date.now() - 1); await c.state.alarm(); }
  assert.ok(wikiCalls.includes('search:Martin sitcom television series'));
  assert.ok(wikiCalls.includes('query:The Fresh Prince of Bel-Air season 1|The Fresh Prince of Bel-Air season 2'), 'season pages were followed in one request');
  const [a] = storage.saved.get('study:assignments');
  assert.equal(a.status, 'done');
  assert.deepEqual(a.subjects.map((s) => [s.article, s.episodes.length, s.cursor]), [['Martin (TV series)', 3, 3], ['The Fresh Prince of Bel-Air', 2, 2]]);
  assert.ok(a.subjects.every((s) => s.episodes.every((e) => e.method === 'episode summary (Wikipedia episode guide)')));
  // Lessons: in the Brain's Learned Knowledge region under Humor, the copied one dropped, sources kept.
  const lessons = storage.saved.get('humor_lessons');
  assert.ok(lessons.length >= 3);
  assert.ok(lessons.every((l) => l.technique !== 'Copycat'), 'a lesson repeating its source was dropped');
  // Retrieval after a restart, with no model and no Wikipedia call.
  c = await che(storage);
  wikiCalls.length = 0;
  const status = await c.say("How's your studying going?");
  assert.equal(status.done.model_calls, 0);
  assert.match(status.reply, /Martin \(TV series\): 3 of 3 episodes covered \(3 episode summary \(Wikipedia episode guide\)\)\. Episodes watched: 0\./);
  const learned = await c.say('What did you learn about comedy?');
  assert.match(learned.reply, /^Here's what I've learned so far, sir, in my own words:/);
  assert.match(learned.reply, /Escalation/);
  assert.deepEqual(wikiCalls, [], 'nothing re-read');
  assert.ok(status.ms < 2000 && learned.ms < 2000, `fast from storage (${status.ms} ms, ${learned.ms} ms)`);
  // The chat prompt carries the learned principles, never the shows' text, and no owner words go to Wikipedia.
  c.prompts.length = 0;
  const joke = await c.say('Roast me a little, I burned the rice again.');
  const prompt = c.prompts.find((p) => p.includes('HUMOR YOU LEARNED')) || '';
  assert.ok(prompt.includes('Escalation') && prompt.includes('never quote a show'));
  assert.ok(!prompt.includes('romantic dinner for Gina'), 'no episode text in the prompt');
  assert.match(joke.reply, /smoke detector/);
  // His laugh scores the lesson behind the joke.
  await c.say('lmao', [{ role: 'user', content: 'roast me' }, { role: 'assistant', content: 'Escalation: first the rice, then the pan, then the smoke detector.' }]);
  assert.ok(storage.saved.get('humor_lessons').find((l) => l.technique === 'Escalation').score >= 1);
});

test('stop and resume keep the cursor', async () => {
  const storage = storageMap();
  const c = await che(storage);
  await c.say(REQUEST);
  await storage.put('study:wake', Date.now() - 1);
  await c.state.alarm();
  const r = await c.say('stop studying');
  assert.match(r.reply, /^Paused, sir/);
  assert.equal(storage.saved.has('study:wake'), false);
  await c.state.alarm();
  assert.equal(storage.saved.get('study:assignments')[0].passes, 1, 'nothing ran while paused');
  assert.match((await c.say('resume studying')).reply, /from exactly where I stopped/);
});

test('the live check passes against this code', async () => {
  const storage = storageMap();
  const c = await che(storage, { name: 'memory-truth-probe' });
  const report = await studyProbe(c.env, new Request('https://che.example/api/study/probe', { method: 'POST', headers: { Authorization: 'Bearer probe-token-0123456789abcdef0123456789' } }), 'memory-truth-probe', { passes: 10 });
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => !s.pass && !s.optional)));
  assert.deepEqual(report.coverage.map((x) => [x.show, x.episodes, x.covered]), [['Martin (TV series)', 3, 3], ['The Fresh Prince of Bel-Air', 2, 2]]);
});
