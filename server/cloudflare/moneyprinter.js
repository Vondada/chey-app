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
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password &&
      !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host) &&
      !host.endsWith('.local') && !/^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
  } catch {
    return false;
  }
}

// A renderer JSON response is not a finished file. Prove that the actual URL
// serves MP4 bytes before surfacing it to the owner. Read only the first chunk.
export async function verifyVideoMedia(raw, fetcher = fetch) {
  if (!validMediaUrl(raw)) return { ok: false, error: 'Renderer returned an unsafe or invalid video address.' };
  try {
    const response = await fetcher(raw, {
      headers: { Range: 'bytes=0-63', Accept: 'video/mp4' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok || !response.body) return { ok: false, error: 'Video file is not accessible.' };
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => {});
    const bytes = first.value || new Uint8Array();
    const mp4 = bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 &&
      bytes[6] === 0x79 && bytes[7] === 0x70;
    if (!mp4) return { ok: false, error: 'Renderer did not return a real MP4 file.' };
    return { ok: true, verified: true, content_type: 'video/mp4' };
  } catch {
    return { ok: false, error: 'Could not verify the rendered MP4 file.' };
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
    if (mediaUrl) {
      const verified = await verifyVideoMedia(mediaUrl, fetcher);
      if (!verified.ok) return { ok: false, task_id: id, stage: 'verify', error: verified.error };
      return { ok: true, task_id: id, media_url: mediaUrl, verified: true, duration_verified: false };
    }
    return { ok: true, pending: true, task_id: id, error: 'Video is still rendering.' };
  } catch {
    return { ok: false, task_id: id, error: 'The video renderer did not respond. No completed file was received.' };
  }
}

export async function moneyPrinterVideo(env, topic, fetcher = fetch, options = {}) {
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
      body: JSON.stringify({
        video_subject: subject,
        video_aspect: '9:16',
        ...(options.script ? { video_script: String(options.script).slice(0, 8000) } : {}),
        ...(options.seconds ? { video_clip_duration: 5, paragraph_number: 3 } : {}),
      }),
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
