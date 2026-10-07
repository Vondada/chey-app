// POST /api/video/line {"topic":"pirates"}
// Calls MoneyPrinter. A file exists only when that server returns one.

import { moneyPrinterVideo } from './moneyprinter.js';

export async function handleVideoLine(request, env, parsedBody) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = parsedBody ?? await request.json().catch(() => ({}));
  const result = await moneyPrinterVideo(env, body.topic || body.prompt || '');
  return new Response(JSON.stringify(result), {
    status: result.media_url ? 200 : 424,
    headers: { 'content-type': 'application/json' },
  });
}
