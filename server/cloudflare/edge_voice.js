// Hosted voice. Returns mp3 bytes only when Edge sends them.

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`;
const VOICE = 'en-US-AvaNeural';

function ssml(text, voice) {
  const safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<speak version='1.0' xml:lang='en-US'><voice name='${voice}'>${safe}</voice></speak>`;
}

function concat(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function edgeSpeak(env, text) {
  const said = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!said) return { ok: false, error: 'Nothing to say.' };
  const voice = String(env.CHE_EDGE_VOICE || VOICE);
  const requestId = crypto.randomUUID().replace(/-/g, '');
  try {
    const socket = new WebSocket(`${WSS}&ConnectionId=${requestId}`);
    const chunks = await new Promise((resolve, reject) => {
      const audio = [];
      const timer = setTimeout(() => reject(new Error('Edge voice timed out.')), 12000);
      socket.addEventListener('open', () => {
        socket.send(`X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
        socket.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml(said, voice)}`);
      });
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          const headerEnd = bytes.indexOf(0);
          audio.push(headerEnd >= 0 ? bytes.slice(headerEnd + 1) : bytes);
        }
        if (typeof event.data === 'string' && event.data.includes('Path:turn.end')) {
          clearTimeout(timer);
          socket.close();
          resolve(audio);
        }
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Edge voice did not respond.'));
      });
    });
    const mp3 = concat(chunks);
    if (!mp3.length) return { ok: false, error: 'Edge voice returned no audio.', voice };
    return { ok: true, voice, mp3 };
  } catch (error) {
    return { ok: false, error: String(error.message || error), voice };
  }
}
