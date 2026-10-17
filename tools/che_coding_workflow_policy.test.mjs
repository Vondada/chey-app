import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/che-opencode-runtime.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('      - name: Resolve model');
const stop = workflow.indexOf('      - name: Run OpenCode', start);
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
  assert.match(workflow, /node tools\/che_coding_paid_gate\.mjs/);
  assert.match(workflow, /for m in \$FREE_CANDIDATES \$PAID_CANDIDATES/);
  assert.match(workflow, /CHE_CODING_OPENROUTER_PAID_KEY/);
  assert.doesNotMatch(workflow, /CHE_ALLOW_PAID_MODELS/);
  assert.match(workflow, /remaining - 180/);
});
