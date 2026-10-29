// Natural-language picture requests in chat: recognised, routed to Modal only when connected, authorized and within its cap,
// and never switched silently. Modal is a fake fetcher; nothing runs on a GPU and nothing is billed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chatImageProvider, modalPictureReply, workersAiNote } from './chat_image_provider.js';
import { inferTurnCapabilities } from './cognitive_capabilities.js';
import { MODAL_IMAGE_KEY, startModalImage } from './media.js';

const HOST = 'https://vondada--che-gpu.us-east.modal.run';
const ON = { CHE_MODAL_TXT2IMG: 'enabled', MODAL_TOKEN: `bearer:${'a'.repeat(40)}@${HOST}` };

function memoryStorage() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (k, v) => { map.set(k, structuredClone(v)); },
    delete: async (k) => { map.delete(k); },
    list: async () => new Map(),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}
const fakeModal = () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ call_id: 'fc-abcdef123456' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetcher };
};

test('the owner\'s sentence is an image-generation request', () => {
  assert.ok(inferTurnCapabilities('CHE, create a picture of a futuristic city.').includes('image_generation'));
  assert.ok(inferTurnCapabilities('make me a picture of a lighthouse at dusk').includes('image_generation'));
});

test('a sentence that only mentions a picture is not an image request', () => {
  assert.ok(!inferTurnCapabilities('Take a picture of the receipt for my taxes').includes('image_generation'));
});

test('Modal is off until the owner turns pictures on: the picture is made by Workers AI, and the reply says why', async () => {
  const choice = await chatImageProvider({}, memoryStorage());
  assert.equal(choice.provider, 'workers_ai');
  assert.match(choice.reason, /not authorized yet/);
  assert.match(workersAiNote(choice.reason), /^Made with Cloudflare Workers AI \(provider: Workers AI\), because Modal GPU pictures are not authorized yet\. $/);
});

test('Modal is not connected: Workers AI, with the reason', async () => {
  const choice = await chatImageProvider({ CHE_MODAL_TXT2IMG: 'enabled' }, memoryStorage());
  assert.equal(choice.provider, 'workers_ai');
  assert.match(choice.reason, /Modal is not connected/);
});

test('connected, authorized and within the cap: Modal is chosen', async () => {
  const choice = await chatImageProvider(ON, memoryStorage());
  assert.equal(choice.provider, 'modal');
});

test('once the cap is used up, the next picture is made by Workers AI and says so', async () => {
  const storage = memoryStorage();
  const { fetcher } = fakeModal();
  await startModalImage(ON, storage, { prompt: 'first' }, fetcher);
  const choice = await chatImageProvider(ON, storage);
  assert.equal(choice.provider, 'workers_ai');
  assert.match(choice.reason, /cap is used up/);
});

test('asking for several pictures goes to Workers AI, with the reason, because Modal makes one at a time', async () => {
  const choice = await chatImageProvider(ON, memoryStorage(), { count: 3 });
  assert.equal(choice.provider, 'workers_ai');
  assert.match(choice.reason, /one picture at a time/);
});

test('a started Modal picture is reported with its job id, never as a finished image', async () => {
  const { fetcher } = fakeModal();
  const started = await startModalImage(ON, memoryStorage(), { prompt: 'a futuristic city' }, fetcher);
  const reply = modalPictureReply(started);
  assert.match(reply, /provider: Modal, job fc-abcdef123456/);
  assert.match(reply, /It is not in your Gallery yet/);
  assert.doesNotMatch(reply, /generated|saved to your Gallery|here is|shown/i);
});

test('a refused Modal start is reported with its reason, and no other engine is named as having made it', async () => {
  const started = await startModalImage({ CHE_MODAL_TXT2IMG: 'enabled' }, memoryStorage(), { prompt: 'a city' }, fakeModal().fetcher);
  const reply = modalPictureReply(started);
  assert.match(reply, /I did not start a Modal GPU picture/);
  assert.match(reply, /no other engine was used/);
});
