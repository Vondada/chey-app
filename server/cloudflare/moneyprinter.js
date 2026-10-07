// MoneyPrinterTurbo adapter. CHE_VIDEO_GEN_URL may be the server root or
// an /api/v1 base. Pending work returns a real task id for authenticated polling.

function moneyPrinterApiBase(env = {}) {
  const raw = String(env.CHE_VIDEO_GEN_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /\/api\/v1$/i.test(raw) ? raw : `${raw}/api/v1`;
}

function validMediaUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function moneyPrinterStatus(env, taskId, fetcher = fetch) {
  const base = moneyPrinterApiBase(env);
  const id = String(taskId || '').trim();
  if (!base) return { ok: false, error: 'MoneyPrinter is not connected. Set CHE_VIDEO_GEN_URL.' };
  if (!id || id.length > 200) return { ok: false, error: 'A valid video task id is required.' };
  try {
    const response = await fetcher(`${base}/tasks/${encodeURIComponent(id)}`, {
      headers: env.CHE_VIDEO_GEN_TOKEN ? { 'X-API-Key': env.CHE_VIDEO_GEN_TOKEN } : {},
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, task_id: id, error: 'The video status could not be retrieved.', status: response.status };
    }
    const state = data?.data?.state ?? data?.state;
    if (state === -1 || state === 'failed') {
      return { ok: false, task_id: id, error: 'The video renderer could not finish this video.' };
    }
    const mediaUrl = String(
      data?.data?.videos?.[0] ||
      data?.data?.video_url ||
      data?.video_url ||
      data?.url ||
      '',
    );
    if (validMediaUrl(mediaUrl)) return { ok: true, task_id: id, media_url: mediaUrl };
    return { ok: true, pending: true, task_id: id, error: 'Video is still rendering.' };
  } catch {
    return { ok: false, task_id: id, error: 'The video renderer did not respond. No completed file was received.' };
  }
}

export async function moneyPrinterVideo(env, topic, fetcher = fetch) {
  const base = moneyPrinterApiBase(env);
  const subject = String(topic || '').trim();
  if (!base) return { ok: false, error: 'MoneyPrinter is not connected. Set CHE_VIDEO_GEN_URL.' };
  if (subject.length < 3 || subject.length > 2000) return { ok: false, error: 'Name the video in 3 to 2000 characters.' };
  const headers = {
    'content-type': 'application/json',
    ...(env.CHE_VIDEO_GEN_TOKEN ? { 'X-API-Key': env.CHE_VIDEO_GEN_TOKEN } : {}),
  };
  try {
    const started = await fetcher(`${base}/videos`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({ video_subject: subject, video_aspect: '9:16' }),
    });
    const created = await started.json().catch(() => ({}));
    const taskId = created?.data?.task_id || created?.task_id;
    if (!started.ok || !taskId) {
      return { ok: false, error: 'MoneyPrinter did not start a video.', status: started.status };
    }
    return moneyPrinterStatus(env, taskId, fetcher);
  } catch {
    return { ok: false, error: 'The video renderer did not respond. No completed file was received.' };
  }
}
