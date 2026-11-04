// "Do X. If you cannot, find out what's missing, build it and show it works": the owner asks CHE to acquire an
// ability, not only to attempt a task. CHE answers it in three steps, through her normal architecture:
//   1. Try. The task part alone goes through her own /api/chat route as a fresh turn, so whichever tool owns it
//      answers (no special case for any task).
//   2. Diagnose. A try that returns a success receipt is done: nothing is built. Otherwise the tool's own answer
//      (its route and what it said it cannot do) is the diagnosis.
//   3. Build. The task, the diagnosis and the owner's own words go to her self-development job, which inspects the
//      repository, plans, implements with tests and opens a pull request only. Nothing merges or deploys from it.
// Money, deletion and secrets are never built this way (the same rule as capability_gap.js).
import { ndjsonReply } from './ndjson_reply.js';
import { loadRegistry, register, saveRegistry } from './capability_registry.js';

// The conditional the owner adds: "if you cannot do this today", "if you can't", "if you are unable to".
const IF_UNABLE = /\b(?:if|in\s+case|should)\s+(?:you|che|jay)\s+(?:can(?:not|['’]t|\s+not)|are\s+(?:unable|not\s+able)\s+to|don['’]t\s+know\s+how\s+to|do\s+not\s+know\s+how\s+to|lack)\b/i;
// What the owner asks CHE to do about it: acquire or build the ability.
const ACQUIRE = /\b(?:implement|build|add|create|develop|acquire|learn|write|code)\b[\s\S]{0,60}\b(?:capabilit(?:y|ies)|abilit(?:y|ies)|feature|tool|support|solution|it|that|this)\b/i;
const NEVER = /\b(?:passwords?|passcodes?|secrets?|api\s*keys?|credentials?|keychain|pay|paying|payments?|purchases?|buy|buying|transfer\w*|bank|delete|deleting|erase|wipe|live\s+(?:trade|trading|order)s?|real[\s-]money)\b/i;
// A question about the idea ("what would you do if you couldn't...?") is not an acquisition request.
const QUESTION_ONLY = /^\s*(?:what|how|why|would|could|should|do|does|is|are|can)\b[^.!]*\?\s*$/i;

/** {task, clause} when the message asks CHE to try a task and acquire the ability if she lacks it; else null. */
export function acquisitionRequest(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 2000 || QUESTION_ONLY.test(text) || NEVER.test(text)) return null;
  const at = text.search(IF_UNABLE);
  if (at <= 0) return null;
  const clause = text.slice(at).trim();
  if (!ACQUIRE.test(clause)) return null;
  const task = text.slice(0, at).replace(/(?:[\s,;:–—-]|\b(?:and|but|so|then)\b)+$/i, '').trim();
  // The task must be a real request of its own, not "If you can't, build it." with nothing before it.
  if (task.split(/\s+/).length < 4) return null;
  return { task: /[.!?]$/.test(task) ? task : `${task}.`, clause };
}

