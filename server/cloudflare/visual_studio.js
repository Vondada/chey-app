// CHE Visual Studio (owner, 2026-10-22): Create → Images, Video, Templates, Projects.
//
// One edit document per visual project, kept non-destructive: the original media is never changed; every edit is
// a parameter on the document (adjustments, crop, layers, clips, captions), so any edit can be changed again,
// undone, compared with an earlier version, or rendered. The project itself is an ordinary CHE project
// (data.projects, type 'visual'); its document, history and versions live under their own storage key so the main
// record stays small.
//
// Everything here is deterministic and works without any AI key: adjustments, filters, crop, text, layers, trim,
// split, reorder, speed, volume, transitions, captions editing, templates, smart resize, brand kits and the render
// specification. Generative edits (remove a person, replace a background) are provider capabilities and are
// reported as unavailable until a real engine is connected, never faked.

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 3) => Math.round(Number(v) * 10 ** d) / 10 ** d;
const uid = (p) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const copy = (x) => JSON.parse(JSON.stringify(x));

// ─── Vocabulary ───────────────────────────────────────────────────────────

/// Adjustments, each -100..100 with 0 neutral (blur, sharpness, clarity, fade, vignette: 0..100).
export const ADJUSTMENTS = Object.freeze({
  brightness: [-100, 100], contrast: [-100, 100], exposure: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
  saturation: [-100, 100], vibrance: [-100, 100], temperature: [-100, 100], tint: [-100, 100],
  sharpness: [0, 100], clarity: [0, 100], fade: [0, 100], vignette: [0, 100], blur: [0, 100],
});
export const VIDEO_ADJUSTMENTS = Object.freeze(['brightness', 'contrast', 'exposure', 'highlights', 'shadows', 'saturation', 'temperature', 'tint', 'sharpness', 'vignette']);
const neutral = () => Object.fromEntries(Object.keys(ADJUSTMENTS).map((k) => [k, 0]));

/// Filters are parameter presets: applying one sets these values, which stay adjustable afterwards.
export const FILTERS = Object.freeze({
  original: {},
  clean: { contrast: 6, clarity: 12, vibrance: 8 },
  warm: { temperature: 22, tint: 4, saturation: 6 },
  cool: { temperature: -22, tint: -3, contrast: 4 },
  cinematic: { contrast: 18, saturation: -12, temperature: -6, shadows: -10, highlights: -8, vignette: 28, fade: 8 },
  vibrant: { saturation: 22, vibrance: 25, contrast: 8 },
  dark: { brightness: -18, exposure: -10, shadows: -20, contrast: 12, vignette: 35 },
  vintage: { fade: 30, saturation: -18, temperature: 14, contrast: -8, vignette: 22 },
  bw: { saturation: -100, contrast: 14 },
});

/// Output presets by aspect only. Platform limits beyond the aspect are verified when exporting, not assumed.
export const PRESETS = Object.freeze({
  tiktok: { label: 'TikTok 9:16', w: 1080, h: 1920 },
  reels: { label: 'Reels 9:16', w: 1080, h: 1920 },
  shorts: { label: 'Shorts 9:16', w: 1080, h: 1920 },
  youtube: { label: 'YouTube 16:9', w: 1920, h: 1080 },
  thumbnail: { label: 'YouTube Thumbnail 16:9', w: 1280, h: 720 },
  square: { label: 'Square 1:1', w: 1080, h: 1080 },
  portrait: { label: 'Portrait 4:5', w: 1080, h: 1350 },
  album: { label: 'Album / Single Cover 1:1', w: 3000, h: 3000 },
});

export const TRANSITIONS = Object.freeze(['cut', 'fade', 'dissolve', 'slide', 'zoom']);
export const ANIMATIONS = Object.freeze(['none', 'fade_in', 'fade_out', 'slide', 'scale', 'pop']);
export const LAYER_TYPES = Object.freeze(['background', 'photo', 'image', 'logo', 'text', 'shape', 'arrow', 'line', 'sticker', 'effect']);

/// Text styles: ready presets for common destinations. Every field stays editable on the layer.
export const TEXT_STYLES = Object.freeze({
  tiktok: { font: 'Inter', size: 0.06, weight: 800, color: '#FFFFFF', outline: { color: '#000000', width: 0.004 }, shadow: null, background: null, align: 'center' },
  reels: { font: 'Inter', size: 0.055, weight: 700, color: '#FFFFFF', outline: null, shadow: { color: '#000000AA', blur: 8 }, background: null, align: 'center' },
  shorts: { font: 'Inter', size: 0.06, weight: 800, color: '#FFE45C', outline: { color: '#000000', width: 0.004 }, shadow: null, background: null, align: 'center' },
  thumbnail: { font: 'Anton', size: 0.12, weight: 900, color: '#FFFFFF', outline: { color: '#000000', width: 0.008 }, shadow: { color: '#000000', blur: 12 }, background: null, align: 'left' },
  ad: { font: 'Inter', size: 0.07, weight: 800, color: '#FFFFFF', outline: null, shadow: null, background: { color: '#E8343BEE', radius: 0.01 }, align: 'center' },
  album: { font: 'Playfair Display', size: 0.08, weight: 700, color: '#F5F1E8', outline: null, shadow: { color: '#00000088', blur: 10 }, background: null, align: 'center' },
  social: { font: 'Inter', size: 0.05, weight: 600, color: '#FFFFFF', outline: null, shadow: { color: '#00000099', blur: 6 }, background: null, align: 'left' },
  caption_clean: { font: 'Inter', size: 0.045, weight: 600, color: '#FFFFFF', outline: null, shadow: { color: '#000000CC', blur: 6 }, background: null, align: 'center' },
  caption_bold: { font: 'Inter', size: 0.055, weight: 900, color: '#FFFFFF', outline: { color: '#000000', width: 0.005 }, shadow: null, background: null, align: 'center' },
  caption_minimal: { font: 'Inter', size: 0.038, weight: 500, color: '#FFFFFF', outline: null, shadow: null, background: { color: '#00000088', radius: 0.008 }, align: 'center' },
  caption_karaoke: { font: 'Inter', size: 0.055, weight: 900, color: '#FFFFFF', highlight: '#FFE45C', outline: { color: '#000000', width: 0.005 }, shadow: null, background: null, align: 'center' },
});

/// What needs a connected provider, and is therefore not offered as working until one exists.
export const PROVIDER_FEATURES = Object.freeze({
  remove_background: 'Remove background needs a segmentation engine (none connected).',
  replace_background: 'Replace background needs a segmentation engine (none connected).',
  remove_object: 'Removing an object or person needs a generative edit engine (none connected).',
  replace_object: 'Replacing an object needs a generative edit engine (none connected).',
  extend_image: 'Extending an image needs a generative edit engine (none connected).',
  face_brighten: 'Brightening only a face needs face detection (none connected).',
  stabilize: 'Stabilization is done at render time with ffmpeg vidstab when the renderer has it.',
});

// ─── Documents ────────────────────────────────────────────────────────────

export function newImageDoc({ preset = 'square', asset = null, w, h } = {}) {
  const p = PRESETS[preset] || PRESETS.square;
  const doc = {
    kind: 'image', v: 1, preset, canvas: { w: w || p.w, h: h || p.h, background: '#000000' },
    adjust: neutral(), filter: 'original',
    transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, rotate: 0, straighten: 0, flip_h: false, flip_v: false },
    layers: [],
  };
  if (asset) doc.layers.push(layer({ type: 'photo', name: 'Photo', asset, x: 0, y: 0, w: 1, h: 1 }));
  return doc;
}

export function newVideoDoc({ preset = 'tiktok', fps = 30 } = {}) {
  const p = PRESETS[preset] || PRESETS.tiktok;
  return { kind: 'video', v: 1, preset, canvas: { w: p.w, h: p.h, fps }, adjust: neutral(), filter: 'original', clips: [], audio: [], text: [], captions: { cues: [], style: 'caption_clean', position: 0.78, source: null } };
}

