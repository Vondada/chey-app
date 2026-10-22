// Security Intelligence (owner, 2026-10-22): defense in depth over what CHE already has (device pairing and its
// failure limits, device revocation, lockdown, the money/delete and app gates, privacy_policy redaction, the Face ID
// vault on the phone). It never claims CHE is unhackable, never names an attacker without evidence, never probes a
// system CHE does not own, and never runs an unknown executable.
//
// One storage key holds its state: findings (never the secret itself), authorization sessions, nonces, telemetry
// counters, quarantine, trusted snapshots metadata and the audit log.
import { setLockdown, isLockedDown } from './resilience.js';

export const SECURITY_KEY = 'che:security_v1';
export const SNAPSHOT_KEY = 'che:trusted_snapshot_v1';
const MAX_EVENTS = 200;
const SESSION_TTL_MS = 10 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;

const clip = (v, n) => String(v ?? '').slice(0, n);

// ─── Secret scanning and redaction ──────────────────────────────────────────

// Each kind names a credential format; `entropy` is a high-randomness token with no known prefix.
const SECRET_PATTERNS = [
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g],
  ['xai_key', /\bxai-[A-Za-z0-9_-]{16,}/g],
  ['huggingface_token', /\bhf_[A-Za-z0-9]{20,}/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['alpaca_key', /\b(?:PK|AK)[A-Z0-9]{16,}\b/g],
  ['stripe_key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['password_assignment', /\b(?:password|passwd|passcode|pwd)\s*(?:is|=|:)\s*["']?[^\s"']{6,}/gi],
  ['secret_assignment', /\b(?:api[ _-]?key|secret|access[ _-]?token|client[ _-]?secret|auth[ _-]?token)\s*(?:is|=|:)\s*["']?[A-Za-z0-9._~+/=-]{12,}/gi],
];

// The broad check used where a false positive only refuses (workflow import/export, saved inputs): it also catches
// plain forms such as "password hunter2", "api key abc123" and "token: xyz". Model prompts and logs use the precise
// patterns above, so ordinary prose ("the token expires") is never altered there. Mirrored on the phone in
// lib/security/che_secret_scan.dart.
export const BROAD_SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|PK[A-Z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})|\b(?=[A-Za-z0-9+/_-]{32,}\b)(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9+/_-]{32,}\b|\b(?:password|passcode|passphrase|api[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token|token|pin)\s*(?:is\s+|=\s*|:\s*|\s)\s*(?!is\b|for\b|the\b|a\b|to\b|and\b|of\b)\S{4,}/i;

/** True when the text looks like it holds a credential. `broad` adds the plain-word forms. */
export function looksSecret(value, { broad = false } = {}) {
  const text = String(value ?? '');
  return scanSecrets(text).length > 0 || (broad && BROAD_SECRET_RE.test(text));
}

function entropy(s) {
  const counts = {};
  for (const c of s) counts[c] = (counts[c] || 0) + 1;
  return Object.values(counts).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

// A random-looking 32–200 character token with letters and digits. Git SHAs, other pure hex hashes, UUIDs, data: URIs
// and paths are not secrets and are left alone (coding prompts are full of them).
function entropyHits(text) {
  const hits = [];
  for (const m of text.matchAll(/(?<![\w/:.-])[A-Za-z0-9_+=-]{32,200}(?![\w/.-])/g)) {
    const t = m[0];
    if (/^[0-9a-f]+$/i.test(t) || /^[0-9a-f-]{36}$/i.test(t)) continue;
    if (!/[A-Z]/.test(t) || !/[a-z]/.test(t) || !/\d/.test(t)) continue;
    if (entropy(t) < 4.2) continue;
    hits.push({ kind: 'high_entropy_token', index: m.index, length: t.length });
  }
  return hits;
}

/** Finds credential-shaped text. A finding records its kind, position and length — never the value. */
export function scanSecrets(value) {
  const text = String(value ?? '');
  const findings = [];
  for (const [kind, re] of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) findings.push({ kind, index: m.index, length: m[0].length });
  }
  for (const hit of entropyHits(text)) {
    if (!findings.some((f) => hit.index >= f.index && hit.index < f.index + f.length)) findings.push(hit);
  }
  return findings.sort((a, b) => a.index - b.index);
}

/** The text with every finding replaced by [redacted:kind]. */
export function redact(value) {
  const text = String(value ?? '');
  const findings = scanSecrets(text);
  if (!findings.length) return { text, findings };
  let out = '';
  let at = 0;
  for (const f of findings) {
    if (f.index < at) continue;
    out += text.slice(at, f.index) + `[redacted:${f.kind}]`;
    at = f.index + f.length;
  }
  return { text: out + text.slice(at), findings };
}

/** Deep redaction of any JSON-like value (logs, exports, generated files, chat history). */
export function redactDeep(value, found = []) {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return value;
    const r = redact(value);
    found.push(...r.findings.map((f) => f.kind));
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, found));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = /^(?:image_url|image|audio|b64_json)$/.test(k) ? v : redactDeep(v, found);
    return out;
  }
  return value;
}

