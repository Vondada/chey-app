// Film Studio pipeline: the work CHE's alarm advances, one bounded pass at a time, and the token routes the GitHub
// runners and farm GPUs call. State lives in Durable Object storage (film_studio.FilmStore) and files in R2 under
// film/<id>/, so a film survives restarts and can be paused and resumed without losing anything.

import {
  FilmStore, FILM_VALIDATION_KEY, NEURONS, STILL_MODEL, TTS_MODEL,
  assemblyPlan, checkStill, farmProviders, learnFromCheck, loadRates, loadUsage, mp3Seconds, newFilm, outlineMessages, planFilm,
  recordRate, reserve, sceneMessages, seedFor, segmentSpec, shotList, spend, speakPlan, stillPrompt, validOutline, validSceneShots,
  _internals,
} from './film_studio.js';
import { recordVideoFailed, recordVideoVerified } from './action_receipts.js';
import { farmTokenOpens, hfClip, kaggleSessionStatus, newFarmToken, startKaggleSession, validateKaggle, ensureHfSpace, HF_SPACE_FILES } from './film_farm.js';
import { assemblyTokenOpens, filmRenderStatus, newAssemblyJob, startFilmRender, validateGithub, verifyFilmObject } from './film_render.js';
import { mp4Facts } from './github_video_renderer.js';
import { assembleUpload, mediaStore, partKey, sha256Hex } from './che_media_store.js';
import { saveFilmVideo } from './media.js';
import { redact } from './security_intelligence.js';

// Notes and errors are said to the owner and stored; any secret a provider echoes back is masked first.
const KAGGLE_SECRET = /\bKGAT_[A-Za-z0-9_-]{6,}|\b[a-f0-9]{32}\b/g; // Kaggle API tokens and legacy keys
const safe = (text) => { try { return String(redact(String(text || '').replace(KAGGLE_SECRET, '[redacted:kaggle_token]')).text).slice(0, 300); } catch (_) { return '[hidden]'; } };

const { MAX_ATTEMPTS } = _internals;
const ACTIVE = new Set(['scripting', 'making', 'assembling', 'verifying']);
const STILL_BATCH = 4;
const VOICE_BATCH = 8;
const SCENE_BATCH = 4;

const b64ToBytes = (b64) => { const s = atob(String(b64 || '')); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i); return out; };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** Checks the providers that need a network call; results are cached ten minutes. */
export async function refreshValidation(ctx, { force = false } = {}) {
  const { storage, env, now = Date.now(), fetcher = fetch, keys = {} } = ctx;
  const v = (await storage.get(FILM_VALIDATION_KEY)) || {};
  const stale = (x) => force || !x || now - Number(x.checked_ms || 0) > 600_000;
  if (stale(v.github_actions)) v.github_actions = { ...(await validateGithub(env, fetcher)), checked_ms: now };
  const kaggle = keys.KAGGLE_API_TOKEN || env.KAGGLE_API_TOKEN;
  if (kaggle && !ctx.internalOnly && stale(v.kaggle)) v.kaggle = { ...(await validateKaggle(kaggle, fetcher)), checked_ms: now };
  await storage.put(FILM_VALIDATION_KEY, v);
  return v;
}

export async function filmPlan(ctx, { seconds, deadline }) {
  const providers = await farmProviders(ctx.env, ctx.storage, ctx);
  const { rates, measured } = await loadRates(ctx.storage);
  return { plan: planFilm({ targetSeconds: seconds, deadlineSeconds: deadline?.seconds ?? null, providers, rates, measured, now: ctx.now || Date.now() }), providers };
}

/** "Make me a movie": plans with the real numbers, says the ETA and the mix, and starts (it costs nothing). */
export async function startFilm(ctx, ask) {
  const store = new FilmStore(ctx.storage);
  const busy = (await store.index()).find((f) => ACTIVE.has(f.state));
  if (busy) return { ok: false, said: `I'm already making "${busy.title || 'a film'}". Say "how's my movie going" for its progress, or "cancel my movie" first.` };
  if (!ask.topic) return { ok: false, said: 'What should the film be about? Say, for example, "make me a 10-minute movie about a lighthouse keeper".' };
  await refreshValidation(ctx);
  const { plan } = await filmPlan(ctx, ask);
  const said = speakPlan(plan, { asked: ask.deadline?.words });
  if (!plan.ok) return { ok: false, said };
  const film = await store.save(newFilm({ topic: ask.topic, targetSeconds: ask.seconds, deadline: ask.deadline, plan, now: ctx.now || Date.now() }));
  return { ok: true, film, said: `${said} Starting now.` };
}