export function layer(input = {}) {
  const type = LAYER_TYPES.includes(input.type) ? input.type : 'image';
  return {
    id: input.id || uid('ly'), type, name: clip(input.name || type[0].toUpperCase() + type.slice(1), 40),
    x: round(input.x ?? 0.1), y: round(input.y ?? 0.1), w: round(input.w ?? 0.3), h: round(input.h ?? 0.1),
    rotation: Number(input.rotation) || 0, opacity: clamp(Number(input.opacity ?? 1), 0, 1), hidden: input.hidden === true,
    asset: input.asset || null, placeholder: input.placeholder || null, animation: ANIMATIONS.includes(input.animation) ? input.animation : 'none',
    text: type === 'text' ? { value: clip(input.value ?? input.text ?? 'Title', 400), ...copy(TEXT_STYLES[input.style] || TEXT_STYLES.social), style: input.style || 'social', ...(input.props || {}) } : undefined,
    shape: ['shape', 'arrow', 'line'].includes(type) ? { color: input.color || '#FFFFFF', stroke: input.stroke || 0.006 } : undefined,
  };
}

/// Video clip on the main track. `in`/`out` are seconds inside the source; the timeline position follows from order.
export function videoClip(input = {}) {
  const dur = Number(input.duration) || (input.kind === 'image' ? 3 : 5);
  return {
    id: input.id || uid('cl'), asset: input.asset || null, kind: input.kind === 'image' ? 'image' : 'video', name: clip(input.name || 'Clip', 40),
    in: Number(input.in) || 0, out: Number(input.out) || dur, source_duration: dur, speed: Number(input.speed) || 1,
    volume: Number(input.volume ?? 1), muted: input.muted === true, opacity: 1, rotate: 0, crop: null, focus: input.focus || { x: 0.5, y: 0.5 },
    adjust: {}, transition: { type: 'cut', duration: 0 }, freeze: null, reverse: false,
  };
}

/// Seconds a clip occupies on the timeline after speed.
export const clipLength = (c) => round(Math.max(0, (c.out - c.in) / (c.speed || 1)) + (c.freeze ? c.freeze.duration : 0));

/// Each clip's start on the timeline; transitions overlap the clips they join.
export function timeline(doc) {
  let t = 0;
  return doc.clips.map((c, i) => {
    const overlap = i > 0 && doc.clips[i - 1].transition.type !== 'cut' ? doc.clips[i - 1].transition.duration : 0;
    t = round(t - overlap);
    const row = { id: c.id, start: t, end: round(t + clipLength(c)), length: clipLength(c), index: i };
    t = row.end;
    return row;
  });
}
export const duration = (doc) => (doc.kind === 'video' ? (timeline(doc).at(-1)?.end || 0) : 0);

// ─── Operations ───────────────────────────────────────────────────────────

