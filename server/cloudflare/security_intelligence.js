// Security Intelligence (owner, 2026-10-22): defense in depth over what CHE already has (device pairing and its
// failure limits, device revocation, lockdown, the money/delete and app gates, privacy_policy redaction, the Face ID
// vault on the phone). It never claims CHE is unhackable, never names an attacker without evidence, never probes a
// system CHE does not own, and never runs an unknown executable.
//
// One storage key holds its state: findings (never the secret itself), authorization sessions, nonces, telemetry
// counters, quarantine, trusted snapshots metadata and the audit log.
import { setLockdown, isLockedDown } from './resilience.js';
// The generic engines live in the portable Security Core (security_core/); this module is CHE's adapter over them
// and keeps its exports so existing callers are unchanged.
import { redact, redactDeep, scanSecrets } from './security_core/secrets.js';
import { sha256 } from './security_core/supply_chain.js';
export { BROAD_SECRET_RE, guardModelInput, looksSecret, redact, redactDeep, scanSecrets } from './security_core/secrets.js';
export { ADVISORIES, checkTargetIdentity, checkToolAccess, dependencyAdvisories, inspectArtifacts, inspectFile, mayExecute, reviewGeneratedCode, securityCheckForCapability, sha256 } from './security_core/supply_chain.js';

export const SECURITY_KEY = 'che:security_v1';
export const SNAPSHOT_KEY = 'che:trusted_snapshot_v1';
const MAX_EVENTS = 200;
const SESSION_TTL_MS = 10 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;

const clip = (v, n) => String(v ?? '').slice(0, n);

// ─── State ──────────────────────────────────────────────────────────────────

export function emptySecurity() {
  return { v: 1, events: [], sessions: {}, nonces: {}, counters: {}, quarantine: [], audit: [] };
}

export async function loadSecurity(storage) {
  let saved = null;
  try { saved = await storage.get(SECURITY_KEY); } catch (_) { saved = null; }
  return saved && typeof saved === 'object' ? { ...emptySecurity(), ...saved } : emptySecurity();
}

export async function saveSecurity(storage, state) {
  pruneSecurity(state);
  await storage.put(SECURITY_KEY, state);
}

function pruneSecurity(state, now = Date.now()) {
  state.events = (state.events || []).slice(0, MAX_EVENTS);
  state.audit = (state.audit || []).slice(0, 100);
  for (const [n, at] of Object.entries(state.nonces || {})) if (now - at > NONCE_TTL_MS * 2) delete state.nonces[n];
  for (const [id, s] of Object.entries(state.sessions || {})) if (s.revoked_at || s.expires_at < now - 86_400_000) delete state.sessions[id];
  for (const k of Object.keys(state.counters || {})) if (Number(k.split(':').pop()) < Math.floor(now / 3_600_000) - 48) delete state.counters[k];
}

function audit(state, action, detail, now = new Date().toISOString()) {
  state.audit = [{ at: now, action, detail: clip(detail, 200) }, ...(state.audit || [])].slice(0, 100);
}

/** One security event. `evidence` is what was observed; there is never a guess about who did it. */
export function recordEvent(state, { type, severity = 'info', classification = 'benign', evidence = '', source = '' }, now = new Date().toISOString()) {
  const event = { id: crypto.randomUUID().slice(0, 12), at: now, type: clip(type, 60), severity, classification, evidence: clip(redact(evidence).text, 300), source: clip(source, 60) };
  state.events = [event, ...(state.events || [])].slice(0, MAX_EVENTS);
  return event;
}

/** Records secret findings from one place (prompt, log, export…): the kinds and where, never the values. */
export function recordFindings(state, where, kinds, now) {
  if (!kinds.length) return null;
  return recordEvent(state, { type: 'secret_redacted', severity: 'medium', classification: 'contained', evidence: `${kinds.length} credential-shaped value(s) (${[...new Set(kinds)].join(', ')}) were redacted from ${where}.`, source: where }, now);
}

/** Hourly counters of authorized telemetry (pair failures, unknown tokens, errors). */
export function bump(state, name, now = Date.now()) {
  const key = `${name}:${Math.floor(now / 3_600_000)}`;
  state.counters[key] = (state.counters[key] || 0) + 1;
  return state.counters[key];
}

