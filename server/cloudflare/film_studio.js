// CHE Film Studio (owner handoff 2026-10-22, with the owner's speed correction the same day).
// From a sentence ("Chay, make me a 2-hour movie about a lighthouse keeper") CHE writes a screenplay, plans every
// shot, makes the pictures, voices and music with free compute, and assembles the film on her free GitHub renderer.
//
// What this module owns: the free compute pool and its hard caps, the tier planner and its ETA (from measured
// throughput), the screenplay, the shot list and its checks, and the owner's spoken words. It adds no router, job
// system or renderer registry: chat reaches it through the ordinary /api/chat route, work advances on CHE's alarm,
// assembly runs on the existing GitHub Actions renderer path (film_render.js) and GPU sessions on the farm
// (film_farm.js).
//
// Honesty rules enforced here, not in prompts:
//   - Nothing costs money. Every provider has a hard cap below its free allowance; work past a cap waits, with an ETA.
//   - A provider counts as connected only after a validation call succeeded.
//   - The owner's computer is never part of the farm, a plan or an ETA (owner, 2026-10-22).
//   - Google Colab cannot be started without a person opening it, so it is listed as not automated and never planned.
//   - An ETA is computed from measured throughput; until a stage has been measured it says the number is a starting
//     estimate. A deadline that free compute cannot meet is said plainly, with the best real time.
//   - A shot ships only after it passed its checks; a film is done only when its MP4 is in R2 and was verified.

export const FILM_INDEX_KEY = 'film:index';
export const FILM_RATES_KEY = 'film:throughput';
export const FILM_USAGE_KEY = 'film:usage';
export const FILM_VALIDATION_KEY = 'film:validation';
export const FILM_LESSONS_KEY = 'film:lessons';
const SHOTS_PER_CHUNK = 80; // keeps each stored value far under the Durable Object 128 KB limit

export const STILL_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const REFERENCE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
export const TTS_MODEL = '@cf/myshell-ai/melotts';

// Neuron costs from the Workers AI pricing page (read 2026-10-22). FLUX.1 schnell: 4.80 per 512x512 tile plus 9.60 per
// step; it renders 1024x1024 (4 tiles) at 4 steps. MeloTTS: 18.63 per audio minute. FLUX.2 klein 4B: 26.05 per output
// tile plus 5.37 per input tile (one 512x512 reference).
export const NEURONS = Object.freeze({
  still: 4 * 4.8 + 4 * 9.6,
  reference_still: 4 * 26.05 + 5.37,
  tts_per_minute: 18.63,
});
// Workers AI gives 10,000 neurons a day free, shared with everything else CHE does. The film uses at most this share
// so chat keeps working, and stops for the day at it (hard cap; it resets 00:00 UTC).
export const WORKERS_AI_DAILY_FREE = 10_000;
export const FILM_NEURON_SHARE = 6_000;
// GitHub Actions: 2,000 free minutes a month on a private repository (public repositories are not metered).
export const GHA_PRIVATE_FREE_MINUTES = 2_000;
export const GHA_FILM_MINUTES_CAP = 1_600;
export const GHA_MAX_PARALLEL = 20; // free-plan concurrent job limit
// Hugging Face ZeroGPU: the docs give free accounts 3.5 to 5 GPU minutes a day; CHE plans with the lower number.
export const HF_FREE_DAILY_SECONDS = 210;
// Kaggle reports the real weekly GPU quota; CHE keeps an hour of it unused as margin.
export const KAGGLE_MARGIN_SECONDS = 3600;
export const KAGGLE_SESSION_MAX_SECONDS = 11.5 * 3600; // sessions end at 12 hours

const SHOT_SECONDS = 6;
const CLIP_SECONDS = 5;
const MAX_REUSE = 4; // normally one picture serves at most four shots (different framing and camera move each time)
const DEADLINE_REUSE = 16; // to meet the owner's deadline on one day's free pictures, up to sixteen, said plainly
const MAX_ATTEMPTS = 3;

// Starting numbers used until a stage has been measured on this account. Every one is replaced by a measurement.
export const DEFAULT_RATES = Object.freeze({
  images_per_s: 0.8, // Workers AI stills, four in flight
  tts_speed: 15, // seconds of speech made per second, four in flight
  encode_speed: 2, // seconds of film encoded per second on one runner (2.3 measured on 4 cores, 2026-10-22; private runners have 2)
  runner_startup_s: 75, // dispatch → runner ready with ffmpeg and the assets
  finish_s_per_film_minute: 1.5, // concat + upload + verify, per minute of film
  script_s_per_shot: 0.25, // screenplay writing, scenes written in parallel
  kaggle_startup_s: 600, // GPU session start + model download
  kaggle_clip_s: 240, // one 5-second moving clip on a T4
  hf_clip_s: 60,
});

export const FARM_PROVIDERS = Object.freeze({
  workers_ai: { name: 'Cloudflare Workers AI', does: 'pictures, voices and checks', free: '10,000 neurons a day, shared with the rest of CHE', automated: true, external: false },
  github_actions: { name: 'GitHub Actions', does: 'assembling the film with ffmpeg, up to 20 runners at once', free: '2,000 minutes a month on a private repository', automated: true, external: false },
  kaggle: { name: 'Kaggle', does: 'moving clips on a free T4 GPU', free: 'a weekly GPU quota (about 30 hours), read from your account', automated: true, external: true, key: 'kaggle' },
  hf_zerogpu: { name: 'Hugging Face ZeroGPU', does: 'a few moving clips a day', free: '3.5 to 5 GPU minutes a day on a free account', automated: true, external: true, key: 'huggingface' },
  colab: { name: 'Google Colab', does: 'nothing yet', free: 'free GPU sessions, but only in a browser someone opens', automated: false, external: true, reason: 'Colab has no official way to start a notebook without a person opening it in a browser, so I cannot run it for you. I do not use it in any plan.' },
});

const round = (n, d = 0) => Math.round(Number(n || 0) * 10 ** d) / 10 ** d;
const today = (now) => new Date(now).toISOString().slice(0, 10);
const month = (now) => new Date(now).toISOString().slice(0, 7);
const isoWeek = (now) => { const d = new Date(now); const day = (d.getUTCDay() + 1) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); }; // Kaggle resets Saturday 00:00 UTC
const get = async (s, k, d) => { try { const v = await s?.get?.(k); return v ?? d; } catch (_) { return d; } };

