// CHE autonomous recovery contract.
//
// One policy for every engineering stage (planner, engineer, reviewer,
// background job, PR/CI/deploy). Each failure is classified once:
//
//   A  internal recoverable engineering failure → CHE fixes it herself
//   B  temporary external failure               → bounded retry/backoff/fallback
//   C  permanent external blocker               → stop; tell the owner only the external condition
//   D  consequential authorization requirement  → ask the owner only for that authorization
//
// Ordinary coding mistakes (bad JSON, wrong file, missing anchor, an agent
// asking for source it was already given) are class A and never become owner
// homework. Diagnostics stay on the Worker; owner chat gets human status.

export const FAILURE_CLASS = Object.freeze({
  INTERNAL: 'A',
  TEMPORARY_EXTERNAL: 'B',
  PERMANENT_EXTERNAL: 'C',
  AUTHORIZATION: 'D',
});

// Phrases an agent uses when it is asking someone else (the owner) to supply
// repository evidence CHE can retrieve herself. With GitHub access these are
// agent failures, never owner requests.
const EVIDENCE_REQUEST = [
  /\b(?:source(?:\s+code)?|code|file(?:s)?|repo(?:sitory)?|contents?)\b[^.]{0,60}\b(?:was|were|is|are)\s+not\s+(?:provided|supplied|included|available|shared|given|attached)\b/i,
  /\b(?:not|never)\s+(?:been\s+)?(?:provided|supplied|given|shown)\s+(?:with\s+)?(?:the\s+)?(?:source|code|file|repo)/i,
  /\b(?:unable|cannot|can't|can not|could not|couldn't)\s+(?:to\s+)?(?:inspect|access|see|view|read|review|verify|open|locate)\b[^.]{0,40}\b(?:source|code|repo(?:sitory)?|file|files|implementation)\b/i,
  /\b(?:please\s+)?(?:provide|send|share|paste|supply|give)\s+(?:me\s+)?(?:the\s+)?(?:actual\s+|full\s+|relevant\s+|exact\s+)?(?:source(?:\s+code)?|code|file(?:\s*name)?s?|filename|path|line numbers?|diff|exact (?:text|find text)|snippet)/i,
  /\b(?:copy|paste)\s+(?:the\s+)?exact\s+(?:text|code|lines?)\b/i,
  /\b(?:tell|show)\s+me\s+(?:the\s+|which\s+)?(?:file(?:name)?|path|line)/i,
  /\bwithout\s+(?:access\s+to\s+|seeing\s+)?the\s+(?:actual\s+)?(?:source|code|file|repository)\b/i,
  /\bno\s+(?:source(?:\s+code)?|code|file contents?)\s+(?:was|were|is)?\s*(?:provided|included|supplied)\b/i,
];

export function isEvidenceRequest(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return EVIDENCE_REQUEST.some((re) => re.test(value));
}

// Removes "owner homework" from any text that might reach the owner, without
// hiding the fact that a stage failed.
export function stripOwnerHomework(text) {
  return String(text || '')
    .split(/(?<=[.!?|])\s+/)
    .filter((sentence) => !isEvidenceRequest(sentence))
    .join(' ')
    .trim();
}

const AUTH_PATTERN = /\b(?:401|bad credentials|requires authentication|token (?:expired|revoked|invalid)|2fa|two[- ]factor|captcha|sso|saml)\b/i;
const PERMISSION_PATTERN = /\b(?:403|resource not accessible|permission denied|must have (?:admin|push)|not authorized|forbidden|billing|payment required|402|spending limit|account (?:locked|suspended))\b/i;
const TEMPORARY_PATTERN = /\b(?:429|rate.?limit|quota|busy|overload|temporarily|unavailable|timed? ?out|timeout|abort|econnreset|network|fetch failed|50[0234]|resting|cooldown|daily budget|engines? (?:failed|busy)|try again)\b/i;

