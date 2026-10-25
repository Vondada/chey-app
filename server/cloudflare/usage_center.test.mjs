// Usage Center (usage_center.js): one evidence-backed view; every number labelled OBSERVED, ESTIMATED, USER_ENTERED or
// UNAVAILABLE; owner-only; subscriptions only as the owner said them; removal asks first; nothing fabricated.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { commandById } from './command_catalog.js';
import { PROVENANCE, addSubscription, computeReceipts, nextRenewal, parseSubscription, usageCenterIntent, usageView } from './usage_center.js';

const generated = new URL('./.usage_center.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
));
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// Offline: the Usage Center reads stored records only, so any outbound request is a failure.
const requests = [];
globalThis.fetch = async (input) => { requests.push(String(input?.url || input)); throw new TypeError('fetch failed (usage_center tests are offline)'); };

function storageFor(saved) {
  return {
    get: async (key) => (Array.isArray(key)
      ? new Map(key.filter((k) => saved.has(k)).map((k) => [k, structuredClone(saved.get(k))]))
      : (saved.has(key) ? structuredClone(saved.get(key)) : undefined)),
    put: async (key, value) => {
      if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v));
      else saved.set(key, structuredClone(value));
    },
    delete: async (key) => (Array.isArray(key) ? key.filter((k) => saved.delete(k)).length : saved.delete(key)),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => String(k).startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

const NOW = Date.UTC(2026, 9, 25, 15, 0, 0);
const H = 3600_000;
const at = (ms) => new Date(ms).toISOString();
const metricOf = (view, rowId, id) => view.rows.find((r) => r.id === rowId)?.metrics.find((m) => m.id === id);

/** A brain with real-shaped records from each existing source. */
function seeded() {
  const saved = new Map();
  saved.set('provider_keys', { GROQ_API_KEY: 'gsk_test_key_abcd', GEMINI_API_KEY: 'AIza_test_key_wxyz', MISTRAL_API_KEY: 'mistral_test_key_1234', RUNPOD_API_KEY: 'rp_test_key_5678', KAGGLE_API_TOKEN: 'owner:kaggle_token_9999' });
  saved.set('key_health', { groq: { status: 'healthy', at: NOW - 2 * H, last4: 'abcd' }, gemini: { status: 'unauthorized', code: 401, at: NOW - 3 * H, last4: 'wxyz' } });
  saved.set('ai_usage:groq', { estimated_tokens: 900, reset_at: NOW + 6 * H, limit: 1000 });
  saved.set(`tok_day:${at(NOW).slice(0, 10)}`, 1200);
  saved.set('pool:state', {
    v: 1, cooldowns: {}, handoffs: [], verified: {}, tokens: {}, sessions: {}, settings: { allow_unverified_gpu: false },
    quota: { kaggle: { ok: true, source: 'GetAcceleratorQuotaStatistics', allowed_s: 30 * 3600, used_s: 26 * 3600, reserved_s: 0, refresh: '2026-10-27T00:00:00Z', checked_ms: NOW - H, checked_at: at(NOW - H) } },
    budget: {
      total_cap_usd: 3, monthly_cap_usd: 3, approved_at: at(NOW - 72 * H), approval_text: 'allow up to 3 dollars for GPUs', speed_opt_in: false, history: [],
      balances: { runpod: { usd: 15, ok: true, checked_ms: NOW - H, checked_at: at(NOW - H) } },
      sessions: [
        { id: 'ps_billed', provider: 'runpod', gpu: 'RTX 4090', usd_hr: 0.34, started_ms: NOW - 10 * H, started_at: at(NOW - 10 * H), ended_ms: NOW - 9 * H, ended_at: at(NOW - 9 * H), usd_billed: 2, cost_source: 'provider billing', job_ids: ['gpu_a'] },
        { id: 'ps_est', provider: 'runpod', gpu: 'RTX 3090', usd_hr: 0.22, started_ms: NOW - 5 * H, started_at: at(NOW - 5 * H), ended_ms: NOW - 3 * H, ended_at: at(NOW - 3 * H), usd_billed: null, cost_source: 'wall time x hourly price', job_ids: ['gpu_b'] },
      ],
    },
  });
  saved.set('gpu:jobs', [
    { id: 'gpu_a', kind: 'person_model', state: 'completed', pool: { attempts: [{ provider: 'kaggle', started_at: at(NOW - 8 * H), ended_at: at(NOW - 8 * H + 600_000), outcome: 'completed' }] } },
    { id: 'gpu_b', kind: 'person_model', state: 'completed', pool: { attempts: [{ provider: 'github_actions_cpu', started_at: at(NOW - 4 * H), ended_at: at(NOW - 2 * H), outcome: 'completed' }] } },
  ]);
  return saved;
}

