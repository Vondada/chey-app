// Creative Studio stage 5: one compute router, and ONE monthly Modal ledger under the owner's $10 cap
// (owner, 2026-11-06: "Yes cap 10 a month", then "Done, set to $10" for Modal's own spend limit).
// No network and no money: every Modal answer is a fake, and the tests count that nothing reaches Modal when refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import { POOL_KEY, budgetCommand, routeWork, MODAL_CANNOT_CLIPS } from './compute_pool.js';
import { budgetIntent } from './compute_budget.js';
import { cloudIntent } from './cloud_computer.js';
import {
  MODAL_CALL_WORST_USD, MODAL_MONTHLY_CAP_USD, MODAL_POOL_KEY, OWNER_MODAL_CAP, OWNER_MODAL_SPEND_LIMIT, MODAL_USD_HR, applyModalIntent, modalCreditGate,
  modalIntent, modalMonthCheck, modalMonthCheckFor, modalMonthStop, modalStateOf,
} from './modal_gpu.js';
import { TEST_BUDGET_KEY, TXT2IMG_WORST_CASE_USD, reserveTestBudget, settleTestBudget, testBudgetMonthUsd } from './gpu_test_budget.js';
import { startModalImage } from './media.js';

const T = Date.parse('2026-11-07T12:00:00Z');
function memStorage() {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async (k) => m.delete(k) };
}
/** A finished Blender call on Modal this month that cost about `usd` (measured seconds; start and idle time added on top). */
function doneCall(pool, usd, at = T - 3600_000, n = 1) {
  const m = modalStateOf(pool);
  const secs = Math.max(0, Math.round((usd * 3600) / MODAL_USD_HR) - 120);
  m.calls[`job:old:modal:${n}`] = { key: `job:old:modal:${n}`, provider: 'modal', job_ids: ['old'], state: 'done', dispatched_ms: at, ended_ms: at + secs * 1000, gpu_seconds: secs, usd_hr: MODAL_USD_HR };
}

test('the owner\'s approval is recorded with its words and time; the cap is $10 a month and CHE stops $0.50 under it', () => {
  assert.equal(MODAL_MONTHLY_CAP_USD, 10);
  assert.deepEqual([OWNER_MODAL_CAP.words, OWNER_MODAL_CAP.at, OWNER_MODAL_CAP.provenance], ['Yes cap 10 a month', '2026-11-06T22:29:41.139Z', 'OWNER-APPROVED']);
  assert.deepEqual([OWNER_MODAL_SPEND_LIMIT.words, OWNER_MODAL_SPEND_LIMIT.usd], ['Done, set to $10', 10]);
  assert.equal(MODAL_POOL_KEY, POOL_KEY, 'the Modal ledger lives in the pool');
  assert.equal(modalMonthStop({}), 9.5);
  // One Blender call at its worst case: the whole 45-minute timeout plus start and idle time at the T4 price.
  assert.ok(MODAL_CALL_WORST_USD > 0.4 && MODAL_CALL_WORST_USD < 0.5, String(MODAL_CALL_WORST_USD));
});

