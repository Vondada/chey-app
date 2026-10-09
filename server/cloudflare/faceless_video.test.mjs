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
    async (url) => String(url).includes('cdn.example')
      ? new Response(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109]))
      : new Response(JSON.stringify({ media_url: 'https://cdn.example/v.mp4' })),
  );
  assert.equal(made.ok, true);
  assert.equal(made.media_url, 'https://cdn.example/v.mp4');
});

test('existing MoneyPrinter endpoint supports video jobs without inventing MP4 files', async () => {
  const made = await createFacelessVideo({ CHE_VIDEO_GEN_URL: 'https://renderer.example' },
    { topic: 'Three facts about space', seconds: 15 },
    async (url) => String(url).endsWith('/videos')
      ? new Response(JSON.stringify({ data: { task_id: 'space15' } }))
      : new Response(JSON.stringify({ data: { state: 1 } })));
  assert.equal(made.pending, true);
  assert.equal(made.video, false);
  assert.equal(made.task_id, 'space15');
  assert.equal(made.plan.seconds, 15);
  assert.equal(made.media_url, undefined);
});
