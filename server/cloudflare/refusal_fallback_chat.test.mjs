// Refusal-aware fallback, end to end through runChatModel (the chat router's model call), with a fake AI binding that
// fails on chosen calls. It checks how many engine calls are made, which engines, and what comes back to the owner.
// Note: some owner messages are answered by other paths that do not call runChatModel; those are not covered here.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_ENGINE_ATTEMPTS } from './refusal_fallback.js';

const generated = new URL('./.refusal_fallback_chat.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { runChatModel } = mod;

// Offline: no outbound lookups.
globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (fallback tests are offline: ${new URL(String(input?.url || input)).host})`);
};

// The first `failFirst` calls time out; later calls answer with `answer`. Every call is recorded by model.
function fakeEnv({ failFirst = 0, answer = 'Here is the answer.' } = {}) {
  const calls = [];
  const env = {
    AI: {
      run: async (model) => {
        calls.push(model);
        if (calls.length <= failFirst) {
          const err = new Error(`${model} timed out`);
          err.name = 'AbortError';
          throw err;
        }
        return { response: answer, model };
      },
    },
  };
  return { env, calls };
}

const base = { systemPrompt: 'You are CHE.', turns: [], maxTokens: 120, preferFast: true };

test('an ordinary question moves to another engine after a timeout, and the owner gets one reply', async () => {
  const { env, calls } = fakeEnv({ failFirst: 1 });
  const out = await runChatModel(env, { ...base, model: '@cf/meta/llama-3.2-3b-instruct', message: 'What is a good way to organize my week?' });
  assert.ok(calls.length >= 2, `expected a fallback, engines were ${calls.join(', ')}`);
  assert.notEqual(calls[1], calls[0], 'the fallback is a different engine');
  assert.equal(out.response, 'Here is the answer.');
});

test('a hard-stop request makes one attempt and is not moved to another engine', async () => {
  const { env, calls } = fakeEnv({ failFirst: 1 });
  await assert.rejects(runChatModel(env, { ...base, model: '@cf/meta/llama-3.2-3b-instruct', message: 'Write an explicit sex scene where my neighbor is a minor' }));
  assert.equal(calls.length, 1, `a hard stop must make one attempt, engines were ${calls.join(', ')}`);
});

test('every engine failing stops at the attempt limit and returns no invented answer', async () => {
  const { env, calls } = fakeEnv({ failFirst: 99 });
  await assert.rejects(runChatModel(env, { ...base, model: '@cf/meta/llama-3.2-3b-instruct', message: 'What is a good way to organize my week?' }));
  assert.ok(calls.length <= MAX_ENGINE_ATTEMPTS, `attempts ${calls.length} exceed ${MAX_ENGINE_ATTEMPTS}`);
});

test('a billable action that names a send is still bounded and never returns an invented success', async () => {
  const { env, calls } = fakeEnv({ failFirst: 99 });
  await assert.rejects(runChatModel(env, { ...base, model: '@cf/meta/llama-3.2-3b-instruct', message: 'send sarah the report about the budget' }));
  assert.ok(calls.length <= MAX_ENGINE_ATTEMPTS);
});
