// Real audio measurements for CHE Music, from the decoded samples of an uploaded file. Nothing here
// reads a filename, a tag or a conversation to guess what a recording sounds like.
//
// Supported input: WAV (PCM 16/24/32-bit integer, 32-bit float, incl. WAVE_FORMAT_EXTENSIBLE).
// Other formats need a decoder outside the Worker and are reported as not analysed.
//
// Measurements:
//   integrated loudness  ITU-R BS.1770-4: K-weighting, 400 ms blocks with 75% overlap,
//                        absolute gate -70 LUFS, relative gate -10 LU
//   sample peak          dBFS (not true peak: no oversampling)
//   tempo estimate       onset-strength autocorrelation, 60-180 BPM, with a confidence
//   brightness           mean spectral centroid in Hz
//   loudness range       spread of short-term (3 s) loudness, 10th to 95th percentile, in LU
// Every number can be recomputed from the same file. Tempo is an estimate and says how sure it is.

export function decodeWav(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at, n) => String.fromCharCode(...b.subarray(at, at + n));
  if (b.length < 12 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return { error: 'Not a WAV file.' };
  let fmt = null;
  let data = null;
  for (let at = 12; at + 8 <= b.length;) {
    const id = ascii(at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      let format = view.getUint16(body, true);
      const bits = view.getUint16(body + 14, true);
      if (format === 0xFFFE && size >= 40) format = view.getUint16(body + 24, true);
      fmt = { format, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits };
    } else if (id === 'data') {
      data = { at: body, size: Math.min(size, b.length - body) };
      break;
    }
    at = body + size + (size & 1);
  }
  if (!fmt || !data) return { error: 'The WAV file has no format or no audio data.' };
  const { format, channels, sampleRate, bits } = fmt;
  const bytesPer = bits / 8;
  if (!(format === 1 && [16, 24, 32].includes(bits)) && !(format === 3 && bits === 32)) return { error: `WAV encoding ${format}/${bits}-bit is not supported.` };
  const frames = Math.floor(data.size / (bytesPer * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const p = data.at + (i * channels + c) * bytesPer;
      let v;
      if (format === 3) v = view.getFloat32(p, true);
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 24) { const x = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); v = ((x & 0x800000) ? x - 0x1000000 : x) / 8388608; }
      else v = view.getInt32(p, true) / 2147483648;
      out[c][i] = v;
    }
  }
  return { sampleRate, channels: out, bits, format: format === 3 ? 'float' : 'pcm' };
}

/// A WAV file from channel data (16-bit PCM). Used to write new versions; the source is never touched.
export function encodeWav(channels, sampleRate) {
  const n = channels[0]?.length || 0;
  const ch = channels.length;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const w = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(44 + (i * ch + c) * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
    }
  }
  return new Uint8Array(buf);
}

// ─── Loudness (ITU-R BS.1770-4) ───────────────────────────────────────────

function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// K-weighting filter coefficients for any sample rate (the BS.1770 pre-filter and RLB high-pass).
function kWeighting(fs) {
  const shelf = (() => {
    const G = 3.99984385397, Q = 0.7071752369554193, fc = 1681.9744509555319;
    const A = 10 ** (G / 40), w0 = (2 * Math.PI * fc) / fs, alpha = Math.sin(w0) / (2 * Q), cw = Math.cos(w0), sa = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) - (A - 1) * cw + sa;
    return [A * ((A + 1) + (A - 1) * cw + sa) / a0, -2 * A * ((A - 1) + (A + 1) * cw) / a0, A * ((A + 1) + (A - 1) * cw - sa) / a0, 2 * ((A - 1) - (A + 1) * cw) / a0, ((A + 1) - (A - 1) * cw - sa) / a0];
  })();
  const hp = (() => {
    const Q = 0.5003270373253953, fc = 38.13547087613982, w0 = (2 * Math.PI * fc) / fs, alpha = Math.sin(w0) / (2 * Q), cw = Math.cos(w0);
    const a0 = 1 + alpha;
    return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, (-2 * cw) / a0, (1 - alpha) / a0];
  })();
  return [shelf, hp];
}

