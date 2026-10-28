// Image payloads follow each model's own schema. The owner's production failure: "All image engines failed (CHE image
// engine: 5006: Error: Additional or unevaluated properties '/seed' at '/' not allowed)". Tests use unseen values and
// several models, not the owner's exact request.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FLUX_SCHNELL, LUCID_ORIGIN, imagePayload, payloadReceipt } from './image_payload.js';
import { STILL_MODEL } from './film_studio.js';
import { generateImage, listMedia } from './media.js';

test('FLUX.1 schnell is never sent a seed: its schema lists prompt and steps only', () => {
  const r = imagePayload(FLUX_SCHNELL, { prompt: 'a lighthouse at dusk, unseen wording 4417', steps: 6, seed: 90210 });
  assert.deepEqual(Object.keys(r.payload).sort(), ['prompt', 'steps']);
  assert.equal(r.payload.steps, 6);
  assert.equal(r.seed_applied, false);
  const dropped = r.dropped.find((d) => d.field === 'seed');
  assert.ok(dropped, 'the drop is reported, not hidden');
  assert.match(dropped.reason, /does not take a seed/);
});

test('steps are clamped to the model\'s range and the prompt to its maximum length, with the change reported', () => {
  const r = imagePayload(FLUX_SCHNELL, { prompt: 'x'.repeat(2100), steps: 40 });
  assert.equal(r.payload.prompt.length, 2048);
  assert.equal(r.payload.steps, 8);
  assert.ok(r.dropped.some((d) => d.field === 'prompt' && /cut to 2048/.test(d.reason)));
  assert.ok(r.dropped.some((d) => d.field === 'steps' && /set to 8/.test(d.reason)));
});

test('an unsupported parameter is dropped with its reason: width, height, guidance, negative prompt', () => {
  const r = imagePayload(FLUX_SCHNELL, { prompt: 'a violin', steps: 4, width: 512, height: 512, guidance: 7, negative_prompt: 'blur' });
  assert.deepEqual(Object.keys(r.payload).sort(), ['prompt', 'steps']);
  for (const field of ['width', 'height', 'guidance', 'negative_prompt']) assert.ok(r.dropped.some((d) => d.field === field), field);
});

test('a model whose schema is not known sends only the prompt and says so', () => {
  const r = imagePayload('@cf/example/unknown-image-model', { prompt: 'a red kite', steps: 4, seed: 5 });
  assert.deepEqual(r.payload, { prompt: 'a red kite' });
  assert.equal(r.schema_known, false);
  assert.ok(r.dropped.some((d) => d.field === 'seed' && /not known to CHE/.test(d.reason)));
});

test('the receipt lists what was sent and what was dropped, for the record', () => {
  const built = imagePayload(FLUX_SCHNELL, { prompt: 'a bridge in fog', steps: 8, seed: 3 });
  const receipt = payloadReceipt(FLUX_SCHNELL, built);
  assert.deepEqual(receipt.fields_sent.sort(), ['prompt', 'steps']);
  assert.equal(receipt.seed_applied, false);
  assert.equal(receipt.dropped.length, 1);
});

// The chat image engine, end to end with a Workers AI stand-in that enforces flux's schema exactly: any property the
// schema does not list is refused with the production message. Storage is in memory; no network.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const FLUX_FIELDS = new Set(['prompt', 'steps']);
function fluxSchemaAi(calls = []) {
  return { run: async (model, input) => {
    calls.push({ model, input: structuredClone(input) });
    if (model !== FLUX_SCHNELL) throw new Error(`model ${model} is not in this fake`);
    for (const key of Object.keys(input)) if (!FLUX_FIELDS.has(key)) throw new Error(`5006: Error: Additional or unevaluated properties '/${key}' at '/' not allowed`);
    if (typeof input.prompt !== 'string' || input.prompt.length < 1 || input.prompt.length > 2048) throw new Error('5006: prompt length');
    if (input.steps !== undefined && (input.steps < 1 || input.steps > 8)) throw new Error('5006: steps out of range');
    return { image: PNG_1X1 };
  } };
}
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

test('the chat image engine returns a real image and saves it to the Gallery, with the schema-compatible payload', async () => {
  const calls = [];
  const storage = memoryStorage();
  const out = await generateImage({ AI: fluxSchemaAi(calls) }, storage, { prompt: 'a heron standing in shallow water at dawn, check 8812' });
  assert.equal(out.status, 200, JSON.stringify(out));
  assert.equal(out.item.engine, 'CHE image engine');
  assert.equal(out.item.mime_type, 'image/png', 'the type comes from the bytes');
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].input).sort(), ['prompt', 'steps']);
  assert.equal(out.item.payload_receipt.seed_applied, false);
  assert.ok(out.item.payload_receipt.dropped.some((d) => d.field === 'seed'));
  const gallery = await listMedia(storage);
  assert.equal(gallery.length, 1, 'the image is in the Gallery');
  assert.equal(gallery[0].id, out.item.id);
});

