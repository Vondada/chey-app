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

test('a file URL and YouTube id become the board link', async () => {
  const out = await runVideoLine(
    { CHE_TREND_URLS: 'https://feeds.example/top', CHE_VIDEO_RENDER_URL: 'https://render.example/video', CHE_YOUTUBE_TOKEN: 'token' },
    async (url) => {
      const target = String(url);
      if (target.includes('feeds.example')) {
        return { ok: true, text: async () => '<rss><channel><item><title>Why Rome fell</title></item></channel></rss>' };
      }
      if (target.includes('render.example')) {
        return { ok: true, json: async () => ({ media_url: 'https://cdn.example/rome.mp4' }), text: async () => '' };
      }
      return { ok: true, json: async () => ({ id: 'abc123' }), text: async () => '' };
    },
  );
  assert.equal(out.ok, true);
  assert.equal(out.board[0].link, 'https://www.youtube.com/watch?v=abc123');
});
