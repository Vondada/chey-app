// CHE capability-aware model broker.
//
// Routes by what a task needs (fast chat, deep reasoning, coding, vision,
// long context, local-only privacy…) instead of a fixed provider order, using
// live provider health. Pure functions: ai_router.js applies them and keeps
// the existing retries, cooldowns, budgets and "never run out" fallbacks.

import { BUILTIN_PROVIDER_MANIFESTS } from './provider_registry.js';

const COST_RANK = { free: 0, low: 1, medium: 2, high: 3 };
const LATENCY_RANK = { instant: 0, fast: 1, medium: 2, slow: 3 };

// Rough strength priors per provider family for hard reasoning/coding work.
// Health and discovered-model evaluations adjust this at runtime; it is a
// tie-breaker, never a hard-coded single-model dependency.
const STRENGTH = {
  openai: 9, xai: 9, anthropic: 9, gemini: 8, huggingface: 6, groq: 6,
  cerebras: 6, mistral: 6, github: 7, sambanova: 6, openrouter: 5,
  ollama: 5, cloudflare: 3,
};

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : String(p?.text || ''))).join(' ');
  return String(content || '');
}

// Infers what the task needs from the request.
export function inferNeeds(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const latest = contentText([...messages].reverse().find((m) => m?.role === 'user')?.content);
  const chars = messages.reduce((sum, m) => sum + contentText(m?.content).length, 0);
  const hasImage = messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url' || p?.type === 'input_image'));
  let capability = String(input.che_capability || '').trim();
  if (!capability) {
    if (hasImage) capability = 'vision';
    else if (chars > 60000) capability = 'long_context';
    else if (/\b(?:code|debug|implement|refactor|function|stack trace|compile|typescript|python|dart|flutter|sql)\b/i.test(latest)) capability = 'coding';
    else if (/\b(?:prove|analy[sz]e|architect|strategy|plan|research|compare|investigate|why|derive|legal|financial|medical)\b/i.test(latest) || chars > 5000) capability = 'deep_reasoning';
    else capability = 'fast_chat';
  }
  const difficulty = capability === 'fast_chat' && latest.length < 240 && chars < 1600
    ? 'trivial'
    : ['deep_reasoning', 'coding', 'long_context'].includes(capability) && (chars > 1500 || /\b(?:difficult|hard|complex|critical|high[- ]stakes|important)\b/i.test(latest))
      ? 'hard'
      : 'normal';
  return {
    capability,
    difficulty,
    local_only: input.che_local_only === true,
    provider: (() => { const p = String(input.che_provider || '').trim().toLowerCase(); return p === 'auto' ? '' : p; })(),
    model: (() => { const m = String(input.che_model || '').trim(); return m.toLowerCase() === 'auto' ? '' : m; })(),
    strongest: input.che_strongest === true,
  };
}

// ─── Health ────────────────────────────────────────────────────────────────

export function recordHealth(health, providerId, { ok, status = 0, latencyMs = null, timeout = false, quota = false, error = '' }, now = Date.now()) {
  const h = health[providerId] || { success: 0, failure: 0, latency_total: 0, latency_count: 0, rate_limited: 0, timeouts: 0, score: 1, recent_errors: [] };
  if (ok) {
    h.success += 1;
    h.last_ok_at = now;
    if (Number.isFinite(latencyMs)) { h.latency_total += latencyMs; h.latency_count += 1; }
    h.score = Math.min(1, h.score * 0.8 + 0.2);
  } else {
    h.failure += 1;
    h.last_error_at = now;
    if (status === 429) h.rate_limited += 1;
    if (timeout) h.timeouts += 1;
    if (quota) h.quota_until = now + 30 * 60 * 1000;
    h.recent_errors = [...(h.recent_errors || []), { at: now, status, error: String(error).slice(0, 120) }].slice(-8);
    h.score = Math.max(0, h.score * 0.6);
  }
  // Decay: counters shouldn't grow forever.
  if (h.success + h.failure > 500) {
    h.success = Math.round(h.success / 2); h.failure = Math.round(h.failure / 2);
    h.latency_total = Math.round(h.latency_total / 2); h.latency_count = Math.round(h.latency_count / 2);
  }
  health[providerId] = h;
  return h;
}

export function isUnhealthy(h, now = Date.now()) {
  if (!h) return false;
  if (h.quota_until && h.quota_until > now) return true;
  const recent = (h.recent_errors || []).filter((e) => now - e.at < 5 * 60 * 1000).length;
  return h.score < 0.25 && recent >= 3;
}

// ─── Ranking ───────────────────────────────────────────────────────────────

function manifestFor(id) {
  const base = String(id).split(':')[0];
  return BUILTIN_PROVIDER_MANIFESTS.find((m) => m.id === base) || null;
}

