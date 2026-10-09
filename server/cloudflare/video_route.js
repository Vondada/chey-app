// Authenticated video endpoint.
// POST {topic} starts a direct MoneyPrinter render.
// GET ?task_id=... polls it.
// POST {office:true} runs the connected Office scout/render/upload line.

import { moneyPrinterStatus, moneyPrinterVideo } from './moneyprinter.js';
import { runVideoLine } from './video_line.js';
import { probeVideoEngine } from './video_engine.js';
import { githubVideoConfigured, startGithubVideo, githubVideoStatus } from './github_video_renderer.js';
import { generateVideo } from './media.js';

function statusFor(result) {
  if (result?.pending) return 202;
  if (result?.ok) return 200;
  return 424;
}

export async function handleVideoLine(request, env, parsedBody, youtube = {}, storage = null, fetcher = fetch) {
  if (!['GET', 'POST'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405 });
  }
  let result;
  if (request.method === 'GET') {
    if (new URL(request.url).searchParams.get('engine') === 'status') {
      const status = await probeVideoEngine(env, fetcher);
      return new Response(JSON.stringify(status), {
        status: status.ready ? 200 : 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    const taskId = new URL(request.url).searchParams.get('task_id') || '';
    if (taskId.startsWith('gha_') && storage) {
      const finished = await generateVideo(env, storage, {
        task_id: taskId, prompt: 'Verified video render',
      }, fetcher);
      if (finished.pending) result = { ok: true, pending: true, task_id: taskId, stage: 'rendering' };
      else if (finished.item?.verified) {
        const origin = new URL(request.url).origin;
        result = {
          ok: true, verified: true, task_id: taskId, media_id: finished.item.id,
          media_url: origin + '/api/media/' + finished.item.id + '/video',
          thumbnail_media_id: finished.item.thumbnail_media_id || null,
          thumbnail_url: finished.item.thumbnail_media_id
            ? origin + '/api/media/' + finished.item.thumbnail_media_id + '/image' : null,
          duration_seconds: finished.item.duration_seconds || null,
          duration_verified: finished.item.duration_verified === true,
          status: 'complete',
        };
      } else result = { ok: false, task_id: taskId, error: finished.detail || 'No verified video file was returned.' };
    } else result = taskId.startsWith('gha_')
      ? await githubVideoStatus(env, taskId, fetcher)
      : await moneyPrinterStatus(env, taskId, fetcher);
  } else {
    const body = parsedBody ?? await request.json().catch(() => ({}));
    if (body.office === true && body.approve_upload !== true) {
      return new Response(JSON.stringify({
        ok: false, stage: 'approval', requires_owner_confirmation: true,
        error: 'A YouTube upload requires separate explicit owner approval. No rendering or upload was started.',
      }), { status: 428, headers: { 'content-type': 'application/json' } });
    }
    result = body.office === true
      ? await runVideoLine(env, fetcher, youtube)
      : env.CHE_VIDEO_GEN_URL
        ? await moneyPrinterVideo(env, body.topic || body.prompt || '', fetcher)
        : githubVideoConfigured(env)
          ? await startGithubVideo(env, body.topic || body.prompt || '', Number(body.seconds) || 15, fetcher)
          : { ok: false, error: 'MoneyPrinter is not connected. Set CHE_VIDEO_GEN_URL or enable the free GitHub Actions renderer.' };
  }
  return new Response(JSON.stringify(result), {
    status: statusFor(result),
    headers: { 'content-type': 'application/json' },
  });
}
