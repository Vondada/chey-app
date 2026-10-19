// Knowledge Atlas in the Brain (owner issue #346, Brain lane). The cards are projected into CHE's one
// Brain as curated lessons (never the owner's memories, never measured facts), once: a second run
// writes nothing. The owner's study is recorded there as owner practice, measured from this chat,
// and read back as real counts. "Reset my progress" is a delete and waits for his yes. A coding or
// trading question that reaches the language model carries at most two relevant cards in at most 600
// characters, and every other question carries none. Through the real /api/chat, offline.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { BRAIN_REGIONS, CheBrainStore, VERIFICATION_STATES, learningRecords, recordLearning } from './brain_store.js';
import {
  ATLAS_CARDS, ATLAS_PROMPT_MAX, answerAtlas, atlasBrainRecord, atlasCard, atlasIntent, atlasPromptContext, atlasRelevantCards, atlasResetIntent,
  firstClause, gradeQuizAnswer, nextToStudy, progressText, projectAtlasToBrain, recordAtlasPractice,
} from './knowledge_atlas.js';
import { classifyOwnerActions } from './owner_action_gate.js';

const generated = new URL('./.atlas_brain.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

globalThis.fetch = async () => { throw new TypeError('fetch failed (atlas_brain tests are offline)'); };

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

// The Durable Object's two stores: key-value and SQLite, as CHE has them.
function storageFor(saved = new Map()) {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (q, ...p) => { const stmt = db.prepare(q); return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []); } },
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

// A paired owner phone. `say` returns the route, the reply, the model calls and every system prompt the model was given.
async function owner({ model = () => '' } = {}) {
  let calls = 0;
  const prompts = [];
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async (_model, opts = {}) => {
      calls += 1;
      const system = (opts.messages || []).find((m) => m.role === 'system');
      if (system) prompts.push(String(system.content || ''));
      const asked = [...(opts.messages || [])].reverse().find((m) => m.role === 'user');
      return { response: model(String(asked?.content || '')) || 'MODEL ANSWERED' };
    } },
  };
  const storage = storageFor();
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  const say = async (message, { as = token, keep = true, ...extra } = {}) => {
    const before = calls;
    const shown = prompts.length;
    const res = await send('/api/chat', { message, history: [...history], ...extra }, as);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const route = held?.held_for_owner ? 'held' : done.source || (calls > before ? 'model' : 'none');
    const reply = held?.message || replyFromNdjson(raw);
    if (keep) history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { route, done, reply, modelCalls: calls - before, prompts: prompts.slice(shown) };
  };
  const post = async (path, body) => (await send(path, body, token)).json();
  const get = async (path) => (await worker.fetch(new Request(`https://che.example${path}`, { headers: { Authorization: `Bearer ${token}` } }), env)).json();
  const brain = new CheBrainStore(storage);
  return { say, send, post, get, storage, brain, history };
}

async function guestOf(che) {
  const tenant = await che.post('/api/platform/tenants', { name: 'Guest', role: 'family' });
  const invite = await che.post('/api/platform/enrollments', { access: 'private', tenant_id: tenant.body?.tenant?.id || tenant.tenant?.id });
  const enrollment = invite.body?.enrollment || invite.enrollment;
  return (await (await che.send('/api/enroll', { enrollment_token: enrollment.token, device_name: 'guest' })).json()).device_token;
}

const spoken = (text) => text.replace(/[.,?!]/g, '').replace(/'/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const variants = (phrase) => [phrase, spoken(phrase), `CHE, ${phrase}`, `hey che ${spoken(phrase)}`];
const coding = ATLAS_CARDS.filter((c) => c.domain === 'coding');
const trading = ATLAS_CARDS.filter((c) => c.domain === 'trading');
const ownerMemory = {
  id: 'mem:owner-1', kind: 'memory', region: BRAIN_REGIONS.personal, path: 'Family', title: 'Mom’s birthday',
  body: 'Mom’s birthday is on the 4th of July.', verification: 'owner_attested', source: { kind: 'memory_record' },
};
const ownerTalk = {
  id: 'conv:owner-2', kind: 'conversation', region: BRAIN_REGIONS.conversations, path: 'Chat/2026-10-18', title: 'I like recursion',
  body: 'You said: I like recursion\nCHE answered: Noted, sir.', verification: 'owner_attested', source: { kind: 'owner_chat' },
};

// ─── Brain linking ────────────────────────────────────────────────────────

test('the cards enter the Brain once, as curated lessons in Knowledge Atlas folders; the owner\'s records are untouched', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  store.put(ownerMemory, { origin: 'phone' });
  store.put(ownerTalk, { origin: 'cloud' });
  const mine = [store.get(ownerMemory.id), store.get(ownerTalk.id)];
  const before = store.status();

  const first = projectAtlasToBrain(store);
  assert.equal(first.written, ATLAS_CARDS.length, 'every card is written once');
  for (const c of ATLAS_CARDS) {
    const r = store.get(`atlas:${c.id}`);
    assert.equal(r.kind, 'concept_card', c.id);
    assert.equal(r.verification, 'curated_lesson', `${c.id}: a curated lesson, not owner_attested and not verified_source`);
    assert.equal(r.region, c.domain === 'coding' ? BRAIN_REGIONS.coding : BRAIN_REGIONS.trading);
    assert.equal(r.path, `Knowledge Atlas/${c.domain === 'coding' ? 'Coding' : 'Trading'}/${c.title}`);
    assert.equal(r.source.kind, 'knowledge_atlas');
    assert.match(r.source.provenance, /curated teaching content, not the owner's words/);
    assert.deepEqual(r.links.filter((l) => l.type === 'builds_upon').map((l) => l.to).sort(), c.prerequisites.map((p) => `atlas:${p}`).sort(), `${c.id} prerequisites are edges`);
    assert.deepEqual(r.links.filter((l) => l.type === 'related_to').map((l) => l.to).sort(), c.related.map((p) => `atlas:${p}`).sort(), `${c.id} related cards are edges`);
  }
  assert.ok(VERIFICATION_STATES.includes('curated_lesson') && VERIFICATION_STATES.includes('owner_practice'));

  // Idempotent: the second run writes nothing at all, not even a revision.
  const seq = store.status().seq;
  const second = projectAtlasToBrain(store);
  assert.deepEqual([second.written, second.unchanged, second.removed], [0, ATLAS_CARDS.length, 0]);
  assert.equal(store.status().seq, seq, 'no record moved');

  // The counts are honest: memories stay memories, the cards are their own kind and label.
  const after = store.status();
  assert.equal(after.by_kind.memory, before.by_kind.memory, 'no memory was added');
  assert.equal(after.by_kind.conversation, before.by_kind.conversation);
  assert.equal(after.by_kind.concept_card, ATLAS_CARDS.length);
  assert.equal(after.by_verification.curated_lesson, ATLAS_CARDS.length);
  assert.equal(after.by_verification.owner_attested, before.by_verification.owner_attested, 'no card reads as something the owner said');
  const folders = after.regions.find((r) => r.region === BRAIN_REGIONS.coding).folders.map((f) => f.path);
  assert.ok(coding.every((c) => folders.includes(`Knowledge Atlas/Coding/${c.title}`)));
  for (const r of mine) {
    const now = store.get(r.id);
    assert.deepEqual([now.rev, now.hash, now.body, now.verification, now.origin], [r.rev, r.hash, r.body, r.verification, r.origin], `${r.id} untouched`);
  }
});

test('a changed card rewrites only itself; a card the owner deleted stays deleted; a foreign record is never overwritten', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  projectAtlasToBrain(store);
  // The stored copy of one card is an older revision: its body and the remembered hash differ.
  const [changed, deleted] = [ATLAS_CARDS[1], ATLAS_CARDS[2]];
  store.put({ ...atlasBrainRecord(changed), body: 'an older revision of this card' }, { origin: 'atlas' });
  const meta = store.meta('atlas_projection');
  store.setMeta('atlas_projection', { ...meta, hashes: { ...meta.hashes, [`atlas:${changed.id}`]: 'stale', [`atlas:${deleted.id}`]: 'stale' } });
  store.delete(`atlas:${deleted.id}`, { origin: 'owner' });
  const revs = new Map(ATLAS_CARDS.map((c) => [c.id, store.get(`atlas:${c.id}`).rev]));

  const run = projectAtlasToBrain(store);
  assert.equal(run.written, 1, 'only the changed card is written');
  assert.equal(store.get(`atlas:${changed.id}`).body, atlasBrainRecord(changed).body, 'it now holds the current card');
  assert.ok(store.get(`atlas:${deleted.id}`).deleted, 'the owner\'s delete wins');
  for (const c of ATLAS_CARDS) if (c !== changed) assert.equal(store.get(`atlas:${c.id}`).rev, revs.get(c.id), `${c.id} not rewritten`);
  assert.equal(projectAtlasToBrain(store).written, 0, 'and the next run is quiet again');

  // An id the atlas would use, held by a record it did not write, is left alone.
  const other = new CheBrainStore(storageFor());
  other.put({ id: `atlas:${ATLAS_CARDS[0].id}`, kind: 'note', region: BRAIN_REGIONS.learned, title: 'My own note', body: 'The owner wrote this note himself.', verification: 'owner_attested' }, { origin: 'phone' });
  projectAtlasToBrain(other);
  assert.equal(other.get(`atlas:${ATLAS_CARDS[0].id}`).body, 'The owner wrote this note himself.');
});

