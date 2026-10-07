// CHE_VIDEO_GEN_URL is the configured MoneyPrinter API base (including its
// API prefix). A pending task is never presented as a completed video.
export async function moneyPrinterVideo(env, topic, fetcher = fetch) {
  const base = String(env.CHE_VIDEO_GEN_URL || '').replace(/\/$/, '');
  const subject = String(topic || '').trim();
  if (!base) return { ok: false, error: 'MoneyPrinter is not connected. Set CHE_VIDEO_GEN_URL.' };
  if (subject.length < 3 || subject.length > 2000) return { ok: false, error: 'Name the video in 3 to 2000 characters.' };
  const headers = {
    'content-type': 'application/json',
    ...(env.CHE_VIDEO_GEN_TOKEN ? { 'X-API-Key': env.CHE_VIDEO_GEN_TOKEN } : {}),
  };
  try {
    const started = await fetcher(`${base}/videos`, {
      method: 'POST', headers, signal: AbortSignal.timeout(12000),
      body: JSON.stringify({ video_subject: subject, video_aspect: '9:16' }),
    });
    const created = await started.json().catch(() => ({}));
    const taskId = created?.data?.task_id || created?.task_id;
    if (!started.ok || !taskId) return { ok: false, error: 'MoneyPrinter did not start a video.', status: started.status };
    const task = await fetcher(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers, signal: AbortSignal.timeout(12000) });
    if (!task.ok) return { ok: false, task_id: taskId, error: 'The video status could not be retrieved.', status: task.status };
    const data = await task.json().catch(() => ({}));
    if (data?.data?.state === -1) return { ok: false, task_id: taskId, error: 'The video renderer could not finish this video.' };
    const url = String(data?.data?.videos?.[0] || data?.video_url || data?.url || '');
    let valid = false;
    try { const u = new URL(url); valid = ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { /* pending or invalid receipt */ }
    if (!valid) return { ok: true, pending: true, task_id: taskId, error: 'Video started. No file yet.' };
    return { ok: true, task_id: taskId, media_url: url };
  } catch {
    return { ok: false, error: 'The video renderer did not respond. No completed file was received.' };
  }
}