test('free first: the router sends clips to Kaggle, then the free HF GPU, and never to Modal, which has no clip function', () => {
  const kaggle = { id: 'kaggle', usable: true, detail: '27.5 GPU hours left this week' };
  const hf = { id: 'hf_zerogpu', usable: true, detail: 'free ZeroGPU minutes left today' };
  let r = routeWork('film_clip', [kaggle, hf]);
  assert.deepEqual([r.route, r.order, r.paid], ['kaggle', ['kaggle', 'hf_zerogpu'], false]);
  assert.match(r.why, /^Moving clips and lip sync runs on the free Kaggle GPU\. The free Kaggle GPU: 27\.5 GPU hours left this week\./);
  r = routeWork('film_clip', [{ ...kaggle, usable: false, detail: 'The Kaggle GPU quota is used up until Monday.' }, hf]);
  assert.equal(r.route, 'hf_zerogpu');
  r = routeWork('film_clip', [{ ...kaggle, usable: false, detail: 'No Kaggle token is saved.' }, { ...hf, usable: false, detail: 'No Hugging Face token.' }]);
  assert.equal(r.route, null);
  assert.match(r.why, /^No computer can take moving clips and lip sync now\. The free Kaggle GPU: No Kaggle token is saved\. The free Hugging Face GPU: No Hugging Face token\./);
  assert.ok(r.why.includes(MODAL_CANNOT_CLIPS.replace(/\.$/, '')), 'it says why the paid GPU is no help');
  // CPU work never goes to a metered GPU.
  const scene = routeWork('scene_render', [{ id: 'github_actions', usable: true, detail: 'free runners' }]);
  assert.deepEqual([scene.route, scene.paid], ['github_actions', false]);
  assert.match(routeWork('scene_render', [{ id: 'github_actions', usable: false, detail: 'needs CHE_GITHUB_TOKEN' }]).why, /CPU work never goes to a metered GPU/);
  assert.equal(routeWork('picture_gpu', [], { modal: { ok: false, reason: 'cap reached' } }).route, null);
  assert.deepEqual(routeWork('picture_gpu', [], { modal: { ok: true, left_usd: 9 } }).order, ['modal']);
});

