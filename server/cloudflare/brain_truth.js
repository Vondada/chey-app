// Brain Room → Truth & Verification: counts from the hallucination audit ledger and the real receipts, nothing else.
// No accuracy or hallucination percentage is computed; evidence_coverage is null until a claim has been checked.
import { auditHealth, auditLedger } from './hallucination_auditor.js';
import { loadReceipts } from './truth_layer.js';

export const TRUTH_WINDOW_MS = 7 * 24 * 3600_000;
export const RECENT_AUDIT_ROWS = 20;

/** The view behind GET /api/brain/truth. Ledger rows carry labels only, so nothing here is reply or owner text. */
export async function brainTruthView(storage, { now = Date.now() } = {}) {
  // The ledger keeps 30 days; this view speaks of "the last seven days", so its rows are cut to the same window
  // as the receipts (Codex, #510: a 14-day-old verified claim was counted as checked this week).
  const rows = (await auditLedger(storage, { now })).filter((row) => now - Date.parse(row.at || 0) <= TRUTH_WINDOW_MS);
  const receipts = await loadReceipts(storage, { sinceMs: TRUTH_WINDOW_MS, now });
  const count = (pred) => receipts.filter(pred).length;
  const verified_actions = {
    merged: count((r) => r.kind === 'merged' && r.sha),
    deployed: count((r) => r.kind === 'deployed'),
    memory_saved: count((r) => r.kind === 'memory_saved'),
    video_render: count((r) => r.kind === 'video_render' && r.status === 'complete'),
    trade_placed: count((r) => r.kind === 'trade_placed'),
  };
  verified_actions.total = Object.values(verified_actions).reduce((a, b) => a + b, 0);
  const failed_tools = count((r) => r.kind === 'tool_execution' && r.status !== 'success');
  const recent = [...rows].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0)).slice(0, RECENT_AUDIT_ROWS).map((r) => ({
    at: r.at || '', request_id: String(r.request_id || '').slice(0, 8), claim_type: r.claim_type || '', verdict: r.verdict || '', outcome: r.outcome || '', contradiction: r.contradiction || '',
  }));
  return { health: auditHealth(rows), receipts: { verified_actions, failed_tools }, recent, window_days: 7, at: new Date(now).toISOString() };
}

// "Open Truth and Verification", "show me the truth screen", "go to verification": the spoken route to the Brain
// Room's Truth & Verification section (owner, AGENTS.md: every screen needs a voice route, never a menu tap).
const OPEN_TRUTH_ASK = /^(?:please\s+)?(?:open|show(?: me)?|go to|take me to|bring up)\s+(?:the\s+)?(?:truth(?:\s*(?:and|&)\s*verification)?|verification)(?:\s+(?:screen|page|section|view|room|tab))?\s*[.!?]?$/i;
const plainAsk = (m) => String(m || '').trim().replace(/^(?:che|chey|hey che|okay|ok|so|sir)[,\s]+/i, '').replace(/[,\s]+(?:please|sir)\s*[.!?]?$/i, '');
export function truthScreenAsk(message) { return OPEN_TRUTH_ASK.test(plainAsk(message)); }

/** The spoken form, the same facts the page shows. */
export function brainTruthSummary(view) {
  const h = view?.health || {};
  const r = view?.receipts || {};
  const actions = r.verified_actions?.total || 0;
  if (!h.checked && !actions && !r.failed_tools) return 'No audit records yet, sir. Nothing has been checked or verified in the last seven days.';
  const parts = [`In the last seven days I checked ${h.checked || 0} ${h.checked === 1 ? 'claim' : 'claims'}: ${h.verified || 0} verified, ${h.inferred || 0} labelled inference, ${h.unverified || 0} unverified removed, ${h.contradicted || 0} contradicted, ${h.stale || 0} stale.`];
  parts.push(`${actions} verified ${actions === 1 ? 'action' : 'actions'} by receipt and ${r.failed_tools || 0} failed tool ${r.failed_tools === 1 ? 'execution' : 'executions'}.`);
  if (h.evidence_coverage != null) parts.push(`Evidence coverage ${Math.round(h.evidence_coverage * 100)} percent of checked claims.`);
  return parts.join(' ');
}