test('the Brain sync projects the cards, so the phone replica pulls them for the Brain Room offline', sqlite, async () => {
  const che = await owner();
  const page = await che.get('/api/brain/changes?since=0&limit=1000');
  const cards = page.records.filter((r) => r.kind === 'concept_card');
  assert.equal(cards.length, ATLAS_CARDS.length, 'the first pull from the start carries every card');
  assert.ok(cards.every((r) => r.verification === 'curated_lesson' && /^Knowledge Atlas\/(?:Coding|Trading)\//.test(r.path) && r.body.length > 100));
  const again = await che.get('/api/brain/changes?since=0&limit=1000');
  assert.deepEqual(again.records.filter((r) => r.kind === 'concept_card').map((r) => `${r.id}:${r.rev}`), cards.map((r) => `${r.id}:${r.rev}`), 'a second pull rewrites nothing');
  assert.equal(again.seq, page.seq);
});

// ─── Learning progress ────────────────────────────────────────────────────

test('with nothing studied, "what have I learned so far" says no lessons recorded yet, typed or spoken', sqlite, async () => {
  const che = await owner();
  const lesson = [{ role: 'assistant', content: 'Quiz on Recursion, sir. 3 questions:\n1. Q?\nSource: Knowledge Atlas card "Recursion" (coding), curated teaching content.' }];
  const cold = [...variants('What have I learned so far in the Knowledge Atlas?'), ...variants('How am I doing on trading?'), 'how many lessons have I done', "what's my learning progress in coding", 'what did I learn in coding'];
  for (const [words, history] of [...cold.map((w) => [w, []]), ...variants('What have I learned so far?').map((w) => [w, lesson])]) {
    const out = await che.say(words, { keep: false, history });
    assert.equal(out.route, 'che_knowledge_atlas', `${words} → ${out.route}: ${out.reply.slice(0, 100)}`);
    assert.equal(out.modelCalls, 0, words);
    assert.match(out.reply, /^No (?:coding |trading )?lessons recorded yet, sir\./, words);
    assert.doesNotMatch(out.reply, /\d+ (?:lessons?|quiz answers?) studied|correct \(/, 'no invented count');
  }
  assert.equal(learningRecords(che.brain).length, 0, 'asking records nothing');
});

test('lessons and graded quiz answers are recorded as owner practice, and read back as real counts', sqlite, async () => {
  const che = await owner();
  const loops = atlasCard('loops');
  const taught = await che.say('Teach me loops');
  assert.equal(taught.route, 'che_knowledge_atlas');
  await che.say('teach me loops', { keep: false });
  const lessons = learningRecords(che.brain).filter((r) => r.source.event === 'lesson');
  assert.equal(lessons.length, 1, 'the same lesson twice on one day is one record');
  assert.equal(lessons[0].verification, 'owner_practice');
  assert.equal(lessons[0].source.provenance, 'measured from this chat');
  assert.equal(lessons[0].path, `Knowledge Atlas/Coding/${loops.title}`);
  assert.deepEqual(lessons[0].links, [{ type: 'relevant_to', to: 'atlas:loops' }]);

  const quiz = await che.say('Quiz me on loops');
  assert.match(quiz.reply, /To answer one, say "number 1 is" and your answer\./);
  // Question 3 has a check: 1 + … + 10 = 55, recomputed from the card's formula.
  const q3 = await che.say('number 3 is 55');
  assert.equal(q3.route, 'che_knowledge_atlas', q3.reply);
  assert.match(q3.reply, /^Quiz finished on Loops and iteration, sir\. Question 3: correct\. You said: 55\./, 'the last question closes the quiz');
  assert.match(q3.reply, /Graded by the number, recomputed from the card's formula\. Recorded in your Brain as owner practice\./);
  const wrong = await che.say('CHE, the answer to question 3 is fifty four', { history: [{ role: 'assistant', content: quiz.reply }] });
  assert.match(wrong.reply, /^Quiz finished on Loops and iteration, sir\. Question 3: not quite\. You said: fifty four\. The card's answer: 55/);
  const after = await che.say('my answer is 55', { history: [{ role: 'assistant', content: wrong.reply }], keep: false });
  assert.notEqual(after.done.atlas_kind, 'grade', 'a finished quiz grades nothing more');
  const q1 = await che.say('number one is a condition that eventually becomes false', { history: [{ role: 'assistant', content: quiz.reply }] });
  assert.match(q1.reply, /^Question 1 on Loops and iteration, sir: correct\./);
  assert.match(q1.reply, /Graded by the card's own answer\./, 'the first clause of the card\'s answer, normalized');
  assert.match(q1.reply, /Question 2: A loop runs i from 0/, 'the next question is read');
  const q2 = await che.say('my answer is a big number');
  assert.match(q2.reply, /^Question 2 on Loops and iteration, sir: not quite\./, 'a bare answer goes to the next question');
  const answers = learningRecords(che.brain).filter((r) => r.source.event === 'quiz');
  assert.equal(answers.length, 4);
  assert.ok(answers.every((r) => r.verification === 'owner_practice' && typeof r.source.correct === 'boolean' && /Owner's answer: /.test(r.body)));
  assert.deepEqual(answers.map((r) => r.source.correct).sort(), [false, false, true, true]);

  for (const words of variants('What have I learned so far?')) {
    const out = await che.say(words, { keep: false });
    assert.match(out.reply, new RegExp(`^Your Knowledge Atlas progress, sir, measured from this chat: 1 lesson studied, on 1 of ${ATLAS_CARDS.length} cards; 4 quiz answers, 2 correct \\(50%\\)\\.`), words);
    assert.match(out.reply, /Latest lessons: Loops and iteration, beginner level, \d{4}-\d\d-\d\d\./);
    assert.match(out.reply, /Latest answers: Loops and iteration question 2, not correct; Loops and iteration question 1, correct; /);
    assert.match(out.reply, /Source: 5 practice records in CHE's Brain, Knowledge Atlas folder, labelled owner practice\. They record your study in this chat, not facts you told me\./);
  }
  const tradingOnly = await che.say('how am i doing on trading', { keep: false });
  assert.match(tradingOnly.reply, /^No trading lessons recorded yet, sir\./, 'a domain counts only its own records');
});

test('the recorder is generic over a card, an item, a kind and a result (exercises and drills from the coding lane)', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  for (const c of [coding[0], trading[0]]) {
    const r = recordLearning(store, { card: c, kind: 'exercise', item_id: 'ex-1', correct: true }, { now: '2026-10-19T04:00:00.000Z' });
    assert.equal(r.outcome, 'created', c.id);
    recordLearning(store, { card: c, kind: 'drill', item_id: 'drill-2', correct: false }, { now: '2026-10-19T04:00:01.000Z' });
  }
  const rows = learningRecords(store);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.kind === 'atlas_progress' && r.verification === 'owner_practice'));
  assert.match(progressText(rows), /4 practice results, 2 correct \(50%\)/);
  assert.match(progressText(rows, 'trading'), /^Your trading Knowledge Atlas progress, sir, measured from this chat: 0 lessons studied, on 0 of \d+ trading cards; 0 quiz answers; 2 practice results, 1 correct \(50%\)\./);
  assert.equal(recordLearning(store, { card: null, kind: 'quiz' }).outcome, 'rejected', 'a record needs a card');
  // By card id, as the coding and trading lanes call it for their exercises and drills.
  const storage = storageFor();
  assert.equal(recordAtlasPractice(storage, { card_id: coding[0].id, item_id: 'drill-1', kind: 'drill', correct: true }).outcome, 'created');
  assert.equal(learningRecords(new CheBrainStore(storage))[0].source.event, 'drill');
  assert.equal(recordAtlasPractice(storage, { card_id: 'no-such-card', kind: 'drill', correct: true }).outcome, 'rejected');
  assert.equal(recordAtlasPractice({ get: async () => null }, { card_id: coding[0].id, kind: 'drill' }).outcome, 'rejected', 'no SQL, no record');
  assert.equal(recordLearning(null, { card: coding[0], kind: 'quiz' }).outcome, 'rejected', 'no Brain, no record, and no throw');
});

test('a numbered answer is graded by its number, recomputed; yes-or-no by the word; words only roughly', () => {
  for (const c of ATLAS_CARDS) {
    c.quiz.forEach((q, i) => {
      if (!q.check) return;
      const shown = q.check.shown.join(' and ');
      assert.equal(gradeQuizAnswer(c, i, shown).correct, true, `${c.id} q${i + 1}: the card's own shown answer "${shown}" is correct`);
      // A wrong number is wrong; for a check shown as a word ("sweep") a number is not an answer CHE can judge.
      assert.equal(gradeQuizAnswer(c, i, 'I think 987654').correct, /\d/.test(shown) ? false : null, `${c.id} q${i + 1}: a wrong number is not`);
    });
  }
  // A check shown as a word is graded by that word, not by the question's own numbers.
  const liquidity = atlasCard('t-liquidity');
  assert.equal(gradeQuizAnswer(liquidity, 1, 'a buy-side sweep').correct, true);
  assert.notEqual(gradeQuizAnswer(liquidity, 1, 'it traded above 100').correct, true, 'the question\'s own number is not the answer');
  for (const denied of ['not a sweep', 'it\'s a break, not a sweep', 'no sweep, a break']) assert.notEqual(gradeQuizAnswer(liquidity, 1, denied).correct, true, denied);
  const variables = atlasCard('variables');
  assert.equal(gradeQuizAnswer(variables, 1, 'yes they both see it').correct, true);
  assert.equal(gradeQuizAnswer(variables, 1, 'no').correct, false);
  assert.equal(gradeQuizAnswer(atlasCard('r-multiple'), 0, 'minus 2R').correct, false, 'the sign counts');
  assert.equal(gradeQuizAnswer(atlasCard('tick-value'), 0, 'fifty cents').correct, true, 'spoken money');
  assert.equal(gradeQuizAnswer(variables, 9, 'x'), null, 'no such question');
});

test('"what should I study next" follows the prerequisites from what was studied', sqlite, async () => {
  const che = await owner();
  const first = await che.say('What lesson should I study next?', { keep: false });
  const start = coding.find((c) => !c.prerequisites.length);
  assert.equal(first.route, 'che_knowledge_atlas');
  assert.match(first.reply, new RegExp(`^Next for you, sir: ${start.title}, ${start.level} level\\. .*No lessons are recorded yet, so this is where the curriculum starts\\. For trading, the first card is ${trading[0].title}\\.`));
  for (const words of [...variants('What should I study next in trading?'), ...variants('What should I study next in the Knowledge Atlas?').slice(0, 2)].slice(0, 6)) {
    const out = await che.say(words, { keep: false });
    if (/trading/.test(words)) assert.match(out.reply, new RegExp(`^Next for you, sir: ${trading.find((c) => !c.prerequisites.length).title},`), words);
    else assert.match(out.reply, /^Next for you, sir: /, words);
  }
  // Study cards out of order; the next card must be one whose every prerequisite is studied.
  const studied = new Set();
  for (const c of [coding[0], coding[2], coding[1]]) { await che.say(`teach me ${c.aliases[0]}`, { keep: false }); studied.add(c.id); }
  const out = await che.say('what lesson should i study next', { keep: false });
  const { card } = nextToStudy(learningRecords(che.brain));
  assert.equal(out.done.atlas_card, card.id);
  assert.ok(!studied.has(card.id), 'not one already studied');
  assert.ok(card.prerequisites.every((p) => studied.has(p)), `${card.id}: every prerequisite studied`);
  for (const c of coding.slice(0, coding.indexOf(card))) assert.ok(studied.has(c.id) || c.prerequisites.some((p) => !studied.has(p)), `${c.id} came first only if it was not ready`);
  if (card.prerequisites.length) assert.match(out.reply, /Its prerequisites?, .+, (?:is|are) in your studied lessons\./);
  // "Teach me this" then takes the suggested card, from the reply's own source line.
  const next = await che.say('teach me this', { history: [{ role: 'assistant', content: out.reply }], keep: false });
  assert.match(next.reply, new RegExp(`^${card.title}, beginner level, sir\\.`));
  // Right after a lesson, "what should I learn next" keeps its curriculum meaning (the card after this one).
  const lesson = await che.say('teach me recursion', { keep: false });
  const after = await che.say('what should I learn next', { history: [{ role: 'assistant', content: lesson.reply }], keep: false });
  assert.match(after.reply, /^After Recursion comes /);
});

test('"reset my progress" is a delete: held for the owner\'s yes, and only then are his practice records removed', sqlite, async () => {
  const che = await owner();
  await che.say('teach me recursion', { keep: false });
  await che.say('teach me expectancy', { keep: false });
  assert.equal(learningRecords(che.brain).length, 2);
  for (const words of ['Reset my progress', 'reset my learning progress', 'CHE, clear my trading quiz scores', 'delete my knowledge atlas progress']) {
    assert.ok(classifyOwnerActions(words).includes('delete'), `${words} is a delete`);
    assert.ok(atlasResetIntent(words), words);
    assert.equal(atlasIntent(words), null, 'never answered as a lesson');
  }
  const held = await che.say('Reset my progress');
  assert.equal(held.route, 'held');
  assert.equal(held.reply, 'Before I delete anything, I need your yes: delete your 2 Knowledge Atlas practice records (lessons studied, quiz answers and practice results)? The cards and your memories stay. Should I go ahead?', 'the hold names the target and the count');
  assert.equal(learningRecords(che.brain).length, 2, 'nothing deleted while it waits');
  const declined = await che.say('no thanks');
  assert.notEqual(declined.done.atlas_kind, 'reset');
  assert.equal(learningRecords(che.brain).length, 2, 'a no deletes nothing');

  await che.say('reset my progress');
  const done = await che.say('yes');
  assert.equal(done.route, 'che_knowledge_atlas');
  assert.equal(done.done.atlas_kind, 'reset');
  assert.match(done.reply, /^Done, sir\. I deleted 2 practice records of your Knowledge Atlas progress: lessons studied, quiz answers and practice results\. The cards themselves are unchanged/);
  assert.equal(learningRecords(che.brain).length, 0);
  assert.equal(che.brain.status().by_kind.concept_card, ATLAS_CARDS.length, 'the cards stay');
  assert.match((await che.say('what have I learned so far', { keep: false })).reply, /^No lessons recorded yet, sir\./);
});

test('a correction that names the card is recorded as his statement about it, and the card is not claimed fixed', sqlite, async () => {
  const che = await owner();
  await che.say('teach me vwap');
  for (const words of ['Your lesson on VWAP is wrong, it resets every session.', 'your lesson on vwap is wrong it resets every session']) {
    const fix = await che.say(words, { keep: false });
    assert.equal(fix.route, 'che_knowledge_atlas', fix.reply);
    assert.match(fix.reply, /^Thank you, sir\. I recorded your correction to the VWAP card in your Brain\./);
    assert.match(fix.reply, /changes only when it is fixed and its tests pass/);
  }
  const rec = learningRecords(che.brain).find((r) => r.source.event === 'correction');
  assert.match(rec.body, /What the owner said is wrong: it resets every session/);
  assert.match(rec.body, /The owner's own statement about this card, as he said it in this chat\. The card is unchanged until it is fixed and tested\./);
  assert.equal(rec.verification, 'owner_attested', 'his own words about the card');
  assert.equal(rec.source.provenance, "the owner's statement about this card, in this chat");
  // Named with no lesson just before, or "that formula" right after one.
  assert.equal((await che.say('the recursion card is wrong', { keep: false, history: [] })).done.atlas_card, 'recursion');
  const lesson = await che.say('teach me expectancy', { keep: false });
  assert.equal((await che.say('that formula is wrong', { keep: false, history: [{ role: 'assistant', content: lesson.reply }] })).done.atlas_card, 'expectancy');
});

// ─── Relevant retrieval, with few tokens ──────────────────────────────────

// Coding and trading questions the atlas does not answer itself, so they reach the language model.
const RELATED = [
  'why does my recursion in python hit the maximum call stack',
  'should I use a hash map or an array for a lookup table in javascript',
  'my unit tests pass locally but fail in github actions, why',
  'is merge sort faster than quicksort for linked lists',
  'why is my async function in dart not waiting for the result',
  'is the time complexity of my nested for loops in python quadratic',
  'which http status codes should my cloudflare worker return for a bad request',
  'why does binary search on my sorted array in javascript return the wrong index',
  'should my rest api in node return json or xml',
  'can closures in javascript cause memory leaks',
  'my variables in dart keep showing null, why',
  'is test driven development worth it for a small flutter app',
  'why is amdahls law so pessimistic about adding more cores',
  'do hash tables in python keep insertion order',
  "what's a good recursion depth limit for a json parser in python",
  'should I move my stop loss to breakeven after a 10 point gain on mnq',
  'is a profit factor of 1.3 good enough for a scalping strategy',
  'why does my backtest win rate look so much better than paper trading',
  'how big a drawdown should I expect from a strategy like mine',
  'does vwap work better on nq or es for intraday entries',
  'is my sample size of 30 trades enough to trust the results',
  'why is slippage worse at the new york open on mnq',
  'should my position size change after three losing trades in a row',
  'can a strategy with negative expectancy still have a high win rate',
  'is walk forward testing better than a single out of sample split for my futures strategy',
  'my r multiple on losing trades is worse than minus one, what am I doing wrong',
  'why does the bid ask spread widen before economic news',
  'is risk per trade of 2 percent too aggressive for a small futures account',
  'how does overfitting show up when I optimize moving average lengths',
  'does the tick value of mnq change with the contract month',
];
const UNRELATED = [
  "what's the weather like in phoenix tomorrow",
  'remind me to call mom at five',
  'what is the function of the liver',
  'is there a road closure on interstate 17 today',
  'how do I sort my laundry by color',
  "what's the risk of rain this weekend",
  'play some relaxing music',
  'tell me a joke about cats',
  'how fast does the flu spread in winter',
  "what's a good recipe for chicken soup",
  'my blood tests came back normal, what does ldl mean',
  "I'm stuck in a loop of bad sleep, any advice",
  'who won the football game last night',
  'translate good morning into spanish',
  'what time is it in tokyo',
  "what's the scope of the kitchen remodel",
  'how much sizing should I leave around a picture frame',
  'write a birthday message for my sister',
  'what are the variable costs of running a food truck',
  'summarize my emails from today',
];

const HEAD = /^Knowledge Atlas \(curated teaching cards: reference, not the owner's words, not measured results\):\n- /;

test('retrieval: an unrelated question carries 0 atlas characters; a related one at most two cards in 600', () => {
  assert.equal(RELATED.length, 30);
  assert.equal(UNRELATED.length, 20);
  for (const q of RELATED) {
    assert.equal(atlasIntent(q), null, `${q}: goes to the language model, not the deterministic lesson`);
    const ctx = atlasPromptContext(q);
    assert.ok(ctx.length > 0 && ctx.length <= ATLAS_PROMPT_MAX, `${q}: ${ctx.length} characters`);
    assert.match(ctx, HEAD, q);
    assert.ok(atlasRelevantCards(q).length >= 1 && atlasRelevantCards(q).length <= 2, q);
    assert.equal(atlasPromptContext(`CHE, ${q}`), ctx, 'spoken with her name, the same cards');
    assert.equal(atlasPromptContext(spoken(q)), ctx, 'unpunctuated speech, the same cards');
  }
  for (const q of UNRELATED) assert.equal(atlasPromptContext(q), '', q);
  // Whole words only (#357): "trade-offs" is not a trading word, so it never lends a card its domain.
  for (const q of ['what are the trade-offs here', 'what are the trade-offs of a wide spread', 'what are the trade-offs of sizing']) assert.equal(atlasPromptContext(q), '', q);
  assert.deepEqual(atlasRelevantCards('the trade-offs of a hash map in python').map((c) => c.id), ['hash-maps']);
  // Each excerpt is the card's definition and its formula, not the whole lesson.
  const vwap = atlasPromptContext('does vwap work better on nq or es for intraday entries');
  assert.ok(vwap.includes(atlasCard('vwap').summary) && vwap.includes(atlasCard('vwap').formula.expression));
  assert.ok(!vwap.includes(atlasCard('vwap').levels.expert), 'no long explanation');
});

test('retrieval through /api/chat: the model\'s prompt gains at most 600 characters, and only for coding and trading', sqlite, async (t) => {
  const che = await owner();
  const added = [];
  const sizes = [];
  for (const q of RELATED) {
    const out = await che.say(q, { keep: false });
    if (out.route !== 'model') continue;
    const excerpt = atlasPromptContext(q);
    const prompt = out.prompts.find((p) => p.includes(excerpt));
    assert.ok(prompt, `${q}: the reply model read the excerpt`);
    assert.equal(prompt.split('Knowledge Atlas (curated teaching cards').length - 1, 1, `${q}: once`);
    added.push(excerpt.length + 1);
    sizes.push(prompt.length);
  }
  assert.ok(added.length >= 25, `${added.length} of 30 reached the model`);
  for (const q of UNRELATED) {
    const out = await che.say(q, { keep: false });
    for (const p of out.prompts) assert.ok(!p.includes('Knowledge Atlas (curated'), `${q}: no atlas text`);
  }
  const mean = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
  assert.ok(Math.max(...added) <= ATLAS_PROMPT_MAX + 1, 'within the 600-character budget');
  // The budget: 600 characters (about 150 tokens), under a quarter of the smallest block the compact
  // prompt already allows (owner memories, 2,500 characters), and a small share of either prompt.
  assert.ok(ATLAS_PROMPT_MAX * 4 <= 2500);
  assert.ok(Math.max(...added.map((a, i) => a / (sizes[i] - a))) < 0.15, 'a small share of the prompt it joins');
  const split = (small) => sizes.map((s, i) => [s - added[i], s]).filter(([b]) => (b < 10_000) === small);
  for (const [name, rows] of [['compact', split(true)], ['full', split(false)]]) {
    if (rows.length) t.diagnostic(`${name} prompt (${rows.length}): before mean ${mean(rows.map((r) => r[0]))} chars, after mean ${mean(rows.map((r) => r[1]))} chars`);
  }
  t.diagnostic(`atlas excerpt: ${added.length} related prompts, added mean ${mean(added)} max ${Math.max(...added)} chars (~${Math.round(mean(added) / 4)} tokens); unrelated: 0 added`);
});

// ─── Guests and the owner's own words ─────────────────────────────────────

test('a guest gets no progress, no practice record, no reset and no atlas text in the model\'s prompt', sqlite, async () => {
  const che = await owner();
  await che.say('teach me recursion', { keep: false });
  const before = learningRecords(che.brain).length;
  const guest = await guestOf(che);
  for (const words of ['What have I learned so far?', 'teach me loops', 'reset my progress', 'yes', 'why does my recursion in python hit the maximum call stack']) {
    const out = await che.say(words, { as: guest, keep: false });
    assert.notEqual(out.route, 'che_knowledge_atlas', `${words} → ${out.route}`);
    assert.doesNotMatch(out.reply, /Knowledge Atlas progress|practice records?/);
    for (const p of out.prompts) assert.ok(!p.includes('Knowledge Atlas (curated'), `${words}: no atlas text for a guest`);
  }
  assert.equal(learningRecords(che.brain).length, before, 'the owner\'s practice records are untouched by a guest');
});

test('a memory question never cites an atlas card as the owner\'s words', sqlite, async () => {
  const che = await owner();
  await che.say('teach me recursion', { keep: false });
  await che.say('quiz me on recursion');
  await che.say('number 1 is 15');
  for (const words of ['What did I tell you about recursion?', 'what did i tell you about recursion', 'CHE, what did I say about expectancy?', 'Do you remember what I said about hash maps?']) {
    const out = await che.say(words, { keep: false });
    assert.notEqual(out.route, 'che_knowledge_atlas', words);
    assert.doesNotMatch(out.reply, /Knowledge Atlas|curated|calling itself|Russian nesting dolls/, `${words}: no card text offered as his words`);
    for (const p of out.prompts) assert.ok(!p.includes('Knowledge Atlas (curated'), `${words}: no atlas excerpt beside his memories`);
  }
});

test('counter-cases keep their routes: a bare "how am I doing", measured questions and other clears', sqlite, async () => {
  const che = await owner();
  assert.notEqual((await che.say('how am I doing', { keep: false })).route, 'che_knowledge_atlas', 'alone it could mean anything');
  assert.notEqual((await che.say("what's my win rate", { keep: false })).route, 'che_knowledge_atlas', 'CHE\'s measured numbers, not progress');
  for (const words of ['reset my thoughts', 'clear the screen']) assert.deepEqual(classifyOwnerActions(words), [], `${words} is still ordinary chat`);
  assert.equal(atlasResetIntent('reset the timer'), null);
  assert.equal(atlasIntent('number 3 is 55'), null, 'an answer needs the quiz it answers');
  for (const words of ['what should I do next', 'suggest a topic', 'what should I read', 'show my results in trading', "what's my progress", 'what did I learn', 'what have I covered', 'what have I studied', 'what should I study next', 'what have I learned so far', 'show my history']) {
    assert.equal(atlasIntent(words), null, `${words}: not about the atlas without an atlas word or an atlas reply just before`);
    assert.notEqual((await che.say(words, { keep: false, history: [] })).route, 'che_knowledge_atlas', words);
  }
});

// ─── Review of acd7286: ordinary sentences are never answers, corrections or resets ─────

test('after a quiz, ordinary sentences are never graded or saved as practice, and a memory still saves', sqlite, async () => {
  const che = await owner({ model: (m) => (/remember that/i.test(m) ? 'Noted, sir.\n```che-remember\n[People] The owner\'s mom\'s birthday is Friday\n```' : '') });
  const ordinary = [
    'no one told me about the meeting', 'first tell me the time', 'I think we should stop the quiz', 'is it raining in Denver',
    'answer the email from Bob', 'one more thing email Bob the report', 'two tickets for tonight please', 'number 3 is my favorite',
    'I say we switch to live trading', 'I think I want to buy two calls', "I think my mom's birthday is Friday, remember that",
    'my answer is send it to Bob', 'number 2 is what time is it?', 'answer 1: delete my notes', 'my answer is my wife knows',
  ];
  for (const words of ordinary) {
    const quiz = await che.say('quiz me on recursion', { keep: false, history: [] });
    const out = await che.say(words, { keep: false, history: [{ role: 'user', content: 'quiz me on recursion' }, { role: 'assistant', content: quiz.reply }] });
    assert.notEqual(out.done.atlas_kind, 'grade', `${words} → graded`);
    assert.doesNotMatch(out.reply, /^(?:Question \d+ on|Quiz finished on)/, words);
    // The phone saves a memory from the reply's che-remember block, so the model must answer this one.
    if (/remember that/.test(words)) assert.ok(out.route === 'model' && /```che-remember\n\[People\] The owner's mom's birthday is Friday/.test(out.reply), `the memory sentence still saves: ${out.route}`);
  }
  assert.equal(learningRecords(che.brain).filter((r) => r.source.event === 'quiz').length, 0, 'no practice record was written');
  // The explicit forms still grade.
  const quiz = await che.say('quiz me on recursion', { keep: false, history: [] });
  const graded = await che.say('number 1 is a base case and a recursive case', { keep: false, history: [{ role: 'assistant', content: quiz.reply }] });
  assert.equal(graded.done.atlas_kind, 'grade');
});

test('a memory statement after a lesson is never filed as a card correction', sqlite, async () => {
  const che = await owner();
  await che.post('/api/memory/add', { memory: 'My name is Wesley' });
  for (const words of ["that's wrong, my name is Wes", "you're wrong, I live in Denver now", "no, that's wrong, I said Tuesday not Thursday", "that is incorrect, my wife's name is Ana", 'your recursion card is wrong, my name is Wes']) {
    const lesson = await che.say('teach me recursion', { keep: false, history: [] });
    const out = await che.say(words, { keep: false, history: [{ role: 'user', content: 'teach me recursion' }, { role: 'assistant', content: lesson.reply }] });
    assert.notEqual(out.done.atlas_kind, 'correction', words);
    assert.doesNotMatch(out.reply, /I recorded your correction/, words);
  }
  assert.equal(learningRecords(che.brain).filter((r) => r.source.event === 'correction').length, 0);
});

test('an approved "delete my history" or "clear my records" never touches atlas progress', sqlite, async () => {
  const che = await owner();
  await che.say('teach me recursion', { keep: false });
  for (const words of ['delete my history', 'clear my records', 'clear my trading history', 'delete my trading records']) {
    assert.equal(atlasResetIntent(words), null, words);
    assert.equal((await che.say(words)).route, 'held', `${words} is still held as a delete`);
    const yes = await che.say('yes');
    assert.notEqual(yes.done.atlas_kind, 'reset', words);
    assert.equal(learningRecords(che.brain).length, 1, `${words}: the practice record is still there`);
  }
  for (const words of ['reset my progress', 'clear my lesson history', 'delete my quiz records', 'delete my history in the knowledge atlas']) assert.ok(atlasResetIntent(words), words);
});

test('only an explicit lesson request records a study; definitions and readbacks do not', sqlite, async () => {
  const che = await owner();
  for (const words of ['what is risk', 'explain the drawdown', 'explain expectancy', 'define expectancy', 'knowledge atlas expectancy', 'what is win rate']) await che.say(words, { keep: false });
  assert.equal(learningRecords(che.brain).length, 0, 'no study recorded');
  const taught = await che.say('teach me expectancy', { keep: false });
  await che.say('give me the expert version', { keep: false, history: [{ role: 'assistant', content: taught.reply }] });
  assert.deepEqual(learningRecords(che.brain).map((r) => r.source.level).sort(), ['beginner', 'expert']);
});

test('a held Gmail send does not survive a quiz answer or a reset: the later yes sends nothing', sqlite, async () => {
  const che = await owner();
  const hold = () => che.storage.put('pending_google_action', { intent: { kind: 'gmail_send', to: 'bob@example.com', subject: 'Report', body: 'The report is ready.' }, at: Date.now(), summary: 'The email to bob@example.com' });
  const quiz = await che.say('quiz me on loops', { keep: false, history: [] });
  await hold();
  const graded = await che.say('my answer is no', { keep: false, history: [{ role: 'assistant', content: quiz.reply }] });
  assert.equal(graded.done.atlas_kind, 'grade');
  assert.equal(await che.storage.get('pending_google_action'), null, 'the grade turn dropped the held email');
  let yes = await che.say('yes', { keep: false, history: [] });
  assert.notEqual(yes.done.source, 'che_google');
  assert.doesNotMatch(yes.reply, /bob@example\.com/);

  await che.say('teach me loops', { keep: false });
  await hold();
  assert.equal((await che.say('reset my progress', { keep: false, history: [] })).route, 'held');
  const reset = await che.say('yes', { keep: false, history: [] });
  assert.equal(reset.done.atlas_kind, 'reset');
  assert.equal(await che.storage.get('pending_google_action'), null, 'the reset dropped the held email');
  yes = await che.say('yes', { keep: false, history: [] });
  assert.notEqual(yes.done.source, 'che_google');
  assert.doesNotMatch(yes.reply, /bob@example\.com/);
});

test('review nits: a phone edit of a card is kept, capped counts say so, and a list of guesses is not an answer', sqlite, () => {
  const store = new CheBrainStore(storageFor());
  projectAtlasToBrain(store);
  const c = ATLAS_CARDS[0];
  const mine = store.get(`atlas:${c.id}`);
  store.apply({ type: 'put', record: { ...mine, body: 'The owner rewrote this card on his phone.' }, base_rev: mine.rev }, { origin: 'iphone' });
  const meta = store.meta('atlas_projection');
  store.setMeta('atlas_projection', { ...meta, hashes: { ...meta.hashes, [`atlas:${c.id}`]: 'stale' } });
  projectAtlasToBrain(store);
  assert.equal(store.get(`atlas:${c.id}`).body, 'The owner rewrote this card on his phone.', 'a card revision never overwrites his edit');

  const rows = Object.assign([{ source: { event: 'lesson', card_id: c.id, domain: c.domain, level: 'beginner' }, created_at: '2026-10-19T00:00:00Z' }], { capped: true });
  assert.match(progressText(rows), /These counts are from your newest 1 practice records only; older ones are not counted\./);

  const loops = atlasCard('loops');
  assert.equal(gradeQuizAnswer(loops, 2, '55').correct, true);
  assert.equal(gradeQuizAnswer(loops, 2, '10 or 55 or 100').correct, null, 'a list of guesses is never correct');
  assert.equal(gradeQuizAnswer(loops, 2, '10 and then 55').correct, false, 'the main number must match');
});

// ─── Re-review of c1ab5c0: the grader judges only what it can, and an answer is never a hidden request ─────

test('a no answer may repeat its no: "no, it doesn\'t" is right where the card says no, and wrong where it says yes', () => {
  let checked = 0;
  for (const c of ATLAS_CARDS) {
    c.quiz.forEach((q, i) => {
      if (/^no\b/i.test(q.a)) {
        checked++;
        assert.equal(gradeQuizAnswer(c, i, "no, it doesn't").correct, true, `${c.id} q${i + 1}`);
        assert.equal(gradeQuizAnswer(c, i, 'no, it does not').correct, true, `${c.id} q${i + 1}`);
        assert.equal(gradeQuizAnswer(c, i, 'yes').correct, false, `${c.id} q${i + 1}`);
        assert.equal(gradeQuizAnswer(c, i, 'no, or maybe yes').correct, null, `${c.id} q${i + 1}: a hedge is still not graded`);
      }
      if (/^yes\b/i.test(q.a)) assert.notEqual(gradeQuizAnswer(c, i, 'no, it does not').correct, true, `${c.id} q${i + 1}`);
    });
  }
  assert.ok(checked >= 5, 'the atlas has questions whose answer is no');
});

test('every quiz question in the atlas passes with its own answer: never graded wrong (all cards, every lane)', () => {
  let checked = 0;
  for (const c of ATLAS_CARDS) {
    c.quiz.forEach((q, i) => {
      // The card's own answer, its first sentence, and its first clause (independently: up to the first mark).
      for (const form of [q.a, q.a.split(/[.;:!?](?=\s|$)/)[0], firstClause(q.a), q.a.split(/[.;:!?](?=\s|$)|,\s/)[0]]) {
        const r = gradeQuizAnswer(c, i, form);
        assert.notEqual(r.correct, false, `${c.id} question ${i + 1}: "${form}" is the card's own answer (${r.method})`);
        checked += 1;
      }
    });
  }
  assert.ok(checked >= ATLAS_CARDS.length * 3 * 4, `${checked} answers graded`);
});

test('the reviewer\'s right answers are correct; wrong ones are wrong; what CHE cannot judge is not graded', () => {
  const g = (id, i, a) => gradeQuizAnswer(atlasCard(id), i, a).correct;
  for (const [id, i, a] of [
    ['bid-ask-spread', 1, 'the ask'], ['bid-ask-spread', 1, 'you pay the ask'], ['drawdown', 0, '25%'], ['drawdown', 0, '25 percent'], ['drawdown', 0, '0.25'],
    ['drawdown', 1, '33.3%'], ['tick-value', 2, 'ten'], ['big-o', 0, 'O of n squared'], ['big-o', 0, 'O(n^2)'], ['big-o', 0, 'O(n²)'], ['big-o', 1, 'O of n'],
    ['sorting', 0, 'O of n log n'], ['recursion', 0, 'a base case and a recursive case'], ['expectancy', 2, 'the sample is too small'],
    ['http-apis', 1, 'GET, PUT and DELETE'], ['risk-management', 2, '$100'], ['recursion', 1, 'six'], ['concurrency', 1, 'about one second'],
  ]) assert.equal(g(id, i, a), true, `${id} q${i + 1}: ${a}`);
  for (const [id, i, a] of [['big-o', 1, 'O of n squared'], ['recursion', 1, '16'], ['risk-management', 2, '$200'], ['r-multiple', 1, '1R'], ['concurrency', 1, '3 seconds']]) {
    assert.equal(g(id, i, a), false, `${id} q${i + 1}: ${a}`);
  }
  for (const [id, i, a] of [['win-rate-ci', 0, 'yes'], ['http-apis', 0, '400s'], ['loops', 1, 'n items']]) assert.equal(g(id, i, a), null, `${id} q${i + 1}: ${a} cannot be judged`);
});

test('through /api/chat: a right answer is recorded correct, an ungradeable one as not graded, never as wrong', sqlite, async () => {
  const che = await owner();
  const quiz = await che.say('quiz me on bid ask spread');
  assert.match(quiz.reply, /^Quiz on Bid, ask and spread, sir\./);
  const right = await che.say('number 2 is the ask');
  assert.match(right.reply, /^Question 2 on Bid, ask and spread, sir: correct\./);
  const progress = await che.say('how am I doing', { keep: false });
  assert.match(progress.reply, /1 quiz answer, 1 correct \(100%\)/);
  const wilson = await che.say('quiz me on win rate confidence interval', { keep: false, history: [] });
  const cannot = await che.say('number 1 is yes', { keep: false, history: [{ role: 'assistant', content: wilson.reply }] });
  assert.match(cannot.reply, /^Question 1 on Win rate and its confidence interval, sir: I can't grade that one automatically\. You said: yes\. The card's answer is: /);
  assert.match(cannot.reply, /Recorded in your Brain as not graded, never as wrong\./);
  const rows = learningRecords(che.brain).filter((r) => r.source.event === 'quiz');
  assert.deepEqual(rows.map((r) => r.source.correct), [null, true]);
  assert.match((await che.say('how am I doing on trading', { keep: false })).reply, /2 quiz answers, 1 correct of 1 graded \(100%\), 1 not graded/);
  const exp = await che.say('quiz me on expectancy', { keep: false, history: [] });
  const small = await che.say('my answer is the sample is too small', { keep: false, history: [{ role: 'assistant', content: `Question 2 on Expectancy, sir: correct.\n${exp.reply.split('\n').pop()}` }] });
  assert.match(small.reply, /^Quiz finished on Expectancy, sir\. Question 3: correct\./);
});

test('an answer in the card\'s own words is graded, never held; a real request in an answer form is held like the bare sentence', sqlite, async () => {
  const che = await owner();
  const http = await che.say('quiz me on http and apis', { keep: false, history: [] });
  const after = (reply) => [{ role: 'assistant', content: reply }];
  const methods = await che.say('number 2 is GET, PUT and DELETE', { keep: false, history: after(http.reply) });
  assert.equal(methods.done.atlas_kind, 'grade', `${methods.route}: ${methods.reply.slice(0, 80)}`);
  assert.match(methods.reply, /: correct\./);
  const ask = await che.say('quiz me on bid ask spread', { keep: false, history: [] });
  const pay = await che.say('number 2 is you pay the ask', { keep: false, history: after(ask.reply) });
  assert.match(pay.reply, /^Question 2 on Bid, ask and spread, sir: correct\./);
  // Real requests: held for a yes, in a quiz or not, and the held words are the bare request.
  const cases = [
    ['number 2 is delete my notes', http.reply, 'delete my notes'], ['my answer is buy two calls', ask.reply, 'buy two calls'],
    ['answer 1: delete my notes', '', 'delete my notes'], ['my answer is delete my notes', '', 'delete my notes'],
    ['number 2 is buy two calls', '', 'buy two calls'], ['answer 1 is pay my electric bill', '', 'pay my electric bill'],
  ];
  for (const [words, reply, bare] of cases) {
    const out = await che.say(words, { keep: false, history: reply ? after(reply) : [] });
    assert.equal(out.route, 'held', `${words} → ${out.route}: ${out.reply.slice(0, 80)}`);
    assert.equal((await che.storage.get('che:pending_owner_action'))?.text, bare, `${words}: the yes would run "${bare}"`);
    await che.say('no', { keep: false, history: [] });
  }
  assert.equal(learningRecords(che.brain).filter((r) => r.source.event === 'quiz').length, 2, 'only the two real answers were graded');
});

test('a newer curated card after the owner\'s edit waits as a sync conflict, and the lesson says so once', sqlite, async () => {
  const storage = storageFor();
  const store = new CheBrainStore(storage);
  projectAtlasToBrain(store);
  const c = atlasCard('recursion');
  const mine = store.get('atlas:recursion');
  store.apply({ type: 'put', record: { ...mine, body: 'The owner rewrote this card on his phone.' }, base_rev: mine.rev }, { origin: 'iphone' });
  // A newer curated revision: the remembered hash no longer matches the card.
  const meta = store.meta('atlas_projection');
  store.setMeta('atlas_projection', { ...meta, hashes: { ...meta.hashes, 'atlas:recursion': 'older-revision' } });
  const run = projectAtlasToBrain(store);
  assert.equal(run.conflicts, 1);
  assert.equal(store.get('atlas:recursion').body, 'The owner rewrote this card on his phone.', 'his copy is kept');
  const open = store.conflicts().filter((x) => x.record_id === 'atlas:recursion');
  assert.equal(open.length, 1, 'the curated card waits beside it');
  assert.equal(open[0].incoming.body, atlasBrainRecord(c).body);
  assert.equal(projectAtlasToBrain(store).conflicts, 0, 'and is not filed again');
  const first = await answerAtlas({ kind: 'teach', card: c, level: 'beginner', study: true }, { storage });
  assert.match(first.text, /Note: you edited this card in your Brain, so I kept your copy\. This lesson reads the newer curated revision \d+, which waits beside your copy as an open sync conflict for you to choose\./);
  const second = await answerAtlas({ kind: 'teach', card: c, level: 'beginner', study: true }, { storage });
  assert.doesNotMatch(second.text, /you edited this card/, 'said once');
});

// ─── Re-review #3: denials, contrasts and hedges are never graded correct, nor learned as speech fixes ─────

test('across every card, a denial, a contrast or a hedge of the card\'s own answer is never graded correct', () => {
  let checked = 0;
  for (const c of ATLAS_CARDS) {
    c.quiz.forEach((q, i) => {
      const fc = firstClause(q.a);
      for (const form of [`not ${fc}`, `${fc}, not ${fc}`, `${fc} or something else`]) {
        const r = gradeQuizAnswer(c, i, form);
        assert.notEqual(r.correct, true, `${c.id} question ${i + 1}: "${form}" (${r.method})`);
        checked += 1;
      }
    });
  }
  assert.equal(checked, ATLAS_CARDS.reduce((n, c) => n + c.quiz.length, 0) * 3);
});

test('the reviewer\'s negated, contrastive, hedged, unit and multiplier answers', () => {
  const g = (id, i, a) => gradeQuizAnswer(atlasCard(id), i, a).correct;
  const liquidity = 't-liquidity';
  assert.ok(atlasCard(liquidity), 'the trading lane\'s liquidity card');
  for (const a of ['sweep', 'a buy-side sweep', 'it is a sweep']) assert.equal(g(liquidity, 1, a), true, a);
  for (const a of ['not a sweep', "it's a break, not a sweep", 'it is a breakout, not a sweep', 'no sweep, a breakout', 'a sell-side sweep', 'sweep or breakout']) {
    assert.notEqual(g(liquidity, 1, a), true, a);
  }
  assert.equal(g(liquidity, 1, 'a break'), false, 'the other option in the question');
  for (const [id, i, a] of [
    ['sorting', 0, 'not O of n log n'], ['big-o', 0, 'not O of n squared'], ['bid-ask-spread', 1, 'not the ask'], ['bid-ask-spread', 1, 'the bid, not the ask'],
    ['sample-size', 2, 'it is not selection bias'], ['http-apis', 0, 'not 4xx'], ['http-apis', 1, 'only POST, not GET, PUT and DELETE'], ['hash-maps', 0, 'not O of 1'],
    ['recursion', 0, 'a base case only, no recursive case'], ['testing', 1, 'to prove the test can never catch the bug'],
    ['recursion', 2, '15 or 177'], ['loops', 2, '10, 55 or 100'],
  ]) assert.equal(g(id, i, a), null, `${id} q${i + 1}: ${a} is not graded`);
  assert.equal(g('drawdown', 0, '25 dollars'), false, 'dollars are not percent');
  assert.equal(g('drawdown', 0, '25 percent'), true);
  assert.equal(g('risk-management', 2, 'ten thousand'), false, 'ten thousand is 10,000, not 10');
  assert.equal(g('risk-management', 2, '100 dollars'), true);
  assert.equal(g('risk-management', 2, '10k'), false);
  assert.equal(g('vwap', 2, 'not by itself'), true, 'the card\'s own "not" is its answer');
  assert.equal(g('functions', 1, 'no'), true);
  assert.equal(g('functions', 1, 'not no'), null);
});

test('through /api/chat: an "X, not Y" answer is graded as not graded, never learned as a speech correction', sqlite, async () => {
  const heard = [];
  const che = await owner({ model: (m) => { heard.push(m); return ''; } });
  const quiz = await che.say('quiz me on bid ask spread');
  const contrast = await che.say('number 2 is the bid, not the ask');
  assert.equal(contrast.done.atlas_kind, 'grade', contrast.reply.slice(0, 80));
  assert.match(contrast.reply, /^Question 2 on Bid, ask and spread, sir: I can't grade that one automatically\./);
  for (const words of ["number 2 is it's a break, not a sweep", 'number 3 is it is not selection bias', 'my answer is not O of n squared']) {
    await che.say(words, { keep: false, history: [{ role: 'assistant', content: quiz.reply }] });
  }
  assert.deepEqual((await che.storage.get('speech_corrections')) || [], [], 'no speech correction was learned');
  const next = await che.say('what is the ask on the MNQ spread right now', { keep: false, history: [] });
  assert.equal(next.route === 'model' || next.modelCalls > 0, true, next.route);
  assert.ok(heard.some((m) => m.endsWith('what is the ask on the MNQ spread right now')), `the model read his words: ${heard.slice(-1)}`);
  assert.ok(!heard.some((m) => /number 2 is the bid/.test(m)), 'never rewritten with the quiz answer');
  const liquidity = await che.say('quiz me on liquidity', { keep: false, history: [] });
  const breakout = await che.say('number 2 is no sweep, a breakout', { keep: false, history: [{ role: 'assistant', content: liquidity.reply }] });
  assert.equal(breakout.done.atlas_kind, 'grade');
  const rows = learningRecords(che.brain).filter((r) => r.source.event === 'quiz');
  assert.ok(rows.every((r) => r.source.correct !== true), 'nothing stored as correct');
  assert.ok(rows.some((r) => r.source.card_id === 't-liquidity' && r.source.correct === null));
});

test('a request held from an answer form keeps the owner\'s own words, case and all', sqlite, async () => {
  const che = await owner();
  const out = await che.say('Answer 1: delete Report-Q3.PDF from my files.', { keep: false, history: [] });
  assert.equal(out.route, 'held');
  assert.equal((await che.storage.get('che:pending_owner_action'))?.text, 'delete Report-Q3.PDF from my files.');
});
