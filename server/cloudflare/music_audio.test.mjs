import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeWav, encodeWav, analyzeWav, gainMatch, integratedLoudness, estimateTempo, brightnessHz } from './music_audio.js';

const FS = 48000;
const sine = (freq, amp, seconds, fs = FS) => Float32Array.from({ length: Math.round(seconds * fs) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / fs));

// Short noise bursts on every beat, near-silence between: a click track with a known tempo.
function clicks(bpm, seconds, fs = FS) {
  const x = new Float32Array(Math.round(seconds * fs));
  const period = Math.round((60 / bpm) * fs);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let start = 0; start < x.length; start += period) {
    for (let i = 0; i < Math.round(0.015 * fs) && start + i < x.length; i++) x[start + i] = 0.8 * rnd() * Math.exp(-i / (0.004 * fs));
  }
  return x;
}

test('loudness follows BS.1770: a 1 kHz tone at -20 dBFS reads about -23 LUFS mono, -20 LUFS stereo', () => {
  const tone = sine(1000, 0.1, 5);
  const monoL = integratedLoudness([tone], FS);
  const stereoL = integratedLoudness([tone, tone], FS);
  assert.ok(Math.abs(monoL - -23.0) < 0.3, `mono ${monoL}`);
  assert.ok(Math.abs(stereoL - -20.0) < 0.3, `stereo ${stereoL}`);
  assert.ok(Math.abs(integratedLoudness([sine(1000, 0.1, 5, 44100)], 44100) - monoL) < 0.1, 'the same at 44.1 kHz');
});

test('tempo is measured from the audio, with a confidence', () => {
  for (const bpm of [120, 90, 140]) {
    const t = estimateTempo([clicks(bpm, 20)], FS);
    assert.ok(Math.abs(t.bpm - bpm) <= 2, `${bpm} measured ${t.bpm}`);
    assert.ok(t.confidence > 0.5, `clear clicks give a clear peak (${t.confidence})`);
  }
  const flat = estimateTempo([sine(440, 0.3, 20)], FS);
  assert.equal(flat.bpm, null, 'a steady tone has no beat, so no tempo is reported');
  assert.match(flat.why, /No clear beat/);
  assert.equal(estimateTempo([sine(440, 0.3, 2)], FS).bpm, null, 'too short is said, not guessed');
});

test('brightness is the spectral centroid of the audio', () => {
  const low = brightnessHz([sine(1000, 0.3, 3)], FS);
  const high = brightnessHz([sine(4000, 0.3, 3)], FS);
  assert.ok(Math.abs(low - 1000) < 120, `1 kHz tone: ${low}`);
  assert.ok(high > low * 3, `4 kHz tone is brighter: ${high}`);
});

test('decode and encode WAV: 16-bit and 24-bit PCM, values preserved', () => {
  const tone = sine(440, 0.5, 0.2);
  const wav16 = encodeWav([tone, tone], FS);
  const d = decodeWav(wav16);
  assert.equal(d.sampleRate, FS);
  assert.equal(d.channels.length, 2);
  assert.ok(Math.abs(d.channels[0][100] - tone[100]) < 1e-4);
  // 24-bit by hand: one frame of +0.5 and -0.25.
  const b = new Uint8Array(44 + 6);
  const v = new DataView(b.buffer);
  const w = (at, s) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 42, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, FS, true); v.setUint32(28, FS * 3, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
  w(36, 'data'); v.setUint32(40, 6, true);
  const put24 = (at, x) => { const n = Math.round(x * 8388608) & 0xffffff; b[at] = n & 255; b[at + 1] = (n >> 8) & 255; b[at + 2] = (n >> 16) & 255; };
  put24(44, 0.5); put24(47, -0.25);
  const d24 = decodeWav(b);
  assert.ok(Math.abs(d24.channels[0][0] - 0.5) < 1e-6);
  assert.ok(Math.abs(d24.channels[0][1] + 0.25) < 1e-6);
  assert.equal(decodeWav(new Uint8Array([1, 2, 3])).error, 'Not a WAV file.');
});

test('analyzeWav: every number comes from the decoded file; other formats are not analysed', () => {
  const song = Float32Array.from(clicks(120, 20), (v, i) => v + 0.05 * Math.sin((2 * Math.PI * 220 * i) / FS));
  const a = analyzeWav(encodeWav([song, song], FS));
  assert.equal(a.analysed, true);
  assert.equal(a.sample_rate, FS);
  assert.equal(a.duration_s, 20);
  assert.ok(Math.abs(a.tempo_bpm - 120) <= 2);
  assert.ok(Number.isFinite(a.loudness_lufs) && a.loudness_lufs < 0);
  assert.ok(a.peak_dbfs <= 0);
  const mp3 = analyzeWav(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(mp3.analysed, false);
  assert.match(mp3.why, /Not a WAV/);
});

test('gain match makes a new file at the target and leaves the source bytes unchanged', () => {
  const src = encodeWav([sine(1000, 0.1, 5)], FS);
  const copy = Uint8Array.from(src);
  const r = gainMatch(src, -16);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.after_lufs - -16) < 0.3, `reached ${r.after_lufs}`);
  assert.equal(r.limited_by_peak, false);
  assert.deepEqual(src, copy, 'the original bytes are untouched');
  assert.notDeepEqual(r.wav, src);
  const loud = gainMatch(src, 0);
  assert.equal(loud.limited_by_peak, true, 'a target that would clip is stopped at the ceiling and says so');
  assert.ok(analyzeWav(loud.wav).peak_dbfs <= -0.9);
});
