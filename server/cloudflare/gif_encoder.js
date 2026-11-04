// A small GIF89a encoder (palette frames, LZW, looping) and simple procedural animations drawn with it, so CHE can make
// a real animated GIF inside the Worker with no model, network or paid service. Certification run 24 (41491194768),
// ivg-35: "Produce a short animated GIF of a bouncing ball and attach it" got a model reply with an invented imgur link.
//
// Format: GIF89a (https://www.w3.org/Graphics/GIF/spec-gif89a.txt): header, logical screen with a global colour table,
// the NETSCAPE2.0 looping extension, then per frame a graphic control extension (delay), an image descriptor and
// LZW-compressed palette indices in sub-blocks of at most 255 bytes.

/** LZW-compresses palette indices for GIF with the given minimum code size. Returns the byte stream (before sub-blocks). */
export function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = [];
  let bitBuf = 0;
  let bitLen = 0;
  let codeSize = minCodeSize + 1;
  const write = (code) => {
    bitBuf |= code << bitLen;
    bitLen += codeSize;
    while (bitLen >= 8) { out.push(bitBuf & 0xff); bitBuf >>>= 8; bitLen -= 8; }
  };
  let dict = new Map();
  let next = end + 1;
  write(clear);
  let prefix = indices.length ? indices[0] : 0;
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    write(prefix);
    if (next < 4096) {
      dict.set(key, next);
      next += 1;
      if (next > (1 << codeSize) && codeSize < 12) codeSize += 1;
    } else {
      write(clear);
      dict = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  if (indices.length) write(prefix);
  write(end);
  if (bitLen > 0) out.push(bitBuf & 0xff);
  return out;
}

/**
 * Encodes frames into an animated GIF. palette: [[r,g,b], ...] (2-256 colours); frames: Uint8Array of palette indices
 * (width*height each); delayCs: per-frame delay in hundredths of a second. Returns a Uint8Array.
 */