/**
 * The final guard before any language-model provider call: every text part of the request is redacted, so a secret
 * can never reach a model even if an earlier layer missed it. Images and audio are left as they are.
 */
export function guardModelInput(input) {
  if (!input || typeof input !== 'object') return { input, findings: [] };
  const found = [];
  const guarded = { ...input };
  if (Array.isArray(input.messages)) {
    guarded.messages = input.messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      if (typeof m.content === 'string') return { ...m, content: redactDeep(m.content, found) };
      if (Array.isArray(m.content)) return { ...m, content: m.content.map((p) => (p && p.type === 'text' ? { ...p, text: redactDeep(p.text, found) } : p)) };
      return m;
    });
  }
  if (typeof input.prompt === 'string') guarded.prompt = redactDeep(input.prompt, found);
  return { input: guarded, findings: found };
}

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

// ─── Identity of the target: app, domain, account ───────────────────────────

function registrable(host) {
  const parts = String(host || '').toLowerCase().replace(/\.$/, '').split('.');
  const twoLevel = /^(?:co|com|org|net|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

/**
 * Before acting in an app, on a site or in an account, the target must be exactly the one the owner authorized.
 * Look-alike domains (punycode, extra labels such as paypal.com.evil.io, other registrable domains) and another
 * signed-in account stop the action.
 */
export function checkTargetIdentity({ expected = {}, actual = {} }) {
  const problems = [];
  if (expected.app && String(actual.app || '').toLowerCase() !== String(expected.app).toLowerCase()) problems.push(`the app is ${actual.app || 'unknown'}, not ${expected.app}`);
  if (expected.domain) {
    let host = '';
    try { host = new URL(String(actual.url || '')).hostname.toLowerCase(); } catch (_) { host = String(actual.domain || '').toLowerCase(); }
    const want = String(expected.domain).toLowerCase();
    if (!host) problems.push('the site address is unknown');
    else if (/(^|\.)xn--/.test(host)) problems.push(`${host} uses a look-alike (punycode) name`);
    else if (registrable(host) !== registrable(want) || !(host === want || host.endsWith(`.${want}`) || registrable(want) === want && host.endsWith(`.${want}`))) problems.push(`the site is ${host}, not ${want}`);
    if (actual.url && !/^https:/i.test(String(actual.url))) problems.push('the connection is not HTTPS');
  }
  if (expected.account && String(actual.account || '').toLowerCase() !== String(expected.account).toLowerCase()) problems.push('a different account is signed in');
  return problems.length ? { ok: false, problems } : { ok: true, problems: [] };
}

// ─── Internal tool permissions ──────────────────────────────────────────────

const ACCESS_KINDS = ['files', 'projects', 'network', 'credentials', 'devices', 'actions'];

/**
 * A capability may touch only what its `permissions` list names. An internally created tool starts with nothing, so
 * every file, project, host, credential, device or action it asks for must have been granted explicitly.
 */
export function checkToolAccess(cap, request = {}) {
  if (!cap) return { ok: false, denied: ['unknown tool'] };
  const perms = cap.permissions || {};
  const denied = [];
  for (const kind of ACCESS_KINDS) {
    const allowed = Array.isArray(perms[kind]) ? perms[kind] : [];
    for (const want of [].concat(request[kind] || [])) {
      const w = String(want);
      const ok = allowed.some((a) => {
        const g = String(a);
        if (kind === 'files' || kind === 'projects') return g.endsWith('/*') ? w.startsWith(g.slice(0, -1)) && !w.includes('..') : w === g;
        if (kind === 'network') { let host = w; try { host = new URL(w).hostname; } catch (_) {} return host === g; }
        return w === g;
      });
      if (!ok) denied.push(`${kind}: ${clip(redact(w).text, 80)}`);
    }
  }
  return denied.length ? { ok: false, denied } : { ok: true, denied: [] };
}

// ─── Malware and supply-chain safety ────────────────────────────────────────

async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const BINARY_MAGIC = [
  ['ELF executable', [0x7f, 0x45, 0x4c, 0x46]], ['Windows executable', [0x4d, 0x5a]],
  ['Mach-O executable', [0xcf, 0xfa, 0xed, 0xfe]], ['Mach-O executable', [0xfe, 0xed, 0xfa, 0xcf]], ['Mach-O universal binary', [0xca, 0xfe, 0xba, 0xbe]],
  ['WebAssembly module', [0x00, 0x61, 0x73, 0x6d]], ['Java class', [0xca, 0xfe, 0xba, 0xbe]],
];
const PERMISSIVE = /\b(?:MIT|Apache[- ]2\.0|BSD|ISC|Zlib|Unlicense|CC0|MPL[- ]2\.0)\b/i;
const COPYLEFT = /\b(?:GPL|AGPL|LGPL)[- ]?v?\d/i;

/** Static inspection of one file. Nothing is executed. */
export function inspectFile({ path = '', text = null, bytes = null }) {
  const issues = [];
  const b = bytes instanceof Uint8Array ? bytes : text != null ? new TextEncoder().encode(String(text)) : new Uint8Array();
  for (const [label, magic] of BINARY_MAGIC) if (magic.every((x, i) => b[i] === x)) { issues.push({ severity: 'high', what: `${label} (${path}): never run in production` }); break; }
  const s = text != null ? String(text) : new TextDecoder('utf-8', { fatal: false }).decode(b.slice(0, 200_000));
  if (/package\.json$/.test(path)) {
    try {
      const pkg = JSON.parse(s);
      for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) if (pkg.scripts?.[hook]) issues.push({ severity: 'medium', what: `install script "${hook}" in ${path}` });
    } catch (_) { issues.push({ severity: 'low', what: `${path} is not valid JSON` }); }
  }
  if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z)?sh\b/.test(s)) issues.push({ severity: 'high', what: `${path} pipes a download into a shell` });
  if (/\beval\s*\(\s*(?:atob|Buffer\.from|unescape|String\.fromCharCode)/.test(s) || /(?:\\x[0-9a-f]{2}){40,}/i.test(s)) issues.push({ severity: 'high', what: `${path} decodes and runs hidden code` });
  if (/[A-Za-z0-9+/]{2000,}={0,2}/.test(s) && !/\.(?:png|jpe?g|gif|woff2?|ttf|lock)$/i.test(path)) issues.push({ severity: 'medium', what: `${path} carries a large encoded blob` });
  if (/\b(?:xmrig|stratum\+tcp|coinhive|cryptonight)\b/i.test(s)) issues.push({ severity: 'high', what: `${path} references crypto-mining` });
  if (/(?:~\/\.ssh|id_rsa|\.aws\/credentials|keychain|process\.env)[\s\S]{0,200}(?:fetch|https?\.request|axios|XMLHttpRequest|curl)/i.test(s)) issues.push({ severity: 'high', what: `${path} reads credentials and sends network requests` });
  if (/child_process|subprocess\.Popen|os\.system|Runtime\.getRuntime\(\)\.exec/.test(s)) issues.push({ severity: 'low', what: `${path} starts processes` });
  if (/\b(?:fetch|axios|https?\.request|XMLHttpRequest|urllib|requests\.(?:get|post))\b/.test(s)) issues.push({ severity: 'info', what: `${path} makes network requests` });
  for (const f of scanSecrets(s)) issues.push({ severity: 'medium', what: `${path} contains a credential-shaped value (${f.kind})` });
  return issues;
}

