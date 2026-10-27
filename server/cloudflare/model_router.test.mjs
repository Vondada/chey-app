// Zero-cost model router (owner rule, 2026-10-27: $0 authorized AI spend). Covers the seven error
// classes, the circuit breaker, provider verdicts, ranking, the ledger and the app's status view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ERROR_CLASSES, attemptReceipt, breakerAfter, breakerAllows, breakerState, classifyRouterError, failoverDecision,
} from './coding_failover.mjs';
import {
  AUTHORIZED_SPEND_USD, MAX_CANDIDATES, POLICIES, PROVIDER_POLICIES, attestedProviders, capabilityScore, emptyLedger,
  mergeLedger, modelEligibility, modelStatusView, planCandidates, pricingIsZero, providerVerdict, speakModelStatus,
  spendAuthorization, taskKind,
} from './model_router.mjs';

const T0 = Date.parse('2026-10-27T12:00:00Z');
const FREE = { prompt: '0', completion: '0', request: '0' };
const orKey = (data) => ({ key_present: true, auth: { ok: true, status: 200 }, openrouter_key: data });

// ─── Error classes ───
test('exactly seven error classes, each reached by real provider or OpenCode text', () => {
  assert.deepEqual([...ERROR_CLASSES].sort(), ['auth_failure', 'billing_risk', 'credit_exhausted', 'provider_unavailable', 'rate_limited', 'task_failure', 'unsupported_model']);
  const cases = [
    // The failure on every recent record (ocr-49bea5b4, run 40253860341).
    ['provider_unavailable', '{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_6c7e99e3"}}}'],
    ['provider_unavailable', 'upstream connect error: 503 Service Unavailable'],
    ['auth_failure', '{"statusCode": 401, "message": "No auth credentials found"}'],
    ['auth_failure', 'Invalid API Key'],
    ['rate_limited', 'Rate limit reached for model in organization on requests per minute (RPM)'],
    ['rate_limited', '{"statusCode": 429}'],
    ['credit_exhausted', 'You exceeded your current quota, please check your plan and billing details'],
    ['credit_exhausted', 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day'],
    ['credit_exhausted', 'RESOURCE_EXHAUSTED'],
    ['billing_risk', '{"error":{"code":402,"message":"Insufficient credits. Add more using https://openrouter.ai/credits"}}'],
    ['billing_risk', 'Payment Required'],
    ['unsupported_model', 'The model `llama-3.3-70b-versatile` has been decommissioned'],
    ['unsupported_model', 'The model `x` does not exist or you do not have access to it.'],
    ['unsupported_model', 'ContextOverflowError: Request too large for model on input tokens per minute (ITPM): Limit 7000, Requested 10182'],
    ['unsupported_model', 'No endpoints found that support tool use'],
    ['task_failure', 'timed out'],
    ['task_failure', ''],
  ];
  for (const [cls, text] of cases) assert.equal(classifyRouterError({ text, exitCode: 1 }), cls, text);
  assert.equal(classifyRouterError({ text: 'nothing useful', status: 502 }), 'provider_unavailable');
  assert.equal(classifyRouterError({ text: 'nothing useful', status: 403 }), 'auth_failure');
});

test('numbers that are not status codes never classify an error', () => {
  assert.equal(classifyRouterError({ text: 'stopped at timestamp 1792941401 after 500 tokens' }), 'task_failure');
  assert.equal(classifyRouterError({ text: 'Limit 429 lines in file' }), 'task_failure');
});

test('the failover decision follows the class: account-wide failures skip the provider, model failures skip the model', () => {
  assert.equal(failoverDecision('auth_failure').scope, 'provider');
  assert.equal(failoverDecision('billing_risk').scope, 'provider');
  assert.equal(failoverDecision('billing_risk').alert, true);
  assert.equal(failoverDecision('credit_exhausted', { text: 'free-models-per-day' }).scope, 'provider');
  assert.equal(failoverDecision('credit_exhausted', { text: 'free-models-per-day' }).next, 'next_provider');
  assert.equal(failoverDecision('credit_exhausted', { text: 'You exceeded your current quota' }).scope, 'model', 'Gemini and Groq quotas are per model');
  assert.equal(failoverDecision('unsupported_model').scope, 'model');
  assert.equal(failoverDecision('task_failure').next, 'next_model_with_checkpoint');
  assert.equal(failoverDecision('rate_limited').resumable, true);
  assert.equal(failoverDecision('nonsense').error_class, 'task_failure');
});

test('a receipt carries the router fields the coding audit reads, and keeps the old ones', () => {
  const r = attemptReceipt({ model: 'openrouter/qwen/qwen3-coder:free', exitCode: 1, text: 'Unexpected server error', seconds: 2, capSeconds: 420, progress: 'none', coverage: 'free', startedAt: '2026-10-27T12:00:00Z' });
  for (const field of ['model', 'exit_code', 'kind', 'resumable', 'seconds', 'progress', 'error']) assert.ok(field in r, field);
  assert.equal(r.provider, 'openrouter');
  assert.equal(r.error_class, 'provider_unavailable');
  assert.equal(r.decision, 'next_model');
  assert.equal(r.outcome, 'failed');
  assert.equal(r.coverage, 'free');
  assert.equal(r.started_at, '2026-10-27T12:00:00Z');
  const ok = attemptReceipt({ model: 'groq/x', exitCode: 0 });
  assert.equal(ok.error_class, null);
  assert.equal(ok.outcome, 'success');
  assert.equal(ok.decision, 'completed');
  assert.equal(attemptReceipt({ model: 'a/b', exitCode: 1, coverage: 'paid' }).coverage, null, 'only free or credit_covered can be recorded');
});

// ─── Circuit breaker ───
test('circuit breaker: closed, opens on failures, half-opens after the cooldown, closes on success', () => {
  let b = breakerAfter(null, { ok: false, errorClass: 'provider_unavailable', now: T0 });
  assert.equal(breakerState(b, T0), 'closed', 'one transient failure keeps it closed');
  b = breakerAfter(b, { ok: false, errorClass: 'provider_unavailable', now: T0 + 1000 });
  assert.equal(breakerState(b, T0 + 2000), 'open');
  assert.equal(breakerAllows(b, T0 + 2000), false);
  const later = Date.parse(b.until) + 1;
  assert.equal(breakerState(b, later), 'half_open');
  assert.equal(breakerAllows(b, later), true, 'one trial is allowed');
  const reopened = breakerAfter(b, { ok: false, errorClass: 'provider_unavailable', now: later });
  assert.equal(breakerState(reopened, later + 1), 'open');
  assert.equal(reopened.cooldown_ms, b.cooldown_ms * 2, 'a failed trial doubles the cooldown');
  const closed = breakerAfter(reopened, { ok: true, now: Date.parse(reopened.until) + 1 });
  assert.equal(breakerState(closed), 'closed');
  assert.equal(closed.failures, 0);
});

test('auth, credit, billing and unsupported failures open the breaker at once', () => {
  for (const cls of ['auth_failure', 'credit_exhausted', 'billing_risk', 'unsupported_model', 'rate_limited']) {
    assert.equal(breakerState(breakerAfter(null, { ok: false, errorClass: cls, now: T0 }), T0 + 1), 'open', cls);
  }
  const task = breakerAfter(breakerAfter(null, { ok: false, errorClass: 'task_failure', now: T0 }), { ok: false, errorClass: 'task_failure', now: T0 });
  assert.equal(breakerState(task, T0), 'closed', 'a model that ran but did not finish gets three chances');
});

// ─── Spend authorization and provider verdicts ───
test('authorized spend is $0, and no setting (including the old $15 cap) raises it', () => {
  assert.equal(AUTHORIZED_SPEND_USD, 0);
  const auth = spendAuthorization({ CHE_CODING_PAID_FALLBACK: 'true', CHE_ALLOW_PAID_AI: 'yes', CHE_CODING_OPENROUTER_PAID_KEY: 'x', CHE_AI_SPEND_AUTHORIZED_USD: '15' });
  assert.equal(auth.authorized_usd, 0);
  assert.equal(auth.paid_allowed, false);
  assert.equal(auth.ignored.length, 3);
  assert.ok(auth.ignored.some((n) => /\$15 cap is a ceiling, not an authorization/.test(n)));
});

test('paid-only providers are never eligible while the authorization is $0, even with a working key or an attestation', () => {
  for (const id of ['openai', 'anthropic', 'xai']) {
    const v = providerVerdict(id, { evidence: { key_present: true, auth: { ok: true, status: 200 } }, attested: [id] });
    assert.equal(v.coverage, 'blocked', id);
    assert.equal(v.reason, 'paid_provider_spend_not_authorized');
  }
  assert.deepEqual(attestedProviders('openai, anthropic,xai,groq'), ['groq'], 'paid-only providers cannot be attested');
});

test('billing that cannot be verified is blocked, and says why', () => {
  for (const id of ['google', 'groq', 'cerebras', 'mistral']) {
    const v = providerVerdict(id, { evidence: { key_present: true, auth: { ok: true, status: 200 } } });
    assert.equal(v.policy, 'blocked_billing_unverifiable', id);
    assert.equal(v.reason, 'billing_unverifiable');
    assert.ok(v.remedy, 'the status names what would make it verifiable');
  }
  assert.equal(providerVerdict('openrouter', { evidence: orKey({ is_free_tier: false, limit: null, limit_remaining: null }) }).reason, 'key_can_spend_credits');
  assert.equal(providerVerdict('openrouter', { evidence: orKey({ is_free_tier: false, limit: 15, limit_remaining: 15 }) }).coverage, 'blocked', 'a $15 key limit can still spend $15');
  assert.equal(providerVerdict('openrouter', { evidence: orKey({ is_management_key: true, is_free_tier: true }) }).reason, 'management_key');
  assert.equal(providerVerdict('openrouter', { evidence: { key_present: true, auth: { ok: false, status: 401 } } }).connected, 'auth_failure');
  assert.equal(providerVerdict('openrouter', { evidence: { key_present: false } }).connected, 'not_configured');
});

test('verified zero cost needs runtime evidence; an attestation is labelled as such, never as a runtime check', () => {
  const free = providerVerdict('openrouter', { evidence: orKey({ is_free_tier: true, usage: 0 }) });
  assert.equal(free.policy, 'verified_zero_cost');
  assert.equal(free.verification, 'runtime');
  assert.equal(free.connected, 'verified');
  const zeroLimit = providerVerdict('openrouter', { evidence: orKey({ is_free_tier: false, limit: 0, limit_remaining: 0 }) });
  assert.equal(zeroLimit.guard, 'key_limit_zero');
  const groq = providerVerdict('groq', { evidence: { key_present: true, auth: { ok: true, status: 200 } }, attested: ['groq'] });
  assert.equal(groq.coverage, 'free');
  assert.equal(groq.verification, 'owner_attested');
  const hf = providerVerdict('huggingface', { evidence: { key_present: true, auth: { ok: true, status: 200 }, whoami: { isPro: false, orgs: [] } } });
  assert.equal(hf.verification, 'runtime');
  assert.equal(providerVerdict('huggingface', { evidence: { key_present: true, auth: { ok: true, status: 200 }, whoami: { isPro: true } } }).coverage, 'blocked', 'PRO can pay as you go');
  for (const p of PROVIDER_POLICIES) {
    assert.ok(POLICIES.includes(p.default_policy), p.id);
    assert.ok(p.sources.length && p.sources.every((u) => /^https:\/\//.test(u)), `${p.id} cites sources`);
  }
});

test('an OpenRouter model is eligible only as a live zero-price :free variant with tools and a large context', () => {
  const v = providerVerdict('openrouter', { evidence: orKey({ is_free_tier: true }) });
  const ok = (m) => modelEligibility(m, v);
  assert.equal(ok({ id: 'openrouter/qwen/qwen3-coder:free', pricing: FREE, context_length: 262144, supports_tools: true }).eligible, true);
  assert.equal(ok({ id: 'openrouter/qwen/qwen3-coder', pricing: FREE }).reason, 'not_free_variant');
  assert.equal(ok({ id: 'openrouter/a:free', pricing: { prompt: '0', completion: '0.000001' } }).reason, 'live_price_not_zero');
  assert.equal(ok({ id: 'openrouter/a:free', pricing: { prompt: '0' } }).reason, 'live_price_not_zero', 'a missing price is unknown, not free');
  assert.equal(ok({ id: 'openrouter/a:free', pricing: null }).reason, 'live_price_not_zero');
  assert.equal(ok({ id: 'openrouter/a:free', pricing: FREE, supports_tools: false }).reason, 'no_tool_calling');
  assert.equal(ok({ id: 'openrouter/a:free', pricing: FREE, context_length: 8192 }).reason, 'context_too_small');
  assert.equal(pricingIsZero({ prompt: '0', completion: '0', image: '0.001' }), false);
  assert.equal(ok({ id: 'openrouter/meta-llama/llama-3.3-70b-instruct:free', pricing: FREE, context_length: 131072 }).reason, 'retired_by_provider', 'PR #628: never ranked again');
});

// ─── Ranking ───
test('the most capable eligible model ranks first for each task kind; free does not mean weak', () => {
  const ids = ['openrouter/meta-llama/llama-3.1-8b:free', 'openrouter/qwen/qwen3-coder:free', 'openrouter/deepseek/deepseek-r1:free', 'openrouter/openai/gpt-oss-20b:free', 'openrouter/moonshotai/kimi-k2:free'];
  const best = (kind) => ids.slice().sort((a, b) => capabilityScore({ id: b }, kind) - capabilityScore({ id: a }, kind))[0];
  assert.equal(best('coding'), 'openrouter/qwen/qwen3-coder:free');
  assert.equal(best('math'), 'openrouter/deepseek/deepseek-r1:free');
  assert.equal(best('research'), 'openrouter/deepseek/deepseek-r1:free');
  assert.equal(taskKind('Add one unit test for slugify'), 'coding');
  assert.equal(taskKind('Prove the integral identity'), 'math');
  assert.equal(taskKind('Run a Monte Carlo simulation of the hover drone'), 'simulation');
  assert.equal(taskKind('Research and compare sources on battery chemistry'), 'research');
});

test('the plan holds at most MAX_CANDIDATES models, skips open breakers and tries half-open ones last', () => {
  const v = { openrouter: providerVerdict('openrouter', { evidence: orKey({ is_free_tier: true }) }), groq: providerVerdict('groq', { evidence: { key_present: true, auth: { ok: true } } }) };
  const models = Array.from({ length: 12 }, (_, i) => ({ id: `openrouter/vendor/model-${i}:free`, pricing: FREE, context_length: 131072 }));
  models.push({ id: 'openrouter/qwen/qwen3-coder:free', pricing: FREE, context_length: 262144 }, { id: 'groq/openai/gpt-oss-120b' });
  const ledger = { breakers: {
    'openrouter/qwen/qwen3-coder:free': { state: 'open', until: new Date(T0 - 1).toISOString(), last_error_class: 'provider_unavailable' },
    'openrouter/vendor/model-0:free': { state: 'open', until: new Date(T0 + 60_000).toISOString(), last_error_class: 'unsupported_model' },
  } };
  const plan = planCandidates({ models, verdicts: v, ledger, now: T0 });
  assert.equal(plan.candidates.length, MAX_CANDIDATES);
  assert.ok(!plan.candidates.some((c) => c.model === 'openrouter/vendor/model-0:free'));
  assert.ok(plan.excluded.some((e) => e.model === 'groq/openai/gpt-oss-120b' && e.reason === 'billing_unverifiable'), 'an unattested provider is excluded, with its reason');
  assert.ok(plan.excluded.some((e) => e.reason === 'circuit_open:unsupported_model'));
  const all = planCandidates({ models, verdicts: v, ledger, now: T0, limit: 50 });
  assert.equal(all.candidates.at(-1).model, 'openrouter/qwen/qwen3-coder:free', 'a half-open model gets its single trial after the closed ones');
  assert.equal(all.candidates.at(-1).trial, true);
});

test('when every provider is blocked or exhausted the plan is empty: an honest stop, never a paid fallback', () => {
  const verdicts = {
    openrouter: providerVerdict('openrouter', { evidence: orKey({ is_free_tier: true }) }),
    openai: providerVerdict('openai', { evidence: { key_present: true, auth: { ok: true } } }),
  };
  const ledger = { breakers: { openrouter: { state: 'open', until: new Date(T0 + 3_600_000).toISOString(), last_error_class: 'credit_exhausted' } } };
  const plan = planCandidates({ models: [{ id: 'openrouter/qwen/qwen3-coder:free', pricing: FREE }, { id: 'openai/gpt-5' }], verdicts, ledger, now: T0 });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.excluded.map((e) => e.reason).sort(), ['circuit_open:credit_exhausted', 'paid_provider_spend_not_authorized']);
});

// ─── Ledger ───
const RECORD = {
  session_id: 'ocr-1234abcd', state: 'pr_open', completed_by_model: 'groq/openai/gpt-oss-120b',
  attempts: [
    attemptReceipt({ model: 'openrouter/qwen/qwen3-coder:free', exitCode: 1, text: 'Rate limit exceeded: free-models-per-day. sk-or-v1-abcdefghijklmnop1234', seconds: 3, capSeconds: 420, progress: 'verified', coverage: 'free' }),
    attemptReceipt({ model: 'groq/openai/gpt-oss-120b', exitCode: 0, seconds: 200, capSeconds: 400, progress: 'delivered', coverage: 'free' }),
  ],
  routing: { verdicts: { openrouter: providerVerdict('openrouter', { evidence: orKey({ is_free_tier: true, usage: 0, limit_remaining: null }), now: T0 }) } },
  billing: { openrouter: { usage_before: 0, usage_after: 0, delta_usd: 0, verified: true } },
};

test('the ledger records each attempt, the model that finished, breakers and the verified cost, and no text or secret', () => {
  const ledger = mergeLedger(null, RECORD, T0);
  assert.equal(ledger.models['openrouter/qwen/qwen3-coder:free'].failed, 1);
  assert.equal(ledger.models['openrouter/qwen/qwen3-coder:free'].last_error_class, 'credit_exhausted');
  assert.equal(ledger.models['groq/openai/gpt-oss-120b'].completed, 1);
  assert.equal(ledger.providers.openrouter.billed_usd_verified, 0);
  assert.equal(breakerState(ledger.breakers.openrouter, T0 + 1), 'open', 'an account-wide allowance stops the provider');
  assert.equal(ledger.sessions[0].completed_by_model, 'groq/openai/gpt-oss-120b');
  assert.equal(ledger.verdicts.openrouter.policy, 'verified_zero_cost');
  const text = JSON.stringify(ledger);
  assert.doesNotMatch(text, /sk-or|free-models-per-day/, 'no provider text or key in the ledger');
  const twice = mergeLedger(ledger, RECORD, T0 + 1000);
  assert.equal(twice.sessions.length, 1, 'the same session is not listed twice');
  assert.equal(twice.models['groq/openai/gpt-oss-120b'].completed, 2);
});

test('a measured charge on a free key opens a billing_risk breaker on that provider', () => {
  const ledger = mergeLedger(emptyLedger(), { ...RECORD, attempts: [], billing: { openrouter: { usage_before: 1.5, usage_after: 1.52, delta_usd: 0.02, verified: true } } }, T0);
  assert.equal(ledger.breakers.openrouter.last_error_class, 'billing_risk');
  assert.equal(breakerState(ledger.breakers.openrouter, T0 + 6 * 24 * 3_600_000), 'open', 'stays stopped for days, until the owner looks');
  assert.equal(ledger.providers.openrouter.billed_usd_verified, 0.02);
});

test('a per-model quota pauses that model only; an account-wide one pauses the provider (Codex, PR #685)', () => {
  const attempt = (scope) => ({ ...RECORD, attempts: [{ model: 'gemini/gemini-2.5-flash', provider: 'gemini', outcome: 'failed', exit_code: 1, error_class: 'credit_exhausted', scope }] });
  const perModel = mergeLedger(emptyLedger(), attempt('model'), T0);
  assert.ok(perModel.breakers['gemini/gemini-2.5-flash'], 'the exhausted model is paused');
  assert.equal(perModel.breakers.gemini, undefined, 'other Gemini models stay available');
  const account = mergeLedger(emptyLedger(), attempt('provider'), T0);
  assert.ok(account.breakers.gemini, 'an account-wide allowance pauses the provider');
});

test('a provider paused by a possible charge is not announced as usable, and the reason is spoken (Codex, PR #685)', () => {
  const ledger = mergeLedger(mergeLedger(null, RECORD, T0), { ...RECORD, attempts: [], billing: { openrouter: { usage_before: 1.5, usage_after: 1.52, delta_usd: 0.02, verified: true } } }, T0);
  const view = modelStatusView({ ledger, now: T0 + 60_000 });
  const or = view.providers.find((p) => p.id === 'openrouter');
  assert.equal(or.circuit, 'open');
  assert.equal(or.circuit_reason, 'billing_risk');
  const spoken = speakModelStatus(view);
  assert.doesNotMatch(spoken, /verified at no cost for coding: [^.]*OpenRouter/);
  assert.match(spoken, /OpenRouter: free, connection verified[^.]*, paused because a possible charge was detected/);
});

// ─── Status view ───
test('the status view shows verified facts only: no balance the provider did not report, no connection without a check', () => {
  const empty = modelStatusView({ ledger: null, now: T0 });
  assert.equal(empty.authorized_spend_usd, 0);
  assert.equal(empty.paid_fallback, 'disabled');
  for (const row of empty.providers) {
    assert.notEqual(row.connected, 'verified', `${row.id} is not called connected without evidence`);
    assert.equal(row.remaining_allowance_usd, null);
    assert.equal(row.billed_usd_verified, null);
    assert.equal(row.usage, 'blocked');
  }
  const view = modelStatusView({ ledger: mergeLedger(null, RECORD, T0), now: T0 + 60_000 });
  const or = view.providers.find((p) => p.id === 'openrouter');
  assert.equal(or.connected, 'verified');
  assert.equal(or.usage, 'free');
  assert.equal(or.billed_usd_verified, 0);
  assert.equal(or.allowance_note, 'Not exposed by the provider.');
  assert.equal(view.providers.find((p) => p.id === 'openai').reason, 'paid_provider_spend_not_authorized');
  const stale = modelStatusView({ ledger: mergeLedger(null, RECORD, T0), now: T0 + 8 * 24 * 3_600_000 });
  assert.equal(stale.providers.find((p) => p.id === 'openrouter').connected, 'not_verified', 'a week-old check is not a current connection');
  const spoken = speakModelStatus(view);
  assert.match(spoken, /Authorized AI spend is zero dollars, and paid fallback is off\./);
  assert.match(spoken, /finished by groq\/openai\/gpt-oss-120b/);
  assert.match(spoken, /1\. OpenRouter: free, connection verified/);
  assert.match(speakModelStatus(empty), /No provider is verified at no cost for coding yet/);
});

// ─── Runner tool (no network: fixtures) ───
const TOOL = new URL('../../tools/che_coding_zero_cost.mjs', import.meta.url).pathname;
function tool(args, { fixtures = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'che-zc-'));
  const fx = join(dir, 'fx.json');
  writeFileSync(fx, JSON.stringify(fixtures));
  const res = spawnSync(process.execPath, [TOOL, ...args.map((a) => a.replaceAll('$DIR', dir))], { encoding: 'utf8', env: { PATH: process.env.PATH, CHE_ZERO_COST_FIXTURES: fx, ...env } });
  return { ...res, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('usage before and after: unchanged usage is a verified $0; any increase exits 3 as billing_risk', () => {
  const key = (usage) => ({ 'https://openrouter.ai/api/v1/key': { status: 200, body: { data: { is_free_tier: true, usage, label: 'sk-or-v1-secretlabel' } } } });
  const before = tool(['usage', '--phase', 'before', '--dir', '$DIR'], { fixtures: key(1.25), env: { K_OPENROUTER: 'fake' } });
  assert.equal(before.status, 0);
  const after = spawnSync(process.execPath, [TOOL, 'usage', '--phase', 'after', '--dir', before.dir], { encoding: 'utf8', env: { PATH: process.env.PATH, CHE_ZERO_COST_FIXTURES: join(before.dir, 'fx.json'), K_OPENROUTER: 'fake' } });
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /billed cost for this run: \$0 \(verified/);
  writeFileSync(join(before.dir, 'fx.json'), JSON.stringify(key(1.30)));
  const charged = spawnSync(process.execPath, [TOOL, 'usage', '--phase', 'after', '--dir', before.dir], { encoding: 'utf8', env: { PATH: process.env.PATH, CHE_ZERO_COST_FIXTURES: join(before.dir, 'fx.json'), K_OPENROUTER: 'fake' } });
  assert.equal(charged.status, 3);
  assert.match(charged.stdout, /billing_risk/);
  const book = JSON.parse(readFileSync(join(before.dir, 'billing.json'), 'utf8'));
  assert.equal(book.openrouter.delta_usd, 0.05);
  assert.doesNotMatch(JSON.stringify(book) + charged.stdout, /secretlabel|fake/, 'no key or key label is stored or printed');
  before.cleanup();
});

test('the per-attempt OpenCode config pins main and small model to the same zero-cost model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'che-zc-'));
  writeFileSync(join(dir, 'base.json'), JSON.stringify({ permission: { webfetch: 'deny' } }));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ 'openrouter/qwen/qwen3-coder:free': { name: 'Qwen3 Coder (free)', context: 262144, output: 65536 } }));
  const res = spawnSync(process.execPath, [TOOL, 'config', '--base', join(dir, 'base.json'), '--model', 'openrouter/qwen/qwen3-coder:free', '--models', join(dir, 'models.json'), '--out', join(dir, 'out.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const config = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
  assert.equal(config.model, 'openrouter/qwen/qwen3-coder:free');
  assert.equal(config.small_model, 'openrouter/qwen/qwen3-coder:free', 'OpenCode never picks a cheaper (possibly paid) title model');
  assert.deepEqual(config.permission, { webfetch: 'deny' }, 'the safety permissions are kept');
  assert.deepEqual(config.provider.openrouter.models['qwen/qwen3-coder:free'], { name: 'Qwen3 Coder (free)', limit: { context: 262144, output: 65536 } });
  rmSync(dir, { recursive: true, force: true });
});
