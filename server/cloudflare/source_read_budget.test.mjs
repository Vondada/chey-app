// R-16 and the owner's app audit (2026-11-06, run 42176288358): a broad source question answered HTTP 500. One
// inspection read about 60 files, over the 50 subrequests Cloudflare allows per invocation on CHE's plan. The
// inspection now has one read budget, and the chat turn reports a failed read instead of throwing.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { SOURCE_READ_BUDGET, inspectRepositoryContext } from './self_development.js';

const ROOT = new URL('../../', import.meta.url).pathname;
function walk(dir, out = []) {
  for (const name of readdirSync(`${ROOT}${dir}`)) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'build') continue;
    const rel = `${dir}/${name}`;
    if (statSync(`${ROOT}${rel}`).isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}
const PATHS = ['lib', 'server/cloudflare', 'test'].flatMap((d) => walk(d));

function github(calls) {
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  return async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/git/ref/heads/')) return json({ object: { sha: 'a'.repeat(40) } });
    if (u.includes('/git/trees/')) return json({ tree: PATHS.map((p) => ({ type: 'blob', path: p })) });
    if (u.includes('/contents/')) {
      const f = decodeURIComponent(u.split('/contents/')[1].split('?')[0]);
      try { return json({ content: Buffer.from(readFileSync(`${ROOT}${f}`, 'utf8')).toString('base64'), sha: 'b'.repeat(40), type: 'file' }); } catch { return json({ message: 'Not Found' }, 404); }
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return json({ default_branch: 'main' });
    return json({ message: 'Not Found' }, 404);
  };
}
const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app' };

for (const ask of [
  "Jay, do a complete audit of the CHE app's screens and navigation. Find every screen and navigation path that can show a grey error box or break, with the file and line and the cause. Audit only: do not open a pull request.",
  'How does your memory code work? Explain it in plain English, do not create a job.',
]) {
  test(`one inspection on CHE's real file tree stays under Cloudflare's 50 subrequests: "${ask.slice(0, 40)}…"`, async () => {
    const calls = [];
    const r = await inspectRepositoryContext(env, ask, github(calls), { trace: true });
    assert.equal(r.ok, true);
    const reads = calls.filter((u) => u.includes('/contents/')).length;
    assert.ok(reads <= SOURCE_READ_BUDGET, `${reads} file reads (budget ${SOURCE_READ_BUDGET})`);
    assert.ok(calls.length <= 40, `${calls.length} GitHub requests in one inspection; the plan allows 50 per invocation`);
    assert.ok(r.files.length >= 10, 'the budget still leaves real evidence to answer from');
  });
}

// The memory reset itself (log capture run 42176827333): the code index downloaded the whole ~90 MB repository
// tarball into a 128 MB Durable Object. The download is now a bounded stream.
import { MAX_TARBALL_BYTES, boundedBody, buildCodeIndex } from './code_index.js';

function streamOf(totalBytes, chunk = 1024 * 1024) {
  let sent = 0; let cancelled = false;
  const body = new ReadableStream({
    pull(c) { if (sent >= totalBytes) { c.close(); return; } const n = Math.min(chunk, totalBytes - sent); sent += n; c.enqueue(new Uint8Array(n)); },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body), stats: () => ({ sent, cancelled }) };
}

test('a download larger than the cap is cancelled part way and nothing is returned', async () => {
  const { response, stats } = streamOf(90 * 1024 * 1024);
  assert.equal(await boundedBody(response, MAX_TARBALL_BYTES), null);
  assert.equal(stats().cancelled, true, 'the rest of the 90 MB is never read');
  assert.ok(stats().sent <= MAX_TARBALL_BYTES + 2 * 1024 * 1024, `read ${stats().sent} bytes before stopping`);
  const declared = new Response('x', { headers: { 'content-length': String(MAX_TARBALL_BYTES + 1) } });
  assert.equal(await boundedBody(declared, MAX_TARBALL_BYTES), null, 'a declared size over the cap is refused before reading');
});

test('a small download is returned whole, and an oversized repository tarball builds no index (callers read single files)', async () => {
  const small = await boundedBody(new Response(new Uint8Array([1, 2, 3])), MAX_TARBALL_BYTES);
  assert.deepEqual([...new Uint8Array(small)], [1, 2, 3]);
  const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'Vondada/chey-app' };
  const big = await buildCodeIndex(env, 'a'.repeat(40), async () => streamOf(90 * 1024 * 1024).response);
  assert.equal(big, null);
});