test('rows carry each provenance kind, with sources, words and reasons; nothing is fetched', async () => {
  const saved = seeded();
  const storage = storageFor(saved);
  await addSubscription(storage, 'my ChatGPT subscription is $20 a month, renews on the 3rd', NOW - 24 * H);
  const before = requests.length;
  const view = await usageView({ AI: {}, CHE_GROQ_DAILY_TOKEN_LIMIT: '1000' }, { storage, now: NOW });
  assert.equal(requests.length, before, 'no provider call');
  const groq = view.rows.find((r) => r.id === 'ai:groq');
  assert.equal(groq.status_id, 'connected');
  assert.match(groq.evidence, /Key test passed/);
  const tokens = metricOf(view, 'ai:groq', 'tokens_today');
  assert.equal(tokens.provenance, PROVENANCE.ESTIMATED);
  assert.equal(tokens.value, 900);
  assert.match(tokens.source, /characters ÷ 4/);
  assert.equal(metricOf(view, 'ai:groq', 'tokens_split').provenance, PROVENANCE.UNAVAILABLE, 'input/output split is not invented');
  assert.equal(metricOf(view, 'ai:groq', 'tokens_split').value, null);
  assert.equal(metricOf(view, 'ai:groq', 'token_charge').provenance, PROVENANCE.UNAVAILABLE, 'token charges are never assumed');
  assert.equal(view.rows.find((r) => r.id === 'ai:gemini').status_id, 'needs_owner_sign_in');
  assert.equal(view.rows.find((r) => r.id === 'ai:mistral').status_id, 'unverified', 'a saved key alone is not "connected"');
  assert.equal(view.rows.find((r) => r.id === 'ai:openai').status_id, 'not_connected');
  assert.equal(metricOf(view, 'ai:openai', 'che_spend').provenance, PROVENANCE.OBSERVED, 'paid engines are off in the router');

  const kaggle = view.rows.find((r) => r.id === 'compute:kaggle');
  assert.equal(kaggle.status_id, 'connected', 'an authenticated quota read verifies Kaggle');
  assert.equal(metricOf(view, 'compute:kaggle', 'quota_left').provenance, PROVENANCE.OBSERVED);
  assert.equal(metricOf(view, 'compute:kaggle', 'quota_left').value, 4);
  assert.equal(metricOf(view, 'compute:kaggle', 'gpu_seconds').value, 600);
  assert.equal(metricOf(view, 'compute:kaggle', 'gpu_seconds').provenance, PROVENANCE.OBSERVED);
  assert.equal(metricOf(view, 'compute:github_actions_cpu', 'cpu_hours').value, 2);

  const runpod = view.rows.find((r) => r.id === 'compute:runpod');
  assert.equal(runpod.status_id, 'connected', 'an authenticated balance read verifies RunPod');
  assert.equal(metricOf(view, 'compute:runpod', 'balance').provenance, PROVENANCE.OBSERVED);
  assert.equal(metricOf(view, 'compute:runpod', 'balance').value, 15);
  assert.equal(metricOf(view, 'compute:runpod', 'invoiced').provenance, PROVENANCE.OBSERVED, 'billed by the provider');
  assert.equal(metricOf(view, 'compute:runpod', 'invoiced').value, 2);
  const est = metricOf(view, 'compute:runpod', 'estimated');
  assert.equal(est.provenance, PROVENANCE.ESTIMATED);
  assert.equal(est.value, 0.44);
  assert.match(est.price_source, /runpod\.io/, 'the price source is named');

  const modal = view.rows.find((r) => r.id === 'compute:modal');
  assert.equal(modal.status_id, 'not_connected');
  assert.ok(modal.metrics.every((m) => m.provenance !== PROVENANCE.OBSERVED || (['jobs_month', 'gpu_seconds'].includes(m.id) && m.value === 0)), 'only CHE\'s own zero job count');
  assert.equal(metricOf(view, 'compute:modal', 'credits').provenance, PROVENANCE.UNAVAILABLE);

  const budget = view.rows.find((r) => r.id === 'budget:gpu');
  assert.equal(metricOf(view, 'budget:gpu', 'cap').provenance, PROVENANCE.USER_ENTERED);
  assert.equal(metricOf(view, 'budget:gpu', 'cap').words, 'allow up to 3 dollars for GPUs');
  assert.equal(budget.spent_usd, 2.44);

  const sub = view.rows.find((r) => r.group === 'subscription');
  assert.equal(sub.name, 'ChatGPT');
  const price = sub.metrics.find((m) => m.id === 'price');
  assert.equal(price.provenance, PROVENANCE.USER_ENTERED);
  assert.equal(price.value, 20);
  assert.equal(price.words, 'my ChatGPT subscription is $20 a month, renews on the 3rd');
  assert.equal(price.at, at(NOW - 24 * H));
  assert.equal(sub.metrics.find((m) => m.id === 'invoiced').provenance, PROVENANCE.UNAVAILABLE);
  assert.equal(view.totals.find((m) => m.id === 'subscriptions_month').value, 20);
  assert.equal(view.totals.find((m) => m.id === 'tokens_today').value, 1200);
  for (const r of view.rows) for (const m of r.metrics) {
    assert.ok(Object.values(PROVENANCE).includes(m.provenance), `${r.id}.${m.id} provenance`);
    if (m.provenance === PROVENANCE.UNAVAILABLE) { assert.equal(m.value, null); assert.ok(m.why, `${r.id}.${m.id} says why`); }
  }
  const text = JSON.stringify(view);
  for (const secret of ['gsk_test_key_abcd', 'AIza_test_key_wxyz', 'rp_test_key_5678', 'kaggle_token_9999']) assert.doesNotMatch(text, new RegExp(secret), 'no key leaves');
});