// Scores a router provider entry for the inferred needs. Higher is better.
export function scoreProvider(entry, needs, health = {}, snapshot = {}, now = Date.now()) {
  const manifest = entry.manifest || manifestFor(entry.id);
  const baseId = String(entry.id).split(':')[0];
  if (!manifest) return entry.keyless ? 0.5 : 1;
  const caps = new Set(manifest.capabilities);
  if (needs.local_only && manifest.locality !== 'local') return -Infinity;
  if (needs.provider && baseId !== needs.provider) return -Infinity;
  if (needs.capability && !caps.has(needs.capability) && !(needs.capability === 'fast_chat' && caps.has('text'))) {
    return -Infinity;
  }
  const h = health[baseId];
  if (isUnhealthy(h, now)) return -1000;
  const maxCost = COST_RANK[snapshot.policy?.max_cost_class || 'high'] ?? 3;
  if ((COST_RANK[manifest.cost_class] ?? 2) > maxCost) return -Infinity;
  let score = 0;
  const strength = STRENGTH[baseId] ?? 5;
  if (needs.difficulty === 'trivial' || needs.capability === 'fast_chat') {
    score += (3 - (LATENCY_RANK[manifest.latency_class] ?? 2)) * 3 + (3 - (COST_RANK[manifest.cost_class] ?? 2)) * 2 + strength * 0.3;
  } else if (needs.strongest || needs.difficulty === 'hard' || ['deep_reasoning', 'coding'].includes(needs.capability)) {
    score += strength * 3 - (LATENCY_RANK[manifest.latency_class] ?? 2);
  } else if (needs.capability === 'long_context') {
    score += Math.log10(manifest.context_tokens) * 4 + strength;
  } else {
    score += strength * 1.5 + (3 - (COST_RANK[manifest.cost_class] ?? 2));
  }
  if (h) score += (h.score - 1) * 6;
  if (snapshot.policy?.preferred_provider === baseId) score += 4;
  if (entry.keyless) score -= 20;
  return score;
}

// Orders router provider entries by capability fit and health. Entries that
// cannot serve the need are dropped; ties keep the existing router order so
// "never run out" fallback behavior is preserved.
export function orderByCapability(entries, needs, health = {}, snapshot = {}, now = Date.now()) {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreProvider(entry, needs, health, snapshot, now) }))
    .filter((item) => item.score !== -Infinity)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((item) => item.entry);
}

// Picks a discovered/promoted model for a provider and need, if any. Trial
// (recently promoted) models get a small share of traffic, not all of it.
export function pickCatalogModel(snapshot, providerId, needs, random = Math.random) {
  const models = (snapshot.catalog?.[providerId] || []).filter((m) => m.status === 'active' && m.capabilities?.includes(needs.capability === 'fast_chat' ? 'text' : needs.capability));
  if (!models.length) return '';
  const trial = models.filter((m) => m.trial_until && m.trial_until > Date.now());
  if (trial.length && random() < 0.15) return trial[0].model;
  const stable = models.filter((m) => !(m.trial_until && m.trial_until > Date.now()));
  const pool = stable.length ? stable : models;
  if (needs.capability === 'fast_chat') return (pool.find((m) => m.latency_class === 'fast') || pool[0]).model;
  return (pool.find((m) => m.capabilities.includes('deep_reasoning')) || pool[0]).model;
}

// ─── Cross-model review ────────────────────────────────────────────────────

// Uses several expensive calls only when the task warrants it.
export function shouldCrossCheck(needs, policy = {}, connectedCount = 1) {
  if (connectedCount < 2) return false;
  if (policy.cross_check === 'off') return false;
  if (policy.cross_check === 'always') return needs.difficulty !== 'trivial';
  return needs.difficulty === 'hard' || needs.uncertain === true;
}

// Plans a paired-intelligence job across provider families, e.g.
// OpenAI Researcher + Grok Researcher → Llama Analyst → QA → CHE synthesis.
export function planPairedJob(objective, connected = [], requestedFamilies = []) {
  const available = new Set(connected);
  const pick = (...ids) => ids.find((id) => available.has(id)) || '';
  const families = requestedFamilies.filter((id) => available.has(id));
  const researchers = (families.length ? families : [pick('openai'), pick('xai')].filter(Boolean)).slice(0, 3);
  const steps = [
    ...researchers.map((provider) => ({ role: `${providerLabel(provider)} Researcher`, provider, capability: 'deep_reasoning', stage: 'independent' })),
    { role: 'Analyst', provider: pick('huggingface', 'ollama', 'groq', 'gemini') || '', capability: 'deep_reasoning', stage: 'compare' },
    { role: 'QA/Security Reviewer', provider: pick('anthropic', 'openai', 'xai', 'gemini') || '', capability: 'deep_reasoning', stage: 'review' },
    { role: 'CHE Office Boss', provider: 'che', capability: 'synthesis', stage: 'synthesize' },
  ];
  return {
    objective: String(objective || '').slice(0, 2000),
    steps,
    missing: requestedFamilies.filter((id) => !available.has(id)),
  };
}

export function providerLabel(id) {
  return {
    openai: 'OpenAI', xai: 'Grok', gemini: 'Gemini', anthropic: 'Claude',
    huggingface: 'Llama', ollama: 'Local', cloudflare: 'Cloudflare', groq: 'Groq',
  }[id] || String(id || 'Model');
}
