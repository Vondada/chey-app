// CHE hallucination auditor: a deterministic claim check on each owner-facing reply.
//
// It finds sentences that say something finished or real (saved, merged, deployed, installed, made, placed,
// live, read, ran), labels each one, and removes the ones no structured receipt from this request backs.
// It never calls a model, and it never reads the reply's wording as evidence: evidence is a list of receipts
// that execution code wrote. A missing or unreadable evidence list fails closed, so a claim is removed, not approved.
// The ledger keeps ids, labels and outcomes, never the reply or the owner's words.

import { loadReceipts } from './truth_layer.js';

export const AUDIT_LEDGER_KEY = 'che_hallucination_audit_v1';
export const AUDIT_LEDGER_LIMIT = 500;
export const AUDIT_RETENTION_MS = 30 * 24 * 3600_000;
export const AUDIT_LABELS = Object.freeze(['VERIFIED', 'INFERRED', 'UNVERIFIED', 'CONTRADICTED', 'STALE']);
export const PRICE_FRESH_MS = 15 * 60_000;

const PAST = String.raw`(?:have\s+|just\s+|already\s+|successfully\s+)*`;
const SUBJECT = String.raw`(?:I|CHE|she|we)\s+`;
// A claim is a completed, real action stated as fact. Questions, denials and hedges are judged separately.
export const CLAIMS = Object.freeze([
  { kind: 'memory_saved', re: new RegExp(String.raw`\b${SUBJECT}${PAST}(?:saved|stored|written|recorded)\b[^.!?\n]{0,60}\b(?:memory|memories|note)\b`, 'i') },
  { kind: 'pr_merged', re: new RegExp(String.raw`\b(?:${SUBJECT}|Claude\s+|Codex\s+|ChatGPT\s+|it\s+)${PAST}merged\b[^.!?\n]{0,40}\b(?:PR|pull\s+request)\b|\b(?:PR|pull\s+request)\b[^.!?\n]{0,30}\bmerged\b`, 'i') },
  { kind: 'worker_deployed', re: new RegExp(String.raw`\b${SUBJECT}${PAST}deployed\b[^.!?\n]{0,40}\b(?:Worker|worker|production|backend|server)\b|\b(?:the\s+)?(?:Worker|worker|deployment)\s+(?:was\s+|is\s+)?(?:now\s+)?deployed\b`, 'i') },
  { kind: 'iphone_installed', re: /\b(?:installed|updated)\b[^.!?\n]{0,40}\b(?:on\s+(?:your|the|my)\s+)?(?:iPhone|phone|IPA)\b|\b(?:iPhone|phone)\b[^.!?\n]{0,30}\b(?:now\s+has|has)\b[^.!?\n]{0,20}\b(?:the\s+)?(?:new\s+)?(?:update|build)\b/i },
  { kind: 'video_made', re: new RegExp(String.raw`\b${SUBJECT}${PAST}(?:created|made|generated|rendered|finished|produced)\b[^.!?\n]{0,50}\b(?:video|MP4|movie|film|clip)\b|\b(?:the|your)\s+(?:\w+\s+)?(?:video|MP4|film|clip)\s+(?:is\s+|was\s+)?(?:now\s+)?(?:ready|finished|done|rendered|in\s+(?:your\s+)?Projects)\b`, 'i') },
  { kind: 'trade_placed', re: new RegExp(String.raw`\b${SUBJECT}${PAST}(?:placed|executed|filled|sent|opened|closed)\b[^.!?\n]{0,30}\b(?:trades?|orders?|positions?)\b`, 'i') },
  { kind: 'live_price', re: /\b(?:live|real[- ]time|current|latest)\s+(?:price|quote|bid|ask)\b|\bLIVE\b[^.!?\n]{0,20}\bprice\b/i },
  { kind: 'task_finished', re: new RegExp(String.raw`\b(?:${SUBJECT}|[A-Z][a-z]+\s+|the\s+agent\s+|it\s+)${PAST}(?:finished|completed)\b[^.!?\n]{0,40}\b(?:task|job|assignment|research|study)\b`, 'i') },
  { kind: 'code_executed', re: new RegExp(String.raw`\b${SUBJECT}${PAST}(?:ran|executed)\b[^.!?\n]{0,40}\b(?:code|script|tests?|command|query|pytest|node|flutter)\b`, 'i') },
  { kind: 'book_read', re: new RegExp(String.raw`\b${SUBJECT}${PAST}(?:read|finished\s+reading)\b[^.!?\n]{0,30}\b(?:book|chapter|pages?)\b`, 'i') },
]);

const NEGATED = /\b(?:not|never|no|haven't|hasn't|didn't|don't|doesn't|cannot|can't|couldn't|won't|isn't|wasn't|unable)\b/i;
const HEDGED = /\b(?:may|might|could|probably|likely|I\s+think|I\s+believe|I\s+suspect|appears?\s+to|seems?\s+to|possibly|perhaps|if)\b/i;

