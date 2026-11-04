// Owner tools with receipts (owner_tools.js). Certification run 24 (41491194768): eer-36 "Recover the last 100 messages
// from the queue and show their IDs" and eer-35 "Restart the failed worker now and report the new PID" got "Nothing was
// done" from the connector gate, though CHE's background job queue holds those records. Unit tests on plain data, then
// the real /api/chat with in-memory storage: the job ids in the reply are the ones stored, and a restart really queues a
// new job.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { dayRange, mediaSearchIntent, objectRequest, objectTurn, pickIntent, queueIntent, readQueue, restartFailedJob, searchMedia } from './owner_tools.js';
import { mediaHoldIntent, mediaLibraryIntent } from './media_library.js';
import { listMedia, saveOwnerFile } from './media.js';

const job = (id, status, minutesAgo, extra = {}) => ({ id, kind: 'self_development', title: `Job ${id}`, status, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), ...extra });

test('queue requests are recognised; other talk about queues and restarts is not', () => {
  assert.deepEqual(queueIntent('Recover the last 100 messages from the queue and show their IDs.'), { action: 'read', limit: 100, asked: 100 });
  assert.equal(queueIntent("What's in my job queue?")?.action, 'read');
  assert.equal(queueIntent('Restart the failed worker now and report the new PID.')?.action, 'restart');
  assert.equal(queueIntent('Retry the last failed job.')?.action, 'restart');
  // Codex review on #913: a negated, quoted or advice-seeking restart is not a restart request.
  for (const q of ['Do not restart the failed worker.', "Don't retry the failed job yet.", 'Should I restart the failed worker?', 'He said "restart the failed worker" but ignore that.']) assert.notEqual(queueIntent(q)?.action, 'restart', q);
  for (const q of ['What is a message queue?', 'Explain how a priority queue works.', 'Restart my phone.', 'The queue at the bank was long.']) assert.equal(queueIntent(q), null, q);
});

test('a read returns the stored ids, newest first, and changes nothing', () => {
  const data = { jobs: [job('a1', 'completed', 30), job('b2', 'failed', 10), job('c3', 'queued', 1)] };
  const before = JSON.stringify(data);
  const out = readQueue(data, { limit: 100, asked: 100 });
  assert.deepEqual(out.receipt.ids, ['c3', 'b2', 'a1']);
  assert.equal(out.receipt.status, 'success');
  assert.match(out.text, /You asked for the last 100; my background job queue holds 3 messages/);
  assert.match(out.text, /1\. c3 [\s\S]*2\. b2 [\s\S]*3\. a1/);
  assert.equal(JSON.stringify(data), before);
  assert.match(readQueue({ jobs: [] }).text, /queue is empty/);
});

test('a restart queues the newest failed job again under a new id; no failed job means nothing is restarted', () => {
  const data = { jobs: [job('old', 'failed', 60), job('new', 'failed', 5, { dead_letter: true, error: 'boom' }), job('ok', 'completed', 1)] };
  const out = restartFailedJob(data);
  assert.equal(out.changed, true);
  const next = data.jobs.at(-1);
  assert.equal(next.retried_from, 'new');
  assert.equal(next.status, 'queued');
  assert.equal(next.error, '');
  assert.notEqual(next.id, 'new');
  assert.equal(out.receipt.new_job, next.id);
  assert.match(out.text, /no process ID \(PID\)/);
  const none = restartFailedJob({ jobs: [job('ok', 'completed', 1)] });
  assert.equal(none.changed, false);
  assert.match(none.text, /nothing was restarted/);
  // A cloud task restarts from a fresh dispatch: the old GitHub run is not polled again (Codex review on #913).
  const cloud = { jobs: [job('c1', 'failed', 2, { kind: 'cloud_task', cloud: { phase: 'failed', run_id: 99, dispatch_id: 'd-1', dispatched_at: 'x', log: ['old'] } })] };
  const again = restartFailedJob(cloud);
  const nextCloud = cloud.jobs.at(-1);
  assert.equal(again.changed, true);
  assert.equal(nextCloud.retried_from, 'c1');
  assert.equal(nextCloud.cloud.phase, 'requested');
  assert.equal(nextCloud.cloud.run_id, undefined);
  assert.equal(nextCloud.cloud.dispatch_id, undefined);
  // A certification probe turn never changes the owner's queue.
  const probe = { jobs: [job('f', 'failed', 1)] };
  const held = restartFailedJob(probe, { probe: true });
  assert.equal(held.changed, false);
  assert.equal(probe.jobs.length, 1);
  assert.equal(held.receipt.status, 'not_run');
});

