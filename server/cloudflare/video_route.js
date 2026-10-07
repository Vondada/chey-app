// POST /api/video/line
// Scout, package, render, upload. The board link exists only when YouTube returns an id.

import { runVideoLine } from './video_line.js';

export async function handleVideoLine(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const result = await runVideoLine(env);
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 424,
    headers: { 'content-type': 'application/json' },
  });
}