/// Applies one operation to a copy of the document. Returns { doc, said } or { error }.
export function applyOp(input, op) {
  const doc = copy(input);
  const find = (id) => doc.layers?.find((l) => l.id === id) || null;
  const clipBy = (id) => doc.clips?.find((c) => c.id === id) || null;
  const target = (scope) => {
    if (!scope || scope === 'all' || scope === 'image') return doc;
    const c = clipBy(String(scope).replace(/^clip:/, ''));
    return c || null;
  };
  switch (op.op) {
    case 'adjust': {
      if (!ADJUSTMENTS[op.key]) return { error: `Unknown adjustment ${op.key}.` };
      if (doc.kind === 'video' && !VIDEO_ADJUSTMENTS.includes(op.key)) return { error: `${op.key} is for images; video has ${VIDEO_ADJUSTMENTS.join(', ')}.` };
      const where = target(op.scope);
      if (!where) return { error: 'That clip is not in the project.' };
      const [lo, hi] = ADJUSTMENTS[op.key];
      const now = Number(where.adjust?.[op.key] || 0);
      where.adjust = { ...(where.adjust || {}), [op.key]: clamp(round(op.delta !== undefined ? now + Number(op.delta) : Number(op.value), 0), lo, hi) };
      return { doc, said: `${op.key[0].toUpperCase()}${op.key.slice(1)} ${where.adjust[op.key]}${where === doc ? '' : ` on ${where.name}`}.` };
    }
    case 'filter': {
      if (!FILTERS[op.name]) return { error: `Unknown look ${op.name}.` };
      const where = target(op.scope);
      if (!where) return { error: 'That clip is not in the project.' };
      const allowed = doc.kind === 'video' ? VIDEO_ADJUSTMENTS : Object.keys(ADJUSTMENTS);
      // Swap the previous look's values for the new one's; the owner's own adjustments stay.
      const prev = FILTERS[(where === doc ? doc.filter : where.filter) || 'original'] || {};
      const next = { ...(where.adjust || {}) };
      for (const [k, v] of Object.entries(prev)) if (allowed.includes(k)) next[k] = (next[k] || 0) - v;
      for (const [k, v] of Object.entries(FILTERS[op.name])) if (allowed.includes(k)) { const [lo, hi] = ADJUSTMENTS[k]; next[k] = clamp((next[k] || 0) + v, lo, hi); }
      where.adjust = next;
      if (where === doc) doc.filter = op.name;
      else where.filter = op.name;
      return { doc, said: `${op.name === 'bw' ? 'Black and white' : op.name[0].toUpperCase() + op.name.slice(1)} look applied; every setting stays adjustable.` };
    }
    case 'crop': {
      const c = { x: clamp(+op.x || 0, 0, 1), y: clamp(+op.y || 0, 0, 1), w: clamp(+op.w || 1, 0.02, 1), h: clamp(+op.h || 1, 0.02, 1) };
      if (c.x + c.w > 1.0001 || c.y + c.h > 1.0001) return { error: 'The crop goes outside the picture.' };
      if (doc.kind === 'video') { const cl = clipBy(op.clip); if (!cl) return { error: 'Pick a clip to crop.' }; cl.crop = c; return { doc, said: `Cropped ${cl.name}.` }; }
      doc.transform.crop = c;
      return { doc, said: 'Cropped.' };
    }
    case 'aspect': {
      const p = PRESETS[op.preset];
      if (!p) return { error: 'Unknown size.' };
      return { doc: smartResize(doc, op.preset), said: `Resized to ${p.label}.` };
    }
    case 'rotate': {
      if (doc.kind === 'video') { const cl = clipBy(op.clip); if (!cl) return { error: 'Pick a clip to rotate.' }; cl.rotate = ((cl.rotate + (op.degrees || 90)) % 360 + 360) % 360; return { doc, said: `Rotated ${cl.name} to ${cl.rotate}°.` }; }
      doc.transform.rotate = ((doc.transform.rotate + (op.degrees || 90)) % 360 + 360) % 360;
      return { doc, said: `Rotated to ${doc.transform.rotate}°.` };
    }
    case 'straighten': doc.transform.straighten = clamp(Number(op.degrees) || 0, -45, 45); return { doc, said: `Straightened ${doc.transform.straighten}°.` };
    case 'flip': doc.transform[op.axis === 'v' ? 'flip_v' : 'flip_h'] = !doc.transform[op.axis === 'v' ? 'flip_v' : 'flip_h']; return { doc, said: `Flipped ${op.axis === 'v' ? 'vertically' : 'horizontally'}.` };
    case 'background': doc.canvas.background = /^#[0-9a-f]{6}$/i.test(op.color) ? op.color : doc.canvas.background; return { doc, said: `Background ${doc.canvas.background}.` };
    case 'add_layer': {
      const l = layer(op.layer || {});
      if (doc.kind === 'video') {
        const item = { id: l.id, text: l.text?.value || '', layer: l, start: Number(op.start) || 0, end: Number(op.end) || Math.max(3, duration(doc)) };
        doc.text.push(item);
        return { doc, said: `Added ${l.name}.`, id: l.id };
      }
      doc.layers.push(l);
      return { doc, said: `Added ${l.name}.`, id: l.id };
    }
    case 'edit_layer': {
      const l = find(op.id) || doc.text?.find((t) => t.id === op.id)?.layer;
      if (!l) return { error: 'That layer is not in the project.' };
      for (const k of ['x', 'y', 'w', 'h', 'rotation', 'opacity', 'hidden', 'name', 'animation']) if (op[k] !== undefined) l[k] = k === 'opacity' ? clamp(+op[k], 0, 1) : op[k];
      if (op.text && l.text) {
        Object.assign(l.text, op.text);
        const item = doc.text?.find((t) => t.id === op.id);
        if (item && op.text.value !== undefined) item.text = op.text.value;
      }
      return { doc, said: `${l.name} updated.` };
    }
    case 'move_layer': {
      const l = find(op.id) || doc.text?.find((t) => t.id === op.id)?.layer;
      if (!l) return { error: 'That layer is not in the project.' };
      l.x = round(clamp(l.x + (op.dx || 0), -0.5, 1)); l.y = round(clamp(l.y + (op.dy || 0), -0.5, 1));
      return { doc, said: `Moved ${l.name}.` };
    }
    case 'order': {
      const i = doc.layers.findIndex((l) => l.id === op.id);
      if (i < 0) return { error: 'That layer is not in the project.' };
      const j = op.dir === 'forward' ? Math.min(doc.layers.length - 1, i + 1) : op.dir === 'front' ? doc.layers.length - 1 : op.dir === 'back' ? 0 : Math.max(0, i - 1);
      const [l] = doc.layers.splice(i, 1);
      doc.layers.splice(j, 0, l);
      return { doc, said: `${l.name} ${j > i ? 'brought forward' : j < i ? 'sent back' : 'stays where it is'}.` };
    }
    case 'duplicate_layer': {
      const l = find(op.id);
      if (!l) return { error: 'That layer is not in the project.' };
      const d = { ...copy(l), id: uid('ly'), name: `${l.name} copy`, x: round(l.x + 0.03), y: round(l.y + 0.03) };
      doc.layers.splice(doc.layers.indexOf(l) + 1, 0, d);
      return { doc, said: `Duplicated ${l.name}.`, id: d.id };
    }
    case 'delete_layer': {
      const before = (doc.layers?.length || 0) + (doc.text?.length || 0);
      if (doc.layers) doc.layers = doc.layers.filter((l) => l.id !== op.id);
      if (doc.text) doc.text = doc.text.filter((t) => t.id !== op.id);
      if (before === (doc.layers?.length || 0) + (doc.text?.length || 0)) return { error: 'That layer is not in the project.' };
      return { doc, said: 'Layer removed.' };
    }
    // Video.
    case 'add_clip': {
      if (doc.kind !== 'video') return { error: 'Clips belong to a video project.' };
      const c = videoClip(op.clip || {});
      if (Number.isInteger(op.index)) doc.clips.splice(op.index, 0, c); else doc.clips.push(c);
      return { doc, said: `Added ${c.name}.`, id: c.id };
    }
    case 'trim': {
      const c = clipBy(op.clip);
      if (!c) return { error: 'That clip is not in the project.' };
      const inP = op.in !== undefined ? +op.in : c.in + (+op.trim_start || 0);
      const outP = op.out !== undefined ? +op.out : c.out - (+op.trim_end || 0);
      if (inP < 0 || outP > c.source_duration + 0.001 || outP - inP < 0.1) return { error: `That trim would leave less than a tenth of a second or go past the clip (0 to ${c.source_duration} s).` };
      c.in = round(inP); c.out = round(outP);
      return { doc, said: `${c.name} now runs ${round(clipLength(c), 2)} s.` };
    }
    case 'split': {
      const rows = timeline(doc);
      const row = rows.find((r) => op.at > r.start + 0.05 && op.at < r.end - 0.05);
      if (!row) return { error: 'The playhead is not inside a clip, or too close to its edge to split.' };
      const c = clipBy(row.id);
      const cut = round(c.in + (op.at - row.start) * c.speed);
      const right = { ...copy(c), id: uid('cl'), name: `${c.name} (2)`, in: cut };
      c.out = cut;
      c.transition = { type: 'cut', duration: 0 };
      doc.clips.splice(row.index + 1, 0, right);
      return { doc, said: `Split ${c.name} at ${round(op.at, 2)} s.`, id: right.id };
    }
    case 'delete_clip': {
      const i = doc.clips.findIndex((c) => c.id === op.clip);
      if (i < 0) return { error: 'That clip is not in the project.' };
      const [c] = doc.clips.splice(i, 1);
      return { doc, said: `Removed ${c.name}.` };
    }
    case 'duplicate_clip': {
      const i = doc.clips.findIndex((c) => c.id === op.clip);
      if (i < 0) return { error: 'That clip is not in the project.' };
      const d = { ...copy(doc.clips[i]), id: uid('cl'), name: `${doc.clips[i].name} copy` };
      doc.clips.splice(i + 1, 0, d);
      return { doc, said: `Duplicated ${doc.clips[i].name}.`, id: d.id };
    }
    case 'reorder': {
      const i = doc.clips.findIndex((c) => c.id === op.clip);
      if (i < 0) return { error: 'That clip is not in the project.' };
      const to = clamp(op.to ?? (op.dir === 'left' ? i - 1 : i + 1), 0, doc.clips.length - 1);
      const [c] = doc.clips.splice(i, 1);
      doc.clips.splice(to, 0, c);
      return { doc, said: `${c.name} moved to position ${to + 1}.` };
    }
    case 'clip': {
      const c = clipBy(op.clip);
      if (!c) return { error: 'That clip is not in the project.' };
      if (op.speed !== undefined) c.speed = clamp(+op.speed, 0.25, 4);
      if (op.volume !== undefined) c.volume = clamp(+op.volume, 0, 2);
      if (op.muted !== undefined) c.muted = Boolean(op.muted);
      if (op.opacity !== undefined) c.opacity = clamp(+op.opacity, 0, 1);
      if (op.reverse !== undefined) c.reverse = Boolean(op.reverse);
      if (op.freeze !== undefined) c.freeze = op.freeze ? { at: clamp(+op.freeze.at || 0, 0, c.out - c.in), duration: clamp(+op.freeze.duration || 1, 0.2, 10) } : null;
      return { doc, said: `${c.name} updated.` };
    }
    case 'transition': {
      const c = clipBy(op.clip);
      if (!c) return { error: 'That clip is not in the project.' };
      if (!TRANSITIONS.includes(op.type)) return { error: `Transitions: ${TRANSITIONS.join(', ')}.` };
      if (doc.clips.indexOf(c) === doc.clips.length - 1 && op.type !== 'cut') return { error: 'The last clip has nothing after it to transition into.' };
      const next = doc.clips[doc.clips.indexOf(c) + 1];
      const most = Math.min(clipLength(c), next ? clipLength(next) : 0) / 2;
      c.transition = { type: op.type, duration: op.type === 'cut' ? 0 : round(clamp(+op.duration || 0.5, 0.1, most), 2) };
      return { doc, said: `${op.type[0].toUpperCase() + op.type.slice(1)} after ${c.name}.` };
    }
    case 'add_audio': {
      const a = { id: uid('au'), asset: op.asset || null, name: clip(op.name || 'Audio', 40), role: ['music', 'voice', 'sfx'].includes(op.role) ? op.role : 'music', start: +op.start || 0, in: +op.in || 0, out: op.out !== undefined ? +op.out : null, volume: op.volume ?? (op.role === 'voice' ? 1 : 0.8), fade_in: 0, fade_out: 0, muted: false, normalize: false, clean: false, duck: op.role === 'music', eq: null, project_ref: op.project_ref || null };
      doc.audio.push(a);
      return { doc, said: `Added ${a.name} as ${a.role}.`, id: a.id };
    }
    case 'audio': {
      const targets = op.audio === 'music' || op.audio === 'voice' ? doc.audio.filter((a) => a.role === op.audio) : doc.audio.filter((a) => a.id === op.audio);
      if (!targets.length) return { error: `There is no ${op.audio === 'music' || op.audio === 'voice' ? op.audio : 'such'} track.` };
      for (const a of targets) {
        if (op.volume !== undefined) a.volume = clamp(+op.volume, 0, 2);
        if (op.volume_delta !== undefined) a.volume = clamp(round(a.volume + +op.volume_delta, 2), 0, 2);
        for (const k of ['fade_in', 'fade_out']) if (op[k] !== undefined) a[k] = clamp(+op[k], 0, 10);
        for (const k of ['muted', 'normalize', 'clean', 'duck']) if (op[k] !== undefined) a[k] = Boolean(op[k]);
        if (op.eq !== undefined) a.eq = op.eq ? { low: clamp(+op.eq.low || 0, -12, 12), mid: clamp(+op.eq.mid || 0, -12, 12), high: clamp(+op.eq.high || 0, -12, 12) } : null;
      }
      return { doc, said: `${targets.map((a) => a.name).join(', ')}: volume ${targets.map((a) => Math.round(a.volume * 100)).join('/')}%.` };
    }
    case 'captions': {
      const cues = (op.cues || []).map((c) => ({ id: uid('cp'), start: round(+c.start, 2), end: round(+c.end, 2), text: clip(c.text, 200) })).filter((c) => c.end > c.start && c.text);
      doc.captions.cues = cues;
      doc.captions.source = op.source || 'owner';
      return { doc, said: `${cues.length} caption${cues.length === 1 ? '' : 's'} added.` };
    }
    case 'edit_caption': {
      const c = doc.captions.cues.find((x) => x.id === op.id);
      if (!c) return { error: 'That caption is not in the project.' };
      if (op.text !== undefined) c.text = clip(op.text, 200);
      if (op.start !== undefined) c.start = round(+op.start, 2);
      if (op.end !== undefined) c.end = round(+op.end, 2);
      if (c.end <= c.start) return { error: 'A caption must end after it starts.' };
      return { doc, said: 'Caption updated.' };
    }
    case 'caption_style': {
      if (op.style && !TEXT_STYLES[op.style]) return { error: 'Unknown caption style.' };
      if (op.style) doc.captions.style = op.style;
      if (op.scale) doc.captions.scale = round(clamp((doc.captions.scale || 1) * op.scale, 0.5, 2.5), 2);
      if (op.position !== undefined) doc.captions.position = clamp(+op.position, 0.05, 0.95);
      return { doc, said: `Captions ${op.scale ? (op.scale > 1 ? 'bigger' : 'smaller') : 'restyled'}.` };
    }
    case 'fit_duration': {
      const want = +op.seconds;
      if (!(want > 0)) return { error: 'Say how long it should be.' };
      let over = round(duration(doc) - want, 3);
      if (over < 0) return { error: `The project is ${round(duration(doc), 1)} s; I can shorten, but not lengthen without new footage.` };
      for (let i = doc.clips.length - 1; i >= 0 && over > 0.001; i--) {
        const c = doc.clips[i];
        const can = Math.max(0, clipLength(c) - 0.5);
        const take = Math.min(can, over);
        c.out = round(c.out - take * c.speed);
        over = round(over - take, 3);
      }
      return { doc, said: `Now ${round(duration(doc), 1)} s.` };
    }
    default:
      return { error: `Unknown edit ${op.op}.` };
  }
}