// ─── Measured throughput ─────────────────────────────────────────────────────

/** The rates the planner uses: a measurement where one exists, the starting number otherwise, and which is which. */
export async function loadRates(storage) {
  const stored = await get(storage, FILM_RATES_KEY, {});
  const rates = {}; const measured = {};
  for (const [k, v] of Object.entries(DEFAULT_RATES)) {
    const m = stored?.[k];
    rates[k] = m && Number(m.value) > 0 ? Number(m.value) : v;
    measured[k] = Boolean(m && Number(m.samples) > 0);
  }
  return { rates, measured };
}

/** One measurement of a stage, folded into its running average (newer runs count more). */
export async function recordRate(storage, name, value, now = Date.now()) {
  if (!(name in DEFAULT_RATES) || !(Number(value) > 0) || !Number.isFinite(Number(value))) return null;
  const stored = await get(storage, FILM_RATES_KEY, {});
  const prior = stored[name];
  const next = prior && prior.samples > 0 ? prior.value * 0.6 + Number(value) * 0.4 : Number(value);
  stored[name] = { value: round(next, 4), samples: (prior?.samples || 0) + 1, at: new Date(now).toISOString() };
  await storage.put(FILM_RATES_KEY, stored);
  return stored[name];
}

// ─── Free allowances (hard caps) ─────────────────────────────────────────────

export async function loadUsage(storage, now = Date.now()) {
  const u = await get(storage, FILM_USAGE_KEY, {});
  return {
    day: today(now), neurons: u.day === today(now) ? Number(u.neurons || 0) : 0,
    month: month(now), gha_minutes: u.month === month(now) ? Number(u.gha_minutes || 0) : 0,
    week: isoWeek(now), kaggle_seconds: u.week === isoWeek(now) ? Number(u.kaggle_seconds || 0) : 0,
    hf_day: today(now), hf_seconds: u.hf_day === today(now) ? Number(u.hf_seconds || 0) : 0,
  };
}

/**
 * Takes free allowance before using it. Refuses (and spends nothing) when the cap would be passed, so the cap is a
 * hard limit, never a soft target.
 */
export async function spend(storage, what, amount, { now = Date.now(), caps = {} } = {}) {
  const u = await loadUsage(storage, now);
  const field = { neurons: 'neurons', gha_minutes: 'gha_minutes', kaggle_seconds: 'kaggle_seconds', hf_seconds: 'hf_seconds' }[what];
  if (!field) return { ok: false, reason: 'unknown allowance' };
  const cap = caps[what] ?? { neurons: FILM_NEURON_SHARE, gha_minutes: GHA_FILM_MINUTES_CAP, kaggle_seconds: Infinity, hf_seconds: HF_FREE_DAILY_SECONDS }[what];
  if (u[field] + Number(amount) > cap) return { ok: false, capped: true, used: u[field], cap, reason: `the free ${what.replace('_', ' ')} cap for this period is reached` };
  u[field] += Number(amount);
  await storage.put(FILM_USAGE_KEY, u);
  return { ok: true, used: u[field], cap };
}

/**
 * Reserves allowance for up to `want` items of `unit` each in one read-modify-write (so parallel work in one pass
 * cannot race past the cap). Returns how many fit; spends exactly that many.
 */
export async function reserve(storage, what, unit, want, { now = Date.now(), caps = {} } = {}) {
  const u = await loadUsage(storage, now);
  const field = what;
  const cap = caps[what] ?? { neurons: FILM_NEURON_SHARE, gha_minutes: GHA_FILM_MINUTES_CAP, kaggle_seconds: Infinity, hf_seconds: HF_FREE_DAILY_SECONDS }[what];
  const fit = Math.max(0, Math.min(want, Math.floor((cap - u[field]) / unit)));
  if (fit > 0) { u[field] += fit * unit; await storage.put(FILM_USAGE_KEY, u); }
  return fit;
}

export function secondsUntilReset(kind, now = Date.now()) {
  const d = new Date(now);
  if (kind === 'day') return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000);
  if (kind === 'month') return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - now) / 1000);
  return 0;
}

// ─── The pool ────────────────────────────────────────────────────────────────

/**
 * Every provider and what CHE can honestly say about it now. `usable` means: validated, not blocked, under its cap.
 * The owner's own computer is not a provider here, whatever connector is configured (owner, 2026-10-22).
 */
