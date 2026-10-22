// CHE INTERNAL RENDERER (owner, 2026-10-22: "knowledge must become capability"). A scene graph and a software
// rasterizer in plain JavaScript, a PNG encoder and a PNG decoder/verifier. It runs inside CHE's own Worker: no
// external app, no API, no key. Everything it draws is procedural and is labelled that way, never "AI-generated".
//
// Scenes are built from named components (sky, sun, ocean, shoreline, sand, palms...), so a scene's recipe is
// reusable knowledge: the same skill renders variations (sunset, night, stormy) and animation frames.

export const RENDERER_VERSION = 1;
export const DEFAULT_SIZE = Object.freeze({ w: 640, h: 360 });
export const MAX_SIZE = Object.freeze({ w: 1280, h: 720 });
export const PROVENANCE = 'procedural (CHE internal renderer)';

// ─── Canvas ────────────────────────────────────────────────────────────────

export class Canvas {
  constructor(w, h, { deadline = Infinity, signal = null } = {}) {
    if (!(w > 0 && h > 0) || w > MAX_SIZE.w || h > MAX_SIZE.h) throw new Error(`Size ${w}x${h} is outside 1x1..${MAX_SIZE.w}x${MAX_SIZE.h}.`);
    this.w = w | 0; this.h = h | 0;
    this.px = new Uint8ClampedArray(this.w * this.h * 4);
    this.deadline = deadline; this.signal = signal;
  }
  // Time budget and cancellation, checked once per row of every layer.
  tick() {
    if (this.signal?.aborted) throw new Error('Render cancelled.');
    if (Date.now() > this.deadline) throw new Error('Render ran past its time budget.');
  }
  blend(x, y, [r, g, b], a = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4, p = this.px;
    const k = a >= 1 ? 1 : a;
    p[i] = p[i] + (r - p[i]) * k; p[i + 1] = p[i + 1] + (g - p[i + 1]) * k; p[i + 2] = p[i + 2] + (b - p[i + 2]) * k; p[i + 3] = 255;
  }
  get(x, y) { const i = (y * this.w + x) * 4; return [this.px[i], this.px[i + 1], this.px[i + 2]]; }
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const hex = (s) => { const v = parseInt(String(s).replace('#', ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

// Seeded randomness so a recipe renders the same picture every time.
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
// Value noise with smooth interpolation, octaves summed (fBm).
export function noise2(seed) {
  const r = rng(seed), size = 256, perm = new Uint8Array(512), val = new Float32Array(size);
  for (let i = 0; i < size; i++) { perm[i] = i; val[i] = r(); }
  for (let i = size - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < size; i++) perm[i + size] = perm[i];
  const at = (x, y) => val[perm[(perm[x & 255] + y) & 511]];
  const smooth = (t) => t * t * (3 - 2 * t);
  const one = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), tx = smooth(x - xi), ty = smooth(y - yi);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), tx), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), tx), ty);
  };
  return (x, y, octaves = 4) => { let sum = 0, amp = 0.5, f = 1, norm = 0; for (let o = 0; o < octaves; o++) { sum += one(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2; } return sum / norm; };
}

// ─── Primitives ────────────────────────────────────────────────────────────

export function verticalGradient(c, y0, y1, stops) {
  const a = Math.max(0, Math.floor(y0)), b = Math.min(c.h, Math.ceil(y1));
  for (let y = a; y < b; y++) {
    c.tick();
    const t = (y - y0) / Math.max(1, y1 - y0);
    let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const col = mix(c0, c1, clamp01((t - t0) / Math.max(1e-6, t1 - t0)));
    for (let x = 0; x < c.w; x++) c.blend(x, y, col, 1);
  }
}

/** Filled polygon (even-odd scanline), with optional alpha. */
export function polygon(c, pts, color, alpha = 1) {
  if (pts.length < 3) return;
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(c.h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    c.tick();
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.round(xs[k])); x < Math.min(c.w, Math.round(xs[k + 1])); x++) c.blend(x, y, color, alpha);
  }
}

/** A soft disc: solid core with a glow that fades to the radius times `glow`. */
export function disc(c, cx, cy, r, color, { glow = 1, alpha = 1 } = {}) {
  const R = r * glow, y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(c.h - 1, Math.ceil(cy + R));
  for (let y = y0; y <= y1; y++) {
    c.tick();
    for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(c.w - 1, Math.ceil(cx + R)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) c.blend(x, y, color, alpha);
      else if (d <= R) c.blend(x, y, color, alpha * 0.55 * (1 - (d - r) / (R - r)) ** 2);
    }
  }
}

