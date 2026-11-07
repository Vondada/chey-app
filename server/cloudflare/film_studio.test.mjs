// Film Studio (owner handoff 2026-10-22, with the owner's speed correction). Offline and deterministic: no model,
// GPU or network is reached; Workers AI, GitHub, Kaggle and R2 are fakes that behave like the real APIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_RATES, FARM_PROVIDERS, FILM_NEURON_SHARE, FilmStore, NEURONS, assemblyPlan, checkStill, deadlineFrom, farmProviders,
  filmIntent, imageSize, lengthFrom, loadRates, loadUsage, mp3Seconds, planFilm, recordRate, reserve, segmentSpec, shotList,
  outlineMessages, shotSeconds, speakFarm, speakPlan, speakStatus, spend, validOutline, validSceneShots, _internals,
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
    delete: async (key) => { objects.delete(key); },
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
  assert.ok(two.tier_a > 0, 'with an hour, shots move');
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

test('same faces are planned at what they really cost: a short film gets them within today\'s allowance; a 10-minute film is told it cannot', () => {
  const short = planFilm({ targetSeconds: 60, providers: providers(), now: NOW });
  assert.equal(short.faces, true);
  assert.equal(short.neurons.stills, Math.round(short.unique_stills * NEURONS.picture), "priced at the reference picture");
  assert.ok(short.neurons.stills + short.neurons.cast + short.neurons.voices <= short.neurons.left_today, 'pictures, portraits and voices fit what is left today');
  // Codex on #948: 100 new pictures at the reference price would need about 11,000 neurons, over the film's daily share.
  const ten = planFilm({ targetSeconds: 600, providers: providers(), now: NOW });
  assert.equal(ten.faces, false);
  assert.equal(ten.reuse, 1, 'it keeps one new picture per shot instead of reframing for faces');
  assert.ok(ten.notes.some((n) => /cannot keep faces the same .* faces come from the written descriptions/.test(n)));
  assert.match(speakPlan(ten), /faces come from the written descriptions/);
});

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
  for (const words of ["What's a good movie to watch tonight?", 'I watched a film yesterday', 'the movie was great', 'make me a sandwich', 'film the meeting', 'Build the search feature into your app.']) assert.equal(filmIntent(words), null, words);
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
    // A fixed cast: the writer names cast ids (and one stranger, and a look of its own, which must be ignored).
    if (/Write the outline/.test(last) && /fixed cast of office members/.test(last)) return JSON.stringify({ ...OUTLINE, title: 'The Coffee Machine', characters: [{ id: 'knox', look: 'a pirate' }, { id: 'CHE' }, { id: 'ghost' }] });
    if (/Write the outline/.test(last)) return `Here you go:\n${JSON.stringify(OUTLINE)}`;
    const n = Number(/Write exactly (\d+) shots/.exec(last)[1]);
    const lead = /Cast:\n(\w+):/.exec(last)?.[1] || 'mara';
    return JSON.stringify({ shots: SHOTS(n).shots.map((x) => ({ ...x, characters: [lead], dialogue: x.dialogue.map((d) => ({ ...d, character: lead })) })) });
  };
}

