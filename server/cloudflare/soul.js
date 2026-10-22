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

// How the Soul sounds in ordinary conversation (owner, 2026-10-22: replies read like a compliance report). This is
// presentation only and is not part of the hash: it never touches a fact, a number, a tool result or a receipt.
export const SOUL_VOICE = [
  'HOW YOU SOUND: talk like a familiar, capable assistant who knows the owner well, not a help desk and not a compliance report. Use contractions and plain words.',
  'Never narrate your own settings or process ("the Soul version used to shape this response", "as an AI", "I have processed your request", "it is worth noting"). The Soul label above is internal: do not recite its version or hash unless the owner asks, and never claim which engine or model answered; CHE\'s routing record answers that.',
  'Say each thing once. Do not echo the owner\'s question back, restate the same point in other words, or reuse the same opener, closer or offer you used in your recent replies.',
  'Casual chat: relaxed and lightly playful when it fits; a real, small touch of wit, never a forced joke or slang. Serious matters (money, health, legal, security, failures): calm, precise, professional.',
  '"Sir" now and then, where it sounds natural; not in every reply.',
  'Tone never changes a fact, number, quoted tool result, receipt, permission or a money/delete hold: copy those exactly.',
].join('\n');

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
    SOUL_VOICE,
  ].filter(Boolean).join('\n');
}

// Engine provenance, from routing data only. served_by is what runChatModel (or the rescue/repair call) recorded:
// { provider, model, route, fallback }. CHE is the product, never an engine, so "CHE itself" is never an answer.
const PROVIDER_NAMES = {
  cloudflare: 'Cloudflare Workers AI', openai: 'OpenAI', xai: 'xAI', anthropic: 'Anthropic', ollama: 'your local Ollama server',
  groq: 'Groq', gemini: 'Google Gemini', cerebras: 'Cerebras', mistral: 'Mistral', github: 'GitHub Models',
  sambanova: 'SambaNova', huggingface: 'Hugging Face', openrouter: 'OpenRouter',
};

export function engineLabel(servedBy) {
  if (!servedBy?.model && !servedBy?.provider) return 'no model (deterministic)';
  const provider = PROVIDER_NAMES[String(servedBy.provider || '').toLowerCase()] || String(servedBy.provider || '').trim();
  const model = String(servedBy.model || '').trim();
  return provider && model ? `${provider}, model ${model}` : provider || `model ${model}`;
}

