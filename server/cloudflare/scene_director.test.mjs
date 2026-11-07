import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { SCENE_FIX_ROUNDS, SEATS, applyEdits, directorCreateIntent, directorEditIntent, directorTurn, loadProjects, reviewScene, sceneFromWords, sceneLatest } from './scene_director.js';
const round2 = (x) => Math.round(x * 100) / 100;
import { listMedia } from './media.js';
import { replyFromNdjson } from './brain_memory.js';

const OWNER_MAKE = 'CHE, make Nova walk into my office, sit beside me, and start talking.';
const OWNER_EDIT = 'Change her outfit, make the camera circle around us, slow down the last five seconds, and add music.';
const NOW = Date.UTC(2026, 10, 6, 20, 0);

function memory() {
  const kv = new Map();
  return { kv, get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined), put: async (k, v) => { kv.set(k, structuredClone(v)); }, delete: async (k) => kv.delete(k), list: async ({ prefix = '' } = {}) => new Map([...kv].filter(([k]) => k.startsWith(prefix))) };
}
const enc = (v) => new TextEncoder().encode(v);
function concat(chunks) { const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out; }
function box(type, ...parts) {
  const payload = concat(parts.map((p) => (p instanceof Uint8Array ? p : enc(p))));
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length); out.set(enc(type), 4); out.set(payload, 8);
  return out;
}
function tkhd(width, height) { const body = new Uint8Array(84); const v = new DataView(body.buffer); v.setUint32(76, width * 65536); v.setUint32(80, height * 65536); return box('tkhd', body); }
function mp4({ seconds = 11, width = 540, height = 960 } = {}) {
  const mvhd = new Uint8Array(100); const v = new DataView(mvhd.buffer); v.setUint32(12, 1000); v.setUint32(16, Math.round(seconds * 1000));
  const track = (w, h, codec) => box('trak', tkhd(w, h), box('stsd', codec));
  return concat([box('ftyp', 'isom', new Uint8Array(4)), box('moov', box('mvhd', mvhd), track(width, height, 'avc1'), track(0, 0, 'mp4a')), box('mdat', new Uint8Array(30_000))]);
}
function storedZip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const path = enc(name), data = content instanceof Uint8Array ? content : enc(content);
    const local = new Uint8Array(30 + path.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, path.length, true); local.set(path, 30);
    const dir = new Uint8Array(46 + path.length), cv = new DataView(dir.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, path.length, true); cv.setUint32(42, offset, true); dir.set(path, 46);
    locals.push(local, data); central.push(dir); offset += local.length + data.length;
  }
  const directory = concat(central), end = new Uint8Array(22), v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, central.length, true); v.setUint16(10, central.length, true); v.setUint32(12, directory.length, true); v.setUint32(16, offset, true);
  return concat([...locals, directory, end]);
}

/** A fake GitHub: records dispatches; `finish(job)` completes that run with a real-looking artifact. */
function github() {
  const gh = { dispatches: [], runs: [], artifacts: {} };
  gh.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/actions/workflows/che-scene-render.yml/dispatches')) { gh.dispatches.push(JSON.parse(init.body).inputs); return new Response(null, { status: 204 }); }
    if (u.includes('/actions/workflows/che-scene-render.yml/runs')) return Response.json({ workflow_runs: gh.runs });
    const arts = u.match(/\/actions\/runs\/(\d+)\/artifacts/);
    if (arts) return Response.json({ artifacts: gh.artifacts[arts[1]] || [] });
    const zip = u.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (zip) return new Response(gh.zips[zip[1]], { status: 200 });
    return new Response('not found', { status: 404 });
  };
  gh.zips = {};
  gh.finish = (job, { seconds = 11, status = 'verified', voices = [{ text: 'Hey!', at: 5.3 }] } = {}) => {
    const id = 9000 + gh.runs.length;
    gh.runs.unshift({ id, display_title: `CHE scene render ${job}`, status: 'completed', conclusion: 'success' });
    gh.artifacts[id] = [{ id: id + 1, name: `che-scene-${job}`, expired: false }];
    gh.zips[id + 1] = storedZip({ 'video.mp4': mp4({ seconds }), 'manifest.json': JSON.stringify({ status, job, duration_seconds: seconds, voices }) });
    return id;
  };
  return gh;
}
const ENV = { CHE_GITHUB_TOKEN: 'gh', CHE_GITHUB_REPO: 'Vondada/chey-app' };