// ─── One pass of work ────────────────────────────────────────────────────────

/** Advances the active film by one bounded step. Returns when CHE should look again (ms), or null when idle. */
export async function filmTick(ctx) {
  const store = new FilmStore(ctx.storage);
  const active = (await store.index()).find((f) => ACTIVE.has(f.state));
  if (!active) return null;
  const film = await store.film(active.id);
  if (!film) return null;
  try {
    if (film.state === 'scripting') return await writeStep(ctx, store, film);
    if (film.state === 'making') return await makeStep(ctx, store, film);
    if (film.state === 'assembling') return await assembleStep(ctx, store, film);
    return 30_000;
  } catch (error) {
    film.errors = [...(film.errors || []), safe(error?.message || error)].slice(-10);
    await store.save(film);
    return 60_000;
  }
}

async function writeStep(ctx, store, film) {
  const now = ctx.now || Date.now();
  if (!film.outline) {
    const raw = await ctx.writer(outlineMessages({ topic: film.topic, targetSeconds: film.target_s, shots: film.plan.shots }));
    const outline = validOutline(_internals.firstJson(raw), { shots: film.plan.shots });
    if (outline.error) {
      film.write_attempts = (film.write_attempts || 0) + 1;
      if (film.write_attempts >= MAX_ATTEMPTS) return fail(store, film, `I couldn't write a usable screenplay (${outline.error}).`);
      await store.save(film);
      return 2_000;
    }
    film.outline = outline; film.title = outline.title; film.scene_next = 0;
    await store.save(film);
    return 500;
  }
  const scenes = film.outline.scenes;
  const todo = scenes.slice(film.scene_next, film.scene_next + SCENE_BATCH);
  const started = Date.now();
  const written = await Promise.all(todo.map(async (scene) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const out = validSceneShots(_internals.firstJson(await ctx.writer(sceneMessages(film.outline, scene))), scene, film.outline.characters);
      if (!out.error) return out.shots;
    }
    return null;
  }));
  for (let i = 0; i < todo.length; i += 1) {
    if (!written[i]) return fail(store, film, `scene ${todo[i].id} could not be written after two tries`);
    await ctx.storage.put(`film:${film.id}:scene:${todo[i].id}`, written[i]);
  }
  await recordRate(ctx.storage, 'script_s_per_shot', ((Date.now() - started) / 1000) / Math.max(1, todo.reduce((n, s) => n + s.shots, 0)), now);
  film.scene_next += todo.length;
  if (film.scene_next < scenes.length) { await store.save(film); return 300; }
  const sceneShots = {};
  for (const scene of scenes) sceneShots[scene.id] = (await ctx.storage.get(`film:${film.id}:scene:${scene.id}`)) || [];
  // Re-plan with the real screenplay: its spoken lines and how many distinct pictures it really needs.
  const draft = shotList(film.outline, sceneShots, film.plan);
  const speech = draft.reduce((t, s) => t + s.dialogue.reduce((u, d) => u + d.line.length / 14, 0), 0);
  const replanned = planFilm({ targetSeconds: film.target_s, deadlineSeconds: film.deadline_s, providers: await farmProviders(ctx.env, ctx.storage, ctx), ...(await loadRates(ctx.storage)), dialogueSeconds: speech, uniqueWanted: draft.length, now });
  if (replanned.ok) film.plan = replanned;
  const shots = shotList(film.outline, sceneShots, film.plan);
  await store.putShots(film.id, shots);
  film.shot_count = shots.length;
  film.state = 'making';
  film.eta_at = new Date(film.started_ms + film.plan.eta_s * 1000).toISOString();
  await store.save(film);
  return 200;
}

/** Shot fields the token routes write (clips arrive from the farm while a pass runs), kept apart so nothing is lost. */
async function farmLedger(storage, film) { return (await storage.get(`film:${film.id}:clips`)) || {}; }

