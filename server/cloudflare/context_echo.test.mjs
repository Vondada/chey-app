// Context echo (run 22): stored text handed to the model is reference data, never the reply itself.
// The wording here is not from the certification bank: the rules must hold for any phrasing.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NO_RECORD_FOLLOW_UP, NO_RECORD_QUESTION, contextEchoStage, copiedShare, guardContextEcho, historyRecordsStage,
  historySummaryReply, longHistoryRequest, readConversations, stripSpeakerLabels,
} from './context_echo.js';

const OLD_ASK = 'Book me a table at the Italian place on Friday for six people and ask for the window seats please.';
const BRIEF = 'Office brief: blend a hand-drawn cooking explainer with talking vegetables and a moody night-market drama with recurring vendors and long tracking shots.';

test('rule 1: a speaker label copied from a transcript is taken off the reply', () => {
  assert.equal(stripSpeakerLabels('CHE: Sure thing, sir. The weather tool is not connected yet.').text, 'Sure thing, sir. The weather tool is not connected yet.');
  assert.equal(stripSpeakerLabels('You said: call the plumber. Owner: tomorrow.').count, 2);
  // "Note:" and "Step 1:" are not speakers.
  assert.equal(stripSpeakerLabels('Note: the oven is off. Step 1: wait.').count, 0);
  // A dialogue the owner asked for keeps its labels.
  const asked = 'Write a short dialogue between CHE and the owner about breakfast.';
  assert.equal(stripSpeakerLabels('CHE: Eggs? Owner: Always.', { message: asked }).count, 0);
});

test('rule 1: a transcript of labelled lines that does not take up the message is not an answer', async () => {
  const reply = 'CHE: Sir, I have a note that the owner likes hiking on weekends. CHE: Sir, I have no record of the owner confirming a birthday.';
  const out = await guardContextEcho(reply, { message: 'Carry on.' });
  assert.equal(out.text, NO_RECORD_FOLLOW_UP);
  assert.match(out.text, /continue/);
  assert.equal(out.removed[0].rule, 'transcript_echo');
});