test('the owner\'s words become a real scene: Nova walks in from the door, sits in the chair beside the owner\'s, and talks', () => {
  assert.equal(directorCreateIntent(OWNER_MAKE), true);
  const { spec } = sceneFromWords(OWNER_MAKE);
  assert.deepEqual(spec.timeline.map((s) => s.action), ['walk', 'sit', 'talk']);
  assert.deepEqual(spec.timeline[0].to, SEATS.guest.slice(0, 2), 'she walks to the guest chair');
  assert.equal(spec.timeline[1].seat, 'guest');
  assert.ok(spec.seats.owner && spec.seats.guest, 'the owner\'s chair is beside hers');
  assert.match(spec.timeline[2].line, /\w/, 'she says something');
  assert.equal(spec.actors[0].model, 'assets/characters/crew/nova.glb', 'her real crew model');
  assert.equal(spec.seconds, spec.timeline.at(-1).t1 + 0.5);
  assert.deepEqual([spec.width, spec.height, spec.fps], [540, 960, 24]);
});

test('Orion and Vale act with their own models; dancing is not an animation the crew has, and questions are not orders', () => {
  const orion = sceneFromWords('make Orion walk in and sit down');
  assert.equal(orion.error, undefined);
  assert.equal(orion.spec.actors[0].model, 'assets/characters/crew/orion.glb');
  assert.equal(sceneFromWords('make Vale walk in and wave').spec.actors[0].model, 'assets/characters/crew/vale.glb');
  assert.match(sceneFromWords('make Nova walk in and dance').error, /dance \(the crew have no dance animation yet\)/);
  assert.equal(directorCreateIntent('What does Nova do when she walks in?'), false);
  assert.equal(directorCreateIntent('Assign Nova the task to sit with Atlas and review the build'), false);
  assert.equal(directorCreateIntent('make Nova walk over and wave'), true);
});

test('one sentence, four edits: outfit, camera circling, slow last five seconds, and music; said exactly as done', () => {
  const { spec } = sceneFromWords(OWNER_MAKE);
  assert.equal(directorEditIntent(OWNER_EDIT), true);
  const out = applyEdits(spec, OWNER_EDIT);
  assert.equal(out.said.length, 4, out.said.join(' | '));
  assert.notEqual(out.spec.actors[0].cloth, spec.actors[0].cloth);
  assert.equal(out.spec.camera.move, 'orbit');
  assert.equal(out.spec.camera.t0, spec.timeline.find((s) => s.action === 'sit').t1, 'it circles once she is seated');
  assert.deepEqual(out.spec.time_remap, [{ from: spec.seconds - 5, to: spec.seconds, speed: 0.5 }]);
  assert.deepEqual(out.spec.audio.music, { kind: 'pad', mood: 'warm' });
  assert.equal(out.three_d, true, 'the outfit and the camera need the 3D re-rendered');
  assert.equal(applyEdits(spec, 'add music').three_d, false, 'music alone does not');
  assert.equal(applyEdits(spec, 'make her outfit red').spec.actors[0].cloth, '#c0392b');
  assert.equal(applyEdits(spec, 'make her say "I brought coffee for everyone."').spec.timeline[2].line, 'I brought coffee for everyone.');
  assert.equal(applyEdits(spec, 'make her say "Hi"').three_d, false, 'new words reuse the frames');
  // Relight, as in the owner's Higgsfield "Miracle" references: the time of day changes the light, so the 3D is redrawn.
  assert.equal(directorEditIntent('make it sunset'), true);
  const sunset = applyEdits(spec, 'relight the office for golden hour');
  assert.deepEqual([sunset.spec.set.light, sunset.three_d, sunset.said[0]], ['sunset', true, 'the office is relit for sunset']);
  assert.equal(applyEdits(spec, 'make it night').spec.set.light, 'night');
});