test('without credentials every provider is not connected and no number is invented', async () => {
  const view = await usageView({}, { storage: storageFor(new Map()), now: NOW });
  for (const r of view.rows.filter((x) => x.group === 'ai' || x.group === 'compute')) assert.equal(r.status_id, 'not_connected', r.id);
  assert.equal(view.subscriptions.length, 0, 'no subscription is discovered or guessed');
  assert.equal(view.totals.find((m) => m.id === 'subscriptions_month').provenance, PROVENANCE.UNAVAILABLE);
  assert.equal(view.rows.find((r) => r.id === 'budget:gpu').status, 'off');
  assert.equal(metricOf(view, 'compute:runpod', 'balance').provenance, PROVENANCE.UNAVAILABLE);
  assert.equal(metricOf(view, 'compute:kaggle', 'quota').provenance, PROVENANCE.UNAVAILABLE);
  assert.equal(view.alerts.length, 0);
  assert.match(view.spoken, /0 services connected/);
  assert.match(view.spoken, /You have not told me any subscriptions/);
  assert.doesNotMatch(view.spoken, /tap/i);
});

test('when the records cannot be read, the view says so instead of reporting zeros or "not connected"', async () => {
  const broken = { get: async () => { throw new Error('storage unavailable'); }, put: async () => { throw new Error('storage unavailable'); }, list: async () => new Map() };
  const before = requests.length;
  const view = await usageView({}, { storage: broken, now: NOW });
  assert.equal(requests.length, before);
  const ai = view.rows.filter((r) => r.group === 'ai');
  assert.ok(ai.length > 0 && ai.every((r) => r.status_id === 'unknown'), 'unknown, not "not connected"');
  assert.ok(view.rows.filter((r) => r.group === 'compute').every((r) => r.status_id === 'unknown'));
  for (const id of ['tokens_today', 'gpu_seconds', 'cpu_hours', 'subscriptions_month']) assert.equal(view.totals.find((m) => m.id === id).provenance, PROVENANCE.UNAVAILABLE, id);
  assert.equal(view.subscriptions_readable, false);
  assert.match(view.spoken, /could not read the subscriptions/);
  assert.ok(view.rows.every((r) => r.metrics.every((m) => m.provenance === PROVENANCE.UNAVAILABLE)), 'every figure is unavailable');
});

