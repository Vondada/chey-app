// AI Model Status for the Keys tab (owner rule, 2026-10-27: $0 authorized AI spend). Reads the
// coding runner's model ledger (mailbox/runtime/model-ledger.json on che-mailbox) and turns it,
// with the provider billing policies in model_router.mjs, into rows the app shows and reads aloud.
// No key value ever leaves the server: only whether one is configured. Nothing is called
// connected, free or billed unless the ledger holds the runner's verified evidence for it.
import { gh } from './coding_runtime.js';
import { PROVIDER_POLICIES, modelStatusView, speakModelStatus } from './model_router.mjs';

export const MODEL_LEDGER_PATH = 'mailbox/runtime/model-ledger.json';
const CACHE_KEY = 'ai_model_status_cache';
const CACHE_MS = 5 * 60_000;
// The Keys tab waits for this route; a slow GitHub read must not hold it.
const READ_TIMEOUT_MS = 4000;

function decode(content) {
  const binary = atob(String(content || '').replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

export async function readModelLedger(env, { fetcher = fetch, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const read = gh(env, 'GET', `/contents/${MODEL_LEDGER_PATH}?ref=che-mailbox`, null, fetcher);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, status: 0, timeout: true }), timeoutMs); });
  const found = await Promise.race([read, timeout]).finally(() => clearTimeout(timer));
  if (found.status === 404) return { ledger: null, source: 'none_yet' };
  if (!found.ok || !found.data?.content) return { ledger: null, source: 'unavailable' };
  try {
    return { ledger: JSON.parse(decode(found.data.content)), source: 'che-mailbox' };
  } catch (_) {
    return { ledger: null, source: 'unreadable' };
  }
}

// Which provider keys the Worker itself holds (true/false only).
export function workerKeyPresence(env = {}) {
  const out = {};
  for (const policy of PROVIDER_POLICIES) {
    const names = policy.id === 'openai' ? ['OPENAI_API_KEY', 'CHE_OPENAI_API_KEY'] : [policy.secret];
    out[policy.id] = names.some((name) => Boolean(String(env?.[name] || '').trim()));
  }
  return out;
}

export async function aiModelStatus(env, storage, { fetcher = fetch, now = Date.now(), fresh = false } = {}) {
  if (!fresh) {
    try {
      const cached = await storage?.get?.(CACHE_KEY);
      if (cached && now - Number(cached.cached_at || 0) < CACHE_MS && cached.view) return cached.view;
    } catch (_) { /* a cache miss reads the ledger */ }
  }
  const { ledger, source } = await readModelLedger(env, { fetcher });
  const view = modelStatusView({ ledger, workerKeys: workerKeyPresence(env), now, env });
  view.ledger_source = source;
  view.spoken = speakModelStatus(view);
  try { await storage?.put?.(CACHE_KEY, { cached_at: now, view }); } catch (_) { /* status still returned */ }
  return view;
}

// "AI model status", "which AI models are free?": the same view, spoken, for voice or typing (Codex, PR #685).
// It names AI or coding models or providers, so a 3D model or a drone model never lands here.
const MODEL_STATUS_RE = /\b(?:ai|coding)\s+(?:models?|providers?)\b(?:\s+\w+){0,3}?\s+(?:status|free|cost|costs|available|verified|paused|working|ledger)\b|\b(?:ai\s+)?model\s+status\b|\b(?:status|read|show|list)\b(?:\s+\w+){0,3}?\s+(?:ai|coding)\s+(?:models?|providers?)\b|\b(?:which|what)\s+(?:ai|coding)\s+(?:models?|providers?)\b/i;

export function modelStatusIntent(message) {
  return MODEL_STATUS_RE.test(String(message || ''));
}

/** The chat turn: owner only, 0 model calls; an unreadable ledger is said, never filled in. */
export async function modelStatusTurn(env, storage, ownerDevice, opts) {
  if (!ownerDevice) return { reply: 'Only the CHE owner can read the AI model status, sir.', meta: { source: 'che_model_status', ok: false, model_calls: 0 } };
  const view = await aiModelStatus(env, storage, opts).catch(() => null);
  return view
    ? { reply: view.spoken, meta: { source: 'che_model_status', ok: true, model_calls: 0, ledger_source: view.ledger_source } }
    : { reply: 'I could not read the AI model status right now, sir. Nothing was changed.', meta: { source: 'che_model_status', ok: false, model_calls: 0 } };
}
