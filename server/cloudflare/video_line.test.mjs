import assert from 'node:assert/strict';
import test from 'node:test';
import { runVideoLine } from './video_line.js';

test('missing renderer does not invent an upload', async () => {
  const out = await runVideoLine(
    { CHE_TREND_URLS: 'https://feeds.example/top' },
    async (url) => {
      if (String(url).includes('feeds.example')) {
        return { ok: true, text: async () => '<rss><channel><item><title>Why Rome fell</title></item></channel></rss>' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'render');
  assert.equal(out.board[0].status, 'script_only');
  assert.equal(out.board[0].link, undefined);
});

test('a real media stream and YouTube id preserve both the file and watch link', async () => {
  const out = await runVideoLine(
    {
      CHE_TREND_URLS: 'https://feeds.example/top',
      CHE_VIDEO_RENDER_URL: 'https://render.example/video',
      CHE_YOUTUBE_TOKEN: 'token',
    },
    async (url, options = {}) => {
      const target = String(url);
      if (target.includes('feeds.example')) {
        return { ok: true, text: async () => '<rss><channel><item><title>Why Rome fell</title></item></channel></rss>' };
      }
      if (target.includes('render.example')) {
        return new Response(JSON.stringify({ media_url: 'https://cdn.example/rome.mp4' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('cdn.example')) {
        return new Response(Uint8Array.from([0, 1, 2, 3]), {
          headers: { 'content-type': 'video/mp4', 'content-length': '4' },
        });
      }
      if (target.includes('uploadType=resumable')) {
        assert.equal(options.method, 'POST');
        return new Response('', {
          headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=u1' },
        });
      }
      if (target.includes('upload_id=u1')) {
        assert.equal(options.method, 'PUT');
        return new Response(JSON.stringify({ id: 'abc123' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    },
  );
  assert.equal(out.ok, true);
  assert.equal(out.board[0].media_url, 'https://cdn.example/rome.mp4');
  assert.equal(out.board[0].link, 'https://www.youtube.com/watch?v=abc123');
});
