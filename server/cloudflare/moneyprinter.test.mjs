import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyPrinterStatus, moneyPrinterVideo } from './moneyprinter.js';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('MoneyPrinter accepts a server root, uses /api/v1 and returns a finished media receipt', async () => {
  const seen = [];
  const result = await moneyPrinterVideo(
    { CHE_VIDEO_GEN_URL: 'https://renderer.example' },
    'printing press',
    async (url) => {
      seen.push(String(url));
      return String(url).endsWith('/api/v1/videos')
        ? reply({ data: { task_id: 't1' } })
        : reply({ data: { videos: ['https://cdn.example/v.mp4'] } });
    },
  );
  assert.equal(result.media_url, 'https://cdn.example/v.mp4');
  assert.deepEqual(seen, [
    'https://renderer.example/api/v1/videos',
    'https://renderer.example/api/v1/tasks/t1',
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
    async () => reply({ data: { videos: ['https://cdn.example/done.mp4'] } }),
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
