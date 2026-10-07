import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeAudioFrame, edgeSpeak } from './edge_voice.js';
function frame(payload) {
  const header = new TextEncoder().encode('Path:audio\r\nContent-Type:audio/mpeg\r\n');
  return Uint8Array.from([header.length >> 8, header.length & 255, ...header, ...payload]).buffer;
}
test('Edge binary frames strip the length prefix and protocol headers', () => {
  assert.deepEqual([...edgeAudioFrame(frame([255, 251, 0, 17]))], [255, 251, 0, 17]);
  assert.throws(() => edgeAudioFrame(new Uint8Array([0, 50, 1]).buffer));
});
test('Edge uses a Workers upgrade and closes the completed socket', async () => {
  const events = new Map(); let closed = false;
  const socket = {
    addEventListener: (name, fn) => events.set(name, fn), accept() {},
    send(text) { if (text.includes('Path:ssml')) queueMicrotask(() => {
      events.get('message')({ data: frame([255, 251, 17]) });
      events.get('message')({ data: 'Path:turn.end\r\n' });
    }); }, close() { closed = true; },
  };
  const result = await edgeSpeak({}, 'Hello', async (_, opts) => {
    assert.equal(opts.headers.Upgrade, 'websocket'); return { webSocket: socket };
  });
  assert.equal(result.ok, true); assert.deepEqual([...result.mp3], [255, 251, 17]); assert.equal(closed, true);
});
test('Edge denial returns fallback without claiming audio', async () => {
  const result = await edgeSpeak({}, 'Hello', async () => new Response('', { status: 403 }));
  assert.equal(result.ok, false); assert.equal(result.mp3, undefined);
});
