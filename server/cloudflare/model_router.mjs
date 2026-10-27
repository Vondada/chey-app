// CHE zero-cost model router (owner rule, 2026-10-27).
//
// Authorized out-of-pocket AI spend is $0. CHE may use a model only when the request is covered
// at zero additional cost and that coverage is VERIFIED: a free model whose live price is zero on
// an account that provably cannot be charged, a credit balance the provider itself reports, or a
// free plan on which the provider blocks billing. A spending cap is a ceiling, never an
// authorization: the old "$15-capped paid last" setting is ignored here. When a provider could
// charge and nothing enforceable prevents it, the provider is excluded from automatic execution.
//
// Pure functions, no network, no secrets. The coding runner (tools/che_coding_zero_cost.mjs, a
// trusted copy taken from the base commit) gathers the evidence; the Worker (model_status.js)
// shows the same verdicts in the app. Keep this file dependency-free apart from
// coding_failover.mjs, which holds the error classes and the circuit breaker.
import { ERROR_CLASSES, breakerAfter, breakerAllows, breakerState } from './coding_failover.mjs';

export const AUTHORIZED_SPEND_USD = 0;
export const POLICIES = Object.freeze(['verified_zero_cost', 'credit_covered', 'blocked_billing_unverifiable']);
export const TASK_KINDS = Object.freeze(['coding', 'research', 'math', 'simulation']);
// A coding job tries at most this many models in one run (the record keeps them all).
export const MAX_CANDIDATES = 8;
// OpenCode's system prompt plus repository context needs a large window.
export const MIN_CONTEXT_TOKENS = 32_000;
export const RESEARCHED_AT = '2026-10-27';

// The repository variable through which the owner states, provider by provider, that the account
// is on a plan where the provider itself blocks billing (no payment method on file). It is read
// only for providers whose own terms say billing is impossible on that plan (`attestable`).
export const ATTESTATION_VARIABLE = 'CHE_CODING_FREE_PROVIDERS';