// 5x7 bitmap font for captions and watermarks (uppercase, digits, a little punctuation).
const FONT = {
  A: '0111010001100011111110001100011000110001', B: '1111010001100011111010001100011000111110', C: '0111010001100001000010000100001000101110',
  D: '1111010001100011000110001100011000111110', E: '1111110000100001111010000100001000011111', F: '1111110000100001111010000100001000010000',
  G: '0111010001100001011110001100011000101111', H: '1000110001100011111110001100011000110001', I: '0111000100001000010000100001000010001110',
  J: '0011100010000100001000010100101001001100', K: '1000110010101001100010100100101000110001', L: '1000010000100001000010000100001000011111',
  M: '1000111011101011000110001100011000110001', N: '1000110001110011010110011100011000110001', O: '0111010001100011000110001100011000101110',
  P: '1111010001100011111010000100001000010000', Q: '0111010001100011000110101100101001001101', R: '1111010001100011111010100100101000110001',
  S: '0111110000100000111000001000010000111110', T: '1111100100001000010000100001000010000100', U: '1000110001100011000110001100011000101110',
  V: '1000110001100011000110001100010101000100', W: '1000110001100011000110101101011101110001', X: '1000110001010100010001010100011000110001',
  Y: '1000110001010100010000100001000010000100', Z: '1111100001000100010001000100001000011111', ' ': '0'.repeat(35),
  0: '0111010001100111010111001100011000101110', 1: '0010001100001000010000100001000010001110', 2: '0111010001000010001000100010001000011111',
  3: '1111100010001000001000001000011000101110', 4: '0001000110010101001011111000100001000010', 5: '1111110000111100000100001000011000101110',
  6: '0011001000100001111010001100011000101110', 7: '1111100001000100010001000010000100001000', 8: '0111010001100010111010001100011000101110',
  9: '0111010001100010111100001000010001001100', '.': '0000000000000000000000000000000110001100', '-': '0000000000000001111100000000000000000000',
};
export function text(c, str, x, y, scale, color, alpha = 1) {
  let cx = x;
  for (const ch of String(str).toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) if (g[r * 5 + col] === '1') {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) c.blend(cx + col * scale + dx, y + r * scale + dy, color, alpha);
    }
    cx += 6 * scale;
  }
}

// ─── Scene components ──────────────────────────────────────────────────────

/** The looks a beach can have. Each is data: the same components render every one of them. */
export const BEACH_LOOKS = Object.freeze({
  day: { sky: ['#2f7fd8', '#7fc4f0', '#cfe9f7'], sun: { color: '#fff6d5', x: 0.78, y: 0.16, r: 0.045, glow: 3 }, sea: ['#1c8fb5', '#0d5f8a', '#08405f'], sand: ['#e9d3a1', '#d9b97c'], foam: '#f4fbff', haze: '#d8eef7', grade: null, clouds: 0.5 },
  sunset: { sky: ['#2c2a6b', '#e8644a', '#ffb35c'], sun: { color: '#ffd27a', x: 0.5, y: 0.4, r: 0.06, glow: 4 }, sea: ['#c9614a', '#5c2f55', '#2a1d3f'], sand: ['#e2b07c', '#b47e52'], foam: '#ffd9b8', haze: '#ffb08a', grade: ['#ff8a4c', 0.12], clouds: 0.35 },
  night: { sky: ['#03061a', '#14215a', '#34508f'], sun: { color: '#e8eefc', x: 0.25, y: 0.18, r: 0.035, glow: 2.4 }, sea: ['#0a1838', '#081430', '#040a1a'], sand: ['#6d6a76', '#4a4855'], foam: '#a9b8de', haze: '#34508f', grade: ['#1a2a6a', 0.15], clouds: 0.15, stars: 160 },
  stormy: { sky: ['#3a4048', '#5d666f', '#8a9198'], sun: null, sea: ['#3f5a63', '#2b4048', '#1b2a30'], sand: ['#a89a82', '#857a66'], foam: '#d8dee0', haze: '#9aa2a8', grade: ['#55606a', 0.12], clouds: 0.95, rain: 900 },
});

