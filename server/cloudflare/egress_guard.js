// Outbound egress guard for CHE private memory.
//
// Every send that leaves the Worker toward a model, a code host or any other
// destination should pass through guardOutbound() first. The rules are enforced
// here in code, not only in model instructions:
//
//   (a) AI providers and code hosts (github, openai, groq, gemini, grok, mistral,
//       openrouter, and any other non-Cloudflare AI host) never receive text that
//       is private or sensitive. No owner grant overrides this.
//   (b) 'cloudflare-model' may receive text only after redaction.
//   (c) Sensitive data sent to any other destination is blocked unless the owner
//       has granted that destination.
//
// "Sensitive" means the caller tagged the payload (sensitiveTags, anything other
// than 'public'), or the text contains a private span or a detectable secret:
// emails, phone numbers, card-like digit runs, or API key/token patterns.
//
// Redaction replaces each of these with a placeholder. The `redacted` field is
// always the redacted text, even when an owner grant allows a send.

const CLOUDFLARE_MODEL = 'cloudflare-model';
const PUBLIC_TAG = 'public';

// Destinations that must never receive private or sensitive text.
const NEVER_RECEIVE = new Set([
  'github',
  'openai',
  'groq',
  'gemini',
  'grok',
  'mistral',
  'openrouter',
]);

// Host fragments that identify an AI provider or code host. Any destination
// whose host contains one of these is treated like the named providers above.
const AI_HOST_KEYWORDS = [
  'openai',
  'anthropic',
  'claude',
  'groq',
  'gemini',
  'grok',
  'mistral',
  'openrouter',
  'cohere',
  'perplexity',
  'huggingface',
  'deepseek',
  'ollama',
  'replicate',
  'fireworks',
  'elevenlabs',
  'github',
  'gpt',
  'llm',
];