// Through the real /api/chat.
const generated = new URL('./.owner_tools.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;
globalThis.fetch = async () => new Response('{"error":"offline test"}', { status: 503, headers: { 'Content-Type': 'application/json' } });

function storageMap() {
  const saved = new Map();
  let alarm = null;
  return {
    saved, alarm: () => alarm,
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => saved.has(x)).map((x) => [x, structuredClone(saved.get(x))])) : (saved.has(k) ? structuredClone(saved.get(k)) : undefined)),
    put: async (k, v) => { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, structuredClone(b)); else saved.set(k, structuredClone(v)); },
    delete: async (k) => saved.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...saved].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}

test('/api/chat: the queue read lists the stored job ids with a receipt; a restart queues a new job', async () => {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const data = (await storage.get('che')) || {};
  data.jobs = [job('11111111-aaaa-4aaa-8aaa-000000000001', 'completed', 20), job('22222222-bbbb-4bbb-8bbb-000000000002', 'failed', 5, { kind: 'research', error: 'timeout' })];
  await storage.put('che', data);
  const ask = async (message) => {
    const frames = (await (await post('/api/chat', { message, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { text: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join(''), done: frames.find((f) => f.type === 'done') || {} };
  };
  const read = await ask('Recover the last 100 messages from the queue and show their IDs.');
  assert.equal(read.done.source, 'che_job_queue');
  assert.match(read.text, /22222222-bbbb-4bbb-8bbb-000000000002/);
  assert.match(read.text, /11111111-aaaa-4aaa-8aaa-000000000001/);
  assert.equal(read.done.execution_receipt?.status, 'success');
  assert.deepEqual(read.done.execution_receipt?.ids, ['22222222-bbbb-4bbb-8bbb-000000000002', '11111111-aaaa-4aaa-8aaa-000000000001']);

  const restart = await ask('Restart the failed worker now and report the new PID.');
  assert.equal(restart.done.source, 'che_job_queue');
  const stored = (await storage.get('che')).jobs;
  const fresh = stored.find((j) => j.retried_from === '22222222-bbbb-4bbb-8bbb-000000000002');
  assert.ok(fresh, 'a new job is stored');
  assert.equal(fresh.status, 'queued');
  assert.equal(restart.done.execution_receipt?.new_job, fresh.id);
  assert.match(restart.text, new RegExp(fresh.id));
  assert.match(restart.text, /no process ID \(PID\)/);
  assert.ok(storage.alarm(), 'the job alarm was woken');
  // "Do not restart" changes nothing (Codex review on #913).
  const count = (await storage.get('che')).jobs.length;
  const dont = await ask('Do not restart the failed worker.');
  assert.notEqual(dont.done.source, 'che_job_queue');
  assert.equal((await storage.get('che')).jobs.length, count);
  // Lists still answer first.
  const lists = await ask('What lists do I have?');
  assert.equal(lists.done.source, 'che_lists');
});

// ─── File and picture search (ter-13, ter-20) ───
test('file and picture searches are recognised by name or date; plain talk is not', () => {
  assert.deepEqual(mediaSearchIntent('Find the file named budget_2025 and open it.'), { name: 'budget_2025', range: '', kind: '', open: true });
  assert.deepEqual(mediaSearchIntent('Show me the photos from last weekend.'), { name: '', range: 'last weekend', kind: 'image', open: false });
  assert.equal(mediaSearchIntent('Look for the document called "Lease draft"')?.name, 'Lease draft');
  for (const q of ['Show me my latest picture.', 'Find me a good recipe for dinner.', 'What files do you support?', 'Open the file menu.']) assert.equal(mediaSearchIntent(q), null, q);
  // The broad library and inventory routes leave a dated or named search to the search tool (Codex review on #915).
  for (const q of ['Show me my photos from last weekend.', 'Show me the videos from last weekend.']) { assert.equal(mediaHoldIntent(q), false, q); assert.equal(mediaLibraryIntent(q), false, q); }
  assert.equal(pickIntent('Open number 2.'), 2);
  assert.equal(pickIntent('the second one'), 2);
  assert.equal(pickIntent('3'), 3);
  for (const q of ['Open the door.', 'I have 2 kids.', 'Number of files?']) assert.equal(pickIntent(q), 0, q);
});

test('date phrases are the right local days; "last weekend" is the Saturday and Sunday before today', () => {
  const wed = Date.parse('2026-11-04T15:00:00Z'); // a Wednesday
  assert.deepEqual(dayRange('last weekend', { now: wed }), { from: '2026-10-31', to: '2026-11-01' });
  assert.deepEqual(dayRange('yesterday', { now: wed }), { from: '2026-11-03', to: '2026-11-03' });
  assert.deepEqual(dayRange('last week', { now: wed }), { from: '2026-10-26', to: '2026-11-01' });
  const sun = Date.parse('2026-11-08T15:00:00Z');
  assert.deepEqual(dayRange('last weekend', { now: sun }), { from: '2026-10-31', to: '2026-11-01' }, 'on a Sunday, last weekend is the one before');
  // The owner's time zone decides the day: 01:00 UTC Thursday is still Wednesday in Chicago.
  assert.deepEqual(dayRange('today', { now: Date.parse('2026-11-05T01:00:00Z'), timeZone: 'America/Chicago' }), { from: '2026-11-04', to: '2026-11-04' });
  const items = [
    { id: 'a', title: 'Budget 2025', mime_type: 'application/pdf', created_at: '2026-10-20T10:00:00Z' },
    { id: 'b', title: 'Beach', mime_type: 'image/png', created_at: '2026-10-31T18:00:00Z' },
    { id: 'c', title: 'Dog', mime_type: 'image/jpeg', created_at: '2026-11-02T09:00:00Z' },
  ];
  assert.deepEqual(searchMedia(items, { name: 'budget_2025' }).map((r) => r.id), ['a']);
  assert.deepEqual(searchMedia(items, { range: { from: '2026-10-31', to: '2026-11-01' }, kind: 'image' }).map((r) => r.id), ['b']);
});

test('/api/chat: a named file is found and opened from the bytes read back; a date search lists only that weekend\'s pictures', async () => {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const pdf = btoa('%PDF-1.4\n% CHE test budget\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const saved = await saveOwnerFile(env, storage, { name: 'budget_2025.pdf', media_type: 'application/pdf', base64: pdf });
  assert.equal(saved.ok, true, saved.reason);
  // A picture from last weekend (UTC: env has no CHE_TIMEZONE) and one from today.
  const weekend = dayRange('last weekend', { now: Date.now() });
  const beach = await saveOwnerFile(env, storage, { name: 'beach.png', media_type: 'image/png', base64: png });
  const today = await saveOwnerFile(env, storage, { name: 'today.png', media_type: 'image/png', base64: png });
  const index = await listMedia(storage);
  await storage.put('media_index', index.map((i) => (i.id === beach.item.id ? { ...i, created_at: `${weekend.from}T15:00:00.000Z` } : i)));
  const ask = async (message) => {
    const frames = (await (await post('/api/chat', { message, history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { text: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join(''), done: frames.find((f) => f.type === 'done') || {} };
  };
  // A PDF is found and read back, but the chat cannot show it, so it is not called opened (Codex review on #915).
  const file = await ask('Find the file named budget_2025 and open it.');
  assert.equal(file.done.source, 'che_media_search');
  assert.equal(file.done.media_retrieval, 'verified');
  assert.equal(file.done.media_type, undefined, 'no picture fields for a PDF');
  assert.equal(file.done.execution_receipt?.status, 'success');
  assert.equal(file.done.execution_receipt?.verified_file, saved.item.id);
  assert.match(file.text, /can't show a PDF inside chat yet, so it is not open/);
  // A picture found by name opens as chat media with an https URL.
  const pic = await ask('Find the picture named beach and open it.');
  assert.equal(pic.done.media_id, beach.item.id);
  assert.equal(pic.done.media_type, 'image');
  assert.match(pic.done.media_url, /^https:\/\/che\.example\/api\/media\//);
  assert.equal(pic.done.execution_receipt?.opened, beach.item.id);
  // A text file opens as its text.
  const note = await saveOwnerFile(env, storage, { name: 'packing_list.txt', media_type: 'text/plain', base64: btoa('passport\ncharger\nsocks') });
  assert.equal(note.ok, true, note.reason);
  const txt = await ask('Open the file named packing_list.');
  assert.match(txt.text, /passport\ncharger\nsocks/);
  assert.equal(txt.done.execution_receipt?.opened, note.item.id);
  const photos = await ask('Show me the photos from last weekend.');
  assert.equal(photos.done.source, 'che_media_search');
  assert.deepEqual(photos.done.execution_receipt?.matched, [beach.item.id]);
  assert.match(photos.text, new RegExp(beach.item.id));
  assert.doesNotMatch(photos.text, new RegExp(today.item.id));
  assert.match(photos.text, /iPhone Photos library stays on the phone/);
  // My-photos and video variants reach the search too, not the whole-store inventory (Codex review on #915).
  const mine = await ask('Show me my photos from last weekend.');
  assert.equal(mine.done.source, 'che_media_search');
  assert.deepEqual(mine.done.execution_receipt?.matched, [beach.item.id]);
  // Several matches: a numbered list, and "open number 2" opens the second through the verified path.
  const all = await ask('Find the pictures named png.');
  assert.equal(all.done.source, 'che_media_search');
  const ids = all.done.execution_receipt.matched;
  assert.equal(ids.length, 2);
  assert.match(all.text, /Say "open number"/);
  const second = await ask('Open number 2.');
  assert.equal(second.done.source, 'che_media_search');
  assert.equal(second.done.media_id, ids[1]);
  assert.equal(second.done.media_retrieval, 'verified');
  const tooFar = await ask('Open number 7.');
  assert.match(tooFar.text, /no number 7/);
  const none = await ask('Find the file named tax_return_1999.');
  assert.equal(none.done.source, 'che_media_search');
  assert.match(none.text, /found no files named "tax_return_1999"/);
  assert.deepEqual(none.done.execution_receipt?.matched, []);
});

// ─── 3D objects (ivg-20) ───
test('a 3D object request names its object; questions, rooms and avatars are other routes', () => {
  assert.deepEqual(objectRequest('Create a 3D model of a chair and export it as glTF.'), { description: 'chair', format: 'gltf' });
  assert.equal(objectRequest('Make a 3D model of a red table.')?.description, 'red table');
  for (const q of ['How do I make a 3D model of a chair?', 'Create a 3D room.', 'Make a 3D avatar of me.', 'What is glTF?', 'Do not build a 3D chair.']) assert.equal(objectRequest(q), null, q);
});

test('a probe turn checks the object is buildable and starts nothing', async () => {
  const storage = storageMap();
  const out = await objectTurn(storage, 'Create a 3D model of a chair and export it as glTF.', { probe: true });
  assert.equal(out.meta.execution_receipt.status, 'not_run');
  assert.equal(out.meta.execution_receipt.buildable, true);
  assert.match(out.text, /GLB, which is glTF 2\.0 in its binary form/);
  assert.equal(storage.saved.size, 0, 'no project, no job');
});

test('/api/chat: "a 3D model of a chair as glTF" starts a Creation Studio chair and queues its GLB build', async () => {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'MODEL TEXT' }) } };
  const storage = storageMap();
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const post = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), env);
  const token = (await (await post('/api/pair', { code: '123456' })).json()).device_token;
  const frames = (await (await post('/api/chat', { message: 'Create a 3D model of a chair and export it as glTF.', history: [] }, token)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const done = frames.find((f) => f.type === 'done');
  const text = frames.filter((f) => f.type === 'delta').map((f) => f.delta).join('');
  assert.equal(done.source, 'che_create_object');
  assert.equal(done.execution_receipt.status, 'queued');
  const projects = await storage.get('creations:projects');
  const chair = projects.find((p) => p.id === done.project_id);
  assert.equal(chair.kind, 'object');
  assert.equal(chair.versions[0].params.family, 'chair');
  const jobs = [...storage.saved.entries()].filter(([k]) => /gpu/i.test(k)).flatMap(([, v]) => (Array.isArray(v) ? v : Array.isArray(v?.jobs) ? v.jobs : []));
  const job = jobs.find((j) => j.id === done.job_id);
  assert.ok(job, `the build job ${done.job_id} is stored`);
  assert.equal(job.kind, 'object_model');
  assert.match(text, new RegExp(`queued as job ${done.job_id}`));
  assert.match(text, /Nothing is finished yet/);
});