test('alerts: quota and spending thresholds, a bill above the measurement, a renewal soon, and an unknown charge', async () => {
  const saved = seeded();
  const storage = storageFor(saved);
  await addSubscription(storage, 'my Netflix subscription is 15.49 dollars a month, renews on the 27th', NOW);
  const env = { CHE_GROQ_DAILY_TOKEN_LIMIT: '1000' };
  const first = await usageView(env, { storage, now: NOW });
  const ids = first.alerts.map((a) => a.id);
  assert.ok(ids.includes('quota:ai:groq'), 'Groq at 90% of its daily cap');
  assert.ok(ids.includes('quota:kaggle'), 'Kaggle quota 87% used');
  assert.ok(ids.includes('spend:gpu_total'), '$2.44 of a $3 budget');
  assert.ok(ids.includes('billed:ps_billed'), 'billed $2 for a session measured at $0.34');
  assert.ok(ids.includes(`renewal:${first.subscriptions[0].id}`), 'renews in two days');
  assert.ok(!ids.some((id) => id.startsWith('unknown:')), 'the first balance read only sets the mark');
  assert.equal(first.alerts.find((a) => a.id === 'quota:ai:groq').provenance, PROVENANCE.ESTIMATED);
  assert.equal(first.alerts.find((a) => a.id.startsWith('renewal:')).provenance, PROVENANCE.USER_ENTERED);

  // The balance falls $5 with no new CHE session: an unknown charge, kept after the next view.
  const pool = saved.get('pool:state');
  pool.budget.balances.runpod = { usd: 10, ok: true, checked_ms: NOW + H, checked_at: at(NOW + H) };
  saved.set('pool:state', pool);
  const second = await usageView(env, { storage, now: NOW + 2 * H });
  const unknown = second.alerts.find((a) => a.kind === 'unknown_charge' && a.id.startsWith('unknown:runpod'));
  assert.ok(unknown, 'unknown charge raised');
  assert.match(unknown.text, /fell \$5\.00[\s\S]*account for \$0\.00/);
  const third = await usageView(env, { storage, now: NOW + 3 * H });
  assert.ok(third.alerts.some((a) => a.id === unknown.id), 'the unknown charge stays listed');

  // A top-up is not a charge.
  pool.budget.balances.runpod = { usd: 30, ok: true, checked_ms: NOW + 4 * H, checked_at: at(NOW + 4 * H) };
  saved.set('pool:state', pool);
  const fourth = await usageView(env, { storage, now: NOW + 5 * H });
  assert.equal(fourth.alerts.filter((a) => a.id.startsWith('unknown:')).length, 1);
});

test('subscriptions are parsed only from what was said', () => {
  const p = parseSubscription('my ChatGPT subscription is $20 a month, renews on the 3rd', NOW);
  assert.equal(p.ok, true);
  assert.deepEqual({ name: p.sub.name, amount: p.sub.amount_usd, period: p.sub.period, day: p.sub.renews.day }, { name: 'ChatGPT', amount: 20, period: 'month', day: 3 });
  assert.equal(new Date(nextRenewal(p.sub, NOW)).toISOString().slice(0, 10), '2026-11-03');
  const y = parseSubscription('add a subscription to Adobe Creative Cloud at $599 per year renews on March 3rd', NOW);
  assert.equal(y.sub.period, 'year');
  assert.equal(new Date(nextRenewal(y.sub, NOW)).toISOString().slice(0, 10), '2027-03-03');
  const noDay = parseSubscription('my spotify subscription is twelve dollars a month', NOW);
  assert.equal(noDay.sub.amount_usd, 12);
  assert.equal(noDay.sub.renews, null, 'no renewal day is invented');
  assert.equal(nextRenewal(noDay.sub, NOW), null);
  const noPrice = parseSubscription('my gym subscription renews on the 5th', NOW);
  assert.equal(noPrice.ok, false);
  assert.deepEqual(noPrice.missing, ['price']);
});

