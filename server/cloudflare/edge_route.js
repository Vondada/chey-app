// POST /api/voice/edge -> mp3. No audio means 204, and the phone uses Kokoro.

import { edgeSpeak } from './edge_voice.js';

export async function handleEdgeVoice(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const spoken = await edgeSpeak(env, body.text || '');
  if (!spoken.ok || !spoken.mp3 || !spoken.mp3.length) return new Response(null, { status: 204 });
  return new Response(spoken.mp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
}
