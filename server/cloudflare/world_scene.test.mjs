// Spatial World MVP 1 (owner, 2026-10-20): the Meeting Room scene is a projection of a real War
// Room meeting. Every object names its record, agent output is never styled as verified, and
// "start a meeting with the team about X" convenes a real meeting through chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { MEETING_STAGES, meetingCommand, meetingScene } from './world_scene.js';

const generated = new URL('./.world_scene.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (world_scene tests are offline: ${String(input?.url || input)})`); };

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

async function owner() {
  let calls = 0;
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: { run: async () => { calls += 1; return { response: 'ok' }; } },
  };
  const saved = new Map();
  const storage = storageFor(saved);
  const state = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const che = { env, storage, saved, state, calls: () => calls };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  che.say = async (message) => {
    const raw = await (await send('/api/chat', { message, history: [] }, token)).text();
    while (pending.length) await pending.shift();
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { reply: events.filter((e) => e.type === 'delta').map((e) => e.delta).join(''), done, route: done.source || 'model' };
  };
  che.get = async (path, withToken = true) => { const res = await send(path, null, withToken ? token : '', 'GET'); return { status: res.status, body: await res.json() }; };
  return che;
}

const meeting = (over = {}) => ({
  id: 'm-1234567890', objective: 'Plan the Music Room launch', status: 'drafting', progress: 0.2,
  participants: [
    { agent_id: 'a1', name: 'Nova', role: 'Research Partner', responsibility: 'Own the research slice.' },
    { agent_id: 'a2', name: 'Knox', role: 'Critical Reviewer', responsibility: 'Own the review slice.' },
  ],
  board: [{ from: 'CHE', kind: 'brief', text: 'Objective: Plan the Music Room launch', at: 't0' }],
  decisions: [], conflicts: [], recommendations: [], final_plan: '', updated_at: 't0', ...over,
});

test('every object names a real record; agent output is never verified; the path is CHE\'s unverified synthesis', () => {
  const done = meetingScene(meeting({
    status: 'complete', progress: 1,
    board: [
      { from: 'CHE', kind: 'brief', text: 'Objective: x' },
      { from: 'Nova', kind: 'draft', text: 'Research says playlists drive retention.' },
      { from: 'Knox', kind: 'draft', text: '(draft failed)', failed: true },
      { from: 'Knox', kind: 'critique', to: 'Nova', text: 'Source is a vendor blog; weak.' },
      { from: 'CHE', kind: 'synthesis', text: '1. Nova verifies retention data.' },
    ],
    recommendations: ['Verify the retention claim first', 'Ship a playlist MVP'], decisions: ['Start with playlists'], conflicts: ['Source quality'],
    final_plan: '1. Nova verifies retention data. 2. Juno builds the playlist MVP.',
  }), [{ id: 'a1', status: 'idle' }, { id: 'a2', status: 'reviewing', task: 'Synthesizing' }]);
  for (const o of done.objects) {
    assert.ok(o.source?.store, `${o.id} has a source`);
    assert.notEqual(o.provenance, 'verified', `${o.id} is not styled as verified`);
  }
  const kinds = done.objects.map((o) => o.kind);
  assert.equal(kinds.filter((k) => k === 'avatar').length, 2);
  assert.equal(kinds.filter((k) => k === 'suggestion').length, 2);
  assert.equal(kinds.filter((k) => k === 'path').length, 1);
  assert.ok(!done.objects.some((o) => o.text === '1. Nova verifies retention data.' && o.kind !== 'path'), 'the synthesis post is the path, not another card');
  const plan = done.objects.find((o) => o.kind === 'path');
  assert.equal(plan.provenance, 'che_synthesis_unverified'); assert.equal(plan.zone, 'center');
  assert.equal(plan.actions, undefined, 'no action until one really runs (turning a plan into an objective is MVP 2)');
  assert.equal(done.objects.find((o) => o.author === 'Knox' && o.kind === 'draft').status, 'failed');
  const critique = done.objects.find((o) => o.kind === 'critique');
  assert.ok(done.edges.some((e) => e.from === critique.id && e.type === 'critiques' && e.to === done.objects.find((o) => o.author === 'Nova' && o.kind === 'draft').id), 'a critique points at the draft it critiques');
  assert.equal(done.objects.find((o) => o.id === 'agent:a2').status, 'reviewing', 'avatars show the live runtime status');
  assert.match(done.spoken, /2 agents at the table: Nova, Knox\. The meeting is done/);
  assert.match(done.spoken, /not verified/);
});

