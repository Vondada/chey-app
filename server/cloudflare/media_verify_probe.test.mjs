// The owner probe's read-only Gallery check: a bad id is refused, the route is token-gated and calls the owner object,
// and the module writes nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mediaVerifyProbe } from './media_verify_probe.js';

test('a missing or malformed id is refused before anything is read', async () => {
  assert.equal((await mediaVerifyProbe({}, null, {})).status, 400);
  assert.equal((await mediaVerifyProbe({}, null, { id: '../../etc' })).status, 400);
});

test('the module only reads: no put, delete or write calls', () => {
  const src = readFileSync(new URL('./media_verify_probe.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.put\(|\.delete\(|\.set\(|fetch\(/);
});

test('the probe route is token-gated and calls the owner object', () => {
  const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(src, /if \(path === '\/api\/probe\/media\/verify' && request\.method === 'POST'\) \{\n\s+if \(!voiceProbeAuthorized\(request, env\)\) return json\(\{ detail: 'Not found\.' \}, 404\);/);
  assert.match(src, /getByName\('owner'\)\.mediaVerify\(body\)/);
});
