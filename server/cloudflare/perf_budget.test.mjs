// Performance budgets (owner, 2026-10-22: "make sure every time we add more features she doesn't start lagging").
// The benchmark runs the real Worker with a fake model on a 3000-memory brain; a change that adds full reads of the
// owner state, storage round trips or handler time past tools/che_perf_budget.json fails here, before it can merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bench } from '../../tools/che_perf_bench.mjs';

const budget = JSON.parse(readFileSync(fileURLToPath(new URL('../../tools/che_perf_budget.json', import.meta.url)), 'utf8'));
const result = await bench({ dir: fileURLToPath(new URL('.', import.meta.url)), runs: 5, memories: budget.memories });
const why = 'see docs/CHE_PERFORMANCE.md: find what added the work, or raise the budget on purpose with the reason';

test('each chat turn reads the whole owner state at most twice and stays within its storage and time budget', () => {
  const b = budget.chat_turn;
  for (const [turn, m] of Object.entries(result.turns)) {
    const o = m.storage_ops;
    assert.ok(o.che_reads <= b.che_reads, `${turn}: ${o.che_reads} full reads of che (budget ${b.che_reads}); ${why}`);
    assert.ok(o.che_writes <= b.che_writes, `${turn}: ${o.che_writes} writes of che (budget ${b.che_writes}); ${why}`);
    assert.ok(o.get <= b.storage_gets, `${turn}: ${o.get} storage reads (budget ${b.storage_gets}); ${why}`);
    assert.ok(o.put <= b.storage_puts, `${turn}: ${o.put} storage writes (budget ${b.storage_puts}); ${why}`);
    assert.ok(o.sql <= b.sql_ops, `${turn}: ${o.sql} SQL statements (budget ${b.sql_ops}); ${why}`);
    assert.ok(m.median_ms <= b.median_ms, `${turn}: median ${m.median_ms} ms (budget ${b.median_ms} ms); ${why}`);
  }
});

test('the GETs the app polls read the owner state once and answer within budget', () => {
  const b = budget.get_route;
  for (const [path, m] of Object.entries(result.gets)) {
    assert.ok(m.storage_ops.che_reads <= b.che_reads, `${path}: ${m.storage_ops.che_reads} full reads of che (budget ${b.che_reads}); ${why}`);
    assert.ok(m.storage_ops.get <= b.storage_gets, `${path}: ${m.storage_ops.get} storage reads (budget ${b.storage_gets}); ${why}`);
    assert.ok(m.median_ms <= b.median_ms, `${path}: median ${m.median_ms} ms (budget ${b.median_ms} ms); ${why}`);
  }
});

test('worker.js size and cold start stay within budget', () => {
  assert.ok(result.worker_bytes <= budget.worker_js_bytes, `worker.js is ${result.worker_bytes} bytes (budget ${budget.worker_js_bytes}): move new features into their own modules; ${why}`);
  assert.ok(result.import_ms <= budget.cold_import_ms, `cold import ${result.import_ms} ms (budget ${budget.cold_import_ms} ms); ${why}`);
});

test('the live watch uses the same runtime budget as the budget file', async () => {
  const { RUNTIME_BUDGET } = await import('./perf_watch.js');
  const { _doc, ...runtime } = budget.runtime;
  assert.deepEqual({ ...RUNTIME_BUDGET }, runtime, 'change tools/che_perf_budget.json and perf_watch.js together');
});
