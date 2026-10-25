// Security Core: secret scanning and redaction. Portable: no imports from any product module.
// A finding records the kind, position and length of a credential-shaped value, never the value itself.
// Each kind names a credential format; `entropy` is a high-randomness token with no known prefix.
// This is CHE's one scanner: model prompts, provider egress, agent messages, logs, exports and events all use it
// (docs/CHE_SECURITY_HARDENING.md has the egress map).
const SECRET_PATTERNS = [
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g],
  ['xai_key', /\bxai-[A-Za-z0-9_-]{16,}/g],
  ['groq_key', /\bgsk_[A-Za-z0-9]{20,}/g],
  ['cerebras_key', /\bcsk-[A-Za-z0-9]{20,}/g],
  ['huggingface_token', /\bhf_[A-Za-z0-9]{20,}/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  // Google OAuth: a client secret, an access token, a refresh token.
  ['google_oauth', /(?:\bGOCSPX-[A-Za-z0-9_-]{20,}|\bya29\.[A-Za-z0-9_-]{20,}|(?<![\w/])1\/\/0[A-Za-z0-9_-]{30,})/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['alpaca_key', /\b(?:PK|AK)[A-Z0-9]{16,}\b/g],
  ['stripe_key', /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,})/g],
  ['elevenlabs_key', /\bsk_[a-f0-9]{40,}\b/g],
  // Modal token ids and secrets (ak-/as-) and workspace tokens (wk-/ws-): random letters and digits, both present.
  ['modal_token', /\b(?:ak|as|wk|ws)-(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}\b/g],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['replicate_token', /\br8_[A-Za-z0-9]{30,}/g],
  ['telegram_bot_token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['password_assignment', /\b(?:password|passwd|passcode|pwd)\s*(?:is|=|:)\s*["']?([^\s"']{6,})/gi, (v) => codeReference(v, { strict: true })],
  // "my password hunter2": a password stated without a separator; the value must contain a digit or symbol, so
  // ordinary words ("my password reset") are left alone.
  ['password_plain', /\bmy\s+(?:\w+\s+)?(?:password|passcode|passphrase|pin)\s+(?:is\s+)?(?=[^\s]*[\d!@#$%^&*])[^\s]{4,}/gi],
  // A value that is code naming where a secret lives (env.OPENAI_API_KEY, secret.clientSecret, CHE_CLIENT_SECRET) is
  // not a secret: coding and repository prompts quote such lines all the time. Before this filter, four such lines in
  // a Flagstaff reply's SOURCE excerpts were enough for a Security Room warning (2026-10-25, see the hardening doc).
  ['secret_assignment', /\b(?:api[ _-]?key|secret|access[ _-]?token|client[ _-]?secret|auth[ _-]?token)\s*(?:is|=|:)\s*["']?([A-Za-z0-9._~+/=-]{12,})/gi, (v) => codeReference(v)],
];

const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const CODE_ROOTS = /^(?:env|process|this|self|data|body|req|request|config|cfg|options|opts|secret|secrets|creds|credentials|settings|params|args|json|response|res|os|window|ctx|keys|vault|input|payload|item|record|account|auth|session|provider|connection|row|state|widget|store)\./;

/**
 * True when an assignment's value is code that names a secret rather than the secret itself: a member path
 * (env.KEY, data.access_token), an environment variable name (CHE_GOOGLE_CLIENT_SECRET), a camelCase identifier
 * with no digit, or a placeholder. `strict` (passwords) skips only member paths from a known code root and env names.
 */
export function codeReference(value, { strict = false } = {}) {
  const v = String(value || '').replace(/^["']|["']$/g, '');
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return true;
  // Code shapes either way: a template (${x}), a call (at(pass), save.group(2)), a member path with no digit
  // (saved.password, pw.value), an identifier passed on (password, / password);).
  if (/^\$\{/.test(v) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/.test(v)) return true;
  if (!/\d/.test(v) && (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[!,;)\]}]*$/.test(v) || /^[a-z_$][\w$]*[,;)\]}]+$/.test(v))) return true;
  if (strict) return CODE_ROOTS.test(v) && MEMBER_PATH.test(v);
  if (MEMBER_PATH.test(v)) return true;
  if (/^(?:[a-z]+(?:[A-Z][a-z]+)+|(?:[A-Z][a-z]+){2,})$/.test(v)) return true;
  return /^(?:your|example|sample|placeholder|redacted)[-_]/i.test(v) || /^x{6,}$/i.test(v);
}

// Never scanned: an embedded data: URI (images, audio) and a vault reference ({{secret:NAME}}), which names a secret
// without holding it.
const IGNORED_SPANS = /data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+|\{\{secret:[A-Z][A-Z0-9_]{1,63}\}\}/g;

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

/**
 * Finds credential-shaped text. A finding records its kind, position and length — never the value. Overlapping
 * matches count once (an Anthropic key is one finding, not an Anthropic and an OpenAI key).
 */
export function scanSecrets(value) {
  const text = String(value ?? '');
  const ignored = [...text.matchAll(IGNORED_SPANS)].map((m) => [m.index, m.index + m[0].length]);
  const inIgnored = (i) => ignored.some(([a, b]) => i >= a && i < b);
  const raw = [];
  for (const [kind, re, skip] of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (inIgnored(m.index) || (skip && skip(m[1] ?? m[0]))) continue;
      raw.push({ kind, index: m.index, length: m[0].length });
    }
  }
  for (const hit of entropyHits(text)) if (!inIgnored(hit.index)) raw.push(hit);
  raw.sort((a, b) => a.index - b.index || b.length - a.length);
  const findings = [];
  for (const f of raw) {
    const last = findings[findings.length - 1];
    if (last && f.index < last.index + last.length) continue;
    findings.push(f);
  }
  return findings;
}

/** The text with every finding replaced by [redacted:kind]. */
export function redact(value) {
  const text = String(value ?? '');
  const findings = scanSecrets(text);
  if (!findings.length) return { text, findings };
  let out = '';
  let at = 0;
  for (const f of findings) {
    out += text.slice(at, f.index) + `[redacted:${f.kind}]`;
    at = f.index + f.length;
  }
  return { text: out + text.slice(at), findings };
}

// Media fields pass as they are: pictures and sound are not scanned as text.
const MEDIA_KEYS = /^(?:image_url|image|audio|b64_json|inline_data|inlineData|input_audio|audio_url)$/;

/** Deep redaction of any JSON-like value (logs, exports, generated files, chat history, provider request bodies). */
export function redactDeep(value, found = []) {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return value;
    const r = redact(value);
    found.push(...r.findings.map((f) => f.kind));
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, found));
  if (value && typeof value === 'object') {
    // Only plain records are rebuilt; a signal, stream or class instance passes untouched.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = MEDIA_KEYS.test(k) ? v : redactDeep(v, found);
    return out;
  }
  return value;
}