/**
 * MALWARE SAFETY LOOP for a repository or file set: identity → hashes → static inspection → dependency review →
 * license review → verdict allow / quarantine / reject / owner_review. Nothing from the source is executed.
 */
export async function inspectArtifacts({ source = '', files = [], license = '', identity = {}, paths = [] } = {}) {
  const hashes = [];
  const issues = [];
  // Prebuilt executables in the file list are never trusted, read or not.
  const executables = paths.filter((p) => /\.(?:exe|dll|so|dylib|bin|jar|msi|apk|ipa|scr|bat|cmd|ps1)$/i.test(String(p))).slice(0, 10);
  if (executables.length) issues.push({ severity: 'medium', what: `prebuilt executable files (${executables.slice(0, 3).join(', ')}): never run in production` });
  for (const f of files.slice(0, 2000)) {
    const bytes = f.bytes instanceof Uint8Array ? f.bytes : new TextEncoder().encode(String(f.text ?? ''));
    hashes.push({ path: clip(f.path, 200), sha256: await sha256(bytes), size: bytes.length });
    issues.push(...inspectFile({ path: f.path, text: f.text ?? null, bytes: f.bytes ?? null }));
  }
  const licenseText = license || files.find((f) => /^(?:LICENSE|COPYING)(?:\.\w+)?$/i.test(String(f.path).split('/').pop()))?.text || '';
  const licenseKind = !licenseText ? 'none' : PERMISSIVE.test(licenseText) ? 'permissive' : COPYLEFT.test(licenseText) ? 'copyleft' : 'unknown';
  if (licenseKind === 'none') issues.push({ severity: 'medium', what: 'no license: the code may not be reused' });
  if (licenseKind === 'copyleft') issues.push({ severity: 'medium', what: 'copyleft license: reuse needs the owner\'s decision' });
  if (licenseKind === 'unknown') issues.push({ severity: 'medium', what: 'unrecognised license' });
  if (identity.expected && identity.actual && identity.expected !== identity.actual) issues.push({ severity: 'high', what: `the repository is ${identity.actual}, not ${identity.expected}` });
  const high = issues.filter((i) => i.severity === 'high').length;
  const medium = issues.filter((i) => i.severity === 'medium').length;
  const verdict = high >= 2 || issues.some((i) => /hidden code|pipes a download|crypto-mining|not .* expected|credentials and sends/.test(i.what) && i.severity === 'high') ? 'reject'
    : high ? 'quarantine'
      : medium ? 'owner_review'
        : 'allow';
  return { source: clip(source, 200), verdict, license: licenseKind, hashes: hashes.slice(0, 200), issues: issues.slice(0, 100), executed: false };
}