// ─── History and versions ─────────────────────────────────────────────────

const HISTORY = 30;

/// A project's editing state: the current document, undo and redo stacks, and named versions. The original is kept
/// as version 0 and never changes.
export function editState(doc) {
  return { doc: copy(doc), undo: [], redo: [], versions: [{ id: 'v0', label: 'Original', doc: copy(doc), at: new Date().toISOString() }] };
}

/// Keeps the stored editing state under the Durable Object value limit: the oldest undo steps go first, then the
/// oldest named versions (never the Original).
export function compact(state, maxBytes = 100_000) {
  const size = () => JSON.stringify(state).length;
  while (size() > maxBytes && state.undo.length) state.undo.shift();
  while (size() > maxBytes && state.redo.length) state.redo.shift();
  while (size() > maxBytes && state.versions.length > 2) state.versions.splice(1, 1);
  return state;
}

export function edit(state, op) {
  const r = applyOp(state.doc, op);
  if (r.error) return r;
  state.undo.push(state.doc);
  if (state.undo.length > HISTORY) state.undo.shift();
  state.redo = [];
  state.doc = r.doc;
  return { ok: true, said: r.said, id: r.id };
}

export function undo(state) {
  if (!state.undo.length) return { ok: false, said: 'Nothing to undo.' };
  state.redo.push(state.doc);
  state.doc = state.undo.pop();
  return { ok: true, said: 'Undone.' };
}
export function redo(state) {
  if (!state.redo.length) return { ok: false, said: 'Nothing to redo.' };
  state.undo.push(state.doc);
  state.doc = state.redo.pop();
  return { ok: true, said: 'Redone.' };
}

export function saveVersion(state, label) {
  // Ids never repeat, even after the oldest edits are dropped: they count every save, not the kept ones.
  const n = state.version_seq = Math.max(Number(state.version_seq) || 0, ...state.versions.map((x) => Number(String(x.id).slice(1)) || 0)) + 1;
  const v = { id: `v${n}`, label: clip(label, 40) || `Edit v${n}`, doc: copy(state.doc), at: new Date().toISOString() };
  state.versions.push(v);
  if (state.versions.length > 12) state.versions.splice(1, 1); // the Original is never dropped
  return v;
}
export function restoreVersion(state, id) {
  const v = state.versions.find((x) => x.id === id);
  if (!v) return { ok: false, said: 'No such version.' };
  state.undo.push(state.doc);
  state.redo = [];
  state.doc = copy(v.doc);
  return { ok: true, said: `Restored ${v.label}.` };
}

/// What differs between two documents, in words: for the A/B view's caption.
export function compareDocs(a, b) {
  const out = [];
  for (const k of Object.keys(ADJUSTMENTS)) if ((a.adjust?.[k] || 0) !== (b.adjust?.[k] || 0)) out.push(`${k} ${a.adjust?.[k] || 0} → ${b.adjust?.[k] || 0}`);
  if (a.filter !== b.filter) out.push(`look ${a.filter} → ${b.filter}`);
  if (a.kind === 'image' && JSON.stringify(a.transform) !== JSON.stringify(b.transform)) out.push('crop or rotation changed');
  if ((a.layers?.length || 0) !== (b.layers?.length || 0)) out.push(`${a.layers?.length || 0} → ${b.layers?.length || 0} layers`);
  if (a.kind === 'video') {
    if (a.clips.length !== b.clips.length) out.push(`${a.clips.length} → ${b.clips.length} clips`);
    if (round(duration(a), 1) !== round(duration(b), 1)) out.push(`${round(duration(a), 1)} s → ${round(duration(b), 1)} s`);
    if (a.captions.cues.length !== b.captions.cues.length) out.push(`${a.captions.cues.length} → ${b.captions.cues.length} captions`);
  }
  return out;
}

// ─── Smart resize ─────────────────────────────────────────────────────────

/// Adapts a document to another size without stretching: photos fill the new frame centred on their focus,
/// text keeps its edge (top, middle or bottom), logos keep their corner, everything stays inside a 5% safe margin,
/// and text is resized with the frame's shorter side.
export function smartResize(input, preset) {
  const p = PRESETS[preset];
  const doc = copy(input);
  const from = { w: doc.canvas.w, h: doc.canvas.h };
  doc.canvas = { ...doc.canvas, w: p.w, h: p.h };
  doc.preset = preset;
  const scaleText = Math.min(p.w / from.w, p.h / from.h) / Math.max(p.w / from.w, p.h / from.h);
  const fromAspect = from.w / from.h;
  const toAspect = p.w / p.h;
  const M = 0.05;
  const keepIn = (l) => { l.x = round(clamp(l.x, M, 1 - M - l.w)); l.y = round(clamp(l.y, M, 1 - M - l.h)); };
  if (doc.kind === 'image') {
    for (const l of doc.layers) {
      if (l.type === 'photo' || l.type === 'background') {
        l.x = 0; l.y = 0; l.w = 1; l.h = 1;
        l.fit = { mode: 'cover', focus: l.focus || { x: 0.5, y: 0.5 } };
        continue;
      }
      const cx = l.x + l.w / 2;
      const cy = l.y + l.h / 2;
      // Width and height are fractions of the frame: convert so the element keeps its real shape.
      const k = fromAspect / toAspect;
      let w = l.w * Math.min(1, k);
      let h = l.h * Math.min(1, 1 / k);
      if (l.type === 'text') { w = Math.min(1 - 2 * M, l.w * (k < 1 ? 1 : 1 / Math.max(1, k)) * (toAspect < fromAspect ? 1.6 : 1)); h = l.h * (toAspect < fromAspect ? 1 : 1 / Math.max(1, 1 / k)); if (l.text) l.text.size = round(l.text.size * Math.max(0.6, scaleText), 4); }
      l.w = round(Math.min(w, 1 - 2 * M)); l.h = round(Math.min(h, 1 - 2 * M));
      const band = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : 'middle';
      const side = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : 'center';
      l.x = side === 'left' ? M : side === 'right' ? 1 - M - l.w : 0.5 - l.w / 2;
      l.y = band === 'top' ? Math.max(M, l.y) : band === 'bottom' ? 1 - M - l.h - Math.max(0, 1 - (l.y + l.h) - M) * 0.5 : 0.5 - l.h / 2;
      keepIn(l);
    }
  } else {
    for (const c of doc.clips) {
      // Crop each clip to the new aspect around its focus instead of squashing it.
      const srcAspect = fromAspect;
      if (Math.abs(srcAspect - toAspect) < 0.01) continue;
      const w = srcAspect > toAspect ? toAspect / srcAspect : 1;
      const h = srcAspect > toAspect ? 1 : srcAspect / toAspect;
      const f = c.focus || { x: 0.5, y: 0.5 };
      c.crop = { x: round(clamp(f.x - w / 2, 0, 1 - w)), y: round(clamp(f.y - h / 2, 0, 1 - h)), w: round(w), h: round(h) };
    }
    for (const t of doc.text) { const l = t.layer; if (l.text) l.text.size = round(l.text.size * Math.max(0.6, scaleText), 4); l.w = Math.min(l.w * 1.3, 1 - 2 * M); keepIn(l); }
  }
  return doc;
}

