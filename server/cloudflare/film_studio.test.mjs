// Film Studio (owner handoff 2026-10-22, with the owner's speed correction). Offline and deterministic: no model,
// GPU or network is reached; Workers AI, GitHub, Kaggle and R2 are fakes that behave like the real APIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_RATES, FARM_PROVIDERS, FILM_NEURON_SHARE, FilmStore, NEURONS, assemblyPlan, checkStill, deadlineFrom, farmProviders,
  filmIntent, imageSize, lengthFrom, loadRates, loadUsage, mp3Seconds, planFilm, recordRate, reserve, segmentSpec, shotList,
  speakFarm, speakPlan, spend, validOutline, validSceneShots, _internals,
} from './film_studio.js';
import { HF_SPACE_FILES, KAGGLE_WORKER_PY, durationSeconds, farmTokenOpens, kaggleAuth, kaggleWorkerScript, newFarmToken, startKaggleSession, validateKaggle } from './film_farm.js';
import { filmTick, filmTokenRoute, remakeShot, setFilmState, startFilm } from './film_pipeline.js';
import { mp4Facts } from './github_video_renderer.js';
import { replyFromNdjson } from './brain_memory.js';
import { saveKey } from './resilience.js';

const offline = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };
globalThis.fetch = offline;
const NOW = Date.parse('2026-10-22T12:00:00Z');

// ─── Fakes ───────────────────────────────────────────────────────────────────

function memory() {
  const kv = new Map();
  return {
    kv,
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined),
    put: async (k, v) => { if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) kv.set(a, structuredClone(b)); return; } kv.set(k, structuredClone(v)); },
    delete: async (k) => kv.delete(k),
    list: async ({ prefix = '' } = {}) => new Map([...kv.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
  };
}

function r2() {
  const objects = new Map(); const uploads = new Map();
  const toBytes = async (body) => (body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer()));
  const obj = (bytes, meta = {}) => ({ size: bytes.length, httpMetadata: meta, body: new Response(bytes).body, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  return {
    objects,
    put: async (key, body, opts = {}) => { objects.set(key, { bytes: await toBytes(body), meta: opts.httpMetadata || {} }); },
    head: async (key) => (objects.has(key) ? { size: objects.get(key).bytes.length } : null),
    get: async (key, opts = {}) => {
      const o = objects.get(key); if (!o) return null;
      const r = opts.range; const bytes = r ? o.bytes.subarray(r.offset, r.offset + r.length) : o.bytes;
      return obj(bytes, o.meta);
    },
    createMultipartUpload: async (key) => { const id = `up${uploads.size + 1}`; uploads.set(id, { key, parts: new Map() }); return { uploadId: id }; },
    resumeMultipartUpload: (key, id) => ({
      uploadPart: async (n, body) => { uploads.get(id).parts.set(n, await toBytes(body)); return { partNumber: n, etag: `e${n}` }; },
      complete: async (parts) => {
        const u = uploads.get(id);
        const chunks = parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => u.parts.get(p.partNumber));
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0;
        for (const c of chunks) { all.set(c, at); at += c.length; }
        objects.set(key, { bytes: all, meta: { contentType: 'video/mp4' } });
      },
    }),
  };
}

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const box = (type, payload) => [...be32(8 + payload.length), ...ascii(type), ...payload];
/** A synthetic MP4 with the boxes mp4Facts reads: length from mvhd, frame size from tkhd, codecs from the moov. */
function mp4({ seconds = 10, width = 1280, height = 720, codecs = 'avc1mp4a' } = {}) {
  const mvhd = box('mvhd', [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(1000), ...be32(Math.round(seconds * 1000)), ...new Array(80).fill(0)]);
  const tkhd = box('tkhd', [0, 0, 0, 0, ...new Array(72).fill(0), ...be32(width << 16), ...be32(height << 16)]);
  const moov = box('moov', [...mvhd, ...box('trak', tkhd), ...box('free', ascii(codecs))]);
  return new Uint8Array([...box('ftyp', ascii('isom0000')), ...moov, ...box('mdat', new Array(30_000).fill(7))]);
}
/** A JPEG header the size check reads (SOF0 with 1024x1024), padded with detail. */
function jpeg({ size = 1024, bytes = 40_000 } = {}) {
  const head = [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, size >> 8, size & 255, size >> 8, size & 255, 3];
  const out = new Uint8Array(bytes); out.set(head); for (let i = head.length; i < bytes; i += 1) out[i] = (i * 31) & 0x7f; return out;
}
/** MPEG-1 layer III frames, 128 kb/s at 44.1 kHz: 417 bytes and 1152 samples each. */
function mp3(seconds) {
  const frames = Math.round((seconds * 44100) / 1152); const out = new Uint8Array(frames * 417);
  for (let f = 0; f < frames; f += 1) out.set([0xff, 0xfb, 0x90, 0x64], f * 417);
  return out;
}
const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