test('compute receipts come from a ledger when one is exported, else from the job records', async () => {
  const storage = storageFor(seeded());
  const derived = await computeReceipts(storage, { month: '2026-10', now: NOW, ledger: null });
  assert.equal(derived.source, 'gpu:jobs attempts');
  assert.deepEqual(derived.rows.map((r) => [r.provider, r.gpu_seconds, r.cpu_seconds]), [['kaggle', 600, 0], ['github_actions_cpu', 0, 7200]]);
  // lane/modal-gpu's modal_gpu.js computeUsageLedger(storage, { month, now }) shape.
  const modalLedger = async (_s, { month }) => ({
    month, generated_at: at(NOW), provenance_values: ['OBSERVED', 'ESTIMATED', 'USER-ENTERED', 'UNAVAILABLE'], providers: {},
    receipts: [
      { job_id: 'gpu_m1', job_title: 'Cube render', job_state: 'completed', provider: 'modal', idempotency_key: 'mc_1', state: 'completed', gpu: 'T4', gpu_seconds: 42, gpu_seconds_provenance: 'OBSERVED',
        estimated_cost_usd: 0.0069, cost_provenance: 'ESTIMATED', billed_cost_usd: null, billed_provenance: 'UNAVAILABLE', started_at: at(NOW - H), ended_at: at(NOW - H + 42_000), attempts: 1, artifact_sha256: null, error: '',
        data_provenance: { gpu_seconds: 'OBSERVED', cost: 'ESTIMATED', billed: 'UNAVAILABLE' } },
      { job_id: 'gpu_k1', job_title: 'Character', job_state: 'completed', provider: 'kaggle', idempotency_key: null, state: 'completed', gpu: 'GPU', gpu_seconds: null, gpu_seconds_provenance: 'UNAVAILABLE', cpu_seconds: null,
        estimated_cost_usd: 0, cost_provenance: 'ESTIMATED', cost_basis: 'Kaggle weekly free GPU quota', billed_cost_usd: null, billed_provenance: 'UNAVAILABLE', ended_at: at(NOW - 2 * H) },
    ],
    totals: { estimated_cost_usd: 0.0069, billed_cost_usd: null },
    modal_credit: { opt_in: true, spend_limit_zero: true, stated_credit_usd: 30, stated_credit_provenance: 'USER-ENTERED', third_party_listing_usd: 30, stop_at_usd: 28.5, used_estimate_usd: 0.0069, used_estimate_provenance: 'ESTIMATED',
      remaining_credit_usd: null, remaining_credit_provenance: 'UNAVAILABLE', remaining_credit_why: 'Modal billing reports are Team/Enterprise only and show costs before credits (modal.com/docs/guide/billing).' },
  });
  const viaLedger = await computeReceipts(storage, { month: '2026-10', now: NOW, ledger: modalLedger });
  assert.equal(viaLedger.source, 'computeUsageLedger');
  assert.deepEqual(viaLedger.rows[0], { provider: 'modal', job: 'gpu_m1', kind: 'Cube render', outcome: 'completed', gpu_seconds: 42, cpu_seconds: 0, measured: true, estimated_cost: 0.0069, billed_cost: null, provenance: 'OBSERVED', source: '' });
  assert.equal(viaLedger.rows[1].measured, false, 'an unknown run time is unmeasured, not zero');
  const view = await usageView({}, { storage, now: NOW, ledger: modalLedger });
  assert.equal(metricOf(view, 'compute:modal', 'gpu_seconds').value, 42);
  assert.equal(metricOf(view, 'compute:modal', 'used_estimate').provenance, PROVENANCE.ESTIMATED);
  assert.equal(metricOf(view, 'compute:modal', 'stated_credit').provenance, PROVENANCE.USER_ENTERED);
  assert.match(metricOf(view, 'compute:modal', 'credits').why, /Team\/Enterprise/);
  assert.equal(metricOf(view, 'compute:kaggle', 'gpu_seconds').provenance, PROVENANCE.UNAVAILABLE, 'the only Kaggle job has no measured time');
  const failing = await computeReceipts(storage, { month: '2026-10', now: NOW, ledger: async () => { throw new Error('ledger down'); } });
  assert.equal(failing.source, 'gpu:jobs attempts', 'a failing ledger falls back to the records');
});

