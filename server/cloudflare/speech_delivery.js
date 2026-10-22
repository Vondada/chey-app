// CHE's delivery planner and voice profiles (owner, 2026-10-22). It decides how a sentence should be spoken, which voice
// profile may be used, and which engine can speak it while keeping that voice's identity.
//
// What this module does NOT do: it does not synthesize speech, and it does not train or clone a model. A neural cloning
// model (Fish Audio's reference voices, for example) does the audio; this module tells it how fast to speak and where
// pauses fall, and it refuses any profile without authorization. The only prosody control the Fish request body accepts
// today is `prosody.speed` plus the expressive model choice, so per-word pitch and emphasis are planned here but cannot
// yet reach the engine. The plan says so (`controls`), so nothing claims more than the engine receives.
//
// Credits: planning is local and free. The planner never splits a sentence into extra paid requests: pauses are silence
// in the player, not extra clips.

// ─── Voice profiles and authorization ────────────────────────────────────────────────────────────────────────────────

/** Where a profile's reference audio came from. ElevenLabs output is never training material without explicit permission. */
export const REFERENCE_SOURCES = Object.freeze(['owner_recording', 'licensed_recording', 'elevenlabs_generated', 'provider_preset']);

/** Whether a profile may be used as a cloning reference. Returns a reason when refused; nothing is inferred. */
export function cloningAllowed(profile = {}) {
  if (!profile.consent?.owner_confirmed) return { allowed: false, reason: 'the owner has not confirmed consent for this voice' };
  if (!REFERENCE_SOURCES.includes(profile.reference_source)) return { allowed: false, reason: 'the reference audio source is not recorded' };
  if (profile.reference_source === 'elevenlabs_generated' && profile.consent?.explicit_permission_to_train_on_elevenlabs !== true) {
    return { allowed: false, reason: 'ElevenLabs-generated audio is not training material without the owner\'s explicit permission' };
  }
  if (profile.reference_source === 'provider_preset') return { allowed: true, reason: 'a provider\'s own preset voice; it is used as provided, not cloned from' };
  return { allowed: true, reason: '' };
}

/** A profile with its authorization checked. A profile that names a Fish reference voice is refused without consent; a profile without one can still play a preset. */
export function makeVoiceProfile(input = {}) {
  const id = String(input.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return { ok: false, reason: 'the profile needs a short lowercase id' };
  const profile = {
    id,
    label: String(input.label || id).slice(0, 60),
    provider: ['fish', 'elevenlabs', 'local', 'edge'].includes(input.provider) ? input.provider : 'local',
    provider_voice_id: input.provider_voice_id ? String(input.provider_voice_id).slice(0, 80) : '',
    reference_source: input.reference_source || '',
    consent: input.consent && typeof input.consent === 'object' ? { ...input.consent } : {},
    pronunciation: Object.fromEntries(Object.entries(input.pronunciation || {}).slice(0, 200).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 80)])),
    style: {
      base_speed: clamp(Number(input.style?.base_speed ?? 1), 0.7, 1.2),
      expressive: input.style?.expressive === true,
    },
  };
  const auth = cloningAllowed(profile);
  if (profile.provider === 'fish' && profile.provider_voice_id && !auth.allowed) return { ok: false, reason: auth.reason };
  return { ok: true, profile, authorization: auth };
}

// ─── Delivery planning ───────────────────────────────────────────────────────────────────────────────────────────────