// ─── Templates ────────────────────────────────────────────────────────────

const T = (id, name, category, kind, preset, build, extra = {}) => ({ id, name, category, kind, preset, system: true, build, ...extra });
const textL = (name, placeholder, style, x, y, w, h, value) => layer({ type: 'text', name, placeholder, style, x, y, w, h, value });

/// System templates. Each builds an ordinary document with named placeholders the owner replaces.
export const TEMPLATES = Object.freeze([
  T('tiktok-hook', 'TikTok Hook', 'TikTok', 'video', 'tiktok', () => scenes('tiktok', [3, 4, 4, 4], 'tiktok', 'fade'), { description: 'Hook text, three beats, captions' }),
  T('reels-clean', 'Reels Clean', 'Reels', 'video', 'reels', () => scenes('reels', [3, 5, 5], 'reels', 'dissolve')),
  T('shorts-story', 'Shorts Story', 'YouTube Shorts', 'video', 'shorts', () => scenes('shorts', [3, 5, 5, 5], 'shorts', 'slide')),
  T('youtube-intro', 'YouTube Intro', 'YouTube', 'video', 'youtube', () => scenes('youtube', [4, 8, 8], 'social', 'fade')),
  T('yt-thumb-bold', 'Bold Thumbnail', 'YouTube Thumbnail', 'image', 'thumbnail', () => image('thumbnail', [textL('Title', 'title', 'thumbnail', 0.05, 0.55, 0.6, 0.35, 'YOUR TITLE')], { adjust: { contrast: 15, vibrance: 20 } })),
  T('music-promo', 'Music Promo', 'Music Promo', 'video', 'tiktok', () => musicPromo('tiktok'), { description: 'Cover art, song title, artist, waveform, your song as audio' }),
  T('visualizer-wave', 'Cover + Waveform', 'Music Promo', 'video', 'square', () => visualizer('square', 'waveform')),
  T('visualizer-spectrum', 'Minimal Spectrum', 'Music Promo', 'video', 'youtube', () => visualizer('youtube', 'spectrum')),
  T('lyric-video', 'Lyric Video', 'Music Promo', 'video', 'youtube', () => { const d = visualizer('youtube', 'none'); d.captions.style = 'caption_bold'; d.captions.position = 0.5; return d; }, { description: 'Timed lyrics as captions over your artwork' }),
  T('album-cover', 'Album Cover', 'Album Cover', 'image', 'album', () => image('album', [textL('Artist', 'artist', 'album', 0.1, 0.08, 0.8, 0.08, 'ARTIST'), textL('Title', 'title', 'album', 0.1, 0.82, 0.8, 0.1, 'Album Title')], { filter: 'cinematic' })),
  T('single-cover', 'Single Cover', 'Single Cover', 'image', 'album', () => image('album', [textL('Title', 'title', 'album', 0.08, 0.84, 0.84, 0.09, 'Single')], { filter: 'clean' })),
  T('ad-square', 'Square Ad', 'Advertisement', 'image', 'square', () => image('square', [textL('Headline', 'title', 'ad', 0.08, 0.72, 0.84, 0.12, 'Your headline'), textL('Call to action', 'cta', 'social', 0.08, 0.86, 0.84, 0.06, 'Shop now')])),
  T('product-promo', 'Product Promo', 'Product Promo', 'video', 'reels', () => scenes('reels', [3, 4, 4, 3], 'ad', 'zoom')),
  T('podcast-clip', 'Podcast Clip', 'Podcast Clip', 'video', 'tiktok', () => { const d = scenes('tiktok', [20], 'social', 'cut'); d.captions.style = 'caption_karaoke'; return d; }),
  T('business-promo', 'Business Promo', 'Business Promo', 'video', 'youtube', () => scenes('youtube', [4, 6, 6, 4], 'ad', 'dissolve')),
  T('beat-preview', 'Beat Preview', 'Music Promo', 'video', 'square', () => beatPreview(), { description: 'Artwork, waveform, BPM and key, producer, licence call to action' }),
]);

function scenes(preset, lengths, style, transition) {
  const d = newVideoDoc({ preset });
  lengths.forEach((len, i) => {
    const c = videoClip({ name: `Scene ${i + 1}`, kind: 'image', duration: len });
    c.placeholder = `scene_${i + 1}`;
    if (i < lengths.length - 1 && transition !== 'cut') c.transition = { type: transition, duration: 0.4 };
    d.clips.push(c);
  });
  const hook = layer({ type: 'text', name: 'Hook', placeholder: 'title', style, x: 0.08, y: 0.12, w: 0.84, h: 0.12, value: 'Your hook here', animation: 'pop' });
  d.text.push({ id: hook.id, text: hook.text.value, layer: hook, start: 0, end: lengths[0] });
  return d;
}
function image(preset, layers, { filter = 'original', adjust = {} } = {}) {
  const d = newImageDoc({ preset });
  d.layers.push(layer({ type: 'photo', name: 'Photo', placeholder: 'artwork', x: 0, y: 0, w: 1, h: 1 }));
  d.layers.push(...layers);
  if (filter !== 'original') { d.filter = filter; d.adjust = { ...neutral(), ...FILTERS[filter] }; }
  Object.assign(d.adjust, adjust);
  return d;
}
function musicPromo(preset) {
  const d = newVideoDoc({ preset });
  const c = videoClip({ name: 'Artwork', kind: 'image', duration: 15 });
  c.placeholder = 'artwork';
  d.clips.push(c);
  const t1 = layer({ type: 'text', name: 'Song title', placeholder: 'title', style: 'tiktok', x: 0.08, y: 0.70, w: 0.84, h: 0.08, value: 'Song Title', animation: 'fade_in' });
  const t2 = layer({ type: 'text', name: 'Artist', placeholder: 'artist', style: 'social', x: 0.08, y: 0.79, w: 0.84, h: 0.05, value: 'Artist', animation: 'fade_in' });
  d.text.push({ id: t1.id, text: t1.text.value, layer: t1, start: 0, end: 15 }, { id: t2.id, text: t2.text.value, layer: t2, start: 0.5, end: 15 });
  d.visualizer = { kind: 'waveform', color: '#7FF5E6', y: 0.58, h: 0.08 };
  d.audio_placeholder = 'song';
  return d;
}
function visualizer(preset, kind) {
  const d = musicPromo(preset);
  d.visualizer = kind === 'none' ? null : { kind, color: '#7FF5E6', y: kind === 'spectrum' ? 0.75 : 0.6, h: kind === 'spectrum' ? 0.15 : 0.1 };
  return d;
}
function beatPreview() {
  const d = musicPromo('square');
  const meta = layer({ type: 'text', name: 'BPM and key', placeholder: 'bpm_key', style: 'social', x: 0.08, y: 0.86, w: 0.84, h: 0.05, value: '140 BPM · F# minor' });
  const cta = layer({ type: 'text', name: 'Licence', placeholder: 'cta', style: 'ad', x: 0.2, y: 0.06, w: 0.6, h: 0.07, value: 'Leases available' });
  d.text.push({ id: meta.id, text: meta.text.value, layer: meta, start: 0, end: 15 }, { id: cta.id, text: cta.text.value, layer: cta, start: 1, end: 15 });
  return d;
}

