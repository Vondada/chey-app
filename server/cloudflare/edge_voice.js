// Hosted voice. Edge neural Ava, then the caller falls back to Kokoro.
// Audio exists only when the speech socket returns bytes.

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`;
const VOICE = 'en-US-AvaNeural';

function ssml(text, voice) {
  const safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<speak version='1.0' xml:lang='en-US'><voice name='${voice}'>${safe}</voice></speak>`;
}

export async function edgeSpeak(env, text) {
  const said = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!said) return { ok: false, error: 'Nothing to say.' };
  const voice = String(env.CHE_EDGE_VOICE || VOICE);
  const requestId = crypto.randomUUID().replace(/-/g, '');
  try {
    const socket = new WebSocket(`${WSS}&ConnectionId=${requestId}`, [
      'synthesize',
    ]);
    const audio = await new Promise((resolve, reject) => {
      const chunks = [];
      const timer = setTimeout(() => reject(new Error('Edge voice timed out.')), 12000);
      socket.addEventListener('open', () => {
        socket.send(`X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
        socket.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml(said, voice)}`);
      });
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) chunks.push(new Uint8Array(event.data));
        if (typeof event.data === 'string' && event.data.includes('Path:turn.end')) {
          clearTimeout(timer);
          socket.close();
          resolve(chunks);
        }
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Edge voice did not respond.'));
      });
    });
    const bytes = audio.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!bytes) return { ok: false, error: 'Edge voice returned no audio.', voice };
    return { ok: true, voice, bytes, audio: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error), voice };
  }
}
