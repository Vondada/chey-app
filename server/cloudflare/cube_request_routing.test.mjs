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
