// Security Core: secret scanning and redaction. Portable: no imports from any product module.
// A finding records the kind, position and length of a credential-shaped value, never the value itself.
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
  // "my password hunter2": a password stated without a separator; the value must contain a digit or symbol, so
  // ordinary words ("my password reset") are left alone.
  ['password_plain', /\bmy\s+(?:\w+\s+)?(?:password|passcode|passphrase|pin)\s+(?:is\s+)?(?=[^\s]*[\d!@#$%^&*])[^\s]{4,}/gi],
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