const PRIVATE_TAG_NAMES = 'private-memory|private|sensitive|secret';
const PRIVATE_BLOCK_RE = new RegExp(`<(${PRIVATE_TAG_NAMES})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');
const PRIVATE_OPEN_RE = new RegExp(`<(${PRIVATE_TAG_NAMES})\\b[^>]*>[\\s\\S]*$`, 'i');

const SECRET_RES = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub classic tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bgsk_[A-Za-z0-9]{20,}\b/g, // Groq keys
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// A run of digits, optionally with spaces, dots, dashes or brackets between them.
const DIGIT_RUN_RE = /\+?\d(?:[\d\s().-]*\d)?/g;
const DATE_SHAPE_RE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/;

const PLACEHOLDER = {
  private: '[PRIVATE]',
  secret: '[SECRET]',
  email: '[EMAIL]',
  card: '[CARD]',
  phone: '[PHONE]',
};

function toText(input) {
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return '';
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input);
  }
}

// Scan text once: returns the redacted text and the kinds of sensitive data found.
function scanText(input) {
  let text = toText(input);
  const kinds = new Set();

  const replaceAll = (re, placeholder, kind) => {
    text = text.replace(re, () => {
      kinds.add(kind);
      return placeholder;
    });
  };

  replaceAll(PRIVATE_BLOCK_RE, PLACEHOLDER.private, 'private');
  replaceAll(PRIVATE_OPEN_RE, PLACEHOLDER.private, 'private');
  for (const re of SECRET_RES) replaceAll(re, PLACEHOLDER.secret, 'secret');
  replaceAll(EMAIL_RE, PLACEHOLDER.email, 'email');

  text = text.replace(DIGIT_RUN_RE, (match) => {
    if (DATE_SHAPE_RE.test(match)) return match;
    const digits = match.replace(/\D/g, '');
    const hasPlus = match.startsWith('+');
    if (digits.length >= 13 && digits.length <= 19) {
      kinds.add('card');
      return PLACEHOLDER.card;
    }
    if ((digits.length >= 10 && digits.length <= 12) || (hasPlus && digits.length >= 8 && digits.length <= 15)) {
      kinds.add('phone');
      return PLACEHOLDER.phone;
    }
    return match;
  });

  return { text, kinds };
}

// True when the text holds a private span or any detectable sensitive data.
export function isPrivate(text) {
  return scanText(text).kinds.size > 0;
}

// Replace emails, phone numbers, card-like digit runs, API keys and tokens, and
// every span tagged private, sensitive, secret or private-memory.
export function redact(text) {
  return scanText(text).text;
}

// The kinds of sensitive data found in the text: 'private', 'secret', 'email',
// 'card', 'phone'. Returns an empty array for clean text.
export function sensitiveKinds(text) {
  return [...scanText(text).kinds];
}

function hostOf(key) {
  const noScheme = key.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const authority = noScheme.split(/[/?#]/)[0];
  const noUser = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  return noUser.replace(/:\d+$/, '');
}

function isAiHost(host) {
  if (AI_HOST_KEYWORDS.some((word) => host.includes(word))) return true;
  return /(^|\.)x\.ai$/.test(host);
}

function normalizeDestination(destination) {
  return typeof destination === 'string' ? destination.trim().toLowerCase() : '';
}

// Classify a destination as 'unknown', 'cloudflare-model', 'ai' or 'external'.
export function classifyDestination(destination) {
  const key = normalizeDestination(destination);
  if (!key) return { kind: 'unknown', key: 'unknown' };
  if (key === CLOUDFLARE_MODEL) return { kind: CLOUDFLARE_MODEL, key };
  const host = hostOf(key);
  if (NEVER_RECEIVE.has(key) || NEVER_RECEIVE.has(host)) return { kind: 'ai', key };
  if (isAiHost(host)) return { kind: 'ai', key };
  return { kind: 'external', key };
}

function normalizeTags(sensitiveTags) {
  const list = Array.isArray(sensitiveTags) ? sensitiveTags : sensitiveTags ? [sensitiveTags] : [];
  const tags = list
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag && tag !== PUBLIC_TAG);
  return [...new Set(tags)];
}

// An owner grant is { owner: true, destination, tags? }. It applies only to
// external destinations, never to AI providers or to rule (a).
function grantCovers(ownerGrant, destinationKey, tags) {
  if (!ownerGrant || typeof ownerGrant !== 'object') return false;
  if (ownerGrant.owner !== true) return false;
  if (normalizeDestination(ownerGrant.destination) !== destinationKey) return false;
  if (tags.length === 0) return true;
  if (!Array.isArray(ownerGrant.tags)) return false;
  const granted = ownerGrant.tags.filter((t) => typeof t === 'string').map((t) => t.trim().toLowerCase());
  return tags.every((tag) => granted.includes(tag));
}

/**
 * Decide whether a payload may leave for a destination.
 *
 * @param {object} args
 * @param {string} args.destination  'github', 'openai', 'cloudflare-model', a host, etc.
 * @param {string|object} args.payload  Text to send. Objects are JSON-encoded.
 * @param {string[]} [args.sensitiveTags]  Tags on the whole payload, e.g. 'private-memory'.
 * @param {object} [args.ownerGrant]  Optional { owner: true, destination, tags? } from the owner.
 * @returns {{allowed: boolean, reason: string, redacted: string}}
 *   `redacted` is the text that may be sent, with sensitive spans replaced.
 */
export function guardOutbound({ destination, payload, sensitiveTags, ownerGrant } = {}) {
  const dest = classifyDestination(destination);
  const tags = normalizeTags(sensitiveTags);
  const scan = scanText(payload);
  const sensitive = tags.length > 0 || scan.kinds.size > 0;
  const redacted = tags.length > 0 ? PLACEHOLDER.private : scan.text;
  const result = (allowed, reason) => ({ allowed, reason, redacted });

  if (dest.kind === 'unknown') {
    return result(false, 'destination missing or unknown; blocked by default');
  }

  if (dest.kind === 'ai') {
    if (sensitive) return result(false, `private or sensitive text may never be sent to ${dest.key}`);
    return result(true, `no sensitive data; ${dest.key} may receive this text`);
  }

  if (dest.kind === CLOUDFLARE_MODEL) {
    return result(
      true,
      sensitive ? 'sent to cloudflare-model only after redaction' : 'no sensitive data',
    );
  }

  if (!sensitive) return result(true, 'no sensitive data');
  if (grantCovers(ownerGrant, dest.key, tags)) {
    return result(true, `owner grant for ${dest.key}; redacted text only`);
  }
  return result(false, `sensitive data needs an owner grant for ${dest.key}`);
}