// The owner-facing line for each claim type, used in place of a removed claim. It names what is missing, never a success.
const CORRECTION = Object.freeze({
  memory_saved: 'No confirmed memory write is on record for this request, so I have not saved anything.',
  pr_merged: 'GitHub has not confirmed a merge for that pull request, so I have not marked it merged.',
  worker_deployed: 'No deployment confirmation is on record, so I have not marked the Worker as deployed.',
  iphone_installed: 'The device has not confirmed an install, so I have not marked the update as installed.',
  video_made: 'No playable MP4 is on record yet, so I have not marked the video as finished.',
  trade_placed: 'No verified order or simulated execution receipt exists, so no trade was placed.',
  live_price: 'I cannot give a live price from this data. Any price I have is delayed or unconfirmed.',
  task_finished: 'No verified result is on record for that task, so I have not marked it finished.',
  code_executed: 'No execution record exists for this answer, so I did not run that code.',
  book_read: 'I have not read that book, so I cannot say what it contains.',
});

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function claimKindsIn(text) {
  const kinds = new Set();
  for (const sentence of splitSentences(text)) {
    if (/\?\s*$/.test(sentence) || NEGATED.test(sentence)) continue;
    for (const claim of CLAIMS) if (claim.re.test(sentence)) kinds.add(claim.kind);
  }
  return [...kinds];
}

// Evidence is structured and produced by execution code. Each check says what counts as proof for one claim type.
const PROOF = Object.freeze({
  memory_saved: (e) => (e.memory_writes || []).filter((w) => w.confirmed === true),
  pr_merged: (e) => (e.merged_prs || []).filter((p) => p.sha),
  worker_deployed: (e) => (e.deploys || []).filter((d) => d.sha),
  iphone_installed: (e) => (e.device_installs || []).filter((d) => d.confirmed === true),
  video_made: (e) => (e.videos || []).filter((v) => v.mp4_verified === true && v.playable === true),
  trade_placed: (e) => (e.trades || []).filter((t) => t.order_id),
  task_finished: (e) => (e.tasks || []).filter((t) => t.status === 'complete' && t.verified === true),
  code_executed: (e) => (e.executions || []).filter((x) => x.status === 'success'),
  book_read: (e) => (e.book_reads || []).filter((b) => b.chars > 0),
});

// A contradicting receipt exists only when a real failure receipt of the same kind was written.
const FAILED = Object.freeze({
  worker_deployed: (e) => Number(e.deploy_failures || 0) > 0,
  trade_placed: (e) => Number(e.trade_failures || 0) > 0,
  video_made: (e) => (e.videos || []).some((v) => v.status === 'failed'),
});

function priceVerdict(evidence, now) {
  const prices = evidence.prices || [];
  if (!prices.length) return { label: 'UNVERIFIED', refs: [] };
  if (prices.some((p) => p.delayed === true)) return { label: 'CONTRADICTED', refs: prices.map((p) => p.id || 'price') };
  const fresh = prices.filter((p) => p.live === true && p.at && now - Date.parse(p.at) <= PRICE_FRESH_MS);
  if (fresh.length) return { label: 'VERIFIED', refs: fresh.map((p) => p.id || 'price') };
  return { label: 'STALE', refs: prices.map((p) => p.id || 'price') };
}

