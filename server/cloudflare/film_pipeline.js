// Film Studio pipeline: the work CHE's alarm advances, one bounded pass at a time, and the token routes the GitHub
// runners and farm GPUs call. State lives in Durable Object storage (film_studio.FilmStore) and files in R2 under
// film/<id>/, so a film survives restarts and can be paused and resumed without losing anything.

import {
  FilmStore, sayFixes, FILM_VALIDATION_KEY, MAX_CAST, NEURONS, PORTRAIT_SIZE, REFERENCE_MODEL, REVIEW_ROUNDS, STILL_MODEL, TTS_MODEL, reviewFilm,
  assemblyPlan, checkPortrait, checkStill, farmProviders, learnFromCheck, loadRates, loadUsage, mp3Seconds, newFilm, outlineMessages, planFilm,
  portraitPrompt, recordRate, reserve, sceneMessages, seedFor, shotSeconds, voiceTimes, segmentSpec, shotList, spend, speakPlan, stillPrompt, validOutline, validSceneShots, outlineShots,
  _internals,
} from './film_studio.js';
import { imagePayload } from './image_payload.js';
import { routeWork } from './compute_pool.js';
import { recordVideoFailed, recordVideoVerified } from './action_receipts.js';
import { farmTokenOpens, hfClip, kaggleSessionLog, kaggleSessionStatus, newFarmToken, startKaggleSession, validateKaggle, ensureHfSpace, HF_SPACE_FILES } from './film_farm.js';
import { assemblyTokenOpens, filmRenderStatus, newAssemblyJob, publicOrigin, startFilmRender, validateGithub, verifyFilmObject } from './film_render.js';
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
  const film = await store.save(newFilm({ topic: ask.topic, targetSeconds: ask.seconds, deadline: ask.deadline, plan, roster: ask.roster, now: ctx.now || Date.now() }));
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
    const raw = await ctx.writer(outlineMessages({ topic: film.topic, targetSeconds: film.target_s, shots: film.plan.shots, roster: film.roster }));
    const outline = validOutline(_internals.writerJson(raw), { shots: film.plan.shots, roster: film.roster });
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
  // Two tries for the whole scene, then one asking for fewer shots (a long shot list is where a small model's JSON
  // breaks). Shots that can be read from a broken reply are kept, the longest list wins, and any planned shots still
  // missing show the outline's own description without dialogue, so the film keeps its length. The film's notes say
  // when that happens; one scene never stops the film.
  const written = await Promise.all(todo.map(async (scene) => {
    let best = []; let reason = '';
    for (const count of [scene.shots, scene.shots, Math.max(1, Math.min(3, Math.ceil(scene.shots / 2)))]) {
      const raw = await ctx.writer(sceneMessages(film.outline, scene, count));
      const out = validSceneShots(_internals.writerJson(raw), scene, film.outline.characters);
      if (!out.error && out.shots.length >= scene.shots) return { shots: out.shots };
      if (!out.error && out.shots.length > best.length) best = out.shots;
      reason = out.error ? (String(raw || '').trim() ? `${out.error} (reply of ${String(raw).length} characters)` : 'the writer returned nothing') : `the writer gave ${out.shots.length} of ${scene.shots} shots`;
    }
    const filler = outlineShots(scene, film.outline.characters).slice(best.length);
    return { shots: [...best, ...filler], reason: best.length ? `the writer gave ${best.length} of ${scene.shots} shots` : reason, filled: filler.length };
  }));
  for (let i = 0; i < todo.length; i += 1) {
    const w = written[i];
    if (w.reason) film.notes = [...(film.notes || []), safe(w.filled === todo[i].shots ? `Scene ${todo[i].id} was not written as a shot list (${w.reason}), so its shots show the outline's description without dialogue.` : `Scene ${todo[i].id}: ${w.reason}, so the other ${w.filled} show the outline's description without dialogue.`)];
    await ctx.storage.put(`film:${film.id}:scene:${todo[i].id}`, w.shots);
  }
  await recordRate(ctx.storage, 'script_s_per_shot', ((Date.now() - started) / 1000) / Math.max(1, todo.reduce((n, s) => n + s.shots, 0)), now);
  film.scene_next += todo.length;
  if (film.scene_next < scenes.length) { await store.save(film); return 300; }
  const sceneShots = {};
  for (const scene of scenes) sceneShots[scene.id] = (await ctx.storage.get(`film:${film.id}:scene:${scene.id}`)) || [];
  // Re-plan with the real screenplay: its spoken lines and how many distinct pictures it really needs.
  const draft = shotList(film.outline, sceneShots, film.plan);
  const speech = draft.reduce((t, s) => t + s.dialogue.reduce((u, d) => u + d.line.length / 14, 0), 0);
  const replanned = planFilm({ targetSeconds: film.target_s, deadlineSeconds: film.deadline_s, providers: await farmProviders(ctx.env, ctx.storage, ctx), ...(await loadRates(ctx.storage)), dialogueSeconds: speech, uniqueWanted: draft.length, talkingShots: draft.filter((s) => s.dialogue.length && s.characters?.length).length, now });
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

/**
 * Cast portraits, before any shot: one reference picture per character, made once and kept in the film's files, so
 * every picture of that character starts from the same face. A portrait that fails three times is given up, and the
 * character's shots are drawn from the written description alone. Returns true while portraits are still being made.
 */