test('the Blender gate: within the cap a GPU-only job may go to Modal; at the cap it may not, not even with a one-shot approval', () => {
  const pool = {};
  let g = modalCreditGate(pool, T);
  assert.deepEqual([g.ok, g.paid, g.cap_usd, g.stop_usd], [true, true, 10, 9.5], 'the owner\'s $10 approval turns paid use on, under the cap');
  doneCall(pool, 9.2);
  g = modalCreditGate(pool, T);
  assert.equal(g.ok, false); assert.equal(g.kind, 'month_cap');
  assert.match(g.reason, /^Modal's monthly cap is reached: my estimate of Modal use this month \(2026-11\) is \$9\.\d\d/);
  assert.match(g.reason, /under your \$10\.00 a month \("Yes cap 10 a month"\)/);
  applyModalIntent(pool, { action: 'approve_next' }, 'approve the next Modal job', T);
  assert.equal(modalCreditGate(pool, T).ok, false, 'a one-shot approval never passes the monthly cap');
  // A new calendar month (UTC) starts from zero.
  assert.equal(modalCreditGate(pool, Date.parse('2026-12-01T00:00:01Z')).ok, true);
});

test('an open call counts at its worst case, and GPU pictures count in the same month', () => {
  const pool = {};
  const m = modalStateOf(pool);
  m.calls['job:a:modal:1'] = { key: 'job:a:modal:1', provider: 'modal', job_ids: ['a'], state: 'running', dispatched_ms: T - 60_000, usd_hr: MODAL_USD_HR };
  const c = modalMonthCheck(pool, 0, { t: T });
  assert.equal(c.used_usd, MODAL_CALL_WORST_USD, 'a call one minute in is held at its 45-minute worst case');
  const ledger = { jobs: [
    { id: 'p1', state: 'settled', max_usd: 0.11, actual_usd: 0.02, reserved_at: T - 3600_000 },
    { id: 'p2', state: 'reserved', max_usd: 0.11, reserved_at: T - 60_000 },
    { id: 'p3', state: 'released', max_usd: 0.11, actual_usd: 0, reserved_at: T - 60_000 },
    { id: 'old', state: 'settled', max_usd: 0.11, actual_usd: 0.05, reserved_at: Date.parse('2026-10-30T12:00:00Z') },
  ] };
  assert.equal(testBudgetMonthUsd(ledger, '2026-11'), 0.13);
  const both = modalMonthCheck(pool, 0, { otherUsd: 0.13, t: T });
  assert.equal(both.used_usd, Math.round((MODAL_CALL_WORST_USD + 0.13) * 10000) / 10000);
  assert.equal(modalCreditGate(pool, T, { otherUsd: 9.2 }).kind, 'month_cap', 'pictures and Blender calls share one cap');
});

test('a GPU picture past the monthly cap is refused before anything is sent to Modal', async () => {
  const storage = memStorage();
  // startModalImage reads the real clock, so the spent call is dated now (any month the test runs in).
  const pool = {}; doneCall(pool, 9.45, Date.now() - 1000);
  await storage.put(POOL_KEY, pool);
  let hits = 0;
  const fetcher = async () => { hits += 1; return new Response('{}', { status: 500 }); };
  const env = { CHE_MODAL_TXT2IMG: 'enabled', MODAL_TOKEN: `bearer:${'a'.repeat(64)}@https://ownerws--che-gpu.modal.run` };
  const out = await startModalImage(env, storage, { prompt: 'a glowing blue cube', width: 256 }, fetcher);
  assert.equal(out.status, 402, JSON.stringify(out));
  assert.match(out.detail, /Modal's monthly cap is reached/);
  assert.equal(hits, 0, 'nothing reached Modal');
  assert.equal((await storage.get(TEST_BUDGET_KEY))?.jobs?.length ?? 0, 0, 'no reservation was made either');
  // Under the cap the same picture passes the month check (the $5 test budget still applies after it).
  const fresh = memStorage();
  const ok = await modalMonthCheckFor(fresh, TXT2IMG_WORST_CASE_USD, Date.now());
  assert.equal(ok.ok, true);
});

test('voice: lower the cap, state the spend limit, stop Modal, and ask what this month cost', async () => {
  assert.deepEqual(modalIntent('cap Modal at 5 dollars a month'), { action: 'cap', usd: 5 });
  assert.deepEqual(modalIntent("I set Modal's spend limit to 10 dollars"), { action: 'spend_limit', usd: 10 });
  assert.equal(modalIntent("I set Modal's spend limit to zero").action, 'spend_limit_zero', 'the $0 phrase keeps its meaning');
  const pool = {};
  const up = applyModalIntent(pool, { action: 'cap', usd: 20 }, 'cap Modal at 20 dollars a month', T);
  assert.equal(up.ok, false); assert.match(up.spoken, /raising it is a code change you approve/);
  const down = applyModalIntent(pool, { action: 'cap', usd: 5 }, 'cap Modal at 5 dollars a month', T);
  assert.equal(down.ok, true); assert.equal(modalMonthStop(pool), 4.75);
  assert.equal(modalStateOf(pool).paid_cap.words, 'cap Modal at 5 dollars a month');
  applyModalIntent(pool, { action: 'disable' }, "stop using Modal's credit", T);
  assert.equal(modalCreditGate(pool, T).kind, 'off', '"stop" turns Modal off even with the $10 approval');
  applyModalIntent(pool, { action: 'enable' }, "use Modal's free credit", T);
  assert.equal(modalCreditGate(pool, T).ok, true);

  for (const q of ['How much GPU money have I used this month?', 'how much have I spent on GPUs this month', 'what did I spend on Modal this month']) {
    assert.equal(budgetIntent(q.replace(/\?$/, ''))?.action, 'month', q);
    assert.equal(cloudIntent(q)?.command, 'cloud-gpu', q);
  }
  const storage = memStorage();
  const p = {}; doneCall(p, 1.2);
  await storage.put(POOL_KEY, p);
  await storage.put(TEST_BUDGET_KEY, { jobs: [{ id: 'p1', state: 'settled', max_usd: 0.11, actual_usd: 0.03, reserved_at: T - 60_000 }] });
  const said = await budgetCommand({}, { storage, now: () => T }, { action: 'month' }, 'how much GPU money have I used this month');
  assert.equal(said.ok, true);
  assert.equal(said.month.modal_pictures_usd, 0.03);
  assert.match(said.spoken, /^GPU money this month \(2026-11, my estimate\): \$1\.2\d\./);
  assert.match(said.spoken, /under your cap of \$10\.00 a month \("Yes cap 10 a month"\); I stop at \$9\.50/);
  assert.match(said.spoken, /Free computers \(Workers AI, GitHub runners, Kaggle, Colab\) cost nothing/);
});

test('a $0 Modal cap refuses every paid dispatch unless Modal itself cannot charge and the stated credit covers it (Codex P1)', async () => {
  const env = { CHE_MODAL_TXT2IMG: 'enabled', MODAL_TOKEN: `bearer:${'a'.repeat(64)}@https://ownerws--che-gpu.modal.run` };
  const picture = async (pool) => {
    const storage = memStorage(); await storage.put(POOL_KEY, pool);
    const sent = [];
    const fetcher = async (url) => { sent.push(new URL(String(url)).pathname); return new Response(JSON.stringify({ ok: true, call_id: 'fc-1', state: 'started' }), { status: 200 }); };
    return { out: await startModalImage(env, storage, { prompt: 'a glowing blue cube', width: 256 }, fetcher), sent };
  };
  // Capped at $0, credit unknown, Modal's own spend limit still the owner's $10: nothing may be sent.
  const pool = {};
  applyModalIntent(pool, { action: 'cap', usd: 0 }, 'cap Modal at zero dollars a month', T);
  let r = await picture(pool);
  assert.equal(r.out.status, 402, JSON.stringify(r.out));
  assert.match(r.out.detail, /You capped Modal at \$0\.00 a month, but you have not confirmed that Modal's own spend limit is \$0/);
  assert.deepEqual(r.sent, [], 'no /txt2img call');
  applyModalIntent(pool, { action: 'enable' }, "use Modal's free credit", T);
  assert.equal(modalCreditGate(pool, T).ok, false, 'the Blender gate refuses too');
  // $0 spend limit confirmed but the credit is unknown: still refused, with the reason.
  applyModalIntent(pool, { action: 'spend_limit_zero' }, "I set Modal's spend limit to zero", T);
  r = await picture(pool);
  assert.equal(r.out.status, 402); assert.match(r.out.detail, /do not know your included Modal credit/); assert.deepEqual(r.sent, []);
  assert.equal(modalMonthCheck(pool, TXT2IMG_WORST_CASE_USD, { t: T }).kind, 'credit_unknown');
  // Credit stated and it covers the call: allowed under the credit's stop line.
  applyModalIntent(pool, { action: 'credit', usd: 30 }, 'my Modal credit is 30 dollars', T);
  const ok = modalMonthCheck(pool, TXT2IMG_WORST_CASE_USD, { t: T });
  assert.deepEqual([ok.ok, ok.stop_usd], [true, 25]);
  doneCall(pool, 24.99);
  assert.equal(modalMonthCheck(pool, TXT2IMG_WORST_CASE_USD, { t: T }).ok, false, 'not when the credit no longer covers it');
});

test('the picture ledger keeps each month\'s spend through compaction: 201 settled $0.02 pictures are $4.02 (Codex P2)', async () => {
  const storage = memStorage();
  const now = Date.parse('2026-11-07T12:00:00Z');
  for (let i = 0; i < 201; i += 1) {
    const hold = await reserveTestBudget(storage, { label: `p${i}`, max_usd: 0.02, id: `p${i}`, now: now + i });
    assert.equal(hold.ok, true);
    await settleTestBudget(storage, hold.id, { actual_usd: 0.02, provenance: 'MEASURED', now: now + i });
  }
  const ledger = await storage.get(TEST_BUDGET_KEY);
  assert.ok(ledger.jobs.length <= 200, 'compaction ran');
  assert.equal(testBudgetMonthUsd(ledger, '2026-11'), 4.02);
  assert.equal(testBudgetMonthUsd(ledger, '2026-10'), 0);
  // The shared Modal check sees the same $4.02.
  const c = await modalMonthCheckFor(storage, 0, now + 1000);
  assert.equal(c.used_usd, 4.02);
});
