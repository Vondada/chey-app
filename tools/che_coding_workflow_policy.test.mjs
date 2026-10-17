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

function plan({ paid = false, requested = 'auto', freeProviders = 'openrouter,google,groq', models } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'che-coding-test-'));
  try {
    const bin = join(dir, 'opencode');
    const listing = models || {
      openrouter: ['openrouter/qwen/qwen3-coder:free', 'openrouter/deepseek/deepseek-chat:free',
        'openrouter/qwen/qwen3-coder', 'openrouter/deepseek/deepseek-chat'],
      google: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash'],
      groq: ['groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b'],
    };
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = "models" ] || exit 1\ncase "$2" in\n' +
      Object.entries(listing).map(([k, v]) => `  ${k}) printf '%s\\n' ${v.map(s => "'" + s + "'").join(' ')};;`).join('\n') +
      '\n  *) exit 1;;\nesac\n');
    chmodSync(bin, 0o755);
    const out = join(dir, 'outputs');
    writeFileSync(out, '');
    execFileSync('bash', ['-c', 'set -e;\n' + script], {
      env: { ...process.env, PATH: dir + ':' + process.env.PATH,
        GITHUB_OUTPUT: out, REQUESTED: requested,
        CHE_CODING_FREE_PROVIDERS: freeProviders,
        CHE_CODING_PAID_FALLBACK: String(paid),
        HAS_OPENROUTER: 'true', HAS_GOOGLE: 'true', HAS_GROQ: 'true',
        HAS_CEREBRAS: 'false', HAS_MISTRAL: 'false',
        K_OPENROUTER: 'fake-free-key', K_PAID_OPENROUTER: 'fake-paid-key',
        K_GOOGLE: 'fake-google', K_GROQ: 'fake-groq',
      }, encoding: 'utf8', stdio: 'pipe',
    });
    return Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map(x => {
      const pos = x.indexOf('='); return [x.slice(0,pos),x.slice(pos+1)];
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('free models are tried first; expensive Google Pro is NOT free-listed', () => {
  const p = plan({ paid: false });
  assert.match(p.free_candidates, /openrouter\/.*:free/);
  assert.match(p.free_candidates, /google\/gemini-2.5-flash/);
  assert.doesNotMatch(p.free_candidates, /gemini-2.5-pro/);
  assert.equal(p.paid_candidates, '');
});
test('paid model is offered only after free candidates, and only when explicitly enabled', () => {
  const p = plan({ paid: true });
  assert.match(p.free_candidates, /:free/);
  assert.match(p.paid_candidates, /^openrouter\/qwen\/qwen3-coder/);
  assert.ok(p.free_candidates.split(' ').every(x => !p.paid_candidates.split(' ').includes(x)));
});
test('unverified external providers are not automatically considered free', () => {
  const p = plan({ paid: false, freeProviders: 'openrouter' });
  assert.doesNotMatch(p.free_candidates, /google\/|groq\//);
  assert.match(p.free_candidates, /^openrouter\//);
});
test('even an explicit paid request stays behind the free-first and approval gates', () => {
  const p = plan({ paid: true, requested: 'openrouter/qwen/qwen3-coder' });
  assert.match(p.free_candidates, /:free/);
  assert.match(p.paid_candidates, /^openrouter\/qwen\/qwen3-coder/);
});
test('runtime checks monthly key cap immediately before paid model execution', () => {
  assert.match(workflow, /node "\$CHE_TRUSTED_TOOLS\/tools\/che_coding_paid_gate\.mjs"/);
  assert.match(workflow, /for m in \$FREE_CANDIDATES;/);
  assert.match(workflow, /for m in \$PAID_CANDIDATES;/);
  assert.match(workflow, /Run capped paid OpenRouter only after free attempts/);
  assert.match(workflow, /CHE_CODING_OPENROUTER_PAID_KEY/);
  assert.doesNotMatch(workflow, /CHE_ALLOW_PAID_MODELS/);
  assert.match(workflow, /remaining - 180/);
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
