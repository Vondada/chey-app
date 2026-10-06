import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _clearCodeIndexCache, buildCodeIndex, loadCodeIndex, parseTar } from './code_index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// A real GitHub-style tarball of this repository (top folder + pax header).
const TARBALL = execSync('git -c core.autocrlf=false archive --format=tar.gz --prefix=Vondada-chey-app-abc1234/ HEAD', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
const HEAD_SHA = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
const ENV = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };

function github({ counts = {} } = {}) {
  return async (url) => {
    const u = String(url);
    const kind = u.includes('/tarball/') ? 'tarball' : u.includes('/search/code') ? 'search' : u.includes('/contents/') ? 'contents' : 'other';
    counts[kind] = (counts[kind] || 0) + 1;
    if (kind === 'tarball') return new Response(TARBALL, { status: 200 });
    return new Response('{}', { status: 404 });
  };
}

test('her own index reads the real repository: code in, binaries and minified bundles out, git blob ids exact', async () => {
  _clearCodeIndexCache();
  const index = await buildCodeIndex(ENV, HEAD_SHA, github());
  assert.ok(index.has('lib/main.dart'));
  assert.ok(index.has('server/cloudflare/worker.js'));
  assert.ok(!index.has('assets/office3d/three.min.js'), 'minified bundle skipped');
  assert.ok(!index.has('assets/avatars/che.png'), 'binary skipped');
  const gitBlob = execSync('git rev-parse HEAD:lib/che_stream_batcher.dart', { cwd: ROOT }).toString().trim();
  assert.equal(index.blobSha('lib/che_stream_batcher.dart'), gitBlob);
  const hits = index.search('CheWarRoomScreen');
  assert.ok(hits.includes('lib/agents/che_war_room_screen.dart'));
  assert.ok(hits.includes('lib/agents/che_office_floor_screen.dart'));
  assert.ok(parseTar(new Uint8Array(0)).length === 0);
});

test('one download per commit: saved to storage and reloaded after a restart without downloading again', async () => {
  _clearCodeIndexCache();
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) saved.set(a, b); else saved.set(k, v); }, delete: async (k) => saved.delete(k) };
  const counts = {};
  const first = await loadCodeIndex(storage, ENV, HEAD_SHA, github({ counts }));
  assert.ok(first.size > 100);
  _clearCodeIndexCache(); // the Durable Object restarted
  const again = await loadCodeIndex(storage, ENV, HEAD_SHA, github({ counts }));
  assert.equal(again.size, first.size);
  assert.equal(counts.tarball, 1, 'downloaded once');
  assert.equal(again.blobSha('lib/main.dart'), first.blobSha('lib/main.dart'));
});

test('a coding job runs on her own index: zero GitHub code searches, zero file downloads', async () => {
  _clearCodeIndexCache();
  const { prepareSelfUpdate } = await import('./self_development.js');
  const { AUTONOMY_EXAM, gradeLevel } = await import('./autonomy_exam.js');
  const spec = AUTONOMY_EXAM[2];
  const counts = {};
  const tree = execSync('git ls-tree -r --name-only HEAD', { cwd: ROOT }).toString().trim().split('\n');
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/tarball/')) { counts.tarball = (counts.tarball || 0) + 1; return new Response(TARBALL, { status: 200 }); }
    if (u.includes('/search/code')) { counts.search = (counts.search || 0) + 1; return { ok: false, status: 403, json: async () => ({}) }; }
    if (u.includes('/contents/')) { counts.contents = (counts.contents || 0) + 1; return { ok: false, status: 404, json: async () => ({}) }; }
    if (u.endsWith('/o/r')) return ok({ default_branch: 'main' });
    if (u.includes('/git/ref/')) return ok({ object: { sha: HEAD_SHA } });
    if (u.includes('/git/trees/')) return ok({ tree: tree.map((path) => ({ type: 'blob', path })) });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const SCENE = 'lib/widgets/che_native_scene_world.dart';
  const crew = { run: async (_m, input) => {
    const system = input.messages[0].content;
    const payload = JSON.parse(input.messages[1].content);
    if (system.includes('Architect')) return { response: JSON.stringify({ plan: 'War Room table radius', search_terms: ['War Room', 'table'], paths: ['assets/office3d/warroom.html'] }) };
    if (system.includes('Review')) return { response: JSON.stringify({ approved: true, target_correct: true, notes: [] }) };
    if (!payload.inspected) return { response: JSON.stringify({ plan: 'p', search_terms: ['warRoom'], paths: [SCENE] }) };
    const live = (payload.discovery?.live_files || []).some((f) => f.path === SCENE);
    if (!live) return { response: JSON.stringify({ summary: 'guess', edits: [{ path: 'assets/office3d/warroom.html', find: 'x', replace: 'y' }] }) };
    return { response: JSON.stringify({ summary: 'Larger War Room table', edits: [{ path: SCENE, find: '            bottomRadius: 2.55,\n            topRadius: 2.55,', replace: '            bottomRadius: 2.7,\n            topRadius: 2.7,' }] }) };
  } };
  const out = await prepareSelfUpdate({ ...ENV, AI: crew }, spec.request, fetcher, null, { intentRequest: spec.request });
  const grade = gradeLevel(spec, out);
  assert.equal(grade.passed, true, `${out.detail || ''} ${JSON.stringify(grade.failed_checks)}`);
  assert.equal(counts.search || 0, 0, 'no GitHub code search used');
  assert.equal(counts.contents || 0, 0, 'no per-file downloads');
  assert.equal(counts.tarball, 1);
  const gitBlob = execSync(`git rev-parse HEAD:${SCENE}`, { cwd: ROOT }).toString().trim();
  assert.equal(out.proposal.base_files[SCENE], gitBlob, 'stale-source protection keeps GitHub\'s real blob id');
});