/** Unknown binaries and unreviewed code never run in CHE's production runtime; a sandbox run needs an allow verdict. */
export function mayExecute(report, environment = 'production') {
  if (!report || report.verdict !== 'allow') return { ok: false, reason: `the safety verdict is ${report?.verdict || 'missing'}` };
  if (environment === 'production' && report.issues.some((i) => /executable|binary|WebAssembly/.test(i.what))) return { ok: false, reason: 'unknown executables never run in production' };
  return { ok: true };
}

/** The registry's 'security' promotion check (capability_registry.recordCheck). */
export async function securityCheckForCapability(cap, files = []) {
  const report = await inspectArtifacts({ source: cap?.capability_id, files, license: cap?.license_profile || '' });
  const wide = cap ? [].concat(cap.permissions?.network || [], cap.permissions?.credentials || []) : [];
  const ok = Boolean(cap) && report.verdict === 'allow' && !wide.includes('*');
  return { ok, evidence: ok ? `static review clean (${report.hashes.length} file(s), ${report.license} license, no wildcard access)` : `verdict ${report.verdict}; ${report.issues.filter((i) => i.severity !== 'info').map((i) => i.what).slice(0, 3).join('; ') || 'wildcard network or credential access'}`, report };
}

/** Generated code reaches production only with clean checks, passing tests and the owner's review. */
export async function reviewGeneratedCode({ files = [], syntax_ok = false, tests_passed = false, owner_approved = false } = {}) {
  const report = await inspectArtifacts({ source: 'generated code', files, license: 'MIT (CHE original code)' });
  const blockers = [];
  if (!syntax_ok) blockers.push('syntax checks have not passed');
  if (!tests_passed) blockers.push('tests have not passed');
  if (report.verdict !== 'allow') blockers.push(`security review: ${report.verdict}`);
  if (!owner_approved) blockers.push('the owner has not approved it');
  return { may_enter_production: blockers.length === 0, blockers, report };
}