async function makeStep(ctx, store, film) {
  const { env, storage } = ctx;
  const now = ctx.now || Date.now();
  const media = mediaStore(env, storage);
  const shots = await store.shots(film.id, film.shot_count);
  const byN = new Map(shots.map((s) => [s.n, s]));
  // Owner remakes queued since the last pass, and clips the farm delivered.
  const remakes = (await storage.get(`film:${film.id}:remakes`)) || [];
  if (remakes.length) { for (const n of remakes) applyRemake(shots, n); await storage.put(`film:${film.id}:remakes`, []); }
  const clips = await farmLedger(storage, film);
  for (const s of shots) if (clips[s.n]?.key) s.clip_key = clips[s.n].key;
  const lessons = (await storage.get('film:lessons')) || [];
  film.waiting = '';

  // Moving clips go to the farm first so the GPUs work while the stills are made.
  if (shots.some((s) => s.tier === 'A' && !s.clip_key && s.status !== 'failed') && !film.farm) await dispatchFarm(ctx, film, shots);

  // Pictures: up to four at once. The allowance for all of them is reserved first, in one step, so the cap holds.
  const wantStill = shots.filter((s) => s.still_of === s.n && !s.still_key && s.status !== 'failed').slice(0, STILL_BATCH);
  const stillsPaid = wantStill.length ? await reserve(storage, 'neurons', NEURONS.still, wantStill.length, { now }) : 0;
  if (wantStill.length && !stillsPaid) film.waiting = 'Waiting for tomorrow\'s free picture allowance (it resets at midnight UTC).';
  if (stillsPaid) {
    const started = Date.now(); let made = 0; let storeError = null;
    await Promise.all(wantStill.slice(0, stillsPaid).map(async (shot) => {
      let bytes = null; let check;
      try {
        const out = await env.AI.run(STILL_MODEL, { prompt: stillPrompt(shot, film.outline, lessons), steps: 4, seed: seedFor(shot, film.outline) });
        bytes = out?.image ? b64ToBytes(out.image) : null;
        check = bytes ? checkStill(bytes) : { ok: false, reason: 'the image model returned no picture' };
      } catch (error) { check = { ok: false, reason: String(error?.message || error).slice(0, 120) }; }
      if (check.ok) {
        const key = `film/${film.id}/stills/${shot.n}.jpg`;
        const saved = await media.put(key, bytes, { contentType: 'image/jpeg' });
        if (!saved.ok) { storeError = saved.error; return; }
        Object.assign(shot, { still_key: key, check });
        film.stats.stills_made += 1; made += 1;
      } else {
        shot.attempts += 1; film.stats.retries += 1; shot.check = check;
        await learnFromCheck(storage, check);
        if (shot.attempts >= MAX_ATTEMPTS) { shot.status = 'failed'; film.stats.stills_failed += 1; }
      }
    }));
    if (storeError) return fail(store, film, storeError);
    if (made) {
      await recordRate(storage, 'images_per_s', made / Math.max(0.5, (Date.now() - started) / 1000), now);
      await storage.put(FILM_VALIDATION_KEY, { ...((await storage.get(FILM_VALIDATION_KEY)) || {}), workers_ai: { ok: true, checked_ms: now } });
    }
  }

  // Voices: up to eight lines at once, reserved the same way (about 14 characters a second of speech).
  const lines = [];
  for (const s of shots) s.dialogue.forEach((d, i) => { if (!d.audio_key && s.status !== 'failed') lines.push({ s, d, i }); });
  const batch = lines.slice(0, VOICE_BATCH);
  const lineCost = batch.length ? Math.max(0.5, Math.max(...batch.map((l) => (l.d.line.length / 14 / 60) * NEURONS.tts_per_minute))) : 0;
  const voicesPaid = batch.length && !film.waiting ? await reserve(storage, 'neurons', lineCost, batch.length, { now }) : 0;
  if (batch.length && !voicesPaid && !film.waiting) film.waiting = 'Waiting for tomorrow\'s free voice allowance (it resets at midnight UTC).';
  if (voicesPaid) {
    const started = Date.now(); let audio = 0;
    await Promise.all(batch.slice(0, voicesPaid).map(async ({ s, d, i }) => {
      try {
        const out = await env.AI.run(TTS_MODEL, { prompt: d.line, lang: 'en' });
        const bytes = out instanceof Uint8Array ? out : out?.audio ? b64ToBytes(out.audio) : null;
        const seconds = bytes ? mp3Seconds(bytes) : 0;
        if (!seconds) throw new Error('the voice model returned no speech');
        const key = `film/${film.id}/voice/${s.n}-${i}.mp3`;
        const saved = await media.put(key, bytes, { contentType: 'audio/mpeg' });
        if (!saved.ok) throw new Error(saved.error);
        Object.assign(s.dialogue[i], { audio_key: key, audio_s: seconds });
        audio += seconds; film.stats.lines_voiced += 1;
      } catch (error) {
        s.voice_attempts = (s.voice_attempts || 0) + 1;
        if (s.voice_attempts >= MAX_ATTEMPTS) { s.status = 'failed'; s.check = { ok: false, reason: `voice: ${String(error?.message || error).slice(0, 100)}` }; }
      }
    }));
    if (audio) await recordRate(storage, 'tts_speed', audio / Math.max(0.5, (Date.now() - started) / 1000), now);
  }

  // Hugging Face makes one clip per pass when it is the farm in use.
  if (film.farm?.provider === 'hf_zerogpu' && !film.farm.closed) await hfStep(ctx, film, shots);
  // A farm that stopped (or ran past its window) leaves its remaining moving shots as stills with motion, and says so.
  await settleFarm(ctx, film, shots);

  // A shot is verified when its picture passed, every line is voiced, and its clip arrived (tier A) or it was moved
  // to tier B. A reframed shot depends on the picture it reuses.
  for (const s of shots) {
    if (s.status === 'verified' || s.status === 'failed') continue;
    const source = byN.get(s.still_of);
    if (source?.status === 'failed') { s.status = 'failed'; s.check = { ok: false, reason: `its picture (shot ${source.n}) never passed` }; continue; }
    if (source?.still_key && s.dialogue.every((d) => d.audio_key) && (s.tier !== 'A' || s.clip_key)) s.status = 'verified';
  }
  await store.putShots(film.id, shots);
  await store.save(film);
  if (film.waiting) return 600_000;
  if (shots.every((s) => s.status === 'verified' || s.status === 'failed')) return startAssembly(ctx, store, film, shots);
  return 500;
}