// Classifies an Error, a {status, detail} result, or plain text.
export function classifyFailure(input) {
  const status = Number(input?.status || input?.http_status || 0);
  const text = typeof input === 'string'
    ? input
    : [input?.message, input?.detail, input?.diagnostic, input?.category].filter(Boolean).join(' ');
  if (input?.failure_class && Object.values(FAILURE_CLASS).includes(input.failure_class)) {
    return { failure_class: input.failure_class, kind: input.failure_kind || 'declared' };
  }
  if (input?.owner_authorization_required || /\bowner (?:approval|authorization) (?:is )?required\b/i.test(text)) {
    return { failure_class: FAILURE_CLASS.AUTHORIZATION, kind: 'owner_authorization' };
  }
  // GitHub answers abuse/secondary rate limits with 403; that is temporary.
  if (/secondary rate limit|abuse detection|retry-after/i.test(text)) return { failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL, kind: 'rate_limited' };
  if (status === 401 || AUTH_PATTERN.test(text)) return { failure_class: FAILURE_CLASS.PERMANENT_EXTERNAL, kind: 'authentication' };
  if (status === 402 || status === 403 || PERMISSION_PATTERN.test(text)) return { failure_class: FAILURE_CLASS.PERMANENT_EXTERNAL, kind: 'permission_or_billing' };
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return { failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL, kind: 'provider_or_service' };
  if (input?.category === 'temporary_cloud_unavailable' || input?.category === 'retryable_provider_error' || input?.quota) {
    return { failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL, kind: 'provider_or_service' };
  }
  if (input?.category === 'authentication_required') return { failure_class: FAILURE_CLASS.PERMANENT_EXTERNAL, kind: 'authentication' };
  if (TEMPORARY_PATTERN.test(text)) return { failure_class: FAILURE_CLASS.TEMPORARY_EXTERNAL, kind: 'provider_or_service' };
  if (isEvidenceRequest(text)) return { failure_class: FAILURE_CLASS.INTERNAL, kind: 'agent_evidence_request' };
  return { failure_class: FAILURE_CLASS.INTERNAL, kind: 'engineering' };
}

export function isTemporaryExternal(input) {
  return classifyFailure(input).failure_class === FAILURE_CLASS.TEMPORARY_EXTERNAL;
}

// Exponential backoff with a ceiling, for class B only.
export function backoffMs(attempt, baseMs = 60_000, maxMs = 30 * 60_000) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(maxMs, baseMs * (2 ** n));
}