/** Scene graph for a beach: an ordered list of named component layers. */
export function beachScene(recipe) {
  const look = BEACH_LOOKS[recipe.look] || BEACH_LOOKS.day;
  const layers = [
    { type: 'sky', colors: look.sky.map(hex), clouds: look.clouds },
    ...(look.stars ? [{ type: 'stars', count: look.stars }] : []),
    ...(look.sun ? [{ type: 'sun', ...look.sun, color: hex(look.sun.color) }] : []),
    { type: 'ocean', colors: look.sea.map(hex), waves: recipe.waves ?? 0.6, reflection: look.sun ? hex(look.sun.color) : null, sunX: look.sun?.x ?? 0.5 },
    { type: 'atmosphere', color: hex(look.haze), strength: 0.35 },
    { type: 'sand', colors: look.sand.map(hex) },
    { type: 'shoreline', color: hex(look.foam) },
    ...Array.from({ length: Math.max(0, Math.min(6, recipe.palms ?? 2)) }, (_, i) => ({ type: 'palm', index: i })),
    ...(look.rain ? [{ type: 'rain', count: look.rain }] : []),
    ...(look.grade ? [{ type: 'grade', color: hex(look.grade[0]), amount: look.grade[1] }] : []),
    ...(recipe.caption ? [{ type: 'caption', text: recipe.caption }] : []),
  ];
  return { kind: 'beach', recipe, horizon: recipe.horizon ?? 0.45, shore: recipe.shore ?? 0.68, layers };
}