export async function farmProviders(env = {}, storage, { now = Date.now(), internalOnly = false, noExport = false, keys = {} } = {}) {
  const usage = await loadUsage(storage, now);
  const valid = await get(storage, FILM_VALIDATION_KEY, {});
  const health = await get(storage, 'key_health', {});
  const out = [];
  const add = (id, extra) => out.push({ id, ...FARM_PROVIDERS[id], ...extra });
  const blocked = (p) => (p.external && internalOnly ? 'internal-only mode is on, so I do not send work to outside GPUs'
    : p.external && noExport ? 'this project stays inside CHE, so I do not send it to outside GPUs' : '');

  const aiBound = Boolean(env.AI) && env.CHE_AI_BOUND !== false;
  const neuronsLeft = Math.max(0, FILM_NEURON_SHARE - usage.neurons);
  add('workers_ai', {
    status: !aiBound ? 'not set up' : valid.workers_ai?.ok ? 'connected' : 'built in, not yet checked',
    usable: aiBound && neuronsLeft > NEURONS.still,
    remaining: { neurons: round(neuronsLeft), stills: Math.floor(neuronsLeft / NEURONS.still) },
    resets_in_s: secondsUntilReset('day', now),
    detail: aiBound ? `${round(neuronsLeft)} of the film's ${FILM_NEURON_SHARE} neurons left today (about ${Math.floor(neuronsLeft / NEURONS.still)} pictures).` : 'The Worker has no Workers AI binding.',
  });

  const ghConfigured = Boolean(env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO);
  const repoPublic = valid.github_actions?.public === true;
  const ghLeft = repoPublic ? Infinity : Math.max(0, GHA_FILM_MINUTES_CAP - usage.gha_minutes);
  add('github_actions', {
    status: !ghConfigured ? 'not set up' : valid.github_actions?.ok ? 'connected' : 'not yet checked',
    usable: ghConfigured && valid.github_actions?.ok === true && ghLeft > 5,
    remaining: { minutes: repoPublic ? null : round(ghLeft) },
    detail: !ghConfigured ? 'Needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker.'
      : repoPublic ? 'Public repository: Actions minutes are not metered.' : `${round(ghLeft)} of the film's ${GHA_FILM_MINUTES_CAP} Actions minutes left this month.`,
  });

  const kaggleKey = keys.KAGGLE_API_TOKEN || env.KAGGLE_API_TOKEN || '';
  const kv = valid.kaggle || {};
  const kaggleLeft = kv.ok ? Math.max(0, Number(kv.allowed_s || 0) - Number(kv.used_s || 0) - Number(kv.reserved_s || 0) - KAGGLE_MARGIN_SECONDS - usage.kaggle_seconds) : 0;
  const kBlock = blocked(FARM_PROVIDERS.kaggle);
  add('kaggle', {
    status: !kaggleKey ? 'not set up' : kBlock ? 'blocked' : kv.ok ? (kv.username ? 'connected' : 'connected, needs your username') : kv.error ? 'not working' : 'not yet checked',
    usable: Boolean(kaggleKey) && !kBlock && kv.ok === true && Boolean(kv.username) && kaggleLeft > 1800,
    remaining: { gpu_seconds: round(kaggleLeft) },
    detail: kBlock || (!kaggleKey ? 'Paste your Kaggle API token in Keys as username:token (kaggle.com → Settings → API). GPU sessions with internet need a phone-verified Kaggle account.'
      : kv.ok ? `${round(kaggleLeft / 3600, 1)} GPU hours left this week after a one-hour margin.${kv.username ? '' : ' Add your Kaggle username before the token (username:token) so I can start sessions.'}`
        : kv.error || 'I check it the next time a film needs it.'),
  });

  const hfHealthy = ['healthy', 'rate-limited'].includes(health.huggingface?.status) && Boolean(keys.HF_TOKEN || env.HF_TOKEN);
  const hfLeft = Math.max(0, HF_FREE_DAILY_SECONDS - usage.hf_seconds);
  const hBlock = blocked(FARM_PROVIDERS.hf_zerogpu);
  add('hf_zerogpu', {
    status: !(keys.HF_TOKEN || env.HF_TOKEN) ? 'not set up' : hBlock ? 'blocked' : hfHealthy ? (valid.hf_zerogpu?.space ? 'connected' : 'token works, Space not created yet') : 'not yet checked',
    usable: hfHealthy && !hBlock && Boolean(valid.hf_zerogpu?.space) && hfLeft >= 60,
    remaining: { gpu_seconds: round(hfLeft) },
    detail: hBlock || (hfHealthy ? `${round(hfLeft)} of ${HF_FREE_DAILY_SECONDS} free GPU seconds left today.${valid.hf_zerogpu?.space ? '' : ' The token needs write access so I can create the CHE Space in your account.'}` : 'Paste a Hugging Face token (write access) in Keys.'),
  });

  add('colab', { status: 'not automated', usable: false, remaining: {}, detail: FARM_PROVIDERS.colab.reason });
  return out;
}

// ─── The planner ─────────────────────────────────────────────────────────────

/** The owner's speed targets (2026-10-22): 2 hours in about an hour, 10 minutes in under 5, 5 minutes as fast as possible. */
export function defaultDeadline(targetSeconds) {
  if (targetSeconds <= 300) return 0; // as fast as possible
  return Math.round(targetSeconds / 2);
}

/**
 * The plan for a film of `targetSeconds` by `deadlineSeconds` (0 = as fast as possible): how many shots, which tier
 * each gets, how many new pictures, the segments the renderer runs in parallel, and the ETA, all from the measured
 * rates and the free allowance actually left. Moving clips (tier A) are used only where the budget and the deadline
 * both allow; everything else is tier B (FAST): a still with camera motion, voice, music and sound.
 */
