// Builds CHE Visual Studio edit documents with the real operations (server/cloudflare/visual_studio.js), for the
// renderer's end-to-end test. Usage: node tools/che_edit_doc.mjs <scenario> '<assets json>' → spec JSON on stdout.
import { newImageDoc, newVideoDoc, editState, edit, undo, redo, renderSpec, smartResize, useTemplate, TEMPLATES, timeline } from '../server/cloudflare/visual_studio.js';

const [scenario, rawAssets] = process.argv.slice(2);
const a = JSON.parse(rawAssets || '{}');
const must = (r) => { if (!r.ok) throw new Error(r.error || r.said); return r; };

function video({ adjust = true } = {}) {
  const s = editState(newVideoDoc({ preset: 'tiktok' }));
  const A = must(edit(s, { op: 'add_clip', clip: { asset: a.clipA, name: 'Clip A', duration: 4 } })).id;
  const B = must(edit(s, { op: 'add_clip', clip: { asset: a.clipB, name: 'Clip B', duration: 3 } })).id;
  must(edit(s, { op: 'add_clip', clip: { asset: a.photo, name: 'Photo', kind: 'image', duration: 2 } }));
  must(edit(s, { op: 'trim', clip: A, trim_start: 1 }));                       // A: 1..4 (3 s)
  must(edit(s, { op: 'split', at: 1.5 }));                                     // A → A(1.5 s) + A2(1.5 s)
  must(edit(s, { op: 'reorder', clip: B, to: 0 }));                            // B first
  must(edit(s, { op: 'transition', clip: B, type: 'dissolve', duration: 0.5 }));
  if (adjust) must(edit(s, { op: 'adjust', key: 'brightness', value: 40, scope: `clip:${B}` }));
  must(edit(s, { op: 'filter', name: 'cinematic' }));
  must(edit(s, { op: 'add_audio', asset: a.song, name: 'Song', role: 'music' }));
  must(edit(s, { op: 'audio', audio: 'music', volume: 0.6, fade_out: 1 }));
  must(edit(s, { op: 'captions', cues: [{ start: 0.2, end: 2, text: 'First caption' }, { start: 2.2, end: 4, text: 'Second' }] }));
  must(edit(s, { op: 'edit_caption', id: s.doc.captions.cues[1].id, text: 'Second caption, edited' }));
  must(edit(s, { op: 'add_layer', layer: { type: 'text', name: 'Title', value: 'CHE PROMO', style: 'tiktok', x: 0.08, y: 0.1, w: 0.84, h: 0.1, animation: 'fade_in' }, start: 0, end: 3 }));
  must(edit(s, { op: 'clip', clip: B, speed: 1.5 }));
  must(undo(s)); must(redo(s));
  return s.doc;
}

function image({ withEdits = true } = {}) {
  const s = editState(newImageDoc({ preset: 'square', asset: a.photo }));
  if (withEdits) {
    must(edit(s, { op: 'adjust', key: 'brightness', value: 30 }));
    must(edit(s, { op: 'adjust', key: 'contrast', value: 20 }));
    must(edit(s, { op: 'crop', x: 0.1, y: 0.1, w: 0.8, h: 0.8 }));
    must(edit(s, { op: 'add_layer', layer: { type: 'text', name: 'Title', value: 'NIGHT SHIFT', style: 'album', x: 0.1, y: 0.8, w: 0.8, h: 0.1 } }));
    must(edit(s, { op: 'adjust', key: 'saturation', value: -50 }));
    must(undo(s));                                                              // saturation undone
    must(redo(s)); must(undo(s));
  }
  return s.doc;
}

const docs = {
  video: () => video(),
  video_plain: () => video({ adjust: false }),
  image: () => image(),
  image_plain: () => image({ withEdits: false }),
  youtube: () => smartResize(video(), 'youtube'),
  template: () => { const d = useTemplate(TEMPLATES.find((t) => t.id === 'music-promo'), { artwork: a.photo, title: 'Night Shift', artist: 'CHE', song: { media_id: a.song, title: 'Night Shift' } }); d.clips[0].out = 5; d.clips[0].source_duration = 5; d.text.forEach((t) => { t.end = 5; }); return d; },
};
const doc = docs[scenario]();
const spec = renderSpec(doc, { title: scenario });
if (!spec.ok) throw new Error(spec.why);
process.stdout.write(JSON.stringify({ ...spec.spec, timeline: doc.kind === 'video' ? timeline(doc) : [] }));
