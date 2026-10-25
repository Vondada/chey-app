// CHE hallucination auditor: a deterministic claim check on each owner-facing reply.
//
// It finds sentences that say something finished or real (saved, merged, deployed, installed, made, placed,
// live, read, ran), labels each one, and removes the ones no structured receipt from this request backs.
// It never calls a model, and it never reads the reply's wording as evidence: evidence is a list of receipts
// that execution code wrote. A missing or unreadable evidence list fails closed, so a claim is removed, not approved.
// The ledger keeps ids, labels and outcomes, never the reply or the owner's words.

import { isOwnerAttested } from './memory_provenance.js';
import { loadReceipts } from './truth_layer.js';

export const AUDIT_LEDGER_KEY = 'che_hallucination_audit_v1';
export const AUDIT_LEDGER_LIMIT = 500;
export const AUDIT_RETENTION_MS = 30 * 24 * 3600_000;
export const AUDIT_LABELS = Object.freeze(['VERIFIED', 'INFERRED', 'UNVERIFIED', 'CONTRADICTED', 'STALE']);
export const PRICE_FRESH_MS = 15 * 60_000;

const PAST = String.raw`(?:have\s+|just\s+|already\s+|successfully\s+)*`;
// "I've saved …" is "I have saved …" (owner live test, 2026-10-25: "I've saved that for you and I'll remember it" passed
// every guard with nothing written).
const SUBJECT = String.raw`(?:I|CHE|she|we)(?:'ve|’ve)?\s+`;
// A claim is a completed, real action stated as fact. Questions, denials and hedges are judged separately.
export const CLAIMS = Object.freeze([
  { kind: 'memory_saved', re: new RegExp(String.raw`\b${SUBJECT}${PAST}(?:saved|stored|written|recorded)\b[^.!?\n]{0,60}\b(?:memory|memories|note)\b|\b${SUBJECT}${PAST}(?:saved|stored|noted|memori[sz]ed)\s+(?:that|it|this|them)(?:\s+(?:for\s+you|away|safely|now))?\b|\bI(?:'ll|’ll|\s+will)\s+(?:always\s+|definitely\s+)?remember\s+(?:that|it|this|them)\b|\b(?:it|that)(?:'s|’s|\s+is|\s+has\s+been|\s+was)\s+(?:now\s+)?(?:saved|stored)\b[^.!?\n]{0,30}\b(?:memory|memories|for\s+you)\b`, 'i') },
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

// A denial that CHE keeps, or can read, her own memory, mission, project, job or conversation records. Those stores exist
// and have deterministic readers; a model that answers without them is guessing.
const STORE_WORDS = String.raw`(?:mission|missions|objective|project|projects|job|jobs|coding|memory|memories|conversation|chat|collaboration|work|task)\s*(?:history|records?|logs?|database|ledgers?|ids?)?`;
export const RECORDS_DENIAL = new RegExp(String.raw`\b(?:I|CHE)\s+(?:do\s+not|don't|don’t|cannot|can't|can’t|have\s+no|lack)\s+(?:have\s+)?(?:any\s+)?(?:access\s+to|a\s+way\s+to\s+(?:see|read|access)|(?:see|read|access))\s+(?:your\s+|my\s+|our\s+|the\s+|any\s+)?${STORE_WORDS}|\bno\s+(?:mission|project|job|memory)\s+(?:database|history|records?)\s+exists?\b|\bI\s+(?:can't|can’t|cannot|couldn't|could\s+not)\s+find\s+any\s+record\s+of\s+(?:our\s+)?(?:previous|past|earlier|prior)\s+(?:collaboration|work|projects?)`, 'i');
const RECORDS_DENIAL_LINE = 'I keep mission, project, job and memory records and can read them: ask "show my last five missions", "what were our last three projects" or "search my memory for" a topic, and I will answer from the records themselves.';

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
export function auditReply(reply, { evidence = null, requestId = '', now = Date.now(), fiction = false } = {}) {
  const source = String(reply || '');
  // A story, poem or role-play the owner asked for narrates in its own voice ("I read the book by candlelight").
  // The older guards exempt it through storyRequested(message); the auditor keeps that same exemption.
  if (fiction) return { text: source, outcome: 'none', claims: [], entries: [] };
  const proof = evidence || {};
  const kept = [];
  const corrections = [];
  const claims = [];
  const entries = [];
  let sawClaim = false;
  for (const sentence of splitSentences(source)) {
    // A model's "I don't have access to mission history" is a claim about CHE's stores it never read: removed, and the
    // owner is told the words that read them (owner live test, 2026-10-25).
    if (RECORDS_DENIAL.test(sentence)) {
      sawClaim = true;
      claims.push({ kind: 'records_denied', label: 'CONTRADICTED' });
      if (!corrections.includes(RECORDS_DENIAL_LINE)) corrections.push(RECORDS_DENIAL_LINE);
      entries.push({ at: new Date(now).toISOString(), request_id: String(requestId || ''), claim_type: 'records_denied', evidence_refs: [], verdict: 'CONTRADICTED', contradiction: 'records_denied', correction: RECORDS_DENIAL_LINE, outcome: 'removed' });
      continue;
    }
    const hits = /\?\s*$/.test(sentence) || NEGATED.test(sentence) ? [] : CLAIMS.filter((c) => c.re.test(sentence));
    if (!hits.length) { kept.push(sentence); continue; }
    sawClaim = true;
    // Every claim type in the sentence is judged: one receipt cannot carry an unrelated claim in the same sentence.
    const verdicts = hits.map(({ kind }) => ({ kind, ...labelClaim(kind, sentence, proof, now) }));
    let removed = false;
    let inferred = false;
    for (const { kind, label, refs } of verdicts) {
      claims.push({ kind, label });
      const entry = { at: new Date(now).toISOString(), request_id: String(requestId || ''), claim_type: kind, evidence_refs: refs.slice(0, 5), verdict: label, contradiction: label === 'CONTRADICTED' ? kind : '', correction: '', outcome: '' };
      if (label === 'VERIFIED') entry.outcome = 'kept';
      else if (label === 'INFERRED') { inferred = true; entry.outcome = 'kept_as_inference'; }
      else {
        const line = CORRECTION[kind];
        if (!corrections.includes(line)) corrections.push(line);
        entry.correction = line;
        entry.outcome = 'removed';
        removed = true;
      }
      entries.push(entry);
    }
    if (removed) continue;
    kept.push(inferred ? `${sentence} (inference, not verified)` : sentence);
  }
  if (!sawClaim) return { text: source, outcome: 'none', claims, entries };
  const removed = entries.some((e) => e.outcome === 'removed');
  const text = [...kept, ...corrections].join(' ').trim();
  const outcome = !kept.length ? 'blocked' : removed ? 'corrected' : 'pass';
  return { text, outcome, claims, entries };
}

// Receipts from this request and the recent window: the only evidence the auditor reads. Real receipts come from
// execution code, so an owner's or model's text can never create one.
export async function auditEvidenceFrom(storage, { executions = [], prices = [], tasks = [], teamTasks = [], memoryWrites = [], now = Date.now() } = {}) {
  const receipts = await loadReceipts(storage, { sinceMs: 7 * 24 * 3600_000, now });
  const byKind = (kind) => receipts.filter((r) => r.kind === kind);
  // One video per task id: the render receipt says it started, the verified or failed receipt (action_receipts.js)
  // says how it ended. A verified receipt is the only thing that makes mp4_verified true.
  const videos = new Map();
  for (const r of byKind('video_render')) videos.set(String(r.task_id), { id: `video:${r.task_id}`, status: r.status || 'queued', mp4_verified: false, playable: false });
  for (const r of byKind('video_failed')) videos.set(String(r.task_id), { ...(videos.get(String(r.task_id)) || { id: `video:${r.task_id}` }), status: 'failed', mp4_verified: false, playable: false });
  for (const r of byKind('video_verified')) videos.set(String(r.task_id || r.media_id), { id: `video:${r.task_id || r.media_id}`, status: 'complete', mp4_verified: r.mp4_verified === true, playable: r.playable === true });
  return {
    merged_prs: byKind('merged').map((r) => ({ id: `merged:${r.number}`, number: r.number, sha: r.sha || '' })),
    deploys: byKind('deployed').map((r) => ({ id: `deployed:${r.sha}`, sha: r.sha || '', version_tag: r.version_tag || '' })),
    deploy_failures: byKind('deploy_failed').length,
    videos: [...videos.values()],
    // Alpaca PAPER stock orders and Tradovate sim/live futures orders both prove "I placed an order" only with the broker's id.
    trades: [...byKind('paper_order_placed'), ...byKind('trade_placed')].map((r) => ({ id: `trade:${r.key || ''}`, order_id: r.order_id || '', account: r.account || r.account_mode || '' })),
    trade_failures: byKind('trade_failed').length,
    executions: executions.filter(Boolean).map((x) => ({ id: `execution:${x.invocation_id || ''}`, status: x.status })),
    // A memory write backs "I saved it" only inside this conversation's window, not for a week.
    memory_writes: [...memoryWrites, ...byKind('memory_saved').filter((r) => now - Date.parse(r.at || 0) <= MEMORY_CLAIM_MS).map((r) => ({ id: `memory:${r.record_id || ''}`, confirmed: true }))],
    // Office tasks prove "finished" only when complete and checked (agent_runtime.js sets verified on completion).
    tasks: [...tasks, ...teamTasks.filter(Boolean).map((t) => ({ id: String(t.id || ''), status: t.status, verified: t.verified === true }))],
    // The phone's own report (POST /api/device/installed) is the only install evidence.
    device_installs: byKind('device_install').map((r) => ({ id: `install:${r.version}-${r.build}-${r.patch || 'none'}`, confirmed: r.confirmed === true })),
    prices, book_reads: [],
  };
}

// ─── Two owner questions answered from records, never from a model ──────────
// "Did you save that memory?" and "What do you know versus what are you guessing?" are questions about
// CHE's own evidence. A model can only guess at the answer, so these read the receipts and the ledger.
export const MEMORY_CLAIM_MS = 30 * 60_000;
// The object must be a memory ("that memory", "my notes") or a bare pronoun for the last thing said. "Did you save
// the file?" or "my document" is about a file, not CHE's memory, and is answered elsewhere.
const MEMORY_SAVED_ASK = /^(?:did|have) you (?:actually |really )?(?:save|saved|store|stored|remember|remembered|keep|kept) (?:(?:that|this|it)(?: (?:memory|note|fact|one))?|(?:the|my|that|this|those|these) (?:last |latest |new |recent )?(?:memory|memories|note|notes|fact|facts))\s*\??$/i;
const KNOW_VS_GUESS_ASK = /\bwhat do you (?:actually |really )?know\b.{0,30}\b(?:vers(?:us|es)|vs\.?|compared (?:to|with)|and what (?:are you|do you))\b.{0,30}\b(?:guess\w*|assum\w*|infer\w*|think\w*)|\bwhat are you (?:just )?(?:guessing|assuming|inferring)\b|\bwhat do you know for (?:sure|certain)\b/i;
const plain = (m) => String(m || '').trim().replace(/^(?:che|chey|hey che|okay|ok|so|sir)[,\s]+/i, '').replace(/[,\s]+sir\s*\??$/i, '?');

// "What did you save?" / "what did you just remember?" reads the same receipt (subject-loss audit, 2026-10-24).
const MEMORY_SAVED_WHAT = /^what did you (?:just |actually )?(?:save|store|remember|keep)(?: (?:just now|for me|there|as a memory))?\s*\??$/i;
export function memorySavedQuestion(message) { const p = plain(message); return MEMORY_SAVED_ASK.test(p) || MEMORY_SAVED_WHAT.test(p); }
export function knowVsGuessQuestion(message) { return KNOW_VS_GUESS_ASK.test(plain(message)); }

const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'an unknown time' : d.toISOString().replace('T', ' at ').slice(0, 19) + ' UTC'; };
const clip = (text, n = 90) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The newest memory_saved receipt in the conversation window, or an honest no. */
export async function memorySavedReply(storage, { now = Date.now() } = {}) {
  const receipts = await loadReceipts(storage, { sinceMs: MEMORY_CLAIM_MS, now });
  const saved = receipts.filter((r) => r.kind === 'memory_saved').at(-1);
  if (!saved) return { text: 'No, sir. I have no confirmed memory write on record in the last half hour, so nothing from this conversation was saved. Tell me again and I will confirm it only after reading it back from storage.', saved: null };
  return { text: `Yes, sir. I saved "${clip(saved.text)}" at ${when(saved.at)} and read it back from storage${saved.record_id ? ` as record ${String(saved.record_id).slice(0, 8)}` : ''}. That is a confirmed write, not a promise.`, saved };
}

/** What CHE knows (owner records, receipts) against what she infers, from counts of real rows only. */
export function knowVsGuessReply({ records = [], ledger = [], lastEvidence = null, now = Date.now() } = {}) {
  const owned = records.filter((r) => r.active !== false && isOwnerAttested(r));
  const newest = [...owned].sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)).slice(0, 2);
  const health = auditHealth(ledger.filter((row) => now - Date.parse(row.at || 0) <= 86_400_000));
  const lines = [];
  lines.push(owned.length
    ? `What I know, sir: ${owned.length} ${owned.length === 1 ? 'fact' : 'facts'} you told me yourself, in your own words${newest.length ? `, for example ${newest.map((r) => `"${clip(r.text, 60)}"`).join(' and ')}` : ''}. Those are owner-confirmed records, each with a date.`
    : 'What I know, sir: nothing yet in your own words. I have no owner-confirmed memory records.');
  lines.push('I also know what a receipt proves: a merge with its commit, a deployment, a saved memory read back from storage, a tool that returned a result. Anything else I say is inference from the model, and I label it as inference.');
  if (lastEvidence?.kind) {
    const kind = { owner_attested: 'built from your own records', source_backed: 'backed by sources I opened', tool_result: 'backed by a tool result', none: 'a statement that I had no record', unverified: 'unverified' }[lastEvidence.kind] || lastEvidence.kind;
    lines.push(`My previous answer was ${kind}.`);
  }
  lines.push(health.checked
    ? `In the last day my auditor checked ${health.checked} ${health.checked === 1 ? 'claim' : 'claims'}: ${health.verified} verified, ${health.inferred} labelled inference, ${health.unverified + health.contradicted + health.stale} removed for lack of evidence.`
    : 'My auditor has checked no completion claims in the last day, so I have no counts to give you.');
  return { text: lines.join(' '), owned: owned.length, ownedIds: owned.map((r) => r.id).filter(Boolean).slice(0, 5), health };
}

// The older guards (truth_layer.js, memory_provenance.js, source_verification.js, asset_truth.js) remove claims
// before the auditor runs. Their removals become ledger rows too, so one ledger holds every removed claim.
// Only the guard and rule names are kept, never the removed sentence.
export function guardRemovalEntries(guard, removed = [], { requestId = '', now = Date.now() } = {}) {
  const list = Array.isArray(removed) ? removed : removed ? [removed] : [];
  return list.slice(0, 20).map((item) => {
    const rule = typeof item === 'object' && item ? String(item.rule || item.kind || item.reason || item.type || '') : '';
    return { at: new Date(now).toISOString(), request_id: String(requestId || ''), claim_type: rule ? `${guard}:${rule}` : guard, evidence_refs: [], verdict: 'UNVERIFIED', contradiction: '', correction: guard, outcome: 'removed' };
  });
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