function applyRemake(shots, n) {
  const shot = shots.find((s) => s.n === n);
  if (!shot) return;
  const source = shot.still_of;
  for (const s of shots) {
    if (s.n !== n && s.still_of !== source) continue;
    Object.assign(s, { status: 'planned', attempts: 0, check: null });
    if (s.n === source || s.n === n) s.still_key = '';
  }
  shot.still_of = n;
}

async function startAssembly(ctx, store, film, shots) {
  const now = ctx.now || Date.now();
  const plan = assemblyPlan(film, shots);
  if (!plan.timed.length) return fail(store, film, 'no shot passed its checks, so there is nothing to assemble');
  const { rates } = await loadRates(ctx.storage);
  const minutes = plan.segments.reduce((m, seg) => m + Math.ceil((rates.runner_startup_s + seg.seconds / rates.encode_speed) / 60), 0) + 2;
  const valid = (await ctx.storage.get(FILM_VALIDATION_KEY)) || {};
  if (!valid.github_actions?.public) {
    const paid = await spend(ctx.storage, 'gha_minutes', minutes, { now });
    if (!paid.ok) { film.waiting = 'Waiting for next month\'s free GitHub Actions minutes; the film is saved and resumes then.'; await store.save(film); return 3600_000; }
  }
  for (const seg of plan.segments) await ctx.storage.put(`film:${film.id}:seg:${seg.index}`, segmentSpec(film, seg, plan.timed));
  const { job, token } = await newAssemblyJob(film, plan.segments.length, now);
  await ctx.storage.put(`film:job:${job.id}`, film.id);
  const started = await startFilmRender(ctx.env, job, { base: ctx.base, token }, ctx.fetcher || fetch);
  if (!started.ok) {
    if (started.retryable) { film.waiting = started.error; await store.save(film); return 120_000; }
    return fail(store, film, started.error);
  }
  film.state = 'assembling';
  film.assembly = { job, total_s: plan.total_s, missing: plan.missing, segments: plan.segments.length, reported: [] };
  await store.save(film);
  return 30_000;
}

async function assembleStep(ctx, store, film) {
  const status = await filmRenderStatus(ctx.env, film.assembly.job, ctx.fetcher || fetch, ctx.now || Date.now());
  if (status.pending) {
    if (status.run_started_ms && !film.assembly.run_started_ms) {
      film.assembly.run_started_ms = status.run_started_ms;
      await recordRate(ctx.storage, 'runner_startup_s', (status.run_started_ms - film.assembly.job.dispatched_ms) / 1000 + 20);
      await store.save(film);
    }
    return 30_000;
  }
  if (!status.ok) return fail(store, film, status.error);
  // The runners finished; the upload's completion (the token route) moves the film on. A run that finished without
  // completing its upload produced no film.
  const fresh = await store.film(film.id);
  if (fresh.state === 'assembling') {
    fresh.assembly.finished_seen = fresh.assembly.finished_seen || (ctx.now || Date.now());
    if ((ctx.now || Date.now()) - fresh.assembly.finished_seen > 180_000) return fail(store, fresh, `the assembly finished on GitHub (run ${status.run_id}) but never uploaded a film`);
    await store.save(fresh);
    return 30_000;
  }
  return 30_000;
}

// ─── The farm ────────────────────────────────────────────────────────────────