const providers = (over = {}) => [
  { id: 'workers_ai', usable: true, status: 'connected', remaining: { neurons: FILM_NEURON_SHARE }, ...(over.workers_ai || {}) },
  { id: 'github_actions', usable: true, status: 'connected', remaining: { minutes: 1600 }, ...(over.github_actions || {}) },
  { id: 'kaggle', usable: false, status: 'not set up', remaining: { gpu_seconds: 0 }, ...(over.kaggle || {}) },
  { id: 'hf_zerogpu', usable: false, status: 'not set up', remaining: { gpu_seconds: 0 }, ...(over.hf_zerogpu || {}) },
];
const kaggleOn = { kaggle: { usable: true, status: 'connected', remaining: { gpu_seconds: 25 * 3600 } } };

// ─── The owner's speed targets and honest ETAs ───────────────────────────────

test('the farm never includes the owner\'s computer, even with his image connector configured', async () => {
  const st = memory();
  const list = await farmProviders({ AI: {}, CHE_IMAGE_GEN_URL: 'https://pc.owner.example', CHE_OWNER_COMPUTE_URL: 'https://pc.owner.example' }, st, { now: NOW });
  assert.deepEqual(list.map((p) => p.id), ['workers_ai', 'github_actions', 'kaggle', 'hf_zerogpu', 'colab']);
  assert.ok(!JSON.stringify(list).includes('pc.owner.example'));
  const plan = planFilm({ targetSeconds: 600, providers: providers(), now: NOW });
  assert.ok(plan.providers_used.every((id) => ['workers_ai', 'github_actions', 'kaggle', 'hf_zerogpu'].includes(id)));
  assert.match(speakFarm(list), /Your own computer is never part of it/);
  assert.equal(Object.keys(FARM_PROVIDERS).includes('owner_pc'), false);
});

test('short deadlines force the FAST tier: five minutes "in seconds" and ten minutes in five use no GPU clips, even with Kaggle connected', () => {
  const asap = planFilm({ targetSeconds: 300, deadlineSeconds: 0, providers: providers(kaggleOn), now: NOW });
  assert.equal(asap.tier_a, 0);
  assert.equal(asap.as_fast_as_possible, true);
  const ten = planFilm({ targetSeconds: 600, deadlineSeconds: 300, providers: providers(kaggleOn), now: NOW });
  assert.equal(ten.tier_a, 0, 'a GPU session takes ten minutes just to start, so it cannot help a five-minute deadline');
  const two = planFilm({ targetSeconds: 7200, deadlineSeconds: 3600, providers: providers(kaggleOn), now: NOW });
  assert.ok(two.tier_a > 0 && two.tier_a <= two.shots / 5, 'with an hour, moving clips go only to key moments');
  assert.ok(two.parts.clips_s <= Math.max(two.parts.stills_s, two.parts.voices_s, 1) || two.parts.clips_s < 3600, 'clips never stretch the ETA past the picture stage');
});

test('the ETA comes from measured throughput, and says so until the stages are measured', async () => {
  const st = memory();
  const before = await loadRates(st);
  const p1 = planFilm({ targetSeconds: 600, providers: providers(), ...before, now: NOW });
  assert.equal(p1.estimated, true);
  assert.match(speakPlan(p1), /starting numbers/);
  for (const [k, v] of [['images_per_s', 4], ['tts_speed', 40], ['encode_speed', 6], ['runner_startup_s', 30]]) await recordRate(st, k, v, NOW);
  const after = await loadRates(st);
  assert.deepEqual([after.measured.images_per_s, after.measured.encode_speed], [true, true]);
  const p2 = planFilm({ targetSeconds: 600, providers: providers(), ...after, now: NOW });
  assert.equal(p2.estimated, false);
  assert.ok(p2.eta_s < p1.eta_s, `faster measured stages give a shorter ETA (${p2.eta_s} < ${p1.eta_s})`);
  assert.equal(p2.parts.stills_s, Math.round(p2.unique_stills / 4), 'pictures take unique / measured rate');
  // A slow measurement makes the ETA longer: the plan follows the numbers, not a promise.
  await recordRate(st, 'encode_speed', 0.5, NOW);
  const p3 = planFilm({ targetSeconds: 600, providers: providers(), ...(await loadRates(st)), now: NOW });
  assert.ok(p3.eta_s > p2.eta_s);
});

