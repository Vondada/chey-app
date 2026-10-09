import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyPrinterStatus, moneyPrinterVideo } from './moneyprinter.js';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const mp4 = () => new Response(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]),
  { headers: { 'content-type': 'video/mp4' } });

test('MoneyPrinter accepts a server root, uses /api/v1 and returns a finished media receipt', async () => {
  const seen = [];
  const result = await moneyPrinterVideo(
    { CHE_VIDEO_GEN_URL: 'https://renderer.example' },
    'printing press',
    async (url) => {
      seen.push(String(url));
      return String(url).endsWith('/api/v1/videos')
        ? reply({ data: { task_id: 't1' } })
        : String(url).endsWith('/api/v1/tasks/t1')
          ? reply({ data: { videos: ['https://cdn.example/v.mp4'] } })
          : mp4();
    },
  );
  assert.equal(result.media_url, 'https://cdn.example/v.mp4');
  assert.deepEqual(seen, [
    'https://renderer.example/api/v1/videos',
    'https://renderer.example/api/v1/tasks/t1',
    'https://cdn.example/v.mp4',
  ]);
});

test('MoneyPrinter preserves an explicit /api/v1 base and exposes pending task polling', async () => {
  const env = { CHE_VIDEO_GEN_URL: 'https://renderer.example/api/v1' };
  const pending = await moneyPrinterVideo(
    env,
    'printing press',
    async (url) => String(url).endsWith('/videos')
      ? reply({ task_id: 't1' })
      : reply({ data: { state: 1 } }),
  );
  assert.equal(pending.ok, true);
  assert.equal(pending.pending, true);
  assert.equal(pending.task_id, 't1');

  const done = await moneyPrinterStatus(
    env,
    't1',
    async (url) => String(url).includes('cdn.example') ? mp4() : reply({ data: { videos: ['https://cdn.example/done.mp4'] } }),
  );
  assert.equal(done.media_url, 'https://cdn.example/done.mp4');
});

test('MoneyPrinter distinguishes failed and unreachable jobs', async () => {
  const env = { CHE_VIDEO_GEN_URL: 'https://renderer.example/api/v1' };
  const failed = await moneyPrinterStatus(env, 't1', async () => reply({ data: { state: -1 } }));
  assert.equal(failed.ok, false);
  const offline = await moneyPrinterVideo(env, 'printing press', async () => { throw new Error('offline'); });
  assert.equal(offline.ok, false);
});

test('MoneyPrinter never reports a missing or HTML preview as an MP4', async () => {
  const env = { CHE_VIDEO_GEN_URL: 'https://renderer.example' };
  const out = await moneyPrinterStatus(env, 'fake', async (url) =>
    String(url).includes('cdn.example')
      ? new Response('<html>Not a video</html>', { headers: { 'content-type': 'text/html' } })
      : reply({ data: { videos: ['https://cdn.example/missing.mp4'] } }));
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'verify');
  assert.equal(out.media_url, undefined);
});

test('verification accepts a valid MP4 header split across stream chunks', async () => {
  const { verifyVideoMedia } = await import('./moneyprinter.js');
  const chunks = [Uint8Array.from([0,0,0,24]), Uint8Array.from([102,116,121,112]), Uint8Array.from([105,115,111,109])];
  const result = await verifyVideoMedia('https://cdn.example/real.mp4',
    async () => new Response(new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
      },
    })));
  assert.equal(result.ok, true);
});
test('MoneyPrinter translates different requested durations into different paragraph counts', async () => {
  const sent = [];
  const fetcher = async (url, options) => {
    if (String(url).endsWith('/api/v1/videos')) {
      sent.push(JSON.parse(options.body));
      return reply({ data: { task_id: 'still-rendering' } });
    }
    return reply({ data: { state: 1 } });
  };
  for (const seconds of [5, 15, 120])
    await moneyPrinterVideo({ CHE_VIDEO_GEN_URL: 'https://renderer.example' }, 'Space video', fetcher, { seconds });
  assert.deepEqual(sent.map(x=>x.paragraph_number), [1,3,24]);
});