async function dispatchFarm(ctx, film, shots) {
  const providers = await farmProviders(ctx.env, ctx.storage, ctx);
  const kaggle = providers.find((p) => p.id === 'kaggle');
  const hf = providers.find((p) => p.id === 'hf_zerogpu');
  const { token, record } = await newFarmToken(ctx.now || Date.now());
  if (kaggle?.usable) {
    const { rates } = await loadRates(ctx.storage);
    const want = shots.filter((s) => s.tier === 'A').length;
    const left = Number(kaggle.remaining.gpu_seconds);
    const seconds = Math.floor(Math.min(left, 11.5 * 3600, rates.kaggle_startup_s + want * rates.kaggle_clip_s + 900));
    const usage = await loadUsage(ctx.storage, ctx.now || Date.now());
    const paid = await spend(ctx.storage, 'kaggle_seconds', seconds, { now: ctx.now || Date.now(), caps: { kaggle_seconds: usage.kaggle_seconds + left } });
    if (paid.ok) {
      const session = await startKaggleSession(ctx.keys?.KAGGLE_API_TOKEN || ctx.env.KAGGLE_API_TOKEN, { base: ctx.base, film, token, seconds }, ctx.fetcher || fetch);
      if (session.ok) { film.farm = { ...record, provider: 'kaggle', session, started_ms: ctx.now || Date.now(), window_s: seconds }; return; }
      film.notes = [...(film.notes || []), safe(`Kaggle: ${session.error}`)];
    }
  }
  // The Space receives the farm token with each call, so this provider keeps it (it opens only this film's farm routes).
  if (hf?.usable) { film.farm = { ...record, provider: 'hf_zerogpu', token, started_ms: ctx.now || Date.now() }; return; }
  downgradeTierA(film, shots, 'no free GPU session could start');
}

function downgradeTierA(film, shots, why) {
  let n = 0;
  for (const s of shots) if (s.tier === 'A' && !s.clip_key) { s.tier = 'B'; s.downgraded = why; n += 1; }
  if (n) film.notes = [...(film.notes || []), safe(`${n} moving shots became stills with camera motion: ${why}.`)];
  film.farm = { ...(film.farm || {}), revoked: true, closed: why };
}

async function settleFarm(ctx, film, shots) {
  if (!film.farm || film.farm.closed) return;
  const pendingA = shots.filter((s) => s.tier === 'A' && !s.clip_key && s.status !== 'failed');
  if (!pendingA.length) { film.farm.revoked = true; film.farm.closed = 'all clips arrived'; return; }
  const now = ctx.now || Date.now();
  if (film.farm.provider === 'kaggle') {
    const status = await kaggleSessionStatus(ctx.keys?.KAGGLE_API_TOKEN || ctx.env.KAGGLE_API_TOKEN, film.farm.session, ctx.fetcher || fetch);
    if (status.ok && ['complete', 'error', 'cancelled'].includes(status.state)) return downgradeTierA(film, shots, `the Kaggle session ended (${status.state}${status.failure ? `: ${status.failure.slice(0, 80)}` : ''})`);
  }
  const done = await ctx.storage.get(`film:${film.id}:farmdone`);
  if (done?.error) return downgradeTierA(film, shots, `the GPU worker stopped: ${String(done.error).slice(0, 80)}`);
  // Clips may not hold up the film: once everything else is ready they get half the planned clip time more, no more.
  const othersDone = shots.filter((s) => s.tier !== 'A').every((s) => s.status === 'verified' || s.status === 'failed');
  if (othersDone) {
    film.farm.others_done_ms = film.farm.others_done_ms || now;
    const grace = (film.plan?.parts?.clips_s || 600) * 500 + 120_000;
    if (now - film.farm.others_done_ms > grace) return downgradeTierA(film, shots, 'the GPU farm ran past its planned time');
  }
}