export function planFilm({ targetSeconds, deadlineSeconds = null, providers = [], rates = DEFAULT_RATES, measured = {}, dialogueSeconds = null, uniqueWanted = null, now = Date.now() } = {}) {
  const target = Math.max(20, Math.min(4 * 3600, Math.round(Number(targetSeconds) || 0)));
  const deadline = deadlineSeconds == null ? defaultDeadline(target) : Math.max(0, Number(deadlineSeconds));
  const p = Object.fromEntries(providers.map((x) => [x.id, x]));
  const notes = [];
  const shots = Math.ceil(target / SHOT_SECONDS);
  const speech = dialogueSeconds == null ? target * 0.45 : Number(dialogueSeconds);
  const ai = p.workers_ai;
  if (!ai?.usable) {
    return { ok: false, target_s: target, deadline_s: deadline, said: ai?.status === 'not set up' ? 'I cannot make a film: the Worker has no Workers AI binding for pictures and voices.' : `I cannot start a film today: ${ai?.detail || 'the free picture allowance is used up.'} It resets at midnight UTC.` };
  }
  const gha = p.github_actions;
  if (!gha?.usable) {
    return { ok: false, target_s: target, deadline_s: deadline, said: gha?.status === 'not set up' ? 'I cannot assemble a film: GitHub Actions is not set up (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO).' : `I cannot assemble a film right now: ${gha?.detail || 'GitHub Actions is not reachable.'}` };
  }
  const ttsNeurons = (speech / 60) * NEURONS.tts_per_minute;
  const neuronsLeft = Number(ai.remaining?.neurons || 0);
  const stillsToday = Math.max(0, Math.floor((neuronsLeft - ttsNeurons) / NEURONS.still));
  const wanted = Math.max(1, uniqueWanted == null ? shots : Number(uniqueWanted));
  // Segments run on parallel runners: about a minute of film each, at most the free-plan concurrency.
  const segments = Math.max(1, Math.min(GHA_MAX_PARALLEL, Math.ceil(target / 60)));
  const scriptS = 5 + shots * rates.script_s_per_shot;
  const ttsS = speech / rates.tts_speed;
  const encodeS = rates.runner_startup_s + (target / segments) / rates.encode_speed;
  const finishS = rates.finish_s_per_film_minute * (target / 60) + 5;
  const etaFor = (unique, clips) => {
    const stillsS = unique / rates.images_per_s;
    const clipsS = clips > 0 ? farmClipSeconds(clips, p, rates) : 0;
    return { stills_s: stillsS, clips_s: clipsS, total: scriptS + Math.max(stillsS, ttsS, clipsS) + encodeS + finishS };
  };

  // New pictures: one per shot when the allowance and the deadline allow; otherwise each picture is reframed for up to
  // four shots. Beyond that the film waits for tomorrow's allowance, and the ETA says so.
  let reuse = Math.max(1, Math.ceil(wanted / Math.max(1, stillsToday)));
  let waitS = 0;
  // With a deadline, today's pictures are stretched further (up to twelve framings each) rather than waiting a day.
  const reuseCap = deadline > 0 ? DEADLINE_REUSE : MAX_REUSE;
  if (reuse > MAX_REUSE && reuse <= reuseCap) notes.push(`The free allowance gives about ${stillsToday} new pictures today, so each is framed up to ${reuse} ways to finish on time.`);
  if (reuse > reuseCap) {
    reuse = reuseCap;
    const short = Math.ceil(wanted / MAX_REUSE) - stillsToday;
    const perDay = Math.floor((FILM_NEURON_SHARE - ttsNeurons) / NEURONS.still);
    waitS = secondsUntilReset('day', now) + Math.max(0, Math.ceil(short / Math.max(1, perDay)) - 1) * 86400;
    notes.push(`The free picture allowance gives about ${stillsToday} new pictures today, so the rest wait for the reset at midnight UTC.`);
  }
  let unique = Math.ceil(wanted / reuse);
  while (deadline > 0 && reuse < reuseCap && etaFor(unique, 0).total + waitS > deadline) { reuse += 1; unique = Math.ceil(wanted / reuse); }

  // Moving clips: only key dialogue moments (at most a fifth of the shots), only on connected farm GPUs, and only as
  // many as finish inside the picture stage so they never stretch the ETA.
  const farmOk = Boolean(p.kaggle?.usable || p.hf_zerogpu?.usable);
  let clips = 0;
  if (farmOk && deadline > 0) {
    const budget = farmClipBudget(p, rates);
    const stage = Math.max(etaFor(unique, 0).stills_s, ttsS);
    const window = deadline - (scriptS + encodeS + finishS + waitS);
    clips = Math.max(0, Math.min(Math.floor(shots / 5), budget, clipsWithin(Math.max(stage, window), p, rates)));
  }
  const parts = etaFor(unique, clips);
  const eta = Math.round(parts.total + waitS);
  const meets = deadline === 0 ? true : eta <= deadline;
  const estimated = ['images_per_s', 'tts_speed', 'encode_speed', 'runner_startup_s'].some((k) => !measured[k]);
  if (estimated) notes.push('This uses starting numbers for some stages; I correct the estimate from real measurements as I go.');
  if (!farmOk) notes.push('No free GPU farm is connected, so every shot is a still picture with camera motion, with voices and a simple synthesized score; sound effects need the GPU farm.');
  for (const id of ['kaggle', 'hf_zerogpu']) if (p[id]?.status === 'blocked') notes.push(p[id].detail[0].toUpperCase() + p[id].detail.slice(1) + '.');
  return {
    ok: true, target_s: target, deadline_s: deadline, as_fast_as_possible: deadline === 0,
    shots, tier_a: clips, tier_b: shots - clips, unique_stills: unique, reuse, segments,
    eta_s: eta, meets_deadline: meets, waits_for_reset_s: waitS, estimated,
    parts: { script_s: round(scriptS), stills_s: round(parts.stills_s), voices_s: round(ttsS), clips_s: round(parts.clips_s), assembly_s: round(encodeS), finish_s: round(finishS) },
    neurons: { stills: round(unique * NEURONS.still), voices: round(ttsNeurons), left_today: round(neuronsLeft) },
    providers_used: ['workers_ai', 'github_actions', ...(clips ? ['kaggle', 'hf_zerogpu'].filter((id) => p[id]?.usable) : [])],
    notes,
  };
}

function farmClipBudget(p, rates) {
  let n = 0;
  if (p.kaggle?.usable) n += Math.floor((Number(p.kaggle.remaining?.gpu_seconds || 0) - rates.kaggle_startup_s) / rates.kaggle_clip_s);
  if (p.hf_zerogpu?.usable) n += Math.floor(Number(p.hf_zerogpu.remaining?.gpu_seconds || 0) / rates.hf_clip_s);
  return Math.max(0, n);
}
function clipsWithin(seconds, p, rates) {
  let n = 0;
  if (p.kaggle?.usable) n += Math.max(0, Math.floor((seconds - rates.kaggle_startup_s) / rates.kaggle_clip_s));
  if (p.hf_zerogpu?.usable) n += Math.max(0, Math.floor(seconds / (rates.hf_clip_s * 1.5)));
  return n;
}
function farmClipSeconds(clips, p, rates) {
  if (!clips) return 0;
  const hf = p.hf_zerogpu?.usable ? Math.min(clips, Math.floor(Number(p.hf_zerogpu.remaining?.gpu_seconds || 0) / rates.hf_clip_s)) : 0;
  const rest = clips - hf;
  return Math.max(hf * rates.hf_clip_s * 1.5, rest > 0 ? rates.kaggle_startup_s + rest * rates.kaggle_clip_s : 0);
}

/** "5-minute", "2-hour", "90-second": a length used before "film". */
export function lengthAdjective(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}-second`;
  if (s % 3600 === 0) return `${s / 3600}-hour`;
  return `${Math.round(s / 60)}-minute`;
}

export function spokenDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60); const r = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} minute${r === 1 ? '' : 's'}` : ''}`;
}

/** What CHE says before starting: the real ETA, the mix, and plainly whether the owner's target can be met. */
export function speakPlan(plan, { asked = '' } = {}) {
  if (!plan.ok) return plan.said;
  const length = lengthAdjective(plan.target_s);
  const mix = plan.tier_a
    ? `${plan.tier_a} moving clips for key moments and ${plan.tier_b} stills with camera motion`
    : 'all stills with camera motion';
  const pictures = plan.reuse > 1 ? `, ${plan.unique_stills} new pictures each framed ${plan.reuse} ways` : `, ${plan.unique_stills} new pictures`;
  const eta = spokenDuration(plan.eta_s);
  let lead;
  if (plan.as_fast_as_possible) lead = `A ${length} film takes about ${eta} as fast as free compute allows: ${mix}${pictures}.`;
  else if (plan.meets_deadline) lead = `A ${length} film takes about ${eta}, inside your ${spokenDuration(plan.deadline_s)}: ${mix}${pictures}.`;
  else lead = `I can't make a ${length} film in ${asked || spokenDuration(plan.deadline_s)} with free compute. The fastest I can do is about ${eta}, ${mix}${pictures}.`;
  return [lead, ...plan.notes].join(' ');
}

