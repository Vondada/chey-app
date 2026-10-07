// CHE client for a running MoneyPrinterTurbo server.
// The phone does not run the app. CHE_VIDEO_GEN_URL is that server.
// API shape: POST /videos, then poll /tasks/{id} until a video url exists.

export async function moneyPrinterVideo(env, topic, fetcher = fetch) {
  const base = String(env.CHE_VIDEO_GEN_URL || '').replace(/\/$/, '');
  const subject = String(topic || '').trim();
  if (!base) return { ok: false, error: 'MoneyPrinter is not connected. Set CHE_VIDEO_GEN_URL.' };
  if (subject.length < 3) return { ok: false, error: 'Name the video.' };
  const headers = {
    'content-type': 'application/json',
    ...(env.CHE_VIDEO_GEN_TOKEN ? { 'X-API-Key': env.CHE_VIDEO_GEN_TOKEN } : {}),
  };
  const started = await fetcher(`${base}/videos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ video_subject: subject, video_aspect: '9:16' }),
  });
  const created = await started.json().catch(() => ({}));
  const taskId = created?.data?.task_id || created?.task_id;
  if (!started.ok || !taskId) return { ok: false, error: 'MoneyPrinter did not start a video.', status: started.status };
  const task = await fetcher(`${base}/tasks/${taskId}`, { headers });
  const data = await task.json().catch(() => ({}));
  const url = String(data?.data?.videos?.[0] || data?.video_url || data?.url || '');
  if (!url.startsWith('http')) return { ok: true, pending: true, task_id: taskId, error: 'Video started. No file yet.' };
  return { ok: true, task_id: taskId, media_url: url };
}
