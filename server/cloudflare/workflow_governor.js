// CHE Super-AI Workflow Governor.
//
// Pure, deterministic policy that decides HOW CHE should work before any AI
// provider is chosen. It never performs inference: retrieval and
// deterministic tools get first refusal (knowledge_cache.js and the chat
// path), and models are escalation steps. Scores are cheap text/flag checks.

export const WORKFLOWS = Object.freeze({
  INSTANT: 'instant_answer',
  DEEP_REASONING: 'deep_reasoning',
  FAST_CODING: 'fast_coding',
  DEEP_CODING: 'deep_coding',
  BUG_HUNT: 'bug_hunt',
  RECOVERY: 'recovery',
  RESEARCH: 'research',
  MULTI_AGENT: 'multi_agent',
  WAR_ROOM: 'war_room',
  DEGRADED: 'offline_degraded',
});

// Where CHE looks before spending inference, cheapest and most owner-specific first.
export const RETRIEVAL_ORDER = Object.freeze([
  'active_conversation',
  'job_checkpoint',
  'owner_memory',
  'knowledge_cache',
  'mailbox',
  'repository_index',
  'research_library',
  'deterministic_tools',
]);

// Engine tier and review per workflow: the cheapest capable setup.
const PROFILE = {
  [WORKFLOWS.INSTANT]: { tier: 'small', cross_check: false },
  [WORKFLOWS.DEEP_REASONING]: { tier: 'strong', cross_check: false },
  [WORKFLOWS.FAST_CODING]: { tier: 'standard', cross_check: false },
  [WORKFLOWS.DEEP_CODING]: { tier: 'strong', cross_check: true },
  [WORKFLOWS.BUG_HUNT]: { tier: 'strong', cross_check: false },
  [WORKFLOWS.RECOVERY]: { tier: 'standard', cross_check: false },
  [WORKFLOWS.RESEARCH]: { tier: 'standard', cross_check: false },
  [WORKFLOWS.MULTI_AGENT]: { tier: 'standard', cross_check: true },
  [WORKFLOWS.WAR_ROOM]: { tier: 'strong', cross_check: true },
  [WORKFLOWS.DEGRADED]: { tier: 'small', cross_check: false },
};

// Words that mean CHE should change software (not words that merely appear in
// questions about it: "what is my Worker URL?" is not a coding task).
const CODE_ACTION = /\b(?:implement|refactor|write (?:the |a |some )?code|code (?:this|it|a|the)|add (?:a |an |the )?(?:function|method|endpoint|route|test|screen|button|feature)|change (?:the |this |your )?(?:code|ui|screen|button|label|layout)|edit (?:the )?(?:code|file)|pull request|open a pr|create the pr|merge (?:it|the pr)|compile|stack trace|unit test|flutter|dart file|\.dart\b|\.js\b|\.ts\b)/i;
const BUG = /\b(?:bug|broken|crash(?:es|ed|ing)?|exception|stack trace|regression|debug|root cause|not working|doesn'?t work|failing (?:test|check|build)|fix (?:the |this |a )?(?:bug|error|crash|issue|failure|test|build))\b/i;
// A bug hunt is about CHE's software, not "my wifi is not working".
const SOFTWARE = /\b(?:app|code|test|tests|build|ci|worker|flutter|dart|screen|function|crash(?:es|ed)?|exception|stack trace|endpoint|api|pr|deploy(?:ment)?|che)\b/i;
const RESEARCH = /\b(?:research|investigate|find out|look into|sources?|compare|study|prior art|state of the art)\b/i;
const FRESH = /\b(?:latest|current(?:ly)?|today|tonight|right now|this (?:week|month)|news|price|quote|weather|score|live|breaking|newest|recent(?:ly)?)\b/i;
// High stakes = a consequential ACTION on money, trading, production,
// credentials or security, not talking about them and not ordinary chores
// ("send the file to Bob"). Owner confirmation rules still apply everywhere.
const HIGH_RISK = /\b(?:(?:transfer|wire|pay|send)\b[\s\S]{0,30}(?:\b(?:money|funds|payment)\b|\$\s?\d+)|(?:place|execute|buy|sell|close)\b[\s\S]{0,30}\b(?:orders?|positions?|contracts?|trades?|shares)|(?:deploy|migrate|drop|wipe|truncate)\b[\s\S]{0,40}\b(?:production|prod|database|db)|(?:delete|wipe)\b[\s\S]{0,30}\b(?:production|database|all (?:users|data|accounts))|(?:rotate|revoke)\b[\s\S]{0,30}\b(?:keys?|credentials?|secrets?|tokens?)|security (?:incident|breach)|compromised|leaked (?:keys?|secrets?|passwords?|tokens?)|irreversible)\b/i;
const COMPLEX = /\b(?:architect(?:ure)?|redesign|system[- ]wide|end[- ]to[- ]end|across (?:the )?(?:app|codebase|system)|entire|complex|multi[- ]step|several files|migration plan|trade[- ]?offs?|prove|derive)\b/i;
const PARALLEL = /\b(?:in parallel|parallel(?:ize)?|independent (?:agents|tasks)|team up|work together|whole team|several agents|split (?:it|this) up)\b/i;
const UNCERTAIN = /\b(?:not sure|unsure|maybe|might|could be|which (?:is|one)|should i|best way|why (?:does|is|did))\b|\?\s*$/i;

function textOf(input = {}) {
  if (typeof input.text === 'string') return input.text;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) return last.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return '';
}