function counted(state, name, hours = 1, now = Date.now()) {
  const h = Math.floor(now / 3_600_000);
  let n = 0;
  for (let i = 0; i < hours; i++) n += state.counters?.[`${name}:${h - i}`] || 0;
  return n;
}

// ─── Authorization sessions (Face ID result → scoped session) ───────────────

// Fields that would mean biometric material left the phone. The phone sends only the operating system's yes/no.
const BIOMETRIC_FIELDS = /^(?:template|face|faceprint|image|photo|biometric_data|raw|embedding|depth|scan|fingerprint_image)$/i;
export const SESSION_SCOPES = Object.freeze(['vault', 'security', 'external_dependency', 'restore', 'lockdown_off', 'credentials']);

/** Single-use challenge the phone signs into its session request (replay resistance). */
export function issueNonce(state, now = Date.now()) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  state.nonces[nonce] = now;
  return nonce;
}

/**
 * A scoped session from the phone's biometric result. Only `{ ok, method }` is accepted: anything that looks like
 * biometric material is refused outright. Failed or cancelled Face ID creates nothing. Sessions are bound to the
 * paired device, expire, and each nonce works once.
 */
export function createSession(state, { deviceHash, assertion = {}, scope = [], nonce = '' }, now = Date.now()) {
  if (Object.keys(assertion || {}).some((k) => BIOMETRIC_FIELDS.test(k))) return { ok: false, reason: 'biometric_material_refused' };
  if (assertion?.ok !== true || !['face_id', 'touch_id', 'device_passcode', 'passkey'].includes(assertion.method)) return { ok: false, reason: 'not_authenticated' };
  if (!deviceHash) return { ok: false, reason: 'no_device' };
  const issued = state.nonces[nonce];
  if (!issued) return { ok: false, reason: 'unknown_or_used_nonce' };
  delete state.nonces[nonce];
  if (now - issued > NONCE_TTL_MS) return { ok: false, reason: 'nonce_expired' };
  const scopes = [...new Set((Array.isArray(scope) ? scope : [scope]).filter((s) => SESSION_SCOPES.includes(s)))];
  if (!scopes.length) return { ok: false, reason: 'no_scope' };
  const id = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  // Two factors: the paired device token (possession) and the OS biometric/passcode result (inherence/knowledge).
  state.sessions[id] = { device: deviceHash, scopes, factors: ['device', assertion.method], created_at: now, expires_at: now + SESSION_TTL_MS, revoked_at: null };
  audit(state, 'session_created', `${assertion.method} for ${scopes.join(', ')}`);
  return { ok: true, session: id, expires_at: now + SESSION_TTL_MS, scopes };
}

/** A session is valid only on its own device, within its time, for its own scope, with two factors. */
export function checkSession(state, id, { deviceHash, scope }, now = Date.now()) {
  const s = state.sessions?.[String(id || '')];
  if (!s) return { ok: false, reason: 'no_session' };
  if (s.revoked_at) return { ok: false, reason: 'revoked' };
  if (now > s.expires_at) return { ok: false, reason: 'expired' };
  if (s.device !== deviceHash) return { ok: false, reason: 'wrong_device' };
  if (!s.scopes.includes(scope)) return { ok: false, reason: 'out_of_scope' };
  if (!(s.factors.includes('device') && s.factors.length >= 2)) return { ok: false, reason: 'mfa_required' };
  return { ok: true };
}

export function revokeSessions(state, { deviceHash = null } = {}, now = Date.now()) {
  let n = 0;
  for (const s of Object.values(state.sessions || {})) {
    if (!s.revoked_at && (!deviceHash || s.device === deviceHash)) { s.revoked_at = now; n++; }
  }
  audit(state, 'sessions_revoked', `${n} session(s)`);
  return n;
}

// ─── THREAT DETECTION LOOP ──────────────────────────────────────────────────

/**
 * Collect → normalise → compare with expected behaviour → classify → record. Only CHE's own telemetry is read:
 * pairing failures, unknown tokens, error counts, devices, the deploy commit, the capability registry and secret
 * findings. Words like "attacker" are never used; an event says what was observed.
 */
