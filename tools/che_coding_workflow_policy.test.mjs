import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('      - name: Resolve model');
const stop = workflow.indexOf('\n      - name: ', start + 10) + 1;
assert.ok(start > 0 && stop > start);
const modelBlock = workflow.slice(start, stop);
const scriptMatch = modelBlock.match(/        run: \|\n([\s\S]*)$/);
assert.ok(scriptMatch);
const script = scriptMatch[1].split('\n').map(x => x.startsWith('          ') ? x.slice(10) : x).join('\n');

const ROOT = new URL('..', import.meta.url).pathname;
const FREE_PRICE = { prompt: '0', completion: '0', request: '0', image: '0' };
const PAID_PRICE = { prompt: '0.0000004', completion: '0.0000016', request: '0' };
const orModel = (id, pricing, extra = {}) => ({ id, name: id, pricing, context_length: 131072, supported_parameters: ['tools', 'temperature'], top_provider: { max_completion_tokens: 32768 }, ...extra });
const LIVE_MODELS = [
  orModel('qwen/qwen3.8-27b:free', FREE_PRICE),
  orModel('qwen/qwen3-coder:free', FREE_PRICE, { context_length: 262144 }),
  orModel('moonshotai/kimi-k2:free', FREE_PRICE),
  orModel('openai/gpt-oss-120b:free', FREE_PRICE),
  orModel('meta-llama/llama-3.2-3b-instruct:free', FREE_PRICE, { context_length: 16384 }),
  orModel('some/no-tools:free', FREE_PRICE, { supported_parameters: ['temperature'] }),
  orModel('sneaky/priced:free', PAID_PRICE),
  orModel('qwen/qwen3-coder', PAID_PRICE),
  orModel('deepseek/deepseek-chat', PAID_PRICE),
];

function plan({ paid = false, requested = 'auto', freeProviders = '', key = { is_free_tier: true, limit: null, limit_remaining: null, usage: 0 }, keyStatus = 200, models = LIVE_MODELS, listings = {}, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'che-coding-test-'));
  try {
    const bin = join(dir, 'opencode');
    const listing = { google: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash'], groq: ['groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b'], ...listings };
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = "models" ] || exit 1\ncase "$2" in\n' +
      Object.entries(listing).map(([k, v]) => `  ${k}) printf '%s\\n' ${v.map(s => "'" + s + "'").join(' ')};;`).join('\n') +
      '\n  *) exit 1;;\nesac\n');
    chmodSync(bin, 0o755);
    const fixtures = join(dir, 'fixtures.json');
    writeFileSync(fixtures, JSON.stringify({
      'https://openrouter.ai/api/v1/key': { status: keyStatus, body: { data: key } },
      'https://openrouter.ai/api/v1/models': { status: 200, body: { data: models } },
      'https://generativelanguage.googleapis.com/v1beta/openai/models': { status: 200, body: { data: [] } },
      'https://api.groq.com/openai/v1/models': { status: 200, body: { data: [] } },
    }));
    writeFileSync(join(dir, 'che-runtime-prompt.txt'), 'OWNER REQUEST:\nAdd one unit test for the pure function slugify.');
    const out = join(dir, 'outputs');
    writeFileSync(out, '');
    const stdout = execFileSync('bash', ['-c', 'set -e;\n' + script], {
      env: { ...process.env, PATH: dir + ':' + process.env.PATH,
        GITHUB_OUTPUT: out, REQUESTED: requested, RUNNER_TEMP: dir, CHE_TRUSTED_TOOLS: ROOT,
        CHE_ZERO_COST_FIXTURES: fixtures,
        CHE_CODING_FREE_PROVIDERS: freeProviders,
        CHE_CODING_PAID_FALLBACK: String(paid),
        K_OPENROUTER: 'fake-free-key', K_GOOGLE: 'fake-google', K_GROQ: 'fake-groq',
        ...extraEnv,
      }, encoding: 'utf8', stdio: 'pipe',
    });
    const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map(x => {
      const pos = x.indexOf('='); return [x.slice(0,pos),x.slice(pos+1)];
    }));
    const routing = JSON.parse(readFileSync(join(dir, 'che-route', 'routing.json'), 'utf8'));
    return { ...outputs, routing, stdout, list: String(outputs.free_candidates || '').split(' ').filter(Boolean) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the most capable live zero-price :free models come first; priced, tool-less and tiny models never appear', () => {
  const p = plan();
  assert.equal(p.list[0], 'openrouter/qwen/qwen3-coder:free', 'Qwen3 Coder ranks first for coding');
  assert.ok(p.list.includes('openrouter/moonshotai/kimi-k2:free'));
  assert.ok(p.list.includes('openrouter/qwen/qwen3.8-27b:free'), 'the old single candidate is still there, just not alone');
  assert.ok(p.list.length >= 4, `several models to fail over to, got ${p.list.length}`);
  for (const bad of ['sneaky/priced:free', 'llama-3.2-3b', 'no-tools', 'qwen/qwen3-coder ', 'deepseek-chat']) {
    assert.ok(!p.list.some((m) => (m + ' ').includes(bad)), `${bad} must not be planned`);
  }
  assert.equal(p.paid_candidates, '');
  const reasons = Object.fromEntries(p.routing.excluded.map((e) => [e.model, e.reason]));
  assert.equal(reasons['openrouter/sneaky/priced:free'], 'live_price_not_zero');
  assert.equal(reasons['openrouter/qwen/qwen3-coder'], 'not_free_variant');
  assert.equal(reasons['openrouter/some/no-tools:free'], 'no_tool_calling');
  assert.equal(reasons['openrouter/meta-llama/llama-3.2-3b-instruct:free'], 'context_too_small');
});