// Label one claim sentence. Hedged wording is never upgraded to VERIFIED.
function labelClaim(kind, sentence, evidence, now) {
  if (HEDGED.test(sentence)) return { label: 'INFERRED', refs: [] };
  if (kind === 'live_price') return priceVerdict(evidence, now);
  // A merge claim names its PR: a receipt for another PR proves nothing about this one.
  const named = sentence.match(/#\s?(\d+)/);
  const proof = kind === 'pr_merged' && named
    ? (evidence.merged_prs || []).filter((p) => p.sha && Number(p.number) === Number(named[1]))
    : PROOF[kind] ? PROOF[kind](evidence) : [];
  if (proof.length) return { label: 'VERIFIED', refs: proof.map((p) => p.id || kind) };
  if (FAILED[kind] && FAILED[kind](evidence)) return { label: 'CONTRADICTED', refs: [`${kind}:failed`] };
  return { label: 'UNVERIFIED', refs: [] };
}

/**
 * Audit one reply. `evidence` is the structured list described above, or null when the lookup failed.
 * A null evidence makes every claim UNVERIFIED (fail closed).
 * Returns { text, outcome, claims, entries }: outcome is 'none' | 'pass' | 'corrected' | 'blocked'.
 */
export function auditReply(reply, { evidence = null, requestId = '', now = Date.now() } = {}) {
  const source = String(reply || '');
  const proof = evidence || {};
  const kept = [];
  const corrections = [];
  const claims = [];
  const entries = [];
  let sawClaim = false;
  for (const sentence of splitSentences(source)) {
    const hits = /\?\s*$/.test(sentence) || NEGATED.test(sentence) ? [] : CLAIMS.filter((c) => c.re.test(sentence));
    if (!hits.length) { kept.push(sentence); continue; }
    sawClaim = true;
    const kind = hits[0].kind;
    const { label, refs } = labelClaim(kind, sentence, proof, now);
    claims.push({ kind, label });
    const entry = { at: new Date(now).toISOString(), request_id: String(requestId || ''), claim_type: kind, evidence_refs: refs.slice(0, 5), verdict: label, contradiction: label === 'CONTRADICTED' ? kind : '', correction: '', outcome: '' };
    if (label === 'VERIFIED') { kept.push(sentence); entry.outcome = 'kept'; }
    else if (label === 'INFERRED') { kept.push(`${sentence} (inference, not verified)`); entry.outcome = 'kept_as_inference'; }
    else {
      const line = CORRECTION[kind];
      if (!corrections.includes(line)) corrections.push(line);
      entry.correction = line;
      entry.outcome = 'removed';
    }
    entries.push(entry);
  }
  if (!sawClaim) return { text: source, outcome: 'none', claims, entries };
  const removed = entries.some((e) => e.outcome === 'removed');
  const text = [...kept, ...corrections].join(' ').trim();
  const outcome = !kept.length ? 'blocked' : removed ? 'corrected' : 'pass';
  return { text, outcome, claims, entries };
}

// Receipts from this request and the recent window: the only evidence the auditor reads. Real receipts come from
// execution code, so an owner's or model's text can never create one.
export async function auditEvidenceFrom(storage, { executions = [], prices = [], tasks = [], memoryWrites = [], now = Date.now() } = {}) {
  const receipts = await loadReceipts(storage, { sinceMs: 7 * 24 * 3600_000, now });
  const byKind = (kind) => receipts.filter((r) => r.kind === kind);
  return {
    merged_prs: byKind('merged').map((r) => ({ id: `merged:${r.number}`, number: r.number, sha: r.sha || '' })),
    deploys: byKind('deployed').map((r) => ({ id: `deployed:${r.sha}`, sha: r.sha || '', version_tag: r.version_tag || '' })),
    deploy_failures: byKind('deploy_failed').length,
    videos: byKind('video_render').map((r) => ({ id: `video:${r.task_id}`, status: r.status || 'queued', mp4_verified: r.mp4_verified === true, playable: r.playable === true })),
    trades: byKind('trade_placed').map((r) => ({ id: `trade:${r.key || r.order_id || ''}`, order_id: r.order_id || '' })),
    trade_failures: byKind('trade_failed').length,
    executions: executions.filter(Boolean).map((x) => ({ id: `execution:${x.invocation_id || ''}`, status: x.status })),
    prices, tasks, memory_writes: memoryWrites, device_installs: [], book_reads: [],
  };
}

// Ledger: one row per checked claim. It stores ids, labels and outcomes only, so no reply or owner text is kept.
export async function recordAudit(storage, entries = [], { now = Date.now() } = {}) {
  if (!entries.length) return [];
  let rows = [];
  try { rows = (await storage?.get?.(AUDIT_LEDGER_KEY)) || []; } catch (_) { rows = []; }
  const cutoff = now - AUDIT_RETENTION_MS;
  const kept = (Array.isArray(rows) ? rows : []).filter((row) => Date.parse(row.at || 0) >= cutoff);
  const next = [...kept, ...entries].slice(-AUDIT_LEDGER_LIMIT);
  await storage?.put?.(AUDIT_LEDGER_KEY, next);
  return next;
}

export async function auditLedger(storage, { now = Date.now() } = {}) {
  try {
    const rows = (await storage?.get?.(AUDIT_LEDGER_KEY)) || [];
    return (Array.isArray(rows) ? rows : []).filter((row) => Date.parse(row.at || 0) >= now - AUDIT_RETENTION_MS);
  } catch (_) {
    return [];
  }
}

// Counts from real ledger rows only. No accuracy or hallucination percentage is invented.
export function auditHealth(rows = []) {
  const count = (pred) => rows.filter(pred).length;
  const checked = rows.length;
  const verified = count((r) => r.verdict === 'VERIFIED');
  const unverified = count((r) => r.verdict === 'UNVERIFIED');
  const contradicted = count((r) => r.verdict === 'CONTRADICTED');
  const stale = count((r) => r.verdict === 'STALE');
  const inferred = count((r) => r.verdict === 'INFERRED');
  return {
    checked, verified, inferred, unverified, contradicted, stale,
    corrected: count((r) => r.outcome === 'removed'),
    evidence_coverage: checked ? verified / checked : null,
  };
}