async function hfStep(ctx, film, shots) {
  const clips = await farmLedger(ctx.storage, film);
  const shot = shots.find((s) => s.tier === 'A' && !s.clip_key && !clips[s.n]?.claimed_ms && s.status !== 'failed' && shots.find((x) => x.n === s.still_of)?.still_key);
  if (!shot) return;
  const valid = (await ctx.storage.get(FILM_VALIDATION_KEY)) || {};
  const token = ctx.keys?.HF_TOKEN || ctx.env.HF_TOKEN;
  let host = valid.hf_zerogpu?.host;
  if (!host) {
    const who = await (ctx.fetcher || fetch)('https://huggingface.co/api/whoami-v2', { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}));
    const made = who?.name ? await ensureHfSpace(token, who.name, HF_SPACE_FILES, ctx.fetcher || fetch) : { ok: false, error: 'Hugging Face did not say whose token this is' };
    if (!made.ok) return downgradeTierA(film, shots, made.error);
    host = made.host;
    await ctx.storage.put(FILM_VALIDATION_KEY, { ...valid, hf_zerogpu: { ok: true, space: made.space, host, checked_ms: ctx.now || Date.now() } });
  }
  const paid = await spend(ctx.storage, 'hf_seconds', 60, { now: ctx.now || Date.now() });
  if (!paid.ok) return downgradeTierA(film, shots, 'today\'s free ZeroGPU minutes are used up');
  const base = `${ctx.base}/api/film/farm/${film.id}`;
  const still = shots.find((x) => x.n === shot.still_of).still_key;
  const out = await hfClip(token, host, { image_url: `${base}/asset?key=${encodeURIComponent(still)}`, upload_url: `${base}/result?shot=${shot.n}`, farm_token: film.farm.token, prompt: shot.description, frames: 121, fps: 24, steps: 30 }, ctx.fetcher || fetch);
  if (!out.ok) return downgradeTierA(film, shots, `Hugging Face: ${out.error}`);
  const after = await farmLedger(ctx.storage, film);
  if (after[shot.n]?.key) shot.clip_key = after[shot.n].key;
}

// ─── Owner controls ──────────────────────────────────────────────────────────

export async function setFilmState(ctx, kind) {
  const store = new FilmStore(ctx.storage);
  const film = await store.latest();
  if (!film) return { ok: false, said: 'There is no film in the studio.' };
  if (kind === 'pause') { if (!ACTIVE.has(film.state)) return { ok: false, said: `"${film.title || film.topic}" is not running.` }; film.paused_from = film.state; film.state = 'paused'; await store.save(film, { force: true }); return { ok: true, film, said: `Paused "${film.title || film.topic}". Nothing is lost; say "resume my movie" to continue.` }; }
  if (kind === 'resume') { if (film.state !== 'paused') return { ok: false, said: `"${film.title || film.topic}" is ${film.state}, not paused.` }; film.state = film.paused_from || 'making'; await store.save(film, { force: true }); return { ok: true, film, said: `Resuming "${film.title || film.topic}".` }; }
  if (kind === 'cancel') {
    if (!ACTIVE.has(film.state) && film.state !== 'paused') return { ok: false, said: `"${film.title || film.topic}" is already ${film.state}.` };
    film.state = 'cancelled'; if (film.farm) film.farm.revoked = true; if (film.assembly?.job) film.assembly.job.expires = 0;
    await store.save(film, { force: true });
    return { ok: true, film, said: `Stopped "${film.title || film.topic}". Its finished shots are kept; I deleted nothing.` };
  }
  return { ok: false, said: 'I did not understand that.' };
}

/** "Remake shot 12": the shot (and any shot reframing its picture) is made again, then the film is reassembled. */
export async function remakeShot(ctx, n) {
  const store = new FilmStore(ctx.storage);
  const film = await store.latest();
  if (!film?.shot_count) return { ok: false, said: 'There is no film with shots to remake yet.' };
  if (film.state === 'assembling' || film.state === 'verifying') return { ok: false, said: 'The film is being assembled right now; ask again when it is done.' };
  if (!(n >= 1 && n <= film.shot_count)) return { ok: false, said: `"${film.title}" has ${film.shot_count} shots; there is no shot ${n}.` };
  const shots = await store.shots(film.id, film.shot_count);
  const others = shots.filter((s) => s.n !== n && s.still_of === shots.find((x) => x.n === n).still_of).length;
  const queue = (await ctx.storage.get(`film:${film.id}:remakes`)) || [];
  await ctx.storage.put(`film:${film.id}:remakes`, [...new Set([...queue, n])]);
  film.state = 'making'; film.result = null; film.remakes = (film.remakes || 0) + 1;
  await store.save(film, { force: true });
  return { ok: true, film, said: `Remaking shot ${n} of "${film.title}" with a new picture${others ? `; ${others} other shots that reuse it change too` : ''}. Then I reassemble the film and check it again.` };
}

async function fail(store, film, why) {
  film.state = 'failed';
  film.errors = [...(film.errors || []), safe(why)].slice(-10);
  if (film.farm) film.farm.revoked = true;
  await store.save(film, { force: true });
  return null;
}

// ─── Token routes (GitHub runners and farm GPUs; no device token exists there) ─

/**
 * Routes a runner or farm GPU may call, each opened only by its own expiring token: the assembly token for one
 * assembly job, the farm token for one film's farm work. Returns null when the path is not a film route.
 */