export function detectThreats(state, { data = {}, deploy = null, registry = null, advisories = null } = {}, now = Date.now()) {
  const found = [];
  const add = (e) => found.push(recordEvent(state, e, new Date(now).toISOString()));
  const pairFailures = Object.values(data.failures || {}).reduce((n, t) => n + (Array.isArray(t) ? t.filter((x) => now - x < 3_600_000).length : 0), 0);
  if (pairFailures >= 10) add({ type: 'pairing_failures', severity: 'high', classification: 'suspicious', evidence: `${pairFailures} wrong pairing codes in the last hour from ${Object.keys(data.failures || {}).length} address(es); pairing is rate-limited.`, source: 'pairing' });
  else if (pairFailures >= 3) add({ type: 'pairing_failures', severity: 'low', classification: 'benign', evidence: `${pairFailures} wrong pairing codes in the last hour.`, source: 'pairing' });
  const unknown = counted(state, 'unknown_token', 1, now);
  if (unknown >= 20) add({ type: 'unknown_tokens', severity: 'medium', classification: 'suspicious', evidence: `${unknown} requests with an unknown device token in the last hour; all were refused.`, source: 'auth' });
  const revokedUse = counted(state, 'revoked_device', 24, now);
  if (revokedUse) add({ type: 'revoked_device_use', severity: 'medium', classification: 'suspicious', evidence: `A revoked device tried to connect ${revokedUse} time(s) in the last day; it was refused.`, source: 'auth' });
  const errors = counted(state, 'server_error', 1, now);
  const baseline = Math.max(1, counted(state, 'server_error', 24, now) / 24);
  if (errors >= 10 && errors > baseline * 5) add({ type: 'error_spike', severity: 'medium', classification: 'suspicious', evidence: `${errors} server errors in the last hour against about ${Math.round(baseline)} per hour normally.`, source: 'worker' });
  const recentDevices = Object.values(data.platform?.devices || {}).filter((d) => d && !d.revoked_at && Date.parse(d.created_at || 0) > now - 86_400_000);
  if (recentDevices.length) add({ type: 'new_device', severity: recentDevices.length > 2 ? 'medium' : 'info', classification: recentDevices.length > 2 ? 'suspicious' : 'benign', evidence: `${recentDevices.length} device(s) paired in the last day: ${recentDevices.map((d) => clip(d.name, 40)).join(', ')}.`, source: 'devices' });
  const sameCommit = deploy && (String(deploy.live_sha).startsWith(String(deploy.expected_sha).slice(0, 12)) || String(deploy.expected_sha).startsWith(String(deploy.live_sha).slice(0, 12)));
  if (deploy?.live_sha && deploy.expected_sha && !sameCommit && deploy.relation === 'ahead') {
    add({ type: 'deploy_pending', severity: 'info', classification: 'benign', evidence: `main (${clip(deploy.expected_sha, 12)}) is ahead of the live Worker (${clip(deploy.live_sha, 12)}); a deploy has not finished yet.`, source: 'deploy' });
  } else if (deploy?.live_sha && deploy.expected_sha && !sameCommit) {
    add({ type: 'unexpected_deploy', severity: 'high', classification: 'suspicious', evidence: `The live Worker reports commit ${clip(deploy.live_sha, 12)}, which is not on main (${clip(deploy.expected_sha, 12)}; GitHub compare: ${deploy.relation || 'unknown'}).`, source: 'deploy' });
  }
  for (const cap of Object.values(registry?.capabilities || {})) {
    const promoted = (cap.history || []).find((h) => h.event === 'promoted');
    if (['VERIFIED', 'AVAILABLE'].includes(cap.status) && !(cap.checks?.security?.ok)) add({ type: 'unreviewed_capability', severity: 'high', classification: 'suspicious', evidence: `${cap.capability_id} is marked usable without a passing security review${promoted ? '' : ' or a recorded promotion'}.`, source: 'capabilities' });
    if ([].concat(cap.permissions?.network || [], cap.permissions?.credentials || []).includes('*')) add({ type: 'wide_capability_access', severity: 'medium', classification: 'suspicious', evidence: `${cap.capability_id} has wildcard network or credential access.`, source: 'capabilities' });
  }
  const leaks = (state.events || []).filter((e) => e.type === 'secret_redacted' && now - Date.parse(e.at) < 86_400_000).length;
  if (leaks) add({ type: 'secret_exposure_contained', severity: 'medium', classification: 'contained', evidence: `${leaks} redaction(s) in the last day: credential-shaped values were kept out of prompts, logs or exports. Rotate any real key that was pasted.`, source: 'scanner' });
  for (const a of advisories?.advisories || []) add({ type: 'dependency_advisory', severity: a.severity === 'critical' ? 'high' : a.severity, classification: 'suspicious', evidence: `${a.name} ${a.version} matches ${a.id}.`, source: 'dependencies' });
  return found;
}

