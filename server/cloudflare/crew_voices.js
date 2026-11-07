// One voice per crew member (Stage 7, owner 2026-11-07: "Better-looking renders" "And voices"). This map is the single
// source of truth: Scene Director writes each actor's voice into its spec (spec.actors[].voice), the scene finisher
// (tools/che_scene_finish.py) speaks every line with that actor's voice, and che-scene-render.yml downloads only the
// voices a spec uses. Every voice is a free, offline Piper neural voice (rhasspy/piper-voices, MIT-licensed engine;
// each voice keeps its own dataset licence), run on the free GitHub runner: no paid provider, nothing uploaded.
//
// `speed` is Piper's length scale: 1 is the voice's natural pace, above 1 is slower. Talk steps are timed from it
// (spokenSeconds), and the real voice length from the rendered audio still decides the finished timing.
// CHE keeps the voice her scenes have always used (en_US-kristin-medium).
//
// Follow-up: the Film Studio speaks lines with Workers AI MeloTTS, which has one voice per language, so film
// characters cannot yet sound different. Films can import crewVoice() and voice lines with Piper on their assembly
// runner (film_render.js and che_film_render.yml) — left for the film pipeline's owner.
export const CREW_VOICES = Object.freeze({
  che: Object.freeze({ engine: 'piper', voice: 'en_US-kristin-medium', speed: 1.0 }),
  nova: Object.freeze({ engine: 'piper', voice: 'en_US-amy-medium', speed: 1.0 }),
  atlas: Object.freeze({ engine: 'piper', voice: 'en_US-ryan-medium', speed: 1.05 }),
  mira: Object.freeze({ engine: 'piper', voice: 'en_GB-alba-medium', speed: 1.0 }),
  knox: Object.freeze({ engine: 'piper', voice: 'en_US-joe-medium', speed: 1.08 }),
  sage: Object.freeze({ engine: 'piper', voice: 'en_US-hfc_female-medium', speed: 1.1 }),
  lyra: Object.freeze({ engine: 'piper', voice: 'en_GB-jenny_dioco-medium', speed: 0.95 }),
  iris: Object.freeze({ engine: 'piper', voice: 'en_US-lessac-medium', speed: 1.0 }),
  orion: Object.freeze({ engine: 'piper', voice: 'en_GB-alan-medium', speed: 1.05 }),
  vale: Object.freeze({ engine: 'piper', voice: 'en_GB-cori-medium', speed: 0.95 }),
});
export const DEFAULT_VOICE = CREW_VOICES.che;
const PIPER_NAME = /^[a-z]{2}_[A-Z]{2}-[a-z0-9_]{1,40}-(?:x_low|low|medium|high)$/;

/** The voice a crew member speaks with ({ engine, voice, speed }); CHE's voice for anyone not in the crew. */
export function crewVoice(id) {
  return { ...(CREW_VOICES[String(id || '').toLowerCase()] || DEFAULT_VOICE) };
}

/** A voice from a spec, kept only if it is a well-formed free Piper voice at a sane pace; otherwise null. */
export function cleanVoice(v) {
  if (!v || v.engine !== 'piper' || !PIPER_NAME.test(String(v.voice || ''))) return null;
  const speed = Number(v.speed);
  return { engine: 'piper', voice: v.voice, speed: Number.isFinite(speed) ? Math.max(0.7, Math.min(1.4, speed)) : 1 };
}

/** About how long a line takes to say in a voice: ~2.5 words a second at its natural pace, plus a breath. */
export function spokenSeconds(line, voice = DEFAULT_VOICE) {
  const words = String(line || '').split(/\s+/).filter(Boolean).length;
  return Math.round(Math.max(3, (words / 2.5) * (Number(voice?.speed) || 1) + 1.2) * 100) / 100;
}