/// A template's document with its placeholders filled. Missing values keep the template's sample text.
export function useTemplate(template, fill = {}) {
  const doc = typeof template.build === 'function' ? template.build() : copy(template.doc);
  const set = (l) => {
    if (!l?.placeholder) return;
    const v = fill[l.placeholder];
    if (v === undefined || v === null) return;
    if (l.text) l.text.value = clip(v, 400); else l.asset = v;
  };
  for (const l of doc.layers || []) set(l);
  for (const t of doc.text || []) { set(t.layer); t.text = t.layer.text?.value || t.text; }
  for (const c of doc.clips || []) if (c.placeholder && fill[c.placeholder]) c.asset = fill[c.placeholder];
  if (fill.artwork && doc.kind === 'video') for (const c of doc.clips) if (c.placeholder === 'artwork' || (!c.asset && c.placeholder?.startsWith('scene'))) c.asset = fill.artwork;
  if (fill.song && doc.kind === 'video') {
    doc.audio.push({ id: uid('au'), asset: fill.song.media_id || null, project_ref: fill.song.project_id || null, name: clip(fill.song.title || 'Song', 40), role: 'music', start: 0, in: fill.song.start || 0, out: null, volume: 1, fade_in: 0.5, fade_out: 1, muted: false, normalize: true, clean: false, duck: false, eq: null });
  }
  doc.template = template.id;
  return doc;
}

/// "Save as Template": the layout with the owner's own media removed and replaced by placeholders.
export function templateFromDoc(doc, { name, category = 'Custom' }) {
  const t = copy(doc);
  // Layout only: every media asset is cleared, keeping (or giving) each its placeholder to fill later.
  const strip = (l) => { if (l && (l.asset || l.placeholder)) { l.placeholder ||= l.type === 'logo' ? 'logo' : 'artwork'; l.asset = null; } };
  for (const l of t.layers || []) strip(l);
  for (const x of t.text || []) strip(x.layer);
  for (const c of t.clips || []) { c.placeholder ||= 'scene'; c.asset = null; }
  if (t.audio) t.audio = [];
  t.captions && (t.captions.cues = []);
  return { id: uid('tpl'), name: clip(name, 60) || 'My template', category: clip(category, 40), kind: t.kind, preset: t.preset, system: false, doc: t, created_at: new Date().toISOString() };
}

// ─── Brand kits ───────────────────────────────────────────────────────────

/// A brand kit belongs to the owner (workspace null) or to one client/artist workspace, never both.
export function brandKit(input = {}) {
  return {
    id: input.id || uid('bk'), name: clip(input.name, 60) || 'Brand', workspace_id: input.workspace_id || null,
    logo: input.logo || null, colors: (input.colors || []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 6),
    font: clip(input.font, 40) || null, artist_name: clip(input.artist_name, 80) || null, watermark: input.watermark === true,
  };
}
export function applyBrand(input, kit) {
  const doc = copy(input);
  const texts = [...(doc.layers || []).filter((l) => l.text), ...(doc.text || []).map((t) => t.layer)];
  for (const l of texts) {
    if (kit.font) l.text.font = kit.font;
    if (kit.colors[0]) l.text.color = kit.colors[0];
    if (kit.artist_name && l.placeholder === 'artist') l.text.value = kit.artist_name;
  }
  if (kit.logo) {
    const logo = layer({ type: 'logo', name: 'Logo', asset: kit.logo, x: 0.83, y: 0.04, w: 0.13, h: 0.13, opacity: kit.watermark ? 0.6 : 1 });
    if (doc.kind === 'image') { doc.layers = doc.layers.filter((l) => l.type !== 'logo'); doc.layers.push(logo); } else { doc.text = doc.text.filter((t) => t.layer.type !== 'logo'); doc.text.push({ id: logo.id, text: '', layer: logo, start: 0, end: Math.max(1, duration(doc)) }); }
  }
  doc.brand_kit = kit.id;
  return doc;
}

// ─── One-tap improvements and suggestions ─────────────────────────────────

/// Each is an ordinary list of operations, so it is reversible with Undo like any manual edit.
export const IMPROVEMENTS = Object.freeze({
  auto_enhance: { label: 'Auto Enhance', ops: [{ op: 'adjust', key: 'contrast', delta: 8 }, { op: 'adjust', key: 'saturation', delta: 8 }, { op: 'adjust', key: 'sharpness', delta: 15 }] },
  improve_lighting: { label: 'Improve Lighting', ops: [{ op: 'adjust', key: 'exposure', delta: 10 }, { op: 'adjust', key: 'shadows', delta: 15 }, { op: 'adjust', key: 'highlights', delta: -10 }] },
  balance_color: { label: 'Balance Color', ops: [{ op: 'adjust', key: 'temperature', value: 0 }, { op: 'adjust', key: 'tint', value: 0 }] },
  clean_up: { label: 'Clean Up', ops: [{ op: 'adjust', key: 'clarity', delta: 10 }, { op: 'adjust', key: 'fade', value: 0 }] },
  improve_audio: { label: 'Improve Audio', video: true, ops: [{ op: 'audio', audio: 'music', normalize: true }, { op: 'audio', audio: 'voice', normalize: true }] },
  clean_voice: { label: 'Clean Voice', video: true, ops: [{ op: 'audio', audio: 'voice', clean: true }] },
});

/// Applies an improvement; operations whose target is missing are skipped and named.
export function improve(state, id) {
  const imp = IMPROVEMENTS[id];
  if (!imp) return { ok: false, said: 'Unknown improvement.' };
  const before = state.doc;
  const done = [];
  const skipped = [];
  let doc = state.doc;
  for (const op of imp.ops) {
    if (op.op === 'adjust' && doc.kind === 'video' && !VIDEO_ADJUSTMENTS.includes(op.key)) { skipped.push(op.key); continue; }
    const r = applyOp(doc, op);
    if (r.error) skipped.push(r.error); else { doc = r.doc; done.push(op.key || op.audio); }
  }
  if (!done.length) return { ok: false, said: `${imp.label} had nothing to change here${skipped.length ? `: ${skipped[0]}` : ''}.` };
  state.undo.push(before); state.redo = []; state.doc = doc;
  return { ok: true, said: `${imp.label} applied (${done.join(', ')}). Undo reverses it.` };
}

/// Suggestions from the project itself. Each one names a fix that is a real operation.
export function suggestions(doc) {
  const out = [];
  const texts = doc.kind === 'image' ? doc.layers.filter((l) => l.text && !l.hidden) : doc.text.map((t) => t.layer).filter((l) => l.text);
  for (const l of texts) {
    if (!l.text.outline && !l.text.shadow && !l.text.background && doc.layers?.some((p) => p.type === 'photo' && !p.hidden)) {
      out.push({ id: `readable_${l.id}`, text: `"${clip(l.text.value, 30)}" has no outline, shadow or backing, so it can be hard to read over the picture.`, fix: 'Fix', ops: [{ op: 'edit_layer', id: l.id, text: { shadow: { color: '#000000CC', blur: 8 } } }] });
    }
  }
  if (doc.kind === 'video') {
    const rows = timeline(doc);
    if (rows[0] && rows[0].length > 4 && !doc.text.some((t) => t.start < 3)) out.push({ id: 'slow_intro', text: `The first clip runs ${round(rows[0].length, 1)} s with no text in the first 3 seconds.`, fix: 'Trim Intro', ops: [{ op: 'trim', clip: rows[0].id, trim_start: Math.min(2, rows[0].length - 2) }] });
    if (doc.audio.some((a) => a.role === 'voice') && !doc.captions.cues.length) out.push({ id: 'captions', text: 'There is speech but no captions.', fix: 'Auto Captions', action: 'auto_captions' });
    const music = doc.audio.filter((a) => a.role === 'music');
    if (music.length && doc.audio.some((a) => a.role === 'voice') && music.some((a) => !a.duck)) out.push({ id: 'duck', text: 'Music is not ducked under the voice.', fix: 'Duck Music', ops: [{ op: 'audio', audio: 'music', duck: true }] });
    if (!doc.clips.length) out.push({ id: 'empty', text: 'The timeline is empty.', fix: 'Add media', action: 'import' });
  }
  return out.slice(0, 4);
}

// ─── Words → operations ───────────────────────────────────────────────────

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, half: 0.5 };
const num = (s) => (s === undefined ? null : NUMBER_WORDS[String(s).toLowerCase()] ?? Number(s));
const ORDINAL = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: -1 };