/** Spoken status: counts and what was seen, never a claim of perfect safety. */
export function speakStatus(state, { lockedDown = false, findings = [] } = {}) {
  const day = (state.events || []).filter((e) => Date.now() - Date.parse(e.at) < 86_400_000);
  const serious = day.filter((e) => ['high', 'critical'].includes(e.severity) && e.classification !== 'benign');
  const parts = [lockedDown ? 'Lockdown is on.' : 'Lockdown is off.'];
  parts.push(serious.length ? `${serious.length} serious security event${serious.length === 1 ? '' : 's'} in the last day: ${serious.slice(0, 3).map((e, i) => `${i + 1}. ${e.evidence}`).join(' ')}` : 'No serious security events in the last day.');
  const sessions = Object.values(state.sessions || {}).filter((s) => !s.revoked_at && s.expires_at > Date.now()).length;
  parts.push(`${sessions} active Face ID session${sessions === 1 ? '' : 's'}.`);
  if (findings.length) parts.push(`This check found: ${findings.slice(0, 4).map((e, i) => `${i + 1}. ${e.evidence}`).join(' ')}`);
  parts.push('This lowers risk; no system can be made unhackable.');
  return parts.join(' ');
}

// ─── Incident response, backup and rollback ─────────────────────────────────

/**
 * Contain → recover: revoke every authorization session (and optionally every other paired device), lock down,
 * list what to rotate (names only), and report what was actually done.
 */
export async function respondToIncident(storage, state, data, { revokeDevices = false, keepDeviceHash = '', revokeDevice = null } = {}) {
  const done = [];
  const n = revokeSessions(state);
  done.push(`revoked ${n} Face ID session${n === 1 ? '' : 's'}`);
  if (revokeDevices && typeof revokeDevice === 'function') {
    let r = 0;
    for (const [hash, d] of Object.entries(data.platform?.devices || {})) {
      if (hash !== keepDeviceHash && !d.revoked_at) { revokeDevice(hash); r++; }
    }
    done.push(`revoked ${r} other paired device${r === 1 ? '' : 's'}`);
  }
  await setLockdown(storage, true);
  done.push('turned lockdown on');
  const rotate = ['CHE_PAIR_CODE', 'CHE_GITHUB_TOKEN', 'model provider keys in the Keys tab', 'broker keys', 'Google sign-ins (reconnect)'];
  const verified = await isLockedDown(storage);
  audit(state, 'incident_response', done.join('; '));
  recordEvent(state, { type: 'incident_response', severity: 'info', classification: 'contained', evidence: `Owner incident response: ${done.join('; ')}.`, source: 'owner' });
  return { done, rotate, verified_lockdown: verified };
}

const TRUSTED_FIELDS = ['capability_policy', 'command_workflows', 'apps_granted'];
const TRUSTED_KEYS = ['che:capabilities_v1', 'che:workflow_engine'];

async function digestJson(v) { return sha256(new TextEncoder().encode(JSON.stringify(v ?? null))); }

/** A snapshot of the trusted configuration (no secrets: keys, tokens and passwords are not part of it). */
export async function snapshotTrustedState(storage, data, now = new Date().toISOString()) {
  const fields = Object.fromEntries(TRUSTED_FIELDS.map((f) => [f, data?.[f] ?? null]));
  const keys = {};
  for (const k of TRUSTED_KEYS) { try { keys[k] = (await storage.get(k)) ?? null; } catch (_) { keys[k] = null; } }
  const body = redactDeep({ fields, keys });
  const snapshot = { at: now, body, sha256: await digestJson(body) };
  await storage.put(SNAPSHOT_KEY, snapshot);
  return { at: now, sha256: snapshot.sha256 };
}