async function castStep(ctx, film, media) {
  const { env, storage } = ctx;
  const now = ctx.now || Date.now();
  film.cast = film.cast || {};
  if (film.plan?.faces !== true) return false; // planned without same-face pictures (or planned before they existed)
  const want = (film.outline?.characters || []).slice(0, MAX_CAST).filter((c) => !film.cast[c.id]?.done).slice(0, STILL_BATCH);
  if (!want.length) return false;
  film.waiting = '';
  const paid = await reserve(storage, 'neurons', NEURONS.portrait, want.length, { now });
  if (!paid) { film.waiting = 'Waiting for tomorrow\'s free picture allowance (it resets at midnight UTC).'; return true; }
  await Promise.all(want.slice(0, paid).map(async (c) => {
    const entry = film.cast[c.id] || { tries: 0 };
    try {
      // Made at 448x448 by the reference model itself, so it can be that model's input as it is (no resizing).
      const out = await klein(env, { prompt: portraitPrompt(c), width: PORTRAIT_SIZE, height: PORTRAIT_SIZE, seed: c.seed });
      const bytes = out?.image ? b64ToBytes(out.image) : null;
      const check = bytes ? checkPortrait(bytes) : { ok: false, reason: 'the image model returned no picture' };
      if (!check.ok) throw new Error(check.reason);
      const key = `film/${film.id}/cast/${c.id}.jpg`;
      const saved = await media.put(key, bytes, { contentType: 'image/jpeg' });
      if (!saved.ok) throw new Error(saved.error);
      film.cast[c.id] = { done: true, key };
    } catch (error) {
      entry.tries += 1;
      entry.reason = safe(error?.message || error);
      if (entry.tries >= MAX_ATTEMPTS) { entry.done = true; film.ref_off = film.ref_off || `portrait: ${entry.reason}`; } // given up: description only
      film.cast[c.id] = entry;
    }
  }));
  return true;
}

/**
 * A shot's picture drawn from its lead character's portrait (FLUX.2 klein takes the portrait as a reference image).
 * Returns the model's output, or throws so the caller falls back to a picture from the description alone.
 */
async function referenceStill(env, media, prompt, portraitKey, seed) {
  const portrait = await media.get(portraitKey);
  if (!portrait?.body?.length) throw new Error('the portrait file is missing');
  return klein(env, { prompt, width: 1024, height: 576, seed }, portrait.body);
}

/** One FLUX.2 klein call: its input is a multipart form, with an optional reference picture. */
function klein(env, fields, image = null) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (image) form.append('input_image_0', new Blob([image], { type: 'image/jpeg' }), 'portrait.jpg');
  const body = new Response(form);
  return env.AI.run(REFERENCE_MODEL, { multipart: { body: body.body, contentType: body.headers.get('content-type') } });
}