/// The owner's words turned into operations on the selected project. Several instructions joined by "and" or
/// commas are handled in order. Returns { ops, unsupported, understood }: unsupported lists what needs a provider or
/// was not understood, said plainly; nothing is guessed.
export function wordsToOps(text, doc, { selection = null, playhead = 0 } = {}) {
  const parts = String(text || '').replace(/^(?:che|hey che)[,\s]+/i, '').split(/\s*(?:,|;|\band then\b|\bthen\b|\band\b(?=\s+(?:make|cut|trim|add|remove|delete|move|give|put|split|mute|turn|apply|change|use)))\s*/i).map((s) => s.trim()).filter(Boolean);
  const ops = [];
  const unsupported = [];
  const understood = [];
  const clipAt = (word) => {
    if (!doc.clips?.length) return null;
    const i = ORDINAL[word];
    if (i === undefined) return selection && doc.clips.find((c) => c.id === selection) ? selection : null;
    return (i < 0 ? doc.clips.at(-1) : doc.clips[i])?.id || null;
  };
  const scopeFrom = (p) => {
    const m = p.match(/\b(first|second|third|fourth|fifth|last)\s+(?:scene|clip|shot)\b/i);
    if (m) return clipAt(m[1].toLowerCase()) ? `clip:${clipAt(m[1].toLowerCase())}` : null;
    if (/\b(?:this|selected)\s+(?:clip|scene)\b/i.test(p) && selection) return `clip:${selection}`;
    return 'all';
  };
  const textLayer = (p) => {
    const all = doc.kind === 'image' ? doc.layers.filter((l) => l.text) : doc.text.map((t) => t.layer).filter((l) => l.text);
    const named = all.find((l) => new RegExp(`\\b${l.name.split(/\s+/)[0]}\\b`, 'i').test(p));
    return named || (/\btitle\b/i.test(p) ? all.find((l) => l.placeholder === 'title') : null) || (selection ? all.find((l) => l.id === selection) : null) || all[0] || null;
  };
  for (const p of parts) {
    let m;
    const scope = scopeFrom(p);
    if (/^undo\b/i.test(p)) { ops.push({ op: 'undo' }); understood.push('undo'); continue; }
    if (/^redo\b/i.test(p)) { ops.push({ op: 'redo' }); understood.push('redo'); continue; }
    if (/\bbrighten (?:my |his |her |the )?face\b/i.test(p)) { unsupported.push(PROVIDER_FEATURES.face_brighten); continue; }
    if (/\bremove (?:that|the|this) (?:person|man|woman|guy|object|thing)\b|\berase\b/i.test(p)) { unsupported.push(PROVIDER_FEATURES.remove_object); continue; }
    if (/\b(?:remove|replace) (?:the )?background\b/i.test(p)) { unsupported.push(PROVIDER_FEATURES[/replace/i.test(p) ? 'replace_background' : 'remove_background']); continue; }
    if (/\bbackground darker\b|\bdarken the background\b/i.test(p)) {
      if (doc.kind === 'image' && doc.layers.some((l) => l.type === 'background')) { ops.push({ op: 'edit_layer', id: doc.layers.find((l) => l.type === 'background').id, opacity: 0.7 }); understood.push('darker background layer'); }
      else unsupported.push('Darkening only the background needs it separated from the subject (no segmentation engine connected). Say "darker" to darken everything.');
      continue;
    }
    if ((m = p.match(/\b(?:give it |make it |use )?(?:a |an )?(darker |dark )?(cinematic|warm|cool|vintage|vibrant|clean|black and white|b&w|dark|moody)\b(?: look| feel| vibe)?/i)) && /\blook|feel|vibe|style|cinematic|vintage|black and white/i.test(p)) {
      const name = { 'black and white': 'bw', 'b&w': 'bw', moody: 'dark' }[m[2].toLowerCase()] || m[2].toLowerCase();
      ops.push({ op: 'filter', name, scope });
      if (m[1]) ops.push({ op: 'adjust', key: 'brightness', delta: -12, scope }, { op: 'adjust', key: 'exposure', delta: -8, scope });
      understood.push(`${m[1] ? 'darker ' : ''}${name} look`);
      continue;
    }
    if ((m = p.match(/\b(?:make (?:it|this|that|the [a-z ]+?) |a bit |much )?(brighter|darker|lighter)\b/i)) || /\bbrighten\b|\blighten\b|\bdarken\b/i.test(p)) {
      const dir = /brighter|brighten|lighter|lighten/i.test(p) ? 1 : -1;
      const amt = /\ba (?:little|bit)\b|\bslightly\b/i.test(p) ? 8 : /\bmuch|a lot\b/i.test(p) ? 25 : 15;
      ops.push({ op: 'adjust', key: 'brightness', delta: dir * amt, scope });
      understood.push(`${dir > 0 ? 'brighter' : 'darker'}${scope !== 'all' ? ' (that scene)' : ''}`);
      continue;
    }
    if ((m = p.match(/\b(more|less) (contrast|saturat\w*|color|colour|warm\w*|sharp\w*|blur\w*|vignette)\b/i))) {
      const key = /contrast/i.test(m[2]) ? 'contrast' : /saturat|colou?r/i.test(m[2]) ? 'saturation' : /warm/i.test(m[2]) ? 'temperature' : /sharp/i.test(m[2]) ? 'sharpness' : /blur/i.test(m[2]) ? 'blur' : 'vignette';
      ops.push({ op: 'adjust', key, delta: (/more/i.test(m[1]) ? 1 : -1) * 15, scope });
      understood.push(`${m[1]} ${key}`);
      continue;
    }
    if ((m = p.match(/\b(?:cut|trim|take)\s+(\w+(?:\.\d+)?)\s+seconds?\s+(?:off|from)\s+(?:the\s+)?(intro|start|beginning|end|ending|outro)\b/i))) {
      const secs = num(m[1]);
      const atEnd = /end|outro/i.test(m[2]);
      const c = atEnd ? doc.clips?.at(-1) : doc.clips?.[0];
      if (!c || !secs) { unsupported.push('There is no clip to trim.'); continue; }
      ops.push({ op: 'trim', clip: c.id, [atEnd ? 'trim_end' : 'trim_start']: secs * c.speed });
      understood.push(`cut ${secs} s off the ${atEnd ? 'end' : 'intro'}`);
      continue;
    }
    if (/\bsplit(?: it)?(?: here)?\b/i.test(p)) { ops.push({ op: 'split', at: playhead }); understood.push(`split at ${round(playhead, 1)} s`); continue; }
    if ((m = p.match(/\b(?:remove|delete)\s+(?:the\s+)?(first|second|third|last|this)\s+(?:clip|scene|shot)\b/i))) {
      const id = m[1].toLowerCase() === 'this' ? selection : clipAt(m[1].toLowerCase());
      if (!id) { unsupported.push('There is no such clip.'); continue; }
      ops.push({ op: 'delete_clip', clip: id }); understood.push(`remove the ${m[1]} clip`); continue;
    }
    if ((m = p.match(/\bmake (?:this|it|the video)\s+(\w+)\s+seconds?(?: long)?\b/i))) { ops.push({ op: 'fit_duration', seconds: num(m[1]) }); understood.push(`${num(m[1])} seconds long`); continue; }
    if (/\b(?:add|make|generate)\s+(?:auto\s+)?captions\b/i.test(p)) { ops.push({ op: 'auto_captions' }); understood.push('add captions'); continue; }
    if ((m = p.match(/\b(?:make )?(?:the )?captions\s+(bigger|larger|smaller)\b/i))) { ops.push({ op: 'caption_style', scale: /bigger|larger/i.test(m[1]) ? 1.25 : 0.8 }); understood.push(`captions ${m[1]}`); continue; }
    if ((m = p.match(/\bmove (?:the )?([a-z ]+?)\s+(higher|up|lower|down|left|right)\b/i))) {
      const l = textLayer(m[1]) || doc.layers?.find((x) => x.name.toLowerCase().includes(m[1].toLowerCase()));
      if (!l) { unsupported.push(`I couldn't find "${m[1]}" in the project.`); continue; }
      const d = 0.05;
      ops.push({ op: 'move_layer', id: l.id, dx: /left/i.test(m[2]) ? -d : /right/i.test(m[2]) ? d : 0, dy: /higher|up/i.test(m[2]) ? -d : /lower|down/i.test(m[2]) ? d : 0 });
      understood.push(`move ${l.name} ${m[2]}`); continue;
    }
    if (/\b(?:text|title|words?)\b.*\b(?:easier to read|more readable|readable|pop)\b/i.test(p)) {
      const all = doc.kind === 'image' ? doc.layers.filter((l) => l.text) : doc.text.map((t) => t.layer).filter((l) => l.text);
      if (!all.length) { unsupported.push('There is no text yet.'); continue; }
      for (const l of all) ops.push({ op: 'edit_layer', id: l.id, text: { outline: { color: '#000000', width: 0.004 }, shadow: { color: '#000000CC', blur: 8 } } });
      understood.push('easier-to-read text'); continue;
    }
    if (/\b(?:put|add|place) my logo\b/i.test(p)) { ops.push({ op: 'brand_logo', corner: /left/i.test(p) ? 'left' : 'right', top: !/bottom/i.test(p) }); understood.push('logo in the corner'); continue; }
    if ((m = p.match(/\bmake (?:this|it) look like an? (album cover|single cover|thumbnail|ad)\b/i))) { ops.push({ op: 'template_look', template: { 'album cover': 'album-cover', 'single cover': 'single-cover', thumbnail: 'yt-thumb-bold', ad: 'ad-square' }[m[1].toLowerCase()] }); understood.push(`${m[1]} look`); continue; }
    if (/\b(?:more )?professional\b/i.test(p)) { ops.push({ op: 'improve', id: 'auto_enhance' }); if (doc.kind === 'image') ops.push({ op: 'filter', name: 'clean', scope: 'all' }); understood.push('a cleaner, more professional look'); continue; }
    if ((m = p.match(/\b(?:turn|make) (?:the )?(music|voice)\s+(up|down|louder|quieter|softer)\b|\b(music|voice)\s+(?:volume\s+)?(up|down|louder|quieter)\b/i))) {
      const role = (m[1] || m[3]).toLowerCase(); const up = /up|louder/i.test(m[2] || m[4]);
      ops.push({ op: 'audio', audio: role, volume_delta: up ? 0.15 : -0.15 }); understood.push(`${role} ${up ? 'louder' : 'quieter'}`); continue;
    }
    if (/\bmute\b/i.test(p)) { const role = /music/i.test(p) ? 'music' : /voice/i.test(p) ? 'voice' : null; if (role) ops.push({ op: 'audio', audio: role, muted: true }); else if (selection) ops.push({ op: 'clip', clip: selection, muted: true }); else { unsupported.push('Mute what: the music, the voice, or a selected clip?'); continue; } understood.push(`mute ${role || 'clip'}`); continue; }
    if ((m = p.match(/\bput the (chorus|hook|drop|verse) here\b/i))) { unsupported.push(`I don't know where the ${m[1]} starts in this song yet. Tell me its time (for example "the chorus starts at 0:45") and I'll line it up here.`); continue; }
    if ((m = p.match(/\b(fade|dissolve|slide|zoom|cut)\s+(?:transition|between)/i)) || (m = p.match(/\badd (?:a )?(fade|dissolve|slide|zoom) (?:transition)?\b/i))) {
      const id = selection && doc.clips?.find((c) => c.id === selection) ? selection : doc.clips?.[0]?.id;
      if (!id) { unsupported.push('There is no clip to add a transition to.'); continue; }
      ops.push({ op: 'transition', clip: id, type: m[1].toLowerCase(), duration: 0.5 }); understood.push(`${m[1]} transition`); continue;
    }
    unsupported.push(`I didn't understand "${clip(p, 60)}".`);
  }
  return { ops, unsupported, understood };
}

