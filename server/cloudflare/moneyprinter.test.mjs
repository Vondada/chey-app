import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyPrinterVideo } from './moneyprinter.js';
const env = { CHE_VIDEO_GEN_URL: 'https://renderer.example/api/v1' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
test('MoneyPrinter returns only a successful HTTP media receipt', async () => {
  const result = await moneyPrinterVideo(env, 'printing press', async url => String(url).endsWith('/videos')
    ? reply({ data: { task_id: 't1' } }) : reply({ data: { videos: ['https://cdn.example/v.mp4'] } }));
  assert.equal(result.media_url, 'https://cdn.example/v.mp4');
});
test('MoneyPrinter distinguishes pending, failed and unreachable jobs', async () => {
  for (const [status, data, pending] of [[200, {}, true], [500, { url: 'https://cdn.example/error' }, false], [200, { data: { state: -1 } }, false]]) {
    const result = await moneyPrinterVideo(env, 'printing press', async url => String(url).endsWith('/videos') ? reply({ task_id: 't1' }) : reply(data, status));
    assert.equal(result.pending === true, pending); assert.equal(result.media_url, undefined);
  }
  const failed = await moneyPrinterVideo(env, 'printing press', async () => { throw new Error('offline'); });
  assert.equal(failed.ok, false);
});
