// CONNECTION_CREATED (lane brain-visual, 2026-10-25): when CHE links two nodes, the Brain Population Ledger keeps one
// event with both node ids, the reason and the time, and the Brain Room's Live Activity reads them from
// /api/brain/ledger. Covered: the pure ledger writer (one event per pair, either order; secrets withheld), the Brain's
// relationship pass (brain_rooms.linkRelated), the neural map's token-overlap pass (a baseline first, then only new
// links), connections never counted as knowledge, and the real Worker route end to end.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { BrainLedger, answerLedger, categoryCards, connectionKey, ledgerApi, recordConnection, recordGraphConnections } from './brain_ledger.js';
import { CheBrainStore } from './brain_store.js';
import { publishRoomEvent } from './brain_rooms.js';
import { buildBrainGraph } from './research_memory.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { DatabaseSync = null; }
const sqlite = { skip: DatabaseSync ? false : 'node:sqlite unavailable' };

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

const connections = async (storage) => new BrainLedger(storage).query({ types: ['CONNECTION_CREATED'], limit: 500 });
const NOW = new Date('2026-10-25T15:00:00Z');

test('one CONNECTION_CREATED event per pair: both node ids, the reason, the status and an exact timestamp', sqlite, async () => {
  const s = storageFor();
  const e = recordConnection(s, { from: 'note:ema', to: 'note:vwap', from_title: 'EMA crossover rule', to_title: 'VWAP reclaim rule', reason: 'shared words (ema, reclaim)', basis: 'words', status: 'candidate', origin: 'brain_relations' }, NOW);
  assert.equal(e.event_type, 'CONNECTION_CREATED');
  assert.equal(e.timestamp, '2026-10-25T15:00:00.000Z');
  assert.equal(e.detail.from_id, 'note:ema');
  assert.equal(e.detail.to_id, 'note:vwap');
  assert.equal(e.detail.reason, 'shared words (ema, reclaim)');
  assert.equal(e.detail.status, 'candidate');
  assert.equal(e.record_id, connectionKey('note:vwap', 'note:ema'), 'the key is the same whichever side is named first');
  assert.match(e.title, /EMA crossover rule ↔ VWAP reclaim rule/);
  assert.equal(recordConnection(s, { from: 'note:vwap', to: 'note:ema', reason: 'again' }, NOW), null, 'the same pair, reversed, is never a second event');
  assert.equal(recordConnection(s, { from: 'note:ema', to: 'note:ema', reason: 'self' }, NOW), null, 'a node never links to itself');
  assert.equal(recordConnection(s, { from: 'note:ema', reason: 'no target' }, NOW), null);
  const stored = await connections(s);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].detail, e.detail, 'the detail round-trips through SQLite');
  assert.equal(recordConnection({ get: async () => null, put: async () => {} }, { from: 'a', to: 'b' }, NOW), null, 'no SQL ledger: nothing is claimed');
});

test('credential-shaped ids and titles never reach the ledger', sqlite, async () => {
  const s = storageFor();
  const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const e = recordConnection(s, { from: 'note:a', to: secret, from_title: 'Login note', to_title: `password: ${secret}`, reason: 'shared words' }, NOW);
  assert.ok(e);
  assert.doesNotMatch(JSON.stringify(e), /sk-ant-api03/);
  assert.equal(e.detail.to_id, 'id withheld');
});

test('connections are bookkeeping: never counted as knowledge items or as "entered my brain today"', sqlite, async () => {
  const s = storageFor();
  recordConnection(s, { from: 'a', to: 'b', from_title: 'Breakout strategy', to_title: 'MNQ breakout tool', reason: 'the same market symbol (MNQ)' }, NOW);
  const cards = await categoryCards(s, { now: NOW.getTime() });
  assert.equal(cards.reduce((n, c) => n + c.items + c.procedures + c.capabilities, 0), 0);
  const today = await answerLedger(s, { kind: 'today' }, { now: NOW.getTime() });
  assert.match(today.text, /Nothing entered my brain today/);
  const api = await ledgerApi(s, new URLSearchParams(), { now: NOW.getTime() });
  assert.equal(api.recent.length, 0, 'the Real-Time Learning list stays knowledge only');
  assert.equal(api.connections.length, 1, 'Live Activity reads connections from their own list');
  assert.equal(api.connections[0].status, 'Link');
  assert.match(api.connections[0].spoken, /Connection created/);
  const only = await ledgerApi(s, new URLSearchParams({ type: 'CONNECTION_CREATED' }), { now: NOW.getTime() });
  assert.equal(only.events.length, 1);
  assert.equal(only.events[0].detail.from_id, 'a');
});

