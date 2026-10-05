// CHE Super-AI Workflow Governor.
//
// Pure, deterministic policy that decides HOW CHE should work before choosing
// an AI provider. It deliberately does not perform inference: retrieval and
// deterministic tools get first refusal, and models are escalation steps.

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

const CODING = /\b(?:code|coding|implement|refactor|flutter|dart|javascript|worker|function|class|repository|repo|pull request|\bpr\b)\b/i;
const BUG = /\b(?:bug|broken|error|failure|failing|regression|debug|root cause|fix)\b/i;
const RESEARCH = /\b(?:research|investigate|find out|sources?|compare|study|latest|current)\b/i;
const HIGH_RISK = /\b(?:production data|security|credential|secret|payment|trade|money|delete|remove|irreversible|deploy database|migration)\b/i;
const COMPLEX = /\b(?:architect|architecture|redesign|system-wide|entire|complex|deep|multi-agent|parallel)\b/i;

function textOf(input = {}) {
  if (typeof input.text === 'string') return input.text;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

/**
 * Pick the cheapest sufficient execution strategy. Explicit runtime facts beat
 * language heuristics so a saved failure always resumes as recovery.
 */
export function selectWorkflow(input = {}) {
  const text = textOf(input);
  if (input.offline === true || input.cloud_unavailable === true) return WORKFLOWS.DEGRADED;
  if (input.resume_checkpoint === true || input.recovering === true) return WORKFLOWS.RECOVERY;
  if (input.high_risk === true || HIGH_RISK.test(text)) return WORKFLOWS.WAR_ROOM;
  if (input.parallel_benefit === true || /\b(?:parallel|independent agents|team up|work together)\b/i.test(text)) return WORKFLOWS.MULTI_AGENT;
  if (BUG.test(text) && CODING.test(text)) return WORKFLOWS.BUG_HUNT;
  if (CODING.test(text)) return (input.complex === true || COMPLEX.test(text) || text.length > 1800)
    ? WORKFLOWS.DEEP_CODING : WORKFLOWS.FAST_CODING;
  if (RESEARCH.test(text)) return WORKFLOWS.RESEARCH;
  if (input.complex === true || COMPLEX.test(text) || text.length > 1600) return WORKFLOWS.DEEP_REASONING;
  return WORKFLOWS.INSTANT;
}

/**
 * A deterministic/local hit must bypass model inference. Callers may provide
 * candidates from CHE's existing memory/cache/mailbox/repository/tool layers.
 * Freshness-sensitive requests reject stale entries instead of hallucinating.
 */
export function chooseKnownAnswer(candidates = [], { now = Date.now(), freshnessMs = null } = {}) {
  const ordered = new Map(RETRIEVAL_ORDER.map((name, i) => [name, i]));
  return candidates
    .filter((item) => item && item.found === true && item.value != null)
    .filter((item) => {
      if (!Number.isFinite(freshnessMs)) return true;
      if (!Number.isFinite(item.verified_at)) return false;
      return now - item.verified_at <= freshnessMs;
    })
    .sort((a, b) => (ordered.get(a.source) ?? 999) - (ordered.get(b.source) ?? 999))[0] || null;
}

export function inferenceDecision(candidates = [], options = {}) {
  const known = chooseKnownAnswer(candidates, options);
  return known
    ? { use_engine: false, source: known.source, value: known.value }
    : { use_engine: true, source: null, value: null };
}

/**
 * Start draining an engine before it is exhausted. 70% is the owner's default;
 * callers can override it for providers with materially different quotas.
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

/**
 * Recoverable infrastructure noise belongs in diagnostics, not owner chat.
 * Security/data-integrity risk, exhausted recovery, and owner-only decisions
 * always surface.
 */
export function ownerNotificationPolicy(event = {}) {
  if (event.owner_action_required || event.security_risk || event.data_integrity_risk || event.recovery_exhausted) {
    return { notify: true, reason: event.owner_action_required ? 'owner_action' : 'critical_boundary' };
  }
  if (event.recoverable === true) return { notify: false, reason: 'silent_recovery' };
  return { notify: true, reason: 'unclassified_failure' };
}

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