const OK_STATUS = new Set(['success', 'succeeded', 'complete', 'completed', 'ok', 'done']);
// The tool said it is unable: only this is a missing ability. A handler that worked without a receipt, asked a question
// or failed for a passing reason is not (Codex review on #920: "Paper trade SPY" adds SPY with no receipt).
const UNABLE = /\b(?:I|CHE)\s+(?:can(?:not|['’]t|\s+not)|am\s+(?:unable|not\s+able)\s+to|do\s+not\s+(?:have|support)|don['’]t\s+(?:have|support)|have\s+no\s+(?:way|tool|ability|capability))\b|\bnot\s+something\s+I\s+can\b|\bnot\s+(?:supported|available)\s+yet\b/i;

/** What the try showed: done (a success receipt), declined (the tool's own refusal, the diagnosis), or neither. */
export function attemptOutcome(attempt = {}) {
  const receipts = Array.isArray(attempt.receipts) ? attempt.receipts : [];
  const succeeded = receipts.filter((r) => OK_STATUS.has(String(r?.status || '').toLowerCase()));
  const route = String(attempt.done?.source || '') || 'model';
  const reply = String(attempt.reply || '').replace(/\s+/g, ' ').trim();
  if (attempt.ok !== false && succeeded.length) return { done: true, declined: false, route, reply, receipts };
  return { done: false, declined: UNABLE.test(reply), route, reply: reply || '(no answer)', receipts };
}

/** The self-development request: the owner's task, what the try showed, and the owner's own acquisition words. */
export function acquisitionJobRequest({ task, clause }, outcome, { openPr = true } = {}) {
  return [
    `Owner task: ${task}`,
    `When CHE tried this task just now through her own chat route, the ${outcome.route} route answered: "${outcome.reply.slice(0, 800)}" It returned no success receipt, so CHE cannot do this today.`,
    `The owner asked: "${clause}"`,
    `Find in the repository why the route above cannot do the task and which existing modules (data sources, engines, tests) can be reused. Implement the smallest working ability in the Worker so the owner\'s task, asked again in chat, runs for real and answers with an execution receipt; use real data where the task names it, never invented numbers. Add regression tests. ${openPr ? 'Open a pull request only' : 'Prepare the change for the owner\'s review; do not open a pull request, because the owner said not to'}: do not merge, deploy, spend money, place any live trade, delete anything, or read or store a secret.`,
  ].join('\n');
}

/** The owner-visible answer: what CHE tried, what is missing, and the job she queued (or why none started). */
export function acquisitionReply(outcome, queued) {
  const said = outcome.reply.length > 400 ? `${outcome.reply.slice(0, 400)}…` : outcome.reply;
  const lines = [`I tried it first, sir. My ${outcome.route.replace(/^che_/, '').replace(/_/g, ' ')} route answered: "${said}" No result came back with a receipt, so that ability is missing today.`];
  if (queued?.job?.id) {
    const id = String(queued.job.id).slice(0, 8);
    lines.push(queued.deduplicated
      ? `Coding job ${id} for it is already ${queued.job.status}; I did not start a second one.`
      : `I queued coding job ${id} to build it: my coding team reads that route's code, finds what to reuse, implements the missing part with tests${queued.no_pr ? ' and holds it for your review without a pull request, as you asked' : ' and opens a pull request'}.${queued.held ? ' It will not run until you say "resume", because autonomy is paused.' : ''} Nothing merges or deploys until you approve it. When it is live, ask me again and I will run it and show you the result.`);
  } else if (queued?.not_run) {
    lines.push(`I did not start a coding job: ${queued.not_run}`);
  } else {
    lines.push('I could not save the coding job, so nothing started.');
  }
  return lines.join(' ');
}

/** The receipts for the turn: the try (failed, with its route) and the coding job (queued, or not run). */
export function acquisitionReceipts(outcome, queued, at = new Date().toISOString()) {
  const tried = { tool: 'che_capability_acquisition', operation: 'attempt', status: 'failed', route: outcome.route, at, result: outcome.reply.slice(0, 300) };
  const job = queued?.job?.id
    ? { tool: 'che_self_development', operation: 'coding_job', status: queued.held ? 'awaiting_approval' : 'queued', job_id: queued.job.id, at, deduplicated: Boolean(queued.deduplicated) }
    : { tool: 'che_self_development', operation: 'coding_job', status: 'not_run', at, result: String(queued?.not_run || 'not saved').slice(0, 200) };
  return [tried, job];
}

/** The missing ability, in the capability registry as DISCOVERED (never usable) with its diagnosis and coding job. */
export function gapId(task) {
  return `acquire.${String(task).toLowerCase().replace(/^(?:jay|che)\b[\s,]*/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)}`;
}
export async function recordGap(storage, acquire, outcome, jobId, now = new Date().toISOString()) {
  const registry = await loadRegistry(storage);
  const cap = register(registry, {
    capability_id: gapId(acquire.task),
    name: acquire.task.slice(0, 80),
    description: `Requested by the owner; not available yet. Being built by coding job ${jobId}.`,
    category: 'acquired',
    status: 'DISCOVERED',
    implementation_location: `coding job ${jobId}`,
    known_limitations: [`${outcome.route}: ${outcome.reply.slice(0, 300)}`],
  }, now);
  await saveRegistry(storage, registry);
  return cap;
}

/**
 * The whole turn. tryTurn(task) runs the task as a fresh chat turn and returns {ok, reply, done, receipts}; queue(text)
 * saves the self-development job ({job, deduplicated, held}), or is null when this turn may not start code work.
 */
export async function acquireCapability(acquire, { tryTurn, queue, storage = null, openPr = true }) {
  const tried = await tryTurn(acquire.task);
  const outcome = attemptOutcome(tried);
  if (!outcome.declined) {
    // Done, or handled without saying it is unable: the try's own answer stands and nothing is built.
    const note = outcome.done ? '' : ` I did not start a coding job: my ${outcome.route.replace(/^che_/, '').replace(/_/g, ' ')} route handled it and did not say it was unable.`;
    return ndjsonReply(`${tried.reply}${note}`, { source: 'che_capability_acquisition', attempt_route: outcome.route, execution_receipts: outcome.receipts });
  }
  const queued = queue
    ? await Promise.resolve(queue(acquisitionJobRequest(acquire, outcome, { openPr }), { openPr })).catch(() => null)
    : { not_run: 'this is a certification turn, and certification starts real code work only in a run you authorized.' };
  if (queued?.job?.id && storage) await recordGap(storage, acquire, outcome, queued.job.id).catch(() => null);
  return ndjsonReply(acquisitionReply(outcome, queued), {
    source: 'che_self_development',
    capability_acquisition: true,
    attempt_route: outcome.route,
    background_job_id: queued?.job?.id || '',
    execution_receipts: acquisitionReceipts(outcome, queued),
  });
}
