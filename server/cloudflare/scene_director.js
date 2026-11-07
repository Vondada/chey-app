// CHE Scene Director, stage 1 (owner, 2026-11-06): "CHE, make Nova walk into my office, sit beside me, and start
// talking." Then: "Change her outfit, make the camera circle around us, slow down the last five seconds, and add music."
// CHE performs those edits without the owner rebuilding anything.
//
// A scene is an editable project: a versioned spec (actors from the real crew GLBs, their timeline of clips, the
// office set, the camera, timing and sound) with undo and redo. Rendering is real: .github/workflows/che-scene-render.yml
// draws the spec in Blender (tools/che_scene_render.py) on free GitHub runners and finishes it with ffmpeg and the free
// Piper voice (tools/che_scene_finish.py). An edit that changes only timing, words or music reuses the frames of the
// last render, so it never re-renders 3D. A video counts as ready only after CHE has read the MP4 itself.
//
// Honest limits, said when asked for: only the eight crew members with a 3D model can act (Orion and Vale have none
// yet); the crew's clips are idle, walk, run, wave, sit, stand, talk, think, celebrate, nod and shake, so "dance" is
// refused; the crew have no face shapes, so a talking character moves but its lips do not follow the words.

import { downloadArchive, githubHeaders, mp4Facts, readJson, refusalOf, zipEntry } from './github_video_renderer.js';
import { mediaStore } from './che_media_store.js';
import { saveSceneVideo } from './media.js';

export const DIRECTOR_KEY = 'director:projects';
export const DIRECTOR_LAST = 'director:last';
export const WORKFLOW = 'che-scene-render.yml';
const REPO = 'Vondada/chey-app';
const MAX_PROJECTS = 20;
const MAX_VERSIONS = 40;

const RECENT_MS = 6 * 3600_000; // edits like "change her outfit" go to the scene the owner worked on in the last six hours

export const CREW_MODELS = Object.freeze(['che', 'nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris', 'orion', 'vale']);
// Crew named in a request who have no rigged model yet (none today; Orion and Vale have theirs).
const NO_MODEL = Object.freeze([]);
const NAME = { che: 'CHE', nova: 'Nova', atlas: 'Atlas', mira: 'Mira', knox: 'Knox', sage: 'Sage', lyra: 'Lyra', iris: 'Iris', orion: 'Orion', vale: 'Vale' };
const FEMALE = new Set(['che', 'nova', 'mira', 'sage', 'lyra', 'iris', 'vale']);
const CLIPS = Object.freeze({ wave: 2, nod: 1.5, think: 2.5, celebrate: 2, shake: 1.5 });
const NOT_YET = Object.freeze({ dance: 'the crew have no dance animation yet', jump: 'the crew have no jump animation yet', hug: 'two-person animations are not built yet', kiss: 'two-person animations are not built yet', fight: 'two-person animations are not built yet' });

// The office set (tools/che_scene_render.py builds it): the owner's chair and the guest chair side by side, and the
// doorway on the left wall. Positions are in metres; headings in degrees (0 faces the camera side of the room).
export const SEATS = Object.freeze({ owner: [0.55, 0.3, 0], guest: [-0.55, 0.3, 0] });
const DOOR = [-4.4, 0.4, -90];
const STAND = [-1.0, -0.4];
// Checked in renders (2026-11-06): from inside the room on the right, the doorway, the walk and both chairs are in shot.
const DEFAULT_CAMERA = Object.freeze({ move: 'static', target: [-1.3, 0.4, 0.85], distance: 6.0, height: 1.6, angle: 26 });
const COLORS = Object.freeze({ red: '#c0392b', blue: '#2e5fa8', navy: '#1f2f4d', green: '#2e8b57', black: '#151515', white: '#f2f2f2', purple: '#7d3c98', pink: '#e37aa6', orange: '#e67e22', yellow: '#e2b33c', gold: '#c9a227', grey: '#7f8c8d', gray: '#7f8c8d', brown: '#6e4b32', teal: '#1f8a8a', lavender: '#b9a6e3' });
const CYCLE = ['#151515', '#c0392b', '#f2f2f2', '#2e5fa8', '#2e8b57', '#7d3c98'];
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20 };
const GREETING = {
  che: 'Hey, I am here. Tell me what we are making today.',
  nova: 'Hey! I made it. So, what are we working on today?',
  atlas: 'Morning. The build is green, so what do you need from me?',
  mira: 'Hi! I have the message ready. Want to hear it?',
  knox: 'All clear out there. What is the plan?',
  sage: 'I found something interesting. Got a minute?',
  lyra: 'I just finished a new track. You have to hear this.',
  iris: 'The numbers are in, and they look good.',
};