function contextChars(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return messages.reduce((sum, m) => sum + (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content || '').length), 0);
}

const clamp = (x) => Math.max(0, Math.min(1, x));

/**
 * Cheap signals, each 0..1 (est_tokens is a count): complexity, risk,
 * uncertainty, parallelism benefit, freshness need, estimated tokens and the
 * health of the engines CHE could use right now.
 */
export function assessTask(input = {}, ctx = {}) {
  const text = textOf(input);
  const chars = Math.max(text.length, contextChars(input));
  const complexity = clamp((COMPLEX.test(text) ? 0.5 : 0) + Math.min(0.5, chars / 8000) + (input.complex === true ? 0.5 : 0));
  const risk = clamp((HIGH_RISK.test(text) ? 0.9 : 0) + (input.high_risk === true ? 1 : 0));
  const uncertainty = clamp((UNCERTAIN.test(text) ? 0.4 : 0) + (input.uncertain === true ? 0.6 : 0));
  const parallelism = clamp((PARALLEL.test(text) ? 0.8 : 0) + (input.parallel_benefit === true ? 1 : 0));
  const freshness = clamp((FRESH.test(text) ? 0.8 : 0) + (input.needs_fresh === true ? 1 : 0));
  const est_tokens = Math.ceil(chars / 4) + 600;
  const engine_health = Number.isFinite(ctx.engine_health) ? clamp(ctx.engine_health) : 1;
  return { complexity, risk, uncertainty, parallelism, freshness, est_tokens, engine_health };
}

/**
 * The cheapest workflow that can safely do the job. Runtime facts (offline,
 * resuming a checkpoint, an explicit war-room/multi-agent request) beat text
 * heuristics so a saved failure always resumes as recovery.
 */
export function planWorkflow(input = {}, ctx = {}) {
  const text = textOf(input);
  const s = assessTask(input, ctx);
  let workflow;
  if (input.offline === true || input.cloud_unavailable === true || ctx.healthy_engines === 0 || s.engine_health < 0.15) workflow = WORKFLOWS.DEGRADED;
  else if (input.resume_checkpoint === true || input.recovering === true) workflow = WORKFLOWS.RECOVERY;
  else if (input.war_room === true || s.risk >= 0.8) workflow = WORKFLOWS.WAR_ROOM;
  else if (s.parallelism >= 0.8) workflow = WORKFLOWS.MULTI_AGENT;
  else if (BUG.test(text) && SOFTWARE.test(text)) workflow = WORKFLOWS.BUG_HUNT;
  else if (CODE_ACTION.test(text) || input.coding === true) workflow = (s.complexity >= 0.5 || s.est_tokens > 2500) ? WORKFLOWS.DEEP_CODING : WORKFLOWS.FAST_CODING;
  else if (RESEARCH.test(text) || s.freshness >= 0.8) workflow = WORKFLOWS.RESEARCH;
  else if (s.complexity >= 0.5 || s.uncertainty >= 0.6) workflow = WORKFLOWS.DEEP_REASONING;
  else workflow = WORKFLOWS.INSTANT;
  return { workflow, ...PROFILE[workflow], retrieval_first: true, scores: s };
}