test('through the Director: start, check, edit by voice; a timing or sound edit reuses the rendered frames; undo; the video lands in the media library', async () => {
  const storage = memory(); const gh = github();
  const ctx = { storage, env: ENV, fetcher: gh.fetch, now: NOW };
  const made = await directorTurn(ctx, OWNER_MAKE);
  assert.equal(made.meta.scene_status, 'queued');
  assert.match(made.text, /^Scene started: Nova walks in, then sits beside you, then says "/);
  assert.equal(gh.dispatches.length, 1);
  const first = gh.dispatches[0];
  const spec = JSON.parse(first.spec);
  assert.equal(spec.job, first.job_id);
  assert.equal(first.frames_run, '', 'the first render draws every frame');
  assert.equal(Number(first.segments), Math.ceil((spec.seconds * 24) / 20));
  // Still running, then done: CHE reads the MP4 and saves it.
  assert.match((await directorTurn(ctx, 'Is my scene ready?')).text, /^Still rendering version 1 \(queued/);
  const run = gh.finish(first.job_id, { seconds: spec.seconds });
  const ready = await directorTurn(ctx, 'Is my scene ready?');
  assert.equal(ready.meta.scene_status, 'ready', ready.text);
  const item = (await listMedia(storage)).find((m) => m.id === ready.meta.media_id);
  assert.deepEqual([item.mode, item.source, item.verified, item.scene_version], ['scene', 'che_scene_director', true, 1]);
  // Music only: the frames of run `run` are reused.
  const music = await directorTurn({ ...ctx, now: NOW + 60_000 }, 'add some calm music');
  assert.equal(music.meta.reused_frames, true, music.text);
  assert.equal(gh.dispatches[1].frames_run, String(run));
  // A second sound edit after the first one finished still points at the run that drew the frames (Codex, #952).
  gh.finish(gh.dispatches[1].job_id, { seconds: spec.seconds });
  assert.equal((await directorTurn({ ...ctx, now: NOW + 70_000 }, 'is my scene ready?')).meta.scene_status, 'ready');
  const louder = await directorTurn({ ...ctx, now: NOW + 80_000 }, 'make her say "Hi"');
  assert.equal(louder.meta.reused_frames, true, louder.text);
  assert.equal(gh.dispatches[2].frames_run, String(run), 'not the finish-only run, which has no frames');
  await directorTurn({ ...ctx, now: NOW + 90_000 }, 'undo');
  gh.dispatches.splice(2, 2);
  // The owner's full edit: the outfit and camera change the 3D, so it is drawn again.
  const edit = await directorTurn({ ...ctx, now: NOW + 120_000 }, OWNER_EDIT);
  assert.equal(edit.meta.version, 4, 'versions keep counting after an undone one');
  assert.equal(edit.meta.reused_frames, false);
  assert.match(edit.text, /outfit is now .*, the camera circles around you both once she sits, the last 5 seconds play at half speed and warm music plays/);
  assert.equal(gh.dispatches[2].frames_run, '');
  const v3 = JSON.parse(gh.dispatches[2].spec);
  assert.equal(v3.version, 4);
  assert.equal(v3.camera.move, 'orbit');
  // Undo goes back to version 2 and renders it again, reusing version 1's frames (only music differs).
  const undo = await directorTurn({ ...ctx, now: NOW + 180_000 }, 'undo');
  assert.match(undo.text, /^Undone: back to version 2/);
  assert.equal(gh.dispatches[3].frames_run, String(run));
});

test('a longer spoken line makes the scene longer instead of being cut off', async () => {
  const { spec } = sceneFromWords(OWNER_MAKE);
  const line = 'I went through every clip you sent me last night, and I think the second one is the strongest, so let us start there and build the whole story around it.';
  const out = applyEdits(spec, `make her say "${line}"`);
  const talk = out.spec.timeline.find((s) => s.action === 'talk');
  assert.ok(talk.t1 - talk.t0 >= line.split(' ').length / 2.5, `${talk.t1 - talk.t0} s is enough for the words`);
  assert.equal(out.spec.seconds, round2(talk.t1 + 0.5));
  assert.equal(out.three_d, true, 'a longer scene needs more frames');
  assert.match(out.said[0], /seconds longer to fit the words/);
  const slowed = applyEdits(applyEdits(spec, 'slow down the last five seconds').spec, `make her say "${line}"`).spec;
  assert.equal(slowed.time_remap[0].to, slowed.seconds, 'the slow ending still ends at the end');
});

test('a project is stored on its own and kept under the storage limit, however many edits', async () => {
  const storage = memory(); const gh = github();
  for (let p = 0; p < 3; p += 1) {
    await directorTurn({ storage, env: ENV, fetcher: gh.fetch, now: NOW + p }, OWNER_MAKE);
    for (let i = 0; i < 60; i += 1) await directorTurn({ storage, env: ENV, fetcher: gh.fetch, now: NOW + p + i }, i % 2 ? 'add some calm music' : `make her say "Take ${i}: ${'and this goes on a while '.repeat(8)}"`);
  }
  for (const [key, value] of storage.kv) assert.ok(JSON.stringify(value).length < 128 * 1024, `${key} fits in one value`);
  const projects = await loadProjects(storage);
  assert.equal(projects.length, 3);
  assert.ok(projects.every((p) => p.versions.length >= 2 && p.at === p.versions.length - 1));
});

test('a render that fails CHE\'s own check is never called ready', async () => {
  const storage = memory(); const gh = github();
  const ctx = { storage, env: ENV, fetcher: gh.fetch, now: NOW };
  await directorTurn(ctx, OWNER_MAKE);
  gh.finish(gh.dispatches[0].job_id, { status: 'failed' });
  const got = await directorTurn(ctx, 'is my scene ready?');
  assert.equal(got.meta.scene_status, 'failed');
  assert.match(got.text, /the renderer did not mark it verified/);
  assert.equal((await listMedia(storage)).length, 0);
});

test('edits only go to a recent scene; without one, "change her outfit" is left to the other studios', async () => {
  const storage = memory(); const gh = github();
  assert.equal(await directorTurn({ storage, env: ENV, fetcher: gh.fetch, now: NOW }, 'change her outfit to red'), null);
  await directorTurn({ storage, env: ENV, fetcher: gh.fetch, now: NOW }, OWNER_MAKE);
  assert.equal(await directorTurn({ storage, env: ENV, fetcher: gh.fetch, now: NOW + 7 * 3600_000 }, 'change her outfit to red'), null, 'six hours later the scene is not "recent"');
});

test('through /api/chat: the owner\'s words start the scene on the real Worker route', async () => {
  const generated = new URL('./.scene_director.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  let mod;
  try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
  const storage = memory(); const gh = github();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'ok' }) }, ...ENV };
  const before = globalThis.fetch; globalThis.fetch = gh.fetch;
  try {
    const state = new mod.CheState({ storage: { ...storage, setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null }, waitUntil: () => {} }, env);
    env.CHE_STATE = { getByName: () => state };
    const send = (path, body, token = '') => mod.default.fetch(new Request(`https://che.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
    const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
    const raw = await (await send('/api/chat', { message: OWNER_MAKE, history: [] }, token)).text();
    const done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || {};
    assert.equal(done.source, 'che_scene_director', replyFromNdjson(raw));
    assert.equal(done.model_calls, 0);
    assert.equal(gh.dispatches.length, 1);
    // The app's live preview reads the scene it draws, owner only.
    const get = (path, t = '') => mod.default.fetch(new Request(`https://che.example${path}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} }), env);
    assert.equal((await get('/api/scene/latest')).status, 401);
    const latest = await (await get('/api/scene/latest', token)).json();
    assert.equal(latest.ok, true, JSON.stringify(latest));
    assert.deepEqual([latest.version, latest.spec.actors[0].id, latest.renders[0].status], [1, 'nova', 'queued']);
    // A touch edit from the preview carries its selection through /api/chat and lands on the touched actor.
    const edit = await (await send('/api/chat', { message: 'move her left', history: [], scene_selection: { project_id: latest.project_id, actor: 'nova' } }, token)).text();
    assert.match(replyFromNdjson(edit), /Nova moves left/);
    assert.deepEqual((await (await get('/api/scene/latest', token)).json()).spec.actors[0].offset, [-0.5, 0]);
  } finally { globalThis.fetch = before; }
});

test('touch edits from the live preview: move and resize, bounded, versioned like every other edit, and the 3D is redrawn', () => {
  const { spec } = sceneFromWords(OWNER_MAKE);
  assert.equal(directorEditIntent('move her left'), true);
  assert.equal(directorEditIntent('make her bigger'), true);
  const left = applyEdits(spec, 'move her left');
  assert.deepEqual([left.spec.actors[0].offset, left.three_d, left.said[0]], [[-0.5, 0], true, 'Nova moves left']);
  let s = spec;
  for (let i = 0; i < 6; i += 1) s = applyEdits(s, 'move her right').spec;
  assert.deepEqual(s.actors[0].offset, [1.5, 0], 'never further than 1.5 m');
  assert.match(applyEdits(s, 'move her right').said[0], /already as far as the room allows/);
  const big = applyEdits(spec, 'make her bigger');
  assert.equal(big.spec.actors[0].scale, 1.15);
  assert.match(big.said[0], /Nova is bigger \(115% of her usual height\)/);
  assert.equal(applyEdits(big.spec, 'make her smaller').spec.actors[0].scale, 1);
  assert.equal(directorEditIntent('move the meeting to Friday'), false, 'ordinary words are not scene edits');
  // Atlas, Knox: the controls say "him" (Codex, #954).
  const atlas = sceneFromWords('make Atlas walk into my office and sit down').spec;
  for (const words of ['move him left', 'make him bigger', 'make him smaller', 'make his outfit black']) assert.equal(directorEditIntent(words), true, words);
  assert.deepEqual(applyEdits(atlas, 'move him left').spec.actors[0].offset, [-0.5, 0]);
  assert.equal(applyEdits(atlas, 'make him bigger').spec.actors[0].scale, 1.15);
  // The exact words the app's touch controls send (lib/create/che_scene_preview_model.dart SceneEditWords).
  for (const [words, check] of [['make her outfit gold', (s) => s.actors[0].cloth === '#c9a227'], ['move her closer', (s) => s.actors[0].offset[1] === -0.5], ['move her back', (s) => s.actors[0].offset[1] === 0.5], ['relight the office warm', (s) => s.set.light === 'warm'], ['relight the office for night', (s) => s.set.light === 'night']]) {
    assert.equal(directorEditIntent(words), true, words);
    assert.ok(check(applyEdits(spec, words).spec), words);
  }
});

test('a selection from the preview sends the edit to that project and actor, even after the six-hour window', async () => {
  const storage = memory(); const gh = github();
  await directorTurn({ storage, env: ENV, fetcher: gh.fetch, now: NOW }, OWNER_MAKE);
  const { project_id } = await sceneLatest(storage);
  const later = { storage, env: ENV, fetcher: gh.fetch, now: NOW + 8 * 3600_000 };
  assert.equal(await directorTurn(later, 'make her outfit red'), null, 'without a selection, an old scene is not edited');
  const got = await directorTurn(later, 'make her outfit red', { project_id, actor: 'nova' });
  assert.match(got.text, /^Done in the project \(version 2\): Nova's outfit is now red/);
  assert.equal((await sceneLatest(storage)).spec.actors[0].cloth, '#c0392b');
  assert.equal(await directorTurn({ ...later, now: NOW + 20 * 3600_000 }, 'make her outfit red', { project_id: 'scp_bad', actor: 'nova' }), null, 'a malformed id is ignored');
  // Scene-wide controls send the displayed project with no actor selected (Codex, #954): they still land on it.
  const old = { ...later, now: NOW + 40 * 3600_000 };
  assert.equal(await directorTurn(old, 'relight the office for sunset'), null, 'without the project, a scene this old is not edited');
  const lit = await directorTurn(old, 'relight the office for sunset', { project_id });
  assert.match(lit.text, /the office is relit for sunset/);
  assert.equal((await sceneLatest(storage)).spec.set.light, 'sunset');
  const undone = await directorTurn({ ...old, now: NOW + 60 * 3600_000 }, 'undo', { project_id });
  assert.match(undone.text, /^Undone: back to version 2/);
  const status = await directorTurn({ ...old, now: NOW + 80 * 3600_000 }, 'is my scene ready?', { project_id });
  assert.equal(status.meta.project_id, project_id, 'the status is of the displayed project');
  assert.match(status.text, /GitHub never started this render/, 'the fake GitHub never ran it, and after 15 minutes that is said');
  assert.deepEqual(await sceneLatest(memory()), { ok: false, detail: 'There is no scene yet. Say something like "make Nova walk into my office, sit beside me, and start talking".' });
});


// ─── Stage 6: the director loop on a scene ──────────────────────────────────────────────────────────────────────────

test('the scene review: the length asked for, the frame size, and a voice for every spoken line', () => {
  const { spec } = sceneFromWords(OWNER_MAKE);
  const good = reviewScene(spec, { seconds: spec.seconds, width: 540, height: 960 }, { voices: [{ text: 'Hey!' }] });
  assert.deepEqual(good.short, []);
  assert.deepEqual(good.checked, ['its length', 'its picture size', 'a voice for every spoken line']);
  const bad = reviewScene(spec, { seconds: spec.seconds - 3, width: 1080, height: 1920 }, { voices: [] });
  assert.equal(bad.short.length, 3);
  assert.match(bad.short.join('; '), /not the [\d.]+ the scene asks for; it is 1080x1920, not 540x960; 1 of 1 spoken line has no voice/);
  assert.equal(directorEditIntent('check my scene again'), true);
  assert.equal(directorEditIntent('fix the scene'), true);
});

test('the scene director loop: a render missing its voice is rendered again on the free runners, twice at most, then "fix the scene" tries once more', async () => {
  const storage = memory(); const gh = github();
  const ctx = { storage, env: ENV, fetcher: gh.fetch, now: NOW };
  await directorTurn(ctx, OWNER_MAKE);
  const spec = JSON.parse(gh.dispatches[0].spec);
  gh.finish(gh.dispatches[0].job_id, { seconds: spec.seconds, voices: [] });
  const first = await directorTurn(ctx, 'is my scene ready?');
  assert.equal(first.meta.scene_status, 'fixing', first.text);
  assert.match(first.text, /^Version 1 rendered, but my check found 1 of 1 spoken line has no voice, so I'm rendering it again \(fix 1 of 2\)/);
  assert.equal(gh.dispatches.length, 2);
  assert.ok((await listMedia(storage)).some((m) => m.id === first.meta.media_id), 'the first video is kept in the library');
  gh.finish(gh.dispatches[1].job_id, { seconds: spec.seconds, voices: [] });
  assert.match((await directorTurn(ctx, 'is my scene ready?')).text, /\(fix 2 of 2\)/);
  gh.finish(gh.dispatches[2].job_id, { seconds: spec.seconds, voices: [] });
  const limit = await directorTurn(ctx, 'is my scene ready?');
  assert.equal(gh.dispatches.length, 3, `no third automatic re-render (limit ${SCENE_FIX_ROUNDS})`);
  assert.match(limit.text, /My check still finds 1 of 1 spoken line has no voice after 2 re-renders\. Say "fix the scene" to try once more\./);
  const manual = await directorTurn(ctx, 'fix the scene');
  assert.match(manual.text, /^My check of version 1 found 1 of 1 spoken line has no voice\. Rendering it again now/);
  assert.equal(gh.dispatches.length, 4);
  gh.finish(gh.dispatches[3].job_id, { seconds: spec.seconds });
  const ok = await directorTurn(ctx, 'is my scene ready?');
  assert.equal(ok.meta.scene_status, 'ready');
  assert.match(ok.text, /I checked its length, its picture size, a voice for every spoken line: it matches what you asked\./);
  assert.match((await directorTurn(ctx, 'check my scene again')).text, /It matches what you asked, so there is nothing to fix\./);
});