// ─── The owner's words ───────────────────────────────────────────────────────

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, half: 0.5 };
const num = (w) => (/^\d+(?:\.\d+)?$/.test(w) ? Number(w) : NUM[String(w).toLowerCase()] ?? null);

/** "2-hour", "90 minute", "an hour and a half", "half an hour": seconds, or null. */
export function lengthFrom(text) {
  const t = String(text || '').toLowerCase().replace(/[‐-―]/g, '-');
  if (/\bhalf an hour\b|\bhalf-hour\b/.test(t)) return 1800;
  const m = /\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)[- ](hours?|hrs?|minutes?|mins?|seconds?|secs?)\b(\s+and\s+a\s+half)?/.exec(t);
  if (!m) return null;
  const n = num(m[1]);
  if (n == null) return null;
  const unit = m[2][0] === 'h' ? 3600 : m[2][0] === 'm' ? 60 : 1;
  return Math.round((n + (m[3] ? 0.5 : 0)) * unit);
}

/** The owner's deadline: "in an hour", "within 5 minutes", "in seconds"/"as fast as possible" (0), or null. */
export function deadlineFrom(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:as fast as (?:possible|you can)|asap|in seconds|right now|immediately)\b/.test(t)) return { seconds: 0, words: /in seconds/.test(t) ? 'seconds' : 'no time at all' };
  const m = /\b(?:in|within|under|by|inside)\s+(?:about\s+|less than\s+)?((?:\d+(?:\.\d+)?|a|an|one|two|three|five|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half)[- ]?(?:an?\s+)?(?:hours?|hrs?|minutes?|mins?|seconds?|secs?))\b/.exec(t);
  if (!m) return null;
  const s = lengthFrom(m[1].replace(/^half\s+an?\s+/, 'half an ')) ?? (/^half/.test(m[1]) ? 1800 : null);
  return s == null ? null : { seconds: s, words: m[1] };
}

const FILM_WORD = /\b(?:movie|film|feature)\b/i;
/**
 * The owner's Film Studio words, or null. Strict on purpose: "what's a good movie" and "watch a film" are not orders.
 * Kinds: make, plan (ETA only), status, remake, cancel, farm, open.
 */
export function filmIntent(message = '') {
  const t = String(message || '').trim().replace(/^\W*(?:hey[, ]*)?(?:che|chay|chey|shay)\b[,!:]?\s*/i, '').replace(/[’]/g, "'");
  if (!t) return null;
  if (/^(?:open|show|go to)\s+(?:the\s+|my\s+)?film studio\b/i.test(t)) return { kind: 'open' };
  if (/\b(?:render farm|gpu farm|free gpus?|gpu (?:quota|status))\b/i.test(t) && /\b(?:status|how|what|which|show|check|left|quota)\b/i.test(t)) return { kind: 'farm' };
  const shot = /\b(?:remake|redo|regenerate|re-?render)\s+shot\s+(?:number\s+)?(\d{1,5})\b/i.exec(t);
  if (shot) return { kind: 'remake', shot: Number(shot[1]) };
  if (!FILM_WORD.test(t)) return null;
  if (/\b(?:cancel|stop|pause|halt)\b.*\b(?:movie|film)\b/i.test(t)) return { kind: /\bpause\b/i.test(t) ? 'pause' : 'cancel' };
  if (/\b(?:resume|continue|carry on with|pick up)\b.*\b(?:movie|film)\b/i.test(t)) return { kind: 'resume' };
  if (/\b(?:how(?:'s| is| far)|status|progress|where(?:'s| is)|is my|done yet|ready yet|finished)\b/i.test(t) && /\b(?:my|the)\s+(?:\w+\s+)?(?:movie|film)\b/i.test(t) && !/\b(?:make|create|produce|direct)\b/i.test(t)) return { kind: 'status' };
  const seconds = lengthFrom(t);
  const deadline = deadlineFrom(t.replace(/\b\d+(?:\.\d+)?[- ](?:hours?|minutes?)\s+(?:movie|film)\b/i, ''));
  if (/\bhow long\b|\bhow fast\b|\bcould you\b.*\bin\b|\bcan you make\b.*\bin\b/i.test(t) && seconds && !/\b(?:please|now|go ahead)\b/i.test(t)) return { kind: 'plan', seconds, deadline };
  const make = /\b(?:make|create|produce|direct|shoot|render|generate|build)\s+(?:me\s+|us\s+)?(?:a|an|the|my)?\s*(?:[\w-]+\s+){0,4}(?:movie|film|feature)\b/i.test(t);
  if (!make) return null;
  const about = /\b(?:about|on|of|starring|featuring|where|in which)\s+(.{3,300}?)[.!?]*$/i.exec(t);
  const topic = (about ? about[1] : '').replace(/\b(?:in|within|under|by)\s+(?:about\s+)?(?:\d+|an?|one|half)\b.*$/i, '').replace(/\s+as fast as (?:possible|you can).*$/i, '').trim();
  return { kind: 'make', seconds: seconds || 300, deadline, topic: topic.slice(0, 300) };
}

// ─── The screenplay ──────────────────────────────────────────────────────────

function firstJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth += 1; else if (c === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; } } }
  }
  return null;
}
const clean = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Checks an outline from the writer; returns the cleaned outline or a reason it is unusable. */
export function validOutline(raw, { shots }) {
  const o = raw && typeof raw === 'object' ? raw : null;
  if (!o) return { error: 'the writer did not return a screenplay outline' };
  const characters = (Array.isArray(o.characters) ? o.characters : []).slice(0, 12).map((c, i) => ({
    id: clean(c.id || `c${i + 1}`, 24).toLowerCase().replace(/[^a-z0-9_]/g, '') || `c${i + 1}`,
    name: clean(c.name, 60), look: clean(c.look || c.appearance || c.description, 400), voice: clean(c.voice, 60),
    seed: Math.abs(hash(`${c.name}|${c.look}`)) % 2 ** 31,
  })).filter((c) => c.name && c.look);
  const scenes = (Array.isArray(o.scenes) ? o.scenes : []).slice(0, 400).map((s, i) => ({
    id: i + 1, setting: clean(s.setting || s.location, 300), summary: clean(s.summary, 500), shots: Math.max(1, Math.min(60, Math.round(Number(s.shots) || 1))),
  })).filter((s) => s.setting && s.summary);
  if (!clean(o.title)) return { error: 'the outline has no title' };
  if (!scenes.length) return { error: 'the outline has no usable scenes' };
  // The scene shot counts are scaled to the planned total so the film lands on its length.
  const total = scenes.reduce((n, s) => n + s.shots, 0);
  let left = shots;
  scenes.forEach((s, i) => { s.shots = i === scenes.length - 1 ? Math.max(1, left) : Math.max(1, Math.round((s.shots / total) * shots)); left -= s.shots; });
  return { title: clean(o.title, 120), logline: clean(o.logline, 400), characters, scenes };
}

/** Checks one scene's shots from the writer. Lines name only known characters; nothing else is invented here. */
export function validSceneShots(raw, scene, characters) {
  const known = new Set(characters.map((c) => c.id));
  const byName = new Map(characters.map((c) => [c.name.toLowerCase(), c.id]));
  const list = (Array.isArray(raw?.shots) ? raw.shots : []).slice(0, scene.shots);
  const shots = list.map((s) => ({
    description: clean(s.description || s.visual, 500),
    camera: clean(s.camera, 60) || 'slow push in',
    dialogue: (Array.isArray(s.dialogue) ? s.dialogue : []).slice(0, 4).map((d) => {
      const id = clean(d.character, 60).toLowerCase();
      return { character: known.has(id) ? id : byName.get(id) || '', line: clean(d.line, 300) };
    }).filter((d) => d.character && d.line),
    sound: clean(s.sound || s.sfx, 120),
    characters: (Array.isArray(s.characters) ? s.characters : []).map((c) => { const id = clean(c, 60).toLowerCase(); return known.has(id) ? id : byName.get(id) || ''; }).filter(Boolean).slice(0, 4),
  })).filter((s) => s.description);
  if (!shots.length) return { error: `scene ${scene.id} came back with no usable shots` };
  return { shots };
}

export function outlineMessages({ topic, targetSeconds, shots }) {
  return [
    { role: 'system', content: 'You are a screenwriter. Reply with JSON only, no prose. Original work only: no real people, no copyrighted characters.' },
    { role: 'user', content: `Write the outline of an original ${spokenDuration(targetSeconds)} film about: ${topic}. It has about ${shots} shots of about 6 seconds each. JSON: {"title":"","logline":"","characters":[{"id":"short_id","name":"","look":"fixed visual description: age, face, hair, clothes","voice":"male/female, age, tone"}],"scenes":[{"setting":"place, time of day, look","summary":"what happens","shots":number}]}. Use ${Math.max(2, Math.round(shots / 12))} scenes and at most 6 characters.` },
  ];
}

