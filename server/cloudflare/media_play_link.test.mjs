// Owner, 2026-11-07: the film "Brewed Anarchy" would not play in the app (the crossed-out play icon). The iPhone's
// player fetches a video in byte ranges without the app's Authorization header, so the device-token route refused it.
// A signed play link opens that one video, in ranges, for six hours, and nothing else.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { mediaPlayLink, mediaPlayLinkValid, saveFilmVideo, PLAY_LINK_S } from './media.js';

function memory() {
  const kv = new Map();
  return { kv, get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined), put: async (k, v) => { kv.set(k, structuredClone(v)); }, delete: async (k) => kv.delete(k), list: async ({ prefix = '' } = {}) => new Map([...kv].filter(([k]) => k.startsWith(prefix))) };
}

test('a play link is valid only for its video, its signature and its six hours', async () => {
  const st = memory(); const now = Date.UTC(2026, 10, 7, 4, 0);
  const { url, expires_at } = await mediaPlayLink(st, 'abcdef12-film', 'https://che.example', now);
  const u = new URL(url);
  const [exp, sig] = [u.searchParams.get('exp'), u.searchParams.get('sig')];
  assert.equal(u.pathname, '/api/media/abcdef12-film/video');
  assert.equal(Date.parse(expires_at), now + PLAY_LINK_S * 1000);
  assert.equal(await mediaPlayLinkValid(st, 'abcdef12-film', exp, sig, now + 60_000), true);
  assert.equal(await mediaPlayLinkValid(st, 'abcdef12-other', exp, sig, now), false, 'another video');
  assert.equal(await mediaPlayLinkValid(st, 'abcdef12-film', exp, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'), now), false, 'a changed signature');
  assert.equal(await mediaPlayLinkValid(st, 'abcdef12-film', String(Number(exp) + 3600), sig, now), false, 'a stretched expiry');
  assert.equal(await mediaPlayLinkValid(st, 'abcdef12-film', exp, sig, now + (PLAY_LINK_S + 5) * 1000), false, 'after six hours');
  assert.ok(!url.includes(String(await st.get('media:play_link_key'))), 'the key never leaves storage');
});

test('through the Worker: the app gets a play link with its token, then the player reads the film in byte ranges without one', async () => {
  const generated = new URL('./.media_play_link.test.generated.mjs', import.meta.url);
  writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
  let mod;
  try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
  const storage = memory();
  const film = new Uint8Array(5000).map((_, i) => i % 251);
  const objects = new Map([['film/f1/film.mp4', film]]);
  const bucket = { get: async (k) => (objects.has(k) ? { arrayBuffer: async () => objects.get(k).buffer.slice(0), body: null, size: objects.get(k).length } : null), put: async (k, v) => { objects.set(k, new Uint8Array(v)); }, head: async (k) => (objects.has(k) ? { size: objects.get(k).length } : null), delete: async (k) => objects.delete(k) };
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'ok' }) }, CHE_DATA_BUCKET: bucket };
  const state = new mod.CheState({ storage: { ...storage, setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null }, waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const call = (path, { method = 'GET', token = '', headers = {}, body } = {}) => mod.default.fetch(new Request(`https://che.example${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await call('/api/pair', { method: 'POST', body: { code: '123456' } })).json()).device_token;
  const item = await saveFilmVideo(storage, { key: 'film/f1/film.mp4', title: 'Brewed Anarchy', seconds: 60, bytes: film.length, film_id: 'f1', blob: 'r2' });

  // As before: without the token the video is refused (this is what the iPhone player hit).
  assert.equal((await call(`/api/media/${item.id}/video`, { headers: { Range: 'bytes=0-1' } })).status, 401);
  // The app asks for a play link with its token.
  const link = await call(`/api/media/${item.id}/link`, { method: 'POST', token });
  assert.equal(link.status, 200);
  const { url } = await link.json();
  const path = new URL(url).pathname + new URL(url).search;
  // The player's first probe and a later range, with no Authorization header.
  const probe = await call(path, { headers: { Range: 'bytes=0-1' } });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('Content-Range'), `bytes 0-1/${film.length}`);
  const part = await call(path, { headers: { Range: 'bytes=1000-1999' } });
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), film.slice(1000, 2000));
  assert.equal((await call(path)).status, 200);
  // A tampered link opens nothing; a link for a picture or a missing id is not issued.
  // The tamper always changes the signature (a fixed letter would be a no-op whenever the random signature already
  // started with it, about one run in 64).
  const tampered = path.replace(/sig=(.)/, (_, c) => `sig=${c === 'A' ? 'B' : 'A'}`);
  assert.notEqual(tampered, path);
  assert.equal((await call(tampered)).status, 401);
  assert.equal((await call(`/api/media/${'0'.repeat(12)}/link`, { method: 'POST', token })).status, 404);
  assert.equal((await call(`/api/media/${item.id}/link`, { method: 'POST' })).status, 401, 'only a paired device gets a link');
});