const COMPONENTS = {
  sky(c, l, s, n) {
    const hy = s.horizon * c.h;
    verticalGradient(c, 0, hy + 1, [[0, l.colors[0]], [0.65, l.colors[1]], [1, l.colors[2]]]);
    if (l.clouds > 0) {
      for (let y = 0; y < hy; y++) {
        c.tick();
        for (let x = 0; x < c.w; x++) {
          const v = n(x / 90, y / 30 + 7, 4);
          const a = clamp01((v - (0.62 - l.clouds * 0.18)) * 3) * 0.8 * (1 - y / hy * 0.6);
          if (a > 0) c.blend(x, y, mix(l.colors[2], [255, 255, 255], 0.6), a);
        }
      }
    }
  },
  stars(c, l, s, _n, r) {
    const hy = s.horizon * c.h;
    for (let i = 0; i < l.count; i++) { const x = (r() * c.w) | 0, y = (r() * hy * 0.9) | 0; c.blend(x, y, [255, 255, 255], 0.5 + r() * 0.5); }
  },
  sun(c, l, s) { disc(c, l.x * c.w, Math.min(l.y, s.horizon - 0.02) * c.h, l.r * c.h * 2, l.color, { glow: l.glow }); },
  ocean(c, l, s, n) {
    const hy = s.horizon * c.h, sy = s.shore * c.h, phase = s.recipe.phase || 0;
    verticalGradient(c, hy, sy + c.h * 0.04, [[0, l.colors[0]], [0.5, l.colors[1]], [1, l.colors[2]]]);
    for (let y = Math.floor(hy); y < sy + c.h * 0.03; y++) {
      c.tick();
      const depth = Math.min(1, (y - hy) / Math.max(1, sy - hy)), freq = 0.04 + depth * 0.02;
      for (let x = 0; x < c.w; x++) {
        const w = Math.sin(x * freq + y * 0.9 + phase * 2 * Math.PI) * 0.5 + 0.5;
        const v = n(x / 25, y / 4 + phase * 3, 2);
        const crest = clamp01((w * 0.6 + v * 0.6 - 0.85) * 4) * l.waves;
        if (crest > 0) c.blend(x, y, [255, 255, 255], crest * (0.25 + depth * 0.35));
        if (l.reflection) {
          const dx = Math.abs(x / c.w - l.sunX) * (3 - depth * 1.5);
          const glint = clamp01(1 - dx * 6) * clamp01(w - 0.3) * 0.55;
          if (glint > 0) c.blend(x, y, l.reflection, glint);
        }
      }
    }
  },
  atmosphere(c, l, s) {
    const hy = s.horizon * c.h, band = c.h * 0.08;
    for (let y = Math.max(0, Math.floor(hy - band)); y < Math.min(c.h, hy + band); y++) {
      c.tick();
      const a = (1 - Math.abs(y - hy) / band) * l.strength;
      for (let x = 0; x < c.w; x++) c.blend(x, y, l.color, a);
    }
  },
  sand(c, l, s, n) {
    for (let y = 0; y < c.h; y++) {
      c.tick();
      for (let x = 0; x < c.w; x++) {
        const edge = s.shore * c.h + Math.sin(x / c.w * Math.PI * 2.2 + 0.7) * c.h * 0.025;
        if (y < edge) continue;
        const t = (y - edge) / Math.max(1, c.h - edge), grain = n(x / 3, y / 3, 3);
        const base = mix(l.colors[0], l.colors[1], clamp01(t * 1.2));
        c.blend(x, y, mix(base, [0, 0, 0], (grain - 0.5) * 0.18), 1);
      }
    }
  },
  shoreline(c, l, s) {
    const phase = s.recipe.phase || 0;
    for (let x = 0; x < c.w; x++) {
      const edge = s.shore * c.h + Math.sin(x / c.w * Math.PI * 2.2 + 0.7) * c.h * 0.025;
      const reach = 4 + Math.sin(x / 23 + phase * 2 * Math.PI) * 3;
      for (let d = -reach; d < 2; d++) c.blend(x, Math.round(edge + d), l.color, 0.75 * (1 - Math.abs(d) / (reach + 2)));
    }
  },
  palm(c, l, s, _n, r) {
    const side = l.index % 2 === 0 ? 0.1 + l.index * 0.06 : 0.9 - l.index * 0.06;
    const bx = side * c.w, by = c.h * (0.92 - (l.index % 3) * 0.04), height = c.h * (0.42 - (l.index % 3) * 0.06);
    const lean = (side < 0.5 ? 1 : -1) * height * 0.25, trunk = [40, 28, 18], leaf = [24, 70, 34];
    const tx = bx + lean, ty = by - height;
    polygon(c, [[bx - 6, by], [bx + 6, by], [tx + 3, ty], [tx - 3, ty]], trunk);
    for (let f = 0; f < 7; f++) {
      const a = (f / 7) * Math.PI * 2 + r() * 0.3, len = height * (0.35 + r() * 0.12);
      const ex = tx + Math.cos(a) * len, ey = ty + Math.sin(a) * len * 0.45 + len * 0.18;
      const px = -Math.sin(a) * 7, py = Math.cos(a) * 4;
      polygon(c, [[tx, ty], [lerp(tx, ex, 0.5) + px, lerp(ty, ey, 0.5) + py - 4], [ex, ey], [lerp(tx, ex, 0.5) - px, lerp(ty, ey, 0.5) - py + 4]], leaf);
    }
  },
  rain(c, l, _s, _n, r) {
    for (let i = 0; i < l.count; i++) { const x = r() * c.w, y = r() * c.h, len = 6 + r() * 8; for (let k = 0; k < len; k++) c.blend(Math.round(x - k * 0.3), Math.round(y + k), [200, 210, 220], 0.35); }
  },
  grade(c, l) {
    for (let y = 0; y < c.h; y++) { c.tick(); for (let x = 0; x < c.w; x++) c.blend(x, y, l.color, l.amount); }
  },
  caption(c, l) {
    const scale = Math.max(2, Math.round(c.h / 120)), width = String(l.text).length * 6 * scale;
    text(c, l.text, Math.round((c.w - width) / 2) + scale, c.h - 10 * scale + scale, scale, [0, 0, 0], 0.5);
    text(c, l.text, Math.round((c.w - width) / 2), c.h - 10 * scale, scale, [255, 255, 255]);
  },
};
export const COMPONENT_NAMES = Object.freeze(Object.keys(COMPONENTS));

/** Renders a scene graph to an RGBA canvas within a time budget. Returns the canvas and which components ran. */
export function renderScene(scene, { w = DEFAULT_SIZE.w, h = DEFAULT_SIZE.h, budgetMs = 8000, signal = null, version = RENDERER_VERSION } = {}) {
  const started = Date.now();
  const c = new Canvas(w, h, { deadline: started + budgetMs, signal });
  const seed = (scene.recipe?.seed ?? 7) >>> 0;
  const n = noise2(seed), r = rng(seed ^ 0x9e3779b9);
  const used = [];
  for (const layer of scene.layers) {
    const draw = COMPONENTS[layer.type];
    if (!draw) throw new Error(`Unknown component "${layer.type}".`);
    draw(c, layer, scene, n, r, version);
    used.push(layer.type);
  }
  return { canvas: c, components: [...new Set(used)], ms: Date.now() - started };
}