/** Counts per kind, for an event: `{ count, kinds: { secret_assignment: 4 } }`. Never a value. */
export function summarizeKinds(kinds = []) {
  const counts = {};
  for (const k of kinds) counts[k] = (counts[k] || 0) + 1;
  return { count: kinds.length, kinds: counts };
}

/**
 * The final guard before any language-model provider call: every text field of the request (messages, prompt,
 * system, instructions, the user knowledge bundle in che_context, audit text) is redacted, so a secret can never reach
 * a model even if an earlier layer missed it. Images and audio are left as they are.
 */
export function guardModelInput(input) {
  if (!input || typeof input !== 'object') return { input, findings: [] };
  const found = [];
  // The audit copy repeats the start of the message: it is redacted too, but counted once.
  const { che_audit: audit, ...rest } = input;
  const guarded = redactDeep(rest, found);
  if (audit !== undefined) guarded.che_audit = redactDeep(audit);
  return { input: guarded, findings: found };
}

// ─── Vault references ───────────────────────────────────────────────────────
// A model, a manifest or a workflow names a secret as {{secret:NAME}}; only the trusted tool call that needs it swaps in
// the value, at the moment it sends the request, and only for names that call was granted. The model sees the
// reference, never the value, and a value it writes into its own output is never resolved.
export const SECRET_REF_RE = /\{\{secret:([A-Z][A-Z0-9_]{1,63})\}\}/g;

export function secretRef(name) { return `{{secret:${String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}}}`; }

export function hasSecretRef(value) { return /\{\{\s*secret:/i.test(String(value ?? '')); }

/**
 * Resolves references in one trusted string. `allowed` is the set of names this call may use; `lookup(name)` returns
 * the value. Unknown or ungranted names are not resolved and are reported by name only.
 */
export function resolveSecretRefs(template, { allowed = [], lookup = () => '' } = {}) {
  const grant = new Set(allowed);
  const missing = [];
  const denied = [];
  const value = String(template ?? '').replace(SECRET_REF_RE, (ref, name) => {
    if (!grant.has(name)) { denied.push(name); return ref; }
    const v = lookup(name);
    if (!v) { missing.push(name); return ref; }
    return String(v);
  });
  return { value, missing, denied, ok: !missing.length && !denied.length };
}