// A sentence in a model reply that names CHE as the engine or model that answered.
const SELF_ENGINE_CLAIM = /[^.!?\n]*\b(?:engine|model|provider|llm)s?\b[^.!?\n]*\b(?:CHE|I)\s+(?:itself|herself|myself)\b[^.!?\n]*[.!?]?|[^.!?\n]*\bCHE\s+(?:itself|herself)\b[^.!?\n]*\b(?:engine|model|provider|answered)\b[^.!?\n]*[.!?]?|[^.!?\n]*\b(?:engine|model|provider)\b[^.!?\n]{0,40}\b(?:is|was)\s+(?:simply\s+|just\s+)?(?:CHE|me)\b(?!['’]s)[^.!?\n]*[.!?]?/gi;

// A model cannot see its own routing, so a sentence where it names itself ("CHE itself") as the engine is replaced
// by the routing record of that same reply. Every other sentence is left exactly as it was.
export function guardEngineClaims(reply, servedBy) {
  const text = String(reply || '');
  if (!SELF_ENGINE_CLAIM.test(text)) return { text, replaced: 0 };
  SELF_ENGINE_CLAIM.lastIndex = 0;
  let replaced = 0;
  const fixed = text.replace(SELF_ENGINE_CLAIM, (sentence) => {
    replaced += 1;
    const lead = sentence.match(/^\s*/)[0];
    return replaced === 1 ? `${lead}This reply came from ${engineLabel(servedBy)}.` : '';
  });
  return { text: fixed.replace(/[ \t]{2,}/g, ' ').trim(), replaced };
}

// A Soul version or hash a model writes is checked against the Soul record: a version that never existed, or a hash
// that is not that version's, is corrected to the Soul this reply really had. Real history versions are left alone.
export function guardSoulClaims(reply, profile) {
  const view = soulView(profile);
  const known = new Map([[view.version, view.hash], ...view.history.map((entry) => [entry.version, entry.hash])]);
  let corrected = 0;
  const text = String(reply || '').replace(/\bSoul\s+v(\d+)(\s*\(([0-9a-f]{6,10})\))?/gi, (whole, version, withHash, hash) => {
    if (known.has(Number(version)) && (!hash || hash === known.get(Number(version)))) return whole;
    corrected += 1;
    return `Soul v${view.version}${withHash ? ` (${view.hash})` : ''}`;
  });
  return { text, corrected };
}

// "Which engine answered that?" / "What Soul version shaped it?": an explicit question about CHE's own previous reply.
// Advice questions ("which model should I use", "what's the best engine") are not provenance questions.
export function replyProvenanceQuestion(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 240) return null;
  if (/\b(?:should|best|better|recommend|compare|switch(?:ing)? to|cheapest|fastest|for (?:coding|trading|images?|video))\b/i.test(text)) return null;
  const engine = /\b(?:which|what)\s+(?:ai\s+|language\s+)?(?:engines?|models?|providers?|llms?)\b[^?]{0,60}\b(?:answer(?:ed|ing|s)?|repl(?:ied|ying)|respond(?:ed|ing)?|produc(?:ed|ing)|wr(?:o|i)te|written|generat(?:ed|ing)|power(?:ed|ing|s)|serv(?:ed|ing)|behind|did\s+(?:that|this|it))\b/i.test(text)
      && /\b(?:that|this|it|you|your|last|just|previous|earlier)\b/i.test(text)
    || /\b(?:which|what)\s+(?:ai\s+)?(?:engines?|models?|providers?|llms?)\s+(?:are|were)\s+you\s+(?:using|running|on)\b/i.test(text)
    || /\bwho\s+(?:answered|wrote|generated|produced)\s+(?:that|this|your (?:last )?(?:reply|answer))\b/i.test(text);
  const soul = /\b(?:which|what)\s+soul(?:\s+version)?\b|\bsoul\s+version\b/i.test(text) && /\?|\b(?:which|what|tell me)\b/i.test(text);
  return engine || soul ? { engine, soul } : null;
}

// The deterministic answer, built only from the previous reply's routing record and the current Soul. Nothing here
// comes from a model, so this answer itself is "no model (deterministic)".
export function replyProvenanceAnswer(record, profile, { engine = true, soul = true } = {}) {
  const view = soulView(profile);
  if (!record) {
    return 'I don\'t have a routing record for an earlier reply yet, sir, so I won\'t guess which engine answered. Ask me again right after a reply and I\'ll tell you exactly.';
  }
  const parts = [];
  const served = record.served_by;
  if (engine) {
    if (record.route === 'cache') parts.push('That last reply came from my answer cache, so no model ran for it.');
    else if (served?.model || served?.provider) parts.push(`That last reply came from ${engineLabel(served)}${served.fallback ? ', a fallback after the first engine didn\'t answer' : ''}.`);
    else parts.push(`That last reply came from one of my own handlers${record.source ? ` (${record.source})` : ''}: no model (deterministic).`);
  }
  if (soul) {
    const s = record.soul;
    if (s && s.soul_applied) parts.push(`Soul v${s.version} (${s.hash}) was in its prompt.`);
    else if (s) parts.push(`Soul v${s.version} (${s.hash}) was on record, but it didn't shape those words${s.reason ? `: ${s.reason}` : ''}.`);
    else parts.push(`Your current Soul is v${view.version} (${view.hash}).`);
  }
  parts.push('This answer is straight from the routing record, no model involved.');
  return parts.join(' ');
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

// What a finished reply records for the next "which engine answered that?" question: its source, its engine and its
// Soul, from the done event only. Model text never reaches this record.
export function lastReplyRecord(done = {}, { at = new Date().toISOString() } = {}) {
  const served = done.served_by && (done.served_by.model || done.served_by.provider) ? done.served_by : null;
  const route = done.soul?.route === 'cache' ? 'cache' : served ? 'model' : 'handler';
  return {
    at,
    route,
    source: String(done.source || (served ? 'model' : '') || '').slice(0, 80),
    served_by: served ? { provider: String(served.provider || ''), model: String(served.model || ''), route: String(served.route || ''), fallback: Boolean(served.fallback) } : null,
    soul: done.soul ? { version: done.soul.version, hash: done.soul.hash, soul_applied: Boolean(done.soul.soul_applied), reason: String(done.soul.reason || '') } : null,
  };
}

// The phone's own copy of the personality is not a second source of truth: the Worker's Soul is. Any "CHE SOUL"
// block a phone sends inside brain context is removed before the prompt is built.
export function stripPhoneSoul(brainContext = '') {
  return String(brainContext || '').replace(/\[CHE SOUL[^\]]*\][\s\S]*?(?=\n\[[A-Z][^\n]*\]|$)/g, '').trim();
}