function blockPowers(channels, fs, blockSec, stepSec) {
  const [shelf, hp] = kWeighting(fs);
  const weighted = channels.map((x) => biquad(biquad(x, shelf), hp));
  const size = Math.round(blockSec * fs);
  const step = Math.round(stepSec * fs);
  const n = weighted[0].length;
  const out = [];
  for (let start = 0; start + size <= n; start += step) {
    let sum = 0;
    for (const w of weighted) {
      let ms = 0;
      for (let i = start; i < start + size; i++) ms += w[i] * w[i];
      sum += ms / size;
    }
    out.push(sum);
  }
  return out;
}

const lufs = (power) => -0.691 + 10 * Math.log10(power);

export function integratedLoudness(channels, fs) {
  const blocks = blockPowers(channels, fs, 0.4, 0.1);
  if (!blocks.length) return null;
  const abs = blocks.filter((p) => lufs(p) > -70);
  if (!abs.length) return -Infinity;
  const rel = lufs(abs.reduce((s, p) => s + p, 0) / abs.length) - 10;
  const gated = abs.filter((p) => lufs(p) > rel);
  return lufs(gated.reduce((s, p) => s + p, 0) / gated.length);
}

export function loudnessRange(channels, fs) {
  const st = blockPowers(channels, fs, 3, 1).map(lufs).filter((l) => l > -70);
  if (st.length < 2) return 0;
  const mean = 10 * Math.log10(st.map((l) => 10 ** (l / 10)).reduce((a, b) => a + b, 0) / st.length);
  const gated = st.filter((l) => l > mean - 20).sort((a, b) => a - b);
  const q = (p) => gated[Math.min(gated.length - 1, Math.floor(p * (gated.length - 1)))];
  return gated.length ? q(0.95) - q(0.1) : 0;
}

export function samplePeakDb(channels) {
  let peak = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

// ─── Tempo and brightness ─────────────────────────────────────────────────

function mono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const m = new Float32Array(n);
  for (const x of channels) for (let i = 0; i < n; i++) m[i] += x[i] / channels.length;
  return m;
}

/// Tempo from the onset strength (rise in short-time energy), autocorrelated over 60-180 BPM.
/// Confidence is the normalised autocorrelation at the chosen lag (0 = no repeating beat, 1 = perfectly
/// regular). A signal with no onsets reports no tempo rather than a guess.
export function estimateTempo(channels, fs) {
  const x = mono(channels);
  // Energy in dB over a ~43 ms window every 10 ms: long enough that a steady tone's cycle does not
  // ripple the energy, short enough to place a drum hit.
  const hop = Math.round(fs * 0.01);
  const win = Math.round(fs * 0.043);
  const frames = Math.floor((x.length - win) / hop);
  if (frames < 400) return { bpm: null, confidence: 0, why: 'Too short to estimate a tempo.' };
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < f * hop + win; i++) e += x[i] * x[i];
    energy[f] = 10 * Math.log10(e / win + 1e-10);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  const mean = onset.reduce((s, v) => s + v, 0) / frames;
  for (let f = 0; f < frames; f++) onset[f] -= mean;
  let r0 = 0;
  for (let f = 0; f < frames; f++) r0 += onset[f] * onset[f];
  r0 /= frames;
  // Under 0.02 dB of average rise per frame there are no attacks to count (a steady tone measures
  // about a thousandth of that; drums over a sustained bed measure several times more).
  if (mean < 0.02 || r0 < 1e-8) return { bpm: null, confidence: 0, why: 'No clear beat in the audio.' };
  const fps = fs / hop;
  const minLag = Math.round((60 / 180) * fps);
  const maxLag = Math.round((60 / 60) * fps);
  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0;
    for (let f = lag; f < frames; f++) r += onset[f] * onset[f - lag];
    r /= frames - lag;
    if (r > best) { best = r; bestLag = lag; }
  }
  // Refine the lag with a parabola through its neighbours.
  const at = (lag) => { let r = 0; for (let f = lag; f < frames; f++) r += onset[f] * onset[f - lag]; return r / (frames - lag); };
  const l = at(bestLag - 1), c = best, r = at(bestLag + 1);
  const shift = (l - r) / (2 * (l - 2 * c + r)) || 0;
  const bpm = (60 * fps) / (bestLag + Math.max(-0.5, Math.min(0.5, shift)));
  const confidence = Math.max(0, Math.min(1, best / r0));
  if (confidence < 0.1) return { bpm: null, confidence: Math.round(confidence * 100) / 100, why: 'No clear beat in the audio.' };
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const cr = Math.cos(ang * k), ci = Math.sin(ang * k);
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * cr - ai * ci, ti = ar * ci + ai * cr;
        re[i + k + len / 2] = re[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr; im[i + k] += ti;
      }
    }
  }
}

