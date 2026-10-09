import assert from 'node:assert/strict';
import test from 'node:test';
import { runVideoLine, topicKey } from './video_line.js';

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
        return new Response(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109]), {
          headers: { 'content-type': 'video/mp4', 'content-length': '12' },
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
    { accessToken: 'token', uploads: {} },
  );
  assert.equal(out.ok, true);
  assert.equal(out.board[0].media_url, 'https://cdn.example/rome.mp4');
  assert.equal(out.board[0].link, 'https://www.youtube.com/watch?v=abc123');
});

test('no connected YouTube token means no upload, and the same file is never uploaded twice', async () => {
  const renderFetch = async (url, options = {}) => {
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
      return new Response(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109]), { headers: { 'content-type': 'video/mp4', 'content-length': '12' } });
    }
    if (target.includes('uploadType=resumable')) {
      assert.equal(options.headers.authorization, 'Bearer owner-token');
      return new Response('', { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=u2' } });
    }
    if (target.includes('upload_id=u2')) return new Response(JSON.stringify({ id: 'vid2' }), { headers: { 'content-type': 'application/json' } });
    return new Response('', { status: 404 });
  };
  const env = { CHE_TREND_URLS: 'https://feeds.example/top', CHE_VIDEO_RENDER_URL: 'https://render.example/video' };
  const none = await runVideoLine(env, renderFetch, { accessToken: '', uploads: {} });
  assert.equal(none.ok, false);
  assert.equal(none.stage, 'upload');
  assert.match(none.error, /not connected/i);

  const uploads = {};
  const first = await runVideoLine(env, renderFetch, { accessToken: 'owner-token', uploads });
  assert.equal(first.ok, true);
  assert.equal(uploads[topicKey('Why Rome fell')].link, 'https://www.youtube.com/watch?v=vid2');
  const second = await runVideoLine(env, renderFetch, { accessToken: 'owner-token', uploads });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.board[0].link, 'https://www.youtube.com/watch?v=vid2');
});

test('a topic that is already being produced is refused until its reservation goes stale', async () => {
  const env = { CHE_TREND_URLS: 'https://feeds.example/top', CHE_VIDEO_RENDER_URL: 'https://render.example/video' };
  const feed = async (url) => String(url).includes('feeds.example')
    ? { ok: true, text: async () => '<rss><channel><item><title>Why Rome fell</title></item></channel></rss>' }
    : new Response('', { status: 404 });
  const busy = { [topicKey('Why Rome fell')]: { status: 'rendering', at: new Date().toISOString() } };
  const refused = await runVideoLine(env, feed, { accessToken: 'owner-token', uploads: busy });
  assert.equal(refused.ok, false);
  assert.equal(refused.stage, 'busy');
  const stale = { [topicKey('Why Rome fell')]: { status: 'rendering', at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() } };
  const retried = await runVideoLine(env, feed, { accessToken: 'owner-token', uploads: stale });
  assert.notEqual(retried.stage, 'busy', 'a stale reservation does not block a retry');
});

test('MoneyPrinter Office preserves a pending render ID and resumes the same job without starting another video', async () => {
  const uploads = {};
  let started = 0, finished = false, uploaded = 0;
  const env = { CHE_TREND_URLS: 'https://feeds.example/top', CHE_VIDEO_GEN_URL: 'https://renderer.example' };
  const fetcher = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('feeds.example')) return { ok: true, text: async () => '<rss><channel><item><title>Why Rome fell</title></item></channel></rss>' };
    if (target.endsWith('/api/v1/videos')) { started++; return new Response(JSON.stringify({ data: { task_id: 'persistent1' } })); }
    if (target.includes('/api/v1/tasks/persistent1'))
      return new Response(JSON.stringify(finished ? { data: { videos: ['https://cdn.example/rome.mp4'] } } : { data: { state: 1 } }));
    if (target.includes('cdn.example')) return new Response(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109]));
    if (target.includes('uploadType=resumable')) {
      uploaded++;
      return new Response('', { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=p1' } });
    }
    if (target.includes('upload_id=p1')) return new Response(JSON.stringify({ id: 'confirmed' }));
    return new Response('', { status: 404 });
  };
  const youtube = { accessToken: 'owner-token', uploads };
  const first = await runVideoLine(env, fetcher, youtube);
  assert.equal(first.ok, true);
  assert.equal(first.pending, true);
  assert.equal(first.task_id, 'persistent1');
  assert.equal(uploads[topicKey('Why Rome fell')].task_id, 'persistent1');
  assert.equal(uploaded, 0);
  const second = await runVideoLine(env, fetcher, youtube);
  assert.equal(second.pending, true);
  assert.equal(started, 1);
  finished = true;
  const third = await runVideoLine(env, fetcher, youtube);
  assert.equal(third.ok, true);
  assert.equal(third.pending, undefined);
  assert.equal(third.board[0].link, 'https://www.youtube.com/watch?v=confirmed');
  assert.equal(started, 1);
  assert.equal(uploaded, 1);
});
