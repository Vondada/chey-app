// The Modal picture start refused with HTTP 422. The Worker must send the arguments the Modal handler accepts, keep Modal's
// own reason in the refusal, release the reservation (nothing was charged), and say the closing sentence once in chat.
import assert from 'node:assert/strict';
import test from 'node:test';
import { startModalImage } from './media.js';
import { modalPictureReply, refusalReason } from './chat_image_provider.js';
import { testBudgetReport, TXT2IMG_WORST_CASE_USD } from './gpu_test_budget.js';

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

/** A fake Modal that records what was sent and answers with the given status and JSON body. */
function modalAnswering({ status, body }) {
  const sent = [];
  const fetcher = async (url, init) => {
    sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { sent, fetcher };
}

// The handler's own message for a size it does not allow (tools/modal/txt2img.py validate_txt2img_args).
const MODAL_422 = { ok: false, error: 'width and height must be one of [256, 512]' };

test('the Worker sends exactly the five arguments the Modal handler accepts, with a 256 px request as 256 px', async () => {
  const storage = memoryStorage();
  const { sent, fetcher } = modalAnswering({ status: 200, body: { ok: true, call_id: 'fc-422-check' } });
  await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube', width: 256 }, fetcher);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/txt2img');
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['height', 'prompt', 'seed', 'steps', 'width']);
  assert.equal(sent[0].body.width, 256);
  assert.equal(sent[0].body.height, 256);
  assert.equal(sent[0].body.steps, 4, 'the handler accepts 1 to 4 steps');
  assert.ok(Number.isInteger(sent[0].body.seed) && sent[0].body.seed >= 0 && sent[0].body.seed < 2 ** 31, 'the handler accepts a seed below 2^31');
  assert.equal(sent[0].body.prompt, 'a glowing blue cube');
});

test('a Modal 422 is refused with Modal\'s own reason, the reservation is released, and nothing is charged', async () => {
  const storage = memoryStorage();
  const { fetcher } = modalAnswering({ status: 422, body: MODAL_422 });
  const out = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube', width: 256 }, fetcher);
  assert.equal(out.status, 502);
  assert.match(out.detail, /\(422: width and height must be one of \[256, 512\]\)/);
  assert.equal(out.nothing_generated, true);
  const report = await testBudgetReport(storage);
  assert.equal(report.reserved_usd, 0, 'no reservation stays open');
  assert.equal(report.spent_usd, 0, 'a call Modal refused costs nothing');
  assert.equal(report.jobs[0].state, 'released');
});

test('a 422 with no body still refuses, with the status and no invented reason', async () => {
  const storage = memoryStorage();
  const { fetcher } = modalAnswering({ status: 422, body: null });
  const out = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube' }, fetcher);
  assert.equal(out.status, 502);
  assert.match(out.detail, /refused to start the picture \(422\)\./);
});

test('a network failure keeps its reservation: the call may have started, so nothing is charged as released', async () => {
  const storage = memoryStorage();
  const fetcher = async () => { throw new TypeError('fetch failed'); };
  const out = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube' }, fetcher);
  assert.equal(out.status, 502);
  const report = await testBudgetReport(storage);
  assert.equal(report.reserved_usd, TXT2IMG_WORST_CASE_USD, 'the worst case stays reserved until the outcome is known');
});

test('the chat reply to a 422 names the reason once and says the closing sentence once', async () => {
  const storage = memoryStorage();
  const { fetcher } = modalAnswering({ status: 422, body: MODAL_422 });
  const out = await startModalImage(ENV_ON, storage, { prompt: 'a glowing blue cube', width: 256 }, fetcher);
  const reply = modalPictureReply(out);
  assert.equal(reply.split('Nothing was generated').length - 1, 1, 'Nothing was generated appears once');
  assert.equal(reply.split('no other engine was used').length - 1, 1, 'no other engine was used appears once');
  assert.match(reply, /width and height must be one of \[256, 512\]/);
  assert.doesNotMatch(reply, /\.\s*\./, 'no doubled full stops');
});

test('refusalReason keeps the reason and drops only the closing sentences', () => {
  assert.equal(
    refusalReason('Modal refused to start the picture (422: width and height must be one of [256, 512]). Nothing was generated; no other engine was used.'),
    'Modal refused to start the picture (422: width and height must be one of [256, 512])',
  );
  assert.equal(
    refusalReason('The Modal GPU picture cap is 1 call, so nothing was started. No other engine was used.'),
    'The Modal GPU picture cap is 1 call',
  );
  assert.equal(refusalReason(''), '');
});