export async function filmTokenRoute(ctx, path, request) {
  const render = /^\/api\/film\/render\/(fgha_[a-f0-9]{32})\/(segment\/(\d{1,3})|asset|report|upload\/start|upload\/part|upload\/complete)$/.exec(path);
  const farm = /^\/api\/film\/farm\/(film_[a-f0-9]{16})\/(next|asset|result|done)$/.exec(path);
  if (!render && !farm) return null;
  const store = new FilmStore(ctx.storage);
  const url = new URL(request.url);
  if (render) {
    const filmId = await ctx.storage.get(`film:job:${render[1]}`);
    const film = filmId ? await store.film(filmId) : null;
    if (!film?.assembly?.job || film.assembly.job.id !== render[1] || !(await assemblyTokenOpens(film.assembly.job, request.headers.get('X-CHE-Render-Token'), ctx.now || Date.now()))) return json({ detail: 'Not found.' }, 404);
    const action = render[2];
    if (action.startsWith('segment/')) { const spec = await ctx.storage.get(`film:${film.id}:seg:${Number(render[3])}`); return spec ? json(spec) : json({ detail: 'No such segment.' }, 404); }
    if (action === 'asset') return assetResponse(ctx, film, url.searchParams.get('key'));
    if (action === 'report' && request.method === 'POST') {
      const r = await request.json().catch(() => ({}));
      if (Number(r.video_s) > 0 && Number(r.encode_s) > 0) await recordRate(ctx.storage, 'encode_speed', Number(r.video_s) / Number(r.encode_s));
      if (Number(r.finish_s) > 0 && film.assembly.total_s > 0) await recordRate(ctx.storage, 'finish_s_per_film_minute', Number(r.finish_s) / (film.assembly.total_s / 60));
      const reports = (await ctx.storage.get(`film:${film.id}:reports`)) || [];
      await ctx.storage.put(`film:${film.id}:reports`, [...reports, { segment: r.segment ?? 'final', encode_s: r.encode_s, video_s: r.video_s, finish_s: r.finish_s }].slice(-40));
      return json({ ok: true });
    }
    const media = mediaStore(ctx.env, ctx.storage);
    const key = `film/${film.id}/film.mp4`;
    if (action === 'upload/start' && request.method === 'POST') {
      const uploadId = crypto.randomUUID();
      await ctx.storage.put(`film:${film.id}:upload`, { upload_id: uploadId, started_ms: ctx.now || Date.now(), parts: {} });
      return json({ upload_id: uploadId, provider: media.provider });
    }
    if (action === 'upload/part' && request.method === 'PUT') {
      const n = Number(url.searchParams.get('n'));
      const upload = await ctx.storage.get(`film:${film.id}:upload`);
      if (!upload || url.searchParams.get('upload_id') !== upload.upload_id || !(n >= 1 && n <= 10000)) return json({ detail: 'Wrong upload.' }, 400);
      const bytes = new Uint8Array(await request.arrayBuffer());
      const saved = await media.put(partKey(film.id, upload.upload_id, n), bytes, { contentType: 'application/octet-stream' });
      if (!saved.ok) return json({ detail: saved.error }, 507);
      const etag = await sha256Hex(bytes);
      upload.parts = { ...(upload.parts || {}), [n]: { etag, size: bytes.length } };
      await ctx.storage.put(`film:${film.id}:upload`, upload);
      return json({ n, etag });
    }
    if (action === 'upload/complete' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const upload = await ctx.storage.get(`film:${film.id}:upload`);
      if (!upload || body.upload_id !== upload.upload_id) return json({ detail: 'Wrong upload.' }, 400);
      const built = await assembleUpload(media, { filmId: film.id, uploadId: upload.upload_id, upload, claimed: body.parts || [], finalKey: key });
      if (!built.ok) { await fail(store, film, `the upload could not be assembled: ${built.error}`); return json({ ok: false, verified: false, detail: built.error }, 422); }
      const done = await finishFilm(ctx, store, film, key);
      return json({ ok: done.ok, verified: done.ok, detail: done.ok ? 'verified' : done.error }, done.ok ? 200 : 422);
    }
    return json({ detail: 'Not found.' }, 404);
  }
  const film = await store.film(farm[1]);
  if (!film?.farm || !(await farmTokenOpens(film.farm, request.headers.get('X-CHE-Farm-Token'), ctx.now || Date.now()))) return json({ detail: 'Not found.' }, 404);
  const shots = await store.shots(film.id, film.shot_count);
  const ledgerKey = `film:${film.id}:clips`;
  const ledger = (await ctx.storage.get(ledgerKey)) || {};
  if (farm[2] === 'asset') return assetResponse(ctx, film, url.searchParams.get('key'));
  if (farm[2] === 'next') {
    const open = (s) => s.tier === 'A' && !s.clip_key && !ledger[s.n]?.key && s.status !== 'failed';
    const shot = shots.find((s) => open(s) && !ledger[s.n]?.claimed_ms && shots.find((x) => x.n === s.still_of)?.still_key);
    if (!shot) return json({ done: !shots.some(open) });
    ledger[shot.n] = { ...(ledger[shot.n] || {}), claimed_ms: ctx.now || Date.now() };
    await ctx.storage.put(ledgerKey, ledger);
    const still = shots.find((x) => x.n === shot.still_of).still_key;
    return json({ shot: shot.n, prompt: stillPrompt(shot, film.outline), image_url: `${ctx.base}/api/film/farm/${film.id}/asset?key=${encodeURIComponent(still)}`, frames: 121, fps: 24, steps: 30 });
  }
  if (farm[2] === 'result' && request.method === 'PUT') {
    const n = Number(url.searchParams.get('shot'));
    if (!shots.some((s) => s.n === n && s.tier === 'A')) return json({ detail: 'No such moving shot.' }, 404);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const facts = mp4Facts(bytes);
    // A clip has no sound (voices are mixed later): it must be a real H.264 MP4 of at least three seconds.
    if (!(bytes.length > 20_000 && facts.video && facts.seconds >= 3)) {
      ledger[n] = { ...(ledger[n] || {}), claimed_ms: 0, rejected: (ledger[n]?.rejected || 0) + 1 };
      await ctx.storage.put(ledgerKey, ledger);
      return json({ ok: false, detail: 'That is not a usable clip.' }, 422);
    }
    const key = `film/${film.id}/clips/${n}.mp4`;
    const saved = await mediaStore(ctx.env, ctx.storage).put(key, bytes, { contentType: 'video/mp4' });
    if (!saved.ok) return json({ ok: false, detail: saved.error }, 507);
    ledger[n] = { ...(ledger[n] || {}), key, seconds: facts.seconds, at: ctx.now || Date.now() };
    await ctx.storage.put(ledgerKey, ledger);
    if (Number(url.searchParams.get('seconds')) > 0 && film.farm.provider === 'kaggle') await recordRate(ctx.storage, 'kaggle_clip_s', Number(url.searchParams.get('seconds')));
    return json({ ok: true });
  }
  if (farm[2] === 'done' && request.method === 'POST') {
    await ctx.storage.put(`film:${film.id}:farmdone`, await request.json().catch(() => ({})));
    return json({ ok: true });
  }
  return json({ detail: 'Not found.' }, 404);
}

