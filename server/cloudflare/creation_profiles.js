// Which tools the Creation Engine runs for each kind of creation (owner, 2026-10-24: "make CHE choose the appropriate
// tools automatically based on whether I'm creating a person, movie, object, room, or Roblox game"). One table over the
// EXISTING pipelines; it adds no engine. The job runner reads the settings strings it returns (scripts/
// che_gpu_face_preview.py → tools/avatar_body/render_glb.py and render_profiles.py; roblox_export.py), and
// docs/CHE_CREATION_TOOLS.md records the research and the measured benchmark behind each choice.
//
// Every pipeline renders a quick look first (render profile "preview", EEVEE where the worker has an OpenGL context,
// otherwise a 4-sample denoised Cycles pass at half size), so the owner sees the real model while the final renders
// run, then the final pictures with the "final" render profile (Cycles: adaptive stop, OpenImageDenoise with albedo and
// normal passes, capped light paths, persistent data across views, skin subsurface and micro-detail). A GPU worker
// renders the same profile with OptiX/CUDA; the device is never guessed: the receipt names it.

export const CREATION_KINDS = ['person', 'roblox', 'movie', 'object', 'room'];

const BASE = Object.freeze({ RENDER_PROFILE: 'final', PREVIEW: '1', PREVIEW_ENGINE: 'auto' });

export const CREATION_PROFILES = Object.freeze({
  person: {
    label: 'Person', pipeline: 'blender_full_body', job_kind: 'person_model', gpu: 'preferred', status: 'built',
    tools: ['MPFB2 body, skeleton and skin weights (CC0 data)', 'procedural clothing, hair cap, face morphs', 'clips idle, walk, run, wave, talk',
      'verify_glb.py rig check', 'quick look (EEVEE or 4-sample Cycles)', 'Cycles final with skin subsurface'],
    exports: ['glb'], settings: { ...BASE },
  },
  roblox: {
    label: 'Roblox character', pipeline: 'blender_full_body', job_kind: 'person_model', gpu: 'none', status: 'built',
    tools: ['the person pipeline', 'roblox_export.py: R15 skeleton (17 joints), 15 _Geo parts in the 10,742-triangle body budget, 4 influences, FBX',
      'the FBX is read back and validated (roblox_rig.py)'],
    exports: ['glb', 'fbx_r15', 'fbx_r15_walk'], settings: { ...BASE, EXPORT_ROBLOX: '1' },
    note: 'Imports into Roblox Studio (Import 3D, rig type R15). Not Marketplace-ready: no layered-clothing cages, attachments or FACS face yet.',
  },
  movie: {
    label: 'Movie', pipeline: 'film_renderer', job_kind: null, gpu: 'preferred', status: 'separate_pipeline',
    tools: ['tools/che_film_render.py and the Film Studio director pipeline (MP4)', 'characters come from the person pipeline as GLB'],
    exports: ['mp4'], settings: { ...BASE, LIGHTING: 'cinematic' },
    note: 'Movies render through the Film Studio pipeline; the Creation Engine supplies the characters.',
  },
  object: {
    label: 'Object', pipeline: 'blender_parametric', job_kind: 'object_model', gpu: 'none', status: 'separate_lane',
    tools: ['parametric object generator (Create Object lane)', 'quick look', 'Cycles final'], exports: ['glb'], settings: { ...BASE },
  },
  room: {
    label: 'Room', pipeline: 'blender_parametric', job_kind: 'room_model', gpu: 'preferred', status: 'separate_lane',
    tools: ['parametric room generator (Create Room lane)', 'quick look', 'Cycles final'], exports: ['glb'], settings: { ...BASE },
  },
});

/** The profile for a kind of creation (an unknown kind is an error, never a silent default). */
export function creationProfile(kind) {
  const p = CREATION_PROFILES[kind];
  if (!p) throw new Error(`No Creation Engine profile for "${kind}"; known: ${CREATION_KINDS.join(', ')}.`);
  return p;
}

/** The kind a spoken or typed request is about: "create a Roblox character" → roblox, "make a movie" → movie. */
export function kindFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/\broblox\b/.test(t)) return 'roblox';
  if (/\b(movie|film|scene|short|cinematic|animation reel)\b/.test(t)) return 'movie';
  if (/\b(room|office|bedroom|kitchen|studio space|interior)\b/.test(t)) return 'room';
  if (/\b(person|character|human|man|woman|girl|boy|avatar|someone)\b/.test(t)) return 'person';
  if (/\b(object|chair|table|lamp|desk|cup|mug|car|robot|sword|prop)\b/.test(t)) return 'object';
  return null;
}

/** The job settings (strings, as gpu_queue cleanSettings keeps them) a kind adds to its render settings. */
export function profileSettings(kind) { return { ...creationProfile(kind).settings }; }