test('a deadline free compute cannot meet is said plainly, with the best real time and the mix', () => {
  const plan = planFilm({ targetSeconds: 300, deadlineSeconds: 5, providers: providers(), now: NOW });
  assert.equal(plan.meets_deadline, false);
  const said = speakPlan(plan, { asked: 'seconds' });
  assert.match(said, /^I can't make a 5-minute film in seconds with free compute\. The fastest I can do is about \d+ (?:seconds|minutes?), all stills with camera motion/);
  const ok = planFilm({ targetSeconds: 300, deadlineSeconds: 3600, providers: providers(), now: NOW });
  assert.match(speakPlan(ok), /^A 5-minute film takes about .* inside your 60 minutes/);
});

test('the speed targets: a 2-hour film by the hour runs twenty runners and frames each free picture more ways, and says so; a 4-hour film waits for tomorrow\'s allowance', () => {
  const plan = planFilm({ targetSeconds: 7200, deadlineSeconds: 3600, providers: providers(), now: NOW });
  assert.equal(plan.segments, 20, 'twenty runners at once, the free-plan limit');
  assert.equal(plan.shots, 1200);
  assert.ok(plan.reuse > _internals.MAX_REUSE && plan.reuse <= _internals.DEADLINE_REUSE, `framed ${plan.reuse} ways`);
  assert.equal(plan.waits_for_reset_s, 0);
  assert.equal(plan.meets_deadline, true, `about ${plan.eta_s} s against an hour`);
  assert.match(speakPlan(plan), /each is framed up to \d+ ways to finish on time/);
  const long = planFilm({ targetSeconds: 4 * 3600, deadlineSeconds: 7200, providers: providers(), now: NOW });
  assert.ok(long.waits_for_reset_s > 0, '2400 shots need more new pictures than one free day gives, even framed sixteen ways');
  assert.equal(long.meets_deadline, false);
  assert.match(speakPlan(long), /resets? at midnight UTC/);
});

// ─── Free allowances ─────────────────────────────────────────────────────────

test('free allowances are hard caps: spending past one is refused and nothing is taken', async () => {
  const st = memory();
  assert.equal((await spend(st, 'neurons', FILM_NEURON_SHARE - 10, { now: NOW })).ok, true);
  const over = await spend(st, 'neurons', 20, { now: NOW });
  assert.equal(over.ok, false);
  assert.equal(over.capped, true);
  assert.equal((await loadUsage(st, NOW)).neurons, FILM_NEURON_SHARE - 10);
  // Reserving a batch takes only what fits, in one step.
  assert.equal(await reserve(st, 'neurons', 4, 10, { now: NOW }), 2);
  assert.equal((await loadUsage(st, NOW)).neurons, FILM_NEURON_SHARE - 2);
  // The next UTC day starts fresh.
  assert.equal((await loadUsage(st, NOW + 86_400_000)).neurons, 0);
  assert.equal((await spend(st, 'hf_seconds', 211, { now: NOW })).ok, false, 'Hugging Face ZeroGPU stays under the 3.5 free minutes a day');
});

test('tier planning against the budget: less allowance means more reframing, never paid work', () => {
  const full = planFilm({ targetSeconds: 600, providers: providers(), now: NOW });
  const low = planFilm({ targetSeconds: 600, providers: providers({ workers_ai: { remaining: { neurons: 30 * NEURONS.still } } }), now: NOW });
  assert.equal(full.reuse, 1);
  assert.ok(low.reuse > full.reuse && low.unique_stills < full.unique_stills);
  const none = planFilm({ targetSeconds: 600, providers: providers({ workers_ai: { usable: false, status: 'connected', detail: 'No neurons left today.' } }), now: NOW });
  assert.equal(none.ok, false);
  assert.match(none.said, /resets at midnight UTC/);
});

test('internal-only mode and a no-export project keep work off outside GPUs, and the plan says why', async () => {
  const st = memory();
  await st.put('film:validation', { kaggle: { ok: true, username: 'owner', allowed_s: 30 * 3600, used_s: 0, reserved_s: 0 }, github_actions: { ok: true } });
  const env = { AI: {}, CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app', KAGGLE_API_TOKEN: 'owner:KGAT_x' };
  const open = await farmProviders(env, st, { now: NOW });
  assert.equal(open.find((p) => p.id === 'kaggle').usable, true);
  for (const opts of [{ internalOnly: true }, { noExport: true }]) {
    const list = await farmProviders(env, st, { now: NOW, ...opts });
    const k = list.find((p) => p.id === 'kaggle');
    assert.deepEqual([k.usable, k.status], [false, 'blocked']);
    const plan = planFilm({ targetSeconds: 7200, deadlineSeconds: 3600, providers: list, now: NOW });
    assert.equal(plan.tier_a, 0);
    assert.match(speakPlan(plan), opts.internalOnly ? /internal-only mode is on/i : /stays inside CHE/);
  }
});

test('Colab is listed honestly as not automated and is never planned', async () => {
  const colab = (await farmProviders({ AI: {} }, memory(), { now: NOW })).find((p) => p.id === 'colab');
  assert.deepEqual([colab.usable, colab.status], [false, 'not automated']);
  assert.match(colab.detail, /no official way to start a notebook without a person opening it/);
});

test('a provider counts as connected only after a validation call succeeded', async () => {
  const st = memory();
  const env = { AI: {}, CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app', KAGGLE_API_TOKEN: 'owner:KGAT_x' };
  const before = await farmProviders(env, st, { now: NOW });
  assert.deepEqual(before.map((p) => p.status).slice(0, 3), ['built in, not yet checked', 'not yet checked', 'not yet checked']);
  assert.ok(before.filter((p) => p.id !== 'workers_ai').every((p) => !p.usable));
  await st.put('film:validation', { kaggle: { ok: false, error: 'Kaggle rejected that token.' } });
  assert.equal((await farmProviders(env, st, { now: NOW })).find((p) => p.id === 'kaggle').status, 'not working');
});

// ─── The owner's words ───────────────────────────────────────────────────────

test('the owner\'s film words are read deterministically; ordinary movie talk is not an order', () => {
  const make = filmIntent('Chay, make me a 2-hour movie about a lighthouse keeper in an hour');
  assert.deepEqual([make.kind, make.seconds, make.deadline.seconds, make.topic], ['make', 7200, 3600, 'a lighthouse keeper']);
  const fast = filmIntent('Make me a 5 minute film about bees as fast as possible');
  assert.deepEqual([fast.kind, fast.seconds, fast.deadline.seconds, fast.topic], ['make', 300, 0, 'bees']);
  assert.equal(filmIntent('make me a 10-minute movie about a heist in under 5 minutes').deadline.seconds, 300);
  assert.equal(filmIntent("how's my movie going?").kind, 'status');
  assert.deepEqual(filmIntent('remake shot 12'), { kind: 'remake', shot: 12 });
  assert.equal(filmIntent('pause my movie').kind, 'pause');
  assert.equal(filmIntent('stop the film').kind, 'cancel');
  assert.equal(filmIntent('render farm status').kind, 'farm');
  assert.equal(filmIntent('open the film studio').kind, 'open');
  assert.equal(filmIntent('How long would a 2-hour movie take?').kind, 'plan');
  for (const words of ["What's a good movie to watch tonight?", 'I watched a film yesterday', 'the movie was great', 'make me a sandwich', 'film the meeting']) assert.equal(filmIntent(words), null, words);
  assert.equal(lengthFrom('an hour and a half'), 5400);
  assert.equal(deadlineFrom('in seconds').seconds, 0);
});

// ─── Screenplay and shots ────────────────────────────────────────────────────

const OUTLINE = { title: 'The Keeper', logline: 'A keeper guards a light.', characters: [{ id: 'mara', name: 'Mara', look: 'woman, 60, grey braid, wool coat', voice: 'female, warm' }], scenes: [{ setting: 'Lighthouse at dusk', summary: 'Mara climbs the stairs.', shots: 3 }, { setting: 'Lamp room, night', summary: 'Mara lights the lamp.', shots: 3 }] };
const SHOTS = (n) => ({ shots: Array.from({ length: n }, (_, i) => ({ description: `Shot ${i + 1}: Mara at work`, camera: i % 2 ? 'pan left' : 'slow push in', characters: ['mara'], dialogue: i % 2 ? [] : [{ character: 'Mara', line: `Line ${i + 1}.` }], sound: 'wind' })) });

test('the screenplay is checked: scene shot counts land on the planned length, and lines name only real characters', () => {
  const outline = validOutline(OUTLINE, { shots: 10 });
  assert.equal(outline.scenes.reduce((n, s) => n + s.shots, 0), 10);
  assert.equal(validOutline({ title: 'x', scenes: [] }, { shots: 5 }).error, 'the outline has no usable scenes');
  const scene = validSceneShots({ shots: [{ description: 'a', dialogue: [{ character: 'Ghost', line: 'boo' }, { character: 'mara', line: 'hi' }] }] }, { id: 1, shots: 3 }, outline.characters);
  assert.deepEqual(scene.shots[0].dialogue, [{ character: 'mara', line: 'hi' }]);
});

test('assembly order: only verified shots, in film order, cut into contiguous segments whose voices sit at their times', () => {
  const outline = validOutline(OUTLINE, { shots: 6 });
  const plan = { reuse: 2, tier_a: 0, segments: 2 };
  const shots = shotList(outline, { 1: SHOTS(3).shots.map((s) => validSceneShots({ shots: [s] }, { id: 1, shots: 1 }, outline.characters).shots[0]), 2: SHOTS(3).shots.map((s) => validSceneShots({ shots: [s] }, { id: 2, shots: 1 }, outline.characters).shots[0]) }, plan);
  shots.forEach((s) => { s.status = 'verified'; s.still_key = s.still_of === s.n ? `film/film_0000000000000000/stills/${s.n}.jpg` : ''; s.dialogue.forEach((d, i) => { d.audio_key = `film/film_0000000000000000/voice/${s.n}-${i}.mp3`; d.audio_s = 1.2; }); });
  shots[3].status = 'failed';
  const film = { id: 'film_0000000000000000', plan };
  const a = assemblyPlan(film, shots);
  assert.deepEqual(a.missing, [4]);
  assert.deepEqual(a.segments.flatMap((s) => s.shots), [1, 2, 3, 5, 6], 'film order, no failed shot');
  assert.equal(a.segments.length, 2);
  const spec = segmentSpec(film, a.segments[0], a.timed);
  assert.ok(spec.audio.every((x, i, all) => i === 0 || x.at > all[i - 1].at), 'voices in time order');
  assert.ok(spec.shots.every((s) => s.image.startsWith('film/')), 'a reframed shot points at the picture it reuses');
  assert.equal(spec.shots[1].image, spec.shots[0].image, 'shot 2 reframes shot 1\'s picture');
  assert.ok(spec.assets.includes(spec.audio[0].key));
});

test('checks: a blank, tiny or non-image picture fails; real file facts are read without a decoder', () => {
  assert.deepEqual(imageSize(jpeg()), { type: 'jpeg', width: 1024, height: 1024 });
  assert.equal(checkStill(jpeg()).ok, true);
  assert.match(checkStill(jpeg({ bytes: 5000 })).reason, /almost no detail/);
  assert.match(checkStill(jpeg({ size: 256 })).reason, /too small/);
  assert.match(checkStill(new Uint8Array(50_000)).reason, /not a real image/);
  assert.ok(Math.abs(mp3Seconds(mp3(2)) - 2) < 0.05);
  assert.equal(mp3Seconds(new Uint8Array(1000)), 0);
});

// ─── Farm mechanics (checked against the official Kaggle client) ─────────────

test('Kaggle: Bearer for API tokens, Basic for legacy keys; the quota is read from GetAcceleratorQuotaStatistics', async () => {
  assert.equal(kaggleAuth('owner:KGAT_abc').header, 'Bearer KGAT_abc');
  assert.equal(kaggleAuth(`owner:${'a'.repeat(32)}`).header, `Basic ${btoa(`owner:${'a'.repeat(32)}`)}`);
  assert.equal(kaggleAuth('a'.repeat(32)), null, 'a legacy key needs the username');
  assert.equal(durationSeconds('151.500s'), 151.5);
  const seen = [];
  const ok = await validateKaggle('owner:KGAT_abc', async (url, init) => { seen.push([String(url), init.method, init.headers.Authorization]); return Response.json({ gpuQuota: { totalTimeAllowed: '108000s', timeUsed: '3600.5s', timeReserved: '0s' }, quotaRefreshTime: '2026-10-24T00:00:00Z' }); });
  assert.deepEqual(seen[0], ['https://api.kaggle.com/v1/kernels.KernelsApiService/GetAcceleratorQuotaStatistics', 'POST', 'Bearer KGAT_abc']);
  assert.deepEqual([ok.ok, ok.allowed_s, ok.used_s, ok.username], [true, 108000, 3600.5, 'owner']);
  assert.equal((await validateKaggle('owner:KGAT_bad', async () => new Response('{}', { status: 401 }))).status, 'unauthorized');
});

test('Kaggle sessions are private T4 kernels that Kaggle itself stops at the planned time; the script carries a film-scoped token, never the device token', async () => {
  let body;
  const out = await startKaggleSession('owner:KGAT_abc', { base: 'https://che.example', film: { id: 'film_0123456789abcdef' }, token: 'farmtoken123', seconds: 7200 }, async (url, init) => { body = JSON.parse(init.body); return Response.json({ ref: 'owner/che-film-0123456789', url: 'https://kaggle.com/x', versionNumber: 1 }); });
  assert.equal(out.ok, true);
  assert.deepEqual([body.enableGpu, body.enableInternet, body.isPrivate, body.machineShape, body.sessionTimeoutSeconds, body.kernelType], [true, true, true, 'NvidiaTeslaT4', 7200, 'script']);
  assert.match(body.text, /CHE_BASE = "https:\/\/che\.example"/);
  assert.match(body.text, /FARM_TOKEN = "farmtoken123"/);
  assert.match(body.text, /DEADLINE_S = int\("6900"\)/);
  assert.equal(KAGGLE_WORKER_PY, readFileSync(new URL('../renderfarm/kaggle_worker.py', import.meta.url), 'utf8'), 'the shipped worker file is exactly what CHE pushes');
  for (const f of HF_SPACE_FILES) assert.equal(f.content, readFileSync(new URL(`../renderfarm/hf_space/${f.path}`, import.meta.url), 'utf8'));
  const { token, record } = await newFarmToken(NOW);
  assert.equal(await farmTokenOpens(record, token, NOW), true);
  assert.equal(await farmTokenOpens({ ...record, revoked: true }, token, NOW), false);
  assert.equal(await farmTokenOpens(record, token, NOW + 13 * 3600_000), false, 'expires');
  assert.ok(!JSON.stringify(record).includes(token), 'stored only as a hash');
  assert.match(kaggleWorkerScript({ base: 'b', filmId: 'f', token: 't', deadlineS: 10 }), /DEADLINE_S = int\("10"\)/);
});

test('Keys: a Kaggle token is tested with a real authenticated POST before it is saved', async () => {
  const st = memory();
  let call;
  const saved = await saveKey(st, 'kaggle', 'owner:KGAT_0123456789', async (url, init) => { call = [String(url), init.method, init.headers.Authorization]; return Response.json({}); });
  assert.equal(saved.ok, true);
  assert.deepEqual(call, ['https://api.kaggle.com/v1/kernels.KernelsApiService/GetAcceleratorQuotaStatistics', 'POST', 'Bearer KGAT_0123456789']);
  const bad = await saveKey(st, 'kaggle', 'owner:KGAT_wrongwrong', async () => new Response('{}', { status: 401 }));
  assert.equal(bad.ok, false);
});

// ─── The pipeline, end to end ────────────────────────────────────────────────

function writer() {
  return async (messages) => {
    const last = messages[messages.length - 1].content;
    if (/Write the outline/.test(last)) return `Here you go:\n${JSON.stringify(OUTLINE)}`;
    const n = Number(/Write exactly (\d+) shots/.exec(last)[1]);
    return JSON.stringify(SHOTS(n));
  };
}

function fakeAI({ badFirst = 0 } = {}) {
  let still = 0;
  const write = writer();
  return {
    calls: () => still,
    run: async (model, input) => {
      if (Array.isArray(input?.messages) && /screenwriter/.test(input.messages[0]?.content || '')) return { response: await write(input.messages) };
      if (/flux/.test(model)) { still += 1; return { image: b64(still <= badFirst ? jpeg({ bytes: 4000 }) : jpeg()) }; }
      if (/melotts/.test(model)) return { audio: b64(mp3(1 + input.prompt.length / 30)) };
      return { response: 'ok' };
    },
  };
}

function github(record) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/Vondada/chey-app') return Response.json({ private: true });
    if (u.endsWith('/actions/workflows/che-film-render.yml/dispatches')) { record.dispatch = JSON.parse(init.body); return new Response(null, { status: 204 }); }
    if (u.includes('/actions/workflows/che-film-render.yml/runs')) return Response.json({ workflow_runs: record.run ? [record.run] : [] });
    return offline(url);
  };
}

async function studio({ badFirst = 0, seconds = 60 } = {}) {
  const storage = memory(); const bucket = r2(); const gh = {};
  const ai = fakeAI({ badFirst });
  const env = { AI: ai, CHE_DATA_BUCKET: bucket, CHE_GITHUB_TOKEN: 'gh', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const ctx = { storage, env, keys: {}, writer: writer(), base: 'https://che.example', fetcher: github(gh), now: NOW };
  const started = await startFilm(ctx, { topic: 'a lighthouse keeper', seconds, deadline: null });
  return { storage, bucket, gh, ai, ctx, started };
}
async function runUntil(ctx, states, max = 200) {
  const store = new FilmStore(ctx.storage);
  for (let i = 0; i < max; i += 1) {
    ctx.now += 1000;
    const film = await store.latest();
    if (states.includes(film.state)) return film;
    await filmTick(ctx);
  }
  return store.latest();
}
const req = (path, { token, method = 'GET', body, header = 'X-CHE-Render-Token' } = {}) => new Request(`https://che.example${path}`, { method, headers: token ? { [header]: token } : {}, ...(body !== undefined ? { body } : {}) });

test('end to end: a one-minute film is written, made, assembled on parallel runners, uploaded in parts and done only after the stored MP4 checks out', async () => {
  const { storage, bucket, gh, ctx, started } = await studio({ seconds: 60 });
  assert.equal(started.ok, true);
  assert.match(started.said, /^A 60-second film takes about .* as fast as free compute allows: all stills with camera motion/);
  assert.match(started.said, /Starting now\.$/);
  const film = await runUntil(ctx, ['assembling', 'failed']);
  assert.equal(film.state, 'assembling', film.errors?.join('; '));
  assert.equal(film.title, 'The Keeper');
  const shots = await new FilmStore(storage).shots(film.id, film.shot_count);
  assert.ok(shots.every((s) => s.status === 'verified'));
  assert.ok([...bucket.objects.keys()].some((k) => k.startsWith(`film/${film.id}/stills/`)) && [...bucket.objects.keys()].some((k) => k.startsWith(`film/${film.id}/voice/`)));
  // GitHub got one dispatch with the segment count; the token went only there.
  assert.equal(gh.dispatch.inputs.job_id, film.assembly.job.id);
  assert.equal(Number(gh.dispatch.inputs.segments), film.assembly.segments);
  const token = gh.dispatch.inputs.token;
  assert.ok(!JSON.stringify(await storage.get(`film:${film.id}`)).includes(token), 'the assembly token is stored only as a hash');
  // The runner side: wrong token sees nothing; the right one reads its segment and files.
  const job = film.assembly.job.id;
  assert.equal((await filmTokenRoute(ctx, `/api/film/render/${job}/segment/0`, req(`/api/film/render/${job}/segment/0`, { token: 'nope' }))).status, 404);
  const spec = await (await filmTokenRoute(ctx, `/api/film/render/${job}/segment/0`, req(`/api/film/render/${job}/segment/0`, { token }))).json();
  assert.ok(spec.shots.length && spec.assets.length);
  const asset = await filmTokenRoute(ctx, `/api/film/render/${job}/asset`, req(`/api/film/render/${job}/asset?key=${encodeURIComponent(spec.assets[0])}`, { token }));
  assert.equal(asset.status, 200);
  assert.equal((await filmTokenRoute(ctx, `/api/film/render/${job}/asset`, req(`/api/film/render/${job}/asset?key=media/other.jpg`, { token }))).status, 404, 'only this film\'s files');
  // The join job uploads the film in two parts; CHE reads it back and checks it.
  const bytes = mp4({ seconds: film.assembly.total_s });
  const { upload_id: uploadId } = await (await filmTokenRoute(ctx, `/api/film/render/${job}/upload/start`, req(`/api/film/render/${job}/upload/start`, { token, method: 'POST' }))).json();
  const half = Math.floor(bytes.length / 2);
  const parts = [];
  for (const [n, chunk] of [[1, bytes.slice(0, half)], [2, bytes.slice(half)]]) parts.push(await (await filmTokenRoute(ctx, `/api/film/render/${job}/upload/part`, req(`/api/film/render/${job}/upload/part?upload_id=${uploadId}&n=${n}`, { token, method: 'PUT', body: chunk }))).json());
  const done = await filmTokenRoute(ctx, `/api/film/render/${job}/upload/complete`, req(`/api/film/render/${job}/upload/complete`, { token, method: 'POST', body: JSON.stringify({ upload_id: uploadId, parts }) }));
  assert.equal(done.status, 200);
  const final = await new FilmStore(storage).latest();
  assert.equal(final.state, 'done');
  assert.equal(final.result.seconds, Math.round(film.assembly.total_s * 100) / 100);
  const { listMedia } = await import('./media.js');
  const item = (await listMedia(storage)).find((m) => m.id === final.result.media_id);
  assert.deepEqual([item.kind, item.verified, item.blob_key, item.source], ['video', true, `film/${film.id}/film.mp4`, 'che_film_studio']);
  assert.equal((await filmTokenRoute(ctx, `/api/film/render/${job}/segment/0`, req(`/api/film/render/${job}/segment/0`, { token }))).status, 404, 'the token dies with the job');
});

test('no "done" without a verified MP4: a file of the wrong length, size or codecs fails the film', async () => {
  for (const bad of [{ seconds: 3 }, { width: 640, height: 360 }, { codecs: 'avc1' }]) {
    const { storage, gh, ctx } = await studio({ seconds: 30 });
    const film = await runUntil(ctx, ['assembling', 'failed']);
    const job = film.assembly.job.id; const token = gh.dispatch.inputs.token;
    const bytes = mp4({ seconds: film.assembly.total_s, ...bad });
    const { upload_id: id } = await (await filmTokenRoute(ctx, `/api/film/render/${job}/upload/start`, req(`/api/film/render/${job}/upload/start`, { token, method: 'POST' }))).json();
    const part = await (await filmTokenRoute(ctx, `/api/film/render/${job}/upload/part`, req(`/api/film/render/${job}/upload/part?upload_id=${id}&n=1`, { token, method: 'PUT', body: bytes }))).json();
    const res = await filmTokenRoute(ctx, `/api/film/render/${job}/upload/complete`, req(`/api/film/render/${job}/upload/complete`, { token, method: 'POST', body: JSON.stringify({ upload_id: id, parts: [part] }) }));
    assert.equal(res.status, 422);
    const after = await new FilmStore(storage).latest();
    assert.equal(after.state, 'failed', JSON.stringify(bad));
    assert.match(after.errors.at(-1), /did not pass its checks/);
  }
});

test('check and retry: a failed picture is made again; after three failures the shot is left out and never ships', async () => {
  const retry = await studio({ badFirst: 1, seconds: 30 });
  const film = await runUntil(retry.ctx, ['assembling', 'failed']);
  assert.equal(film.state, 'assembling');
  assert.ok(film.stats.retries >= 1);
  assert.ok((await retry.storage.get('film:lessons')).some((l) => l.id === 'detail'), 'what failed is remembered for later prompts');
  const broken = await studio({ badFirst: 1000, seconds: 30 });
  const failed = await runUntil(broken.ctx, ['assembling', 'failed']);
  assert.equal(failed.state, 'failed');
  assert.match(failed.errors.at(-1), /no shot passed its checks/);
  assert.equal(broken.gh.dispatch, undefined, 'nothing unverified was sent to assembly');
});

test('interrupt and resume: a pause holds every pass, nothing is lost, and resume continues where it stopped', async () => {
  const { storage, ctx } = await studio({ seconds: 60 });
  const store = new FilmStore(storage);
  for (let i = 0; i < 4; i += 1) await filmTick(ctx);
  const mid = await store.latest();
  const paused = await setFilmState(ctx, 'pause');
  assert.match(paused.said, /Nothing is lost/);
  const madeBefore = (await store.latest()).stats.stills_made;
  for (let i = 0; i < 5; i += 1) assert.equal(await filmTick(ctx), null, 'a paused film does no work');
  assert.equal((await store.latest()).stats.stills_made, madeBefore);
  // A background pass that loaded the film before the pause cannot undo it.
  await store.save({ ...mid, state: 'making' });
  assert.equal((await store.latest()).state, 'paused');
  await setFilmState(ctx, 'resume');
  const film = await runUntil(ctx, ['assembling', 'failed']);
  assert.equal(film.state, 'assembling');
});

test('remake shot N: the shot and the shots that reuse its picture are made again', async () => {
  const { storage, ctx } = await studio({ seconds: 60 });
  await runUntil(ctx, ['assembling']);
  const store = new FilmStore(storage);
  const film = await store.latest();
  film.state = 'done'; await store.save(film, { force: true });
  const out = await remakeShot(ctx, 2);
  assert.equal(out.ok, true);
  assert.match(out.said, /Remaking shot 2 of "The Keeper"/);
  await filmTick(ctx);
  const shot = (await store.shots(film.id, film.shot_count)).find((s) => s.n === 2);
  assert.equal(shot.still_of, 2, 'it gets its own new picture');
  assert.equal((await remakeShot(ctx, 999)).ok, false);
});

test('moving clips: a farm that cannot start moves those shots to stills with motion and says so; a clip upload is checked', async () => {
  const storage = memory(); const bucket = r2(); const gh = {};
  await storage.put('film:validation', { github_actions: { ok: true, checked_ms: NOW }, kaggle: { ok: true, username: 'owner', allowed_s: 30 * 3600, used_s: 0, reserved_s: 0, checked_ms: NOW } });
  const env = { AI: fakeAI(), CHE_DATA_BUCKET: bucket, CHE_GITHUB_TOKEN: 'gh', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const kaggleRefuses = async (url, init) => (String(url).includes('SaveKernel') ? Response.json({ error: 'Phone verification is required for internet access. KGAT_secretsecretsecret0123456789' }) : github(gh)(url, init));
  const ctx = { storage, env, keys: { KAGGLE_API_TOKEN: 'owner:KGAT_abc' }, writer: writer(), base: 'https://che.example', fetcher: kaggleRefuses, now: NOW };
  const started = await startFilm(ctx, { topic: 'a heist', seconds: 7200, deadline: { seconds: 3600 } });
  assert.equal(started.ok, true);
  const store = new FilmStore(storage);
  for (let i = 0; i < 6; i += 1) await filmTick(ctx);
  const film = await store.latest();
  const shots = await store.shots(film.id, film.shot_count);
  assert.ok(film.plan.tier_a > 0, 'the plan asked for moving clips');
  assert.ok(shots.every((s) => s.tier === 'B'), 'none stays waiting on a farm that never started');
  assert.ok(film.notes.some((n) => /moving shots became stills with camera motion/.test(n)));
  assert.ok(film.notes.every((n) => !n.includes('KGAT_secret')), 'a token echoed by the provider is masked');
});

test('farm routes: only this film\'s farm token opens them, and a clip must be a real MP4 before it is used', async () => {
  const storage = memory(); const bucket = r2();
  const store = new FilmStore(storage);
  const { token, record } = await newFarmToken(NOW);
  const film = { id: 'film_00000000000000aa', state: 'making', shot_count: 2, outline: validOutline(OUTLINE, { shots: 2 }), farm: { ...record, provider: 'kaggle' }, stats: { clips_made: 0 } };
  await store.save(film, { force: true });
  await store.putShots(film.id, [
    { n: 1, tier: 'A', still_of: 1, still_key: `film/${film.id}/stills/1.jpg`, status: 'planned', dialogue: [], description: 'Mara climbs', characters: [], setting: 'stairs' },
    { n: 2, tier: 'B', still_of: 2, still_key: `film/${film.id}/stills/2.jpg`, status: 'planned', dialogue: [], description: 'x', characters: [], setting: 'y' },
  ]);
  const ctx = { storage, env: { CHE_DATA_BUCKET: bucket }, base: 'https://che.example', now: NOW };
  const call = (path, opts) => filmTokenRoute(ctx, path.split('?')[0], req(path, { header: 'X-CHE-Farm-Token', ...opts }));
  assert.equal((await call(`/api/film/farm/${film.id}/next`, { token: 'wrong' })).status, 404);
  const job = await (await call(`/api/film/farm/${film.id}/next`, { token })).json();
  assert.equal(job.shot, 1);
  assert.deepEqual(await (await call(`/api/film/farm/${film.id}/next`, { token })).json(), { done: false }, 'a claimed shot is not handed out twice');
  assert.equal((await call(`/api/film/farm/${film.id}/result?shot=1`, { token, method: 'PUT', body: new Uint8Array(50_000) })).status, 422);
  assert.equal((await call(`/api/film/farm/${film.id}/result?shot=1&seconds=200`, { token, method: 'PUT', body: mp4({ seconds: 5, codecs: 'avc1' }) })).status, 200);
  assert.equal((await storage.get(`film:${film.id}:clips`))[1].key, `film/${film.id}/clips/1.mp4`);
  assert.equal((await loadRates(storage)).measured.kaggle_clip_s, true, 'clip time is measured');
});

test('through /api/chat: the owner\'s words start a film with its ETA, status answers from the stored state, and guests cannot', async () => {
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const generated = new URL('./.film_studio.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  let mod;
  try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
  const st = memory(); const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: fakeAI(), CHE_DATA_BUCKET: r2(), CHE_GITHUB_TOKEN: 'gh', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const gh = {};
  const before = globalThis.fetch; globalThis.fetch = github(gh);
  try {
    const state = new mod.CheState({ storage: st, waitUntil: (p) => pending.push(p) }, env);
    env.CHE_STATE = { getByName: () => state };
    const send = (path, body, token = '', method = 'POST') => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
    const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
    const say = async (message) => { const raw = await (await send('/api/chat', { message, history: [] }, token)).text(); const done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || {}; return { reply: replyFromNdjson(raw), done }; };
    const made = await say('Chay, make me a 1-minute movie about a lighthouse keeper as fast as possible');
    assert.equal(made.done.source, 'che_film_studio');
    assert.equal(made.done.model_calls, 0);
    assert.match(made.reply, /takes about .* as fast as free compute allows.*Starting now\./);
    assert.ok(await st.get('film:wake'), 'the alarm is asked to start the work');
    await state.filmPass();
    const status = await say("how's my movie going?");
    assert.equal(status.done.source, 'che_film_studio');
    assert.match(status.reply, /"The Keeper"|your film about a lighthouse keeper/);
    assert.match(status.reply, /against an estimate of/);
    const view = await (await send('/api/film', null, token, 'GET')).json();
    assert.equal(view.film.title, 'The Keeper');
    assert.ok(view.providers.some((p) => p.id === 'colab' && p.status === 'not automated'));
    assert.equal((await send('/api/film', null, '', 'GET')).status, 401);
    const farm = await say('render farm status');
    assert.match(farm.reply, /Your own computer is never part of it/);
  } finally { globalThis.fetch = before; }
});
