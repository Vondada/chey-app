// CHE's words about a tool outcome: the handler's facts go in exactly, each closing sentence is said once, and the meta
// names the handler and the responder (this layer, not a model).
import assert from 'node:assert/strict';
import test from 'node:test';
import { startModalImage } from './media.js';
import { modalPictureReply, pictureMeta } from './chat_image_provider.js';
import { COMPOSER, nextStepForRefusal, oncePerSentence, refusedPictureText, startedPictureText } from './execution_reply.js';

const HOST = 'https://vondada--che-gpu.us-east.modal.run';
const ENV_ON = { CHE_MODAL_TXT2IMG: 'enabled', CHE_MODAL_TXT2IMG_MAX: '1000', MODAL_TOKEN: `bearer:${'a'.repeat(40)}@${HOST}`, CHE_AI_BOUND: true };
const REASON = 'width and height must be one of [256, 512]';

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

function modalAnswering({ status, body }) {
  return async () => new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function refusedByModal(status, body) {
  return startModalImage(ENV_ON, memoryStorage(), { prompt: 'a glowing blue cube', width: 256 }, modalAnswering({ status, body }));
}

test('a 422 reply carries Modal\'s validation reason verbatim, once, with the closing sentences once', async () => {
  const reply = modalPictureReply(await refusedByModal(422, { ok: false, error: REASON }));
  assert.equal(reply.split(REASON).length - 1, 1, 'the reason appears once');
  assert.match(reply, /Modal answered HTTP 422 and said: width and height must be one of \[256, 512\]\./);
  assert.equal(reply.split('Nothing was generated').length - 1, 1);
  assert.equal(reply.split('no other engine was used').length - 1, 1);
  assert.match(reply, /nothing was charged; no other engine was used\./);
  assert.match(reply, /256 or 512 pixels/, 'the next step names the size Modal accepts');
  assert.doesNotMatch(reply, /\.\s*\./, 'no doubled full stops');
});

test('a 422 with no reason says so, and does not invent one', async () => {
  const reply = modalPictureReply(await refusedByModal(422, null));
  assert.match(reply, /Modal answered HTTP 422 without a reason\./);
  assert.doesNotMatch(reply, /said:/);
});

test('a network failure says Modal did not answer, keeps the reserve, and does not claim a charge was released', async () => {
  const storage = memoryStorage();
  const started = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube' }, async () => { throw new TypeError('fetch failed'); });
  const reply = modalPictureReply(started);
  assert.match(reply, /Modal did not answer\./);
  assert.match(reply, /reserve stays on the ledger/);
  assert.doesNotMatch(reply, /Nothing was charged/);
  assert.match(reply, /Check Modal's job list before you ask again/);
});

test('a started picture names its job and never claims an image', () => {
  const reply = startedPictureText({ call_id: 'fc-abc123' });
  assert.match(reply, /job fc-abc123/);
  assert.match(reply, /not in your Gallery yet/);
  assert.doesNotMatch(reply, /generated|here is/i);
});

test('oncePerSentence keeps the first copy of a repeated sentence', () => {
  assert.equal(oncePerSentence('Nothing was generated. Nothing was generated. Done.'), 'Nothing was generated. Done.');
  assert.equal(oncePerSentence('One. one. Two.'), 'One. Two.');
});

test('the next step never tells CHE to retry a paid call by itself', () => {
  for (const facts of [{ http_status: 422, modal_reason: REASON }, { http_status: 422, modal_reason: null }, { http_status: null }, { http_status: 500 }]) {
    const step = nextStepForRefusal(facts);
    assert.match(step, /I will not repeat the paid call on my own|may or may not have started/, JSON.stringify(facts));
  }
});

test('the refused text is built from the facts it is given, with no other claim', () => {
  const text = refusedPictureText({ http_status: 422, modal_reason: REASON, budget_state: 'released' });
  assert.match(text, /^I did not start a Modal GPU picture, sir\./);
  assert.doesNotMatch(text, /job /);
});

test('the meta names the handler and the responder, and records no model call', async () => {
  const started = await refusedByModal(422, { ok: false, error: REASON });
  const meta = pictureMeta(started);
  assert.equal(meta.handler, 'modal_txt2img');
  assert.equal(meta.responder, COMPOSER);
  assert.equal(meta.model_calls, 0);
  assert.equal(meta.modal_http_status, 422);
  assert.equal(meta.modal_reason, REASON);
  assert.equal(meta.budget_state, 'released');
  assert.equal(meta.ok, false);
  assert.equal(meta.provider_used, null);
});

test('the meta of a started picture names the job, and nothing is saved', async () => {
  const meta = pictureMeta({ status: 202, call_id: 'fc-1' });
  assert.equal(meta.ok, true);
  assert.equal(meta.call_id, 'fc-1');
  assert.equal(meta.saved, false);
  assert.equal(meta.provider_used, 'modal');
});