// Small vendored advisory list (checked without any network). It is not a full advisory database: the report says so.
export const ADVISORIES = Object.freeze([
  { ecosystem: 'npm', name: 'lodash', below: '4.17.21', id: 'CVE-2021-23337', severity: 'high' },
  { ecosystem: 'npm', name: 'minimist', below: '1.2.6', id: 'CVE-2021-44906', severity: 'high' },
  { ecosystem: 'npm', name: 'node-fetch', below: '2.6.7', id: 'CVE-2022-0235', severity: 'medium' },
  { ecosystem: 'npm', name: 'ws', below: '8.17.1', id: 'CVE-2024-37890', severity: 'high' },
  { ecosystem: 'npm', name: 'axios', below: '1.7.4', id: 'CVE-2024-39338', severity: 'high' },
  { ecosystem: 'npm', name: 'event-stream', exact: '3.3.6', id: 'malicious flatmap-stream', severity: 'critical' },
  { ecosystem: 'pub', name: 'http', below: '0.13.3', id: 'GHSA CRLF injection', severity: 'medium' },
]);

function semverLess(a, b) {
  const pa = String(a).replace(/^[^\d]*/, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

/** Dependency advisories from package.json / package-lock / pubspec.lock content. */
export function dependencyAdvisories({ packageJson = '', pubspecLock = '' } = {}) {
  const deps = [];
  try {
    const pkg = JSON.parse(packageJson || '{}');
    for (const [name, v] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) deps.push({ ecosystem: 'npm', name, version: String(v) });
  } catch (_) {}
  for (const m of String(pubspecLock).matchAll(/^ {2}([a-z0-9_]+):\n(?:(?: {4}.*)\n)*? {4}version: "([^"]+)"/gm)) deps.push({ ecosystem: 'pub', name: m[1], version: m[2] });
  const hits = [];
  for (const d of deps) {
    for (const a of ADVISORIES) {
      if (a.ecosystem !== d.ecosystem || a.name !== d.name) continue;
      const v = d.version.replace(/^[\^~>=<\s]+/, '');
      if ((a.exact && v === a.exact) || (a.below && semverLess(v, a.below))) hits.push({ ...a, version: d.version });
    }
  }
  return { checked: deps.length, advisories: hits, coverage: `a small built-in list of ${ADVISORIES.length} known advisories, not a full database` };
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
  if (/^(?:security status|how(?:'s| is) (?:your|che's|my) security|are you secure)$/.test(t)) return { action: 'status' };
  if (/^(?:revoke|end|kill) (?:all )?(?:my |the )?(?:face id |authorization )?sessions$/.test(t)) return { action: 'revoke' };
  if (/^(?:review|show|list) (?:your |the |my )?internal tools$/.test(t)) return { action: 'tools' };
  if (/^(?:review|show) (?:the )?knowledge access$/.test(t)) return { action: 'knowledge' };
  if (/^(?:disable|turn off|block) (?:all )?external dependencies$|^(?:use only your internal capabilities|do not call any external api)$/.test(t)) return { action: 'internal_only' };
  if (/^(?:we(?:'ve| have) been (?:hacked|compromised)|start incident response|respond to (?:a |the )?(?:security )?incident)$/.test(t)) return { action: 'incident' };
  if (/^(?:back ?up|snapshot) (?:your |the )?trusted (?:state|configuration)$/.test(t)) return { action: 'snapshot' };
  return null;
}
