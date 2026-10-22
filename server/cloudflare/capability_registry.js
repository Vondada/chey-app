// CHE capability registry (owner, 2026-10-22: "knowledge must become capability"). The one record of what CHE can
// actually do. A source, an indexed note or a description is never a capability: only an entry that passed every
// promotion check is VERIFIED/AVAILABLE, and only those may be used or claimed as working.
//
// Shared contract for the Capability Engine, the internal renderer and Security Intelligence: each registers its
// capabilities here and nowhere else.

export const CAPABILITY_REGISTRY_KEY = 'che:capabilities_v1';

export const STATUSES = Object.freeze(['DISCOVERED', 'INDEXED', 'UNDERSTOOD', 'PROTOTYPED', 'TESTING', 'VERIFIED', 'AVAILABLE', 'DEGRADED', 'RETIRED', 'REJECTED']);
export const USABLE = new Set(['VERIFIED', 'AVAILABLE']);

/** Where a capability runs: CHE's own code first, then the owner's compute, then an approved external service. */
export const EXECUTION = Object.freeze({
  INTERNAL: 'internal',            // CHE's own code in the Worker or the app
  LOCAL: 'local',                  // the owner's device (OS services, on-device runtime)
  OWNER_COMPUTE: 'owner_compute',  // compute the owner controls (his GitHub Actions runners, his R2)
  EXTERNAL_FREE: 'external_free',  // a free/open service, only with the owner's approval
  EXTERNAL_PAID: 'external_paid',  // a paid service, only when necessary and approved
});
export const EXECUTION_ORDER = Object.freeze([EXECUTION.INTERNAL, EXECUTION.LOCAL, EXECUTION.OWNER_COMPUTE, EXECUTION.EXTERNAL_FREE, EXECUTION.EXTERNAL_PAID]);

/** Every check a candidate must pass before promotion. */
export const PROMOTION_CHECKS = Object.freeze(['functional', 'security', 'resource', 'license', 'output', 'regression', 'rollback']);

const clip = (v, n) => String(v ?? '').slice(0, n);

/** A capability record. Defaults are the least privilege: no network, no credentials, owner approval required. */
export function capability(def = {}) {
  const id = clip(def.capability_id || def.id, 80).replace(/[^\w.:-]/g, '');
  if (!id) throw new Error('A capability needs an id.');
  return {
    capability_id: id,
    name: clip(def.name || id, 80),
    description: clip(def.description, 400),
    category: clip(def.category || 'general', 40),
    inputs: Array.isArray(def.inputs) ? def.inputs.slice(0, 20) : [],
    outputs: Array.isArray(def.outputs) ? def.outputs.slice(0, 20) : [],
    implementation_location: clip(def.implementation_location, 200),
    execution: EXECUTION_ORDER.includes(def.execution) ? def.execution : EXECUTION.INTERNAL,
    required_runtime: clip(def.required_runtime || 'cloudflare-worker', 80),
    required_compute: clip(def.required_compute || 'worker-cpu', 80),
    required_storage: clip(def.required_storage || 'none', 80),
    required_permissions: Array.isArray(def.required_permissions) ? def.required_permissions.slice(0, 20) : [],
    permissions: {
      files: [], projects: [], network: [], credentials: [], devices: [], actions: [],
      ...(def.permissions || {}),
    },
    risk_level: ['low', 'medium', 'high'].includes(def.risk_level) ? def.risk_level : 'medium',
    approval_policy: def.approval_policy || 'owner',
    license_profile: clip(def.license_profile || 'original CHE code', 200),
    security_profile: clip(def.security_profile, 200),
    version: Number.isInteger(def.version) ? def.version : 1,
    status: STATUSES.includes(def.status) && !USABLE.has(def.status) ? def.status : 'PROTOTYPED',
    checks: {},
    test_status: 'untested',
    last_verified: null,
    runs: 0,
    successes: 0,
    known_limitations: Array.isArray(def.known_limitations) ? def.known_limitations.slice(0, 20) : [],
    fallbacks: Array.isArray(def.fallbacks) ? def.fallbacks.slice(0, 10) : [],
    related_knowledge: Array.isArray(def.related_knowledge) ? def.related_knowledge.slice(0, 40) : [],
    related_loops: Array.isArray(def.related_loops) ? def.related_loops.slice(0, 40) : [],
    history: [],
  };
}

export function emptyRegistry() { return { v: 1, capabilities: {} }; }

export async function loadRegistry(storage) {
  let saved = null;
  try { saved = await storage.get(CAPABILITY_REGISTRY_KEY); } catch (_) { saved = null; }
  return saved && saved.capabilities ? saved : emptyRegistry();
}
export async function saveRegistry(storage, registry) { await storage.put(CAPABILITY_REGISTRY_KEY, registry); }

