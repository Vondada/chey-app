// Authenticated video endpoint.
// POST {topic} starts a direct MoneyPrinter render.
// GET ?task_id=... polls it.
// POST {office:true} runs the connected Office scout/render/upload line.

import { moneyPrinterStatus, moneyPrinterVideo } from './moneyprinter.js';
import { runVideoLine } from './video_line.js';

function statusFor(result) {
  if (result?.pending) return 202;
  if (result?.ok) return 200;
  return 424;
}

export async function handleVideoLine(request, env, parsedBody, youtube = {}) {
  if (!['GET', 'POST'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405 });
  }
  let result;
  if (request.method === 'GET') {
    const taskId = new URL(request.url).searchParams.get('task_id') || '';
    result = await moneyPrinterStatus(env, taskId);
  } else {
    const body = parsedBody ?? await request.json().catch(() => ({}));
    if (body.office === true && body.approve_upload !== true) {
      return new Response(JSON.stringify({
        ok: false, stage: 'approval', requires_owner_confirmation: true,
        error: 'A YouTube upload requires separate explicit owner approval. No rendering or upload was started.',
      }), { status: 428, headers: { 'content-type': 'application/json' } });
    }
    result = body.office === true
      ? await runVideoLine(env, fetch, youtube)
      : await moneyPrinterVideo(env, body.topic || body.prompt || '');
  }
  return new Response(JSON.stringify(result), {
    status: statusFor(result),
    headers: { 'content-type': 'application/json' },
  });
}