/// Mean spectral centroid (Hz) over 2048-sample frames with audible energy.
export function brightnessHz(channels, fs, maxFrames = 400) {
  const x = mono(channels);
  const N = 2048;
  const total = Math.floor(x.length / N);
  if (!total) return null;
  const stride = Math.max(1, Math.floor(total / maxFrames));
  let weighted = 0, energy = 0;
  for (let f = 0; f < total; f += stride) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[f * N + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      weighted += mag * (k * fs) / N;
      energy += mag;
    }
  }
  return energy > 0 ? Math.round(weighted / energy) : null;
}

/// Every measurement for one file, or the reason it was not analysed.
export function analyzeWav(bytes) {
  const d = decodeWav(bytes);
  if (d.error) return { analysed: false, why: d.error };
  const { channels, sampleRate } = d;
  const seconds = channels[0].length / sampleRate;
  const tempo = estimateTempo(channels, sampleRate);
  const round = (v, p = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** p) / 10 ** p : null);
  return {
    analysed: true,
    method: 'BS.1770-4 loudness, sample peak, onset autocorrelation tempo, spectral centroid',
    sample_rate: sampleRate, channels: channels.length, bits: d.bits, duration_s: round(seconds, 2),
    loudness_lufs: round(integratedLoudness(channels, sampleRate)),
    peak_dbfs: round(samplePeakDb(channels)),
    loudness_range_lu: round(loudnessRange(channels, sampleRate)),
    tempo_bpm: tempo.bpm, tempo_confidence: tempo.confidence,
    brightness_hz: brightnessHz(channels, sampleRate),
  };
}

/// A gain-matched copy toward a loudness target, never above `ceilingDb` sample peak. Returns the new
/// WAV bytes and what was actually reached; the input bytes are not modified.
export function gainMatch(bytes, targetLufs, { ceilingDb = -1 } = {}) {
  const d = decodeWav(bytes);
  if (d.error) return { ok: false, why: d.error };
  const before = integratedLoudness(d.channels, d.sampleRate);
  const peak = samplePeakDb(d.channels);
  let gainDb = targetLufs - before;
  let limited = false;
  if (peak + gainDb > ceilingDb) { gainDb = ceilingDb - peak; limited = true; }
  const g = 10 ** (gainDb / 20);
  const out = d.channels.map((x) => Float32Array.from(x, (v) => v * g));
  const wav = encodeWav(out, d.sampleRate);
  const after = integratedLoudness(decodeWav(wav).channels, d.sampleRate);
  return { ok: true, wav, gain_db: Math.round(gainDb * 100) / 100, before_lufs: Math.round(before * 10) / 10, after_lufs: Math.round(after * 10) / 10, limited_by_peak: limited };
}