export function sceneMessages(outline, scene) {
  const cast = outline.characters.map((c) => `${c.id}: ${c.name}, ${c.look}`).join('\n');
  return [
    { role: 'system', content: 'You are a screenwriter writing a shot list. Reply with JSON only, no prose.' },
    { role: 'user', content: `Film: ${outline.title}. ${outline.logline}\nCast:\n${cast}\nScene ${scene.id} of ${outline.scenes.length}: ${scene.setting}. ${scene.summary}\nWrite exactly ${scene.shots} shots. JSON: {"shots":[{"description":"what the camera sees, concrete and visual","camera":"slow push in|pull out|pan left|pan right|tilt up|static","characters":["id"],"dialogue":[{"character":"id","line":"short spoken line"}],"sound":"ambient sound or effect"}]}. Keep lines short; about half the shots have dialogue.` },
  ];
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export class FilmStore {
  constructor(storage) { this.storage = storage; }
  async index() { return (await get(this.storage, FILM_INDEX_KEY, [])) || []; }
  async film(id) { return id ? get(this.storage, `film:${id}`, null) : null; }
  async latest() { const i = await this.index(); return i.length ? this.film(i[0].id) : null; }
  /**
   * Saves a film. Background passes never undo the owner's pause or stop: unless `force`, a stored paused/cancelled
   * state wins over the pass's copy.
   */
  async save(film, { force = false } = {}) {
    if (!force) {
      const stored = await get(this.storage, `film:${film.id}`, null);
      if (stored && ['paused', 'cancelled'].includes(stored.state) && !['paused', 'cancelled'].includes(film.state)) film.state = stored.state;
    }
    film.updated_at = new Date().toISOString();
    await this.storage.put(`film:${film.id}`, film);
    const idx = (await this.index()).filter((f) => f.id !== film.id);
    idx.unshift({ id: film.id, title: film.title || film.topic, state: film.state, created_at: film.created_at });
    await this.storage.put(FILM_INDEX_KEY, idx.slice(0, 50));
    return film;
  }
  async shots(id, count) {
    const out = [];
    for (let k = 0; k * SHOTS_PER_CHUNK < count; k += 1) out.push(...((await get(this.storage, `film:${id}:shots:${k}`, [])) || []));
    return out;
  }
  async putShots(id, shots) {
    for (let k = 0; k * SHOTS_PER_CHUNK < shots.length; k += 1) await this.storage.put(`film:${id}:shots:${k}`, shots.slice(k * SHOTS_PER_CHUNK, (k + 1) * SHOTS_PER_CHUNK));
  }
  async updateShot(id, n, patch) {
    const k = Math.floor((n - 1) / SHOTS_PER_CHUNK);
    const chunk = (await get(this.storage, `film:${id}:shots:${k}`, [])) || [];
    const i = chunk.findIndex((s) => s.n === n);
    if (i < 0) return null;
    chunk[i] = { ...chunk[i], ...patch };
    await this.storage.put(`film:${id}:shots:${k}`, chunk);
    return chunk[i];
  }
}

export function newFilm({ topic, targetSeconds, deadline, plan, now = Date.now() }) {
  return {
    id: 'film_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16), topic: clean(topic, 300), title: '',
    target_s: plan.target_s, deadline_s: plan.deadline_s, deadline_words: deadline?.words || '', plan,
    state: 'scripting', scene_next: 0, shot_count: 0, outline: null,
    created_at: new Date(now).toISOString(), started_ms: now, eta_at: new Date(now + plan.eta_s * 1000).toISOString(),
    stats: { stills_made: 0, stills_failed: 0, lines_voiced: 0, clips_made: 0, retries: 0 },
    errors: [], result: null,
  };
}

/** Turns the written scenes into numbered shots with their tier, picture source (new or reframed) and camera move. */
export function shotList(outline, sceneShots, plan) {
  const shots = [];
  for (const scene of outline.scenes) for (const s of sceneShots[scene.id] || []) shots.push({ ...s, scene: scene.id, setting: scene.setting });
  const moves = ['push_in', 'pull_out', 'pan_left', 'pan_right', 'tilt_up', 'push_in'];
  const dialogueRank = shots.map((s, i) => ({ i, w: s.dialogue.length })).sort((a, b) => b.w - a.w || a.i - b.i);
  const tierA = new Set(dialogueRank.slice(0, plan.tier_a || 0).filter((x) => x.w > 0).map((x) => x.i));
  let lastStill = 0;
  return shots.map((s, i) => {
    const n = i + 1;
    // A new picture every `reuse` shots inside a scene; between, the shot reframes the scene's last picture.
    const fresh = i === 0 || s.scene !== shots[i - 1].scene || (n - lastStill) >= plan.reuse || tierA.has(i);
    if (fresh) lastStill = n;
    return {
      n, scene: s.scene, setting: s.setting, description: s.description, characters: s.characters, sound: s.sound,
      camera: s.camera, motion: cameraMove(s.camera) || moves[i % moves.length],
      dialogue: s.dialogue.map((d) => ({ ...d, audio_key: '', audio_s: 0 })),
      tier: tierA.has(i) ? 'A' : 'B', still_of: fresh ? n : lastStill, still_key: '', clip_key: '',
      status: 'planned', attempts: 0, check: null, seconds: SHOT_SECONDS,
    };
  });
}

function cameraMove(text) {
  const t = String(text || '').toLowerCase();
  if (/pull|zoom out|back/.test(t)) return 'pull_out';
  if (/pan left/.test(t)) return 'pan_left';
  if (/pan right|pan/.test(t)) return 'pan_right';
  if (/tilt/.test(t)) return 'tilt_up';
  if (/static|still|hold/.test(t)) return 'drift';
  if (/push|zoom in|dolly in|in\b/.test(t)) return 'push_in';
  return '';
}

/** The prompt for a shot's picture: the scene's look, the fixed character sheets, the shot, and lessons learned. */
export function stillPrompt(shot, outline, lessons = []) {
  const cast = (shot.characters || []).map((id) => outline.characters.find((c) => c.id === id)).filter(Boolean).map((c) => `${c.name}: ${c.look}`).join('; ');
  const extra = lessons.filter((l) => l.add).slice(0, 3).map((l) => l.add).join(', ');
  return clean(`Cinematic film still, 16:9, photorealistic. ${shot.setting}. ${shot.description}.${cast ? ` Characters: ${cast}.` : ''} Consistent lighting, natural faces and hands${extra ? `, ${extra}` : ''}. No text, no watermark.`, 2000);
}

export function seedFor(shot, outline) {
  const lead = outline.characters.find((c) => c.id === shot.characters?.[0]);
  return lead ? lead.seed : Math.abs(hash(`${outline.title}|scene${shot.scene}`)) % 2 ** 31;
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }

// ─── Checks ──────────────────────────────────────────────────────────────────

/** JPEG/PNG size from the file itself, or null. */
export function imageSize(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { type: 'png', width: (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0, height: (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0 };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}

/**
 * A picture passes when it is a real image of the expected size with enough detail (a blank or flat frame compresses
 * to almost nothing). An optional vision check, when the owner turned it on, must also say it matches the shot.
 */
export function checkStill(bytes, { minBytes = 25_000, vision = null } = {}) {
  const size = imageSize(bytes);
  if (!size) return { ok: false, reason: 'not a real image' };
  if (size.width < 512 || size.height < 512) return { ok: false, reason: `too small (${size.width}x${size.height})` };
  if (bytes.length < minBytes) return { ok: false, reason: 'almost no detail (a blank or flat frame)' };
  if (vision && vision.ok === false) return { ok: false, reason: `the vision check said: ${clean(vision.reason, 140)}` };
  return { ok: true, width: size.width, height: size.height, bytes: bytes.length, vision: vision ? 'passed' : 'off' };
}

/** Seconds of audio in an MP3, counted frame by frame (no decoder needed). */
export function mp3Seconds(bytes) {
  if (!(bytes instanceof Uint8Array)) return 0;
  let i = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) i = 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  let seconds = 0; let frames = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) { i += 1; continue; }
    const ver = (bytes[i + 1] >> 3) & 3; const layer = (bytes[i + 1] >> 1) & 3;
    const bri = bytes[i + 2] >> 4; const sri = (bytes[i + 2] >> 2) & 3; const pad = (bytes[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) { i += 1; continue; }
    const rate = RATES[ver][sri]; const kbps = (ver === 3 ? BR1 : BR2)[bri];
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor((samples / 8) * kbps * 1000 / rate) + pad;
    if (len < 4) { i += 1; continue; }
    seconds += samples / rate; frames += 1; i += len;
  }
  return frames ? round(seconds, 3) : 0;
}

/** Remembers what made pictures fail so later prompts improve (kept small; read by stillPrompt). */
export async function learnFromCheck(storage, check) {
  const lessons = (await get(storage, FILM_LESSONS_KEY, [])) || [];
  const reason = String(check?.reason || '');
  const rule = /blank|flat|detail/.test(reason) ? { id: 'detail', add: 'rich detail, clear subject, well lit' }
    : /hands|face/.test(reason) ? { id: 'anatomy', add: 'hands out of frame, faces clearly visible' } : null;
  if (!rule) return lessons;
  const found = lessons.find((l) => l.id === rule.id);
  if (found) found.count += 1; else lessons.push({ ...rule, count: 1 });
  lessons.sort((a, b) => b.count - a.count);
  await storage.put(FILM_LESSONS_KEY, lessons.slice(0, 10));
  return lessons;
}

// ─── Assembly order ──────────────────────────────────────────────────────────

/**
 * The segments the renderer encodes in parallel, in film order. Only verified shots go in; a shot that never passed
 * is left out and listed, never shipped. Each shot's length fits its spoken lines.
 */
export function assemblyPlan(film, shots, { segments = film.plan?.segments || 1 } = {}) {
  const ready = shots.filter((s) => s.status === 'verified').sort((a, b) => a.n - b.n);
  const missing = shots.filter((s) => s.status !== 'verified').map((s) => s.n);
  const timed = ready.map((s) => {
    const speech = s.dialogue.reduce((t, d) => t + (d.audio_s || 0), 0) + 0.35 * s.dialogue.length;
    return { ...s, seconds: round(Math.max(s.tier === 'A' ? CLIP_SECONDS : SHOT_SECONDS, speech + 0.6), 2) };
  });
  const total = timed.reduce((t, s) => t + s.seconds, 0);
  const per = total / Math.max(1, Math.min(segments, timed.length));
  const out = []; let cur = []; let acc = 0;
  for (const s of timed) {
    cur.push(s); acc += s.seconds;
    if (acc >= per && out.length < segments - 1) { out.push(cur); cur = []; acc = 0; }
  }
  if (cur.length) out.push(cur);
  return { segments: out.map((list, i) => ({ index: i, shots: list.map((s) => s.n), seconds: round(list.reduce((t, s) => t + s.seconds, 0), 2) })), timed, total_s: round(total, 2), missing };
}

/** The spec one runner renders: pictures or clips with their moves, voice lines at their times, sound and music. */
export function segmentSpec(film, segment, timed) {
  const byN = new Map(timed.map((s) => [s.n, s]));
  const stillKey = (s) => byN.get(s.still_of)?.still_key || s.still_key;
  let at = 0;
  const shots = []; const audio = [];
  for (const n of segment.shots) {
    const s = byN.get(n);
    shots.push({ n, seconds: s.seconds, image: s.clip_key ? '' : stillKey(s), clip: s.clip_key || '', motion: s.motion, variant: (n - s.still_of) % 4, caption: s.dialogue.map((d) => d.line).join(' ') });
    let t = at + 0.3;
    for (const d of s.dialogue) { if (d.audio_key) { audio.push({ key: d.audio_key, at: round(t, 3), gain: 1 }); t += d.audio_s + 0.35; } }
    at += s.seconds;
  }
  const assets = [...new Set([...shots.map((s) => s.image || s.clip), ...audio.map((a) => a.key)].filter(Boolean))];
  return { film_id: film.id, segment: segment.index, width: 1280, height: 720, fps: 24, seconds: round(at, 3), shots, audio, music: { kind: 'pad', mood: film.outline?.logline ? 'cinematic' : 'calm', gain: 0.18 }, captions: true, assets };
}

// ─── What CHE says ───────────────────────────────────────────────────────────

export function filmProgress(film, shots = [], now = Date.now()) {
  const verified = shots.filter((s) => s.status === 'verified').length;
  const failed = shots.filter((s) => s.status === 'failed').length;
  const elapsed = Math.round((now - Number(film.started_ms || now)) / 1000);
  const eta = film.plan?.eta_s || 0;
  return { state: film.state, shots_total: shots.length || film.shot_count, shots_verified: verified, shots_failed: failed, elapsed_s: elapsed, eta_s: eta, remaining_s: Math.max(0, eta - elapsed) };
}

export function speakStatus(film, shots = [], now = Date.now()) {
  if (!film) return 'You have no film in the studio yet. Say "make me a 10-minute movie about" and a subject.';
  const p = filmProgress(film, shots, now);
  const name = film.title ? `"${film.title}"` : `your film about ${film.topic}`;
  const time = `${spokenDuration(p.elapsed_s)} in, against an estimate of ${spokenDuration(p.eta_s)}`;
  switch (film.state) {
    case 'scripting': return `${name} is being written: scene ${film.scene_next} of ${film.outline?.scenes?.length || 'the outline'}. ${time}.`;
    case 'making': return `${name}: ${p.shots_verified} of ${p.shots_total} shots done${p.shots_failed ? `, ${p.shots_failed} failed after ${MAX_ATTEMPTS} tries` : ''}. ${time}.${film.waiting ? ` ${film.waiting}` : ''}`;
    case 'assembling': return `${name} is being assembled on ${film.plan?.segments || 1} GitHub runners. ${time}.`;
    case 'verifying': return `${name} is uploaded and I am checking the file. ${time}.`;
    case 'done': return `${name} is done: ${spokenDuration(film.result?.seconds || 0)}, checked from the file itself, in your media library.${film.result?.missing?.length ? ` ${film.result.missing.length} shots never passed their checks and were left out.` : ''} It took ${spokenDuration((Date.parse(film.result?.at || '') - film.started_ms) / 1000)}.`;
    case 'paused': return `${name} is paused at ${p.shots_verified} of ${p.shots_total} shots. Say "resume my movie" to continue; nothing is lost.`;
    case 'cancelled': return `${name} was stopped. Its finished shots are kept.`;
    case 'failed': return `${name} could not be finished: ${film.errors?.slice(-1)[0] || 'an unknown error'}. No film was made.`;
    default: return `${name}: ${film.state}.`;
  }
}

export function speakFarm(providers) {
  const lines = providers.map((p) => `${p.name}: ${p.status}. ${p.detail}`);
  return `My free render farm: ${lines.join(' ')} Your own computer is never part of it.`;
}

export const _internals = { SHOT_SECONDS, CLIP_SECONDS, MAX_REUSE, DEADLINE_REUSE, MAX_ATTEMPTS, SHOTS_PER_CHUNK, firstJson, isoWeek };
