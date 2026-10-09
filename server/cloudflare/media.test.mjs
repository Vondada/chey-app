import assert from 'node:assert/strict';
import test from 'node:test';

import { generateImage, generateVideo } from './media.js';

function memoryStorage() {
  const data = new Map();
  return {
    data,
    get: async (key) => data.get(key),
    put: async (key, value) => data.set(key, value),
    delete: async (key) => data.delete(key),
  };
}

test('HD image generation uses current OpenAI GPT Image when a key is configured', async () => {
  const storage = memoryStorage();
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      data: [{ b64_json: btoa('fake-png-bytes') }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await generateImage(
    { OPENAI_API_KEY: 'test-key', CHE_ALLOW_PAID_MEDIA: '1', CHE_ALLOW_PAID_AI: '1' },
    storage,
    { prompt: 'A vivid cinematic CHE interface' },
    fakeFetch,
  );

  assert.equal(result.status, 200);
  assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(request.body.model, 'gpt-image-2.5-sunburst');
  assert.equal(request.body.quality, 'high');
  assert.equal(result.item.engine, 'openai-gpt-image-hd');
  assert.equal(result.item.mime_type, 'image/png');
});

test('paid HD image provider is gated until owner opt-in', async () => {
  const storage = memoryStorage();
  let called = false;
  const result = await generateImage(
    { OPENAI_API_KEY: 'test-key' },
    storage,
    { prompt: 'A cinematic CHE portrait' },
    async () => {
      called = true;
      throw new Error('should not call paid provider');
    },
  );
  assert.equal(called, false);
  assert.equal(result.status, 402);
  assert.equal(result.requires_owner_confirmation, true);
  assert.match(result.detail, /owner explicitly enables paid media/i);
});

test('Gemini Omni video generation stores MP4 output in R2', async () => {
  const storage = memoryStorage();
  const writes = [];
  let request;
  const bucket = {
    put: async (key, bytes, options) => writes.push({ key, bytes, options }),
    get: async () => null,
    delete: async () => {},
  };
  const fakeFetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      output_video: {
        data: btoa(String.fromCharCode(0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0)),
        mime_type: 'video/mp4',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await generateVideo(
    { GEMINI_API_KEY: 'test-key', CHE_DATA_BUCKET: bucket, CHE_ALLOW_PAID_MEDIA: '1', CHE_ALLOW_PAID_AI: '1' },
    storage,
    { prompt: 'A short cinematic orbit around the CHE logo' },
    fakeFetch,
  );

  assert.equal(result.status, 200);
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(request.body.model, 'gemini-omni-1.1-flash');
  assert.equal(request.body.generation_config.video_config.task, 'text_to_video');
  assert.equal(request.body.response_format.type, 'video');
  assert.equal(request.body.response_format.resolution, '1080p');
  assert.equal(result.item.engine, 'gemini-omni-video');
  assert.equal(result.item.kind, 'video');
  assert.match(result.item.blob_key, /\.mp4$/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.httpMetadata.contentType, 'video/mp4');
});

test('free engines only: the paid-media switch alone never reaches a paid image engine', async () => {
  const calls = [];
  await generateImage(
    { OPENAI_API_KEY: 'test-key', GEMINI_API_KEY: 'g', CHE_ALLOW_PAID_MEDIA: '1' },
    { put: async () => {}, get: async () => null },
    { prompt: 'A tree' },
    async (url) => { calls.push(String(url)); return new Response('{}', { status: 500 }); },
  ).catch(() => null);
  assert.ok(!calls.some((u) => /api\.openai\.com|generativelanguage\.googleapis\.com/.test(u)), 'no paid image call without CHE_ALLOW_PAID_AI');
});

test('paid media error names the switch that is actually off', async () => {
  const out = await generateImage({ OPENAI_API_KEY: 'k', CHE_ALLOW_PAID_MEDIA: '1' }, { put: async () => {}, get: async () => null }, { prompt: 'A tree' }, async () => new Response('{}', { status: 500 }));
  assert.equal(out.status, 402);
  assert.match(out.detail, /enables paid AI\./);
});

test('MoneyPrinter pending render is not stored or reported as completed video', async () => {
  const storage = memoryStorage();
  const calls = [];
  const made = await generateVideo(
    { CHE_VIDEO_GEN_URL: 'https://renderer.example' }, storage,
    { prompt: 'Three facts about space', seconds: 15 },
    async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(String(url).endsWith('/videos')
        ? { data: { task_id: 'space15' } } : { data: { state: 1 } }));
    },
  );
  assert.equal(made.status, 202);
  assert.equal(made.pending, true);
  assert.equal(made.job_id, 'space15');
  assert.equal(storage.data.has('media_index'), false);
  assert.deepEqual(calls, ['https://renderer.example/api/v1/videos', 'https://renderer.example/api/v1/tasks/space15']);
});

test('video completion creates a thumbnail receipt only if an image actually rendered', async () => {
  const storage = memoryStorage();
  const env = { CHE_VIDEO_GEN_URL: 'https://renderer.example' };
  const mp4 = Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109]);
  const created = await generateVideo(env, storage,
    { prompt: 'Three facts about space', seconds: 15, thumbnail: true },
    async (url) => {
      const str = String(url);
      if (str.endsWith('/videos')) return new Response(JSON.stringify({ data: { task_id: 'finished' } }));
      if (str.includes('/tasks/')) return new Response(JSON.stringify({ data: { videos: ['https://cdn.example/space.mp4'] } }));
      return new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
    },
  );
  assert.equal(created.status, 200);
  assert.equal(created.item.verified, true);
  assert.equal(created.item.durable, false, 'without R2 this is only an external preview');
  assert.equal(created.item.thumbnail_media_id, undefined);
  assert.match(created.item.thumbnail_error, /image engines failed|no image engine/i);
  assert.equal((await storage.get('media_index')).length, 1);
});

test('an existing video task finalizes once with a verified media ID, no duplicate render', async () => {
  const storage = memoryStorage();
  let starts = 0;
  const fetcher = async (url) => {
    const u = String(url);
    if (u.endsWith('/videos')) { starts++; return new Response(JSON.stringify({ data: { task_id: 'existing' } })); }
    if (u.includes('/tasks/existing')) return new Response(JSON.stringify({ data: { videos: ['https://cdn.example/space.mp4'] } }));
    return new Response(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109]),
      { headers: { 'content-type': 'video/mp4' } });
  };
  const body = { task_id: 'existing', prompt: 'Three facts about space' };
  const first = await generateVideo({ CHE_VIDEO_GEN_URL: 'https://renderer.example' }, storage, body, fetcher);
  assert.equal(first.status, 200);
  assert.equal(first.item.verified, true);
  assert.equal(first.item.render_task_id, 'existing');
  const again = await generateVideo({ CHE_VIDEO_GEN_URL: 'https://renderer.example' }, storage, body, fetcher);
  assert.equal(again.duplicate, true);
  assert.equal(again.item.id, first.item.id);
  assert.equal(starts, 0, 'finalizing never starts a second video');
});
