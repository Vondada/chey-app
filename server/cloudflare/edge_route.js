// POST /api/voice/edge -> mp3, or 204 so the phone falls back to Kokoro.

import { edgeSpeak } from './edge_voice.js';

export async function handleEdgeVoice(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const spoken = await edgeSpeak(env, body.text || '');
  if (!spoken.ok || !spoken.mp3) {
    return new Response(JSON.stringify({ ok: false, error: spoken.error || 'No audio' }), {
      status: 204,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(spoken.mp3, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
}