test('spoken forms map to the three catalog commands; other phrases are left to their own routes', () => {
  for (const [said, command, input] of [
    ["What's my usage?", 'usage-center', ''], ['CHE, open the Usage Center', 'usage-center', ''], ['what subscriptions do I have', 'usage-center', 'subscriptions'],
    ['any usage alerts', 'usage-center', 'alerts'], ['add a subscription', 'usage-subscription-add', ''],
    ['my ChatGPT subscription is $20 a month, renews on the 3rd', 'usage-subscription-add', 'my ChatGPT subscription is $20 a month, renews on the 3rd'],
    ['remove my ChatGPT subscription', 'usage-subscription-remove', 'ChatGPT'], ['remove a subscription', 'usage-subscription-remove', ''],
    ['cancel my Netflix subscription', 'usage-center', 'cancel Netflix'],
  ]) {
    assert.deepEqual(usageCenterIntent(said), { command, input }, said);
    assert.equal(commandById(command).route, 'che_usage_center');
  }
  for (const other of ['how much GPU money is left', 'how many subscribers do I have on YouTube', 'how many tokens today', 'subscribe me to Netflix']) assert.equal(usageCenterIntent(other), null, other);
});

// ─── Through the real Worker ──────────────────────────────────────────────────────────────────────────────────────
async function owner(saved = new Map()) {
  const pending = [];
  let calls = 0;
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => { calls += 1; return { response: 'MODEL ANSWERED' }; } } };
  const connect = () => { const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env); env.CHE_STATE = { getByName: () => state }; };
  connect();
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const say = async (message, as = token) => {
    const before = calls;
    const res = await send('/api/chat', { message, history: [] }, as);
    const raw = await res.text();
    while (pending.length) await pending.shift();
    let held = null; try { held = JSON.parse(raw); } catch (_) { held = null; }
    const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    return { route: held?.held_for_owner ? 'held' : done.source || (calls > before ? 'model' : 'none'), done, held, reply: held?.message || replyFromNdjson(raw), modelCalls: calls - before };
  };
  const get = async (path, as = token) => { const r = await send(path, null, as, 'GET'); return { status: r.status, body: await r.json() }; };
  const post = async (path, body, as = token) => { const r = await send(path, body, as); return { status: r.status, body: await r.json() }; };
  return { say, get, post, send, token, saved, restart: connect };
}

test('GET /api/usage is the owner\'s: a guest device gets 403 and no figures', async () => {
  const che = await owner();
  const tenant = await che.post('/api/platform/tenants', { name: 'Guest', role: 'family' });
  const invite = await che.post('/api/platform/enrollments', { access: 'private', tenant_id: tenant.body?.tenant?.id || tenant.body?.body?.tenant?.id });
  const enrollment = invite.body?.enrollment || invite.body?.body?.enrollment;
  const guest = (await (await che.send('/api/enroll', { enrollment_token: enrollment.token, device_name: 'guest' })).json()).device_token;
  assert.ok(guest, 'guest device enrolled');
  for (const path of ['/api/usage']) {
    const out = await che.get(path, guest);
    assert.equal(out.status, 403, path);
    assert.equal(out.body.rows, undefined);
  }
  assert.equal((await che.post('/api/usage/subscriptions', { text: 'my ChatGPT subscription is $20 a month' }, guest)).status, 403);
  const mine = await che.get('/api/usage');
  assert.equal(mine.status, 200);
  assert.ok(Array.isArray(mine.body.rows) && mine.body.rows.length > 0);
  const said = await che.say("What's my usage?", guest);
  assert.notEqual(said.route, 'che_usage_center', 'a guest\'s chat never reaches the Usage Center');
});

