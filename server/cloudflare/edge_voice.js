// Optional Edge voice. Fail closed to the existing voice fallback when the
// service is unavailable; never treat protocol headers or partial audio as MP3.
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const ENDPOINT = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`;
const VOICE = 'en-US-AvaNeural';
const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');

export function edgeAudioFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 2) throw new Error('Missing Edge frame header.');
  const length = (bytes[0] << 8) | bytes[1];
  if (length + 2 > bytes.length) throw new Error('Invalid Edge frame length.');
  const headers = new TextDecoder().decode(bytes.subarray(2, length + 2));
  if (!/^Path:audio\r?$/im.test(headers)) return new Uint8Array();
  return bytes.slice(length + 2);
}

export async function edgeSpeak(env = {}, text, fetcher = fetch) {
  const said = String(text || '').replace(/\s+/g, ' ').trim();
  if (!said || said.length > 800) return { ok: false, error: 'Use the existing voice for this text.' };
  const voice = String(env.CHE_EDGE_VOICE || VOICE);
  const requestId = crypto.randomUUID().replace(/-/g, '');
  let socket;
  try {
    const response = await fetcher(`${ENDPOINT}&ConnectionId=${requestId}`, {
      headers: { Upgrade: 'websocket' }, signal: AbortSignal.timeout(4000),
    });
    socket = response.webSocket;
    if (!socket) throw new Error('Edge voice unavailable.');
    const chunks = await new Promise((resolve, reject) => {
      const audio = [];
      let size = 0;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(audio);
      };
      const timer = setTimeout(() => finish(new Error('Edge voice timed out.')), 5000);
      socket.addEventListener('message', event => {
        try {
          if (event.data instanceof ArrayBuffer) {
            const chunk = edgeAudioFrame(event.data);
            size += chunk.length;
            if (size > 2 * 1024 * 1024) throw new Error('Edge audio too large.');
            if (chunk.length) audio.push(chunk);
          } else if (typeof event.data === 'string' && /(?:^|\r\n)Path:turn.end(?:\r\n|$)/.test(event.data)) {
            finish();
          }
        } catch (error) { finish(error); }
      });
      socket.addEventListener('error', () => finish(new Error('Edge voice failed.')));
      socket.addEventListener('close', () => finish(new Error('Edge voice closed before completion.')));
      socket.accept();
      try {
        socket.send(`X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
        socket.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version='1.0' xml:lang='en-US'><voice name='${escapeXml(voice)}'>${escapeXml(said)}</voice></speak>`);
      } catch (error) { finish(error); }
    });
    const mp3 = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) { mp3.set(chunk, offset); offset += chunk.length; }
    if (!mp3.length) throw new Error('Edge returned no audio.');
    return { ok: true, voice, mp3 };
  } catch (error) {
    return { ok: false, error: String(error.message || error), voice };
  } finally {
    try { socket?.close(); } catch (_) { /* already closed */ }
  }
}
