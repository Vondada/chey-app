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

// Decide whether a resumable failure gets another run, and when. `resumeCount`
// is how many resumes already ran for this session.
export function resumeDecision({ resumable = false, resumeCount = 0, now = Date.now() } = {}) {
  const count = Math.max(0, Math.floor(Number(resumeCount) || 0));
  if (!resumable) return { resume: false, reason: 'not_capacity' };
  if (count >= RESUME_LIMIT) return { resume: false, reason: 'limit_reached' };
  const at = now + RESUME_BACKOFF_MS[count];
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
export function progressPrompt({ basePrompt = '', files = [], additions = 0, deletions = 0, attempt = 1 } = {}) {
  const list = (Array.isArray(files) ? files : []).map(String).slice(0, 20);
  const lines = [
    String(basePrompt || '').trimEnd(),
    '',
    `VERIFIED PROGRESS (attempt ${attempt}; do not redo or revert it):`,
    list.length
      ? `Changed files so far: ${list.join(', ')} (+${Number(additions) || 0}/-${Number(deletions) || 0}).`
      : 'No files are changed yet.',
    'The working tree already holds this change and it passed syntax checks.',
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