// ─── PNG ───────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes, start = 0, end = bytes.length) { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function adler32(bytes) { let a = 1, b = 0; for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }

async function streamBytes(input, stream) {
  const out = new Response(new Blob([input]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
/** zlib deflate: CompressionStream when the runtime has it, otherwise stored (uncompressed) deflate blocks. */
export async function zlibDeflate(raw, { forceStored = false } = {}) {
  if (!forceStored && typeof CompressionStream === 'function') {
    try { return await streamBytes(raw, new CompressionStream('deflate')); } catch (_) { /* fall back */ }
  }
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535)), len = part.length;
    out[o++] = i === blocks - 1 ? 1 : 0; out[o++] = len & 255; out[o++] = len >> 8; out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255;
    out.set(part, o); o += len;
  }
  const ad = adler32(raw);
  out[o++] = ad >>> 24; out[o++] = (ad >>> 16) & 255; out[o++] = (ad >>> 8) & 255; out[o++] = ad & 255;
  return out.subarray(0, o);
}
async function zlibInflate(data) {
  if (typeof DecompressionStream !== 'function') throw new Error('This runtime cannot decompress PNG data.');
  return streamBytes(data, new DecompressionStream('deflate'));
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** RGB PNG (8-bit, filter 0) with a tEXt chunk saying how it was made. */
export async function encodePng(canvas, { forceStored = false, meta = PROVENANCE } = {}) {
  const { w, h, px } = canvas, raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { const row = y * (1 + w * 3); raw[row] = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, o = row + 1 + x * 3; raw[o] = px[i]; raw[o + 1] = px[i + 1]; raw[o + 2] = px[i + 2]; } }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const textData = new TextEncoder().encode(`Software\u0000${meta}`);
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('tEXt', textData), chunk('IDAT', await zlibDeflate(raw, { forceStored })), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Re-opens a PNG: signature, every chunk CRC, IHDR, inflate, unfilter. Returns pixels (RGB) or a reason. */
export async function decodePng(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 33) return { ok: false, reason: 'too short to be a PNG' };
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return { ok: false, reason: 'not a PNG signature' };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 8, w = 0, h = 0, ct = 0, depth = 0; const idat = []; let ended = false; const text = {};
    while (o + 12 <= bytes.length) {
      const len = dv.getUint32(o), type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
      if (o + 12 + len > bytes.length) return { ok: false, reason: `chunk ${type} runs past the end` };
      if (crc32(bytes, o + 4, o + 8 + len) !== dv.getUint32(o + 8 + len)) return { ok: false, reason: `chunk ${type} CRC mismatch` };
      const data = bytes.subarray(o + 8, o + 8 + len);
      if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); depth = data[8]; ct = data[9]; }
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'tEXt') { const z = data.indexOf(0); text[new TextDecoder().decode(data.subarray(0, z))] = new TextDecoder().decode(data.subarray(z + 1)); }
      else if (type === 'IEND') { ended = true; break; }
      o += 12 + len;
    }
    if (!ended) return { ok: false, reason: 'no IEND chunk' };
    if (!w || !h || depth !== 8 || ![2, 6].includes(ct)) return { ok: false, reason: 'unsupported PNG layout' };
    const all = new Uint8Array(idat.reduce((n, d) => n + d.length, 0)); let k = 0; for (const d of idat) { all.set(d, k); k += d.length; }
    const raw = await zlibInflate(all);
    const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
    if (raw.length !== h * (stride + 1)) return { ok: false, reason: 'image data size does not match its dimensions' };
    const rgb = new Uint8Array(w * h * 3), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], cc = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
        cur[i] = (line[i] + pred) & 255;
      }
      for (let x = 0; x < w; x++) { rgb[(y * w + x) * 3] = cur[x * bpp]; rgb[(y * w + x) * 3 + 1] = cur[x * bpp + 1]; rgb[(y * w + x) * 3 + 2] = cur[x * bpp + 2]; }
      prev.set(cur);
    }
    return { ok: true, width: w, height: h, rgb, text };
  } catch (error) {
    return { ok: false, reason: `the PNG could not be decoded (${String(error?.message || error).slice(0, 80)})` };
  }
}