// Materially-equivalent strategy fingerprint. Whitespace, line-number
// prefixes, quote style and case do not make a strategy "new"; switching AI
// providers never resets it.
function normalizeCode(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\|\s?/, ''))
    .join('\n')
    .replace(/["'`]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function strategyFingerprint(answer) {
  if (answer?.no_change === true) {
    const evidence = (Array.isArray(answer.evidence) ? answer.evidence : []).map((item) => normalizeCode(item)).sort();
    return `no_change:${evidence.join('|').slice(0, 400)}`;
  }
  const edits = (Array.isArray(answer?.edits) ? answer.edits : [])
    .map((edit) => `${String(edit?.path || '').trim().toLowerCase()}::${normalizeCode(edit?.find)}=>${normalizeCode(edit?.replace)}`)
    .sort();
  const files = (Array.isArray(answer?.new_files) ? answer.new_files : [])
    .map((file) => `${String(file?.path || '').trim().toLowerCase()}::${normalizeCode(file?.content).slice(0, 2000)}`)
    .sort();
  return `edits:${edits.join('||')}##new:${files.join('||')}`;
}

// Per-job AI budget: call ceiling, per-stage ceilings and an estimated token
// ceiling. Exhaustion is a hard stop, never a silent extra loop.
export class AgentBudget {
  constructor({ maxCalls = 40, maxTokens = 200_000, stageLimits = {}, maxElapsedMs = 15 * 60_000, maxIdenticalErrors = 3, now = () => Date.now() } = {}) {
    this.maxCalls = maxCalls;
    this.maxTokens = maxTokens;
    this.maxElapsedMs = maxElapsedMs;
    this.maxIdenticalErrors = maxIdenticalErrors;
    this.now = now;
    this.startedAt = now();
    this.errorCounts = {};
    // engineer: 3 genuine passes + 2 passes that produced nothing, 2 engineers
    // each; format_retry: one re-request per unusable answer. maxCalls and
    // maxTokens (raised by that allowance only) still cap the whole job.
    this.stageLimits = { planner: 2, engineer: 10, format_retry: 6, reviewer: 16, recovery: 3, ...stageLimits };
    this.calls = 0;
    this.tokens = 0;
    this.byStage = {};
  }

  canSpend(stage = 'other', estimatedTokens = 0) {
    const used = this.byStage[stage] || 0;
    const limit = this.stageLimits[stage];
    if (this.calls >= this.maxCalls) return false;
    if (this.now() - this.startedAt > this.maxElapsedMs) return false;
    if (this.repeatedError()) return false;
    if (Number.isFinite(limit) && used >= limit) return false;
    if (this.tokens + Math.max(0, estimatedTokens) > this.maxTokens) return false;
    return true;
  }

  spend(stage = 'other', estimatedTokens = 0) {
    if (!this.canSpend(stage, estimatedTokens)) {
      const error = new Error(`Engineering budget reached for ${stage}.`);
      error.budget_exhausted = true;
      error.failure_class = FAILURE_CLASS.INTERNAL;
      throw error;
    }
    this.calls += 1;
    this.tokens += Math.max(0, Math.ceil(estimatedTokens));
    this.byStage[stage] = (this.byStage[stage] || 0) + 1;
  }

  // Same provider + failure kind more than maxIdenticalErrors times means the
  // approach is not working: stop instead of paying for another identical try.
  recordError(signature) {
    const key = String(signature || 'unknown').slice(0, 200);
    this.errorCounts[key] = (this.errorCounts[key] || 0) + 1;
    return this.errorCounts[key];
  }

  repeatedError() {
    return Object.entries(this.errorCounts).find(([, n]) => n > this.maxIdenticalErrors)?.[0] || '';
  }

  addOutput(tokens) {
    this.tokens += Math.max(0, Math.ceil(Number(tokens) || 0));
  }

  snapshot() {
    return {
      calls: this.calls,
      tokens_estimated: this.tokens,
      by_stage: { ...this.byStage },
      elapsed_ms: this.now() - this.startedAt,
      ...(this.repeatedError() ? { stopped_on_repeated_error: this.repeatedError() } : {}),
    };
  }
}

// Owner-facing wording for an engineering outcome. Raw agent output, provider
// traces and token counts stay in diagnostics.
export function ownerEngineeringMessage(failureClass, kind = '') {
  switch (failureClass) {
    case FAILURE_CLASS.TEMPORARY_EXTERNAL:
      return 'My AI engines or GitHub are temporarily unavailable, sir. I saved the coding job and will continue it automatically when they recover. Nothing was changed.';
    case FAILURE_CLASS.PERMANENT_EXTERNAL:
      return kind === 'authentication'
        ? 'GitHub rejected CHE’s credentials, sir. The CHE GitHub token on the Worker needs to be renewed before I can continue. Nothing was changed.'
        : 'GitHub refused access for this operation, sir (permission or billing). That has to be fixed on the GitHub side before I can continue. Nothing was changed.';
    case FAILURE_CLASS.AUTHORIZATION:
      return 'This next step needs your approval, sir.';
    default:
      return 'My coding team tried three materially different approaches against the current source and none passed independent review and validation, sir. I stopped instead of looping. Nothing was changed, and I kept the engineering record for the next attempt.';
  }
}

// Stable short hash (FNV-1a) for idempotency keys; not for security.
export function stableHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function idempotencyKey(kind, value) {
  const normalized = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${kind}:${stableHash(normalized)}:${normalized.length}`;
}
