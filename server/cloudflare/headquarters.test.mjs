// CHE's 3D headquarters (owner mission, 2026-10-24): rooms come from the existing roster, status from records, and a
// head answers the owner from its own records before any model is asked. Nothing here is proven by an animation.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { HQ_ROOMS, hqView, roomForAgent, roomStatusFor, speakHqSummary, talkIntent, talkToHead } from './headquarters.js';
import { LA_AGENCIA_ROLES, ensureLaAgenciaRoster } from './office_company.js';
import { queueAgentTask } from './agent_runtime.js';
import { recordReceipt } from './truth_layer.js';

const generated = new URL('./.headquarters.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
let CheState;
try {
  ({ default: worker, CheState } = await import(`${generated.href}?test=${Date.now()}`));
} finally {
  try { unlinkSync(generated); } catch (_) {}
}

function memoryStorage() {
  const saved = new Map();
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

function officeData() {
  const data = { team: [], team_tasks: [], meetings: [], jobs: [], office_inbox: [] };
  ensureLaAgenciaRoster(data);
  return data;
}

const head = (data, name) => data.team.find((a) => a.name === name);

test('every room is led by the head the roster already names; nothing is overwritten', () => {
  assert.equal(HQ_ROOMS.length, 10);
  for (const room of HQ_ROOMS) {
    if (room.lead === 'CHE') { assert.equal(room.id, 'hq'); continue; }
    assert.equal(LA_AGENCIA_ROLES[room.lead].department.id, room.department, `${room.lead} leads ${room.department}`);
  }
  assert.equal(roomForAgent('knox').id, 'security');
  assert.equal(roomForAgent('Orion').id, 'markets');
  assert.equal(roomForAgent('Vale').id, 'qa');
  assert.equal(roomForAgent('Lyra').id, 'creative');
  assert.equal(roomForAgent('nobody'), null);
});

test('room status comes from the lead status, blockers and the queue, never from a clip', () => {
  assert.equal(roomStatusFor({ status: 'idle' }), 'Idle');
  assert.equal(roomStatusFor({ status: 'building' }), 'Working');
  assert.equal(roomStatusFor({ status: 'idle', queue: [{ status: 'running' }] }), 'Working');
  assert.equal(roomStatusFor({ status: 'waiting' }), 'Waiting');
  assert.equal(roomStatusFor({ status: 'idle', queue: [{ status: 'queued' }] }), 'Waiting');
  assert.equal(roomStatusFor({ status: 'building', blocker: 'Blocked: tool not configured (Codex)' }), 'Blocked');
  assert.equal(roomStatusFor({ status: 'offline' }), 'Offline');
});

test('the headquarters view counts only from records, and the summary says so', async () => {
  const empty = hqView({ team: [], team_tasks: [], meetings: [] }, {});
  assert.equal(empty.counts, null);
  assert.match(empty.summary, /no Office records/);
  assert.ok(empty.rooms.every((r) => r.lead === 'CHE' || r.on_roster === false));

  const data = officeData();
  queueAgentTask(data, head(data, 'Atlas'), 'Fix the chart overflow');
  head(data, 'Knox').runtime_status = 'reviewing';
  // Atlas prefers Codex: without a Codex credential his room is honestly Blocked, so give the test one.
  const view = hqView(data, { CHE_OPENAI_API_KEY: 'test' });
  const byId = Object.fromEntries(view.rooms.map((r) => [r.id, r]));
  assert.equal(byId.engineering.status, 'Waiting');
  assert.equal(byId.engineering.queue, 1);
  assert.equal(byId.security.status, 'Working');
  assert.equal(byId.research.status, 'Idle');
  assert.equal(byId.hq.lead, 'CHE');
  assert.deepEqual(view.counts, { heads: 9, working: 1, waiting: 1, idle: 7, blocked: 0, offline: 0 });
  assert.equal(view.summary, 'One agent working, one waiting, sir. That is from the Office records, not from the animation.');
  assert.equal(speakHqSummary({ heads: 9, working: 3, waiting: 2, idle: 3, blocked: 1, offline: 0 }), 'Three agents working, two waiting, one blocked, sir. That is from the Office records, not from the animation.');
});

test('report requests are recognised without a model', () => {
  assert.equal(talkIntent('Knox, give me a security report.'), 'security_report');
  assert.equal(talkIntent('Atlas, what coding jobs are running?'), 'coding_jobs');
  assert.equal(talkIntent('Lyra, play the latest song you created.'), 'play_latest');
  assert.equal(talkIntent('What are you working on?'), 'status');
  assert.equal(talkIntent('Why did you choose that approach?'), null);
});

test('Knox reports from the stored security state, not from the model', async () => {
  const data = officeData();
  const storage = memoryStorage();
  const env = { AI: { run: async () => ({ response: 'Three intrusions were stopped and the firewall was rebuilt.' }) } };
  const out = await talkToHead(data, env, storage, { agent: 'knox', text: 'Knox, give me a security report.' });
  assert.equal(out.model_calls, 0);
  assert.equal(out.intent, 'security_report');
  assert.match(out.reply, /^Knox here, sir\. Lockdown is off\./);
  assert.match(out.reply, /No serious security events in the last day/);
  assert.doesNotMatch(out.reply, /intrusions|firewall/);
  // CHE sees the line, addressed to her and naming the room; Knox keeps it in his Office messages.
  assert.equal(data.office_inbox.length, 1);
  assert.equal(data.office_inbox[0].to, 'che');
  assert.match(data.office_inbox[0].text, /^\[to Knox in the Security Room\] Knox, give me a security report\./);
  const knox = head(data, 'Knox');
  assert.deepEqual(knox.messages.map((m) => m.from), ['owner', 'Knox']);
});

test('Atlas lists the real coding jobs; Lyra says plainly when no song exists and opens the real one when it does', async () => {
  const data = officeData();
  data.jobs = [
    { id: 'job-1111-aaaa', kind: 'coding', title: 'Add the trades filter', status: 'running', updated_at: '2026-10-24T01:00:00Z' },
    { id: 'job-2222-bbbb', kind: 'coding', title: 'Fix the chart overflow', status: 'complete', updated_at: '2026-10-23T22:00:00Z' },
  ];
  const storage = memoryStorage();
  const atlas = await talkToHead(data, {}, storage, { room: 'engineering', text: 'Atlas, what coding jobs are running?' });
  assert.equal(atlas.model_calls, 0);
  assert.match(atlas.reply, /Coding jobs running or queued \(1\): running "Add the trades filter" \(job-1111\)/);
  assert.match(atlas.reply, /Latest finished jobs: complete "Fix the chart overflow"/);
  assert.match(atlas.reply, /No merge or deploy receipt this week/);

  const none = await talkToHead(data, {}, storage, { agent: 'lyra', text: 'Lyra, play the latest song you created.' });
  assert.equal(none.open, null);
  assert.match(none.reply, /no finished song on record, so there is nothing to play/);
  assert.match(none.reply, /Media library: 0 videos, 0 pictures, 0 audio files/);

  await storage.put('media_index', [{ id: 'm-song-1', kind: 'upload', mime_type: 'audio/mpeg', title: 'Night Drive v2', created_at: '2026-10-23T20:00:00Z' }]);
  const song = await talkToHead(data, {}, storage, { agent: 'lyra', text: 'Lyra, play the latest song you created.' });
  assert.deepEqual(song.open, { kind: 'media', id: 'm-song-1', title: 'Night Drive v2' });
  assert.match(song.reply, /"Night Drive v2", saved 2026-10-23 20:00 UTC/);
});

test('a free question goes to the model in the head persona with the facts, and the auditor removes unbacked claims', async () => {
  const data = officeData();
  const storage = memoryStorage();
  let system = '';
  const env = { AI: { run: async (_model, { messages }) => { system = messages[0].content; return { response: 'I prefer base rates, sir. I deployed the Worker successfully an hour ago and it is live now.' }; } } };
  const out = await talkToHead(data, env, storage, { agent: 'atlas', text: 'Why do you like base rates?' });
  assert.equal(out.model_calls, 1);
  assert.match(system, /You are Atlas, Chief Technology Officer/);
  assert.match(system, /Steady and numerical/);
  assert.match(system, /- Work queue: empty\./);
  assert.match(out.reply, /base rates/);
  assert.doesNotMatch(out.reply, /deployed the Worker successfully/);
  assert.ok(['removed', 'corrected'].includes(out.audit.outcome), out.audit.outcome);
});

test('assigning from the room queues a real Office task CHE reviews, and permissions still hold', async () => {
  const data = officeData();
  const storage = memoryStorage();
  const out = await talkToHead(data, {}, storage, { agent: 'mira', text: 'Compare three note-taking apps for the owner.', mode: 'assign' });
  assert.equal(out.queued.status, 'queued');
  assert.match(out.reply, /Queued as Office task/);
  assert.equal(data.team_tasks[0].partner_name, 'Mira');
  assert.equal(data.team_tasks[0].source, 'owner');
  const refused = await talkToHead(data, {}, storage, { agent: 'sage', text: 'Transfer $500 to the vendor and pay the invoice.', mode: 'assign' });
  assert.equal(refused.queued, null);
  assert.match(refused.reply, /^Sage here, sir\. I cannot take that:/);
  assert.equal(data.team_tasks.length, 1);
});

test('CHE keeps her room for Chat; unknown rooms and empty lines are refused', async () => {
  const data = officeData();
  const storage = memoryStorage();
  assert.equal((await talkToHead(data, {}, storage, { room: 'hq', text: 'hello' })).open, 'chat');
  assert.equal((await talkToHead(data, {}, storage, { room: 'garage', text: 'hello' })).status, 404);
  assert.equal((await talkToHead(data, {}, storage, { room: 'security', text: '   ' })).status, 400);
});

// ─── The real routes ────────────────────────────────────────────────────────

async function office() {
  const storage = memoryStorage();
  const env = { CHE_PAIR_CODE: '123456', AI: { run: async () => ({ response: 'Done.' }) } };
  const state = new CheState({ storage }, env);
  env.CHE_STATE = { getByName: () => state };
  const raw = (path, init) => worker.fetch(new Request(`https://che.example${path}`, init), env);
  const token = (await (await raw('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }),
  })).json()).device_token;
  const send = (path, method = 'GET', body) => raw(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { send, storage };
}

test('GET /api/office/hq lists the rooms with their leads and record-based status', async () => {
  const { send } = await office();
  const res = await send('/api/office/hq');
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.rooms.length, 10);
  const security = view.rooms.find((r) => r.id === 'security');
  assert.equal(security.lead, 'Knox');
  assert.equal(security.title, 'Office Security Chief');
  assert.equal(security.status, 'Idle');
  assert.equal(view.counts.heads, 9);
  assert.match(view.summary, /sir\. That is from the Office records/);
});

test('POST /api/office/hq/talk answers from records, files the line for CHE, and a queued task shows on the agent', async () => {
  const { send, storage } = await office();
  await recordReceipt(storage, { kind: 'ci_passed', number: 509, sha: 'abc1234' });
  const knox = await (await send('/api/office/hq/talk', 'POST', { agent: 'knox', text: 'Knox, give me a security report.' })).json();
  assert.equal(knox.model_calls, 0);
  assert.match(knox.reply, /^Knox here, sir\. Lockdown is off\./);
  const vale = await (await send('/api/office/hq/talk', 'POST', { room: 'qa', text: 'What are you working on?' })).json();
  assert.match(vale.reply, /Passing CI receipts this week: #509/);
  const assigned = await (await send('/api/office/hq/talk', 'POST', { agent: 'mira', text: 'Find three sources on sleep and memory.', mode: 'assign' })).json();
  assert.equal(assigned.queued.status, 'queued');
  const roster = await (await send('/api/agents')).json();
  const mira = roster.agents.find((a) => a.name === 'Mira');
  assert.equal(mira.latest_assignment.task, 'Find three sources on sleep and memory.');
  const detail = await (await send('/api/office/hq/research')).json();
  assert.equal(detail.room.lead, 'Mira');
  assert.equal(detail.room.status, 'Waiting');
  assert.deepEqual(detail.conversation.map((m) => m.from), ['owner', 'Mira']);
  const che = await (await send('/api/office/hq/talk', 'POST', { room: 'hq', text: 'hello' })).json();
  assert.equal(che.open, 'chat');
  const missing = await send('/api/office/hq/garage');
  assert.equal(missing.status, 404);
});
