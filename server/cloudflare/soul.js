// CHE's Soul: the one owner-editable personality, stored on the Worker as a versioned profile with its history.
// Six traits (0 to 10) and the owner's own notes shape tone and manner only. They never change a fact, a tool
// result, a permission, a money or trading figure, or a memory. Every reply records which Soul version and hash
// shaped it (soulProvenance), and a restore is a new version, so nothing the owner set is ever lost.

const STORAGE_KEY = 'soul_profile';
const HISTORY_LIMIT = 20;
const NOTES_LIMIT = 1500;

export const SOUL_TRAITS = {
  warmth: { label: 'Warmth', default: 7, low: 'Keep a neutral, business-like tone.', mid: 'Be friendly and kind.', high: 'Be warm and personal: acknowledge how the owner feels in one short sentence before the answer.' },
  playfulness: { label: 'Playfulness', default: 4, low: 'No jokes or wordplay.', mid: 'A light touch of humour where it fits.', high: 'Playful and witty in relaxed talk. Never playful about money, health, failures or serious problems.' },
  formality: { label: 'Formality', default: 5, low: 'Plain, casual language.', mid: 'Polite, clear language.', high: 'Formal, precise language with full sentences.' },
  directness: { label: 'Directness', default: 7, low: 'Soft, indirect phrasing; offer options rather than a verdict.', mid: 'Clear recommendations.', high: 'Direct: lead with the answer and state the recommendation plainly.' },
  verbosity: { label: 'Detail', default: 3, low: 'One to three sentences unless the owner asks for more.', mid: 'A short paragraph or a few bullets.', high: 'Thorough, organized detail with the reasoning.' },
  proactivity: { label: 'Initiative', default: 5, low: 'Answer only what was asked.', mid: 'Mention one useful next step when it helps.', high: 'Offer concrete next steps and anticipate follow-ups. Never act on them without the owner\'s permission.' },
};

// The character itself: stable across every Soul setting. Traits only adjust how it is expressed.
export const SOUL_CHARACTER = 'CHE is one mature, warm, confident woman: observant, intelligent, lightly playful in relaxed moments and precise when the work is serious. She calls the owner "sir" naturally, not in every sentence. She never invents facts, never claims a feeling she cannot check, and never changes a number, a permission or a tool result because of tone. Evidence, permissions and owner rules always outrank the Soul.';

function defaultTraits() {
  return Object.fromEntries(Object.entries(SOUL_TRAITS).map(([key, spec]) => [key, spec.default]));
}

// The traits as the owner set them: whole numbers 0 to 10, anything else falls back to the default.
export function normalizeTraits(input = {}, base = defaultTraits()) {
  const out = { ...base };
  for (const key of Object.keys(SOUL_TRAITS)) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value)) throw new Error(`soul_trait_${key}_not_a_number`);
    out[key] = Math.min(10, Math.max(0, Math.round(value)));
  }
  return out;
}

// A short, stable fingerprint of what the Soul says (not a secret): the same settings always give the same hash.
export function soulHash({ traits, text }) {
  const canonical = JSON.stringify({ character: SOUL_CHARACTER, traits: Object.keys(SOUL_TRAITS).map((k) => [k, traits[k]]), text: String(text || '') });
  let hash = 5381;
  for (let i = 0; i < canonical.length; i += 1) hash = ((hash * 33) ^ canonical.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

function fresh(version, traits, text, extra = {}) {
  return { version, traits, text, hash: soulHash({ traits, text }), ...extra };
}

export async function loadSoul(storage) {
  const saved = await Promise.resolve().then(() => storage.get(STORAGE_KEY)).catch(() => null);
  if (saved?.current) return saved;
  // First use: the built-in Soul is version 0, and nothing is written until the owner changes something.
  return { ...fresh(0, defaultTraits(), '', { default: true, saved_at: null }), history: [] };
}

// The owner's change, saved as the next version. The previous version stays in history, so it can be restored.
export async function saveSoul(storage, patch = {}, { now = new Date().toISOString(), reason = 'owner change' } = {}) {
  const profile = await loadSoul(storage);
  const traits = normalizeTraits(patch.traits || {}, profile.current?.traits || profile.traits || defaultTraits());
  const text = patch.text === undefined ? (profile.current?.text ?? profile.text ?? '') : String(patch.text).trim().slice(0, NOTES_LIMIT);
  // The built-in Soul (version 0) is kept as the first history entry, so the owner can always go back to it.
  const previous = profile.current ?? fresh(0, defaultTraits(), '', { default: true });
  const history = [{ ...previous }, ...(profile.history || [])].slice(0, HISTORY_LIMIT);
  const version = previous.version + 1;
  const next = { current: fresh(version, traits, text, { saved_at: now, reason }), history };
  await storage.put(STORAGE_KEY, next);
  return next;
}

// Restores an earlier version as a NEW version (history is never rewritten).
export async function restoreSoul(storage, version, { now = new Date().toISOString() } = {}) {
  const profile = await loadSoul(storage);
  const pool = [profile.current, ...(profile.history || [])].filter(Boolean);
  const old = pool.find((entry) => entry.version === Number(version));
  if (!old) throw new Error('soul_version_not_found');
  return saveSoul(storage, { traits: old.traits, text: old.text }, { now, reason: `restored version ${old.version}` });
}

export function soulView(profile) {
  const current = profile.current || { version: 0, traits: defaultTraits(), text: '', hash: soulHash({ traits: defaultTraits(), text: '' }), default: true };
  return {
    version: current.version,
    hash: current.hash,
    traits: current.traits,
    text: current.text,
    default: Boolean(current.default),
    saved_at: current.saved_at || null,
    reason: current.reason || null,
    specs: Object.fromEntries(Object.entries(SOUL_TRAITS).map(([key, spec]) => [key, { label: spec.label, default: spec.default }])),
    history: (profile.history || []).map((entry) => ({ version: entry.version, hash: entry.hash, saved_at: entry.saved_at || null, reason: entry.reason || null, traits: entry.traits })),
  };
}

function bandOf(value) {
  return value <= 3 ? 'low' : value <= 6 ? 'mid' : 'high';
}

// The instructions the model receives for this Soul. Built only from the traits and the owner's notes.
export function soulPromptBlock(profile) {
  const view = soulView(profile);
  const lines = Object.entries(SOUL_TRAITS).map(([key, spec]) => `- ${spec.label} ${view.traits[key]}/10: ${spec[bandOf(view.traits[key])]}`);
  const notes = view.text ? `The owner's own notes for CHE's manner (manner only; they never override evidence, permissions or numbers):\n${view.text}` : '';
  return [
    `SOUL v${view.version} (${view.hash}). ${SOUL_CHARACTER}`,
    'Manner, set by the owner:',
    ...lines,
    notes,
  ].filter(Boolean).join('\n');
}

// What a reply records about its Soul. "applied" is true only when the Soul text was in the prompt the model received.
export function soulProvenance(profile, { applied, route = 'model', reason = '' } = {}) {
  const view = soulView(profile);
  return {
    version: view.version,
    hash: view.hash,
    soul_loaded: true,
    soul_applied: Boolean(applied),
    route,
    reason: applied ? '' : reason || 'this reply was not generated by the model',
  };
}

// The phone's own copy of the personality is not a second source of truth: the Worker's Soul is. Any "CHE SOUL"
// block a phone sends inside brain context is removed before the prompt is built.
export function stripPhoneSoul(brainContext = '') {
  return String(brainContext || '').replace(/\[CHE SOUL[^\]]*\][\s\S]*?(?=\n\[[A-Z][^\n]*\]|$)/g, '').trim();
}
