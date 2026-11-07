// A film's GitHub assembly and Kaggle GPU session fetch from the origin CHE stored in `film:base`. On 2026-11-07 a film
// started by a probe chat turn stored the synthetic https://che.internal, and the runner failed with
// "Could not resolve host: che.internal" before rendering anything. Only a public https origin may be used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicOrigin, startFilmRender } from './film_render.js';

test('only a public https origin is an address the runners can reach', () => {
  assert.equal(publicOrigin('https://chey-app.henryjavoni.workers.dev/api/chat'), 'https://chey-app.henryjavoni.workers.dev');
  for (const bad of ['https://che.internal/api/chat', 'http://chey-app.henryjavoni.workers.dev/', 'https://localhost/x', 'https://127.0.0.1/',
    'https://[::1]/', 'https://box.local/', 'https://single/', 'not a url', '', null, undefined]) {
    assert.equal(publicOrigin(bad), '', String(bad));
  }
});

test('the assembly is never dispatched to an unreachable address; it waits and says why', async () => {
  let called = false;
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const out = await startFilmRender(env, { id: 'fgha_x', segments: 1 }, { base: 'https://che.internal', token: 'k' }, async () => { called = true; return new Response(null, { status: 204 }); });
  assert.equal(called, false, 'GitHub is not asked to run a job that cannot fetch its files');
  assert.equal(out.ok, false);
  assert.equal(out.retryable, true);
  assert.match(out.error, /public address/);
  let sent = null;
  const ok = await startFilmRender(env, { id: 'fgha_x', segments: 1 }, { base: 'https://chey-app.henryjavoni.workers.dev', token: 'k' }, async (_u, init) => { sent = JSON.parse(init.body); return new Response(null, { status: 204 }); });
  assert.equal(ok.ok, true);
  assert.equal(sent.inputs.source, 'https://chey-app.henryjavoni.workers.dev');
});

test('the Worker stores and reads only a public film base, and the probe turn carries the real origin', () => {
  const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(src, /if \(request && publicOrigin\(request\.url\)\) \{ try \{ await storage\.put\('film:base', publicOrigin\(request\.url\)\)/);
  assert.match(src, /base: publicOrigin\(await storage\.get\('film:base'\)\)/);
  assert.doesNotMatch(src, /storage\.put\('film:base', new URL\(request\.url\)\.origin\)/);
});