test('the Brain relationship pass (linkRelated) records each new link once, with its reason', sqlite, async () => {
  const storage = storageFor();
  const store = new CheBrainStore(storage);
  const first = publishRoomEvent(store, { room: 'trading', kind: 'journal_trades', key: 'k1', title: 'Breakout strategy closed 3 MNQ trades', body: 'x', status: 'verified', at: '2026-10-20T10:00:00Z' });
  assert.equal((await connections(storage)).length, 0, 'a record with nothing to link to creates no connection');
  const rea = publishRoomEvent(store, { room: 'rea', kind: 'investigation', key: 'k2', title: 'REA investigation complete: breakout strategy tool for MNQ traders', body: 'y', status: 'verified', at: '2026-10-20T10:01:00Z' });
  assert.ok(rea.links.some((l) => l.to === first.id));
  const events = await connections(storage);
  assert.equal(events.length, rea.links.length, 'one event per link the pass created');
  const e = events.find((x) => x.detail.to_id === first.id);
  assert.equal(e.detail.from_id, rea.id);
  assert.equal(e.detail.origin, 'brain_relations');
  assert.ok(e.detail.reason.length > 3, 'the reason is the relation the rules found');
  assert.match(e.title, /Breakout strategy closed 3 MNQ trades/);
  // Relinking the same record (the alarm's relink pass) is never a second event.
  const { linkRelated } = await import('./brain_rooms.js');
  linkRelated(store, store.get(rea.id));
  assert.equal((await connections(storage)).length, events.length);
});

test('the neural map: the first read is a baseline, later reads record only links that are new', sqlite, async () => {
  const s = storageFor();
  const data = { memory_notes: [
    { id: 'n1', title: 'EMA crossover rule for MNQ futures', bullets: ['ema crossover futures session'], kind: 'research' },
    { id: 'n2', title: 'EMA crossover backtest on MNQ futures', bullets: ['ema crossover futures backtest'], kind: 'research' },
  ] };
  const g1 = buildBrainGraph(data);
  assert.ok(g1.links.length >= 1);
  assert.deepEqual(recordGraphConnections(s, g1, { now: NOW }), { recorded: 0, baseline: true, skipped: 0 });
  assert.equal((await connections(s)).length, 0, 'links that already existed are not news');
  assert.equal(recordGraphConnections(s, g1, { now: NOW }).recorded, 0, 'the same map again records nothing');
  data.memory_notes.push({ id: 'n3', title: 'EMA crossover journal for MNQ futures', bullets: ['ema crossover futures journal'], kind: 'research' });
  const g2 = buildBrainGraph(data);
  const r = recordGraphConnections(s, g2, { now: NOW });
  const events = await connections(s);
  assert.ok(r.recorded >= 1);
  assert.equal(events.length, r.recorded);
  for (const e of events) {
    assert.ok([e.detail.from_id, e.detail.to_id].includes('n3'), 'only links to the new note are new');
    assert.equal(e.detail.origin, 'brain_graph');
    assert.match(e.detail.reason, /token overlap|same kind|ML cluster|same language|related on the note/);
  }
  assert.equal(recordGraphConnections(s, g2, { now: NOW }).recorded, 0);
});

test('a burst of new links records at most the cap per read and says how many it skipped', sqlite, async () => {
  const s = storageFor();
  recordGraphConnections(s, { nodes: [], links: [] }, { now: NOW });
  const links = Array.from({ length: 30 }, (_, i) => ({ source: `a${i}`, target: `b${i}`, relation: 'related', weight: 0.2 }));
  const r = recordGraphConnections(s, { nodes: [], links }, { now: NOW, cap: 10 });
  assert.equal(r.recorded, 10);
  assert.equal(r.skipped, 20);
  assert.equal((await connections(s)).length, 10);
});

test('the real Worker: /api/brain/graph records new links and /api/brain/ledger shows them to the owner', sqlite, async () => {
  const generated = new URL('./.brain_connections.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
    "import { DurableObject } from 'cloudflare:workers';",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  ), 'utf8');
  let mod;
  try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
  const { default: worker, CheState } = mod;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'ok' }) } };
  const saved = new Map();
  const storage = storageFor(saved);
  const pending = [];
  const che = new CheState({ storage, waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => che };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  assert.ok(token);
  const putNotes = async (notes) => {
    const che = (await storage.get('che')) || {};
    await storage.put('che', { ...che, memory_notes: notes });
  };
  const notes = [
    { id: 'w1', title: 'Websocket reconnect backoff for the price stream', bullets: ['websocket reconnect backoff stream'], kind: 'research' },
    { id: 'w2', title: 'Websocket reconnect backoff tested on the price stream', bullets: ['websocket reconnect backoff tested'], kind: 'research' },
  ];
  await putNotes(notes);
  const first = await (await send('/api/brain/graph', null, token, 'GET')).json();
  assert.ok(first.links.length >= 1);
  let ledger = await (await send('/api/brain/ledger', null, token, 'GET')).json();
  assert.equal(ledger.connections.length, 0, 'the first map read is a baseline');
  await putNotes([...notes, { id: 'w3', title: 'Websocket reconnect backoff fix for the price stream', bullets: ['websocket reconnect backoff fix'], kind: 'research' }]);
  const state = await (await send('/api/state', null, token, 'GET')).json();
  assert.ok(state.brain_graph.nodes.some((n) => n.id === 'w3'), 'the phone reads the same map from /api/state');
  while (pending.length) await pending.shift();
  ledger = await (await send('/api/brain/ledger', null, token, 'GET')).json();
  assert.ok(ledger.connections.length >= 1, 'the new link is in the ledger');
  const c = ledger.connections[0];
  assert.equal(c.event_type, 'CONNECTION_CREATED');
  assert.ok([c.detail.from_id, c.detail.to_id].includes('w3'));
  assert.ok(c.detail.reason);
  assert.ok(Number.isFinite(c.ms));
  const stranger = await send('/api/brain/ledger', null, '', 'GET');
  assert.ok([401, 403].includes(stranger.status), 'only the owner reads the ledger');
});
