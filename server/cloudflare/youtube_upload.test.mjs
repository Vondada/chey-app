import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadYouTube } from './youtube_upload.js';

test('YouTube uploader sends the rendered media stream through a resumable session', async () => {
  const calls = [];
  const result = await uploadYouTube(
    { media_url: 'https://cdn.example/video.mp4', title: 'A real video' },
    'token',
    async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      if (String(url).includes('cdn.example')) {
        return new Response(Uint8Array.from([1, 2, 3]), {
          headers: { 'content-type': 'video/mp4', 'content-length': '3' },
        });
      }
      if (String(url).includes('uploadType=resumable')) {
        return new Response('', {
          headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test' },
        });
      }
      return new Response(JSON.stringify({ id: 'vid1' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.link, 'https://www.youtube.com/watch?v=vid1');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'PUT']);
});

test('YouTube uploader rejects an unsafe upload-session redirect', async () => {
  const result = await uploadYouTube(
    { media_url: 'https://cdn.example/video.mp4', title: 'A real video' },
    'token',
    async (url) => String(url).includes('cdn.example')
      ? new Response(Uint8Array.from([1]), { headers: { 'content-type': 'video/mp4' } })
      : new Response('', { headers: { location: 'https://evil.example/upload' } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /upload session/i);
});

test('YouTube uploader refuses to upload without a connected access token', async () => {
  let called = false;
  const result = await uploadYouTube({ media_url: 'https://cdn.example/video.mp4', title: 'x' }, '', async () => {
    called = true;
    return new Response('');
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not connected/i);
  assert.equal(called, false);
});