async function makeStep(ctx, store, film) {
  const { env, storage } = ctx;
  const now = ctx.now || Date.now();
  const media = mediaStore(env, storage);
  if (await castStep(ctx, film, media)) { await store.save(film); return film.waiting ? 600_000 : 500; }
  const shots = await store.shots(film.id, film.shot_count);
  const byN = new Map(shots.map((s) => [s.n, s]));
  // Owner remakes queued since the last pass, and clips the farm delivered.
  const remakes = (await storage.get(`film:${film.id}:remakes`)) || [];
  if (remakes.length) { for (const n of remakes) applyRemake(shots, n); await storage.put(`film:${film.id}:remakes`, []); }
  const clips = await farmLedger(storage, film);
  takeFarmResults(film, shots, clips);
  const lessons = (await storage.get('film:lessons')) || [];
  film.waiting = '';

  // Moving clips go to the farm first so the GPUs work while the stills are made.
  if ((shots.some((s) => s.tier === 'A' && !s.clip_key && s.status !== 'failed') || talkers(film, shots).size) && !film.farm) await dispatchFarm(ctx, film, shots);

  // Pictures: up to four at once. The allowance for all of them is reserved first, in one step, so the cap holds.
  const wantStill = shots.filter((s) => s.still_of === s.n && !s.still_key && s.status !== 'failed').slice(0, STILL_BATCH);
  // A shot whose lead has a portrait is drawn from it; the allowance is reserved at the reference price, which also
  // covers the plain picture if the reference model fails.
  const portraitOf = (shot) => (film.ref_off ? '' : film.cast?.[shot.characters?.[0]]?.key || '');
  const stillCost = wantStill.some(portraitOf) ? NEURONS.picture : NEURONS.still;
  const stillsPaid = wantStill.length ? await reserve(storage, 'neurons', stillCost, wantStill.length, { now }) : 0;
  if (wantStill.length && !stillsPaid) film.waiting = 'Waiting for tomorrow\'s free picture allowance (it resets at midnight UTC).';
  if (stillsPaid) {
    const started = Date.now(); let made = 0; let storeError = null;
    await Promise.all(wantStill.slice(0, stillsPaid).map(async (shot) => {
      let bytes = null; let check;
      const prompt = stillPrompt(shot, film.outline, lessons);
      try {
        let out = null;
        const portrait = portraitOf(shot);
        if (portrait) {
          try {
            out = await referenceStill(env, media, prompt, portrait, seedFor(shot, film.outline));
            if (!out?.image) throw new Error('the reference model returned no picture');
            shot.from_portrait = true;
          } catch (error) {
            // The reference model is not working: say why once, and draw this and later shots from the description.
            film.ref_off = safe(error?.message || error);
            out = null;
          }
        }
        if (!out) out = await env.AI.run(STILL_MODEL, imagePayload(STILL_MODEL, { prompt, steps: 4, seed: seedFor(shot, film.outline) }).payload);
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

  // A re-render from the saved script reuses the lines already recorded: each is copied under this film (the farm
  // and the runners may fetch only this film's files) at no voice allowance. A recording that is gone is voiced again.
  const copies = [];
  for (const s of shots) s.dialogue.forEach((d, i) => { if (!d.audio_key && d.from_key && s.status !== 'failed') copies.push({ s, d, i }); });
  await Promise.all(copies.slice(0, VOICE_BATCH * 2).map(async ({ s, d, i }) => {
    try {
      const obj = await media.get(d.from_key);
      if (!obj?.body?.length) throw new Error('gone');
      const key = `film/${film.id}/voice/${s.n}-${i}.mp3`;
      const saved = await media.put(key, obj.body, { contentType: 'audio/mpeg' });
      if (!saved.ok) throw new Error(saved.error);
      Object.assign(s.dialogue[i], { audio_key: key, audio_s: Number(d.from_s) || mp3Seconds(obj.body), from_key: '' });
      film.stats.lines_voiced += 1; film.stats.voices_reused = (film.stats.voices_reused || 0) + 1;
    } catch { s.dialogue[i].from_key = ''; }
  }));

  // Voices: up to eight lines at once, reserved the same way (about 14 characters a second of speech).
  const lines = [];
  for (const s of shots) s.dialogue.forEach((d, i) => { if (!d.audio_key && !d.from_key && s.status !== 'failed') lines.push({ s, d, i }); });
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
  const chosen = talkers(film, shots);
  for (const s of shots) {
    if (s.status === 'verified' || s.status === 'failed') continue;
    if (lipPending(film, s, clips, chosen)) continue; // its lip-synced clip is still coming from the GPU
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
  // Each assembly writes its own file, so a repair round (or "remake shot N") never replaces a video already verified
  // and in the library; an assembly started before this field existed still writes film.mp4 (the token route).
  film.assembly = { job, total_s: plan.total_s, missing: plan.missing, segments: plan.segments.length, reported: [], output_key: `film/${film.id}/film-${job.id}.mp4` };
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
  // A GPU session fetches the film's pictures from CHE and uploads its clips to her. Without her public address it
  // could only fail, so the farm waits (the film keeps making its stills) until CHE has been opened once.
  if (!publicOrigin(ctx.base)) {
    film.waiting = 'Waiting to start the free GPU: CHE does not know her public address yet. Open CHE on your phone once and the moving shots start.';
    return;
  }
  const providers = await farmProviders(ctx.env, ctx.storage, ctx);
  const kaggle = providers.find((p) => p.id === 'kaggle');
  // The one compute router (compute_pool.routeWork) picks the clip farm: free GPUs only, Kaggle first; it says why
  // when none can take the clips (Modal's app has no clip function, so the paid route never applies here).
  const route = routeWork('film_clip', providers);
  const { token, record } = await newFarmToken(ctx.now || Date.now());
  if (route.order.includes('kaggle')) {
    const { rates } = await loadRates(ctx.storage);
    const want = shots.filter((s) => s.tier === 'A' && !s.clip_key).length;
    const lips = [...talkers(film, shots)].filter((n) => !shots.find((s) => s.n === n)?.lip_key).length;
    const left = Number(kaggle.remaining.gpu_seconds);
    const seconds = Math.floor(Math.min(left, 11.5 * 3600, rates.kaggle_startup_s + want * rates.kaggle_clip_s + (lips ? rates.lipsync_setup_s + lips * rates.kaggle_lipsync_s : 0) + 900));
    const usage = await loadUsage(ctx.storage, ctx.now || Date.now());
    const paid = await spend(ctx.storage, 'kaggle_seconds', seconds, { now: ctx.now || Date.now(), caps: { kaggle_seconds: usage.kaggle_seconds + left } });
    if (paid.ok) {
      const session = await startKaggleSession(ctx.keys?.KAGGLE_API_TOKEN || ctx.env.KAGGLE_API_TOKEN, { base: ctx.base, film, token, seconds, username: kaggle.username, lipsync: lips > 0 }, ctx.fetcher || fetch);
      if (session.ok) { film.farm = { ...record, provider: 'kaggle', session, started_ms: ctx.now || Date.now(), window_s: seconds }; return; }
      film.notes = [...(film.notes || []), safe(`Kaggle: ${session.error}`)];
    }
  }
  // The Space receives the farm token with each call, so this provider keeps it (it opens only this film's farm routes).
  // The Space makes moving clips only, never lip sync.
  if (route.order.includes('hf_zerogpu') && shots.some((s) => s.tier === 'A')) { film.farm = { ...record, provider: 'hf_zerogpu', token, started_ms: ctx.now || Date.now() }; if (film.plan?.lip_sync) film.notes = [...(film.notes || []), 'Lip sync needs the Kaggle GPU, which could not start, so talking shots use their pictures as they are.']; return; }
  // Why no clip farm ran, in the router's words, so the finished film can say it (film_studio.whyNotes).
  if (!route.route) film.notes = [...(film.notes || []), safe(route.why)];
  downgradeTierA(film, shots, 'no free GPU session could start');
}

// ─── Lip sync ────────────────────────────────────────────────────────────────

/** The talking shots this film lip-syncs: shots with a character speaking, in film order, as many as the plan allows. */
function talkers(film, shots) {
  const n = Number(film.plan?.lip_sync || 0);
  if (!n || film.farm?.closed) return new Set();
  return new Set(shots.filter((s) => s.dialogue.length && s.characters?.length && s.status !== 'failed').slice(0, n).map((s) => s.n));
}

/**
 * Copies what the farm delivered onto the shots: moving clips, lip-synced clips, and lip-sync failures, each of which
 * is said once in the film's notes (the owner hears why a talking shot has no lip sync).
 */
function takeFarmResults(film, shots, ledger) {
  for (const s of shots) {
    const got = ledger[s.n] || {};
    if (got.key) s.clip_key = got.key;
    if (got.lip_key) s.lip_key = got.lip_key;
    if (got.lip_error && !s.lip_error && !s.lip_key) {
      s.lip_error = got.lip_error;
      film.notes = [...(film.notes || []), safe(`Shot ${s.n} has no lip sync: ${got.lip_error}.`)];
    }
  }
}

/** A talking shot that must wait for its lip-synced clip: the Kaggle farm is open and it has neither the clip nor a failure. */
function lipPending(film, s, ledger, chosen) {
  return film.farm?.provider === 'kaggle' && !film.farm.closed && chosen.has(s.n) && !s.lip_key && !ledger[s.n]?.lip_key && !ledger[s.n]?.lip_error;
}

function downgradeTierA(film, shots, why) {
  let n = 0;
  for (const s of shots) if (s.tier === 'A' && !s.clip_key) { s.tier = 'B'; s.downgraded = why; n += 1; }
  if (n) film.notes = [...(film.notes || []), safe(`${n} moving shots became stills with camera motion: ${why}.`)];
  const unsynced = talkers(film, shots).size - shots.filter((s) => s.lip_key).length;
  if (!film.farm?.closed && unsynced > 0) film.notes = [...(film.notes || []), safe(`${unsynced} talking shot${unsynced === 1 ? '' : 's'} got no lip sync: ${why}.`)];
  film.farm = { ...(film.farm || {}), revoked: true, closed: why };
}

async function settleFarm(ctx, film, shots) {
  if (!film.farm || film.farm.closed) return;
  // Read again: a clip may have arrived during this pass. Copy it onto the shots before deciding to close the farm.
  const ledger = await farmLedger(ctx.storage, film);
  takeFarmResults(film, shots, ledger);
  const chosen = talkers(film, shots);
  const onFarm = (s) => (s.tier === 'A' && !s.clip_key && s.status !== 'failed') || lipPending(film, s, ledger, chosen);
  if (!shots.some(onFarm)) { film.farm.revoked = true; film.farm.closed = 'all clips arrived'; return; }
  const now = ctx.now || Date.now();
  // The worker's own report comes first: its handler posts the error to /done and then exits, so Kaggle also says
  // "error" for the same session, without the reason.
  const done = await ctx.storage.get(`film:${film.id}:farmdone`);
  if (done?.error) return downgradeTierA(film, shots, `the GPU worker stopped: ${safe(done.error).slice(0, 160)}`);
  if (film.farm.provider === 'kaggle') {
    const raw = ctx.keys?.KAGGLE_API_TOKEN || ctx.env.KAGGLE_API_TOKEN;
    const status = await kaggleSessionStatus(raw, film.farm.session, ctx.fetcher || fetch);
    if (status.ok && ['complete', 'error', 'cancelled'].includes(status.state)) {
      // A session that ended without reporting (it never reached CHE, or died before its handler ran): the reason is
      // in the session's own log, read once here; Kaggle's failure message is the fallback.
      const fromLog = status.state === 'complete' ? '' : await kaggleSessionLog(raw, film.farm.session, ctx.fetcher || fetch, [film.farm.token]);
      const reason = safe(fromLog || status.failure || '').slice(0, 160);
      return downgradeTierA(film, shots, `the Kaggle session ended (${status.state}${reason ? `: ${reason}` : ', with no reason in its log'})`);
    }
  }
  // Clips may not hold up the film: once everything else is ready they get half the planned clip time more, no more.
  const othersDone = shots.filter((s) => !onFarm(s)).every((s) => s.status === 'verified' || s.status === 'failed' || (s.tier === 'A' && !s.clip_key));
  if (othersDone) {
    film.farm.others_done_ms = film.farm.others_done_ms || now;
    const grace = ((film.plan?.parts?.clips_s || 600) + (film.plan?.parts?.lip_sync_s || 0)) * 500 + 120_000;
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
  // A director-loop repair that fails leaves the film as it was: done, with the video it already had, and the fixes
  // it tried listed as still short with the reason.
  if (film.previous_result && film.review?.fixing?.length) {
    Object.assign(film.review, { left: mergeFixes(film.review.left || [], film.review.fixing), fixing: [], why: safe(why) });
    film.state = 'done'; film.result = film.previous_result; film.previous_result = null;
    if (film.farm) film.farm.revoked = true;
    await store.save(film, { force: true });
    return null;
  }
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
  const farm = /^\/api\/film\/farm\/(film_[a-f0-9]{16})\/(next|asset|result|done|lipfail)$/.exec(path);
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
    const key = film.assembly?.output_key || `film/${film.id}/film.mp4`;
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
    // kind: "clip" or "lipsync" (one loop per GPU on a two-GPU session), "any" (one GPU), or "hello" (the worker is up).
    const kind = url.searchParams.get('kind') || 'any';
    const gpus = Number(url.searchParams.get('gpus'));
    if (kind === 'hello') {
      // Real start-up time (session boot until the worker asks) and the GPU count, measured for the next plans.
      if (!ledger.hello_ms) {
        ledger.hello_ms = ctx.now || Date.now();
        await patchLedger(ctx.storage, ledgerKey, 'hello_ms', () => ledger.hello_ms);
        if (film.farm.started_ms) await recordRate(ctx.storage, 'kaggle_startup_s', (ledger.hello_ms - film.farm.started_ms) / 1000);
        if (gpus > 0) await recordRate(ctx.storage, 'kaggle_gpus', gpus);
      }
      return json({ ok: true });
    }
    const open = (s) => s.tier === 'A' && !s.clip_key && !ledger[s.n]?.key && s.status !== 'failed';
    const shot = kind === 'lipsync' ? null : shots.find((s) => open(s) && !ledger[s.n]?.claimed_ms && shots.find((x) => x.n === s.still_of)?.still_key);
    if (!shot) {
      // Then lip sync: a talking shot whose picture (or moving clip) and voices are ready, unclaimed for 30 minutes.
      const chosen = talkers(film, shots);
      const asset = (key) => `${ctx.base}/api/film/farm/${film.id}/asset?key=${encodeURIComponent(key)}`;
      const clipOf = (s) => s.clip_key || ledger[s.n]?.key || '';
      const stillOf = (s) => shots.find((x) => x.n === s.still_of)?.still_key || '';
      const ready = (s) => stillOf(s) && s.dialogue.every((d) => d.audio_key) && (s.tier !== 'A' || clipOf(s));
      const now = ctx.now || Date.now();
      const lip = kind === 'clip' ? null : shots.find((s) => lipPending(film, s, ledger, chosen) && ready(s) && now - Number(ledger[s.n]?.lip_claimed_ms || 0) > 1_800_000);
      if (lip) {
        await patchLedger(ctx.storage, ledgerKey, lip.n, (cur) => ({ ...cur, lip_claimed_ms: now }));
        return json({ kind: 'lipsync', shot: lip.n, seconds: shotSeconds(lip), fps: 25, video_url: clipOf(lip) ? asset(clipOf(lip)) : '', image_url: asset(stillOf(lip)), audio: voiceTimes(lip).map((v) => ({ url: asset(v.key), at: v.at })) });
      }
      // Work still coming (clips claimed, or talking shots whose pictures and voices are not made yet): wait, do not stop.
      const clipsLeft = kind !== 'lipsync' && shots.some(open);
      const lipsLeft = kind !== 'clip' && shots.some((s) => lipPending(film, s, ledger, chosen));
      if (clipsLeft || lipsLeft) return json({ wait: 30 });
      return json({ done: true });
    }
    await patchLedger(ctx.storage, ledgerKey, shot.n, (cur) => ({ ...cur, claimed_ms: ctx.now || Date.now() }));
    const still = shots.find((x) => x.n === shot.still_of).still_key;
    return json({ shot: shot.n, prompt: stillPrompt(shot, film.outline), image_url: `${ctx.base}/api/film/farm/${film.id}/asset?key=${encodeURIComponent(still)}`, frames: 121, fps: 24, steps: 30 });
  }
  if (farm[2] === 'result' && request.method === 'PUT' && url.searchParams.get('kind') === 'lipsync') {
    const n = Number(url.searchParams.get('shot'));
    const shot = shots.find((s) => s.n === n && s.dialogue.length);
    if (!shot) return json({ detail: 'No such talking shot.' }, 404);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const facts = mp4Facts(bytes);
    // A lip-synced clip replaces the shot's picture in the edit, so it must be a real H.264 MP4 the shot's full length.
    if (!(bytes.length > 20_000 && facts.video && facts.seconds >= shotSeconds(shot) - 0.5)) {
      await patchLedger(ctx.storage, ledgerKey, n, (cur) => ({ ...cur, lip_claimed_ms: 0, lip_rejected: (cur.lip_rejected || 0) + 1, ...((cur.lip_rejected || 0) >= 1 ? { lip_error: 'the lip-synced clip was not usable twice' } : {}) }));
      return json({ ok: false, detail: 'That is not a usable lip-synced clip.' }, 422);
    }
    const key = `film/${film.id}/lips/${n}.mp4`;
    const saved = await mediaStore(ctx.env, ctx.storage).put(key, bytes, { contentType: 'video/mp4' });
    if (!saved.ok) return json({ ok: false, detail: saved.error }, 507);
    await patchLedger(ctx.storage, ledgerKey, n, (cur) => ({ ...cur, lip_key: key, lip_s: facts.seconds }));
    if (Number(url.searchParams.get('seconds')) > 0) await recordRate(ctx.storage, 'kaggle_lipsync_s', Number(url.searchParams.get('seconds')));
    if (Number(url.searchParams.get('setup')) > 0) await recordRate(ctx.storage, 'lipsync_setup_s', Number(url.searchParams.get('setup')));
    return json({ ok: true });
  }
  if (farm[2] === 'lipfail' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const n = Number(body.shot);
    if (!shots.some((s) => s.n === n && s.dialogue.length)) return json({ detail: 'No such talking shot.' }, 404);
    // That shot keeps its picture; the film does not wait for it.
    await patchLedger(ctx.storage, ledgerKey, n, (cur) => ({ ...cur, lip_error: safe(body.error || 'lip sync failed') }));
    return json({ ok: true });
  }
  if (farm[2] === 'result' && request.method === 'PUT') {
    const n = Number(url.searchParams.get('shot'));
    if (!shots.some((s) => s.n === n && s.tier === 'A')) return json({ detail: 'No such moving shot.' }, 404);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const facts = mp4Facts(bytes);
    // A clip has no sound (voices are mixed later): it must be a real H.264 MP4 of at least three seconds.
    if (!(bytes.length > 20_000 && facts.video && facts.seconds >= 3)) {
      await patchLedger(ctx.storage, ledgerKey, n, (cur) => ({ ...cur, claimed_ms: 0, rejected: (cur.rejected || 0) + 1 }));
      return json({ ok: false, detail: 'That is not a usable clip.' }, 422);
    }
    const key = `film/${film.id}/clips/${n}.mp4`;
    const saved = await mediaStore(ctx.env, ctx.storage).put(key, bytes, { contentType: 'video/mp4' });
    if (!saved.ok) return json({ ok: false, detail: saved.error }, 507);
    await patchLedger(ctx.storage, ledgerKey, n, (cur) => ({ ...cur, key, seconds: facts.seconds, at: ctx.now || Date.now() }));
    if (Number(url.searchParams.get('seconds')) > 0 && film.farm.provider === 'kaggle') await recordRate(ctx.storage, 'kaggle_clip_s', Number(url.searchParams.get('seconds')));
    return json({ ok: true });
  }
  if (farm[2] === 'done' && request.method === 'POST') {
    await ctx.storage.put(`film:${film.id}:farmdone`, await request.json().catch(() => ({})));
    return json({ ok: true });
  }
  return json({ detail: 'Not found.' }, 404);
}

/**
 * Changes one entry of the farm ledger from the ledger as stored now, never from a copy read earlier in the request:
 * two GPUs upload at the same time, and a request that awaited its upload must not write back an older ledger over the
 * other's result. The read and the write are back to back with nothing awaited between them, so in the Durable Object
 * no other request runs in between (its input gate holds while storage is read).
 */
async function patchLedger(storage, key, entry, change) {
  const fresh = (await storage.get(key)) || {};
  fresh[entry] = change(fresh[entry] && typeof fresh[entry] === 'object' ? fresh[entry] : {});
  await storage.put(key, fresh);
  return fresh;
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
  // The director loop: check the finished film against what was asked and, within its rounds, fix what it can.
  try { await directorRound(ctx, store, film); } catch (error) { film.notes = [...(film.notes || []), safe(`My check of the finished film did not run: ${error?.message || error}`)]; await store.save(film); }
  return { ok: true, item };
}

// ─── The director loop ───────────────────────────────────────────────────────

const sameFix = (a, b) => a.kind === b.kind;
function mergeFixes(into, add) {
  const out = into.map((f) => ({ ...f, shots: [...f.shots] }));
  for (const f of add) {
    const at = out.find((x) => sameFix(x, f));
    if (at) at.shots = [...new Set([...at.shots, ...f.shots])].sort((a, b) => a - b); else out.push({ ...f, shots: [...f.shots] });
  }
  return out;
}

/**
 * One round of the director loop on a finished film: review it (film_studio.reviewFilm), say what the last round
 * fixed, and start the fixes it can make: remake shots that never passed, and moving clips or lip sync again on a
 * free GPU the one compute router offers (compute_pool.routeWork; never a paid route). At most REVIEW_ROUNDS
 * automatic rounds; `manual` (the owner's "fix it" / "check it again") allows one more. A fix it cannot make is kept,
 * with the router's reason, for the finished film's status. Returns { started, review }.
 */
export async function directorRound(ctx, store, film, { manual = false } = {}) {
  const shots = await store.shots(film.id, film.shot_count);
  const prev = film.review || {};
  const found = reviewFilm(film, shots);
  const open = (kind, n) => found.fixes.some((f) => f.kind === kind && f.shots.includes(n));
  const fixedNow = (prev.fixing || []).map((f) => ({ kind: f.kind, shots: f.shots.filter((n) => !open(f.kind, n)) })).filter((f) => f.shots.length);
  const review = { rounds: prev.rounds || 0, extra: (prev.extra || 0) + (manual ? 1 : 0), checked: found.checked, short: found.short, fixed: mergeFixes(prev.fixed || [], fixedNow), fixing: [], left: [], why: '', at: new Date(ctx.now || Date.now()).toISOString() };
  const finish = async () => { film.review = review; await store.save(film); return { started: false, review }; };
  if (!found.fixes.length) return finish();
  if (review.rounds >= REVIEW_ROUNDS + review.extra) { review.left = found.fixes; return finish(); }
  const byN = new Map(shots.map((s) => [s.n, s]));
  let todo = found.fixes.filter((f) => f.kind === 'remake');
  const gpu = found.fixes.filter((f) => f.kind !== 'remake');
  // A remade shot still planned to move (tier A, no clip) needs a clip farm too; without one it could never verify.
  const remakeMoving = (todo[0]?.shots || []).filter((n) => byN.get(n)?.tier === 'A' && !byN.get(n)?.clip_key);
  const route = gpu.length || remakeMoving.length ? routeWork('film_clip', await farmProviders(ctx.env, ctx.storage, ctx)) : null;
  if (gpu.length) {
    // Lip sync runs only on the Kaggle GPU; moving clips on any free clip farm.
    const can = (f) => route.route && (f.kind === 'clips' || route.order.includes('kaggle'));
    todo = [...todo, ...gpu.filter(can)];
    review.left = gpu.filter((f) => !can(f));
    if (review.left.length) review.why = route.route ? 'lip sync needs the free Kaggle GPU, which is not available now' : route.why;
  }
  if (!todo.length) return finish();
  const remakes = todo.find((f) => f.kind === 'remake')?.shots || [];
  if (remakes.length) {
    const queue = (await ctx.storage.get(`film:${film.id}:remakes`)) || [];
    await ctx.storage.put(`film:${film.id}:remakes`, [...new Set([...queue, ...remakes])]);
    for (const n of remakes) if (byN.get(n)) byN.get(n).voice_attempts = 0;
  }
  // Without a free clip farm, a remade shot that was planned to move becomes a still with camera motion, and says so.
  if (remakeMoving.length && !route.route) {
    for (const n of remakeMoving) Object.assign(byN.get(n), { tier: 'B', downgraded: route.why || 'no free GPU session could start' });
    film.notes = [...(film.notes || []), safe(`${remakeMoving.length} remade shot${remakeMoving.length === 1 ? '' : 's'} became stills with camera motion: ${route.why || 'no free GPU session could start'}.`)];
  }
  const again = todo.filter((f) => f.kind !== 'remake');
  const reopen = new Set([...again.flatMap((f) => f.shots), ...(route?.route ? remakeMoving : [])]);
  if (reopen.size) {
    const ns = reopen;
    for (const n of again.flatMap((f) => f.shots)) {
      const s = byN.get(n);
      if (again.some((f) => f.kind === 'clips' && f.shots.includes(n))) { s.tier = 'A'; delete s.downgraded; }
      delete s.lip_error;
      s.status = 'planned';
    }
    // The farm's ledger forgets these shots' old answers, and a new free GPU session is started for them only.
    const ledgerKey = `film:${film.id}:clips`;
    const ledger = (await ctx.storage.get(ledgerKey)) || {};
    for (const n of ns) { const { claimed_ms, lip_claimed_ms, lip_error, lip_rejected, rejected, ...keep } = ledger[n] || {}; ledger[n] = keep; }
    await ctx.storage.put(ledgerKey, ledger);
    await ctx.storage.delete(`film:${film.id}:farmdone`);
    film.farm = null;
  }
  await store.putShots(film.id, shots);
  review.rounds += 1;
  review.fixing = todo;
  film.review = review;
  film.previous_result = film.result;
  film.result = null;
  film.state = 'making';
  await store.save(film);
  return { started: true, review };
}

/**
 * Words that may not be for the Film Studio at all. "Check it again" and "fix it" name no film: they are its only
 * while a finished film is recent. "Re-render <words>" without the word film is its only when the words are a film's
 * title ("re-render the Nova character" is not). Any other ask applies.
 */
export async function filmAskApplies(storage, ask, now = Date.now()) {
  if (!ask?.bare) return true;
  const store = new FilmStore(storage);
  if (ask.kind === 'rerender') return Boolean(filmByTitle(await store.index(), ask.title));
  const film = await store.latest();
  return Boolean(film && film.state === 'done' && now - Date.parse(film.result?.at || film.updated_at || 0) < 6 * 3600_000);
}
export const filmReviewApplies = (storage, now = Date.now()) => filmAskApplies(storage, { kind: 'review', bare: true }, now);

/** The owner's "fix it" / "check it again": one more round of the director loop on the latest finished film. */
export async function reviewFilmNow(ctx, { fix = false } = {}) {
  const store = new FilmStore(ctx.storage);
  const film = await store.latest();
  if (!film) return { ok: false, said: 'There is no film in the studio to check.' };
  const name = film.title ? `"${film.title}"` : 'your film';
  if (film.state !== 'done') return { ok: false, said: `${name} is not finished yet (${film.state}); I check it myself as soon as it is.` };
  const out = await directorRound(ctx, store, film, { manual: true });
  const r = out.review;
  if (out.started) return { ok: true, started: true, film, said: `I checked ${name} again: ${r.checked.join(', ')}. I'm fixing it now: ${sayFixes(r.fixing)}.${r.left.length ? ` I can't fix the rest right now: ${sayFixes(r.left, false)} (${r.why}).` : ''} Then I reassemble it and check it once more.` };
  const short = [...r.short, ...(r.left.length ? [sayFixes(r.left, false)] : [])];
  if (!short.length) return { ok: true, film, said: `I checked ${name} again: ${r.checked.join(', ')}. Everything matches what you asked${fix ? ', so there is nothing to fix' : ''}.` };
  return { ok: true, film, said: `I checked ${name} again: ${r.checked.join(', ')}. Still short: ${short.join('; ')}${r.why ? ` (${r.why})` : ''}. I can't fix that with the free tools right now.` };
}

// ─── Re-render from the saved script ─────────────────────────────────────────

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** The film an owner names, by its title in any case: exact first, then a title the words contain or are part of. */
function filmByTitle(index, title) {
  const want = norm(title);
  if (!want) return null;
  return index.find((f) => norm(f.title) === want) || index.find((f) => f.title && want.length >= 4 && (norm(f.title).includes(want) || want.includes(norm(f.title)))) || null;
}

/**
 * "Re-render Brewed Anarchy": a NEW film made from a finished film's saved outline, title, cast, shots and dialogue
 * (and its recorded voices while they are stored), with today's pipeline (moving clips, lip sync). The writer is never
 * called, so the words are the same. The old film and its video stay as they are.
 */
export async function rerenderFilm(ctx, ask) {
  const store = new FilmStore(ctx.storage);
  const index = await store.index();
  const busy = index.find((f) => ACTIVE.has(f.state));
  if (busy) return { ok: false, said: `I'm already making "${busy.title || 'a film'}". Say "how's my movie going" for its progress, or "cancel my movie" first.` };
  const entry = ask.last ? index.find((f) => f.state === 'done') : filmByTitle(index, ask.title);
  if (!entry) {
    const named = index.filter((f) => f.title && f.state === 'done').slice(0, 5).map((f) => `"${f.title}"`);
    return { ok: false, said: `${ask.last ? 'You have no finished film yet.' : `I have no film called "${ask.title}".`}${named.length ? ` Your finished films: ${named.join(', ')}.` : ''}` };
  }
  const old = await store.film(entry.id);
  const shots = old?.shot_count ? await store.shots(old.id, old.shot_count) : [];
  const title = old?.title || entry.title || ask.title;
  if (!old?.outline?.scenes?.length || !shots.length || shots.length < old.shot_count) {
    return { ok: false, said: `I can't re-render "${title}" from its script: ${!old ? 'its record is no longer stored' : !old.outline?.scenes?.length ? 'its screenplay was never finished' : 'its shot list is no longer complete'}. Ask for a new film instead and I'll write it fresh.` };
  }
  // The saved shots, scene by scene, as the writer gave them; each line keeps its recording to reuse.
  const sceneShots = {};
  for (const s of shots) {
    (sceneShots[s.scene] ||= []).push({ description: s.description, characters: s.characters, sound: s.sound, camera: s.camera,
      dialogue: s.dialogue.map(({ audio_key, audio_s, from_key, from_s, ...d }) => ({ ...d, from_key: audio_key || '', from_s: audio_s || 0 })) });
  }
  await refreshValidation(ctx);
  const now = ctx.now || Date.now();
  const draft = shotList(old.outline, sceneShots, { tier_a: 0, reuse: 1 });
  const speech = draft.reduce((t, s) => t + s.dialogue.reduce((u, d) => u + (d.from_s || d.line.length / 14), 0), 0);
  // The owner's own deadline carries over; a default one is planned afresh (and not quoted back as if he gave it).
  const deadline = old.deadline_s && old.deadline_words ? { seconds: old.deadline_s, words: old.deadline_words } : null;
  const plan = planFilm({ targetSeconds: old.target_s, deadlineSeconds: deadline?.seconds ?? null, providers: await farmProviders(ctx.env, ctx.storage, ctx), ...(await loadRates(ctx.storage)), dialogueSeconds: speech, uniqueWanted: draft.length, talkingShots: draft.filter((s) => s.dialogue.length && s.characters?.length).length, now });
  const said = speakPlan(plan, { asked: deadline?.words });
  if (!plan.ok) return { ok: false, said };
  const film = newFilm({ topic: old.topic, targetSeconds: old.target_s, deadline, plan, roster: old.roster, now });
  Object.assign(film, { title: old.title, outline: old.outline, scene_next: old.outline.scenes.length, rerender_of: old.id, state: 'making' });
  // The same faces: the old film's portraits are reused (the Worker reads them directly; no runner fetches them).
  const portraits = Object.fromEntries(Object.entries(old.cast || {}).filter(([, c]) => c?.key).map(([id, c]) => [id, { done: true, key: c.key }]));
  if (Object.keys(portraits).length) film.cast = portraits;
  const made = shotList(old.outline, sceneShots, plan);
  await store.putShots(film.id, made);
  film.shot_count = made.length;
  film.eta_at = new Date(now + plan.eta_s * 1000).toISOString();
  await store.save(film);
  const lines = made.reduce((n, s) => n + s.dialogue.length, 0);
  const recorded = made.reduce((n, s) => n + s.dialogue.filter((d) => d.from_key).length, 0);
  const faces = Object.keys(portraits).length;
  return { ok: true, film, said: `Re-rendering "${title}" from its saved script: the same ${old.outline.scenes.length} scenes, ${made.length} shots and ${lines} lines of dialogue, nothing rewritten${recorded ? `, reusing ${recorded} recorded voice line${recorded === 1 ? '' : 's'}` : ''}${faces ? ` and the same ${faces} character portrait${faces === 1 ? '' : 's'}` : ''}. ${said} Starting now.` };
}

export const FILM_ACTIVE_STATES = ACTIVE;
