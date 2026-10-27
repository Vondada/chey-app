// PCM16 mono -> WAV container so AVAudioPlayer can play it directly.
// Moved out of worker.js unchanged (worker.js size budget).
export function pcm16ToWav(pcm, sampleRate = 24000) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeText = (offset, text) => { for (let i = 0; i < text.length; i++) v.setUint8(offset + i, text.charCodeAt(i)); };
  writeText(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeText(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}