/** Adds or replaces a candidate. A new version starts unverified; the previous verified version is kept for rollback. */
export function register(registry, def, now = new Date().toISOString()) {
  const cap = capability(def);
  const prev = registry.capabilities[cap.capability_id];
  if (prev) {
    cap.version = Math.max(cap.version, (prev.version || 1) + 1);
    cap.previous = USABLE.has(prev.status) ? { ...prev, previous: undefined, history: [] } : prev.previous || null;
    cap.history = [...(prev.history || [])];
    // Until the new version is promoted, the verified one keeps serving.
    if (USABLE.has(prev.status)) cap.serving = prev.version;
  }
  cap.history = [{ at: now, event: 'registered', version: cap.version }, ...cap.history].slice(0, 30);
  registry.capabilities[cap.capability_id] = cap;
  return cap;
}

/** Records one promotion check result with its evidence. */
export function recordCheck(registry, id, check, { ok, evidence = '' }, now = new Date().toISOString()) {
  const cap = registry.capabilities[id];
  if (!cap || !PROMOTION_CHECKS.includes(check)) return { ok: false, reason: 'unknown' };
  cap.checks[check] = { ok: ok === true, evidence: clip(evidence, 300), at: now };
  if (cap.status === 'PROTOTYPED') cap.status = 'TESTING';
  return { ok: true, cap };
}

/**
 * Promotion gate: every check passed → VERIFIED (or AVAILABLE once used successfully). Any failed check → REJECTED,
 * and a rejected candidate is never served: the previous verified version, if any, keeps serving.
 */
export function promote(registry, id, now = new Date().toISOString()) {
  const cap = registry.capabilities[id];
  if (!cap) return { ok: false, reason: 'unknown' };
  const missing = PROMOTION_CHECKS.filter((c) => !cap.checks[c]);
  const failed = PROMOTION_CHECKS.filter((c) => cap.checks[c] && !cap.checks[c].ok);
  if (failed.length) {
    cap.status = 'REJECTED';
    cap.history.unshift({ at: now, event: 'rejected', failed });
    return { ok: false, reason: 'failed_checks', failed, serving: cap.previous ? cap.previous.version : null };
  }
  if (missing.length) return { ok: false, reason: 'missing_checks', missing };
  cap.status = 'VERIFIED';
  cap.test_status = 'passed';
  cap.last_verified = now;
  delete cap.serving;
  cap.history.unshift({ at: now, event: 'promoted', version: cap.version });
  return { ok: true, cap };
}

/** Back to the previous verified version. */
export function rollback(registry, id, now = new Date().toISOString()) {
  const cap = registry.capabilities[id];
  if (!cap?.previous) return { ok: false, reason: 'no_previous_version' };
  const back = { ...cap.previous, history: [{ at: now, event: 'rolled_back', from: cap.version }, ...(cap.history || [])].slice(0, 30) };
  registry.capabilities[id] = back;
  return { ok: true, cap: back };
}

/** The version that serves requests now, or null: never an unverified or rejected candidate. */
export function serving(registry, id) {
  const cap = registry.capabilities[id];
  if (!cap) return null;
  if (USABLE.has(cap.status)) return cap;
  return cap.previous && USABLE.has(cap.previous.status) ? cap.previous : null;
}

/** Records a real use; repeated success makes a verified capability AVAILABLE, repeated failure DEGRADED. */
export function recordUse(registry, id, ok, now = new Date().toISOString()) {
  const cap = serving(registry, id);
  if (!cap) return null;
  cap.runs++;
  if (ok) cap.successes++;
  cap.last_used = now;
  if (ok && cap.status === 'VERIFIED' && cap.successes >= 1) cap.status = 'AVAILABLE';
  if (cap.runs >= 4 && cap.successes / cap.runs < 0.5) cap.status = 'DEGRADED';
  return cap;
}

/**
 * May this capability run under the owner's policy? Internal-only mode allows only CHE's own code and the owner's
 * device or compute; anything external needs the owner's approval for that dependency.
 */
export function executionAllowed(cap, policy = {}) {
  if (!cap || !USABLE.has(cap.status)) return { ok: false, reason: 'not a verified capability' };
  if (policy.internal_only && ![EXECUTION.INTERNAL, EXECUTION.LOCAL, EXECUTION.OWNER_COMPUTE].includes(cap.execution)) {
    return { ok: false, reason: 'internal-only mode is on and this capability runs on an external service' };
  }
  if (policy.no_paid && cap.execution === EXECUTION.EXTERNAL_PAID) return { ok: false, reason: 'paid services are turned off' };
  if ([EXECUTION.EXTERNAL_FREE, EXECUTION.EXTERNAL_PAID].includes(cap.execution) && !(policy.approved_external || []).includes(cap.capability_id)) {
    return { ok: false, reason: 'this external dependency has not been approved', needs_approval: true };
  }
  return { ok: true };
}

/** What CHE may say about a capability: never "I can" for anything not verified. */
export function speakCapability(cap) {
  if (!cap) return 'I do not have that capability.';
  const where = { internal: 'with my own code', local: 'on your device', owner_compute: 'on compute you control', external_free: 'through an approved free service', external_paid: 'through an approved paid service' }[cap.execution];
  if (USABLE.has(cap.status)) return `I can ${cap.name.toLowerCase()} ${where}; verified ${String(cap.last_verified || '').slice(0, 10)}${cap.known_limitations.length ? `. Limits: ${cap.known_limitations.join('; ')}` : ''}.`;
  return `${cap.name} is ${cap.status.toLowerCase()}, not a working capability yet.`;
}