export function selectWorkflow(input = {}, ctx = {}) {
  return planWorkflow(input, ctx).workflow;
}

/**
 * A trustworthy known answer bypasses model inference. Candidates come from
 * CHE's memory/cache/mailbox/repository/tool layers. Expired entries and,
 * when freshness matters, entries older than `freshnessMs` are rejected so
 * stale memory never overrides an authoritative fresh check.
 */
export function chooseKnownAnswer(candidates = [], { now = Date.now(), freshnessMs = null, minConfidence = 0.8 } = {}) {
  const ordered = new Map(RETRIEVAL_ORDER.map((name, i) => [name, i]));
  return candidates
    .filter((item) => item && item.found === true && item.value != null && String(item.value).trim())
    .filter((item) => (Number.isFinite(item.confidence) ? item.confidence : 1) >= minConfidence)
    .filter((item) => !(Number.isFinite(item.expires_at) && now > item.expires_at))
    .filter((item) => {
      if (!Number.isFinite(freshnessMs)) return true;
      return Number.isFinite(item.verified_at) && now - item.verified_at <= freshnessMs;
    })
    .sort((a, b) => ((ordered.get(a.source) ?? 999) - (ordered.get(b.source) ?? 999)) || ((b.verified_at || 0) - (a.verified_at || 0)))[0] || null;
}

export function inferenceDecision(candidates = [], options = {}) {
  const known = chooseKnownAnswer(candidates, options);
  return known
    ? { use_engine: false, source: known.source, value: known.value }
    : { use_engine: true, source: null, value: null };
}

/**
 * Healthy → Caution → Draining (default 70% of the provider's budget, or
 * poor health) → Offline. Draining engines are used only after healthy ones,
 * so CHE switches before an engine is exhausted and keeps a reserve.
 */
export function engineCapacityState({ utilization = 0, health = 1, hard_failure = false } = {}, drainAt = 0.70) {
  if (hard_failure || health <= 0.15 || utilization >= 1) return 'offline';
  if (utilization >= drainAt || health < 0.45) return 'draining';
  if (utilization >= Math.max(0, drainAt - 0.15) || health < 0.70) return 'caution';
  return 'healthy';
}

export function shouldSwitchEngine(state) {
  return state === 'draining' || state === 'offline';
}

