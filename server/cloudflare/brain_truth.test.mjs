// Brain Room → Truth & Verification: every number comes from an audit-ledger row or a receipt; none is invented.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { brainTruthSummary, brainTruthView } from './brain_truth.js';
import { AUDIT_LEDGER_KEY } from './hallucination_auditor.js';
import { RECEIPTS_KEY } from './truth_layer.js';

const NOW = Date.parse('2026-10-23T23:00:00Z');
const at = (agoMs) => new Date(NOW - agoMs).toISOString();
const memStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return {
    get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
    put: async (k, v) => { data.set(k, structuredClone(v)); },
    delete: async (k) => data.delete(k),
    deleteAll: async () => data.clear(),
    list: async ({ prefix = '' } = {}) => new Map([...data.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null,
    data,
  };
};

test('an empty ledger gives zero counts, null coverage and the honest empty sentence', async () => {
  const view = await brainTruthView(memStorage(), { now: NOW });
  assert.equal(view.health.checked, 0);
  assert.equal(view.health.evidence_coverage, null);
  assert.equal(view.receipts.verified_actions.total, 0);
  assert.equal(view.receipts.failed_tools, 0);
  assert.deepEqual(view.recent, []);
  assert.match(brainTruthSummary(view), /^No audit records yet, sir/);
});

test('seeded ledger rows and receipts are counted exactly; old rows and a merge without a SHA are not', async () => {
  const storage = memStorage({
    [AUDIT_LEDGER_KEY]: [
      { at: at(1000), request_id: 'req-1-abcdef', claim_type: 'pr_merged', verdict: 'VERIFIED', outcome: 'kept' },
      { at: at(2000), request_id: 'req-2', claim_type: 'truth_layer:deployed', verdict: 'UNVERIFIED', outcome: 'removed' },
      { at: at(3000), request_id: 'req-3', claim_type: 'live_price', verdict: 'CONTRADICTED', outcome: 'removed', contradiction: 'live_price' },
      { at: at(4000), request_id: 'req-4', claim_type: 'pr_merged', verdict: 'INFERRED', outcome: 'kept_as_inference' },
      { at: at(40 * 24 * 3600_000), request_id: 'old', claim_type: 'pr_merged', verdict: 'VERIFIED', outcome: 'kept' },
    ],
    [RECEIPTS_KEY]: [
      { kind: 'merged', number: 508, sha: '0a86b70', at: at(5000) },
      { kind: 'merged', number: 1, sha: '', at: at(5000) },
      { kind: 'deployed', sha: '0a86b70', at: at(5000) },
      { kind: 'memory_saved', record_id: 'm1', at: at(5000) },
      { kind: 'video_render', task_id: 'v1', status: 'queued', at: at(5000) },
      { kind: 'video_render', task_id: 'v2', status: 'complete', at: at(5000) },
      { kind: 'tool_execution', status: 'failure', at: at(5000) },
      { kind: 'tool_execution', status: 'success', at: at(5000) },
      { kind: 'deployed', sha: 'old', at: at(8 * 24 * 3600_000) },
    ],
  });
  const view = await brainTruthView(storage, { now: NOW });
  assert.equal(view.health.checked, 4, 'the 40-day-old row is past retention');
  assert.equal(view.health.verified, 1);
  assert.equal(view.health.unverified, 1);
  assert.equal(view.health.contradicted, 1);
  assert.equal(view.health.inferred, 1);
  assert.equal(view.health.corrected, 2);
  assert.equal(view.health.evidence_coverage, 0.25);
  assert.deepEqual(view.receipts.verified_actions, { merged: 1, deployed: 1, memory_saved: 1, video_render: 1, trade_placed: 0, total: 4 });
  assert.equal(view.receipts.failed_tools, 1);
  assert.equal(view.recent.length, 4);
  assert.equal(view.recent[0].claim_type, 'pr_merged', 'newest first');
  assert.equal(view.recent[0].request_id, 'req-1-ab', 'request ids are shortened');
  assert.ok(view.recent.every((r) => !('correction' in r) && !('evidence_refs' in r)), 'only labels and times are exposed');
  const spoken = brainTruthSummary(view);
  assert.match(spoken, /checked 4 claims: 1 verified, 1 labelled inference, 1 unverified removed, 1 contradicted, 0 stale/);
  assert.match(spoken, /4 verified actions by receipt and 1 failed tool execution/);
  assert.match(spoken, /Evidence coverage 25 percent/);
});

// ─── The route, through the real Worker ──────────────────────────────────────
const generated = new URL('./.brain_truth.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

async function owner(seed = {}) {
  const storage = memStorage(seed);
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'A model answer.' }) } };
  const state = new CheState({ storage, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, token = '') => worker.fetch(new Request(`https://che.example${path}`, { method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} }), env);
  const pair = await worker.fetch(new Request('https://che.example/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }) }), env);
  const token = (await pair.json()).device_token;
  return { get: async (p, t = token) => { const r = await send(p, t); return { status: r.status, body: await r.json() }; } };
}

test('Worker: /api/brain/truth is owner-only and returns the ledger view', async () => {
  const che = await owner({ [AUDIT_LEDGER_KEY]: [{ at: new Date().toISOString(), request_id: 'r', claim_type: 'pr_merged', verdict: 'UNVERIFIED', outcome: 'removed' }] });
  const anon = await che.get('/api/brain/truth', '');
  assert.ok([401, 403].includes(anon.status), 'a guest cannot read the truth view');
  const view = await che.get('/api/brain/truth');
  assert.equal(view.status, 200);
  assert.equal(view.body.health.checked, 1);
  assert.equal(view.body.health.evidence_coverage, 0);
  assert.equal(view.body.recent[0].claim_type, 'pr_merged');
  assert.equal(view.body.window_days, 7);
});
