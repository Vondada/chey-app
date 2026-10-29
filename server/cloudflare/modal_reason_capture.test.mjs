// A Modal refusal keeps its reason whatever shape it arrives in: the handler's `error`, a framework's `detail`, or plain body
// text. Before this, a refusal that was not `{ error }` JSON was reported as "without a reason".
import assert from 'node:assert/strict';
import test from 'node:test';
import { modalReasonOf, startModalImage } from './media.js';

const HOST = 'https://vondada--che-gpu.us-east.modal.run';
const ENV_ON = { CHE_MODAL_TXT2IMG: 'enabled', CHE_MODAL_TXT2IMG_MAX: '1000', MODAL_TOKEN: `bearer:${'a'.repeat(40)}@${HOST}`, CHE_AI_BOUND: true };

function memoryStorage() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (k, v) => { map.set(k, structuredClone(v)); },
    delete: async (k) => { map.delete(k); },
    list: async ({ prefix = '' } = {}) => new Map([...map.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}

async function refusedWith(status, text, type = 'application/json') {
  return startModalImage(ENV_ON, memoryStorage(), { prompt: 'a glowing blue cube', width: 256 },
    async () => new Response(text, { status, headers: { 'content-type': type } }));
}

test('the handler\'s own error is the reason', async () => {
  const out = await refusedWith(422, JSON.stringify({ ok: false, error: 'width and height must be one of [256, 512]' }));
  assert.equal(out.modal_reason, 'width and height must be one of [256, 512]');
  assert.match(out.detail, /\(422: width and height must be one of \[256, 512\]\)/);
});

test('a framework 422 with a detail list gives its messages as the reason', async () => {
  const out = await refusedWith(422, JSON.stringify({ detail: [{ loc: ['body', 'seed'], msg: 'Input should be a valid integer', type: 'int_type' }] }));
  assert.equal(out.modal_reason, 'Input should be a valid integer');
});

test('a 422 whose body is plain text keeps those words as the reason', async () => {
  const out = await refusedWith(422, 'Unprocessable Entity: field "steps" is missing', 'text/plain');
  assert.equal(out.modal_reason, 'Unprocessable Entity: field "steps" is missing');
});

test('a 422 with an empty body gives no reason, and says none was given', async () => {
  const out = await refusedWith(422, '', 'text/plain');
  assert.equal(out.modal_reason, null);
  assert.match(out.detail, /\(422\)\./);
});

test('modalReasonOf keeps only printable characters and at most 160', () => {
  const reason = modalReasonOf({ data: { error: `${'x'.repeat(200)}\u0007` } });
  assert.equal(reason.length, 160);
  assert.doesNotMatch(reason, /[^\x20-\x7E]/);
});
