// CHE Creator Studio (owner issue #347): the original series bible, the 40-second vertical
// pilot, per-platform export profiles, the growth record, and the owner's spoken routes through
// the real /api/chat. Offline: GitHub and YouTube are fakes that record every call, so a test can
// prove nothing was rendered, uploaded or posted without the right step and the owner's yes.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import {
  EXPORT_PROFILES, LAYOUT, PILOT, SAFE_ZONE, SERIES_BIBLE, SOURCES, boxInSafeZone, exportPackage, platformsIn,
  referenceTermsIn, studioChatIntent, studioRenderSpec, validateBible, validateEpisode,
} from './creator_studio.js';
import { mp4Facts, startGithubVideo } from './github_video_renderer.js';
import { sealToken } from './youtube_connection.js';

// Every network call lands here. A test installs `net.route` to answer GitHub or YouTube.
const net = { calls: [], route: null };
globalThis.fetch = async (input, options = {}) => {
  const url = String(input?.url || input);
  net.calls.push({ url, method: options.method || 'GET', body: options.body });
  const answer = net.route && await net.route(url, options);
  if (answer) return answer;
  throw new TypeError(`fetch failed (offline test: ${new URL(url).host})`);
};

const generated = new URL('./.creator_studio.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

const GITHUB = { CHE_GITHUB_TOKEN: 'ghp_test_only', CHE_GITHUB_REPO: 'Vondada/chey-app' };
const GOOGLE = { CHE_OAUTH_SECRET: 's'.repeat(40), CHE_YOUTUBE_CLIENT_ID: 'client.test', CHE_YOUTUBE_CLIENT_SECRET: 'secret.test' };

async function owner({ env: extra = {} } = {}) {
  const saved = new Map();
  const inputs = [];
  const pending = [];
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', ...extra,
    AI: { run: async (_model, input) => { inputs.push(input); return { response: 'MODEL ANSWERED' }; } },
  };
  const state = new CheState({ storage: storageFor(saved), waitUntil: (p) => pending.push(p) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST') => worker.fetch(new Request(`https://che.example${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  const say = async (message, { fresh = false } = {}) => {
    const before = inputs.length;
    const raw = await (await send('/api/chat', { message, history: fresh ? [] : history.slice(-6) }, token)).text();
    while (pending.length) await pending.shift();
    let held = null;
    try { held = JSON.parse(raw); } catch (_) { held = null; }
    const done = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((e) => e?.type === 'done') || {};
    const reply = held?.message || replyFromNdjson(raw);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { route: held?.held_for_owner ? 'held' : done.source || (inputs.length > before ? 'model' : 'none'), done, reply, modelCalls: inputs.length - before };
  };
  const get = async (path) => (await send(path, null, token, 'GET')).json();
  return { say, get, saved, env };
}

// ── A fake GitHub renderer and YouTube, recording what CHE asked of them ──
const enc = (v) => new TextEncoder().encode(v);
function concat(chunks) { const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out; }
function box(type, ...parts) {
  const payload = concat(parts.map((p) => (p instanceof Uint8Array ? p : enc(p))));
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length); out.set(enc(type), 4); out.set(payload, 8);
  return out;
}
function tkhd(width, height) {
  const body = new Uint8Array(84); const v = new DataView(body.buffer);
  v.setUint32(76, width * 65536); v.setUint32(80, height * 65536);
  return box('tkhd', body);
}
function mp4({ seconds = 40, width = 1080, height = 1920 } = {}) {
  const mvhd = new Uint8Array(100); const v = new DataView(mvhd.buffer); v.setUint32(12, 1000); v.setUint32(16, seconds * 1000);
  return concat([box('ftyp', 'isom', new Uint8Array(4)), box('moov', box('mvhd', mvhd),
    box('trak', tkhd(width, height), box('stsd', 'avc1')), box('trak', tkhd(0, 0), box('stsd', 'mp4a')))]);
}
function storedZip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const path = enc(name), data = content instanceof Uint8Array ? content : enc(content);
    const local = new Uint8Array(30 + path.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, path.length, true); local.set(path, 30);
    const dir = new Uint8Array(46 + path.length), cv = new DataView(dir.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, path.length, true); cv.setUint32(42, offset, true); dir.set(path, 46);
    locals.push(local, data); central.push(dir); offset += local.length + data.length;
  }
  const directory = concat(central), end = new Uint8Array(22), v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, central.length, true); v.setUint16(10, central.length, true); v.setUint32(12, directory.length, true); v.setUint32(16, offset, true);
  return concat([...locals, directory, end]);
}
const png = (() => { const b = new Uint8Array(32); b.set([137, 80, 78, 71, 13, 10, 26, 10]); const v = new DataView(b.buffer); v.setUint32(16, 1280); v.setUint32(20, 720); return b; })();
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakePlatforms({ video = mp4(), views = '1234' } = {}) {
  const seen = { dispatches: [], uploads: 0, sessions: 0, stats: 0, done: false };
  net.calls = [];
  net.route = async (url, options) => {
    if (url.endsWith('/actions/workflows/che-video-render.yml/dispatches')) {
      seen.dispatches.push(JSON.parse(options.body).inputs);
      return new Response(null, { status: 204 });
    }
    const job = seen.dispatches.at(-1)?.job_id;
    if (url.includes('/actions/workflows/che-video-render.yml/runs')) {
      return json({ workflow_runs: job && seen.done ? [{ display_title: `CHE free render ${job}`, status: 'completed', conclusion: 'success', id: 56 }] : [] });
    }
    if (url.includes('/actions/runs/56/artifacts')) return json({ artifacts: [{ name: `che-video-${job}`, id: 77, expired: false }] });
    if (url.includes('/actions/artifacts/77/zip')) {
      const manifest = { status: 'verified', title: 'Confident, Not Correct', description: 'Pilot.', duration_seconds: 40, video_width: 1080, video_height: 1920, format: '9:16', episode: 'S1E1', youtube_uploaded: false };
      return new Response(storedZip({ 'video.mp4': video, 'thumbnail.png': png, 'manifest.json': JSON.stringify(manifest) }));
    }
    if (url === 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc') {
      seen.uploads += 1;
      seen.uploadedBytes = options.body?.length || 0;
      return json({ id: 'pilotVid123' });
    }
    if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable')) {
      seen.sessions += 1;
      seen.metadata = JSON.parse(options.body);
      return new Response('{}', { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc' } });
    }
    if (url.startsWith('https://www.googleapis.com/youtube/v3/videos?part=statistics')) {
      seen.stats += 1;
      return json({ items: [{ id: 'pilotVid123', statistics: { viewCount: views, likeCount: '56', commentCount: '7' } }] });
    }
    return null;
  };
  return seen;
}

async function connectYouTube(che) {
  const data = che.saved.get('che');
  data.youtube = {
    status: 'connected', channel_id: 'UC_test', channel_title: 'Vondada Test Channel', connected_at: new Date().toISOString(),
    refresh: await sealToken(che.env, 'refresh-token-test'), access: await sealToken(che.env, 'access-token-test'), access_expires_at: Date.now() + 3600_000,
  };
  che.saved.set('che', data);
}

const googleCalls = () => net.calls.filter((c) => c.url.includes('googleapis.com'));
const githubDispatches = () => net.calls.filter((c) => c.url.endsWith('/dispatches'));

// ─── 1. The series bible and the pilot spec ───────────────────────────────

test('the series bible is original, complete and copyright-safe', () => {
  assert.deepEqual(validateBible(), { ok: true, errors: [] });
  assert.ok(SERIES_BIBLE.cast.length >= 3);
  assert.deepEqual(referenceTermsIn(SERIES_BIBLE), [], 'no name, character or title from the reference videos');
  assert.deepEqual(referenceTermsIn(PILOT), []);
  assert.equal(SERIES_BIBLE.episode_format.beats[0].id, 'hook');
  // A borrowed name or a character the renderer cannot draw is refused.
  const borrowed = { ...SERIES_BIBLE, cast: [...SERIES_BIBLE.cast, { ...SERIES_BIBLE.cast[0], id: 'lobby', name: 'Lobby' }] };
  assert.match(validateBible(borrowed).errors.join(' '), /reference material: lobby/);
  const undrawable = { ...SERIES_BIBLE, cast: SERIES_BIBLE.cast.map((c, i) => (i ? c : { ...c, prop: 'sword' })) };
  assert.match(validateBible(undrawable).errors.join(' '), /nia has no prop/);
});

test('the pilot is a 30-45 second vertical episode whose every fact cites a source the team read', () => {
  const check = validateEpisode();
  assert.equal(check.ok, true, check.errors.join(' '));
  assert.equal(check.seconds, 40);
  assert.equal(PILOT.width * 16, PILOT.height * 9);
  const known = new Set(SOURCES.map((s) => s.id));
  for (const s of PILOT.scenes) for (const f of s.facts || []) assert.ok(f.sources.every((id) => known.has(id)), f.text);
  for (const s of SOURCES) assert.ok(s.url.startsWith('https://') && s.quotes.length && s.read_on, s.id);
  const broken = (change) => validateEpisode({ ...PILOT, ...change }).errors.join(' ');
  assert.match(broken({ seconds: 50 }), /30 to 45 seconds/);
  assert.match(broken({ width: 1920, height: 1080 }), /vertical 9:16/);
  const scenes = (i, change) => ({ scenes: PILOT.scenes.map((s, n) => (n === i ? { ...s, ...change } : s)) });
  assert.match(broken(scenes(0, { seconds: 4 })), /add up to 41|hook of at most 3/);
  assert.match(broken(scenes(1, { cast: ['tay', 'stranger'] })), /stranger, who is not in the series cast/);
  assert.match(broken(scenes(1, { speaker: 'odette' })), /speaker is not in the shot/);
  assert.match(broken(scenes(2, { facts: [{ text: 'An unsourced claim.', sources: [] }] })), /without a source/);
  assert.match(broken(scenes(2, { facts: [{ text: 'A claim.', sources: ['S9'] }] })), /S9, which is not a source/);
  assert.match(broken(scenes(3, { narration: 'word '.repeat(30) })), /too fast to speak/);
  assert.match(broken(scenes(3, { caption: 'What Love Made Me Do' })), /reference material/);
});

// ─── 2. Per-platform export profiles ──────────────────────────────────────

test('each platform package passes its own limits; posting state is honest per platform', () => {
  for (const id of Object.keys(EXPORT_PROFILES)) {
    const out = exportPackage(id);
    assert.equal(out.ok, true, `${id}: ${out.errors.join(' ')}`);
    assert.deepEqual([out.package.width, out.package.height, out.package.aspect], [1080, 1920, '9:16']);
    assert.ok(out.package.text.length <= EXPORT_PROFILES[id].text_max);
    assert.ok(out.package.hashtags.length <= EXPORT_PROFILES[id].hashtags_max);
    assert.ok(out.warnings.some((w) => /not re-checked/.test(w)), 'unchecked limits say so');
  }
  assert.ok(exportPackage('youtube_shorts').package.hashtags.includes('#Shorts'));
  assert.ok(exportPackage('youtube_shorts').package.title.length <= 100);
  for (const box of Object.values(LAYOUT)) assert.ok(boxInSafeZone(box), `${box} inside the caption-safe zone`);
  assert.equal(boxInSafeZone([72, 1500, 930, 1700]), false, 'text in the bottom 35% is refused');
  assert.equal(boxInSafeZone([72, 400, 1000, 500]), false, 'text under the right-hand buttons is refused');
  // A package over a platform's limits fails there and only there.
  const long = { ...PILOT, description: 'x'.repeat(2500) };
  assert.equal(exportPackage('tiktok', { episode: long }).ok, false);
  assert.match(exportPackage('tiktok', { episode: long }).errors[0], /caption is \d+ characters; the limit is 2200/);
  assert.equal(exportPackage('youtube_shorts', { episode: long }).ok, true);
  assert.equal(exportPackage('myspace').ok, false);
  assert.deepEqual(platformsIn('TikTok, Reels and Shorts'), ['youtube_shorts', 'tiktok', 'instagram_reels']);
  assert.deepEqual(platformsIn('every platform'), Object.keys(EXPORT_PROFILES));
  assert.deepEqual(platformsIn('Facebook Reels'), ['facebook_reels']);
  assert.equal(SAFE_ZONE.basis.includes('not an official platform number'), true);
});

// ─── 3. Renderer inputs ───────────────────────────────────────────────────

test('the renderer storyboard is built from the bible and pilot, and is the fixture the renderer tests check', () => {
  const spec = studioRenderSpec();
  const fixture = JSON.parse(readFileSync(new URL('../../tools/fixtures/pilot_render_spec.json', import.meta.url), 'utf8'));
  assert.deepEqual(fixture, JSON.parse(JSON.stringify(spec)),
    'stale fixture: regenerate tools/fixtures/pilot_render_spec.json from creator_studio.studioRenderSpec()');
  assert.deepEqual([spec.width, spec.height, spec.seconds], [1080, 1920, 40]);
  assert.equal(spec.scenes.reduce((n, s) => n + s.seconds, 0), 40);
  assert.deepEqual(spec.cast.map((c) => c.id).sort(), ['bolt', 'nia', 'odette', 'reggie', 'tay']);
  assert.ok(spec.scenes.every((s) => s.cast.includes(s.speaker) && s.caption && s.narration));
  assert.deepEqual(spec.sources.map((s) => s.id), ['S1', 'S2']);
  assert.ok(JSON.stringify(spec).length < 6000, 'small enough for a workflow input');
});

test('a storyboard render sends the spec as one workflow input, and a mismatched one is refused before any call', async () => {
  const spec = JSON.stringify(studioRenderSpec());
  const sent = [];
  const fetcher = async (url, options) => { sent.push({ url: String(url), body: JSON.parse(options.body) }); return new Response(null, { status: sent.length === 1 ? 403 : 204 }); };
  const started = await startGithubVideo(GITHUB, 'Street Smart Explainers S1E1', 40, fetcher, { spec });
  assert.equal(started.ok, true);
  assert.equal(sent[0].body.inputs.spec, spec);
  assert.equal(sent[0].body.inputs.seconds, '40');
  assert.equal(sent[1].body.client_payload.spec, spec, 'the repository-dispatch fallback carries it too');
  const calls = [];
  const wrong = await startGithubVideo(GITHUB, 'Street Smart Explainers S1E1', 30, async () => { calls.push(1); }, { spec });
  assert.equal(wrong.code, 'invalid');
  assert.equal(calls.length, 0);
});

test('mp4Facts reads the frame size from the MP4 itself', () => {
  assert.deepEqual(mp4Facts(mp4()), { ok: true, seconds: 40, video: 'h264', audio: 'aac', width: 1080, height: 1920 });
  assert.equal(mp4Facts(mp4({ width: 1920, height: 1080 })).width, 1920);
});

// ─── 4. Routes through /api/chat ──────────────────────────────────────────

test('the owner\'s studio phrasings and their voice variants reach the studio, with no model', async () => {
  const che = await owner();
  fakePlatforms();
  const cases = [
    ['show the series bible', 'studio-bible', /Street Smart Explainers[\s\S]*Nia Brooks[\s\S]*nothing is taken from the reference videos/],
    ['Show me the series bible.', 'studio-bible', /series bible/],
    ['CHE, show the series bible', 'studio-bible', /series bible/],
    ['write the pilot script', 'studio-pilot', /S1E1, "Confident, Not Correct", 40 seconds[\s\S]*passes every check[\s\S]*nothing was rendered/],
    ['Write the pilot script.', 'studio-pilot', /pilot script/],
    ['export the pilot for TikTok', 'studio-export', /TikTok: the package passes[\s\S]*TikTok is not connected; you must authorize it first[\s\S]*Nothing was posted/],
    ['Export the pilot for TikTok.', 'studio-export', /TikTok/],
    ['show the growth experiments', 'studio-growth', /Three hooks[\s\S]*No bots[\s\S]*YouTube Shorts: no data[\s\S]*TikTok: no data; not connected/],
  ];
  for (const [words, command, reply] of cases) {
    const out = await che.say(words, { fresh: true });
    assert.equal(out.route, 'che_creator_studio', words);
    assert.equal(out.done.command, command, words);
    assert.equal(out.modelCalls, 0, words);
    assert.match(out.reply, reply, words);
  }
  // The slash forms reach the same handler.
  for (const slash of ['/studio-bible', '/studio-pilot', '/studio-export TikTok', '/studio-growth']) {
    assert.equal((await che.say(slash, { fresh: true })).route, 'che_creator_studio', slash);
  }
  assert.equal(githubDispatches().length + googleCalls().length, 0, 'reading, scripting and exporting touch no platform');
});

test('counter-cases keep their own routes', async () => {
  const che = await owner();
  fakePlatforms();
  assert.notEqual((await che.say('What does a pilot do?', { fresh: true })).route, 'che_creator_studio');
  assert.notEqual((await che.say('Show me the pilot of Breaking Bad', { fresh: true })).route, 'che_creator_studio');
  assert.notEqual((await che.say('post it to YouTube Shorts', { fresh: true })).route, 'che_creator_studio', 'with no pilot in the conversation, "it" is not the pilot');
  assert.equal((await che.say('Check my YouTube channel', { fresh: true })).route, 'che_youtube_status');
  assert.equal(studioChatIntent('make a video about black holes'), null);
  assert.equal(studioChatIntent('the airline pilot was late'), null);
  assert.equal(studioChatIntent('buy the pilot a coffee and delete my notes'), null, 'money and delete requests stay with the owner gates');
  assert.equal(studioChatIntent('Design growth experiments for my barbershop'), null, 'the owner\'s own business is not the series');
  assert.equal(studioChatIntent('did the pilot get fake views?')?.refuse, undefined, 'a question about fake views is not a request for them');
  assert.equal(studioChatIntent('buy 500 followers for my TikTok')?.refuse, 'fake_growth');
  assert.equal(studioChatIntent('Show the growth experiments for my channel')?.command, 'studio-growth');
});

// ─── 5. Render, export and post: the right step, the owner's yes ──────────

test('render the pilot: one dispatch with the storyboard, then only a verified MP4 counts', async () => {
  const che = await owner({ env: GITHUB });
  const seen = fakePlatforms();
  const scriptOnly = await che.say('write the pilot script');
  assert.equal(seen.dispatches.length, 0, 'a script request renders nothing');
  const queued = await che.say('render the pilot');
  assert.equal(queued.route, 'che_creator_studio');
  assert.equal(queued.done.render_status, 'queued');
  assert.match(queued.reply, /accepted the pilot[\s\S]*40 seconds, vertical 1080 by 1920[\s\S]*not animated and not lip-synced[\s\S]*No MP4 exists yet, and nothing will be posted/);
  assert.equal(seen.dispatches.length, 1);
  assert.equal(JSON.parse(seen.dispatches[0].spec).episode, 'S1E1');
  assert.ok(scriptOnly.reply.length > 0);
  // Asked again while GitHub has not started it: a status, never a second render.
  const again = await che.say('Render the pilot.');
  assert.match(again.reply, /queued on GitHub[\s\S]*did not start a second one/);
  assert.equal(seen.dispatches.length, 1);
  // The chat's own video status follows the same job.
  assert.equal(che.saved.get('che_video_pending').task_id, seen.dispatches[0].job_id);
  seen.done = true;
  const ready = await che.say('is the pilot ready');
  assert.equal(ready.done.render_status, 'verified');
  assert.match(ready.reply, /verified MP4[\s\S]*40 seconds, 1080 by 1920, H264 with AAC[\s\S]*nothing was posted/);
  assert.match(ready.done.media_url, /\/api\/media\/[\w-]+\/video$/);
  assert.equal(googleCalls().length, 0, 'rendering uploads nothing');
});

test('a render whose MP4 is not 9:16 is not reported as made', async () => {
  const che = await owner({ env: GITHUB });
  const seen = fakePlatforms({ video: mp4({ width: 1920, height: 1080 }) });
  await che.say('render the pilot');
  seen.done = true;
  const out = await che.say('is the pilot ready');
  assert.equal(out.done.render_status, 'failed');
  assert.match(out.reply, /render failed[\s\S]*1920x1080, not the 1080x1920[\s\S]*No MP4 exists/);
});

test('posting: not connected says so and posts nothing; connected asks once with account, video and visibility', async () => {
  const che = await owner({ env: { ...GITHUB, ...GOOGLE } });
  const seen = fakePlatforms();
  await che.say('export the pilot for TikTok');
  const notConnected = await che.say('post it to YouTube Shorts');
  assert.equal(notConnected.route, 'che_creator_studio', 'nothing is held when nothing can be posted');
  assert.match(notConnected.reply, /YouTube is not connected; you must authorize it first[\s\S]*Nothing was posted/);
  const tiktok = await che.say('Post the pilot to TikTok');
  assert.match(tiktok.reply, /TikTok is not connected; you must authorize it first[\s\S]*Nothing was posted/);
  for (const words of ['Post the pilot to Instagram Reels', 'post the pilot to facebook reels']) {
    assert.match((await che.say(words)).reply, /is not connected; you must authorize it first[\s\S]*Nothing was posted/, words);
  }
  await connectYouTube(che);
  const noVideo = await che.say('Post the pilot to YouTube Shorts');
  assert.match(noVideo.reply, /no verified MP4 yet[\s\S]*Nothing was posted/);
  await che.say('render the pilot');
  seen.done = true;
  await che.say('is the pilot ready');
  const ask = await che.say('post it to YouTube Shorts');
  assert.equal(ask.route, 'held');
  assert.match(ask.reply, /Post the pilot to YouTube Shorts, sir\? Account: YouTube channel "Vondada Test Channel"\. Video: "Confident, Not Correct", 40 seconds, 1080 by 1920[\s\S]*Visibility: unlisted, not public[\s\S]*Say yes to approve/);
  assert.equal(seen.sessions + seen.uploads, 0, 'asking uploads nothing');
  // Another turn drops the hold: a later yes posts nothing.
  await che.say('what time is it in Phoenix');
  await che.say('yes');
  assert.equal(seen.uploads, 0);
  // The talk moved on, so "it" is named again.
  await che.say('post the pilot to YouTube Shorts');
  const posted = await che.say('yes');
  assert.equal(posted.route, 'che_creator_studio');
  assert.match(posted.reply, /Uploaded unlisted to YouTube, sir: https:\/\/www\.youtube\.com\/watch\?v=pilotVid123\. It is not public/);
  assert.equal(seen.uploads, 1);
  assert.equal(seen.metadata.status.privacyStatus, 'unlisted');
  assert.equal(seen.metadata.snippet.title, 'Confident, Not Correct');
  assert.match(seen.metadata.snippet.description, /#Shorts/);
  assert.ok(seen.uploadedBytes > 0, 'the verified MP4 bytes were sent, not a signed-in link');
  // Idempotent per platform: asking again posts nothing new.
  const twice = await che.say('post it to YouTube Shorts');
  assert.match(twice.reply, /already on YouTube Shorts[\s\S]*did not post it again/);
  assert.equal(seen.sessions, 1);
  // Growth reads YouTube's own counters; the other platforms have no data.
  const growth = await che.say('how is the pilot doing');
  assert.match(growth.reply, /read from YouTube just now: 1234 views, 56 likes, 7 comments[\s\S]*TikTok: no data; not connected/);
  assert.equal(seen.stats, 1);
  const view = await che.get('/api/studio');
  assert.equal(view.pilot.render, 'verified');
  assert.equal(view.platforms.find((p) => p.id === 'youtube_shorts').posted, 'https://www.youtube.com/watch?v=pilotVid123');
  assert.deepEqual(view.platforms.filter((p) => p.connection === 'not_connected').map((p) => p.id), ['tiktok', 'instagram_reels', 'facebook_reels']);
});

test('prohibitions and fake growth: nothing is posted, bought or invented', async () => {
  const che = await owner({ env: GITHUB });
  const seen = fakePlatforms();
  const exportOnly = await che.say('Export the pilot for TikTok but dont post it');
  assert.equal(exportOnly.done.command, 'studio-export');
  const notYet = await che.say('Dont render the pilot yet');
  assert.equal(notYet.done.render_status, 'not_started');
  assert.equal(seen.dispatches.length, 0);
  const fake = await che.say('buy 1000 followers for the pilot');
  assert.equal(fake.route, 'che_creator_studio');
  assert.match(fake.reply, /won't do that[\s\S]*Nothing was bought or posted/);
  const growth = await che.say('show the growth experiments');
  assert.doesNotMatch(growth.reply, /\d+ views/, 'with nothing posted there are no view counts');
  assert.match(growth.reply, /I never estimate or invent views/);
  assert.equal(googleCalls().length, 0);
});

test('without the free renderer the pilot is not started, and the panel view says why', async () => {
  const che = await owner();
  fakePlatforms();
  const out = await che.say('render the pilot');
  assert.match(out.reply, /needs setup[\s\S]*Video renderer[\s\S]*Nothing was run/);
  assert.equal(githubDispatches().length, 0);
  const view = await che.get('/api/studio');
  assert.equal(view.series.title, 'Street Smart Explainers');
  assert.equal(view.pilot.render, 'not_started');
  assert.equal(view.pilot.valid, true);
  assert.ok(view.platforms.every((p) => p.connection === 'not_connected' && !p.posted));
  assert.match(view.capability, /not animation, not photoreal and not lip-synced/);
});
