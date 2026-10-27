// CHE coding failover policy: what a failed model attempt means, when a paused
// coding job may resume, and what the next model must be told. Pure functions,
// no network, no git. The Worker and the OpenCode runner both use this module,
// so the two never disagree about which failures are worth another attempt.

// A capacity failure (quota, rate limit, timeout) clears on its own, so the job
// resumes from its verified checkpoint after a backoff. A bounded count stops
// the loop: after RESUME_LIMIT resumes the job goes to CHE's own coding team.
export const RESUME_LIMIT = 3;
export const RESUME_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 180 * 60_000];
// A dispatched resume that no runner has claimed within this window is given up.
export const RESUME_CLAIM_WAIT_MS = 20 * 60_000;
// A checkpoint must fit one GitHub contents write (1 MB, base64 adds a third).
export const CHECKPOINT_MAX_BYTES = 300_000;

// Ordered: the first matching rule wins. A too-large request is not a capacity
// problem (retrying the same request cannot succeed), so it is checked first.
const RULES = [
  {
    kind: 'too_large', resumable: false,
    pattern: /ContextOverflowError|Request too large|context length|request too large/i,
    words: 'the request is larger than the token limit of that model key',
  },
  {
    kind: 'quota', resumable: true,
    pattern: /exceeded your current quota|RESOURCE_EXHAUSTED|insufficient_quota|quota exceeded/i,
    words: 'the provider\'s quota for that key is used up',
  },
  {
    kind: 'rate_limit', resumable: true,
    pattern: /rate.?limit|too many requests|statusCode"?\s*:\s*429|\b429\b/i,
    words: 'the provider is rate limiting that key right now',
  },
  {
    kind: 'access', resumable: false,
    pattern: /does not exist or you do not have access|statusCode"?\s*:\s*(?:401|403|404)|invalid api key|unauthori[sz]ed/i,
    words: 'the key has no access to that model',
  },
];

// The model's own text decides the kind. Exit 124 is the time budget running out.
export function classifyModelFailure({ text = '', exitCode = 0 } = {}) {
  const message = String(text || '');
  for (const rule of RULES) {
    if (rule.pattern.test(message)) return { kind: rule.kind, resumable: rule.resumable, words: rule.words };
  }
  if (Number(exitCode) === 124 || /timed out/i.test(message)) {
    return { kind: 'timeout', resumable: true, words: 'it ran out of time' };
  }
  return { kind: 'unknown', resumable: false, words: '' };
}

// One receipt per model attempt, kept in the job record. The record used to keep only the
// last attempt's error, so an earlier model's quota, size or access failure was lost. `progress`
// says what happened to the attempt's edits: none, verified (kept as the checkpoint), reverted,
// unverifiable (could not be reverted) or delivered (a successful attempt's change).
const RECEIPT_PROGRESS = Object.freeze(['none', 'verified', 'reverted', 'unverifiable', 'delivered']);

