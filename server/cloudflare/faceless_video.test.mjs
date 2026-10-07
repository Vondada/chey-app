import assert from 'node:assert/strict';
import test from 'node:test';
import { createFacelessVideo, planFacelessVideo } from './faceless_video.js';

test('topic becomes a shot list and no fake file', async () => {
  const plan = planFacelessVideo({ topic: 'how a futures tick works', minutes: 4 });
  assert.equal(plan.ok, true);
  assert.equal(plan.video, false);
  assert.equal(plan.shots.length, 4);
  const made = await createFacelessVideo({}, { topic: 'how a futures tick works' });
  assert.equal(made.ok, false);
  assert.match(made.error, /No mp4/);
});

test('renderer url is the only way to get a file', async () => {
  const made = await createFacelessVideo(
    { CHE_VIDEO_RENDER_URL: 'https://render.example/video' },
    { topic: 'office agents' },
    async () => ({ ok: true, json: async () => ({ media_url: 'https://cdn.example/v.mp4' }) }),
  );
  assert.equal(made.ok, true);
  assert.equal(made.media_url, 'https://cdn.example/v.mp4');
});