const NEGATION = /\b(not|never|no|don't|do not|can't|cannot|won't|isn't|aren't)\b/i;
const CAPS = /\b[A-Z]{2,}\b/;

/** The kind of sentence, from its own words. Plain statements are the default; nothing is guessed about the owner. */
export function sentenceKind(sentence) {
  const s = String(sentence || '').trim();
  if (/\?\s*$/.test(s)) return 'question';
  if (/\b(sorry|that sounds|i understand|that's tough|that is tough|it's okay|it is okay|i'm here)\b/i.test(s)) return 'empathy';
  if (/\b(warning|urgent|important|careful|danger|risk|losses?|cannot|can't|do not|don't|stop)\b/i.test(s)) return 'serious';
  if (/\b(haha|lol|ha ha|joke|funny)\b/i.test(s)) return 'humor';
  if (/\b(maybe|might|not sure|i think|probably|perhaps|could be|unsure)\b/i.test(s)) return 'uncertain';
  if (/!\s*$/.test(s)) return 'excited';
  return 'statement';
}

// Speed multiplier and the final pitch movement for each kind. Ranges are conservative: a fast reply that sounds rushed is worse than a plain one.
const KIND = {
  statement: { rate: 1.0, final: 'fall' },
  question: { rate: 1.0, final: 'rise' },
  excited: { rate: 1.06, final: 'fall' },
  serious: { rate: 0.93, final: 'fall' },
  empathy: { rate: 0.92, final: 'fall' },
  humor: { rate: 1.03, final: 'rise' },
  uncertain: { rate: 0.97, final: 'rise' },
};

// Pause after each punctuation mark, in ms. Sentence ends are the longest so the next sentence does not run on.
const PAUSE_MS = [
  [/,/g, 180],
  [/[;:]/g, 260],
  [/(—|--|\.\.\.|…)/g, 320],
  // A sentence end is a single . ! or ?; the dots of an ellipsis are not sentence ends.
  [/(?<![.])[.!?](?![.])(?=\s|$)/g, 420],
];

/**
 * The delivery plan for one sentence: how fast, where to pause, what to stress, and how the pitch should move.
 * `controls` lists what the chosen engine can actually receive, so the plan never over-claims.
 */
export function planDelivery(sentence, { base_speed = 1, expressive = false, engine = 'local' } = {}) {
  const text = String(sentence || '').replace(/\s+/g, ' ').trim();
  const kind = sentenceKind(text);
  const k = KIND[kind];
  const speed = clamp(base_speed * k.rate, 0.7, 1.2);
  const pauses = [];
  for (const [pattern, ms] of PAUSE_MS) {
    for (const match of text.matchAll(pattern)) pauses.push({ at: match.index + match[0].length, ms });
  }
  pauses.sort((a, b) => a.at - b.at);
  const words = text.split(' ');
  const emphasis = words
    .map((w, i) => ({ i, w }))
    .filter(({ w }) => CAPS.test(w) || NEGATION.test(w))
    .map(({ i, w }) => ({ word: w.replace(/[^A-Za-z']/g, ''), index: i, reason: CAPS.test(w) ? 'capitalized' : 'negation' }));
  const controls = {
    speed: true, // prosody.speed on Fish; the local engine's speed setting
    pauses: 'silence in the player, never extra requests',
    emphasis: 'planned only: the current engine request has no word-level emphasis control',
    pitch_contour: 'planned only: the current engine request has no pitch control',
    expressive_model: engine === 'fish' && expressive,
  };
  return {
    kind,
    speed: Math.round(speed * 100) / 100,
    final_pitch: k.final,
    pauses,
    emphasis,
    controls,
  };
}

// ─── Engine choice and fallback ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The engine that speaks a profile, in order, with what each one preserves. A fallback that cannot keep the profile's
 * voice says so (`preserves_voice_identity: false`), so the owner hears the difference reported, never a silent swap.
 * Nothing is spoken by an engine that is not ready: an empty list means no voice is available, and nothing is invented.
 */
export function chooseEngine(profile, engines = {}) {
  const ready = (name) => engines[name]?.ready === true;
  const order = [];
  if (profile?.provider === 'fish' && profile.provider_voice_id && ready('fish')) {
    order.push({ engine: 'fish', voice: profile.provider_voice_id, preserves_voice_identity: true, warning: '' });
  }
  if (profile?.provider === 'elevenlabs' && profile.provider_voice_id && ready('elevenlabs')) {
    order.push({ engine: 'elevenlabs', voice: profile.provider_voice_id, preserves_voice_identity: true, warning: '' });
  }
  if (ready('kokoro')) {
    order.push({ engine: 'kokoro', voice: 'local-default', preserves_voice_identity: false, warning: 'This plays the built-in local voice, not your saved voice profile.' });
  }
  if (ready('edge')) {
    order.push({ engine: 'edge', voice: 'edge-default', preserves_voice_identity: false, warning: 'This plays the fallback Edge voice, not your saved voice profile.' });
  }
  return order;
}

/** The cache key for a delivery: the same text in the same voice, engine and speed is the same audio, and nothing else. */
export function deliveryCacheKey({ profile, engine, text, speed }) {
  return [profile?.id || 'default', engine || '', profile?.provider_voice_id || '', String(speed), text].join('\u001f');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