// Per-provider billing policy, from each provider's own published terms (sources checked
// 2026-10-27 through web search; the container could not open the pages themselves).
//   default_policy  the verdict before any runtime evidence
//   runtime_rule    what the runner must observe, at request time, for a verified_zero_cost verdict
//   attestable      the provider blocks billing on its free plan, so the owner's statement that the
//                   account is on that plan (no payment method) can stand in for a runtime check
//   runner          OpenCode provider id used by the coding runtime, or null when not used for coding
export const PROVIDER_POLICIES = Object.freeze([
  {
    id: 'openrouter', name: 'OpenRouter', secret: 'OPENROUTER_API_KEY', runner: 'openrouter', paid_only: false,
    default_policy: 'blocked_billing_unverifiable', attestable: false,
    runtime_rule: 'Model id ends in ":free" and its live price on GET /api/v1/models is zero for prompt, completion and request; and GET /api/v1/key proves this key cannot spend: is_free_tier is true (no credits ever bought) or limit_remaining is 0. The key\'s usage is read again after the run and any increase stops the provider (billing_risk).',
    remedy: 'If this OpenRouter account ever bought credits, set this key\'s credit limit to $0 at openrouter.ai/settings/keys so it can use only free models.',
    sources: [
      'https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key',
      'https://openrouter.ai/docs/api/reference/limits',
      'https://openrouter.ai/docs/guides/routing/model-variants/free',
      'https://openrouter.ai/docs/overview/models',
    ],
    terms: ':free variants have no per-token cost; account-wide limits of 20 requests per minute and 50 free requests per day (1,000 per day after $10 of credits were ever bought).',
  },
  {
    id: 'google', name: 'Google Gemini API', secret: 'GEMINI_API_KEY', runner: 'google', paid_only: false,
    default_policy: 'blocked_billing_unverifiable', attestable: true,
    runtime_rule: 'None available: an API key cannot reveal whether its Google Cloud project has a billing account linked. Usable only after the owner confirms the key\'s project has no Cloud Billing account (free tier).',
    remedy: 'Confirm in AI Studio that the key\'s project shows "Free tier" with no billing account, then add google to the repository variable CHE_CODING_FREE_PROVIDERS.',
    sources: ['https://ai.google.dev/gemini-api/docs/billing', 'https://discuss.ai.google.dev/t/clarification-on-gemini-api-free-tier-vs-paid-tier-after-billing-activation/96995'],
    terms: 'Free tier applies to projects without Cloud Billing; once billing is linked, all usage is charged.',
  },
  {
    id: 'groq', name: 'Groq', secret: 'GROQ_API_KEY', runner: 'groq', paid_only: false,
    default_policy: 'blocked_billing_unverifiable', attestable: true,
    runtime_rule: 'None available: the API does not report the account tier. Usable only after the owner confirms the account is on the Free plan (no payment method); over-limit requests then return 429, never a charge.',
    remedy: 'Confirm console.groq.com Settings, Billing shows the Free plan, then add groq to CHE_CODING_FREE_PROVIDERS.',
    sources: ['https://console.groq.com/docs/billing-faqs', 'https://console.groq.com/docs/rate-limits'],
    terms: 'Upgrading from Free to Developer requires a payment method; free-tier usage is not billed and over-limit requests return 429.',
  },
  {
    id: 'cerebras', name: 'Cerebras', secret: 'CEREBRAS_API_KEY', runner: 'cerebras', paid_only: false,
    default_policy: 'blocked_billing_unverifiable', attestable: true,
    runtime_rule: 'None available. Pay-as-you-go accounts can accrue a negative balance before limits apply, so only a free account with no payment method or credits may be attested.',
    remedy: 'Confirm cloud.cerebras.ai Billing has no payment method and no purchased credits, then add cerebras to CHE_CODING_FREE_PROVIDERS.',
    sources: ['https://support.cerebras.net/articles/5041581099-cerebras-self-serve-paygo-faq'],
    terms: 'Developer (pay-as-you-go) tier bills purchased credits and may charge small negative balances at period end.',
  },
  {
    id: 'mistral', name: 'Mistral', secret: 'MISTRAL_API_KEY', runner: 'mistral', paid_only: false,
    default_policy: 'blocked_billing_unverifiable', attestable: true,
    runtime_rule: 'None available. The Experiment plan needs only a verified phone number (no card); usable only after the owner confirms the workspace is on Experiment, not Scale.',
    remedy: 'Confirm console.mistral.ai shows the Experiment plan with no payment method, then add mistral to CHE_CODING_FREE_PROVIDERS.',
    sources: ['https://help.mistral.ai/en/articles/450104-how-can-i-try-the-api-for-free-with-the-experiment-plan'],
    terms: 'Experiment plan is free with a verified phone number; requests may be used for training; Scale is pay-per-use.',
  },
  {
    id: 'github', name: 'GitHub Models', secret: 'GITHUB_MODELS_TOKEN', runner: null, paid_only: false,
    default_policy: 'blocked_billing_unverifiable', attestable: true,
    runtime_rule: 'None available with a models token. Without paid usage enabled or a payment method, usage is blocked at the free quota; opted-in accounts start with a $0 budget.',
    remedy: 'Not used for coding: free per-request token limits are smaller than OpenCode\'s prompt.',
    sources: ['https://docs.github.com/en/billing/concepts/product-billing/github-models', 'https://github.blog/changelog/2025-06-24-github-models-now-supports-moving-beyond-free-limits/'],
    terms: 'Each account gets free, rate-limited usage; paid usage needs opt-in and a budget, which defaults to $0.',
  },
  {
    id: 'sambanova', name: 'SambaNova', secret: 'SAMBANOVA_API_KEY', runner: null, paid_only: false,
    default_policy: 'blocked_billing_unverifiable', attestable: true,
    runtime_rule: 'None available. Free tier applies only with no payment method linked; one 2026-08 report says new accounts must now buy credits.',
    remedy: 'Not used for coding by the OpenCode runner.',
    sources: ['https://docs.sambanova.ai/docs/en/models/rate-limits', 'https://cloud.sambanova.ai/plans'],
    terms: 'Free tier with no payment method; Developer tier once a payment method is linked; billing is moving to prepaid credits.',
  },
  {
    id: 'huggingface', name: 'Hugging Face Inference Providers', secret: 'HF_TOKEN', runner: null, paid_only: false,
    default_policy: 'blocked_billing_unverifiable', attestable: false,
    runtime_rule: 'GET https://huggingface.co/api/whoami-v2 must show a non-PRO personal account with no paying organization: free users get $0.10 a month and no pay-as-you-go.',
    remedy: 'Not used for coding: the free monthly credit ($0.10) cannot carry an agentic coding job.',
    sources: ['https://huggingface.co/docs/inference-providers/pricing'],
    terms: 'Free users $0.10/month with no pay-as-you-go; PRO $2/month then pay-as-you-go.',
  },
  {
    id: 'openai', name: 'OpenAI API', secret: 'OPENAI_API_KEY', runner: null, paid_only: true,
    default_policy: 'blocked_billing_unverifiable', attestable: false,
    runtime_rule: 'Paid per token with no free allowance that a key can prove; a ChatGPT subscription does not include API usage. Never selected while the authorized spend is $0.',
    remedy: 'Stays excluded. Only a provider-reported promotional credit balance could make it credit_covered.',
    sources: ['https://openai.com/api/pricing/', 'https://help.openai.com/en/articles/8156019'],
    terms: 'API usage is billed separately from ChatGPT plans.',
  },
  {
    id: 'anthropic', name: 'Anthropic API', secret: 'ANTHROPIC_API_KEY', runner: null, paid_only: true,
    default_policy: 'blocked_billing_unverifiable', attestable: false,
    runtime_rule: 'Prepaid credits are not readable with an inference key; a Claude subscription does not cover API usage. Never selected while the authorized spend is $0.',
    remedy: 'Stays excluded.',
    sources: ['https://docs.anthropic.com/en/api/rate-limits', 'https://support.anthropic.com/en/articles/8114526'],
    terms: 'API usage is billed per token from purchased credits, separate from Claude plans.',
  },
  {
    id: 'xai', name: 'xAI API', secret: 'XAI_API_KEY', runner: null, paid_only: true,
    default_policy: 'blocked_billing_unverifiable', attestable: false,
    runtime_rule: 'Balances are readable only with a management key, which CHE does not hold. Never selected while the authorized spend is $0.',
    remedy: 'Stays excluded.',
    sources: ['https://docs.x.ai/docs/key-information/billing'],
    terms: 'Usage is billed per token against prepaid or invoiced credits.',
  },
]);

