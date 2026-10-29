// The certification probe's owner chat route (POST /api/probe/chat). It must be behind the probe token like /api/probe/modal,
// reach the owner's own /api/chat path, and never be open to a guest profile. Checked against the source, offline.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

test('POST /api/probe/chat returns 404 unless the probe token is presented, like /api/probe/modal', () => {
  assert.match(
    source,
    /path === '\/api\/probe\/chat' && request\.method === 'POST'\) \{\s*if \(!voiceProbeAuthorized\(request, env\)\) return json\(\{ detail: 'Not found\.' \}, 404\);/,
  );
  assert.match(source, /path === '\/api\/probe\/modal' && request\.method === 'POST'\) return voiceProbeAuthorized\(request, env\)/);
});

test('the probe route runs the owner object chat turn, not a second reasoning path', () => {
  assert.match(source, /return json\(await env\.CHE_STATE\.getByName\('owner'\)\.probeChat\(body\)\);/);
  const start = source.indexOf('  async probeChat(body = {}) {');
  const method = source.slice(start, source.indexOf('execution_receipts: receipts };', start) + 'execution_receipts: receipts };'.length);
  assert.ok(method.includes('return { ok: response.ok'), 'the method body is found');
  assert.match(method, /this\.fetch\(request\)/, 'the turn goes through the owner object fetch, the same path as /api/chat');
  assert.match(method, /new Request\('https:\/\/che\.internal\/api\/chat'/);
  assert.doesNotMatch(method, /callModel|runChat|reasonAbout/, 'no separate model call is made by the probe');
});

test('the probe turn is authorised as the owner only through its own marker, and does not grow the owner brain', () => {
  assert.match(source, /const PROBE_CHAT_REQUESTS = new WeakSet\(\);/);
  assert.match(source, /const probeChat = PROBE_CHAT_REQUESTS\.has\(request\) && path === '\/api\/chat';/);
  assert.match(source, /const ownerInternal = workflowStep \|\| probeChat;/);
  assert.match(source, /const probeRun = isChat && \(isMemoryProbeRequest\(request, this\.env\) \|\| PROBE_CHAT_REQUESTS\.has\(request\)\);/);
});

test('the probe route is absent from the guest allow-list', () => {
  const guest = source.slice(source.indexOf('export function guestRouteAllowed'), source.indexOf('// The second half of a combined'));
  assert.ok(guest.length > 0, 'guestRouteAllowed is found');
  assert.doesNotMatch(guest, /api\/probe/, 'no probe route is open to a guest profile');
  assert.doesNotMatch(guest, /probe/i);
});
