// CHE automatic model discovery + Model Watcher.
//
// For connected providers with an official model-list endpoint (xAI, OpenAI,
// Gemini's OpenAI-compatible API, Anthropic, Hugging Face router, Groq, …, or
// a local Ollama server) CHE refreshes the catalog on a gentle interval.
// Newly seen models enter a *candidate* state, get a lightweight capability
// evaluation, and are promoted into routing only when the provider is already
// authorized, the checks pass, and owner cost/privacy policy allows it.
// Providers that are not connected are never called: they only show
// "available to connect".

import {
  allManifests, ensureAiState, normalizeModelRecord, providerBaseUrl,
  providerConnection, providerCredential,
} from './provider_registry.js';

export const WATCH_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice a day at most
const COST_ORDER = ['free', 'low', 'medium', 'high'];

function authHeaders(env, manifest) {
  const credential = providerCredential(env, manifest);
  if (manifest.id === 'ollama') {
    const token = String(env.CHE_OLLAMA_TOKEN || '');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  if (manifest.id === 'anthropic') {
    return credential ? { 'x-api-key': credential, 'anthropic-version': '2023-06-01' } : {};
  }
  return credential ? { Authorization: `Bearer ${credential}` } : {};
}

function rowsFrom(method, body) {
  if (method === 'ollama_tags') {
    return (Array.isArray(body?.models) ? body.models : []).map((m) => ({ id: m.name || m.model }));
  }
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  return list.map((m) => ({
    id: String(m.id || m.name || '').replace(/^models\//, ''),
    created: m.created || (m.created_at ? Date.parse(m.created_at) / 1000 : null),
    context_window: m.context_window || m.context_length || m.inputTokenLimit || null,
  }));
}

// Calls one provider's official model-list endpoint. Returns normalized records.
export async function discoverModels(env, data, manifest, fetcher = fetch) {
  const method = manifest.discovery?.method;
  if (!['openai_models', 'gemini_models', 'ollama_tags', 'huggingface_models'].includes(method)) {
    return { provider: manifest.id, status: 'no_discovery', models: [] };
  }
  const connection = providerConnection(env, data, manifest);
  if (connection.state !== 'connected') {
    return { provider: manifest.id, status: connection.state, models: [] };
  }
  const base = providerBaseUrl(env, manifest);
  if (!base) return { provider: manifest.id, status: 'no_base_url', models: [] };
  const url = `${base}${manifest.discovery.path || '/models'}`;
  try {
    const response = await fetcher(url, {
      headers: { Accept: 'application/json', ...authHeaders(env, manifest) },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { provider: manifest.id, status: `http_${response.status}`, models: [] };
    const body = await response.json().catch(() => null);
    const models = rowsFrom(method, body)
      .filter((row) => row.id)
      .slice(0, 400)
      .map((row) => normalizeModelRecord(manifest, row));
    return { provider: manifest.id, status: 'ok', models };
  } catch (error) {
    return { provider: manifest.id, status: 'error', detail: String(error?.message || error).slice(0, 200), models: [] };
  }
}

// Merges a discovery result into the catalog; new models become candidates.
export function registerDiscovered(data, result, { firstSync = false } = {}) {
  const ai = ensureAiState(data);
  const entry = ai.catalog[result.provider] || { models: [], synced_at: null };
  const known = new Map(entry.models.map((m) => [m.model, m]));
  const fresh = [];
  const isFirst = firstSync || !entry.synced_at;
  for (const record of result.models) {
    if (known.has(record.model)) {
      const existing = known.get(record.model);
      Object.assign(existing, { ...record, status: existing.status });
      continue;
    }
    // On the very first sync the whole catalog is the baseline, not "new".
    const model = { ...record, status: isFirst ? 'active' : 'candidate', discovered_at: new Date().toISOString() };
    entry.models.push(model);
    if (!isFirst) fresh.push(model);
  }
  entry.synced_at = new Date().toISOString();
  entry.models = entry.models.slice(-400);
  ai.catalog[result.provider] = entry;
  for (const model of fresh) {
    if (!ai.candidates.some((c) => c.key === model.key)) {
      ai.candidates.unshift({ key: model.key, provider: model.provider, model: model.model, status: 'candidate', discovered_at: model.discovered_at });
    }
  }
  ai.candidates = ai.candidates.slice(0, 60);
  return fresh;
}

// ─── Candidate evaluation ──────────────────────────────────────────────────

const PROBES = [
  { name: 'reasoning', prompt: 'A train leaves at 3:40 PM and the trip takes 2 hours 35 minutes. What time does it arrive? Answer with just the time.', check: (t) => /6:15/.test(t) },
  { name: 'coding', prompt: 'Write a JavaScript function add(a, b) that returns their sum. Reply with code only.', check: (t) => /function\s+add|const\s+add|add\s*=\s*\(/.test(t) && /return|=>/.test(t) },
  { name: 'instruction_following', prompt: 'Reply with exactly the single word: HORIZON', check: (t) => /^\W*horizon\W*$/i.test(t.trim()) },
  { name: 'context_handling', prompt: `Remember the code word "amber-47". ${'Filler sentence for context. '.repeat(60)} What was the code word? Reply with only the code word.`, check: (t) => /amber-47/i.test(t) },
];

// Runs lightweight probes through the caller-supplied `ask(model, prompt)`.
// Stores a result the owner can inspect. Never promotes on its own.
export async function evaluateCandidate(candidate, ask, { vision = false } = {}) {
  const results = [];
  let latencyTotal = 0;
  let failures = 0;
  for (const probe of PROBES) {
    const started = Date.now();
    try {
      const text = String(await ask(candidate, probe.prompt) || '');
      const ms = Date.now() - started;
      latencyTotal += ms;
      results.push({ name: probe.name, passed: probe.check(text), latency_ms: ms });
    } catch (error) {
      failures += 1;
      results.push({ name: probe.name, passed: false, error: String(error?.message || error).slice(0, 160) });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  const avgLatency = results.length - failures ? Math.round(latencyTotal / (results.length - failures)) : null;
  return {
    key: candidate.key,
    provider: candidate.provider,
    model: candidate.model,
    evaluated_at: new Date().toISOString(),
    probes: results,
    tool_calling: 'not_probed',
    vision: vision ? 'declared_not_probed' : 'not_applicable',
    score: Number((passed / PROBES.length).toFixed(2)),
    avg_latency_ms: avgLatency,
    reliability: Number(((results.length - failures) / results.length).toFixed(2)),
    passed: passed >= 3 && failures <= 1,
  };
}

// Decides promotion under owner policy. Returns { promote, reason }.
export function promotionDecision(env, data, candidate, evaluation) {
  const ai = ensureAiState(data);
  const manifest = allManifests(data).find((m) => m.id === candidate.provider);
  if (!manifest) return { promote: false, reason: 'Unknown provider.' };
  if (providerConnection(env, data, manifest).state !== 'connected') return { promote: false, reason: 'Provider is not authorized.' };
  if (!evaluation?.passed) return { promote: false, reason: 'Did not pass capability checks.' };
  if (!ai.policy.auto_promote_models) return { promote: false, reason: 'Owner policy requires manual promotion.' };
  const record = ai.catalog[candidate.provider]?.models.find((m) => m.model === candidate.model);
  const cost = record?.cost_class || manifest.cost_class;
  if (COST_ORDER.indexOf(cost) > COST_ORDER.indexOf(ai.policy.max_cost_class || 'high')) {
    return { promote: false, reason: `Cost class ${cost} exceeds owner limit.` };
  }
  if (ai.policy.local_only && manifest.locality !== 'local') return { promote: false, reason: 'Owner is in local-only mode.' };
  return { promote: true, reason: 'Passed checks within owner cost/privacy policy.' };
}

export function applyEvaluation(env, data, evaluation) {
  const ai = ensureAiState(data);
  const candidate = ai.candidates.find((c) => c.key === evaluation.key);
  if (!candidate) return { error: 'Candidate not found.' };
  ai.evaluations = [evaluation, ...ai.evaluations.filter((e) => e.key !== evaluation.key)].slice(0, 80);
  const decision = promotionDecision(env, data, candidate, evaluation);
  const record = ai.catalog[candidate.provider]?.models.find((m) => m.model === candidate.model);
  candidate.evaluated_at = evaluation.evaluated_at;
  candidate.score = evaluation.score;
  candidate.decision = decision.reason;
  if (decision.promote) {
    candidate.status = 'promoted';
    // Gradual rollout: a promoted model starts in "trial" routing weight.
    if (record) { record.status = 'active'; record.promoted_at = new Date().toISOString(); record.trial_until = Date.now() + 3 * 24 * 60 * 60 * 1000; }
    ai.notices.unshift({ at: new Date().toISOString(), text: `New model ${candidate.model} from ${candidate.provider} passed checks and is now in trial routing.` });
  } else {
    candidate.status = evaluation.passed ? 'awaiting_owner' : 'rejected';
    if (record) record.status = candidate.status === 'rejected' ? 'rejected' : 'candidate';
  }
  return { candidate, decision };
}

export function promoteManually(data, key, ownerApproved) {
  if (ownerApproved !== true) return { error: 'Owner approval required.' };
  const ai = ensureAiState(data);
  const candidate = ai.candidates.find((c) => c.key === key);
  if (!candidate) return { error: 'Candidate not found.' };
  candidate.status = 'promoted';
  const record = ai.catalog[candidate.provider]?.models.find((m) => m.model === candidate.model);
  if (record) { record.status = 'active'; record.promoted_at = new Date().toISOString(); record.trial_until = Date.now() + 3 * 24 * 60 * 60 * 1000; }
  return { candidate };
}

// ─── Model Watcher ─────────────────────────────────────────────────────────

// Refreshes connected catalogs at most every WATCH_INTERVAL_MS, registers
// candidates and (optionally) evaluates up to `evaluateLimit` of them.
export async function runModelWatcher(env, data, {
  fetcher = fetch, ask = null, now = Date.now(), force = false, evaluateLimit = 2,
} = {}) {
  const ai = ensureAiState(data);
  if (!force && now - Number(ai.watcher.last_run_at || 0) < WATCH_INTERVAL_MS) {
    return { status: 'skipped', next_run_at: Number(ai.watcher.last_run_at) + WATCH_INTERVAL_MS };
  }
  ai.watcher.last_run_at = now;
  ai.watcher.runs = Number(ai.watcher.runs || 0) + 1;
  const providers = [];
  const newModels = [];
  const availableToConnect = [];
  for (const manifest of allManifests(data)) {
    const connection = providerConnection(env, data, manifest);
    if (connection.state !== 'connected') {
      availableToConnect.push({ id: manifest.id, state: connection.state, how_to_connect: manifest.connect_hint });
      continue;
    }
    const result = await discoverModels(env, data, manifest, fetcher);
    providers.push({ id: manifest.id, status: result.status, models: result.models.length });
    if (result.status === 'ok') newModels.push(...registerDiscovered(data, result));
  }
  const evaluated = [];
  if (ask) {
    for (const candidate of ai.candidates.filter((c) => c.status === 'candidate').slice(0, evaluateLimit)) {
      const evaluation = await evaluateCandidate(candidate, ask);
      evaluated.push(applyEvaluation(env, data, evaluation));
    }
  }
  ai.watcher.last_result = {
    at: new Date(now).toISOString(),
    providers,
    new_models: newModels.map((m) => m.key),
    evaluated: evaluated.map((e) => e.candidate?.key).filter(Boolean),
  };
  return { status: 'ran', providers, new_models: newModels, evaluated, available_to_connect: availableToConnect };
}

export function newestModel(data) {
  const ai = ensureAiState(data);
  const all = Object.values(ai.catalog).flatMap((c) => c.models || []);
  const discovered = all.filter((m) => m.discovered_at && m.status !== 'rejected')
    .sort((a, b) => Date.parse(b.discovered_at) - Date.parse(a.discovered_at));
  if (discovered.length) return discovered[0];
  return all.filter((m) => m.created).sort((a, b) => b.created - a.created)[0] || null;
}
