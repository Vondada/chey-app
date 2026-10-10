import assert from 'node:assert/strict';
import test from 'node:test';
import { ownToolPermissionProblems } from './flagstaff_reply_check.js';

test('the renderer listed under the owner-yes heading is flagged, as in the live V1 reply', () => {
  const reply = [
    '**What needs the owner’s yes**',
    '- Running the video renderer to actually create the MP4.',
    '- Uploading the video to YouTube and publishing it.',
  ].join('\n');
  assert.equal(ownToolPermissionProblems(reply).length, 1);
});

test('an owner-yes list with only upload and publish is not flagged', () => {
  const reply = ['**What needs the owner’s yes**', '- Uploading the video to YouTube.', '- Publishing it.'].join('\n');
  assert.deepEqual(ownToolPermissionProblems(reply), []);
});

test('the renderer under what I can do now is not flagged', () => {
  const reply = ['**What I can do now**', '- Generate a 15 second MP4 with the free GitHub video renderer.'].join('\n');
  assert.deepEqual(ownToolPermissionProblems(reply), []);
});

test('an inline needs-the-owner-yes sentence about the renderer is flagged', () => {
  assert.equal(ownToolPermissionProblems('Rendering the MP4 needs the owner\'s yes.').length, 1);
});

test('a renderer line with an upload word is exempt, and the spending line is not flagged', () => {
  const reply = ['**What needs the owner’s yes**', '- Uploading the rendered cut to YouTube.', '- Any spending tied to the rendering service.'].join('\n');
  assert.deepEqual(ownToolPermissionProblems(reply), []);
});
