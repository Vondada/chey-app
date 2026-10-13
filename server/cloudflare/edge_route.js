// POST /api/voice/edge -> mp3. No audio means 204, and the phone uses Kokoro.

import { edgeSpeak } from './edge_voice.js';
import { preferredElevenLabsKeyStatus } from './preferred_elevenlabs_voice.js';

export async function handleEdgeVoice(request, env, parsedBody) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = parsedBody ?? await request.json().catch(() => ({}));
  // Mary's status in the Keys tab's words, so the phone can say why Mary did not
  // speak. Only the status word is sent, never the key or a provider's error text.
  const mary = preferredElevenLabsKeyStatus(env).status;
  const spoken = await edgeSpeak(env, body.text || '');
  if (!spoken.ok || !spoken.mp3 || !spoken.mp3.length) return new Response(null, { status: 204, headers: { 'X-CHE-Mary': mary } });
  return new Response(spoken.mp3, { status: 200, headers: { 'content-type': 'audio/mpeg', 'X-CHE-Voice': 'edge-ava', 'X-CHE-Mary': mary, 'Cache-Control': 'no-store' } });
}
