// The blue glowing cube regression (owner, 2026-10-29): an authorized 256x256 picture of a blue glowing cube got old GPU
// health-check and job-status replies, because the words "verify", "check", "test" and "done" inside a picture request
// were read as a Modal status or health ask. A picture request goes to the picture route; a negated creation makes nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { modalServiceIntent } from './modal_connect.js';
import { inferTurnCapabilities } from './cognitive_capabilities.js';
import { chatImageProvider } from './chat_image_provider.js';

const PICTURE_REQUESTS = [
  'CHE, create a 256x256 image of a blue glowing cube.',
  'CHE, create a 256x256 image of a blue glowing cube using Modal GPU.',
  'Make a 256 by 256 picture of a blue glowing cube on Modal.',
  'Create a blue glowing cube image on Modal and verify it when done.',
  'Generate a Modal picture of a blue glowing cube and check it is saved.',
  'Create a picture of a blue glowing cube with Modal, then test it.',
];

test('a picture request is never a Modal health, connection or status ask', () => {
  for (const msg of PICTURE_REQUESTS) assert.equal(modalServiceIntent(msg), null, msg);
});

test('a picture request is recognised as an image-generation request', () => {
  for (const msg of PICTURE_REQUESTS) {
    assert.ok(inferTurnCapabilities(msg).includes('image_generation'), msg);
  }
});

test('a negated creation makes no picture and starts no Modal run', () => {
  const msg = 'Do not create another blue cube picture.';
  assert.equal(modalServiceIntent(msg), null);
  assert.equal(inferTurnCapabilities(msg).includes('image_generation'), false, msg);
});

test('an earlier picture is asked about with its own words, and it is a status ask, not a new picture', () => {
  assert.equal(modalServiceIntent('Check the previous Modal picture of the blue cube.')?.kind, 'job_status');
  assert.equal(inferTurnCapabilities('Check the previous Modal picture of the blue cube.').includes('image_generation'), false);
});

test('the Modal picture is chosen only when the owner has authorized it; otherwise Workers AI, with the reason', async () => {
  const off = await chatImageProvider({}, { get: async () => undefined }, { count: 1 });
  assert.equal(off.provider, 'workers_ai');
  assert.match(off.reason, /not authorized yet/);
});

// Codex review of #763: a question about an existing picture is a status ask, and a negation covers only its own clause.
test('"Did you create a picture of the blue cube on Modal?" is a status ask and creates no picture', () => {
  const msg = 'Did you create a picture of the blue cube on Modal?';
  assert.equal(modalServiceIntent(msg)?.kind, 'job_status');
  assert.equal(inferTurnCapabilities(msg).includes('image_generation'), false);
});

test('a negated clause does not cancel an affirmative picture request in the same message', () => {
  assert.equal(inferTurnCapabilities('Do not create a logo. Make a picture of a dog instead.').includes('image_generation'), true);
  assert.equal(inferTurnCapabilities("Don't forget to create a picture of a dog.").includes('image_generation'), true);
});

// The five routing cases of the blue cube mission (2026-10-29): creating an image, checking a picture job, checking Modal
// connectivity, checking GitHub Actions, and cancelling or refusing. Each reaches its own handler and nothing else.
test('creating an image goes to the picture route; a picture job, Modal connectivity, GitHub Actions and a refusal each keep their own route', () => {
  const create = 'Generate one 256x256 image of a glowing blue cube using Modal GPU.';
  assert.equal(inferTurnCapabilities(create).includes('image_generation'), true);
  assert.equal(modalServiceIntent(create), null);
  assert.equal(modalServiceIntent('Check the previous picture job on Modal.')?.kind, 'job_status');
  assert.equal(modalServiceIntent('Check Modal connection.')?.kind, 'connection');
  const gh = "What's the status of the GitHub Actions run?";
  assert.equal(modalServiceIntent(gh), null, 'GitHub Actions is answered by the deploy and commit receipts, not Modal');
  assert.equal(inferTurnCapabilities(gh).includes('image_generation'), false);
  const refuse = 'Do not generate the blue cube picture.';
  assert.equal(inferTurnCapabilities(refuse).includes('image_generation'), false, 'a refusal makes no picture');
  assert.equal(modalServiceIntent(refuse), null);
});

// An explicit Modal request is never answered by another engine (owner's rule: no silent provider switching).
test('an explicit Modal picture request with Modal off makes nothing and names the reason; no other engine runs', async () => {
  const { chatPictureTurn } = await import('./chat_image_provider.js');
  let engineCalls = 0;
  const makeImages = async () => { engineCalls += 1; return [{ number: 1, ok: true, id: 'x', mime_type: 'image/png', title: 't', status: 200 }]; };
  const out = await chatPictureTurn({}, { get: async () => undefined, put: async () => {} }, { message: 'Generate one 256x256 image of a glowing blue cube using Modal GPU.', origin: 'https://w', makeImages });
  assert.equal(engineCalls, 0);
  assert.match(out.text, /I did not make the picture, sir: you asked for Modal GPU/);
  assert.equal(out.meta.nothing_generated, true);
  assert.equal(out.meta.provider_used, null);
});

test('a plain picture request with no Modal word still uses the picture engine, with its engine note', async () => {
  const { chatPictureTurn } = await import('./chat_image_provider.js');
  let engineCalls = 0;
  const makeImages = async () => { engineCalls += 1; return [{ number: 1, ok: true, id: 'y', mime_type: 'image/png', title: 't', status: 200 }]; };
  const out = await chatPictureTurn({}, { get: async () => undefined, put: async () => {} }, { message: 'Generate one 256x256 image of a glowing blue cube.', origin: 'https://w', makeImages });
  assert.equal(engineCalls, 1);
  assert.match(out.text, /^Made with Cloudflare Workers AI \(provider: Workers AI\)/);
});