export function encodeGif({ width, height, palette, frames, delayCs = 6, loop = 0 }) {
  if (!(width > 0 && height > 0 && width <= 1024 && height <= 1024)) throw new Error('GIF size must be 1-1024 pixels');
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > 256) throw new Error('GIF palette needs 2-256 colours');
  if (!frames?.length) throw new Error('GIF needs at least one frame');
  let bits = 1;
  while ((1 << bits) < palette.length) bits += 1;
  const tableSize = 1 << bits;
  const bytes = [];
  const u16 = (n) => { bytes.push(n & 0xff, (n >> 8) & 0xff); };
  for (const c of 'GIF89a') bytes.push(c.charCodeAt(0));
  u16(width); u16(height);
  bytes.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0); // global table, colour resolution, table size; bg 0; aspect 0
  for (let i = 0; i < tableSize; i += 1) { const [r, g, b] = palette[i] || [0, 0, 0]; bytes.push(r & 255, g & 255, b & 255); }
  bytes.push(0x21, 0xff, 0x0b); for (const c of 'NETSCAPE2.0') bytes.push(c.charCodeAt(0));
  bytes.push(0x03, 0x01); u16(loop); bytes.push(0x00);
  const minCode = Math.max(2, bits);
  for (const frame of frames) {
    if (frame.length !== width * height) throw new Error('every GIF frame must be width x height indices');
    bytes.push(0x21, 0xf9, 0x04, 0x00); u16(delayCs); bytes.push(0x00, 0x00);
    bytes.push(0x2c); u16(0); u16(0); u16(width); u16(height); bytes.push(0x00);
    bytes.push(minCode);
    const data = lzwEncode(frame, minCode);
    for (let i = 0; i < data.length; i += 255) { const chunk = data.slice(i, i + 255); bytes.push(chunk.length, ...chunk); }
    bytes.push(0x00);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

/** Reads a GIF back: its size, frame count and loop flag, from the bytes (a check that the file is what was made). */
export function inspectGif(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  const head = String.fromCharCode(...b.slice(0, 6));
  if (head !== 'GIF89a' && head !== 'GIF87a') return { ok: false, reason: 'not a GIF' };
  const width = b[6] | (b[7] << 8);
  const height = b[8] | (b[9] << 8);
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  let frames = 0;
  let loops = false;
  while (p < b.length) {
    const tag = b[p];
    if (tag === 0x3b) return { ok: true, width, height, frames, loops, bytes: b.length };
    if (tag === 0x21) {
      if (b[p + 1] === 0xff && String.fromCharCode(...b.slice(p + 3, p + 14)) === 'NETSCAPE2.0') loops = true;
      p += 2;
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p += 1;
    } else if (tag === 0x2c) {
      frames += 1;
      const packed = b[p + 9];
      p += 10;
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
      p += 1; // LZW minimum code size
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p += 1;
    } else return { ok: false, reason: `unexpected block 0x${tag.toString(16)}` };
  }
  return { ok: false, reason: 'no GIF trailer' };
}

// ─── Procedural animations ───
const COLOURS = {
  red: [220, 50, 47], orange: [235, 120, 30], yellow: [240, 200, 40], green: [60, 170, 80], blue: [40, 110, 220],
  purple: [130, 70, 190], pink: [230, 100, 160], white: [245, 245, 245], black: [25, 25, 25], grey: [140, 140, 140], gray: [140, 140, 140],
};
export const ANIMATION_SHAPES = ['ball', 'square'];
export const ANIMATION_MOTIONS = ['bounce', 'slide', 'pulse', 'spin'];

/** The animation a message asks for: { shape, motion, colour }, or null when it names no shape and motion this draws. */
export function animationSpec(message = '') {
  const t = String(message || '').toLowerCase();
  if (!/\b(?:gif|animation|animated)\b/.test(t)) return null;
  const shape = /\b(?:ball|circle|dot|sphere)\b/.test(t) ? 'ball' : /\b(?:square|box|block|cube)\b/.test(t) ? 'square' : null;
  const motion = /\bbounc/.test(t) ? 'bounce' : /\b(?:slid|mov(?:e|ing)\s+across|roll)/.test(t) ? 'slide' : /\b(?:puls|grow|breath)/.test(t) ? 'pulse' : /\b(?:spin|rotat)/.test(t) ? 'spin' : null;
  if (!shape || !motion) return null;
  const colour = Object.keys(COLOURS).find((c) => new RegExp(`\\b${c}\\b`).test(t)) || (shape === 'ball' ? 'red' : 'blue');
  return { shape, motion, colour };
}

/** Draws the animation's frames and encodes the GIF. Returns { bytes, width, height, frames, delayCs, seconds }. */
export function makeAnimation({ shape = 'ball', motion = 'bounce', colour = 'red', size = 96, frameCount = 16, delayCs = 6 } = {}) {
  const W = size; const H = size;
  const palette = [[250, 250, 252], COLOURS[colour] || COLOURS.red, [200, 200, 208], [120, 120, 130]]; // bg, shape, shadow, floor
  const frames = [];
  const r = Math.round(size * 0.12);
  const floorY = H - 6;
  for (let f = 0; f < frameCount; f += 1) {
    const ph = f / frameCount;
    const px = new Uint8Array(W * H);
    for (let x = 0; x < W; x += 1) px[floorY * W + x] = 3;
    let cx = W / 2; let cy = H / 2; let rad = r; let angle = 0;
    if (motion === 'bounce') { const h = Math.abs(Math.sin(Math.PI * ph)); cy = floorY - r - 1 - h * (H * 0.6); }
    else if (motion === 'slide') { cx = r + 2 + (W - 2 * r - 4) * (0.5 - 0.5 * Math.cos(2 * Math.PI * ph)); cy = floorY - r - 1; }
    else if (motion === 'pulse') { rad = r * (0.7 + 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * ph))); }
    else if (motion === 'spin') { angle = 2 * Math.PI * ph; }
    // Shadow on the floor, smaller when the shape is higher.
    const lift = Math.max(0, (floorY - (cy + rad)) / H);
    const sw = Math.max(2, Math.round(rad * (1 - lift)));
    for (let x = Math.round(cx - sw); x <= Math.round(cx + sw); x += 1) if (x >= 0 && x < W) px[(floorY - 1) * W + x] = 2;
    for (let y = 0; y < floorY - 1; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const dx = x - cx; const dy = y - cy;
        let inside;
        if (shape === 'ball') inside = dx * dx + dy * dy <= rad * rad;
        else { const c = Math.cos(angle); const s = Math.sin(angle); const u = dx * c + dy * s; const v = -dx * s + dy * c; inside = Math.abs(u) <= rad && Math.abs(v) <= rad; }
        if (inside) px[y * W + x] = 1;
      }
    }
    frames.push(px);
  }
  const bytes = encodeGif({ width: W, height: H, palette, frames, delayCs, loop: 0 });
  return { bytes, width: W, height: H, frames: frameCount, delayCs, seconds: (frameCount * delayCs) / 100 };
}