const clean = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
/** How long a spoken line needs: about 2.5 words a second, plus room to start and finish. */
const talkSeconds = (line) => round(Math.max(3, String(line).split(/\s+/).length / 2.5 + 1.2), 2);
const num = (w) => (/^\d+$/.test(w) ? Number(w) : NUMBERS[String(w).toLowerCase()] ?? null);

// ─── Words → a scene ─────────────────────────────────────────────────────────

/** The crew member a request names, or null. */
export function actorIn(text) {
  const t = String(text || '').toLowerCase().replace(/^\s*(?:hey\s+)?(?:che|chay|chey)\s*[,:!]\s*/, '');
  return [...CREW_MODELS, ...NO_MODEL].find((id) => new RegExp(`\\b${id}\\b`).test(t)) || null;
}

/**
 * "make Nova walk into my office, sit beside me, and start talking" → { actor, steps, unsupported }.
 * Steps keep the owner's order; an action the crew cannot do is listed, never guessed.
 */
export function stepsFrom(text) {
  const quotes = [];
  const masked = String(text || '').replace(/["“]([^"”]+)["”]/g, (_, q) => { quotes.push(clean(q, 240)); return ` QUOTE${quotes.length - 1} `; });
  const clauses = masked.toLowerCase().split(/,|;|\band then\b|\bthen\b|\band\b/).map((c) => c.trim()).filter(Boolean);
  const steps = []; const unsupported = [];
  for (const c of clauses) {
    const q = c.match(/quote(\d+)/);
    const refused = Object.keys(NOT_YET).find((k) => new RegExp(`\\b${k}(?:s|ing)?\\b`).test(c));
    if (refused) { unsupported.push(`${refused} (${NOT_YET[refused]})`); continue; }
    if (/\b(?:walk|walks|walking|come|comes|coming|enter|enters|step|steps)\b/.test(c)) { steps.push({ action: 'walk' }); continue; }
    if (/\b(?:sit|sits|sitting|seat|seated)\b/.test(c)) { steps.push({ action: 'sit' }); continue; }
    if (/\b(?:talk|talks|talking|speak|speaks|speaking|say|says|saying|chat|chatting|greet|greets)\b/.test(c)) { steps.push({ action: 'talk', line: q ? quotes[Number(q[1])] : '' }); continue; }
    const clip = Object.keys(CLIPS).find((k) => new RegExp(`\\b${k}(?:s|ing)?\\b`).test(c));
    if (clip) { steps.push({ action: clip }); continue; }
    if (q && steps.length && steps.at(-1).action === 'talk' && !steps.at(-1).line) { steps.at(-1).line = quotes[Number(q[1])]; continue; }
  }
  return { steps, unsupported };
}

/** Is this a request to direct a crew scene? (Named crew member and a body action, not a question about them.) */
export function directorCreateIntent(text) {
  const t = String(text || '');
  if (!actorIn(t) || /\?\s*$/.test(t) || /\b(?:who|what|why|how|when|where)\b.{0,40}\?/i.test(t)) return false;
  if (!/\b(?:make|have|let|get|show|create|film|render)\b/i.test(t)) return false;
  return stepsFrom(t).steps.some((s) => s.action === 'walk' || s.action === 'sit') && !/\b(?:task|job|assign|research|code|build the|deploy)\b/i.test(t);
}

/** The first version of a scene project's spec, or { error }. */
export function sceneFromWords(text) {
  const id = actorIn(text);
  if (!id) return { error: 'Name a crew member to direct: ' + CREW_MODELS.map((x) => NAME[x]).join(', ') + '.' };
  if (NO_MODEL.includes(id)) return { error: `${NAME[id]} has no 3D model yet, so ${FEMALE.has(id) ? 'she' : 'he'} cannot act in a scene. The crew who can: ${CREW_MODELS.map((x) => NAME[x]).join(', ')}.` };
  const { steps, unsupported } = stepsFrom(text);
  if (unsupported.length) return { error: `I can't do that part yet: ${unsupported.join('; ')}. The crew can walk, sit, talk, wave, nod, think, celebrate and shake their heads.` };
  const willSit = steps.some((s) => s.action === 'sit');
  const timeline = [];
  let t = 0; let at = DOOR.slice(0, 2);
  for (const s of steps) {
    if (s.action === 'walk') {
      const to = willSit ? SEATS.guest.slice(0, 2) : STAND;
      const len = round(Math.max(2.5, Math.hypot(to[0] - at[0], to[1] - at[1]) / 1.1), 2);
      timeline.push({ actor: id, action: 'walk', to, t0: t, t1: round(t + len, 2) });
      at = to; t = round(t + len, 2);
    } else if (s.action === 'sit') {
      timeline.push({ actor: id, action: 'sit', seat: 'guest', t0: t, t1: round(t + 1.5, 2) });
      t = round(t + 1.5, 2);
    } else if (s.action === 'talk') {
      const line = clean(s.line || GREETING[id], 240);
      const len = talkSeconds(line);
      timeline.push({ actor: id, action: 'talk', line, t0: t, t1: round(t + len, 2) });
      t = round(t + len, 2);
    } else {
      timeline.push({ actor: id, action: s.action, t0: t, t1: round(t + CLIPS[s.action], 2) });
      t = round(t + CLIPS[s.action], 2);
    }
  }
  if (!timeline.length) return { error: `Tell me what ${NAME[id]} should do: walk in, sit, talk, wave, nod, think or celebrate.` };
  return {
    spec: {
      v: 1, title: clean(`${NAME[id]} in the office`, 80), fps: 24, seconds: round(t + 0.5, 2), width: 540, height: 960, samples: 8, denoise: true,
      set: { kind: 'office', light: 'warm' }, seats: { ...SEATS },
      actors: [{ id, model: `assets/characters/crew/${id}.glb`, start: DOOR.slice(), cloth: null }],
      timeline, camera: { ...DEFAULT_CAMERA }, time_remap: [], audio: { music: null },
    },
  };
}

// ─── Edits ───────────────────────────────────────────────────────────────────

const PRONOUN = /\b(?:her|his|him|their|she|he|they|them)\b/i;
/** Is this an edit of the scene the owner just made? Only checked while a scene is recent. */
export function directorEditIntent(text) {
  const t = String(text || '').toLowerCase();
  if (/^\s*(?:undo|redo)\b|^\s*(?:undo|go back)(?: that| the last)?(?: change| edit)?\s*[.!]?$/.test(t)) return true;
  if (/\b(?:is|how(?:'s| is)) (?:my |the )?scene\b|\bscene (?:ready|done|status)\b|\brender (?:it|the scene|my scene) again\b/.test(t)) return true;
  return [/\bmove (?:her|him|them)\b|\bmake (?:her|him|them) (?:bigger|taller|larger|smaller|shorter)\b/, /\b(?:relight|lighting)\b|\bmake it (?:sunset|night|morning|golden hour|evening)\b/, /\boutfit\b|\bclothes\b|\b(?:put|dress) (?:her|him|them) in\b/, /\bcamera\b|\bcircle around\b|\borbit\b/, /\bslow(?:er)?(?: it)? down\b|\bslow[- ]?mo(?:tion)?\b|\bspeed (?:it |that )?up\b|\bfaster\b/, /\bmusic\b|\bsoundtrack\b/, /\b(?:make|have|let) (?:her|him|them) say\b/].some((r) => r.test(t)) && (PRONOUN.test(t) || /\b(?:scene|camera|music|slow|speed|relight|lighting|sunset|night|morning|evening|golden hour)\b/.test(t));
}

function threeDKey(spec) {
  const { time_remap, audio, timeline, ...rest } = spec;
  return JSON.stringify({ ...rest, job: undefined, version: undefined, timeline: timeline.map(({ line, ...s }) => s) });
}

/** Applies every edit in one sentence. Returns { spec, said: [...], unknown: [...] }; never changes what it did not say. */
export function applyEdits(prev, text, { actor: chosen = null } = {}) {
  const spec = structuredClone(prev);
  const t = String(text || '').toLowerCase();
  const said = [];
  // The actor touched in the app's live preview, when one is selected; otherwise the scene's lead.
  const actor = spec.actors.find((a) => a.id === chosen) || spec.actors[0];
  const who = NAME[actor.id] || actor.id;
  const pron = FEMALE.has(actor.id) ? 'her' : 'his';

  // Touch edits from the live preview (tools/che_scene_layout.py draws them): move in half-metre steps, resize by 15%.
  const move = t.match(/\bmove (?:her|him|them)(?: a (?:bit|little))? (left|right|closer|forward|back(?:ward)?|further away)\b/);
  if (move) {
    const [dx, dy] = { left: [-0.5, 0], right: [0.5, 0], closer: [0, -0.5], forward: [0, -0.5], back: [0, 0.5], backward: [0, 0.5], 'further away': [0, 0.5] }[move[1]];
    const was = actor.offset || [0, 0];
    actor.offset = [round(Math.max(-1.5, Math.min(1.5, was[0] + dx)), 2), round(Math.max(-1.5, Math.min(1.5, was[1] + dy)), 2)];
    said.push(`${who} moves ${move[1]}${actor.offset[0] === was[0] && actor.offset[1] === was[1] ? ' (already as far as the room allows)' : ''}`);
  }
  const size = t.match(/\bmake (?:her|him|them) (bigger|taller|larger|smaller|shorter)\b/);
  if (size) {
    const grow = /bigger|taller|larger/.test(size[1]);
    actor.scale = round(Math.max(0.6, Math.min(1.6, (actor.scale || 1) * (grow ? 1.15 : 1 / 1.15))), 3);
    said.push(`${who} is ${grow ? 'bigger' : 'smaller'} (${Math.round(actor.scale * 100)}% of ${pron} usual height)`);
  }

  if (/\boutfit\b|\bclothes\b|\b(?:put|dress) (?:her|him|them) in\b/.test(t)) {
    const word = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`).test(t));
    const next = word ? COLORS[word] : CYCLE.find((c) => c !== actor.cloth) || CYCLE[0];
    actor.cloth = next;
    const name = word || Object.entries(COLORS).find(([, v]) => v === next)?.[0] || next;
    said.push(`${who}'s outfit is now ${name}${word ? '' : ' (you did not name a colour, so I picked one; say a colour to change it)'}`);
  }
  if (/\bcamera\b.*\b(?:circle|orbit|around|spin)\b|\bcircle around\b|\borbit\b/.test(t)) {
    const sit = spec.timeline.find((s) => s.action === 'sit');
    spec.camera = { move: 'orbit', target: [0, 0.4, 0.9], distance: 3.0, height: 1.45, angle: -25, degrees: 360, t0: sit ? sit.t1 : 0, t1: spec.seconds, from: { ...DEFAULT_CAMERA } };
    said.push(`the camera circles around you both${sit ? ' once she sits' : ''}`.replace('she', FEMALE.has(actor.id) ? 'she' : 'he'));
  } else if (/\bcamera\b.*\b(?:still|static|steady|stop moving)\b/.test(t)) {
    spec.camera = { ...DEFAULT_CAMERA };
    said.push('the camera holds still');
  }
  const lit = t.match(/\b(?:relight|light(?:ing)?|make it|turn it|change it)\b.*?\b(sunset|golden hour|evening|night|nighttime|morning|sunrise|daytime|day ?light|warm|cool)\b/);
  if (lit) {
    const look = { 'golden hour': 'sunset', evening: 'sunset', nighttime: 'night', sunrise: 'morning', daytime: 'morning', daylight: 'morning', 'day light': 'morning' }[lit[1]] || lit[1];
    spec.set = { ...(spec.set || {}), light: look };
    said.push(`the office is relit for ${look === 'warm' || look === 'cool' ? `${look} light` : look}`);
  }
  const last = t.match(/\b(slow(?:er)?(?: it)? down|slow[- ]?mo(?:tion)?|speed (?:it |that )?up|faster)\b(?:.*?\b(?:the )?(last|first) (\w+) seconds?\b)?/);
  if (last) {
    const slow = /slow/.test(last[1]);
    const n = last[3] ? num(last[3]) : null;
    const s = spec.seconds;
    const [from, to] = n ? (last[2] === 'first' ? [0, Math.min(n, s)] : [Math.max(0, s - n), s]) : [0, s];
    spec.time_remap = [...(spec.time_remap || []).filter((r) => r.to <= from || r.from >= to), { from: round(from, 2), to: round(to, 2), speed: slow ? 0.5 : 1.5 }].sort((a, b) => a.from - b.from);
    said.push(`${n ? `the ${last[2]} ${n} seconds play` : 'the whole scene plays'} at ${slow ? 'half speed' : '1.5 times speed'}`);
  }
  if (/\b(?:no|remove|without|take out|turn off) (?:the )?music\b|\bmusic off\b/.test(t)) {
    spec.audio = { ...(spec.audio || {}), music: null };
    said.push('the music is off');
  } else if (/\bmusic\b|\bsoundtrack\b/.test(t)) {
    const mood = /\b(?:calm|soft|chill|relax)/.test(t) ? 'calm' : /\b(?:upbeat|happy|bright|fun)/.test(t) ? 'bright' : 'warm';
    spec.audio = { ...(spec.audio || {}), music: { kind: 'pad', mood } };
    said.push(`${mood} music plays under the scene, softer while ${who} talks`);
  }
  const say = String(text || '').match(/\b(?:make|have|let) (?:her|him|them) say[:,]?\s*["“]?([^"”]{2,240})["”]?\s*$/i);
  if (say) {
    const talk = spec.timeline.find((s) => s.action === 'talk');
    if (talk) {
      talk.line = clean(say[1], 240);
      // A longer line gets a longer talk: the talk step, everything after it and the scene grow to fit the words.
      const grow = round(Math.max(0, talkSeconds(talk.line) - (talk.t1 - talk.t0)), 2);
      if (grow > 0) {
        const end = spec.seconds;
        for (const s of spec.timeline) { if (s.t0 >= talk.t1) s.t0 = round(s.t0 + grow, 2); if (s.t1 >= talk.t1) s.t1 = round(s.t1 + grow, 2); }
        spec.seconds = round(end + grow, 2);
        if (spec.camera?.move === 'orbit' && spec.camera.t1 >= end) spec.camera.t1 = spec.seconds;
        spec.time_remap = (spec.time_remap || []).map((r) => (r.to >= end ? { ...r, from: round(r.from + grow, 2), to: spec.seconds } : r));
      }
      said.push(`${who} now says: "${talk.line}"${grow > 0 ? ` (the scene is ${grow} seconds longer to fit the words)` : ''}`);
    }
  }
  return { spec, said, three_d: threeDKey(spec) !== threeDKey(prev), pron };
}

// ─── Projects ────────────────────────────────────────────────────────────────

// Each project is its own storage value (a Durable Object value holds at most 128 KiB); the index lists their ids.
// A project keeps its last MAX_VERSIONS versions and MAX_RENDERS renders, and is trimmed further if it would still
// pass PROJECT_BYTES, so a save can never be refused for size.
const PROJECT_BYTES = 96_000;
const MAX_RENDERS = 20;
const projectKey = (id) => `director:project:${id}`;
export async function loadProjects(storage) {
  const ids = (await storage.get(DIRECTOR_KEY)) || [];
  const got = await Promise.all(ids.map((x) => storage.get(projectKey(x.id))));
  return got.filter(Boolean);
}
export function boundProject(project) {
  project.renders = project.renders.slice(0, MAX_RENDERS);
  const trim = () => {
    if (project.versions.length <= 1) return false;
    const drop = project.at > 0 ? 0 : project.versions.length - 1; // the oldest, unless that is the one on screen
    project.versions.splice(drop, 1);
    if (drop < project.at) project.at -= 1;
    return true;
  };
  while (project.versions.length > MAX_VERSIONS && trim());
  while (JSON.stringify(project).length > PROJECT_BYTES && (trim() || (project.renders.length > 1 && project.renders.pop())));
  return project;
}
async function saveProject(storage, project, now) {
  boundProject(project);
  await storage.put(projectKey(project.id), project);
  const ids = ((await storage.get(DIRECTOR_KEY)) || []).filter((x) => x.id !== project.id);
  const keep = [{ id: project.id, title: project.title }, ...ids];
  for (const old of keep.slice(MAX_PROJECTS)) await storage.delete(projectKey(old.id));
  await storage.put(DIRECTOR_KEY, keep.slice(0, MAX_PROJECTS));
  await storage.put(DIRECTOR_LAST, { id: project.id, at: now });
}
export function current(project) { return project.versions[project.at]; }

export async function newProject(storage, spec, now = Date.now()) {
  const id = 'scp_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const project = { id, title: spec.title, created_at: new Date(now).toISOString(), versions: [{ ...spec, project: id, version: 1 }], at: 0, renders: [] };
  await saveProject(storage, project, now);
  return project;
}

async function updateProject(storage, project, now = Date.now()) { await saveProject(storage, project, now); }

/** The scene the owner worked on most recently, if it was within the last six hours. */
export async function recentProject(storage, now = Date.now()) {
  const last = await storage.get(DIRECTOR_LAST);
  if (!last?.id || now - Number(last.at || 0) > RECENT_MS) return null;
  return (await storage.get(projectKey(last.id))) || null;
}

// ─── Render on GitHub, and collect ───────────────────────────────────────────

// GitHub keeps the frame artifacts for 7 days (che-scene-render.yml); after 6, the 3D is drawn again.
const FRAMES_KEEP_MS = 6 * 86_400_000;
/** The run whose frame artifacts this spec can reuse: the run that drew them, even through a chain of reuses. */
function framesFor(project, spec, now) {
  const key = threeDKey(spec);
  const r = project.renders.find((x) => x.status === 'ready' && x.run_id && x.three_d === key && now - Number(x.frames_at || x.at || 0) < FRAMES_KEEP_MS);
  return r ? { run_id: r.reused_run || r.run_id, at: r.frames_at || r.at } : null;
}

export async function dispatchRender(env, project, fetcher = fetch, now = Date.now()) {
  if (!env.CHE_GITHUB_TOKEN || !env.CHE_GITHUB_REPO) return { ok: false, error: 'The free GitHub renderer needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker.' };
  const spec = current(project);
  const job = 'scj_' + crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  const reuse = framesFor(project, spec, now);
  const payload = JSON.stringify({ ...spec, job });
  if (payload.length > 16000) return { ok: false, error: 'This scene is too large for one render request.' };
  const frames = Math.round(spec.seconds * spec.fps);
  const segments = String(Math.max(1, Math.min(20, Math.ceil(frames / 20))));
  let res;
  try {
    res = await fetcher(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST', headers: { ...githubHeaders(env), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(14000),
      body: JSON.stringify({ ref: 'main', inputs: { job_id: job, spec: payload, segments, frames_run: reuse ? String(reuse.run_id) : '' } }),
    });
  } catch { return { ok: false, error: 'GitHub Actions could not be reached, so nothing was started.' }; }
  if (res.status !== 204) return { ok: false, error: (await refusalOf(res, 'the scene workflow', env)).error };
  project.renders = [{ job, version: spec.version, status: 'queued', at: now, three_d: threeDKey(spec), reused_run: reuse?.run_id || null, frames_at: reuse ? reuse.at : now, segments: Number(segments) }, ...project.renders].slice(0, 20);
  return { ok: true, job, reused: Boolean(reuse), segments: Number(segments) };
}

/** Checks the latest render: still running, failed (with where), or ready (the MP4 read and saved to the media library). */
export async function collectRender(ctx, project) {
  const { env, storage, fetcher = fetch, now = Date.now() } = ctx;
  const render = project.renders[0];
  if (!render) return { state: 'none' };
  if (render.status === 'ready' || render.status === 'failed') return { state: render.status, render };
  const root = `https://api.github.com/repos/${REPO}`;
  const list = await fetcher(`${root}/actions/workflows/${WORKFLOW}/runs?per_page=50`, { headers: githubHeaders(env), signal: AbortSignal.timeout(15000) });
  if (!list.ok) return { state: 'checking', render };
  const run = ((await readJson(list)).workflow_runs || []).find((r) => r.display_title === `CHE scene render ${render.job}`);
  if (!run) {
    if (now - render.at > 15 * 60_000) { render.status = 'failed'; render.error = 'GitHub never started this render.'; return { state: 'failed', render }; }
    return { state: 'queued', render };
  }
  render.run_id = run.id;
  if (run.status !== 'completed') return { state: run.status === 'in_progress' ? 'running' : 'queued', render };
  if (run.conclusion !== 'success') { render.status = 'failed'; render.error = `The render ${run.conclusion === 'timed_out' ? 'ran out of time' : 'failed'} on GitHub (run ${run.id}).`; return { state: 'failed', render }; }
  const arts = await fetcher(`${root}/actions/runs/${run.id}/artifacts?per_page=100`, { headers: githubHeaders(env), signal: AbortSignal.timeout(15000) });
  const artifact = ((await readJson(arts)).artifacts || []).find((a) => a.name === `che-scene-${render.job}` && !a.expired);
  if (!artifact) { render.status = 'failed'; render.error = 'The render finished without its video.'; return { state: 'failed', render }; }
  const archive = await downloadArchive(env, artifact.id, fetcher);
  const [video, manifestBytes] = await Promise.all([zipEntry(archive, 'video.mp4'), zipEntry(archive, 'manifest.json')]);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const facts = mp4Facts(video);
  const problems = [
    !facts.ok && 'the MP4 is not a playable H.264/AAC file',
    manifest.status !== 'verified' && 'the renderer did not mark it verified',
    facts.ok && Math.abs(facts.seconds - Number(manifest.duration_seconds)) > 0.5 && 'its length does not match',
    manifest.job !== render.job && 'it belongs to another job',
  ].filter(Boolean);
  if (problems.length) { render.status = 'failed'; render.error = `The video failed CHE's own checks: ${problems.join('; ')}.`; return { state: 'failed', render }; }
  const key = `scene/${project.id}/${render.job}.mp4`;
  const media = mediaStore(env, storage);
  const saved = await media.put(key, video, { contentType: 'video/mp4' });
  if (!saved.ok) { render.status = 'failed'; render.error = saved.error; return { state: 'failed', render }; }
  const item = await saveSceneVideo(storage, { key, title: `${project.title} (v${render.version})`, seconds: round(facts.seconds, 2), width: facts.width, height: facts.height, bytes: video.length, project_id: project.id, version: render.version, blob: media.provider });
  Object.assign(render, { status: 'ready', media_id: item.id, seconds: round(facts.seconds, 2), voices: manifest.voices || [], ready_at: now });
  return { state: 'ready', render, item };
}

// ─── Chat ────────────────────────────────────────────────────────────────────

function eta(render) {
  // Measured locally: about 6.4 s a frame at 540x960 on a 4-core runner; runners start in about a minute and a half.
  if (render.reused_run) return 'about two minutes, since only the timing and sound change';
  return 'about four to six minutes';
}

/**
 * The scene the app's live preview draws: the project the owner worked on last, its version on screen and its recent
 * renders. Read-only; { ok: false } when there is no scene yet.
 */
export async function sceneLatest(storage) {
  const last = await storage.get(DIRECTOR_LAST);
  const project = last?.id ? await storage.get(projectKey(last.id)) : null;
  if (!project) return { ok: false, detail: 'There is no scene yet. Say something like "make Nova walk into my office, sit beside me, and start talking".' };
  const spec = current(project);
  return {
    ok: true, project_id: project.id, title: project.title, version: spec.version, versions: project.versions.length, spec,
    renders: project.renders.slice(0, 5).map((r) => ({ job: r.job, version: r.version, status: r.status, media_id: r.media_id || null, seconds: r.seconds ?? null })),
  };
}

/**
 * One chat turn of the Scene Director. Returns { text, meta } or null when the words are not for it. `selection`
 * ({ project_id, actor }) comes from the app's live preview when the owner has touched an actor.
 */
export async function directorTurn(ctx, text, selection = null) {
  const { storage, env, fetcher = fetch, now = Date.now() } = ctx;
  if (directorCreateIntent(text)) {
    const made = sceneFromWords(text);
    if (made.error) return { text: made.error, meta: { source: 'che_scene_director', ok: false } };
    const project = await newProject(storage, made.spec, now);
    const started = await dispatchRender(env, project, fetcher, now);
    await updateProject(storage, project, now);
    const plan = made.spec.timeline.map((s) => (s.action === 'walk' ? 'walks in' : s.action === 'sit' ? 'sits beside you' : s.action === 'talk' ? `says "${s.line}"` : s.action)).join(', then ');
    const who = NAME[made.spec.actors[0].id];
    if (!started.ok) return { text: `I set up the scene (${who} ${plan}), but the render did not start: ${started.error}`, meta: { source: 'che_scene_director', ok: false, project_id: project.id } };
    return {
      text: `Scene started: ${who} ${plan}. It's ${made.spec.seconds} seconds, rendered in 3D with ${who}'s real model on ${started.segments} free GitHub runners at once, ${eta(project.renders[0])}. It's saved as an editable project, so you can say things like "change her outfit", "make the camera circle around us", "slow down the last five seconds" or "add music". Ask "is my scene ready?" anytime.`,
      meta: { source: 'che_scene_director', ok: true, project_id: project.id, job: started.job, scene_status: 'queued' },
    };
  }
  // Ordinary chat costs nothing here: storage is read only when the words are a scene edit.
  if (!directorEditIntent(text)) return null;
  // A selection from the live preview names its project and actor, so a touch edit lands there even after six hours.
  const picked = selection && /^scp_[a-f0-9]{16}$/.test(String(selection.project_id || '')) ? await storage.get(projectKey(selection.project_id)) : null;
  const project = picked || await recentProject(storage, now);
  if (!project) return null;
  const lower = String(text).toLowerCase();
  if (/^\s*undo\b|^\s*go back\b/.test(lower) || /^\s*redo\b/.test(lower)) {
    const redo = /^\s*redo\b/.test(lower);
    const to = project.at + (redo ? 1 : -1);
    if (to < 0 || to >= project.versions.length) return { text: redo ? 'There is nothing to redo.' : 'This is the first version; there is nothing to undo.', meta: { source: 'che_scene_director', ok: false } };
    project.at = to;
    const started = await dispatchRender(env, project, fetcher, now);
    await updateProject(storage, project, now);
    return { text: `${redo ? 'Redone' : 'Undone'}: back to version ${current(project).version}. ${started.ok ? `Re-rendering it now, ${eta(project.renders[0])}.` : started.error}`, meta: { source: 'che_scene_director', ok: started.ok, project_id: project.id } };
  }
  if (/\b(?:is|how(?:'s| is)) (?:my |the )?scene\b|\bscene (?:ready|done|status)\b/.test(lower)) {
    const got = await collectRender(ctx, project);
    await updateProject(storage, project, now);
    const r = got.render;
    if (got.state === 'ready') return { text: `Your scene is ready: "${project.title}", version ${r.version}, ${r.seconds} seconds, checked from the file itself and saved in your media library.${r.voices?.length ? ` The voice is the free Piper voice; the lips do not move with the words yet.` : ''}`, meta: { source: 'che_scene_director', ok: true, project_id: project.id, media_id: r.media_id, scene_status: 'ready' } };
    if (got.state === 'failed') return { text: `That render did not work: ${r.error} Say "render it again" to try once more.`, meta: { source: 'che_scene_director', ok: false, project_id: project.id, scene_status: 'failed' } };
    if (got.state === 'none') return { text: 'This scene has not been rendered yet. Say "render it again".', meta: { source: 'che_scene_director', ok: false } };
    return { text: `Still rendering version ${r.version} (${got.state} on GitHub${r.run_id ? `, run ${r.run_id}` : ''}). ${r.reused_run ? 'Only the timing and sound are being redone.' : `${r.segments} runners are drawing the frames.`}`, meta: { source: 'che_scene_director', ok: true, project_id: project.id, scene_status: got.state } };
  }
  if (/\brender (?:it|the scene|my scene) again\b/.test(lower)) {
    const started = await dispatchRender(env, project, fetcher, now);
    await updateProject(storage, project, now);
    return { text: started.ok ? `Rendering version ${current(project).version} again, ${eta(project.renders[0])}.` : started.error, meta: { source: 'che_scene_director', ok: started.ok, project_id: project.id } };
  }
  const edited = applyEdits(current(project), text, { actor: picked ? String(selection.actor || '') : null });
  if (!edited.said.length) return null;
  const version = Math.max(...project.versions.map((v) => v.version)) + 1;
  project.versions = [...project.versions.slice(0, project.at + 1), { ...edited.spec, version }].slice(-MAX_VERSIONS);
  project.at = project.versions.length - 1;
  const started = await dispatchRender(env, project, fetcher, now);
  await updateProject(storage, project, now);
  const list = edited.said.length > 1 ? `${edited.said.slice(0, -1).join(', ')} and ${edited.said.at(-1)}` : edited.said[0];
  return {
    text: `Done in the project (version ${version}): ${list}. ${started.ok ? (started.reused ? `Only the timing and sound changed, so I'm reusing the 3D frames already rendered: ${eta(project.renders[0])}.` : `Re-rendering the 3D now, ${eta(project.renders[0])}.`) : `The re-render did not start: ${started.error}`} Say "undo" to go back.`,
    meta: { source: 'che_scene_director', ok: started.ok, project_id: project.id, version, reused_frames: Boolean(started.reused) },
  };
}