test('a provider that refuses the payload is reported with its own error, and nothing is saved or invented', async () => {
  const storage = memoryStorage();
  const refusing = { run: async () => { throw new Error("5006: Error: Additional or unevaluated properties '/seed' at '/' not allowed"); } };
  const out = await generateImage({ AI: refusing }, storage, { prompt: 'a kite over a harbour, check 3309' });
  assert.equal(out.status, 502);
  assert.match(out.detail, /All image engines failed \(CHE image engine: 5006: Error: Additional or unevaluated properties '\/seed' at '\/' not allowed\)/);
  assert.equal((await listMedia(storage)).length, 0, 'no picture is recorded when the engine fails');
});

test('a payload the old code would have sent (seed on flux) is refused by the stand-in: the regression is caught', async () => {
  const ai = fluxSchemaAi();
  await assert.rejects(() => ai.run(FLUX_SCHNELL, { prompt: 'a bell', steps: 4, seed: 1 }), /\/seed/);
});

test('model switching: the same wish gives each model its own payload (seed kept by lucid, dropped by FLUX)', () => {
  const wish = { prompt: 'a glass bridge over a quiet lake, switch-test 552', steps: 6, seed: 4242, width: 768, height: 512, guidance: 5 };
  const flux = imagePayload(FLUX_SCHNELL, wish);
  const lucid = imagePayload(LUCID_ORIGIN, wish);
  assert.deepEqual(Object.keys(flux.payload).sort(), ['prompt', 'steps']);
  assert.deepEqual(Object.keys(lucid.payload).sort(), ['guidance', 'height', 'prompt', 'seed', 'steps', 'width']);
  assert.equal(lucid.payload.seed, 4242, 'a supported seed is preserved');
  assert.equal(lucid.seed_applied, true);
  assert.equal(flux.seed_applied, false);
  assert.ok(flux.dropped.some((d) => d.field === 'width') && flux.dropped.some((d) => d.field === 'guidance'));
  assert.deepEqual(lucid.dropped, [], 'nothing supported is dropped for lucid');
});

test('numeric limits are enforced per model and each change is reported', () => {
  const r = imagePayload(LUCID_ORIGIN, { prompt: 'a clock tower', guidance: 15, width: 9000, height: -4, steps: 0, seed: -1 });
  assert.equal(r.payload.guidance, 10);
  assert.equal(r.payload.width, 2500);
  assert.equal(r.payload.height, 0);
  assert.equal(r.payload.steps, 1);
  assert.equal(r.payload.seed, undefined, 'a negative seed is not sent');
  for (const field of ['guidance', 'width', 'height', 'steps', 'seed']) assert.ok(r.dropped.some((d) => d.field === field), field);
});

test('the film pipeline\'s still model is FLUX, so its payload carries no seed (the same 5006 case)', () => {
  assert.equal(STILL_MODEL, FLUX_SCHNELL);
  const r = imagePayload(STILL_MODEL, { prompt: 'a harbour at night, film still 7', steps: 4, seed: 99 });
  assert.deepEqual(Object.keys(r.payload).sort(), ['prompt', 'steps']);
});

// Provider routing: an explicit Modal request is refused, never answered by Workers AI or another engine.
test('an explicit Modal image request is refused: no Workers AI call, nothing saved, the refusal says so', async () => {
  const calls = [];
  const storage = memoryStorage();
  const out = await generateImage({ AI: fluxSchemaAi(calls) }, storage, { prompt: 'a bell tower in snow, provider check 1190', provider: 'modal' });
  assert.equal(out.status, 503);
  assert.equal(out.provider_requested, 'modal');
  assert.equal(out.provider_used, null);
  assert.match(out.detail, /Nothing was generated, and no other engine was used/);
  assert.equal(calls.length, 0, 'Workers AI was not called for an explicit Modal request');
  assert.equal((await listMedia(storage)).length, 0, 'nothing is saved');
});

test('without an explicit provider, the Workers AI engine is still used (the default is unchanged)', async () => {
  const calls = [];
  const out = await generateImage({ AI: fluxSchemaAi(calls) }, memoryStorage(), { prompt: 'a bell tower in snow, default check 1191' });
  assert.equal(out.status, 200);
  assert.equal(calls.length, 1);
});