/** Stable reorder: healthy and caution first, then draining, then offline. */
export function drainOrder(entries = [], stateOf = () => 'healthy') {
  const rank = { healthy: 0, caution: 0, draining: 1, offline: 2 };
  return entries
    .map((entry, index) => ({ entry, index, rank: rank[stateOf(entry)] ?? 0 }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((item) => item.entry);
}

/**
 * Recoverable infrastructure noise belongs in diagnostics, not owner chat.
 * Security/data-integrity risk, exhausted recovery, money, destructive
 * actions and owner-only decisions always surface. Unknown failures surface.
 */
export function ownerNotificationPolicy(event = {}) {
  if (event.owner_action_required) return { notify: true, reason: 'owner_action' };
  if (event.security_risk || event.data_integrity_risk || event.financial_action || event.destructive_action || event.safety_critical) {
    return { notify: true, reason: 'critical_boundary' };
  }
  if (event.recovery_exhausted) return { notify: true, reason: 'recovery_exhausted' };
  if (event.recoverable === true) return { notify: false, reason: 'silent_recovery' };
  return { notify: true, reason: 'unclassified_failure' };
}

/**
 * Drops exact repeats of large evidence blocks from a chat payload, keeping
 * the LAST copy. System messages, short turns (a repeated "yes" means
 * something) and non-text content (images, tool calls) are never touched,
 * and nothing is dropped for size: budgets are enforced elsewhere.
 */
export function dedupeEvidence(messages = [], minChars = 400) {
  if (!Array.isArray(messages)) return messages;
  const textOfMessage = (m) => (typeof m?.content === 'string' ? m.content.trim() : null);
  const lastIndex = new Map();
  messages.forEach((m, i) => {
    const t = textOfMessage(m);
    if (m?.role !== 'system' && t && t.length >= minChars) lastIndex.set(t, i);
  });
  const keep = messages.map((m, i) => {
    const t = textOfMessage(m);
    return m?.role === 'system' || !t || t.length < minChars || lastIndex.get(t) === i;
  });
  // Never create two same-role turns in a row: an earlier copy is kept when
  // dropping it would join its neighbours (strict-alternation APIs reject that).
  for (let i = 0; i < messages.length; i += 1) {
    if (keep[i]) continue;
    let prev = i - 1; while (prev >= 0 && !keep[prev]) prev -= 1;
    let next = i + 1; while (next < messages.length && !keep[next]) next += 1;
    if (prev >= 0 && next < messages.length && messages[prev]?.role === messages[next]?.role && messages[prev]?.role !== 'system') keep[i] = true;
  }
  return messages.filter((_, i) => keep[i]);
}

/** Distinct context snippets within a character budget (for callers packing evidence). */
export function minimalContext(items = [], maxChars = 12000) {
  const seen = new Set();
  let used = 0;
  const packed = [];
  for (const item of items) {
    const value = String(item?.text ?? item ?? '').trim();
    if (!value || seen.has(value)) continue;
    if (used + value.length > maxChars) continue;
    seen.add(value);
    packed.push(value);
    used += value.length;
  }
  return packed;
}

// Context-rot defense without an AI summarizer. Recent turns stay verbatim;
// older turns are condensed deterministically into the lines that must never
// be lost: owner constraints and permissions, decisions, objectives, failed
// strategies, verified facts and repository SHAs. Everything else in the old
// history is dropped (it is completed, and repeating it only costs tokens).
const PINNED = /\b(?:don'?t|do not|never|always|must|only|stop|permission|allowed|authori[sz]e|approve[ds]?|confirm|forbid|objective|goal|mission|decid(?:e|ed)|plan is|we agreed|remember|failed|tried|didn'?t work|broke|sha\b|commit [0-9a-f]{7}|[0-9a-f]{7,40}\b(?=.*(?:sha|commit|head|main))|unresolved|still need|todo|next step)\b/i;

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

/**
 * history: [{role, content}] oldest first. Returns { turns, condensed, dropped }:
 * the last `keep` turns verbatim, plus (when older turns exist) one condensed
 * state block of their pinned sentences, bounded to `maxCondensedChars`.
 */
export function condenseHistory(history = [], { keep = 12, maxCondensedChars = 1800, maxTurnChars = 2000 } = {}) {
  const clean = (Array.isArray(history) ? history : [])
    .filter((item) => item && ['user', 'assistant'].includes(item.role))
    .map((item) => ({ role: item.role, content: String(item.content ?? item.text ?? '') }));
  // Recent turns are the live conversational state. Never clip their tail:
  // final constraints commonly occur at the end of a long owner request.
  // maxTurnChars is retained for API compatibility but intentionally applies
  // only to older deterministic condensation, not the live recent turns.
  const recent = clean.slice(-keep).map((t) => ({ ...t }));
  const older = clean.slice(0, Math.max(0, clean.length - keep));
  if (!older.length) return { turns: recent, condensed: '', dropped: 0 };
  const seen = new Set();
  const pinned = [];
  for (const turn of older) {
    for (const sentence of turn.content.split(/(?<=[.!?])\s+|\n+/)) {
      const s = sentence.trim().replace(/\s+/g, ' ');
      if (s.length < 6 || !PINNED.test(s)) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pinned.push(`${turn.role === 'user' ? 'Owner' : 'CHE'}: ${s.slice(0, 300)}`);
    }
  }
  // Newest pinned lines win when the block is over budget.
  const lines = [];
  let used = 0;
  for (const line of pinned.reverse()) {
    if (used + line.length + 1 > maxCondensedChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  const condensed = lines.length
    ? `Earlier in this conversation (condensed by CHE; ${older.length} older turns; constraints and decisions still apply):\n${lines.join('\n')}`
    : '';
  return { turns: recent, condensed, dropped: older.length };
}
