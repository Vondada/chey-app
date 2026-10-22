// CHE Visual Studio (owner, 2026-10-22): the non-destructive edit model, words → edits, templates, smart resize,
// brand kits, renders and their verification, and the Worker routes (owner, token and workspace isolation).
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  newImageDoc, newVideoDoc, editState, edit, undo, redo, saveVersion, restoreVersion, compareDocs, timeline, duration,
  smartResize, useTemplate, templateFromDoc, TEMPLATES, FILTERS, brandKit, applyBrand, improve, suggestions, wordsToOps,
  renderSpec, nextRenderStage, compact, visualIntent, PRESETS,
} from './visual_studio.js';
import { checkOutput, newRenderJob, tokenOpens } from './visual_render.js';
import { replyFromNdjson } from './brain_memory.js';
import { encodeWav } from './music_audio.js';

globalThis.fetch = async (input) => { throw new TypeError(`fetch failed (offline test: ${new URL(String(input?.url || input)).host})`); };

const must = (r) => { assert.ok(r.ok, r.error || r.said); return r; };

function video() {
  const s = editState(newVideoDoc({ preset: 'tiktok' }));
  const A = must(edit(s, { op: 'add_clip', clip: { asset: 'a', name: 'Intro', duration: 6 } })).id;
  const B = must(edit(s, { op: 'add_clip', clip: { asset: 'b', name: 'Verse', duration: 4 } })).id;
  const C = must(edit(s, { op: 'add_clip', clip: { asset: 'c', name: 'Outro', duration: 3, kind: 'image' } })).id;
  return { s, A, B, C };
}

