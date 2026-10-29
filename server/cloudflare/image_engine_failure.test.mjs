// The owner's production failure after the schema fix: "All image engines failed (CHE image engine: 5006: E00001: Failed
// to create image)". The error text is the Workers AI binding's, so these tests show which engine answered, that Modal is
// never called, that nothing is saved for a failed picture, and that the prompt sent to Workers AI is the owner's own
// sentence with no retrieved memory in it. No model is called: the binding is a stand-in that throws the production text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateImage, listMedia } from './media.js';
import { makeChatImages, chatImageReply } from './chat_images.js';

const PRODUCTION_ERROR = '5006: E00001: Failed to create image';

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

// A Workers AI binding that refuses every image with the production text, and records what it was asked.
function refusingAi(calls) {
  return { run: async (model, input) => { calls.push({ model, input }); throw new Error(PRODUCTION_ERROR); } };
}

test('a Workers AI refusal is reported with its own text, the engine that answered, and nothing saved', async () => {
  const calls = [];
  const storage = memoryStorage();
  const made = await generateImage({ AI: refusingAi(calls), CHE_AI_BOUND: true }, storage, { prompt: 'a red kite over a field', title: 'kite' });
  assert.equal(calls.length, 1, 'exactly one Workers AI call');
  assert.equal(made.status, 502);
  assert.match(made.detail, /All image engines failed \(CHE image engine: 5006: E00001: Failed to create image\)/);
  assert.equal((await listMedia(storage)).length, 0, 'a failed picture is never saved');
});

test('the failure never reaches Modal: no Modal host is contacted and no Modal fallback is taken', async () => {
  const calls = [];
  const hosts = [];
  const fetcher = async (url) => { hosts.push(new URL(String(url)).host); return new Response('{}', { status: 500 }); };
  await generateImage({ AI: refusingAi(calls), CHE_AI_BOUND: true, CHE_MODAL_URL: 'https://example.modal.run' }, memoryStorage(), { prompt: 'a red kite' }, fetcher);
  assert.ok(hosts.every((h) => !h.endsWith('.modal.run')), `hosts contacted: ${hosts.join(', ') || 'none'}`);
});

test('the chat reply names the failed picture and its reason, and claims no picture was made', async () => {
  const storage = memoryStorage();
  const results = await makeChatImages({ AI: refusingAi([]), CHE_AI_BOUND: true }, storage, { message: 'CHE, make a picture of a red kite', count: 1 });
  const reply = chatImageReply(results);
  assert.match(reply, /I did not generate any pictures, sir\. Nothing was saved\./);
  assert.match(reply, /Picture 1 failed: All image engines failed/);
  assert.match(reply, /E00001/);
  assert.equal((await listMedia(storage)).length, 0);
});

test('the prompt sent to Workers AI is the owner\'s sentence (wake word removed), never stored memory', async () => {
  const calls = [];
  const storage = memoryStorage();
  await makeChatImages({ AI: refusingAi(calls), CHE_AI_BOUND: true }, storage, { message: 'CHE, make a picture of a lighthouse at dusk', count: 1 });
  const prompt = calls[0].input.prompt;
  assert.equal(prompt, 'make a picture of a lighthouse at dusk');
  assert.doesNotMatch(prompt, /RETRIEVAL CONTEXT|memory|Brain/i);
});

test('a picture that works is saved to the Gallery and listed', async () => {
  const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString('base64');
  const ai = { run: async () => ({ image: pngBase64 }) };
  const storage = memoryStorage();
  const results = await makeChatImages({ AI: ai, CHE_AI_BOUND: true }, storage, { message: 'CHE, make a picture of a red kite', count: 1 });
  assert.equal(results[0].ok, true);
  const items = await listMedia(storage);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, results[0].id);
});