// ─── Evaluation ────────────────────────────────────────────────────────────

const meanOf = (img, y0, y1) => {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, Math.floor(y0 * img.height)); y < Math.min(img.height, Math.ceil(y1 * img.height)); y++) for (let x = 0; x < img.width; x += 2) { const i = (y * img.width + x) * 3; r += img.rgb[i]; g += img.rgb[i + 1]; b += img.rgb[i + 2]; n++; }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
};
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Checks a decoded beach picture against its own scene: not blank, sky above / sea between / sand below each close
 * to the colours the look asked for, and a visible horizon. Pixel facts, not opinion.
 */
export function evaluateBeach(img, scene) {
  const look = BEACH_LOOKS[scene.recipe.look] || BEACH_LOOKS.day;
  const hz = scene.horizon, sh = scene.shore;
  const sky = meanOf(img, 0.02, hz * 0.5), sea = meanOf(img, hz + 0.04, (hz + sh) / 2), sand = meanOf(img, Math.min(0.97, sh + 0.12), 0.99);
  let sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < img.rgb.length; i += 3 * 37) { const l = lum([img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]]); sum += l; sumSq += l * l; n++; }
  const spread = Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2));
  const above = meanOf(img, hz - 0.03, hz - 0.01), below = meanOf(img, hz + 0.01, hz + 0.03);
  const expected = { sky: hex(look.sky[1]), sea: hex(look.sea[1]), sand: hex(look.sand[0]) };
  const checks = {
    not_blank: spread > 12,
    sky_colour: dist(sky, mix(expected.sky, hex(look.sky[0]), 0.5)) < 120,
    sea_colour: dist(sea, expected.sea) < 110,
    sand_colour: dist(sand, expected.sand) < 110,
    horizon_visible: dist(above, below) > 14,
    regions_distinct: dist(sea, sand) > 40,
  };
  return { ok: Object.values(checks).every(Boolean), checks, facts: { sky: sky.map(Math.round), sea: sea.map(Math.round), sand: sand.map(Math.round), contrast: Math.round(spread) } };
}

// ─── Words → recipe ────────────────────────────────────────────────────────