/** Restore only an intact snapshot (its hash must match); anything tampered with is refused. */
export async function restoreTrustedState(storage, data) {
  let snap = null;
  try { snap = await storage.get(SNAPSHOT_KEY); } catch (_) { snap = null; }
  if (!snap?.body) return { ok: false, reason: 'no_snapshot' };
  if ((await digestJson(snap.body)) !== snap.sha256) return { ok: false, reason: 'snapshot_tampered' };
  for (const f of TRUSTED_FIELDS) data[f] = snap.body.fields[f];
  for (const k of TRUSTED_KEYS) { if (snap.body.keys[k] == null) await storage.delete(k); else await storage.put(k, snap.body.keys[k]); }
  return { ok: true, at: snap.at };
}

// ─── External calls ─────────────────────────────────────────────────────────

// Internal-only mode is enforced on every outbound request CHE's Worker makes: one guard wraps fetch. CHE's own
// origin and the owner's own compute (his GitHub repository and Actions, his Cloudflare account) stay reachable;
// every other host (model providers, search, media, brokers, any API) is refused before a byte leaves. Workers AI
// runs through the Cloudflare binding, not fetch, so CHE keeps an answer engine inside its own runtime.
export const EGRESS_KEY = 'che:egress_policy';
export const OWNER_COMPUTE_HOSTS = Object.freeze(['api.github.com', 'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'codeload.github.com', 'api.cloudflare.com']);
const EGRESS = { internalOnly: false, selfHosts: new Set(), ownerHosts: new Set(), ownerRepo: '', blocked: 0, holds: 0 };

/** The owner's own compute from the Worker env: his repository (only it, on api.github.com) and his model/compute servers. */
export function setEgressOwner(env = {}) {
  EGRESS.ownerRepo = String(env.CHE_GITHUB_REPO || '').toLowerCase();
  for (const own of [env.CHE_OLLAMA_URL, env.CHE_OWNER_COMPUTE_URL]) {
    try { if (own) EGRESS.ownerHosts.add(new URL(own).hostname); } catch (_) {}
  }
}

/** Hosts the owner controls. With his repository known, api.github.com is reachable for that repository only. */
export function ownerHost(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return false; }
  if (EGRESS.selfHosts.has(u.hostname) || EGRESS.ownerHosts.has(u.hostname)) return true;
  if (u.hostname === 'api.github.com' && EGRESS.ownerRepo) {
    const path = u.pathname.toLowerCase();
    return path === `/repos/${EGRESS.ownerRepo}` || path.startsWith(`/repos/${EGRESS.ownerRepo}/`);
  }
  if (/(^|\.)actions\.githubusercontent\.com$/.test(u.hostname) || /\.blob\.core\.windows\.net$/.test(u.hostname)) return true; // GitHub artifact storage
  return OWNER_COMPUTE_HOSTS.includes(u.hostname);
}

/** A request for a project the owner said must stay inside CHE holds the guard closed while it runs (capability_engine.js). */
export function holdEgress(delta) { EGRESS.holds = Math.max(0, EGRESS.holds + Number(delta || 0)); return EGRESS.holds; }

export function setEgressPolicy(policy, selfUrl = '') {
  EGRESS.internalOnly = policy?.internal_only === true;
  try { if (selfUrl) EGRESS.selfHosts.add(new URL(selfUrl).hostname); } catch (_) {}
  return EGRESS.internalOnly;
}

export function egressBlockedCount() { return EGRESS.blocked; }

export function installEgressGuard() {
  if (globalThis.fetch?.cheEgressGuard) return false;
  const original = globalThis.fetch;
  const guarded = (input, init) => {
    if (EGRESS.internalOnly || EGRESS.holds > 0) {
      let host = '';
      try { host = new URL(String(input?.url || input)).hostname; } catch (_) { host = ''; }
      if (!ownerHost(String(input?.url || input))) {
        EGRESS.blocked++;
        return Promise.reject(new TypeError(EGRESS.internalOnly ? `Internal-only mode is on, so ${host || 'that service'} was not called.` : `This project stays inside CHE, so ${host || 'that service'} was not called.`));
      }
    }
    return original(input, init);
  };
  guarded.cheEgressGuard = true;
  globalThis.fetch = guarded;
  return true;
}

/** Turns internal-only mode on or off for this Worker now and for every later request and background pass. */
export async function storeEgressPolicy(storage, internalOnly) {
  const policy = { internal_only: internalOnly === true, at: new Date().toISOString() };
  await storage.put(EGRESS_KEY, policy);
  setEgressPolicy(policy);
  return policy;
}

/** Internal-only mode: no external API, app or provider is called; CHE's own runtime and the owner's compute only. */
export function externalCallAllowed(policy = {}, target = '', { ownerCompute = [] } = {}) {
  if (!policy?.internal_only) return { ok: true };
  let host = '';
  try { host = new URL(String(target)).hostname; } catch (_) { host = String(target); }
  if (ownerCompute.includes(host)) return { ok: true, owner_compute: true };
  return { ok: false, reason: `internal-only mode is on, so ${host || 'that service'} was not called` };
}

// ─── Owner words ────────────────────────────────────────────────────────────

export function securityIntent(message = '') {
  const t = String(message || '').trim().toLowerCase().replace(/[’]/g, "'").replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chey|chay)\b[\s,.:;!?-]*/, '').replace(/^(?:please|can you|could you)\s+/, '').replace(/[.!?]+$/, '').trim();
  if (/^(?:run|do|start) (?:a |the )?(?:full )?security (?:check|scan|audit)$|^check (?:your|che's) security$/.test(t)) return { action: 'check' };
  if (/^(?:(?:what(?:'s| is) )?(?:my |your |the )?security status|how(?:'s| is) (?:your|che's|my) security|are you secure|am i secure)$/.test(t)) return { action: 'status' };
  if (/^(?:what(?:'s| is) )?(?:my |the |your )?security (?:readiness|score)$|^how ready is (?:my |your |the )?security$/.test(t)) return { action: 'readiness' };
  if (/^(?:preview|show(?: me)?) (?:the )?lock ?down(?: preview)?$|^what (?:would|does|will) (?:a )?lock ?down do$/.test(t)) return { action: 'lockdown_preview' };
  if (/^(?:show|list|read|any) (?:me )?(?:my |the )?(?:open |active )?(?:security )?incidents$/.test(t)) return { action: 'incidents' };
  if (/^(?:who(?:'s| is) (?:on )?(?:my|your|the) security team|(?:show )?(?:the )?security chain of command)$/.test(t)) return { action: 'team' };
  if (/^(?:open|show(?: me)?|go to|take me to) (?:the |my )?security access(?: list)?$|^who has access to (?:che|you|my (?:che|accounts|data))$|^what (?:does che|do you) have access to$/.test(t)) return { action: 'access' };
  if (/^(?:open|show(?: me)?|list|read|go to) (?:the |my )?security findings$|^(?:what are )?(?:the |my )?security findings$/.test(t)) return { action: 'findings' };
  if (/^(?:open|show(?: me)?|go to|take me to) (?:the |my )?security(?: page| center| command center| screen)?$/.test(t)) return { action: 'open' };
  const drill = t.match(/^run (?:a |the )?(?:safe )?(?:security )?(?:drill|simulation)(?: (?:of|for) (?:a |an |the )?(.+))?$/);
  if (drill) return { action: 'drill', scenario: drill[1] || '' };
  if (/^(?:revoke|end|kill) (?:all )?(?:my |the )?(?:face id |authorization )?sessions$/.test(t)) return { action: 'revoke' };
  if (/^(?:review|show|list) (?:your |the |my )?internal tools$/.test(t)) return { action: 'tools' };
  if (/^(?:review|show) (?:the )?knowledge access$/.test(t)) return { action: 'knowledge' };
  if (/^(?:disable|turn off|block) (?:all )?external dependencies$|^(?:use only your internal capabilities|do not call any external api)$/.test(t)) return { action: 'internal_only' };
  if (/^(?:we(?:'ve| have) been (?:hacked|compromised)|start incident response|respond to (?:a |the )?(?:security )?incident)$/.test(t)) return { action: 'incident' };
  if (/^(?:back ?up|snapshot) (?:your |the )?trusted (?:state|configuration)$/.test(t)) return { action: 'snapshot' };
  return null;
}
