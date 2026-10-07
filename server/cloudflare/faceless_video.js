// Faceless video job. Builds the script, shot list, and voice track text.
// An mp4 exists only when CHE_VIDEO_RENDER_URL returns one. Otherwise the
// job says the file was not made.

const clip = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function planFacelessVideo(body = {}) {
  const topic = clip(body.topic || body.prompt, 200);
  if (topic.length < 3) return { ok: false, error: 'Name the topic.' };
  const minutes = Math.max(1, Math.min(12, Number(body.minutes) || 8));
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
    script: shots.map((shot) => shot.say).join(' '),
    shots,
  };
}

export async function renderFacelessVideo(env, plan, fetcher = fetch) {
  const url = String(env.CHE_VIDEO_RENDER_URL || '').trim();
  if (!url) {
    return { ok: false, error: 'No video renderer is connected. Script and shots are ready. No mp4 was made.', plan };
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
    return { ok: true, video: true, media_url: String(data.media_url), media_type: 'video', plan };
  } catch (_) {
    return { ok: false, error: 'Video renderer did not respond.', plan };
  }
}

export async function createFacelessVideo(env, body, fetcher = fetch) {
  const plan = planFacelessVideo(body);
  if (!plan.ok) return plan;
  return renderFacelessVideo(env, plan, fetcher);
}