test('image: brightness, contrast, crop, text, layers, undo and redo, versions; the original never changes', () => {
  const s = editState(newImageDoc({ preset: 'square', asset: 'photo1' }));
  must(edit(s, { op: 'adjust', key: 'brightness', value: 20 }));
  must(edit(s, { op: 'adjust', key: 'contrast', delta: 10 }));
  must(edit(s, { op: 'crop', x: 0.1, y: 0.1, w: 0.8, h: 0.8 }));
  const title = must(edit(s, { op: 'add_layer', layer: { type: 'text', name: 'Title', value: 'NIGHT SHIFT', style: 'album', x: 0.1, y: 0.8, w: 0.8, h: 0.1 } })).id;
  assert.equal(s.doc.adjust.brightness, 20);
  assert.equal(s.doc.adjust.contrast, 10);
  assert.deepEqual(s.doc.transform.crop, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  must(undo(s));
  assert.equal(s.doc.layers.length, 1, 'undo removed the title');
  must(redo(s));
  assert.equal(s.doc.layers.at(-1).text.value, 'NIGHT SHIFT', 'redo brought it back, still editable');
  must(edit(s, { op: 'edit_layer', id: title, text: { value: 'NIGHT SHIFT EP', size: 0.09 } }));
  const logo = must(edit(s, { op: 'add_layer', layer: { type: 'logo', name: 'Logo', asset: 'logo1' } })).id;
  must(edit(s, { op: 'order', id: logo, dir: 'back' }));
  assert.equal(s.doc.layers[0].id, logo);
  must(edit(s, { op: 'duplicate_layer', id: title }));
  must(edit(s, { op: 'edit_layer', id: title, hidden: true }));
  assert.equal(s.doc.layers.find((l) => l.id === title).hidden, true);
  saveVersion(s, 'Edit v1');
  must(edit(s, { op: 'filter', name: 'bw' }));
  assert.equal(s.doc.adjust.saturation, -100);
  must(edit(s, { op: 'adjust', key: 'saturation', value: -40 }));
  assert.equal(s.doc.adjust.saturation, -40, 'a look stays adjustable afterwards');
  assert.deepEqual(s.versions[0].doc.adjust, newImageDoc({ asset: 'photo1' }).adjust, 'Original is untouched');
  assert.ok(compareDocs(s.versions[0].doc, s.doc).some((d) => /brightness 0 → 20/.test(d)));
  must(restoreVersion(s, 'v1'));
  assert.equal(s.doc.filter, 'original');
  assert.equal(must(undo(s)).ok, true, 'a restore is itself undoable');
});

test('video: play-order timeline, trim, split, reorder, transition, speed, freeze, duplicate, delete, fit to N seconds', () => {
  const { s, A, B, C } = video();
  assert.equal(duration(s.doc), 13);
  must(edit(s, { op: 'trim', clip: A, trim_start: 2 }));
  assert.equal(duration(s.doc), 11);
  const right = must(edit(s, { op: 'split', at: 2 })).id;
  assert.deepEqual(s.doc.clips.map((c) => c.name), ['Intro', 'Intro (2)', 'Verse', 'Outro']);
  assert.equal(s.doc.clips[0].out, 4);
  assert.equal(s.doc.clips[1].in, 4);
  must(edit(s, { op: 'reorder', clip: C, to: 0 }));
  assert.equal(s.doc.clips[0].id, C);
  must(edit(s, { op: 'transition', clip: C, type: 'dissolve', duration: 0.5 }));
  assert.equal(timeline(s.doc)[1].start, 2.5, 'a transition overlaps the clips it joins');
  must(edit(s, { op: 'clip', clip: B, speed: 2 }));
  assert.equal(timeline(s.doc).find((r) => r.id === B).length, 2);
  must(edit(s, { op: 'clip', clip: B, freeze: { duration: 1 } }));
  assert.equal(timeline(s.doc).find((r) => r.id === B).length, 3);
  must(edit(s, { op: 'duplicate_clip', clip: right }));
  must(edit(s, { op: 'delete_clip', clip: right }));
  assert.equal(s.doc.clips.length, 4);
  must(edit(s, { op: 'fit_duration', seconds: 8 }));
  assert.equal(duration(s.doc), 8);
  assert.match(edit(s, { op: 'transition', clip: s.doc.clips.at(-1).id, type: 'fade' }).error, /last clip/);
  assert.match(edit(s, { op: 'split', at: 99 }).error, /not inside a clip/);
});

test('audio and captions: song, music volume, fades, ducking, normalise, clean voice, captions and edits', () => {
  const { s } = video();
  must(edit(s, { op: 'add_audio', asset: 'song', name: 'Night Shift', role: 'music' }));
  must(edit(s, { op: 'add_audio', asset: 'vo', name: 'Voice', role: 'voice' }));
  must(edit(s, { op: 'audio', audio: 'music', volume: 0.5, fade_in: 1, fade_out: 2 }));
  assert.equal(s.doc.audio[0].volume, 0.5);
  assert.equal(s.doc.audio[0].duck, true, 'music ducks under speech by default');
  assert.match(must(improve(s, 'clean_voice')).said, /Clean Voice applied/);
  assert.equal(s.doc.audio[1].clean, true);
  must(undo(s));
  assert.equal(s.doc.audio[1].clean, false, 'one-tap improvements are reversible');
  must(edit(s, { op: 'captions', cues: [{ start: 0, end: 2, text: 'Hello' }, { start: 2, end: 4, text: 'world' }] }));
  must(edit(s, { op: 'edit_caption', id: s.doc.captions.cues[1].id, text: 'world!', end: 4.5 }));
  assert.equal(s.doc.captions.cues[1].text, 'world!');
  must(edit(s, { op: 'caption_style', style: 'caption_karaoke', scale: 1.25 }));
  assert.equal(s.doc.captions.scale, 1.25);
  must(edit(s, { op: 'adjust', key: 'brightness', value: 10, scope: `clip:${s.doc.clips[0].id}` }));
  assert.equal(s.doc.clips[0].adjust.brightness, 10, 'Apply to Clip');
  must(edit(s, { op: 'adjust', key: 'contrast', value: 12 }));
  assert.equal(s.doc.adjust.contrast, 12, 'Apply to All');
  assert.match(edit(s, { op: 'adjust', key: 'blur', value: 10 }).error, /for images/);
});

test('CHE edits from plain words: several instructions in one sentence, each a real operation; unknowns are said, not faked', () => {
  const { s } = video();
  const t = must(edit(s, { op: 'add_layer', layer: { type: 'text', name: 'Title', value: 'Night Shift', style: 'tiktok', y: 0.3 }, start: 0, end: 5 })).id;
  must(edit(s, { op: 'captions', cues: [{ start: 0, end: 2, text: 'hey' }] }));
  const w = wordsToOps('CHE, make the first scene brighter, cut two seconds off the intro, make the captions bigger and give it a darker cinematic look', s.doc);
  assert.deepEqual(w.understood, ['brighter (that scene)', 'cut 2 s off the intro', 'captions bigger', 'darker cinematic look']);
  assert.equal(w.unsupported.length, 0);
  for (const op of w.ops) must(edit(s, op));
  assert.equal(s.doc.clips[0].adjust.brightness, 15);
  assert.equal(s.doc.clips[0].in, 2);
  assert.equal(s.doc.captions.scale, 1.25);
  assert.equal(s.doc.filter, 'cinematic');
  assert.ok(s.doc.adjust.brightness < 0);
  const move = wordsToOps('Move the title higher', s.doc);
  must(edit(s, move.ops[0]));
  assert.equal(s.doc.text.find((x) => x.id === t).layer.y, 0.25);
  assert.equal(wordsToOps('Split here', s.doc, { playhead: 3 }).ops[0].at, 3);
  assert.equal(wordsToOps('Undo that', s.doc).ops[0].op, 'undo');
  assert.equal(wordsToOps('Remove the last clip', s.doc).ops[0].clip, s.doc.clips.at(-1).id);
  assert.equal(wordsToOps('Make this 30 seconds', s.doc).ops[0].seconds, 30);
  assert.equal(wordsToOps('Add captions', s.doc).ops[0].op, 'auto_captions');
  assert.match(wordsToOps('Remove that person', s.doc).unsupported[0], /generative edit engine/);
  assert.match(wordsToOps('brighten my face', s.doc).unsupported[0], /face detection/);
  assert.match(wordsToOps('Put the chorus here', s.doc).unsupported[0], /where the chorus starts/);
  const img = newImageDoc({ asset: 'p' });
  img.layers.push({ ...img.layers[0], id: 'tx', type: 'text', name: 'Title', text: { value: 'Hi', size: 0.05 } });
  assert.equal(wordsToOps('Make the text easier to read', img).ops[0].text.outline.color, '#000000');
  assert.equal(wordsToOps('Make this look like an album cover', img).ops[0].template, 'album-cover');
  assert.equal(wordsToOps('Make this look more professional', img).ops[0].id, 'auto_enhance');
});

test('templates: real documents with placeholders; save as template strips the owner\'s media; reuse fills it', () => {
  assert.ok(TEMPLATES.length >= 12);
  for (const cat of ['TikTok', 'Reels', 'YouTube Shorts', 'YouTube', 'YouTube Thumbnail', 'Music Promo', 'Album Cover', 'Single Cover', 'Advertisement', 'Product Promo', 'Podcast Clip', 'Business Promo']) {
    assert.ok(TEMPLATES.some((t) => t.category === cat), cat);
  }
  const promo = useTemplate(TEMPLATES.find((t) => t.id === 'music-promo'), { artwork: 'art1', title: 'Night Shift', artist: 'Dee', song: { media_id: 'song1', project_id: 'p1', title: 'Night Shift' } });
  assert.equal(promo.clips[0].asset, 'art1');
  assert.equal(promo.text[0].layer.text.value, 'Night Shift');
  assert.equal(promo.audio[0].asset, 'song1', 'the song is linked, not copied');
  assert.equal(promo.audio[0].project_ref, 'p1');
  assert.equal(promo.visualizer.kind, 'waveform');
  const mine = templateFromDoc(promo, { name: 'My promo' });
  assert.equal(mine.doc.clips[0].asset, null);
  assert.equal(mine.doc.audio.length, 0);
  const again = useTemplate(mine, { artwork: 'art2', title: 'Second Song' });
  assert.equal(again.clips[0].asset, 'art2');
  assert.equal(again.text[0].layer.text.value, 'Second Song');
  assert.equal(again.template, mine.id);
});

test('smart resize: TikTok/Reels and YouTube versions reposition, never stretch', () => {
  const s = editState(newImageDoc({ preset: 'square', asset: 'photo' }));
  const title = must(edit(s, { op: 'add_layer', layer: { type: 'text', name: 'Title', value: 'TITLE', style: 'thumbnail', x: 0.1, y: 0.05, w: 0.8, h: 0.12 } })).id;
  const logo = must(edit(s, { op: 'add_layer', layer: { type: 'logo', name: 'Logo', asset: 'l', x: 0.82, y: 0.82, w: 0.12, h: 0.12 } })).id;
  const tall = smartResize(s.doc, 'tiktok');
  const wide = smartResize(s.doc, 'youtube');
  for (const d of [tall, wide]) {
    const t = d.layers.find((l) => l.id === title);
    const g = d.layers.find((l) => l.id === logo);
    assert.ok(t.y < 0.2, 'the title stays at the top');
    assert.ok(g.x + g.w > 0.85 && g.y + g.h > 0.85, 'the logo keeps its corner');
    for (const l of d.layers.filter((x) => x.type !== 'photo')) assert.ok(l.x >= 0.049 && l.y >= 0.049 && l.x + l.w <= 0.951 && l.y + l.h <= 0.951, `${l.name} stays inside the safe area`);
    assert.equal(d.layers.find((l) => l.type === 'photo').fit.mode, 'cover', 'the photo fills the frame without stretching');
  }
  assert.equal(tall.canvas.w / tall.canvas.h, 9 / 16);
  assert.equal(wide.canvas.w / wide.canvas.h, 16 / 9);
  const v = video().s.doc;
  const yt = smartResize(v, 'youtube');
  assert.ok(yt.clips.every((c) => c.crop && c.crop.h < 1 && Math.abs(c.crop.w - 1) < 0.001), 'vertical clips are cropped around their focus for 16:9');
});

test('brand kits: owner and client kits stay separate; applying one sets fonts, colours, artist and logo', () => {
  const kit = brandKit({ name: 'Dee brand', workspace_id: 'ws_dee', logo: 'deelogo', colors: ['#FF3366'], font: 'Anton', artist_name: 'Dee' });
  const doc = applyBrand(useTemplate(TEMPLATES.find((t) => t.id === 'album-cover'), {}), kit);
  assert.equal(doc.layers.find((l) => l.placeholder === 'artist').text.value, 'Dee');
  assert.ok(doc.layers.some((l) => l.type === 'logo' && l.asset === 'deelogo'));
  assert.ok(doc.layers.filter((l) => l.text).every((l) => l.text.font === 'Anton' && l.text.color === '#FF3366'));
});

test('suggestions come from the project and each fix is a real operation', () => {
  const { s } = video();
  must(edit(s, { op: 'add_audio', asset: 'vo', name: 'Voice', role: 'voice' }));
  must(edit(s, { op: 'add_audio', asset: 'song', name: 'Song', role: 'music' }));
  must(edit(s, { op: 'audio', audio: 'music', duck: false }));
  const ids = suggestions(s.doc).map((x) => x.id);
  assert.deepEqual(ids, ['slow_intro', 'captions', 'duck']);
  for (const op of suggestions(s.doc).find((x) => x.id === 'slow_intro').ops) must(edit(s, op));
  assert.equal(timeline(s.doc)[0].length, 4);
});

test('render: a spec only when every clip has media; ready only with a verified file; failure keeps its reason', async () => {
  const empty = renderSpec(newVideoDoc());
  assert.match(empty.why, /no clips/);
  const s = editState(newVideoDoc({ preset: 'tiktok' }));
  must(edit(s, { op: 'add_clip', clip: { name: 'Blank' } }));
  assert.match(renderSpec(s.doc).why, /Blank has no media/);
  const tiny = newVideoDoc();
  tiny.canvas = { w: 108, h: 192, fps: 15 };
  tiny.clips.push({ ...newVideoDoc().clips, id: 'c1', asset: 'm1', kind: 'video', name: 'x', in: 0, out: 2, source_duration: 2, speed: 1, transition: { type: 'cut', duration: 0 } });
  const spec = renderSpec(tiny);
  assert.equal(spec.ok, true);
  const { job, token } = await newRenderJob(spec.spec);
  assert.ok(await tokenOpens(job, token));
  assert.equal(await tokenOpens(job, 'wrong'), false);
  assert.equal(await tokenOpens(job, token, job.expires + 1), false, 'the token expires');
  assert.ok(!JSON.stringify(job).includes(token), 'only the token\'s hash is stored');
  // CHE's own check of a real rendered file (made with ffmpeg, kept as a fixture).
  const mp4 = new Uint8Array(readFileSync(new URL('../../test/fixtures/edit_render_tiny.mp4', import.meta.url)));
  const zip = storedZip({ 'video.mp4': mp4, 'manifest.json': new TextEncoder().encode('{"status":"verified"}') });
  const ok = await checkOutput(job, zip);
  assert.equal(ok.verified, true, ok.error);
  assert.equal(ok.verification.width, 108);
  const wrongSize = await checkOutput({ ...job, canvas: { w: 1080, h: 1920 } }, zip);
  assert.equal(wrongSize.verified, false);
  assert.match(wrongSize.error, /not 1080x1920/);
  const fake = await checkOutput(job, storedZip({ 'video.mp4': new TextEncoder().encode('....ftypisom not really a video'), 'manifest.json': new Uint8Array() }));
  assert.equal(fake.verified, false, 'a header without a playable file is not ready');
  // Stages: preparing → rendering → finalizing → ready, or failed with a reason. Never a fake 100%.
  let j = { ...job };
  j = nextRenderStage(j, { ok: true, pending: true, stage: 'running' });
  assert.equal(j.stage, 'rendering');
  j = nextRenderStage(j, { ok: true, pending: true, stage: 'checking' });
  assert.equal(j.stage, 'finalizing');
  const failed = nextRenderStage(j, { ok: false, error: 'The render failed on GitHub (Actions run 9).' });
  assert.equal(failed.stage, 'failed');
  assert.equal(failed.retryable, true);
  assert.notEqual(failed.progress, 1);
  assert.equal(nextRenderStage(j, { ok: true, verified: true, media_id: 'm9', verification: {} }).stage, 'ready');
});

test('storage stays under the Durable Object limit however long the edit history is', () => {
  const { s } = video();
  for (let i = 0; i < 25; i++) must(edit(s, { op: 'captions', cues: Array.from({ length: 60 }, (_, k) => ({ start: k, end: k + 0.9, text: `caption number ${k} with some words ${i}` })) }));
  compact(s);
  assert.ok(JSON.stringify(s).length <= 100_000);
  assert.equal(s.versions[0].label, 'Original', 'the Original is never dropped');
  assert.ok(s.undo.length > 0, 'recent undo steps are kept');
});

test('owner words open Visual Studio work', () => {
  assert.deepEqual(visualIntent('CHE, make me a promo video for this song'), { kind: 'song_promo', platform: 'tiktok', title: null });
  assert.deepEqual(visualIntent('Make me a TikTok promo for Night Shift'), { kind: 'song_promo', platform: 'tiktok', title: 'Night Shift' });
  assert.deepEqual(visualIntent('Make versions for TikTok, Instagram and YouTube'), { kind: 'variants', presets: ['tiktok', 'reels', 'youtube'] });
  assert.equal(visualIntent('Use my music promo template but make it darker').tweak, 'make it darker');
  assert.equal(visualIntent('Edit').kind, 'open_editor');
  assert.equal(visualIntent('Render it').kind, 'render');
  assert.equal(visualIntent('What time is it?'), null);
  assert.ok(Object.keys(PRESETS).includes('portrait') && Object.keys(FILTERS).length === 9);
});

// ─── Through the Worker ─────────────────────────────────────────────────────

const generated = new URL('./.visual_studio.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => { if (key && typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, structuredClone(v)); return; } saved.set(key, structuredClone(value)); },
    delete: async (key) => saved.delete(key), list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {},
  };
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function owner(saved = new Map()) {
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async () => ({ response: 'ok' }) } };
  const state = new CheState({ storage: storageFor(saved), waitUntil: () => {} }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '', method = 'POST', headers = {}) => worker.fetch(new Request(`https://che.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  return {
    saved, env, token,
    get: async (p) => (await send(p, null, token, 'GET')).json(),
    post: async (b) => { const r = await send('/api/visual', b, token); return { status: r.status, body: await r.json() }; },
    say: async (message, extra = {}) => { const raw = await (await send('/api/chat', { message, history: [], ...extra }, token)).text(); const done = raw.trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'done') || {}; return { reply: replyFromNdjson(raw), route: done.source, done }; },
    raw: send,
  };
}
function seedMedia(saved, items) {
  saved.set('media_index', items.map(([id, extra = {}]) => ({ id, kind: 'image', mime_type: 'image/png', title: id, blob: 'do', created_at: '2026-10-22T00:00:00Z', ...extra })));
  for (const [id] of items) saved.set(`media:${id}`, PNG);
}

test('Worker: create, edit, undo, version, variants, template, voice edits, and the editor\'s project', async () => {
  const saved = new Map();
  seedMedia(saved, [['photo1'], ['photo2']]);
  const che = await owner(saved);
  const created = await che.post({ action: 'create', kind: 'image', preset: 'square', asset: 'photo1', title: 'Cover' });
  assert.equal(created.status, 200);
  const id = created.body.project.id;
  const e1 = await che.post({ action: 'op', project_id: id, op: { op: 'adjust', key: 'brightness', value: 25 } });
  assert.match(e1.body.said, /Brightness 25/);
  assert.equal(e1.body.project.can_undo, true);
  assert.equal((await che.post({ action: 'undo', project_id: id })).body.doc.adjust.brightness, 0);
  assert.equal((await che.post({ action: 'redo', project_id: id })).body.doc.adjust.brightness, 25);
  assert.match((await che.post({ action: 'save_version', project_id: id, label: 'Edit v1' })).body.said, /Saved Edit v1/);
  const cmp = await che.post({ action: 'compare', project_id: id, a: 'v0', b: 'v1' });
  assert.ok(cmp.body.differences.some((d) => /brightness 0 → 25/.test(d)));
  const variants = await che.post({ action: 'variants', project_id: id, presets: ['tiktok', 'youtube'] });
  assert.equal(variants.body.variants.length, 2);
  const tpl = await che.post({ action: 'save_template', project_id: id, name: 'My cover' });
  assert.match(tpl.body.said, /Saved "My cover"/);
  const list = await che.get('/api/visual');
  assert.ok(list.templates.some((t) => t.name === 'My cover' && !t.system));
  assert.ok(list.templates.filter((t) => t.system).every((t) => t.doc && t.doc.canvas), 'every template carries a real document for its preview');
  assert.ok(list.provider_features.every((f) => f.available === false), 'generative features are not offered as working');
  const reused = await che.post({ action: 'create', template_id: tpl.body.template.id, title: 'Second cover', fill: { artwork: 'photo2' } });
  assert.equal(reused.status, 200);
  // Voice edits in the editor: the app sends the open project.
  const v = await che.say('Make it brighter and make the text easier to read', { visual_project_id: id });
  assert.equal(v.route, 'che_visual_studio');
  assert.match(v.reply, /Brightness 40/);
  assert.match(v.reply, /There is no text yet/);
  // "Remove" is held by CHE's delete rule until the owner says yes; a generative edit is then said to be unavailable.
  assert.match((await (await che.raw('/api/chat', { message: 'Remove that person', history: [], visual_project_id: id }, che.token)).json()).reply, /need your yes/);
  const odd = await che.say('Replace the background with a beach', { visual_project_id: id });
  assert.match(odd.reply, /segmentation engine/);
  // Outside the editor, ordinary chat is not taken over.
  assert.notEqual((await che.say('What is the weather like?')).route, 'che_visual_studio');
});

test('Worker: render tokens open only their own job; workspace media never crosses into another workspace', async () => {
  const saved = new Map();
  seedMedia(saved, [['clientArt', { workspace_id: 'ws_a' }], ['ownerArt']]);
  const che = await owner(saved);
  const data = saved.get('che');
  data.music_workspaces = [{ id: 'ws_a', kind: 'CLIENT', name: 'A' }, { id: 'ws_b', kind: 'CLIENT', name: 'B' }];
  saved.set('che', data);
  const leak = await che.post({ action: 'create', kind: 'image', asset: 'clientArt', title: 'B cover', workspace_id: 'ws_b' });
  assert.equal(leak.status, 400);
  assert.match(leak.body.detail, /belongs to another client/);
  assert.equal((await che.post({ action: 'create', kind: 'image', asset: 'clientArt', title: 'A cover', workspace_id: 'ws_a' })).status, 200);
  // A render without GitHub configured fails honestly and stays retryable.
  const p = (await che.post({ action: 'create', kind: 'image', asset: 'ownerArt', title: 'Mine' })).body.project.id;
  const r = await che.post({ action: 'render', project_id: p });
  assert.match(r.body.said, /Render did not start: .*CHE_GITHUB_TOKEN/);
  assert.equal(r.body.project.render.stage, 'failed');
  // The token route: no token, wrong token or unknown job → not found; nothing else is served.
  const bad = await che.raw('/api/visual/render/gha_' + 'a'.repeat(32), null, '', 'GET', { 'X-CHE-Render-Token': 'nope' });
  assert.equal(bad.status, 404);
  const { job, token } = await newRenderJob({ assets: ['ownerArt'], doc: { kind: 'image', canvas: { w: 1, h: 1 } }, duration: 0 });
  const vs = saved.get(`visual:${p}`);
  vs.render = { ...job, spec: { v: 1, assets: ['ownerArt'] } };
  saved.set(`visual:${p}`, vs);
  const d2 = saved.get('che');
  d2.projects.find((x) => x.id === p).render = { id: job.id, stage: 'preparing' };
  saved.set('che', d2);
  const spec = await che.raw(`/api/visual/render/${job.id}`, null, '', 'GET', { 'X-CHE-Render-Token': token });
  assert.equal(spec.status, 200);
  assert.deepEqual((await spec.json()).assets, ['ownerArt']);
  const file = await che.raw(`/api/visual/render/${job.id}/asset/ownerArt`, null, '', 'GET', { 'X-CHE-Render-Token': token });
  assert.equal(file.status, 200);
  assert.equal((await file.arrayBuffer()).byteLength > 20, true);
  assert.equal((await che.raw(`/api/visual/render/${job.id}/asset/clientArt`, null, '', 'GET', { 'X-CHE-Render-Token': token })).status, 404, 'only the job\'s own assets');
  assert.equal((await che.raw(`/api/visual/render/${job.id}`, null, '', 'GET', { 'X-CHE-Render-Token': 'wrong' })).status, 404);
});

test('Worker: "make me a promo video for this song" uses the song\'s own audio file and artwork, or says what is missing', async () => {
  const saved = new Map();
  seedMedia(saved, [['songfile', { kind: 'upload', mime_type: 'audio/wav' }], ['cover1']]);
  const che = await owner(saved);
  const data = saved.get('che');
  data.projects = [{ id: 'song_1', type: 'music', title: 'Night Shift', music: { versions: [{ kind: 'master', sha256: 'a'.repeat(64) }], artwork_media_id: 'cover1', metadata: { artist: 'Dee' } } }];
  saved.set('che', data);
  assert.match((await che.say('Make me a promo video for this song')).reply, /no uploaded audio file yet/);
  data.projects[0].music.versions.push({ kind: 'master', sha256: 'b'.repeat(64), media_id: 'songfile' });
  saved.set('che', data);
  const r = await che.say('Make me a promo video for this song');
  assert.equal(r.route, 'che_visual_studio');
  assert.match(r.reply, /Made "Night Shift promo": TikTok 9:16.*Night Shift as the audio/);
  const view = await che.get(`/api/visual?project_id=${r.done.visual_project_id}`);
  assert.equal(view.doc.audio[0].asset, 'songfile', 'the song file is referenced, not duplicated');
  assert.equal(view.doc.clips[0].asset, 'cover1');
  assert.equal(view.doc.text[0].layer.text.value, 'Night Shift');
  assert.equal(view.doc.text[1].layer.text.value, 'Dee');
});

test('Worker: upload from the phone, and waveforms measured from WAV audio (other files say why not)', async () => {
  const saved = new Map();
  const che = await owner(saved);
  const up = await che.post({ action: 'upload', name: 'pic.png', media_type: 'image/png', base64: PNG });
  assert.equal(up.status, 200);
  assert.equal(up.body.item.mime_type, 'image/png');
  const x = new Float32Array(22050);
  for (let i = 0; i < x.length; i++) x[i] = (i < 11025 ? 0.1 : 0.8) * Math.sin(i / 5);
  const wav = Buffer.from(encodeWav([x], 22050)).toString('base64');
  const items = saved.get('media_index');
  items.unshift({ id: 'wav1', kind: 'upload', mime_type: 'audio/wav', title: 'beat', blob: 'do' });
  saved.set('media_index', items);
  saved.set('media:wav1', wav);
  const p = (await che.post({ action: 'create', kind: 'image', title: 'x' })).body.project.id;
  const w = await che.post({ action: 'waveform', project_id: p, asset: 'wav1' });
  assert.equal(w.body.peaks.length, 240);
  assert.ok(w.body.peaks.at(-1) > w.body.peaks[0] * 4, 'the louder second half shows in the waveform');
  const notWav = await che.post({ action: 'waveform', project_id: p, asset: up.body.item.id });
  assert.equal(notWav.body.peaks, null);
  assert.match(notWav.body.why, /WAV/);
});

// A ZIP with stored (uncompressed) entries, enough for the renderer artifact checks.
function storedZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  for (const [name, data] of Object.entries(files)) {
    const n = enc.encode(name);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc(data), true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, n.length, true);
    parts.push(new Uint8Array(h.buffer), n, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc(data), true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, Object.keys(files).length, true); e.setUint16(10, Object.keys(files).length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