/** "a sunset beach with three palm trees" → a beach recipe; null when the words are not a beach scene. */
export function beachRecipe(words, base = {}) {
  const t = String(words || '').toLowerCase();
  if (!/\b(beach|shore|seaside|coast|ocean scene|sea scene|tropical island)\b/.test(t) && !base.look) return null;
  const look = /\bsunset|sundown|dusk|golden hour\b/.test(t) ? 'sunset' : /\bnight|moon|midnight|starry|stars\b/.test(t) ? 'night' : /\bstorm|stormy|rain|rainy|overcast|grey|gray\b/.test(t) ? 'stormy' : /\b(day|sunny|noon|morning|bright)\b/.test(t) ? 'day' : base.look || 'day';
  const NUM = { no: 0, zero: 0, one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const m = t.match(/\b(no|zero|one|a|two|three|four|five|six|\d)\s+palm/);
  const palms = m ? (NUM[m[1]] ?? Number(m[1])) : /\bno (?:trees|palms)\b/.test(t) ? 0 : base.palms ?? 2;
  const cap = String(words || '').match(/(?:caption|text|title)\s+(?:saying\s+|that says\s+)?["“]([^"”]{1,40})["”]/i);
  const waves = /\bcalm|still|glassy\b/.test(t) ? 0.2 : /\brough|big waves|surf\b/.test(t) ? 1 : base.waves ?? 0.6;
  const size = /\b(?:youtube|wide|landscape|16:9)\b/.test(t) ? { w: 640, h: 360 } : /\b(?:square|instagram)\b/.test(t) ? { w: 480, h: 480 } : /\b(?:tiktok|vertical|portrait|phone wallpaper|9:16)\b/.test(t) ? { w: 360, h: 640 } : base.size || { w: 640, h: 360 };
  return { scene: 'beach', look, palms: Math.min(6, palms), waves, caption: cap ? cap[1] : base.caption || '', seed: base.seed ?? 7, size };
}

// ─── Loops ─────────────────────────────────────────────────────────────────

/**
 * INTERNAL SCENE / BEACH SCENE LOOP with the INTERNAL RENDER LOOP inside it. Checkpoints: the scene, the preview and
 * the final render are kept, so an export failure retries only the export. Repairs: a failed preview check changes
 * the recipe (seed, palms, waves) and renders the preview again, at most `maxRepairs` times.
 */
export async function beachLoop(recipe, { size = recipe.size || DEFAULT_SIZE, budgetMs = 15000, maxRepairs = 2, exportPng = encodePng, signal = null, version = RENDERER_VERSION } = {}) {
  const steps = [];
  const started = Date.now();
  let scene = beachScene(recipe);
  steps.push({ step: 'scene constructed', ok: true, components: scene.layers.map((l) => l.type) });
  let preview = null;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const p = renderScene(scene, { w: 160, h: Math.max(90, Math.round(160 * size.h / size.w)), budgetMs, signal, version });
    const img = await decodePng(await encodePng(p.canvas));
    const evaluation = img.ok ? evaluateBeach(img, scene) : { ok: false, checks: { decodes: false } };
    steps.push({ step: attempt ? `preview after repair ${attempt}` : 'preview rendered', ok: evaluation.ok, checks: evaluation.checks });
    if (evaluation.ok) { preview = evaluation; break; }
    if (attempt === maxRepairs) return { ok: false, steps, reason: `The preview failed its checks: ${Object.entries(evaluation.checks).filter(([, v]) => !v).map(([k]) => k.replace(/_/g, ' ')).join(', ')}.` };
    recipe = { ...recipe, seed: (recipe.seed || 7) + 101, palms: Math.min(recipe.palms, 2), waves: Math.min(recipe.waves, 0.6) };
    scene = beachScene(recipe);
  }
  const final = renderScene(scene, { w: size.w, h: size.h, budgetMs: Math.max(1000, budgetMs - (Date.now() - started)), signal, version });
  steps.push({ step: 'final rendered', ok: true, ms: final.ms });
  let png = null, lastError = '';
  for (let attempt = 0; attempt < 2 && !png; attempt++) {
    try {
      const bytes = await exportPng(final.canvas, { forceStored: attempt > 0 });
      const check = await decodePng(bytes);
      if (!check.ok) throw new Error(check.reason);
      if (check.width !== size.w || check.height !== size.h) throw new Error(`the PNG is ${check.width}x${check.height}, not ${size.w}x${size.h}`);
      const verified = evaluateBeach(check, scene);
      if (!verified.ok) throw new Error('the final picture failed its checks');
      png = { bytes, verification: { width: check.width, height: check.height, bytes: bytes.length, checks: verified.checks, facts: verified.facts } };
    } catch (error) {
      lastError = String(error?.message || error);
      steps.push({ step: `export attempt ${attempt + 1}`, ok: false, error: lastError });
    }
  }
  if (!png) return { ok: false, steps, reason: `The export failed: ${lastError}. The scene and render were kept.` };
  steps.push({ step: 'exported and verified', ok: true, bytes: png.bytes.length });
  return { ok: true, recipe, scene, components: final.components, png: png.bytes, verification: png.verification, preview, steps, ms: Date.now() - started };
}

/** Frames for the internal video engine: the same recipe with the waves and shoreline moving. */
export async function beachFrames(recipe, { frames = 24, size = { w: 320, h: 180 }, budgetMs = 20000 } = {}) {
  const out = [];
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    const scene = beachScene({ ...recipe, phase: i / frames });
    const r = renderScene(scene, { w: size.w, h: size.h, budgetMs: Math.max(500, budgetMs - (Date.now() - started)) });
    out.push(await encodePng(r.canvas));
  }
  return out;
}

export function describeRecipe(recipe, components = []) {
  const parts = [`a ${recipe.look} beach`, recipe.palms ? `${recipe.palms} palm tree${recipe.palms === 1 ? '' : 's'}` : 'no palm trees', recipe.waves >= 0.9 ? 'rough waves' : recipe.waves <= 0.3 ? 'calm water' : 'gentle waves'];
  if (recipe.caption) parts.push(`the caption "${recipe.caption}"`);
  const named = components.map((c) => (c === 'sun' && recipe.look === 'night' ? 'moon' : c === 'grade' ? 'colour grade' : c === 'palm' ? 'palm trees' : c));
  return `${parts.join(', ')}. Built from ${named.join(', ')}`;
}