function fakeAI({ badFirst = 0 } = {}) {
  let still = 0;
  const write = writer();
  return {
    calls: () => still,
    run: async (model, input) => {
      if (Array.isArray(input?.messages) && /screenwriter/.test(input.messages[0]?.content || '')) return { response: await write(input.messages) };
      if (/flux-2-klein/.test(model)) {
        // FLUX.2 klein reads a multipart form; like the real model, it refuses a reference of 512x512 or more.
        const form = await new Response(input.multipart.body, { headers: { 'content-type': input.multipart.contentType } }).formData();
        input.form = form;
        const ref = form.get('input_image_0');
        if (!ref) return { image: b64(jpeg({ size: Number(form.get('width')), bytes: 20_000 })) }; // a cast portrait
        const size = imageSize(new Uint8Array(await ref.arrayBuffer()));
        if (!size || size.width >= 512 || size.height >= 512) throw new Error(`input image must be smaller than 512x512 (got ${size?.width}x${size?.height})`);
      }
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

async function studio({ badFirst = 0, seconds = 60, withR2 = true } = {}) {
  const storage = memory(); const bucket = r2(); const gh = {};
  const ai = fakeAI({ badFirst });
  // withR2: false is production's setup (no R2 bucket bound): every file goes to CHE's own store.
  const env = { AI: ai, ...(withR2 ? { CHE_DATA_BUCKET: bucket } : {}), CHE_GITHUB_TOKEN: 'gh', CHE_GITHUB_REPO: 'Vondada/chey-app' };
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
  assert.match(started.said, /^A 60-second film takes about [^,]*: all stills with camera motion/, 'no farm connected, so stills; no deadline was given, so none is quoted back');
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

// Regression (reliability lane, 2026-10-25): production binds no R2 bucket, so a finished film lives in CHE's own store,
// but its media record said blob 'r2'. Opening it (GET /api/media/<id>/video reads readBlob) found no bucket and answered
// "Media data missing", and the video library called it missing. The record must name the store the bytes are in.
test('a film finished without R2 reopens: the record names CHE\'s own store, the exact MP4 reads back, and the library calls it playable', async () => {
  const { storage, gh, ctx } = await studio({ seconds: 30, withR2: false });
  const film = await runUntil(ctx, ['assembling', 'failed']);
  assert.equal(film.state, 'assembling', film.errors?.join('; '));
  const job = film.assembly.job.id; const token = gh.dispatch.inputs.token;
  const bytes = mp4({ seconds: film.assembly.total_s });
  const { upload_id: id } = await (await filmTokenRoute(ctx, `/api/film/render/${job}/upload/start`, req(`/api/film/render/${job}/upload/start`, { token, method: 'POST' }))).json();
  const part = await (await filmTokenRoute(ctx, `/api/film/render/${job}/upload/part`, req(`/api/film/render/${job}/upload/part?upload_id=${id}&n=1`, { token, method: 'PUT', body: bytes }))).json();
  const done = await filmTokenRoute(ctx, `/api/film/render/${job}/upload/complete`, req(`/api/film/render/${job}/upload/complete`, { token, method: 'POST', body: JSON.stringify({ upload_id: id, parts: [part] }) }));
  assert.equal(done.status, 200);
  const final = await new FilmStore(storage).latest();
  assert.equal(final.state, 'done');
  const { listMedia, readBlob, verifyMediaFile } = await import('./media.js');
  const { mediaLibraryReport } = await import('./media_library.js');
  const items = await listMedia(storage);
  const item = items.find((m) => m.id === final.result.media_id);
  assert.equal(item.blob, 'che_store', 'the record names the store that holds the bytes');
  const back = await readBlob(ctx.env, storage, item);
  assert.ok(back, 'the film reopens');
  assert.deepEqual(new Uint8Array(back), new Uint8Array(bytes), 'the exact MP4 that was uploaded');
  assert.equal(mp4Facts(new Uint8Array(back)).ok, true, 'and it decodes as an MP4');
  assert.equal((await verifyMediaFile(ctx.env, storage, item)).status, 'verified');
  const report = await mediaLibraryReport(ctx.env, storage, items);
  assert.equal(report.playable, 1, JSON.stringify(report.videos));
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

test('one face per character: a portrait is made once, every shot of her is drawn from it, and the status says so', async () => {
  const { storage, bucket, ai, ctx } = await studio({ seconds: 60 });
  const calls = [];
  const run = ai.run;
  ai.run = async (model, input) => { calls.push({ model, input }); return run(model, input); };
  const film = await runUntil(ctx, ['assembling', 'failed']);
  assert.equal(film.state, 'assembling', film.errors?.join('; '));
  assert.deepEqual(Object.keys(film.cast), ['mara']);
  const portraitKey = `film/${film.id}/cast/mara.jpg`;
  assert.equal(film.cast.mara.key, portraitKey);
  assert.ok(bucket.objects.has(portraitKey), 'the portrait is kept in the film files');
  const portraits = calls.filter((c) => /reference portrait/i.test(c.input?.form?.get('prompt') || ''));
  assert.equal(portraits.length, 1, 'the portrait is made once');
  assert.deepEqual([portraits[0].input.form.get('width'), portraits[0].input.form.get('height')], ['448', '448'], 'under the reference input limit');
  const refs = calls.filter((c) => c.model === '@cf/black-forest-labs/flux-2-klein-4b');
  assert.ok(refs.length >= 1);
  // The reference model gets the real portrait as its input image, in a multipart form.
  const form = refs.find((c) => c.input.form?.get('input_image_0')).input.form;
  assert.match(form.get('prompt'), /Mara: woman, 60, grey braid/);
  const sent = new Uint8Array(await form.get('input_image_0').arrayBuffer());
  const kept = new Uint8Array(await (await bucket.get(portraitKey)).arrayBuffer());
  assert.deepEqual(sent, kept);
  const shots = await new FilmStore(storage).shots(film.id, film.shot_count);
  assert.ok(shots.filter((s) => s.still_of === s.n).every((s) => s.from_portrait), 'every new picture of Mara starts from her portrait');
  assert.match(speakStatus({ ...film, state: 'making' }, shots, NOW), /1 character portrait keeps faces the same from shot to shot\./);
});

test('a reference model that fails is said once, and the film is still made from the descriptions', async () => {
  const { storage, ai, ctx } = await studio({ seconds: 60 });
  const run = ai.run;
  let refCalls = 0;
  // The portrait works; drawing a shot from it fails.
  ai.run = async (model, input) => { const out = await run(model, input); if (input?.form?.get('input_image_0')) { refCalls += 1; throw new Error('5006: unsupported input'); } return out; };
  const film = await runUntil(ctx, ['assembling', 'failed']);
  assert.equal(film.state, 'assembling', film.errors?.join('; '));
  assert.ok(refCalls >= 1 && refCalls <= 4, `only the first batch of four pictures tried it (${refCalls})`);
  assert.match(film.ref_off, /unsupported input/);
  const shots = await new FilmStore(storage).shots(film.id, film.shot_count);
  assert.ok(shots.every((s) => s.status === 'verified'));
  assert.match(speakStatus({ ...film, state: 'making' }, shots, NOW), /Faces come from the written descriptions only: the reference picture model failed \(5006: unsupported input\)\./);
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

test('a Kaggle session that cannot start: the planned lip sync is dropped, said once, and the film goes on', async () => {
  const storage = memory(); const bucket = r2(); const gh = {};
  await storage.put('film:validation', { github_actions: { ok: true, checked_ms: NOW }, kaggle: { ok: true, username: 'owner', allowed_s: 30 * 3600, used_s: 0, reserved_s: 0, checked_ms: NOW } });
  const env = { AI: fakeAI(), CHE_DATA_BUCKET: bucket, CHE_GITHUB_TOKEN: 'gh', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const kaggleRefuses = async (url, init) => (String(url).includes('SaveKernel') ? Response.json({ error: 'Phone verification is required for internet access.' }) : github(gh)(url, init));
  const ctx = { storage, env, keys: { KAGGLE_API_TOKEN: 'owner:KGAT_abc' }, writer: writer(), base: 'https://che.example', fetcher: kaggleRefuses, now: NOW };
  assert.equal((await startFilm(ctx, { topic: 'a keeper', seconds: 60, deadline: { seconds: 7200 } })).ok, true);
  const film = await runUntil(ctx, ['assembling', 'failed']);
  assert.equal(film.state, 'assembling', film.errors?.join('; '));
  assert.ok(film.plan.lip_sync > 0, 'the plan had lip sync');
  assert.equal(film.notes.filter((n) => /talking shots? got no lip sync: no free GPU session could start/.test(n)).length, 1, film.notes.join(' | '));
  const shots = await new FilmStore(storage).shots(film.id, film.shot_count);
  assert.ok(shots.every((s) => s.status === 'verified' && !s.lip_key), 'nothing waits on a farm that never started');
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
  assert.deepEqual(await (await call(`/api/film/farm/${film.id}/next`, { token })).json(), { wait: 30 }, 'a claimed shot is not handed out twice; the worker waits (the old { done: false } crashed it: no image_url)');
  assert.equal((await call(`/api/film/farm/${film.id}/result?shot=1`, { token, method: 'PUT', body: new Uint8Array(50_000) })).status, 422);
  assert.equal((await call(`/api/film/farm/${film.id}/result?shot=1&seconds=200`, { token, method: 'PUT', body: mp4({ seconds: 5, codecs: 'avc1' }) })).status, 200);
  assert.equal((await storage.get(`film:${film.id}:clips`))[1].key, `film/${film.id}/clips/1.mp4`);
  assert.equal((await loadRates(storage)).measured.kaggle_clip_s, true, 'clip time is measured');
});

test('lip sync is planned at its real GPU cost: with Kaggle, talking shots get it; as fast as possible or without GPU time they do not, and the plan says so', () => {
  const one = planFilm({ targetSeconds: 60, deadlineSeconds: 7200, providers: providers(kaggleOn), talkingShots: 4, now: NOW });
  assert.equal(one.lip_sync, 4);
  // One GPU: the install runs beside the session start and the clips, then the four talking shots one after another.
  const r = DEFAULT_RATES;
  const clipsS = one.tier_a ? r.kaggle_startup_s + one.tier_a * r.kaggle_clip_s : 0;
  assert.equal(one.parts.lip_sync_s, Math.round(Math.max(clipsS, r.kaggle_startup_s + r.lipsync_setup_s) + 4 * r.kaggle_lipsync_s - clipsS), 'its install and each shot are in the ETA');
  // Two GPUs (measured): the talking shots are lip-synced while the clips are made, so the film is ready sooner.
  const two = planFilm({ targetSeconds: 60, deadlineSeconds: 7200, providers: providers(kaggleOn), talkingShots: 4, rates: { ...r, kaggle_gpus: 2 }, now: NOW });
  assert.equal(two.lip_sync, 4);
  assert.ok(two.eta_s <= one.eta_s, `two GPUs ${two.eta_s} s, one GPU ${one.eta_s} s`);
  // Where the clips take longer than the install, the second GPU takes the talking shots off the clip GPU's queue.
  const slowClips = { ...r, kaggle_clip_s: 900 };
  const one2 = planFilm({ targetSeconds: 60, deadlineSeconds: 7200, providers: providers(kaggleOn), talkingShots: 4, rates: slowClips, now: NOW });
  const two2 = planFilm({ targetSeconds: 60, deadlineSeconds: 7200, providers: providers(kaggleOn), talkingShots: 4, rates: { ...slowClips, kaggle_gpus: 2 }, now: NOW });
  assert.ok(one2.tier_a > 0 && two2.eta_s < one2.eta_s, `two GPUs ${two2.eta_s} s, one GPU ${one2.eta_s} s`);
  assert.match(speakPlan(one), /4 talking shots get lip sync on the free Kaggle GPU\./);
  assert.equal(planFilm({ targetSeconds: 60, deadlineSeconds: 7200, providers: providers(), now: NOW }).lip_sync, 0, 'no Kaggle, no lip sync');
  assert.equal(planFilm({ targetSeconds: 60, deadlineSeconds: 0, providers: providers(kaggleOn), now: NOW }).lip_sync, 0, 'as fast as possible uses no GPU');
  const short = planFilm({ targetSeconds: 60, deadlineSeconds: 7200, providers: providers({ kaggle: { usable: true, status: 'connected', remaining: { gpu_seconds: 1800 } } }), talkingShots: 6, now: NOW });
  assert.ok(short.lip_sync < 6);
  assert.ok(short.notes.some((n) => /talking shots get (no )?lip sync|of 6 talking shots get lip sync/i.test(n)), short.notes.join(' | '));
});

test('lip sync on the farm: after the clips, a talking shot is sent with its voices at the edit\'s times; the shot waits for it, and a failure lets it go on', async () => {
  const storage = memory(); const bucket = r2();
  const store = new FilmStore(storage);
  const { token, record } = await newFarmToken(NOW);
  const film = { id: 'film_00000000000000bb', state: 'making', shot_count: 3, outline: validOutline(OUTLINE, { shots: 3 }), plan: { lip_sync: 2, segments: 1, parts: {} }, farm: { ...record, provider: 'kaggle' }, stats: { clips_made: 0 } };
  await store.save(film, { force: true });
  const line = (k, s) => ({ character: 'mara', line: 'Hello there.', audio_key: `film/${film.id}/voice/${k}.mp3`, audio_s: s });
  await store.putShots(film.id, [
    { n: 1, tier: 'B', still_of: 1, still_key: `film/${film.id}/stills/1.jpg`, status: 'planned', dialogue: [line('1-0', 1.2), line('1-1', 0.8)], description: 'Mara talks', characters: ['mara'], setting: 'stairs' },
    { n: 2, tier: 'A', still_of: 2, still_key: `film/${film.id}/stills/2.jpg`, status: 'planned', dialogue: [line('2-0', 2)], description: 'Mara at the lamp', characters: ['mara'], setting: 'lamp' },
    { n: 3, tier: 'B', still_of: 3, still_key: `film/${film.id}/stills/3.jpg`, status: 'planned', dialogue: [], description: 'The sea', characters: [], setting: 'sea' },
  ]);
  const ctx = { storage, env: { CHE_DATA_BUCKET: bucket }, base: 'https://che.example', now: NOW };
  const call = (path, opts) => filmTokenRoute(ctx, path.split('?')[0], req(path, { header: 'X-CHE-Farm-Token', ...opts }));
  const next = async () => (await call(`/api/film/farm/${film.id}/next`, { token })).json();
  // The moving clip first; shot 2 cannot be lip-synced before its clip arrives.
  assert.equal((await next()).shot, 2);
  const lip = await next();
  assert.equal(lip.kind, 'lipsync');
  assert.equal(lip.shot, 1);
  assert.equal(lip.video_url, '', 'a still shot is held for its length');
  assert.match(lip.image_url, /stills%2F1\.jpg$/);
  assert.deepEqual(lip.audio.map((a) => a.at), [0.3, 1.85], 'the same times the edit gives the lines: 0.3 s in, 0.35 s between');
  assert.equal(lip.seconds, shotSeconds({ ...lip, tier: 'B', dialogue: [line('1-0', 1.2), line('1-1', 0.8)] }));
  assert.deepEqual(await next(), { wait: 30 }, 'shot 2 still waits for its clip, so the worker waits');
  // A clip shorter than the shot is refused; the right one is kept.
  assert.equal((await call(`/api/film/farm/${film.id}/result?shot=1&kind=lipsync`, { token, method: 'PUT', body: mp4({ seconds: 2, codecs: 'avc1' }) })).status, 422);
  assert.equal((await call(`/api/film/farm/${film.id}/result?shot=1&kind=lipsync&seconds=140`, { token, method: 'PUT', body: mp4({ seconds: lip.seconds, codecs: 'avc1' }) })).status, 200);
  assert.equal((await storage.get(`film:${film.id}:clips`))[1].lip_key, `film/${film.id}/lips/1.mp4`);
  assert.equal((await loadRates(storage)).measured.kaggle_lipsync_s, true, 'lip sync time is measured');
  // Shot 2's clip arrives; its lip sync starts from that clip, and fails: that shot goes on with its clip.
  assert.equal((await call(`/api/film/farm/${film.id}/result?shot=2&seconds=200`, { token, method: 'PUT', body: mp4({ seconds: 5, codecs: 'avc1' }) })).status, 200);
  const lip2 = await next();
  assert.deepEqual([lip2.kind, lip2.shot], ['lipsync', 2]);
  assert.match(lip2.video_url, /clips%2F2\.mp4$/);
  assert.equal((await call(`/api/film/farm/${film.id}/lipfail`, { token, method: 'POST', body: JSON.stringify({ shot: 2, error: 'Face not detected' }) })).status, 200);
  assert.deepEqual(await next(), { done: true });
  // The edit uses the lip-synced clip in place of the still.
  const shots = await store.shots(film.id, 3);
  shots[0].lip_key = `film/${film.id}/lips/1.mp4`;
  shots.forEach((s) => { s.status = 'verified'; });
  const plan = assemblyPlan(film, shots);
  const spec = segmentSpec(film, plan.segments[0], plan.timed);
  assert.deepEqual([spec.shots[0].clip, spec.shots[0].image], [`film/${film.id}/lips/1.mp4`, '']);
  assert.match(speakStatus(film, shots, NOW), /1 talking shot is lip-synced\./);
});

test('lip sync results reach the film: a clip that lands during a pass is used, and a failure is said in the notes and the status (Codex on #950)', async () => {
  const storage = memory(); const bucket = r2();
  const store = new FilmStore(storage);
  const { record } = await newFarmToken(NOW);
  const film = { id: 'film_00000000000000cc', state: 'making', shot_count: 2, outline: validOutline(OUTLINE, { shots: 2 }), plan: { lip_sync: 2, segments: 1, parts: {} }, farm: { ...record, provider: 'kaggle', session: {} }, stats: { stills_made: 0, stills_failed: 0, lines_voiced: 0, clips_made: 0, retries: 0 }, notes: [], errors: [] };
  await store.save(film, { force: true });
  const line = (k) => ({ character: 'mara', line: 'Hello.', audio_key: `film/${film.id}/voice/${k}.mp3`, audio_s: 1 });
  await store.putShots(film.id, [
    { n: 1, tier: 'B', still_of: 1, still_key: `film/${film.id}/stills/1.jpg`, status: 'planned', attempts: 0, dialogue: [line('1-0')], description: 'Mara talks', characters: ['mara'], setting: 'stairs' },
    { n: 2, tier: 'B', still_of: 2, still_key: `film/${film.id}/stills/2.jpg`, status: 'planned', attempts: 0, dialogue: [line('2-0')], description: 'Mara again', characters: ['mara'], setting: 'lamp' },
  ]);
  const ledgerKey = `film:${film.id}:clips`;
  await storage.put(ledgerKey, { 2: { lip_error: 'Face not detected' } });
  // Shot 1's lip-synced clip lands between this pass's first and second read of the farm ledger.
  let reads = 0; const get = storage.get;
  storage.get = async (k) => { if (k === ledgerKey && ++reads === 2) await storage.put(ledgerKey, { ...(await get(k)), 1: { lip_key: `film/${film.id}/lips/1.mp4`, lip_s: 2 } }); return get(k); };
  const ctx = { storage, env: { CHE_DATA_BUCKET: bucket, CHE_GITHUB_TOKEN: 'gh', CHE_GITHUB_REPO: 'Vondada/chey-app' }, keys: {}, base: 'https://che.example', fetcher: offline, now: NOW };
  await filmTick(ctx);
  storage.get = get;
  const after = await store.film(film.id);
  const shots = await store.shots(film.id, 2);
  assert.equal(shots[0].lip_key, `film/${film.id}/lips/1.mp4`, 'the clip that arrived mid-pass is on the shot before the farm closes');
  assert.equal(after.farm.closed, 'all clips arrived');
  const plan = assemblyPlan(after, shots);
  assert.equal(segmentSpec(after, plan.segments[0], plan.timed).shots[0].clip, `film/${film.id}/lips/1.mp4`);
  assert.equal(after.notes.filter((n) => n === 'Shot 2 has no lip sync: Face not detected.').length, 1, after.notes.join(' | '));
  assert.match(speakStatus({ ...after, state: 'making' }, shots, NOW), /1 talking shot is lip-synced\. 1 talking shot could not be lip-synced \(Face not detected\)\./);
  await filmTick({ ...ctx });
  assert.equal((await store.film(film.id)).notes.filter((n) => /Shot 2 has no lip sync/.test(n)).length, 1, 'said once');
});

test('two GPUs: the clip loop gets only clips and the lip-sync loop only talking shots; the worker reports its real start-up, install time and GPU count', async () => {
  const storage = memory(); const bucket = r2();
  const store = new FilmStore(storage);
  const { token, record } = await newFarmToken(NOW);
  const film = { id: 'film_00000000000000dd', state: 'making', shot_count: 2, outline: validOutline(OUTLINE, { shots: 2 }), plan: { lip_sync: 1, segments: 1, parts: {} }, farm: { ...record, provider: 'kaggle', started_ms: NOW - 240_000 }, stats: { clips_made: 0 } };
  await store.save(film, { force: true });
  await store.putShots(film.id, [
    { n: 1, tier: 'A', still_of: 1, still_key: `film/${film.id}/stills/1.jpg`, status: 'planned', dialogue: [], description: 'The sea', characters: [], setting: 'sea' },
    { n: 2, tier: 'B', still_of: 2, still_key: `film/${film.id}/stills/2.jpg`, status: 'planned', dialogue: [{ character: 'mara', line: 'Hi.', audio_key: `film/${film.id}/voice/2-0.mp3`, audio_s: 1 }], description: 'Mara talks', characters: ['mara'], setting: 'stairs' },
  ]);
  const ctx = { storage, env: { CHE_DATA_BUCKET: bucket }, base: 'https://che.example', now: NOW };
  const next = async (q) => (await filmTokenRoute(ctx, `/api/film/farm/${film.id}/next`, req(`/api/film/farm/${film.id}/next?${q}`, { header: 'X-CHE-Farm-Token', token }))).json();
  assert.deepEqual(await next('kind=hello&gpus=2&boot=35'), { ok: true });
  const { rates, measured } = await loadRates(storage);
  assert.deepEqual([rates.kaggle_startup_s, rates.kaggle_gpus, measured.kaggle_startup_s], [240, 2, true], 'start-up is measured from the session start to the worker\'s hello');
  await next('kind=hello&gpus=2');
  assert.equal((await loadRates(storage)).rates.kaggle_startup_s, 240, 'a second hello is not counted again');
  const lip = await next('kind=lipsync&gpus=2');
  assert.deepEqual([lip.kind, lip.shot], ['lipsync', 2], 'the lip-sync loop never gets the clip');
  const clip = await next('kind=clip&gpus=2');
  assert.equal(clip.shot, 1);
  assert.equal(clip.kind, undefined);
  assert.deepEqual(await next('kind=clip&gpus=2'), { wait: 30 }, 'the clip loop waits for its claimed clip, not for lip sync');
  assert.deepEqual(await next('kind=lipsync&gpus=2'), { wait: 30 });
  const put = (q, body) => filmTokenRoute(ctx, `/api/film/farm/${film.id}/result`, req(`/api/film/farm/${film.id}/result?${q}`, { header: 'X-CHE-Farm-Token', token, method: 'PUT', body }));
  assert.equal((await put('shot=2&kind=lipsync&seconds=80&setup=410', mp4({ seconds: 6, codecs: 'avc1' }))).status, 200);
  assert.equal((await loadRates(storage)).rates.lipsync_setup_s, 410, 'the real install time is measured');
  assert.deepEqual(await next('kind=lipsync&gpus=2'), { done: true }, 'the lip-sync loop stops when its work is done, while the clip is still coming');
});

test('two GPUs uploading at the same moment both keep their results (Codex on #951)', async () => {
  const storage = memory(); const bucket = r2();
  const store = new FilmStore(storage);
  const { token, record } = await newFarmToken(NOW);
  const film = { id: 'film_00000000000000ee', state: 'making', shot_count: 2, outline: validOutline(OUTLINE, { shots: 2 }), plan: { lip_sync: 1, segments: 1, parts: {} }, farm: { ...record, provider: 'kaggle' }, stats: { clips_made: 0 } };
  await store.save(film, { force: true });
  await store.putShots(film.id, [
    { n: 1, tier: 'A', still_of: 1, still_key: `film/${film.id}/stills/1.jpg`, status: 'planned', dialogue: [], description: 'The sea', characters: [], setting: 'sea' },
    { n: 2, tier: 'B', still_of: 2, still_key: `film/${film.id}/stills/2.jpg`, status: 'planned', dialogue: [{ character: 'mara', line: 'Hi.', audio_key: `film/${film.id}/voice/2-0.mp3`, audio_s: 1 }], description: 'Mara talks', characters: ['mara'], setting: 'stairs' },
  ]);
  // Uploads take real time: the first one's file is still being stored while the second request starts.
  const slow = { ...bucket, put: async (k, v, o) => { await new Promise((r) => setTimeout(r, k.includes('/clips/') ? 30 : 5)); return bucket.put(k, v, o); } };
  const ctx = { storage, env: { CHE_DATA_BUCKET: slow }, base: 'https://che.example', now: NOW };
  const put = (q, body) => filmTokenRoute(ctx, `/api/film/farm/${film.id}/result`, req(`/api/film/farm/${film.id}/result?${q}`, { header: 'X-CHE-Farm-Token', token, method: 'PUT', body }));
  const [a, b] = await Promise.all([put('shot=1&seconds=200', mp4({ seconds: 5, codecs: 'avc1' })), put('shot=2&kind=lipsync&seconds=80', mp4({ seconds: 6, codecs: 'avc1' }))]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const ledger = await storage.get(`film:${film.id}:clips`);
  assert.equal(ledger[1]?.key, `film/${film.id}/clips/1.mp4`, 'the clip is kept');
  assert.equal(ledger[2]?.lip_key, `film/${film.id}/lips/2.mp4`, 'and the lip-synced clip');
});

test('the Kaggle worker is valid Python that waits for work, frees the GPU for lip sync, and pins LatentSync 1.5', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const file = new URL('./.kaggle_worker.test.py', import.meta.url);
  writeFileSync(file, kaggleWorkerScript({ base: 'https://che.example', filmId: 'film_0123456789abcdef', token: 't', deadlineS: 3600 }));
  // Two GPUs, and the clip loop crashes: main() raises (so the handler reports it to CHE), and the lip-sync loop stops.
  const harness = `
import runpy, threading
w = runpy.run_path(${JSON.stringify(file.pathname)}, run_name="worker")["main"].__globals__
calls = []
def che(method, path, body=None, raw=None, timeout=120):
    calls.append(path)
    return {"wait": 1} if "kind=lipsync" in path else {"ok": True}
w["che"] = che
w["gpu_count"] = lambda: 2
w["LIPSYNC"] = True
w["PREPARING"] = threading.Thread(target=lambda: None)
def crash(kind, gpu):
    if kind == "clip":
        raise RuntimeError("CUDA out of memory")
    while not w["STOP"].is_set():
        w["che"]("GET", "/next?kind=lipsync")
        w["STOP"].wait(0.05)
w["work"] = crash
try:
    w["main"]()
    print("NO-RAISE")
except RuntimeError as e:
    print("RAISED", e, "STOPPED", w["STOP"].is_set(), "DONE-SENT", any(p == "/done" for p in calls))
`;
  try {
    execFileSync('python3', ['-m', 'py_compile', file.pathname]);
    const out = execFileSync('python3', ['-c', harness], { encoding: 'utf8', timeout: 20000 });
    assert.match(out, /RAISED CUDA out of memory STOPPED True DONE-SENT False/, out);
  } finally { unlinkSync(file); }
  assert.match(KAGGLE_WORKER_PY, /if job\.get\("wait"\):/);
  assert.match(KAGGLE_WORKER_PY, /LATENTSYNC_COMMIT = "a229c3948406bc2cf6eaf4873e662e70c6a04746"/);
  assert.match(KAGGLE_WORKER_PY, /LATENTSYNC_WEIGHTS = "ByteDance\/LatentSync-1\.5"/);
  assert.match(KAGGLE_WORKER_PY, /configs\/unet\/stage2\.yaml/, 'the 256-pixel 1.5 config, not 1.6\'s 512 (18 GB)');
  assert.match(KAGGLE_WORKER_PY, /torch\.cuda\.empty_cache\(\)/);
  assert.match(KAGGLE_WORKER_PY, /\/lipfail/);
  assert.match(KAGGLE_WORKER_PY, /"--enable_deepcache"/, 'DeepCache, as in the inference.sh LatentSync ships');
  assert.match(KAGGLE_WORKER_PY, /"uv", "pip", "install"/, 'the install uses uv, with pip as the fallback');
  assert.match(KAGGLE_WORKER_PY, /threading\.Thread\(target=guarded, args=\("clip", 0\)\), threading\.Thread\(target=guarded, args=\("lipsync", 1\)\)/, 'one loop per GPU on a T4 x2');
  assert.match(KAGGLE_WORKER_PY, /CUDA_VISIBLE_DEVICES/);
  assert.match(kaggleWorkerScript({ base: 'b', filmId: 'f', token: 't', deadlineS: 10, lipsync: true }), /LIPSYNC = "1" == "1"/);
  assert.match(kaggleWorkerScript({ base: 'b', filmId: 'f', token: 't', deadlineS: 10 }), /LIPSYNC = "0" == "1"/);
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

test('a story in the office is played by the real crew with their fixed looks, even when the owner says "video"', async () => {
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const generated = new URL('./.film_office.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  let mod;
  try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
  const st = memory(); const pending = [];
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: fakeAI(), CHE_DATA_BUCKET: r2(), CHE_GITHUB_TOKEN: 'gh', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const before = globalThis.fetch; globalThis.fetch = github({});
  try {
    const state = new mod.CheState({ storage: st, waitUntil: (p) => pending.push(p) }, env);
    env.CHE_STATE = { getByName: () => state };
    const send = (path, body, token = '') => mod.default.fetch(new Request(`https://che.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
    const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
    assert.equal((await send('/api/agents', { name: 'Knox', role: 'Office Security Chief' }, token)).status < 300, true);
    // The owner gives Knox a look in their own words; the Workshop keeps it.
    assert.equal((await send('/api/office/workshop/avatar', { agent_id: 'knox', description: 'man in his 30s' }, token)).status, 200);
    // The owner's words, 2026-11-06.
    const raw = await (await send('/api/chat', { message: 'Okay, and I want her to create a video too. I want her to create like a short story of something that happens in the office using realistic characters for each of the office members.', history: [] }, token)).text();
    const done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || {};
    assert.equal(done.source, 'che_film_studio', replyFromNdjson(raw));
    const store = new FilmStore(st);
    let film = await store.latest();
    assert.equal(film.target_s, 60, 'a short story is a one-minute film');
    assert.equal(film.roster[0].id, 'che');
    assert.ok(film.roster.some((r) => r.id === 'knox' && /^man in his 30s, /.test(r.look)), JSON.stringify(film.roster.map((r) => r.id)));
    for (let i = 0; i < 6 && !film.outline; i += 1) { await state.filmPass(); film = await store.latest(); }
    assert.equal(film.outline.title, 'The Coffee Machine');
    assert.deepEqual(film.outline.characters.map((c) => c.id), ['che', 'knox'], 'only cast members, never a stranger');
    const knox = film.outline.characters.find((c) => c.id === 'knox');
    assert.equal(knox.look, film.roster.find((r) => r.id === 'knox').look, 'the look is the Office\'s, never the writer\'s');
    assert.doesNotMatch(knox.look, /pirate/);
    // With #948: a one-minute story gets same-face pictures, so each cast member gets one portrait from their look.
    assert.equal(film.plan.faces, true);
    for (let i = 0; i < 6 && !(film.cast?.che?.key && film.cast?.knox?.key); i += 1) { await state.filmPass(); film = await store.latest(); }
    assert.deepEqual(Object.keys(film.cast).sort(), ['che', 'knox']);
    assert.ok(film.cast.knox.key && film.cast.che.key, JSON.stringify(film.cast));
  } finally { globalThis.fetch = before; }
});

test('the office story words: what starts one and what does not', () => {
  const office = filmIntent('Make a short story about the office coffee machine breaking');
  assert.deepEqual([office.kind, office.office, office.seconds], ['make', true, 60]);
  assert.equal(office.deadline.seconds, 7200, 'a crew story may take two hours, so its talking shots can be lip-synced');
  assert.equal(filmIntent('Make a short story about the office coffee machine as fast as possible').deadline.seconds, 0, 'unless the owner wants it fast');
  const plan = planFilm({ targetSeconds: office.seconds, deadlineSeconds: office.deadline.seconds, providers: providers(kaggleOn), talkingShots: 5, now: NOW });
  assert.equal(plan.lip_sync, 5, 'with the free Kaggle GPU connected, every talking shot of a crew story gets lip sync');
  assert.equal(filmIntent('Che, make a 3-minute movie about my crew planning a launch').seconds, 180);
  assert.equal(filmIntent('Make a movie about a pirate crew').office, undefined, 'a pirate crew is not the office');
  assert.equal(filmIntent('Make a film about an office romance in 1950s New York').office, undefined);
  assert.equal(filmIntent('Make a video about black holes'), null, 'ordinary videos stay with the video renderer');
  assert.equal(filmIntent('How is the office story going?'), null);
  // Codex on #949: a question only plans, and the plot after "starring" is kept.
  const ask = filmIntent('How long would it take to make a 3-minute movie about my crew?');
  assert.deepEqual([ask.kind, ask.seconds], ['plan', 180]);
  const heist = filmIntent('Make a movie starring my crew solving a bank robbery');
  assert.deepEqual([heist.kind, heist.office, heist.topic], ['make', true, 'my crew solving a bank robbery']);
});

test('a fixed cast: the writer picks who appears, never their names or looks; a cast nobody uses is refused', () => {
  const roster = [{ id: 'che', name: 'CHE', role: 'Office Boss', look: 'standard build' }, { id: 'nova', name: 'Nova', role: 'Product', look: 'tall build' }];
  const out = validOutline({ title: 'T', characters: [{ id: 'Nova', name: 'Bob', look: 'a wizard' }, 'che', { id: 'ghost' }], scenes: [{ setting: 'Office', summary: 'x', shots: 2 }] }, { shots: 4, roster });
  assert.deepEqual(out.characters.map((c) => [c.id, c.name, c.look]), [['che', 'CHE', 'standard build'], ['nova', 'Nova', 'tall build']]);
  assert.equal(validOutline({ title: 'T', characters: [{ id: 'ghost' }], scenes: [{ setting: 'Office', summary: 'x', shots: 2 }] }, { shots: 4, roster }).error, 'the outline used none of the cast');
  assert.match(outlineMessages({ topic: 'x', targetSeconds: 60, shots: 10, roster })[1].content, /fixed cast of office members.*che \(CHE, Office Boss\); nova \(Nova, Product\)/);
});

// ─── A writer reply that is not valid JSON (live, 2026-11-06: "scene 2 could not be written after two tries") ──────

test('shots are read from a writer reply cut off at its token limit or broken by a quote in one line; broken shots are dropped, never guessed', () => {
  const good = (n) => `{"description":"shot ${n} at the desk","camera":"static","characters":["nova"],"dialogue":[{"character":"nova","line":"Line ${n}"}],"sound":"hum"}`;
  const cut = `{"shots":[${good(1)},${good(2)},{"description":"shot 3 is cut off mid`;
  assert.equal(_internals.firstJson(cut), null, 'the whole reply does not parse');
  assert.deepEqual(_internals.writerJson(cut).shots.map((s) => s.description), ['shot 1 at the desk', 'shot 2 at the desk']);
  const quoted = `Sure!\n{"shots":[${good(1)},{"description":"she says "hi" loudly","camera":"static"},${good(3)},]}`;
  assert.deepEqual(_internals.writerJson(quoted).shots.map((s) => s.description), ['shot 1 at the desk', 'shot 3 at the desk']);
  assert.equal(_internals.writerJson('I cannot help with that.'), null);
  assert.deepEqual(_internals.writerJson({ shots: [{ description: 'already parsed' }] }).shots[0].description, 'already parsed', 'Workers AI can return parsed JSON');
});

test('a scene the writer never gets right does not stop the film: fewer shots are asked for, then the outline describes the scene, and the notes say so', async () => {
  const { ctx } = await studio({ seconds: 60 });
  const base = ctx.writer; const asked = [];
  ctx.writer = async (messages) => {
    const last = messages.at(-1).content;
    if (/Scene 2 of/.test(last)) { asked.push(Number(/Write exactly (\d+) shots/.exec(last)[1])); return '{"shots":[{"description":"cut'; }
    return base(messages);
  };
  const film = await runUntil(ctx, ['making', 'assembling', 'failed']);
  assert.notEqual(film.state, 'failed', film.error || '');
  assert.equal(asked.length, 3);
  assert.ok(asked[2] < asked[0], `the third try asks for fewer shots (${asked.join(', ')})`);
  assert.ok(film.notes.some((n) => /^Scene 2 was not written as a shot list \(scene 2 came back with no usable shots \(reply of \d+ characters\)\)/.test(n)), film.notes.join(' | '));
  const scene2 = await ctx.storage.get(`film:${film.id}:scene:2`);
  assert.equal(scene2.length, film.outline.scenes[1].shots);
  assert.ok(scene2.every((s) => s.description.includes(film.outline.scenes[1].summary) && s.dialogue.length === 0));
});

test('a writer reply cut off after some shots keeps those shots, fills the rest from the outline and keeps the film\'s length', async () => {
  const { ctx } = await studio({ seconds: 60 });
  const base = ctx.writer;
  ctx.writer = async (messages) => {
    const out = await base(messages);
    return /Scene 1 of/.test(messages.at(-1).content) ? out.slice(0, out.lastIndexOf('{"description"') - 1) : out;
  };
  const film = await runUntil(ctx, ['making', 'assembling', 'failed']);
  assert.notEqual(film.state, 'failed');
  const planned = film.outline.scenes[0].shots;
  const scene1 = await ctx.storage.get(`film:${film.id}:scene:1`);
  assert.equal(scene1.length, planned, 'every planned shot is there');
  const fromOutline = scene1.filter((s) => s.description.includes(film.outline.scenes[0].summary));
  assert.equal(fromOutline.length, 1, 'only the cut-off shot comes from the outline');
  assert.ok(film.notes.some((n) => n === `Scene 1: the writer gave ${planned - 1} of ${planned} shots, so the other 1 show the outline's description without dialogue.`), film.notes.join(' | '));
});

test('when only the shorter third ask works, the film still has every planned shot (Codex, #953)', async () => {
  const { ctx } = await studio({ seconds: 60 });
  const base = ctx.writer; const planned = {};
  ctx.writer = async (messages) => {
    const last = messages.at(-1).content;
    const m = /Scene (\d+) of/.exec(last);
    if (m) { const n = Number(/Write exactly (\d+) shots/.exec(last)[1]); planned[m[1]] = Math.max(planned[m[1]] || 0, n); if (n === planned[m[1]]) return 'not json'; }
    return base(messages);
  };
  const film = await runUntil(ctx, ['making', 'assembling', 'failed']);
  assert.notEqual(film.state, 'failed');
  const want = film.outline.scenes.reduce((n, s) => n + s.shots, 0);
  let got = 0;
  for (const s of film.outline.scenes) got += (await ctx.storage.get(`film:${film.id}:scene:${s.id}`)).length;
  assert.equal(got, want);
  assert.equal(film.notes.filter((n) => /the writer gave \d+ of \d+ shots/.test(n)).length, film.outline.scenes.length);
});

// ─── Moving and talking, not pictures (owner, 2026-11-07, on "Brewed Anarchy") ───────────────────────────────────

test('with the free GPU connected and no deadline given, every shot of a one-minute film moves and the talking shots are lip-synced', () => {
  const plan = planFilm({ targetSeconds: 60, providers: providers(kaggleOn), now: NOW });
  assert.equal(plan.tier_a, plan.shots, `${plan.tier_a} of ${plan.shots} shots move`);
  assert.ok(plan.lip_sync > 0, 'talking shots get lip sync');
  assert.ok(plan.meets_deadline);
  const said = speakPlan(plan);
  assert.match(said, /^A 60-second film takes about [^:]*: every shot a moving clip \(10\)/);
  assert.doesNotMatch(said, /inside your/, 'no deadline was given, so none is quoted back');
  // "As fast as possible" is still the owner's choice of stills.
  assert.equal(planFilm({ targetSeconds: 60, deadlineSeconds: 0, providers: providers(kaggleOn), now: NOW }).tier_a, 0);
});

test('when every shot moves, the shots without dialogue move too (talking shots are picked first only when some must stay still)', () => {
  const outline = validOutline(OUTLINE, { shots: 6 });
  const sceneShots = { 1: SHOTS(3).shots.map((s) => validSceneShots({ shots: [s] }, { id: 1, shots: 1 }, outline.characters).shots[0]), 2: SHOTS(3).shots.map((s) => validSceneShots({ shots: [s] }, { id: 2, shots: 1 }, outline.characters).shots[0]) };
  const all = shotList(outline, sceneShots, { tier_a: 6, reuse: 1, segments: 1 });
  assert.deepEqual(all.map((s) => s.tier), ['A', 'A', 'A', 'A', 'A', 'A']);
  const some = shotList(outline, sceneShots, { tier_a: 2, reuse: 1, segments: 1 });
  assert.ok(some.filter((s) => s.tier === 'A').every((s) => s.dialogue.length > 0), 'with two clips, talking shots move first');
});

test('the finished film says how many shots really move and are lip-synced, and why when the GPU did not deliver', () => {
  const film = { id: 'f1', state: 'done', title: 'Brewed Anarchy', started_ms: NOW, result: { seconds: 60, at: new Date(NOW + 11 * 60_000).toISOString() }, notes: ['Kaggle: the GPU session could not start (quota).', 'Lip sync needs the Kaggle GPU, which could not start, so talking shots use their pictures as they are.', 'This uses starting numbers.'] };
  const shots = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, clip_key: i < 2 ? `c${i}` : '', dialogue: [] }));
  const said = speakStatus(film, shots, NOW + 12 * 60_000);
  assert.match(said, /2 of 10 shots move; the rest are stills with camera motion\./);
  assert.match(said, /Kaggle: the GPU session could not start \(quota\)\. Lip sync needs the Kaggle GPU/);
  assert.doesNotMatch(said, /starting numbers/, 'only the notes that explain motion and lip sync');
  assert.match(speakStatus(film, shots.map((s) => ({ ...s, clip_key: 'c' })), NOW), /Every shot moves\./);
});