test('voice: a subscription is saved with words and time, survives a restart, and its removal waits for a yes', async () => {
  const che = await owner();
  const added = await che.say('CHE, my ChatGPT subscription is $20 a month, renews on the 3rd.');
  assert.equal(added.route, 'che_usage_center', added.reply);
  assert.equal(added.modelCalls, 0);
  assert.match(added.reply, /ChatGPT, \$20\.00 a month, renews the 3rd/);
  assert.match(added.reply, /did not check it with ChatGPT/);

  che.restart();   // a new Durable Object instance over the same storage
  const view = await che.get('/api/usage');
  const sub = view.body.subscriptions.find((s) => s.name === 'ChatGPT');
  assert.ok(sub, 'persisted across the restart');
  assert.equal(sub.words, 'my ChatGPT subscription is $20 a month, renews on the 3rd');
  assert.match(sub.at, /^\d{4}-\d\d-\d\dT/);
  const row = view.body.rows.find((r) => r.sub_id === sub.id);
  assert.equal(row.metrics.find((m) => m.id === 'price').provenance, 'USER_ENTERED');

  const list = await che.say('What subscriptions do I have?');
  assert.equal(list.route, 'che_usage_center');
  assert.match(list.reply, /1\. ChatGPT, \$20\.00 a month, renews the 3rd/);

  const usage = await che.say("What's my usage?");
  assert.equal(usage.route, 'che_usage_center');
  assert.equal(usage.done.open_screen, 'usage_center');
  assert.equal(usage.modelCalls, 0);
  assert.match(usage.reply, /^Usage Center\./);

  const cancel = await che.say('cancel my ChatGPT subscription');
  assert.equal(cancel.route, 'che_usage_center');
  assert.equal(cancel.done.account_change, 'not_performed');
  assert.match(cancel.reply, /Nothing was cancelled/);

  const ask = await che.say('remove my ChatGPT subscription');
  assert.equal(ask.route, 'held', 'removal asks first (AGENTS.md delete rule)');
  assert.match(ask.reply, /Should I remove your ChatGPT subscription record/);
  assert.ok((await che.get('/api/usage')).body.subscriptions.some((s) => s.name === 'ChatGPT'), 'nothing removed before the yes');
  const yes = await che.say('yes');
  assert.equal(yes.route, 'che_usage_center', yes.reply);
  assert.match(yes.reply, /Removed the ChatGPT record/);
  che.restart();
  assert.equal((await che.get('/api/usage')).body.subscriptions.length, 0);
});

test('the screen\'s remove needs confirm: true; the GPU money question stays with the GPU budget', async () => {
  const che = await owner();
  const added = await che.post('/api/usage/subscriptions', { text: 'my Netflix subscription is 15.49 dollars a month' });
  assert.equal(added.status, 200);
  const id = added.body.subscription.id;
  const unconfirmed = await che.post('/api/usage/subscriptions/remove', { id });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.needs_confirmation, true);
  assert.equal((await che.get('/api/usage')).body.subscriptions.length, 1);
  const confirmed = await che.post('/api/usage/subscriptions/remove', { id, confirm: true });
  assert.equal(confirmed.status, 200);
  assert.equal((await che.get('/api/usage')).body.subscriptions.length, 0);
  const bad = await che.post('/api/usage/subscriptions', { text: 'my gym subscription' });
  assert.equal(bad.status, 422);
  assert.match(bad.body.spoken, /Nothing was saved/);
  const gpu = await che.say('how much GPU money is left');
  assert.equal(gpu.route, 'che_cloud_computer', 'the existing GPU budget answer');
  assert.match(gpu.reply, /Paid GPUs are off/);
});
