// Faceless video job. Builds the script, shot list, and voice track text.
// An mp4 exists only when a configured renderer returns and verifies one. Otherwise the
// job says the file was not made.

import { moneyPrinterVideo, verifyVideoMedia } from './moneyprinter.js';

const clip = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function planFacelessVideo(body = {}) {
  const topic = clip(body.topic || body.prompt, 200);
  if (topic.length < 3) return { ok: false, error: 'Name the topic.' };
  const seconds = Math.max(5, Math.min(720, Number(body.seconds || body.duration_seconds) || (Number(body.minutes) || 8) * 60));
  const minutes = Math.max(1, Math.min(12, Math.ceil(seconds / 60)));
  const beats = Math.max(4, Math.min(10, minutes));
  const shots = [];
  for (let i = 1; i <= beats; i += 1) {
    shots.push({
      n: i,
      say: i === 1 ? `Hook: ${topic}` : `Point ${i - 1} about ${topic}`,
      show: `No face. Image ${i} for ${topic}`,
    });
  }
  return {
    ok: true,
    video: false,
    topic,
    minutes,
    seconds,
    script: shots.map((shot) => shot.say).join(' '),
    shots,
  };
}

export async function renderFacelessVideo(env, plan, fetcher = fetch) {
  const url = String(env.CHE_VIDEO_RENDER_URL || '').trim();
  if (!url) {
    if (!env.CHE_VIDEO_GEN_URL) return {
      ok: false, video: false,
      error: 'No video renderer is connected. Configure a live CHE_VIDEO_GEN_URL or CHE_VIDEO_RENDER_URL. No mp4 was made.',
      plan,
    };
    const result = await moneyPrinterVideo(env, plan.topic, fetcher, { seconds: plan.seconds });
    if (result.pending) return { ok: true, pending: true, video: false, task_id: result.task_id, plan };
    if (!result.ok || !result.verified) return { ok: false, video: false, error: result.error || 'No verified MP4.', plan };
    return { ok: true, video: true, verified: true, media_url: result.media_url, media_type: 'video', duration_verified: false, plan };
  }
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: plan.topic, script: plan.script, shots: plan.shots }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.media_url) {
      return { ok: false, error: 'Renderer did not return a video file.', status: response.status, plan };
    }
    const verified = await verifyVideoMedia(String(data.media_url), fetcher);
    if (!verified.ok) return { ok: false, video: false, error: verified.error, plan };
    return { ok: true, video: true, verified: true, media_url: String(data.media_url), media_type: 'video', duration_verified: false, plan };
  } catch (_) {
    return { ok: false, error: 'Video renderer did not respond.', plan };
  }
}

export async function createFacelessVideo(env, body, fetcher = fetch) {
  const plan = planFacelessVideo(body);
  if (!plan.ok) return plan;
  return renderFacelessVideo(env, plan, fetcher);
}