test('paid fallback is never planned, and a "$15 cap" setting is reported as ignored, not treated as approval', () => {
  const p = plan({ paid: true, extraEnv: { CHE_CODING_OPENROUTER_PAID_KEY: 'fake-paid' } });
  assert.equal(p.paid_candidates, '');
  assert.equal(p.routing.authorized_spend_usd, 0);
  assert.equal(p.routing.paid_fallback, 'disabled');
  assert.ok(p.routing.ignored_settings.some((n) => /not a spending approval/.test(n)));
  assert.ok(p.list.every((m) => m.endsWith(':free')));
});

test('unverified external providers are not automatically considered free', () => {
  const p = plan();
  assert.doesNotMatch(p.free_candidates, /google\/|groq\//);
  assert.equal(p.routing.verdicts.google.policy, 'blocked_billing_unverifiable');
  assert.equal(p.routing.verdicts.groq.reason, 'billing_unverifiable');
});

test('an owner-attested free-plan provider is used, and expensive Pro models still rank by capability, not price', () => {
  const p = plan({ freeProviders: 'groq,google,openai' });
  assert.match(p.free_candidates, /groq\/openai\/gpt-oss-120b/);
  assert.equal(p.routing.verdicts.groq.verification, 'owner_attested');
  assert.deepEqual(p.routing.attested, ['groq', 'google'], 'a paid-only provider cannot be attested');
});

test('an OpenRouter key that can spend purchased credits blocks OpenRouter entirely', () => {
  const p = plan({ key: { is_free_tier: false, limit: null, limit_remaining: null, usage: 3.2 } });
  assert.equal(p.free_candidates, '');
  assert.equal(p.routing.verdicts.openrouter.reason, 'key_can_spend_credits');
  assert.match(p.stdout, /No model is verified at zero cost/);
});

test('a key limited to $0 is a provider-enforced guard, so its free models run', () => {
  const p = plan({ key: { is_free_tier: false, limit: 0, limit_remaining: 0, usage: 3.2 } });
  assert.equal(p.routing.verdicts.openrouter.guard, 'key_limit_zero');
  assert.match(p.free_candidates, /:free/);
});

test('an unreadable key status (auth failure or network) is never treated as connected or free', () => {
  for (const status of [401, 0]) {
    const p = plan({ keyStatus: status });
    assert.equal(p.free_candidates, '');
    assert.notEqual(p.routing.verdicts.openrouter.connected, 'verified');
  }
});

test('an explicitly requested model goes first only when it is itself eligible', () => {
  assert.equal(plan({ requested: 'openrouter/openai/gpt-oss-120b:free' }).list[0], 'openrouter/openai/gpt-oss-120b:free');
  const paid = plan({ requested: 'openrouter/qwen/qwen3-coder' });
  assert.ok(!paid.list.includes('openrouter/qwen/qwen3-coder'));
  assert.ok(paid.routing.notes.some((n) => /not verified at zero cost/.test(n)));
});

test('an open circuit breaker keeps a failing model out of the plan', () => {
  const dirLedger = { version: 1, breakers: { 'openrouter/qwen/qwen3.8-27b:free': { state: 'open', failures: 3, last_error_class: 'provider_unavailable', until: '2999-01-01T00:00:00Z' } } };
  const p = plan();
  assert.ok(p.list.includes('openrouter/qwen/qwen3.8-27b:free'));
  // Same plan with the ledger in place.
  const dir = mkdtempSync(join(tmpdir(), 'che-ledger-'));
  try {
    writeFileSync(join(dir, 'che-model-ledger.json'), JSON.stringify(dirLedger));
    const q = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { planCandidates, providerVerdict } from '${ROOT}server/cloudflare/model_router.mjs';
      const verdicts = { openrouter: providerVerdict('openrouter', { evidence: { key_present: true, auth: { ok: true, status: 200 }, openrouter_key: { is_free_tier: true } } }) };
      const models = [{ id: 'openrouter/qwen/qwen3.8-27b:free', pricing: { prompt: '0', completion: '0' }, context_length: 131072, supports_tools: true }, { id: 'openrouter/openai/gpt-oss-120b:free', pricing: { prompt: '0', completion: '0' }, context_length: 131072, supports_tools: true }];
      const out = planCandidates({ models, verdicts, ledger: ${JSON.stringify(dirLedger)} });
      process.stdout.write(JSON.stringify(out));`], { encoding: 'utf8' });
    const out = JSON.parse(q);
    assert.deepEqual(out.candidates.map((c) => c.model), ['openrouter/openai/gpt-oss-120b:free']);
    assert.equal(out.excluded[0].reason, 'circuit_open:provider_unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime checks monthly key cap immediately before paid model execution', () => {
  assert.match(workflow, /node "\$CHE_TRUSTED_TOOLS\/tools\/che_coding_paid_gate\.mjs"/);
  assert.match(workflow, /for m in \$FREE_CANDIDATES;/);
  assert.match(workflow, /for m in \$PAID_CANDIDATES;/);
  assert.match(workflow, /Run capped paid OpenRouter only after free attempts/);
  assert.match(workflow, /CHE_CODING_OPENROUTER_PAID_KEY/);
  assert.doesNotMatch(workflow, /CHE_ALLOW_PAID_MODELS/);
  assert.match(workflow, /remaining - 180/);
  // Owner rule 2026-10-27: the plan never lists a paid model and the step refuses without code-level authorization.
  assert.match(workflow, /Paid coding fallback is disabled: the owner authorized/);
  const resolve = workflow.slice(workflow.indexOf('      - name: Resolve model'), workflow.indexOf('      - name: Fetch the verified checkpoint'));
  assert.doesNotMatch(resolve, /CHE_CODING_OPENROUTER_PAID_KEY|K_PAID_OPENROUTER|K_OPENAI|K_ANTHROPIC/, 'no paid key reaches model planning');
});

test('the workflow resume limit is the same number the failover policy uses', async () => {
  const { RESUME_LIMIT } = await import('../server/cloudflare/coding_failover.mjs');
  const declared = workflow.match(/const MAX_RESUMES = (\d+);/);
  assert.ok(declared, 'the claim step declares MAX_RESUMES');
  assert.equal(Number(declared[1]), RESUME_LIMIT);
});

test('a failed model that changed files is checkpointed or reverted, never silently passed on', () => {
  assert.match(workflow, /node "\$CHE_TRUSTED_TOOLS\/tools\/che_coding_checkpoint\.mjs" advance/);
  assert.doesNotMatch(workflow, /A model that already edited files is not retried on another model/);
  assert.match(workflow, /BASE_SHA: \$\{\{ inputs\.base_sha \}\}/);
  assert.match(workflow, /Checkout the exact base this session was dispatched for/);
});

test('the runner decides paid use only with a trusted gate, copied from the base before any attempt', () => {
  assert.match(workflow, /Stage trusted coding tools/);
  assert.match(workflow, /cp tools\/che_coding_paid_gate\.mjs tools\/che_coding_checkpoint\.mjs "\$trust\/tools\/"/);
  assert.match(workflow, /CHE_TRUSTED_TOOLS=\$trust/);
  assert.doesNotMatch(workflow, /node tools\/che_coding_paid_gate\.mjs/);
  assert.doesNotMatch(workflow, /node tools\/che_coding_checkpoint\.mjs/);
});

test('the paid key is absent from the free coding step and is gated in a separate step', () => {
  const start = workflow.indexOf('- name: Run OpenCode in the isolated checkout');
  const paid = workflow.indexOf('- name: Run capped paid OpenRouter only after free attempts');
  const result = workflow.indexOf('- name: Build compact result and patch');
  assert.ok(start >= 0 && paid > start && result > paid);
  const freeStep = workflow.slice(start, paid);
  const paidStep = workflow.slice(paid, result);
  assert.doesNotMatch(freeStep, /K_PAID_OPENROUTER: \$\{\{ secrets\./);
  assert.doesNotMatch(freeStep, /paid_key="\$K_PAID_OPENROUTER"/);
  assert.match(freeStep, /for m in \$FREE_CANDIDATES;/);
  assert.match(paidStep, /K_PAID_OPENROUTER: \$\{\{ secrets\.CHE_CODING_OPENROUTER_PAID_KEY \}\}/);
  assert.match(paidStep, /steps\.opencode\.outputs\.exit_code != '0'/);
  assert.match(paidStep, /vars\.CHE_CODING_PAID_FALLBACK == 'true'/);
  assert.match(paidStep, /paid_key="\$K_PAID_OPENROUTER"; unset K_PAID_OPENROUTER/);
  assert.match(paidStep, /node "\$CHE_TRUSTED_TOOLS\/tools\/che_coding_paid_gate\.mjs"/);
});

test('the claim job passes the resume count to the runtime job (the resume could never start without it)', () => {
  const claim = workflow.slice(workflow.indexOf('  claim:'), workflow.indexOf('  runtime:'));
  assert.match(claim, /resume_count: \$\{\{ steps\.claim\.outputs\.resume_count \}\}/);
  assert.match(workflow, /fromJSON\(needs\.claim\.outputs\.resume_count \|\| '0'\) > 0/);
});

test('only an implemented session becomes a patch and a PR; a blocked one keeps only its checkpoint', () => {
  assert.match(workflow, /const patch = state === 'implemented' \? git\('diff', '--no-renames', '--binary'\) : '';/);
  assert.match(workflow, /--diff-filter=ACMRD'\)\.split\('\\0'\)/);
});

test('a failed source baseline stops every attempt, so a revert can never delete files it should keep', () => {
  assert.match(workflow, /Could not record the source baseline, so no attempt will run/);
  assert.match(workflow, /\[ -z "\$baseline_failed" \] \|\| break/);
});

test('a revert that fails stops the attempts instead of continuing on a dirty tree', () => {
  assert.match(workflow, /verdict_rc=\$\?/);
  assert.match(workflow, /"\$verdict_rc" = 2/);
});

test('the paid-model switch no longer reaches autopilot, which uses only free OpenRouter models with the main key', () => {
  const autopilot = readFileSync(new URL('../.github/workflows/che-autopilot.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(autopilot, /CHE_ALLOW_PAID_MODELS/);
  assert.match(autopilot, /if \[ "\$provider" = openrouter \]; then list=\$\(printf/);
});

test('the key-check and gate pass the owner\'s BYOK confirmation, and only as a repository variable', () => {
  assert.match(workflow, /CHE_CODING_OPENROUTER_NO_BYOK: \$\{\{ vars\.CHE_CODING_OPENROUTER_NO_BYOK \}\}/);
  const check = readFileSync(new URL('../.github/workflows/che-coding-key-check.yml', import.meta.url), 'utf8');
  assert.match(check, /CHE_CODING_OPENROUTER_NO_BYOK: \$\{\{ vars\.CHE_CODING_OPENROUTER_NO_BYOK \}\}/);
});

test('a re-delivery reuses the open PR for the branch instead of opening a second one', () => {
  const deliver = workflow.slice(workflow.indexOf('\n  deliver:\n'), workflow.indexOf('\n  publish:\n'));
  const reuse = deliver.indexOf('gh pr list --head "$TARGET_BRANCH"');
  const create = deliver.indexOf('gh pr create');
  assert.ok(reuse > 0 && create > reuse, 'the open-PR check runs before any create');
  assert.match(deliver, /echo "pr_number=\$\{existing\}" >> "\$GITHUB_OUTPUT"\n\s+exit 0/);
});

test('the router and its evidence tool run from the trusted base copy, and the ledger is written after the record', () => {
  assert.match(workflow, /cp tools\/che_coding_zero_cost\.mjs "\$trust\/tools\/" && cp server\/cloudflare\/model_router\.mjs "\$trust\/server\/cloudflare\/"/);
  assert.match(workflow, /zc="\$CHE_TRUSTED_TOOLS\/tools\/che_coding_zero_cost\.mjs"/);
  assert.doesNotMatch(workflow, /node tools\/che_coding_zero_cost\.mjs/);
  const publish = workflow.slice(workflow.indexOf('\n  publish:\n'));
  const post = publish.indexOf('- name: Post compact result to CHE mailbox branch');
  const ledger = publish.indexOf('- name: Update the model ledger');
  const fail = publish.indexOf('- name: Fail the run when the coding session was blocked');
  assert.ok(post > 0 && ledger > post && fail > ledger);
  assert.match(publish, /mailbox\/runtime\/model-ledger\.json/);
  assert.match(workflow, /completed_by_model: winner \? winner\.model : null/);
});

test('every attempt pins OpenCode\'s small model to the attempt model, and prints OpenCode\'s own error log for redaction', () => {
  assert.match(workflow, /node "\$zc" config --base "\$OPENCODE_CONFIG" --model "\$m"/);
  assert.match(workflow, /opencode run --print-logs --log-level ERROR --format json --auto --model "\$m" "\$prompt"/);
});