async function assetResponse(ctx, film, key) {
  if (!key || !key.startsWith(`film/${film.id}/`) || key.includes('..')) return json({ detail: 'Not found.' }, 404);
  const obj = await mediaStore(ctx.env, ctx.storage).get(key);
  if (!obj) return json({ detail: 'Not found.' }, 404);
  return new Response(obj.body, { headers: { 'Content-Type': obj.contentType || 'application/octet-stream' } });
}

/** The film exists only when the stored MP4 reads back and passes its checks; then it joins the media library. */
async function finishFilm(ctx, store, film, key) {
  film.state = 'verifying'; await store.save(film);
  const facts = await verifyFilmObject(mediaStore(ctx.env, ctx.storage), key, { expectedSeconds: film.assembly.total_s });
  if (!facts.ok) {
    await recordVideoFailed(ctx.storage, { task_id: film.id, error: facts.error, source: 'film_studio' });
    await fail(store, film, `the uploaded film did not pass its checks: ${facts.error}`);
    return facts;
  }
  const item = await saveFilmVideo(ctx.storage, { key, title: film.title, prompt: film.topic, seconds: facts.seconds, width: facts.width, height: facts.height, bytes: facts.bytes, film_id: film.id, blob: mediaStore(ctx.env, ctx.storage).provider });
  // The receipt behind "the film is finished": written only after the stored MP4 read back and passed (action_receipts.js).
  await recordVideoVerified(ctx.storage, { task_id: film.id, media_id: item.id, bytes: facts.bytes, seconds: facts.seconds, width: facts.width, height: facts.height, source: 'film_studio' });
  film.state = 'done';
  film.result = { media_id: item.id, key, seconds: facts.seconds, bytes: facts.bytes, width: facts.width, height: facts.height, missing: film.assembly.missing, at: new Date(ctx.now || Date.now()).toISOString() };
  if (film.farm) film.farm.revoked = true;
  film.assembly.job.expires = 0;
  await store.save(film);
  return { ok: true, item };
}

export const FILM_ACTIVE_STATES = ACTIVE;
