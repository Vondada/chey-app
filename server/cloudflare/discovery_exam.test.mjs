// The autonomy exam, run against THIS repository's real files: CHE's
// deterministic discovery (no model) must map a named utility and the whole
// War Room feature, app to server, without picking dead copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { explicitPaths, rankSourcePaths, traceSourceGraph } from './self_development.js';

const ROOT = new URL('../../', import.meta.url).pathname;
function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(dir, name);
    if (/node_modules|\.dart_tool|build$|three\.min\.js$/.test(path)) continue;
    if (statSync(join(ROOT, path)).isDirectory()) walk(path, out);
    else if (/\.(?:dart|m?js|html)$/.test(name)) out.push(relative(ROOT, join(ROOT, path)));
  }
  return out;
}
const PATHS = ['lib', 'assets/office3d', 'server/cloudflare', 'test'].flatMap((d) => walk(d));
const TEXT = new Map(PATHS.map((p) => [p, readFileSync(join(ROOT, p), 'utf8')]));
const index = { paths: PATHS, editable_paths: PATHS };
const env = { CHE_GITHUB_TOKEN: 't', CHE_GITHUB_REPO: 'o/r' };
// GitHub code search emulated over the real files (exact, case-insensitive).
const fetcher = async (url) => {
  const q = decodeURIComponent(String(url).split('q=')[1]).split('" repo:')[0].replace(/^"/, '').toLowerCase();
  return { ok: true, json: async () => ({ items: PATHS.filter((p) => TEXT.get(p).toLowerCase().includes(q)).map((path) => ({ path })) }) };
};
const read = async (p) => TEXT.get(p) ?? null;
const run = (request) => {
  const named = explicitPaths(request, new Set(PATHS));
  const seeds = named.length ? named : rankSourcePaths(index.editable_paths, request, 6);
  return traceSourceGraph(env, { index, request, seeds, read, fetcher });
};

test('exam (simple): a named utility, its test and its callers', async () => {
  const g = await run('Make lib/che_stream_batcher.dart flush partial replies sooner.');
  const file = g.files.find((f) => f.path === 'lib/che_stream_batcher.dart');
  assert.equal(file.live, true);
  assert.ok(file.tests.includes('test/che_stream_batcher_test.dart'));
  assert.ok(file.callers.includes('lib/main.dart'));
  assert.ok(file.callers.includes('lib/che_speech_chunker.dart'));
  assert.equal(g.files.length, 1, 'a named file is not padded with unrelated guesses');
});

test('exam (complex): the live War Room from screen to Worker routes, the dead HTML copy excluded', async () => {
  const g = await run('Update the existing War Room in CHE. Improve its immersive 3D-room feel and make the central table/orb feel more alive with subtle animation.');
  const at = (p) => g.files.find((f) => f.path === p);
  assert.equal(at('lib/agents/che_war_room_screen.dart').live, true);
  assert.ok(at('lib/agents/che_war_room_screen.dart').callers.includes('lib/agents/che_office_floor_screen.dart'));
  assert.equal(at('lib/widgets/che_native_scene_world.dart').live, true, 'the real 3D renderer');
  assert.ok(at('lib/widgets/che_native_scene_world.dart').tests.includes('test/che_native_scene_world_test.dart'));
  assert.equal(at('lib/agents/che_agent_runtime.dart').live, true, 'the data controller/client');
  assert.ok(g.dead.includes('assets/office3d/warroom.html'), 'nothing loads the HTML page');
  assert.equal(g.contradiction, false);
  const convene = g.api.find((a) => a.client_method === 'convene');
  assert.equal(convene.route, '/api/meetings');
  assert.equal(convene.http, 'POST');
  assert.ok(convene.server.some((r) => r.server_file === 'server/cloudflare/worker.js' && r.handlers.some((h) => h.fn === 'conveneMeeting' && h.module === 'server/cloudflare/agent_runtime.js')));
  const meeting = g.api.find((a) => a.client_method === 'meeting');
  assert.equal(meeting.route, '/api/meetings/$id');
  assert.ok(meeting.server.some((r) => /\\\/api\\\/meetings\\\//.test(r.route)), 'the regex route is found too');
});