// ─── Rendering ────────────────────────────────────────────────────────────

/// The render specification for the ffmpeg renderer (tools/che_edit_render.py): every clip, trim, speed,
/// adjustment, transition, text, caption, audio level and visualizer, with sources as asset ids the render job
/// downloads through a one-time token. Nothing here is drawn by a model.
export function renderSpec(doc, { title = 'CHE edit' } = {}) {
  const missing = [];
  if (doc.kind === 'video') {
    if (!doc.clips.length) missing.push('the timeline has no clips');
    for (const c of doc.clips) if (!c.asset) missing.push(`${c.name} has no media`);
    for (const a of doc.audio) if (!a.asset) missing.push(`${a.name} has no audio file`);
  } else {
    for (const l of doc.layers) if (['photo', 'logo', 'image'].includes(l.type) && !l.asset && !l.hidden) missing.push(`${l.name} has no picture`);
  }
  if (missing.length) return { ok: false, why: `Not ready to render: ${missing.join('; ')}.` };
  const assets = [...new Set([...(doc.clips || []).map((c) => c.asset), ...(doc.audio || []).map((a) => a.asset), ...(doc.layers || []).map((l) => l.asset), ...(doc.text || []).map((t) => t.layer.asset)].filter(Boolean))];
  return { ok: true, spec: { v: 1, title: clip(title, 80), doc: copy(doc), assets, duration: doc.kind === 'video' ? round(duration(doc), 3) : 0 } };
}

export const RENDER_STAGES = Object.freeze(['preparing', 'rendering', 'finalizing', 'ready', 'failed']);

/// The render record's next stage from the GitHub run status. Ready only with a verified file; anything else stays
/// in progress or fails with its reason. A finished run without a verified file is a failure, never a 100% job.
export function nextRenderStage(job, status) {
  if (!status) return job;
  if (status.ok && status.verified) return { ...job, stage: 'ready', progress: 1, media_id: status.media_id || job.media_id, verified: status.verification, finished_at: new Date().toISOString() };
  if (status.ok && status.pending) return { ...job, stage: status.stage === 'running' ? 'rendering' : status.stage === 'checking' ? 'finalizing' : 'preparing', progress: status.stage === 'running' ? 0.5 : status.stage === 'checking' ? 0.9 : 0.1 };
  return { ...job, stage: 'failed', progress: job.progress || 0, error: status.error || 'The render failed.', retryable: true, finished_at: new Date().toISOString() };
}

// ─── Words ────────────────────────────────────────────────────────────────

/// Owner words that start or open Visual Studio work.
export function visualIntent(message) {
  const t = String(message || '').trim().replace(/[.!?]+$/, '');
  let m;
  if ((m = t.match(/\bmake (?:me )?(?:a |an )?(tiktok|reels?|shorts?|youtube)?\s*(?:promo|promotional) (?:video|clip)? ?for (?:this song|my song|the song|"?(.+?)"?)$/i))) return { kind: 'song_promo', platform: (m[1] || 'tiktok').toLowerCase().replace(/s$/, ''), title: m[2] || null };
  if ((m = t.match(/\b(?:create|make) (?:a )?(?:music )?visuali[sz]er for (?:this song|my song|"?(.+?)"?)$/i))) return { kind: 'visualizer', title: m[1] || null };
  if ((m = t.match(/\b(?:create|make) (?:a )?preview video for (?:the beat |my beat )?"?(.+?)"?$/i))) return { kind: 'beat_preview', beat: m[1] };
  if ((m = t.match(/\bmake versions? for (.+)$/i))) {
    const want = [];
    if (/tiktok/i.test(m[1])) want.push('tiktok');
    if (/instagram|reels?/i.test(m[1])) want.push('reels');
    if (/shorts/i.test(m[1])) want.push('shorts');
    if (/youtube(?! shorts)/i.test(m[1])) want.push('youtube');
    if (/square/i.test(m[1])) want.push('square');
    if (want.length) return { kind: 'variants', presets: want };
  }
  if ((m = t.match(/\buse my (.+?) template(?: but (.+))?$/i))) return { kind: 'use_template', name: m[1], tweak: m[2] || null };
  if ((m = t.match(/\bsave (?:this|it) as (?:a )?template(?: called (.+))?$/i))) return { kind: 'save_template', name: m[1] || null };
  if (/\buse my (?:artist )?brand\b/i.test(t)) return { kind: 'apply_brand' };
  if (/^(?:che,?\s*)?edit(?: it| this| that)?$/i.test(t)) return { kind: 'open_editor' };
  if (/^(?:render|export)(?: it| this| the video| the project)?$/i.test(t)) return { kind: 'render' };
  return null;
}