export function providerPolicy(id) {
  return PROVIDER_POLICIES.find((p) => p.id === String(id || '').toLowerCase()) || null;
}

// The spend authorization is a constant, not configuration: no variable can raise it. Old
// settings that look like approval are reported as ignored so the status can say so.
export function spendAuthorization(env = {}) {
  const ignored = [];
  const truthy = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').trim().toLowerCase());
  if (truthy(env.CHE_CODING_PAID_FALLBACK)) ignored.push('CHE_CODING_PAID_FALLBACK=true is a capped-key setting, not a spending approval; paid fallback stays disabled.');
  if (truthy(env.CHE_ALLOW_PAID_AI)) ignored.push('CHE_ALLOW_PAID_AI does not authorize spend for coding; the owner authorized $0.');
  if (String(env.CHE_CODING_OPENROUTER_PAID_KEY || '').trim()) ignored.push('A separate capped paid OpenRouter key exists; its $15 cap is a ceiling, not an authorization, so it is never used.');
  return { authorized_usd: AUTHORIZED_SPEND_USD, paid_allowed: false, ignored };
}

export function attestedProviders(value = '') {
  return String(value || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    .filter((id) => providerPolicy(id)?.attestable === true);
}

// A price field counts as zero only when it is present and parses to exactly 0.
function zeroPrice(value) {
  if (value === undefined || value === null || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n === 0;
}

export function pricingIsZero(pricing) {
  if (!pricing || typeof pricing !== 'object') return false;
  // Prompt and completion must be listed as zero (a missing price is unknown, not free), and
  // every other listed price (request, image, web_search, reasoning, cache) must be zero too.
  if (!zeroPrice(pricing.prompt) || !zeroPrice(pricing.completion)) return false;
  return Object.values(pricing).every((v) => v === undefined || v === null || v === '' || zeroPrice(v));
}

// The OpenRouter key guard: the key provably cannot spend money.
export function openRouterKeyGuard(key) {
  const data = key && typeof key === 'object' ? key : null;
  if (!data) return { ok: false, reason: 'key_status_unreadable' };
  if (data.is_management_key || data.is_provisioning_key) return { ok: false, reason: 'management_key' };
  if (data.is_free_tier === true) return { ok: true, guard: 'free_tier_account' };
  const remaining = data.limit_remaining;
  if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining <= 0 && data.limit !== null && data.limit !== undefined) {
    return { ok: true, guard: 'key_limit_zero' };
  }
  return { ok: false, reason: 'key_can_spend_credits' };
}

// Only the numeric and boolean status fields; never the label or any key text.
export function openRouterKeySummary(key) {
  const data = key && typeof key === 'object' ? key : {};
  const out = {};
  for (const name of ['is_free_tier', 'limit', 'limit_remaining', 'limit_reset', 'usage', 'usage_daily', 'usage_monthly', 'include_byok_in_limit', 'byok_usage']) {
    const v = data[name];
    if (typeof v === 'number' || typeof v === 'boolean' || v === null || (name === 'limit_reset' && typeof v === 'string')) out[name] = v;
  }
  return out;
}

// One provider's verdict from the evidence the runner gathered. `evidence` shape:
//   { key_present, auth: { ok, status }, openrouter_key: {...data}, whoami: {...} }
export function providerVerdict(id, { evidence = {}, attested = [], now = Date.now() } = {}) {
  const policy = providerPolicy(id);
  const at = new Date(now).toISOString();
  if (!policy) return { id, policy: 'blocked_billing_unverifiable', coverage: 'blocked', connected: 'unknown', reason: 'unknown_provider', at };
  const base = { id, name: policy.name, at, verification: 'none' };
  const keyPresent = evidence.key_present === true;
  const auth = evidence.auth || {};
  const connected = !keyPresent ? 'not_configured' : auth.ok === true ? 'verified' : auth.status === 401 || auth.status === 403 ? 'auth_failure' : 'not_verified';
  if (policy.paid_only) return { ...base, policy: 'blocked_billing_unverifiable', coverage: 'blocked', connected, reason: 'paid_provider_spend_not_authorized' };
  if (!keyPresent) return { ...base, policy: policy.default_policy, coverage: 'blocked', connected, reason: 'no_key' };
  if (id === 'openrouter') {
    if (auth.ok !== true) return { ...base, policy: 'blocked_billing_unverifiable', coverage: 'blocked', connected, reason: connected === 'auth_failure' ? 'auth_failure' : 'key_status_unreadable' };
    const guard = openRouterKeyGuard(evidence.openrouter_key);
    const summary = openRouterKeySummary(evidence.openrouter_key);
    if (!guard.ok) return { ...base, policy: 'blocked_billing_unverifiable', coverage: 'blocked', connected, reason: guard.reason, key_status: summary, remedy: policy.remedy };
    return { ...base, policy: 'verified_zero_cost', coverage: 'free', connected, verification: 'runtime', guard: guard.guard, key_status: summary };
  }
  if (id === 'huggingface') {
    const who = evidence.whoami;
    if (auth.ok !== true || !who) return { ...base, policy: 'blocked_billing_unverifiable', coverage: 'blocked', connected, reason: 'account_unreadable' };
    const payingOrg = Array.isArray(who.orgs) && who.orgs.some((o) => o && (o.isEnterprise || o.plan && o.plan !== 'free'));
    if (who.isPro === false && !payingOrg) return { ...base, policy: 'verified_zero_cost', coverage: 'free', connected, verification: 'runtime', guard: 'free_account_no_payg' };
    return { ...base, policy: 'blocked_billing_unverifiable', coverage: 'blocked', connected, reason: 'account_can_pay_as_you_go' };
  }
  if (policy.attestable && attested.includes(id)) {
    // The owner's statement stands in for a check the API cannot make. A billing signal at run
    // time (402, payment text) still classifies billing_risk and opens this provider's breaker.
    if (connected === 'auth_failure') return { ...base, policy: 'blocked_billing_unverifiable', coverage: 'blocked', connected, reason: 'auth_failure' };
    return { ...base, policy: 'verified_zero_cost', coverage: 'free', connected, verification: 'owner_attested', guard: 'free_plan_no_payment_method' };
  }
  return { ...base, policy: 'blocked_billing_unverifiable', coverage: 'blocked', connected, reason: 'billing_unverifiable', remedy: policy.remedy };
}

// Whether one model may run, given its provider's verdict. A model is never eligible on a
// blocked provider; an OpenRouter model must also be a live zero-price :free variant.
// Models a provider retired (HTTP 404 on 2026-10-17; PR #628): never ranked, however a list is filtered.
export const RETIRED_MODELS = Object.freeze([/llama-3\.3/i]);

export function modelEligibility(model, verdict) {
  const id = String(model?.id || '');
  if (!verdict || verdict.coverage === 'blocked') return { eligible: false, reason: verdict?.reason || 'provider_blocked' };
  if (RETIRED_MODELS.some((pattern) => pattern.test(id))) return { eligible: false, reason: 'retired_by_provider' };
  if (verdict.id === 'openrouter') {
    if (!/:free$/.test(id)) return { eligible: false, reason: 'not_free_variant' };
    if (!pricingIsZero(model.pricing)) return { eligible: false, reason: 'live_price_not_zero' };
  }
  if (model.supports_tools === false) return { eligible: false, reason: 'no_tool_calling' };
  if (Number(model.context_length) > 0 && Number(model.context_length) < MIN_CONTEXT_TOKENS) return { eligible: false, reason: 'context_too_small' };
  return { eligible: true, coverage: verdict.coverage };
}

// ─── Capability ranking ───
// The most capable eligible model first, per task kind. Free does not mean weak: the table
// ranks open frontier models (Qwen3 Coder 480B, Kimi K2, DeepSeek, GLM, gpt-oss-120b) above
// small ones. Unknown families score in the middle and are ranked by size and context.
const FAMILY_SCORES = [
  // pattern,                                    coding research math
  [/qwen3[-.]?coder|qwen-?3-?coder/i,            100, 80, 82],
  [/kimi-?k2/i,                                    95, 92, 88],
  [/deepseek-(?:v3|chat|v4)/i,                     92, 88, 88],
  [/deepseek-r1|deepseek-reason/i,                 84, 95, 98],
  [/glm-?(?:4\.[5-9]|5)/i,                         90, 86, 86],
  [/gpt-oss-120b/i,                                88, 88, 92],
  [/qwen3[.-]?\d*-?2\d\db|qwen3-max|qwen3\.\d/i,   86, 90, 92],
  [/devstral|codestral/i,                          84, 60, 60],
  [/gemini-[\d.]+-pro/i,                           88, 92, 92],
  [/gemini-[\d.]+-flash/i,                         80, 84, 84],
  [/llama-4-maverick/i,                            78, 80, 74],
  [/mistral-(?:large|medium)/i,                    76, 78, 74],
  [/minimax|hunyuan|ernie/i,                       74, 76, 74],
  [/qwen3/i,                                       70, 72, 76],
  [/gpt-oss-20b/i,                                 60, 62, 70],
  [/llama/i,                                       55, 58, 52],
];

// Which listed models of an owner-attested provider can do agentic coding on its free plan. From
// real runs: Gemini Pro and preview models had no free quota (2026-10-17, ocr-8e7f69c5) and Lite
// models lack the capacity; Groq's Llama 3.3 was retired (404, PR #628).
const LISTING_FILTERS = Object.freeze({
  google: { keep: /flash/i, drop: /preview|exp|image|tts|live|lite/i },
  groq: { keep: /gpt-oss|qwen|kimi/i, drop: /guard|[-_.]8b|llama-3\.3/i },
  cerebras: { keep: /coder|qwen|gpt-oss|glm/i, drop: /[-_.]8b/i },
  mistral: { keep: /codestral|devstral|mistral-(?:large|medium)/i, drop: /embed|moderation/i },
});

export function listedModelUsable(provider, id) {
  const rule = LISTING_FILTERS[provider];
  const name = String(id || '');
  if (/embed|guard|audio|tts|whisper|moderation/i.test(name)) return false;
  if (!rule) return true;
  return rule.keep.test(name) && !rule.drop.test(name);
}

export function taskKind(request = '') {
  const text = String(request || '');
  if (/\bsimulat|monte carlo|physics model|digital twin\b/i.test(text)) return 'simulation';
  if (/\b(?:prove|theorem|equation|integral|derivative|probability|algebra|calculus|math(?:ematics)?)\b/i.test(text) && !/\b(?:test|refactor|fix|bug|implement)\b/i.test(text)) return 'math';
  if (/\b(?:research|investigate|compare sources|literature|survey|cite)\b/i.test(text) && !/\b(?:implement|fix|refactor|add|change|test)\b/i.test(text)) return 'research';
  return 'coding';
}

export function capabilityScore(model, kind = 'coding') {
  const id = String(model?.id || '');
  const column = kind === 'research' ? 2 : kind === 'math' ? 3 : 1;
  let score = 50;
  for (const row of FAMILY_SCORES) {
    if (row[0].test(id)) { score = kind === 'simulation' ? Math.round((row[1] + row[3]) / 2) : row[column]; break; }
  }
  const size = Number((id.match(/(\d{2,4})b\b/i) || [])[1]) || 0;
  if (size) score += Math.min(8, Math.round(Math.log2(size)));
  const ctx = Number(model?.context_length) || 0;
  if (ctx >= 128_000) score += 3;
  if (/preview|exp(?:erimental)?\b/i.test(id)) score -= 4;
  return score;
}

// The ordered plan for one run: eligible models, best first, without open breakers. A model
// whose breaker is half-open gets one trial after every closed one.
export function planCandidates({ models = [], verdicts = {}, kind = 'coding', ledger = {}, now = Date.now(), limit = MAX_CANDIDATES } = {}) {
  const breakers = ledger?.breakers || {};
  const excluded = [];
  const ranked = [];
  const seen = new Set();
  for (const model of models) {
    const id = String(model?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const provider = String(model.provider || id.split('/')[0]);
    const verdict = verdicts[provider];
    const verdictEligibility = modelEligibility(model, verdict);
    if (!verdictEligibility.eligible) { excluded.push({ model: id, provider, reason: verdictEligibility.reason }); continue; }
    const providerBreaker = breakers[provider];
    const modelBreaker = breakers[id];
    if (!breakerAllows(providerBreaker, now) || !breakerAllows(modelBreaker, now)) {
      excluded.push({ model: id, provider, reason: `circuit_open:${(modelBreaker && !breakerAllows(modelBreaker, now) ? modelBreaker : providerBreaker).last_error_class || 'failures'}` });
      continue;
    }
    const trial = breakerState(providerBreaker, now) === 'half_open' || breakerState(modelBreaker, now) === 'half_open';
    ranked.push({ model: id, provider, coverage: verdictEligibility.coverage, verification: verdict.verification, score: capabilityScore(model, kind), trial });
  }
  ranked.sort((a, b) => (a.trial - b.trial) || (b.score - a.score) || a.model.localeCompare(b.model));
  return { kind, candidates: ranked.slice(0, limit), excluded: excluded.slice(0, 40) };
}

// ─── Ledger ───
// One small file on che-mailbox (mailbox/runtime/model-ledger.json) that every run updates:
// per model and provider, coding attempts completed and failed, the last error class, the
// circuit breakers, the latest provider verdicts and the verified billed cost. It holds no
// error text and no secrets. The runner reads it to skip open breakers; the app shows it.
export function emptyLedger() {
  return { version: 1, updated_at: null, models: {}, providers: {}, breakers: {}, verdicts: {}, sessions: [] };
}

export function mergeLedger(ledger, record, now = Date.now()) {
  const next = ledger && typeof ledger === 'object' && ledger.version === 1 ? JSON.parse(JSON.stringify(ledger)) : emptyLedger();
  const at = new Date(now).toISOString();
  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  for (const attempt of attempts) {
    const model = String(attempt?.model || '').slice(0, 120);
    if (!model) continue;
    const provider = String(attempt.provider || model.split('/')[0]);
    const ok = attempt.outcome === 'success' || Number(attempt.exit_code) === 0;
    const errorClass = ERROR_CLASSES.includes(attempt.error_class) ? attempt.error_class : (ok ? null : 'task_failure');
    for (const [bucket, key] of [['models', model], ['providers', provider]]) {
      const row = next[bucket][key] || { completed: 0, failed: 0, last_error_class: null, last_used_at: null, last_ok_at: null };
      if (ok) { row.completed += 1; row.last_ok_at = at; } else { row.failed += 1; row.last_error_class = errorClass; }
      row.last_used_at = at;
      next[bucket][key] = row;
    }
    // The receipt's own scope wins: a per-model quota (Gemini, Groq) pauses that model only.
    const scoped = attempt.scope === 'model' ? model : attempt.scope === 'provider' ? provider : null;
    const decisionScope = scoped || (errorClass && ['auth_failure', 'credit_exhausted', 'billing_risk'].includes(errorClass) ? provider : model);
    if (ok) {
      next.breakers[model] = breakerAfter(next.breakers[model], { ok: true, now });
      if (next.breakers[provider]) next.breakers[provider] = breakerAfter(next.breakers[provider], { ok: true, now });
    } else {
      next.breakers[decisionScope] = breakerAfter(next.breakers[decisionScope], { ok: false, errorClass, now });
    }
  }
  const routing = record?.routing && typeof record.routing === 'object' ? record.routing : {};
  if (routing.verdicts && typeof routing.verdicts === 'object') {
    for (const [id, verdict] of Object.entries(routing.verdicts)) {
      if (providerPolicy(id) && verdict && typeof verdict === 'object') next.verdicts[id] = { ...verdict };
    }
  }
  const billing = record?.billing && typeof record.billing === 'object' ? record.billing : {};
  for (const [id, row] of Object.entries(billing)) {
    if (!providerPolicy(id) || !row || typeof row !== 'object') continue;
    const prior = next.providers[id] || { completed: 0, failed: 0, last_error_class: null, last_used_at: null, last_ok_at: null };
    if (row.verified === true && typeof row.delta_usd === 'number') {
      prior.billed_usd_verified = Math.round(((Number(prior.billed_usd_verified) || 0) + row.delta_usd) * 1e6) / 1e6;
      prior.billing_checked_at = at;
    }
    if (row.verified === true && row.delta_usd > 0) {
      next.breakers[id] = breakerAfter(next.breakers[id], { ok: false, errorClass: 'billing_risk', now });
    }
    next.providers[id] = prior;
  }
  if (record?.session_id) {
    next.sessions = [{
      session_id: String(record.session_id).slice(0, 20), state: String(record.state || '').slice(0, 30),
      completed_by_model: record.completed_by_model || null, attempts: attempts.length, at,
    }, ...(Array.isArray(next.sessions) ? next.sessions : []).filter((s) => s?.session_id !== record.session_id)].slice(0, 20);
  }
  next.updated_at = at;
  return next;
}

// ─── Status for the app ───
// One row per provider. Nothing is called connected without a verified check, no balance or
// limit is shown unless the provider reported it, and a cost is shown only when it was measured.
export function modelStatusView({ ledger = null, workerKeys = {}, now = Date.now(), env = {} } = {}) {
  const book = ledger && ledger.version === 1 ? ledger : emptyLedger();
  const auth = spendAuthorization(env);
  const providers = PROVIDER_POLICIES.map((policy) => {
    const verdict = book.verdicts?.[policy.id] || null;
    const usage = book.providers?.[policy.id] || null;
    const breaker = book.breakers?.[policy.id] || null;
    const models = Object.entries(book.models || {}).filter(([id]) => id.split('/')[0] === (policy.runner || policy.id));
    const lastOk = models.map(([id, row]) => ({ id, at: row.last_ok_at })).filter((m) => m.at).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    const verifiedAt = verdict?.at || null;
    const fresh = verifiedAt && now - Date.parse(verifiedAt) <= 7 * 24 * 60 * 60_000;
    const blocked = policy.paid_only || !verdict || verdict.coverage === 'blocked';
    const usageState = policy.paid_only ? 'blocked' : !verdict ? 'blocked' : verdict.coverage === 'free' ? 'free' : verdict.coverage === 'credit_covered' ? 'credit_covered' : 'blocked';
    const keyStatus = verdict?.key_status || null;
    const remaining = keyStatus && typeof keyStatus.limit_remaining === 'number' ? keyStatus.limit_remaining : null;
    return {
      id: policy.id,
      name: policy.name,
      policy: verdict?.policy || policy.default_policy,
      usage: usageState,
      connected: verdict?.connected === 'verified' && fresh ? 'verified' : verdict?.connected === 'auth_failure' ? 'auth_failure' : 'not_verified',
      verification: verdict?.verification || 'none',
      verified_at: verifiedAt,
      used_for_coding: Boolean(policy.runner) && !policy.paid_only,
      current_model: lastOk?.id || null,
      remaining_allowance_usd: remaining,
      allowance_note: remaining !== null ? 'Reported by the provider for this key.' : 'Not exposed by the provider.',
      requests_completed: Number(usage?.completed || 0),
      failed_attempts: Number(usage?.failed || 0),
      last_error_class: usage?.last_error_class || null,
      billed_usd_verified: typeof usage?.billed_usd_verified === 'number' ? usage.billed_usd_verified : null,
      circuit: breaker ? breakerState(breaker, now) : 'closed',
      circuit_reason: breaker && breakerState(breaker, now) === 'open' ? breaker.last_error_class || null : null,
      reason: blocked ? (policy.paid_only ? 'paid_provider_spend_not_authorized' : verdict?.reason || 'not_checked_yet') : null,
      rule: policy.runtime_rule,
      remedy: blocked ? policy.remedy : null,
      terms: policy.terms,
      sources: policy.sources,
      worker_key_present: Boolean(workerKeys?.[policy.id]),
    };
  });
  const last = (book.sessions || [])[0] || null;
  return {
    researched_at: RESEARCHED_AT,
    authorized_spend_usd: auth.authorized_usd,
    paid_fallback: 'disabled',
    ignored_settings: auth.ignored,
    updated_at: book.updated_at,
    last_session: last,
    providers,
  };
}

// Spoken summary of the status, for Read Aloud. Short sentences, numbered providers.
export function speakModelStatus(view) {
  const rows = Array.isArray(view?.providers) ? view.providers : [];
  // A provider with an open circuit is skipped by planCandidates, so it is not announced as usable.
  const usable = rows.filter((r) => r.usage !== 'blocked' && r.used_for_coding && r.circuit !== 'open');
  const parts = [`Authorized AI spend is ${Number(view?.authorized_spend_usd) === 0 ? 'zero dollars' : `$${view.authorized_spend_usd}`}, and paid fallback is off.`];
  parts.push(usable.length
    ? `${usable.length} provider${usable.length === 1 ? ' is' : 's are'} verified at no cost for coding: ${usable.map((r) => r.name).join(', ')}.`
    : 'No provider is verified at no cost for coding yet, so coding jobs stop and report instead of spending.');
  if (view?.last_session?.completed_by_model) parts.push(`The last coding job was finished by ${view.last_session.completed_by_model}.`);
  else if (view?.last_session) parts.push(`The last coding job ended ${String(view.last_session.state || 'without a result').replace(/_/g, ' ')}, with no model finishing it.`);
  rows.forEach((r, i) => {
    const use = r.usage === 'free' ? 'free' : r.usage === 'credit_covered' ? 'covered by credits' : 'blocked';
    const conn = r.connected === 'verified' ? 'connection verified' : r.connected === 'auth_failure' ? 'key rejected' : 'connection not verified';
    const counts = r.requests_completed || r.failed_attempts ? `, ${r.requests_completed} completed and ${r.failed_attempts} failed attempts` : '';
    const paused = r.circuit !== 'open' ? ''
      : (r.circuit_reason || r.last_error_class) === 'billing_risk' ? ', paused because a possible charge was detected; check its billing before using it again'
        : `, paused after ${String(r.circuit_reason || r.last_error_class || 'repeated failures').replace(/_/g, ' ')}`;
    parts.push(`${i + 1}. ${r.name}: ${use}, ${conn}${counts}${paused}.`);
  });
  return parts.join(' ');
}
