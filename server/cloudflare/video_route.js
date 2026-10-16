// Authenticated video endpoint.
// POST {topic} starts a direct MoneyPrinter render.
// GET ?task_id=... polls it.
// POST {office:true} runs the connected Office scout/render/upload line.

import { moneyPrinterStatus, moneyPrinterVideo } from './moneyprinter.js';
import { runVideoLine } from './video_line.js';
import { probeVideoEngine } from './video_engine.js';
import { githubVideoConfigured, startGithubVideo, githubVideoStatus } from './github_video_renderer.js';
import { generateVideo } from './media.js';
import { recordReceipt } from './truth_layer.js';

// The words of a video request that say how to make it, not what it is about.
const VIDEO_SPEC = /\b(?:please|can you|could you|would you|i want|i'd like|i would like|for me|me|now|create|make|generate|render|produce|build|do|give me|use|using|try|run|start|with|plus|and|an?|the|free|github|actions?|renderer|rendering|engine|offline|faceless|youtube|yt|shorts?|reels?|tiktok|vertical|hd|real|actual|playable|mp4|videos?|clips?|narration|narrated|narrator|voice ?over|voice|thumbnails?|titles?|descriptions?|tags|captions?|\d+(?:\.\d+)?[- ]?(?:seconds?|secs?|s|minutes?|mins?)(?:[- ]long)?|long|one|new|another|quick|simple|instead|again|it|that|this)\b/gi;

/**
 * What a spoken video request is about: "a 15-second space-facts video" is
 * "space facts", "a YouTube Short about black holes" is "black holes". A
 * request that only says how to make it ("with narration and a thumbnail",
 * "use the free GitHub renderer") has no subject and returns ''.
 */
export function videoRequestTopic(message) {
  const text = String(message || '').replace(/^\W*(?:hey[, ]*)?(?:che|chay|chey|shay)\b[,!:]?\s*/i, '').trim();
  const about = /(?:\b(?:about|covering|explaining|featuring|regarding|on the topic of)|\b(?:videos?|shorts?|clips?|reels?|mp4)\s+(?:on|of))\s+(.{3,}?)\s*(?:[.!?]+\s*$|$|,?\s+(?:with|and (?:add|include|give)|using|for youtube)\b)/i.exec(text);
  const candidate = about ? about[1]
    : text.replace(VIDEO_SPEC, ' ').replace(/[^A-Za-z0-9'’ -]+/g, ' ').replace(/(?:^|\s)-+|-+(?=\s|$)/g, ' ');
  const topic = candidate.replace(/-/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:a|an|the|my|some)\s+/i, '');
  return /[A-Za-z]{3,}/.test(topic) ? topic.slice(0, 200) : '';
}

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
      if (finished.pending) result = { ok: true, pending: true, task_id: taskId, stage: finished.stage || 'queued', run_id: finished.run_id || null };
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
      } else result = { ok: false, task_id: taskId, stage: finished.stage || 'failed', code: finished.code || 'failed', error: finished.detail || 'No verified video file was returned.' };
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
  if (result?.provider === 'github-actions-offline' && result.task_id) {
    // CHE's own render is recorded so her verified state can say it exists.
    await recordReceipt(storage, { kind: 'video_render', key: `video_render:${result.task_id}`, task_id: result.task_id, topic: String(body.topic || body.prompt || '').slice(0, 120), status: 'queued' }).catch(() => null);
  }
  return new Response(JSON.stringify(result), {
    status: statusFor(result),
    headers: { 'content-type': 'application/json' },
  });
}