test('rule 2: an old owner message from the Brain copied back as the answer becomes an honest no record', async () => {
  const out = await guardContextEcho(OLD_ASK, {
    message: 'What was the password you said you would hold for me?',
    brainContext: `[Chat; unverified; speaker owner; 2026-10-30] Owner message: ${OLD_ASK}`,
  });
  assert.equal(out.text, NO_RECORD_QUESTION);
  assert.match(out.text, /don't have a record/);
  assert.equal(out.removed[0].rule, 'context_echo');
});

test('rule 2: a stored note retold as a recollection for a vague request becomes a question back', async () => {
  const reply = `I remember now. I was going to ${BRIEF.replace('Office brief: ', '')}`;
  const out = await guardContextEcho(reply, { message: 'Wrap that up for me.', data: { memories: [BRIEF] } });
  assert.equal(out.text, NO_RECORD_FOLLOW_UP);
  assert.match(out.text, /Which/);
});

test('rule 2: remembered talks are checked too, loaded only when needed', async () => {
  let loads = 0;
  const remembered = async () => { loads++; return [OLD_ASK]; };
  const out = await guardContextEcho(OLD_ASK, { message: 'Do that thing from before.', remembered });
  assert.equal(out.text, NO_RECORD_FOLLOW_UP);
  assert.equal(loads, 1);
  // A reply that takes up the message never reads storage.
  await guardContextEcho('The garden hose is in the shed by the back fence, sir.', { message: 'Where is the garden hose?', remembered });
  assert.equal(loads, 1);
});

test('rule 2: a stored line that answers the message stays', async () => {
  const note = 'The Porto trip budget is 2000 euros for flights and the hotel in June.';
  const data = { memories: [note], memory_records: [{ text: 'My favorite food is pizza', verification_status: 'owner_attested' }] };
  const kept = async (reply, message) => assert.equal((await guardContextEcho(reply, { message, data })).text, reply);
  await kept(`Sir, ${note}`, 'What is the budget for the Porto trip?');
  await kept('Your favorite food is pizza, sir.', 'What is my favorite food?');
  // The owner asked for what is stored, or for his words back.
  await kept(`Here is what I have: ${note}`, 'What do you know about me?');
  await kept(OLD_ASK, 'Repeat my last request word for word.');
  // Text from this conversation, reworked: the owner's pasted essay with its typos fixed, a pasted transcript tidied.
  const essay = 'The harbor wakes early when the gulls start arguing over the night boats and the fish market opens its doors.';
  const fixed = (await guardContextEcho(essay, { message: 'Fix the typos.', data: { memories: [essay] }, ownerHistory: [{ role: 'user', content: essay.replace('arguing', 'arguign') }] })).text;
  assert.equal(fixed, essay);
  const pasted = 'Owner: can we move the call. CHE: yes, to noon.';
  assert.equal((await guardContextEcho('Owner: can we move the call? CHE: yes, to noon.', { message: 'Tidy this up.', ownerHistory: [{ role: 'user', content: pasted }] })).text, 'Owner: can we move the call? CHE: yes, to noon.');
  // An ordinary answer that copies nothing stays.
  await kept('Happy to keep going, sir. Which part should I pick up first?', 'Carry on.');
});

test('copiedShare measures word-for-word runs, not shared topics', () => {
  assert.equal(copiedShare(OLD_ASK, [OLD_ASK]).share, 1);
  assert.ok(copiedShare('I could book a window table for six on Friday at the Italian place.', [OLD_ASK]).share < 0.3);
});

test('rule 3: only a summary of a long conversation history is a history request', () => {
  assert.deepEqual(longHistoryRequest('Give me a recap of all our chats over the past two years about the bakery.'), { topic: ['bakery'], days: 730 });
  assert.equal(longHistoryRequest('Summarize my sales history over the last 6 months.'), null);
  // A possessive domain history is that record, not our talks (Codex review on #889).
  for (const ask of ['Summarize our sales history over the last six months.', 'Give me an overview of our order history for the past two years.',
    'Recap our project history over the whole year.', 'Summarise our medical history over the last five years.', 'Sum up our price history for three months.']) {
    assert.equal(longHistoryRequest(ask), null, ask);
  }
  assert.ok(longHistoryRequest('Recap our chats about my medical history over the past two years.'));
  assert.ok(longHistoryRequest('Summarise what we have discussed over the last four months about the garden.'));
  assert.equal(longHistoryRequest('Summarize this article about bakeries.'), null);
  assert.equal(longHistoryRequest('Recap what we just said.'), null);
});

const brainStorage = (rows) => ({
  list: async ({ prefix = '' } = {}) => new Map(rows.filter(([k]) => k.startsWith(prefix))),
  get: async () => undefined,
});

test('rule 3: the history summary gives counts and dates from the records, and says what is not recorded', async () => {
  const storage = brainStorage([
    ['brainmem:000001761955200000', { at: '2026-11-01T10:00:00Z', title: 'Can you price flour for the bakery opening?', body: 'You said: Can you price flour for the bakery opening?' }],
    ['brainmem:000001761868800000', { at: '2026-10-31T09:00:00Z', title: 'Set a timer', body: 'You said: Set a timer' }],
  ]);
  const data = { memory_records: [{ text: 'My bakery opens in March', source: 'owner_chat', verification_status: 'owner_attested', created_at: '2026-10-20T08:00:00Z' }] };
  const ask = longHistoryRequest('Give me a recap of all our chats over the past two years about the bakery.');
  const text = await historySummaryReply(ask, { data, storage, now: Date.parse('2026-11-02T00:00:00Z') });
  assert.match(text, /2 saved conversations and 1 stored memory, from 2026-10-20 to 2026-11-01/);
  assert.match(text, /2 mention bakery/);
  assert.match(text, /owner-stated\) "My bakery opens in March"/);
  assert.match(text, /starts on 2026-10-20; anything before that is not recorded/);
  assert.doesNotMatch(text, /you (?:told me|mentioned|said) your/i);
  const empty = await historySummaryReply(ask, { data: {}, storage: brainStorage([]) });
  assert.match(empty, /don't have a record of past conversations about bakery/);
});

test('the stages: echo runs on the model text, history only on the owner device', async () => {
  const ctx = { rawMessage: 'Carry on.', data: {}, ownerHistory: [], ownerDevice: false };
  const echo = await contextEchoStage.run('Owner: buy milk. CHE: noted, sir, and the eggs are on the list too.', ctx);
  assert.equal(echo.text, NO_RECORD_FOLLOW_UP);
  const guest = await historyRecordsStage.run('model text', { ...ctx, rawMessage: 'Summarise our five-year history of chats.' });
  assert.equal(guest.text, 'model text');
  const owner = await historyRecordsStage.run('model text', { ...ctx, ownerDevice: true, storage: brainStorage([]), rawMessage: 'Summarise our five-year history of chats.' });
  assert.match(owner.text, /don't have a record/);
});

// A storage that honours prefix, reverse, limit and end the way Durable Object storage does.
const pagedStorage = (rows) => ({
  get: async () => undefined,
  list: async ({ prefix = '', reverse = false, limit = Infinity, end } = {}) => {
    let keys = rows.map(([k]) => k).filter((k) => k.startsWith(prefix) && (end === undefined || k < end)).sort();
    if (reverse) keys.reverse();
    const map = new Map(rows);
    return new Map(keys.slice(0, limit).map((k) => [k, map.get(k)]));
  },
});
const talkRows = (n, startMs) => Array.from({ length: n }, (_, i) => {
  const ms = startMs + i * 60_000;
  return [`brainmem:${String(ms).padStart(15, '0')}_c${i}`, { id: `c${i}`, at: new Date(ms).toISOString(), title: `Note ${i}`, body: `You said: Note ${i}` }];
});

test('rule 3: older conversations are paged in; past the cap nothing is claimed absent (Codex review on #889)', async () => {
  const rows = talkRows(25, Date.parse('2024-01-01T00:00:00Z'));
  const all = await readConversations(pagedStorage(rows), { page: 10, pages: 5 });
  assert.equal(all.talks.length, 25);
  assert.equal(all.complete, true);
  const capped = await readConversations(pagedStorage(rows), { page: 10, pages: 2 });
  // Each page after the first repeats its boundary row (read one millisecond past it), and the ids drop the repeat.
  assert.equal(capped.talks.length, 19);
  assert.equal(capped.complete, false);
  const ask = longHistoryRequest('Give me a recap of all our chats over the past two years about the bakery.');
  const text = await historySummaryReply(ask, { data: {}, storage: pagedStorage(rows), pages: { page: 10, pages: 2 } });
  assert.match(text, /searched only the newest 19 saved conversations; older ones were not searched/);
  assert.match(text, /None of the ones I searched mention bakery/);
  assert.doesNotMatch(text, /not recorded|no record/);
});

test('rule 3: a topic in the stored talk body counts, not only its short title (Codex review on #889)', async () => {
  const long = 'Can you help me plan the opening weekend, the staff rota, the signage and the menu boards for the new bakery on Elm Street?';
  const storage = pagedStorage([['brainmem:000001761955200000_x', { id: 'x', at: '2026-11-01T10:00:00Z', title: long.slice(0, 90), body: `You said: ${long}` }]]);
  const text = await historySummaryReply(longHistoryRequest('Recap all our chats over the past year about the bakery.'), { data: {}, storage });
  assert.match(text, /1 mention bakery: 2026-11-01 \(conversation\)/);
});