test('stages follow the meeting record: gathering before any draft, then drafting, cross-check, synthesis, complete or failed', () => {
  assert.equal(meetingScene(meeting()).stage, 'gathering');
  assert.equal(meetingScene(meeting({ board: [{ from: 'Nova', kind: 'draft', text: 'x' }] })).stage, 'drafting');
  for (const status of ['cross_check', 'synthesizing', 'complete', 'failed']) assert.equal(meetingScene(meeting({ status })).stage, status);
  assert.match(meetingScene(meeting({ status: 'failed', error: 'CHE could not synthesize.' })).spoken, /stopped before a plan\. CHE could not synthesize/);
  for (const stage of Object.keys(MEETING_STAGES)) assert.ok(MEETING_STAGES[stage]);
  assert.equal(meetingScene(null), null);
});

test('the version changes only when the meeting does, so an unchanged poll moves nothing', () => {
  const a = meetingScene(meeting()).version;
  assert.equal(meetingScene(meeting()).version, a);
  assert.notEqual(meetingScene(meeting({ board: [{ from: 'Nova', kind: 'draft', text: 'x' }] })).version, a);
});

test('the meeting command: the owner\'s phrasings, and sentences that are not it', () => {
  assert.deepEqual(meetingCommand('Start a meeting with the team about the Music Room launch'), { topic: 'the Music Room launch' });
  assert.deepEqual(meetingCommand('CHE, call a team meeting on pricing.'), { topic: 'pricing' });
  assert.deepEqual(meetingCommand("let's have a meeting with the agents to plan the trading review"), { topic: 'the trading review' });
  assert.deepEqual(meetingCommand('start a meeting with the team'), { topic: '' });
  for (const m of ['I have a meeting with the team at 3', 'Start the war room', 'How did the meeting go?', 'Schedule a meeting with John tomorrow', 'start a timer']) {
    assert.equal(meetingCommand(m), null, m);
  }
});

test('through chat: the command convenes a real meeting with no model call, and the scene endpoint shows it (owner only)', async () => {
  const che = await owner();
  const asked = await che.say('Start a meeting with the team');
  assert.equal(asked.route, 'che_meeting_room'); assert.equal(asked.done.ok, false);
  assert.match(asked.reply, /What should the team meet about/);
  const started = await che.say('Start a meeting with the team about the Music Room launch');
  assert.equal(started.route, 'che_meeting_room'); assert.equal(started.done.ok, true);
  assert.equal(started.done.model_calls, 0);
  assert.match(started.reply, /Starting the meeting, sir\. \d agents? at the table/);
  const id = started.done.meeting_id;
  assert.ok(id);
  const scene = await che.get(`/api/world/scene?scene=meeting&id=${id}`);
  assert.equal(scene.status, 200);
  assert.equal(scene.body.scene.id, id);
  assert.equal(scene.body.scene.objective, 'the Music Room launch');
  assert.ok(scene.body.scene.objects.some((o) => o.kind === 'avatar'));
  assert.equal((await che.get(`/api/world/scene?scene=meeting&id=${id}`, false)).status, 401, 'no device token, no scene');
  assert.equal((await che.get('/api/world/scene?scene=meeting&id=nope-nope-nope')).status, 404);
});