// The one redactor for every text CHE's coding runner stores or logs: the receipt here, and each
// runner shell line that logs or stores error text (the free and paid model steps and the PR step),
// through `che_coding_checkpoint.mjs redact`. Covers provider keys, bearer and basic authorization,
// key headers, key-like query and form parameters, and token fields in JSON. Replaces, never reports.
const SECRET_PATTERNS = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [key]'],
  [/(\bAuthorization\s*[:=]\s*["']?\s*Basic\s+)[A-Za-z0-9+\/=._-]+/gi, '$1[key]'],
  [/(\b(?:x-api-key|x-goog-api-key|x-auth-token|api-key|apikey)\s*:\s*["']?)[^\s"',;]+/gi, '$1[key]'],
  [/\b(?:sk-or-|sk-|sk_live_|sk_test_|xai-|gsk_|csk-|hf_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[key]'],
  [/\bAIza[0-9A-Za-z_-]{8,}/g, '[key]'],
  [/\bya29\.[A-Za-z0-9._-]{8,}/g, '[key]'],
  [/([?&](?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|auth|secret|password|client[_-]?secret)=)[^&\s"'<>]+/gi, '$1[key]'],
  [/(\b(?:client[_-]?secret|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token)=)[^&\s"'<>]+/gi, '$1[key]'],
  [/(\\?"(?:x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|client[_-]?secret)\\?"\s*:\s*\\?")[^"\\]*/gi, '$1[key]'],
]);

export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// ─── Router error taxonomy (owner, 2026-10-27) ───
// Every failed model attempt gets exactly one of these classes. The class decides what the
// router does next (failoverDecision) and how the circuit breaker reacts (breakerAfter).
//   provider_unavailable  the provider or OpenCode's own server failed (5xx, "Unexpected server error")
//   auth_failure          the key is missing, invalid or not allowed (401/403)
//   rate_limited          a short-window limit (429, requests or tokens per minute)
//   credit_exhausted      a free allowance or credit balance is used up (quota, free-models-per-day)
//   billing_risk          the request would cost money (402, payment required, a non-zero cost seen)
//   unsupported_model     this model cannot serve this request (404, no tools, context too small)
//   task_failure          the model ran but did not finish the task (timeout, non-zero exit, no cause)
export const ERROR_CLASSES = Object.freeze([
  'provider_unavailable', 'auth_failure', 'rate_limited', 'credit_exhausted', 'billing_risk', 'unsupported_model', 'task_failure',
]);

// A status code only counts when the text says it is one (statusCode, status, HTTP), so token
// counts or timestamps such as "Limit 500" or "...1792941401..." never classify an error.
const STATUS_IN_TEXT = /(?:status(?:_?code)?|statusCode|HTTP(?:\/\d(?:\.\d)?)?|code)"?\s*[:= ]\s*"?(\d{3})\b/i;

// Ordered: the first matching rule wins. Billing first, so a 402 is never mistaken for a quota;
// a quota before a rate limit, because providers send both with HTTP 429.
const CLASS_RULES = [
  ['billing_risk', /payment required|insufficient (?:credits|balance|funds)|requires? (?:a )?(?:payment|billing|paid (?:plan|tier|account))|add (?:a )?payment method|negative (?:credit )?balance|billing (?:account )?(?:is )?(?:not )?(?:enabled|required)|non-zero cost|would be charged/i, [402]],
  ['credit_exhausted', /exceeded your current quota|insufficient_quota|RESOURCE_EXHAUSTED|quota (?:exceeded|exhausted)|free-models-per-day|out of credits|credits? (?:are |is )?(?:exhausted|used up|depleted)|(?:monthly|daily) (?:credits?|quota|limit) (?:reached|exceeded|used)|exceeded (?:your )?(?:monthly|daily) (?:included )?(?:credits?|quota)/i, []],
  ['unsupported_model', /does not exist or you do not have access|model[_ ]?not[_ ]?found|ProviderModelNotFoundError|ModelNotFound|no endpoints found|not a valid model|unknown model|model .{0,40}(?:decommissioned|deprecated|retired)|does not support tool|tool(?:s| use| calling) (?:is |are )?not supported|ContextOverflowError|context (?:length|window)|request too large|maximum context|too many tokens/i, [404]],
  ['auth_failure', /invalid[_ ]?api[_ ]?key|api key not valid|incorrect api key|unauthori[sz]ed|forbidden|no auth credentials|authentication (?:failed|required|error)|missing api key|permission denied|key (?:is )?(?:revoked|disabled)/i, [401, 403]],
  ['rate_limited', /rate.?limit|too many requests|tokens per (?:minute|day)|requests per (?:minute|day)|\bTPM\b|\bRPM\b|slow down/i, [429]],
  ['provider_unavailable', /Unexpected server error|UnknownError|internal server error|service unavailable|bad gateway|gateway time-?out|overloaded|upstream (?:error|connect)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|provider returned error/i, [500, 502, 503, 504, 520, 522, 524, 529]],
];

// One class for a failed attempt. `status` is the HTTP status when the caller has it; otherwise
// a status written in the error text is used. A clean exit is never classified.
export function classifyRouterError({ text = '', status = 0, exitCode = 1 } = {}) {
  const message = String(text || '');
  const fromText = Number((message.match(STATUS_IN_TEXT) || [])[1]) || 0;
  const code = Number(status) || fromText;
  for (const [cls, pattern] of CLASS_RULES) if (pattern.test(message)) return cls;
  for (const [cls, , codes] of CLASS_RULES) if (codes.includes(code)) return cls;
  if (code >= 500 && code < 600) return 'provider_unavailable';
  return 'task_failure';
}

// What the router does after one failed attempt. `scope: provider` skips every model of that
// provider for the rest of the run; `scope: model` skips only that model. Progress made by the
// failed attempt is always kept as the verified checkpoint for the next model (the runner's job).
// `resumable`: a later run of the same session may succeed once the limit clears.
const DECISIONS = Object.freeze({
  provider_unavailable: { scope: 'model', next: 'next_model', resumable: true, cooldown_ms: 10 * 60_000, open_after: 2 },
  auth_failure: { scope: 'provider', next: 'next_provider', resumable: false, cooldown_ms: 6 * 60 * 60_000, open_after: 1 },
  rate_limited: { scope: 'model', next: 'next_model', resumable: true, cooldown_ms: 5 * 60_000, open_after: 1 },
  credit_exhausted: { scope: 'provider', next: 'next_provider', resumable: true, cooldown_ms: 60 * 60_000, open_after: 1 },
  billing_risk: { scope: 'provider', next: 'next_provider', resumable: false, cooldown_ms: 7 * 24 * 60 * 60_000, open_after: 1, alert: true },
  unsupported_model: { scope: 'model', next: 'next_model', resumable: false, cooldown_ms: 24 * 60 * 60_000, open_after: 1 },
  task_failure: { scope: 'model', next: 'next_model_with_checkpoint', resumable: false, cooldown_ms: 30 * 60_000, open_after: 3 },
});

// An allowance can belong to one model (Gemini and Groq free quotas are per model) or to the whole
// account (OpenRouter's free requests per day, a credit balance). Only the account-wide kind stops
// every model of the provider; a per-model quota moves on to the provider's next model.
const ACCOUNT_WIDE_ALLOWANCE = /free-models-per-day|credits?\b|balance|account (?:limit|quota)|monthly (?:included )?(?:usage|credits?)/i;

export function failoverDecision(errorClass, { text = '' } = {}) {
  const decision = DECISIONS[errorClass] || DECISIONS.task_failure;
  const cls = DECISIONS[errorClass] ? errorClass : 'task_failure';
  const scope = cls === 'credit_exhausted' && !ACCOUNT_WIDE_ALLOWANCE.test(String(text || '')) ? 'model' : decision.scope;
  return { error_class: cls, ...decision, scope, next: scope === 'model' && decision.next === 'next_provider' ? 'next_model' : decision.next };
}

// ─── Circuit breaker ───
// One record per provider ("openrouter") or per model ("openrouter/x:free"). Closed: used.
// Open: skipped until `until`. Half-open: the cooldown passed, so exactly one trial is allowed;
// its success closes the breaker, its failure re-opens it with twice the cooldown (max 7 days).
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

export function breakerState(record, now = Date.now()) {
  if (!record || record.state === 'closed' || !record.state) return 'closed';
  if (record.state === 'open' && Number.isFinite(Date.parse(record.until)) && Date.parse(record.until) <= now) return 'half_open';
  return record.state === 'half_open' ? 'half_open' : 'open';
}

export function breakerAllows(record, now = Date.now()) {
  return breakerState(record, now) !== 'open';
}

export function breakerAfter(record, { ok = false, errorClass = 'task_failure', now = Date.now() } = {}) {
  const prior = record && typeof record === 'object' ? record : {};
  const at = new Date(now).toISOString();
  if (ok) return { state: 'closed', failures: 0, last_ok_at: at, last_error_class: prior.last_error_class || null, cooldown_ms: 0 };
  const decision = failoverDecision(errorClass);
  const wasTrial = breakerState(prior, now) === 'half_open';
  const failures = Number(prior.failures || 0) + 1;
  const open = wasTrial || failures >= decision.open_after;
  if (!open) return { ...prior, state: 'closed', failures, last_error_class: decision.error_class, last_error_at: at };
  const cooldown = Math.min(MAX_COOLDOWN_MS, wasTrial ? Math.max(decision.cooldown_ms, Number(prior.cooldown_ms || 0) * 2) : decision.cooldown_ms);
  return {
    state: 'open', failures, last_error_class: decision.error_class, last_error_at: at,
    opened_at: at, cooldown_ms: cooldown, until: new Date(now + cooldown).toISOString(),
  };
}

export function attemptReceipt({ model = '', exitCode = 0, text = '', seconds = 0, capSeconds = 0, progress = 'none', coverage = '', startedAt = '' } = {}) {
  const code = Number(exitCode) || 0;
  const verdict = code === 0 ? { kind: 'success', resumable: false } : classifyModelFailure({ text, exitCode: code });
  const excerpt = code === 0 ? '' : redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 300);
  const name = String(model || '').slice(0, 120);
  // Exit 124 is the time budget; 75 is the runner stopping a model at its first fatal error.
  const errorClass = code === 0 ? null : classifyRouterError({ text: code === 124 && !String(text || '').trim() ? 'timed out' : text, exitCode: code });
  const decision = errorClass ? failoverDecision(errorClass, { text }) : null;
  return {
    model: name,
    exit_code: code,
    kind: verdict.kind,
    resumable: Boolean(verdict.resumable),
    seconds: Math.max(0, Math.round(Number(seconds) || 0)),
    cap_seconds: Math.max(0, Math.round(Number(capSeconds) || 0)),
    progress: RECEIPT_PROGRESS.includes(progress) ? progress : 'none',
    error: excerpt,
    // Router fields (2026-10-27). `kind` above stays for older readers.
    provider: name.includes('/') ? name.split('/')[0] : '',
    error_class: errorClass,
    decision: decision ? decision.next : 'completed',
    scope: decision ? decision.scope : null,
    outcome: code === 0 ? 'success' : 'failed',
    coverage: ['free', 'credit_covered'].includes(coverage) ? coverage : null,
    ...(startedAt ? { started_at: String(startedAt).slice(0, 30) } : {}),
  };
}

// Decide whether a resumable failure gets another run, and when. `resumeCount`
// is how many resumes already ran for this session.
export function resumeDecision({ resumable = false, resumeCount = 0, now = Date.now(), notBefore = '' } = {}) {
  const count = Math.max(0, Math.floor(Number(resumeCount) || 0));
  if (!resumable) return { resume: false, reason: 'not_capacity' };
  if (count >= RESUME_LIMIT) return { resume: false, reason: 'limit_reached' };
  const cooldown = Date.parse(notBefore);
  const at = Math.max(now + RESUME_BACKOFF_MS[count], Number.isFinite(cooldown) ? cooldown : 0);
  return { resume: true, reason: 'capacity', attempt: count + 1, at: new Date(at).toISOString() };
}

// Paths that never reach an automatic change. Shared by the runner's result
// step and its checkpoint verifier, so a checkpoint cannot carry a file the
// final patch would refuse.
const UNSAFE_PATHS = [
  /^(?:\.github\/|\.git\/|\.opencode\/)/i,
  // The gate and the verifier decide paid use and what a checkpoint may contain: an attempt
  // must never change them. The runner also runs trusted copies taken from the base.
  /^tools\/che_coding_/i,
  /^server\/cloudflare\/coding_failover\.mjs$/i,
  /(?:^|\/)(?:\.env(?:\.|$)|secrets?\b|credentials?\b)/i,
  /\.(?:pem|p12|mobileprovision|key|keystore|jks)$/i,
  /^(?:pubspec\.ya?ml|pubspec\.lock|server\/cloudflare\/(?:package(?:-lock)?\.json|wrangler\.jsonc))$/i,
  /^ios\/.*\.(?:plist|pbxproj|xcconfig|entitlements)$/i,
  /^android\/.*\.(?:gradle|kts|properties)$/i,
];

export function unsafeCodingPaths(files = []) {
  return (Array.isArray(files) ? files : []).map(String).filter((path) => UNSAFE_PATHS.some((rule) => rule.test(path)));
}

// The prompt for the next model: the original request plus what is already
// verified, so it continues instead of redoing or reverting the change.
// `history` is the earlier attempts' receipts (model, error_class, progress), so the next model
// knows what already failed and why. `checked` lists files whose syntax check passed. Neither
// carries error text: only classes and names, so no provider output reaches the next prompt.
export function progressPrompt({ basePrompt = '', files = [], additions = 0, deletions = 0, attempt = 1, history = [], checked = [] } = {}) {
  const list = (Array.isArray(files) ? files : []).map(String).slice(0, 20);
  const verified = (Array.isArray(checked) ? checked : []).map(String).slice(0, 20);
  const earlier = (Array.isArray(history) ? history : []).filter((row) => row && row.model).slice(-8)
    .map((row) => `${String(row.model).slice(0, 80)} (${String(row.error_class || row.kind || 'failed')}${row.progress && row.progress !== 'none' ? `, ${row.progress}` : ''})`);
  const lines = [
    String(basePrompt || '').trimEnd(),
    '',
    `VERIFIED PROGRESS (attempt ${attempt}; do not redo or revert it):`,
    list.length
      ? `Changed files so far: ${list.join(', ')} (+${Number(additions) || 0}/-${Number(deletions) || 0}).`
      : 'No files are changed yet.',
    'The working tree already holds this change and it passed syntax checks.',
    ...(verified.length ? [`Checks already passed: syntax of ${verified.join(', ')}. Tests have not been run by the runner yet.`] : []),
    ...(earlier.length ? [`Earlier attempts in this job: ${earlier.join('; ')}.`] : []),
    'Outstanding: whatever the owner request still needs beyond the changed files above.',
    'Read only the files you need, then finish the remaining work and keep the change small.',
  ];
  return lines.join('\n');
}

// Failure kinds the Worker may report as resumable, for the spoken status.
export const RESUMABLE_KINDS = Object.freeze(['quota', 'rate_limit', 'timeout']);

// A saved resume: the session id it dispatches, and the count it expects the runner to
// claim. `dispatched_at` is set once the same session was dispatched again.
// Decides what a pending resume should do now. Pure: the Worker supplies what it read.
//   'wait_backoff'  the backoff has not ended; nothing is dispatched
//   'dispatch'      the backoff ended; dispatch the same session
//   'wait_claim'    dispatched, and a run is queued or running but has not claimed yet
//   'claimed'       the runner claimed the resume (its claim count is in the record)
//   'give_up'       dispatched, no live run and never claimed: nothing will resume it
export function resumeAction({ pending, status = {}, runAlive = 'unknown', now = Date.now() } = {}) {
  if (!pending) return 'none';
  if (!pending.dispatched_at) return Date.parse(pending.next_at) > now ? 'wait_backoff' : 'dispatch';
  if (Number(status.resume_count || 0) >= Number(pending.resume_count || 0) + 1) return 'claimed';
  if (runAlive === 'alive' || runAlive === 'unknown') return 'wait_claim';
  return 'give_up';
}

// What a new owner mission does with a resume still pending. A resume that may still
// run (dispatched, and a run is alive or cannot be checked) refuses the new mission, so
// two runners never open PRs for different work. Otherwise the pending resume is dropped.
export function newMissionAction({ pending = null, runAlive = 'unknown' } = {}) {
  if (!pending) return 'start';
  if (pending.dispatched_at && (runAlive === 'alive' || runAlive === 'unknown')) return 'refuse';
  return 'abandon';
}
