// Free original-media renderer via the owner's existing GitHub Actions.
// Artifacts remain accessible only through the paired CHE media endpoint.
// No paid model, external render account, public file host or YouTube upload.
const REPO = 'Vondada/chey-app';
const WORKFLOW = 'che-video-render.yml';
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const TASK = /^gha_[a-f0-9]{32}$/;

function credentials(env) {
  return String(env.CHE_GITHUB_REPO || '') === REPO && Boolean(env.CHE_GITHUB_TOKEN);
}

function githubHeaders(env) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + env.CHE_GITHUB_TOKEN,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export function githubVideoConfigured(env) {
  return credentials(env);
}

// What a GitHub refusal means, in words the owner can act on. 401 is a bad
// token; 403 is a token without the needed permission; 404 means the token
// cannot see the repository or the workflow file is missing on main; 422 is
// an input or trigger the workflow does not accept; 429 and 5xx are GitHub
// being busy or down, which is worth retrying later.
function refusal(status, what) {
  if (status === 401) return { code: 'unauthorized', retryable: false,
    error: `GitHub rejected CHE_GITHUB_TOKEN for ${what} (HTTP 401): the token is invalid, expired or revoked. Owner action: create a new token for Vondada/chey-app and save it as the CHE_GITHUB_TOKEN repository secret.` };
  if (status === 403) return { code: 'forbidden', retryable: false,
    error: `GitHub refused ${what} (HTTP 403): CHE_GITHUB_TOKEN lacks the permission. Owner action: give the token Actions: read and write, or Contents: read and write, on Vondada/chey-app.` };
  if (status === 404) return { code: 'not_found', retryable: false,
    error: `GitHub could not find ${what} (HTTP 404): the token cannot see Vondada/chey-app, or che-video-render.yml is missing on main.` };
  if (status === 422) return { code: 'invalid', retryable: false,
    error: `GitHub refused the inputs for ${what} (HTTP 422).` };
  if (status === 429 || status >= 500) return { code: 'unavailable', retryable: true,
    error: `GitHub was busy or down for ${what} (HTTP ${status}). Nothing was queued; try again shortly.` };
  return { code: 'rejected', retryable: false, error: `GitHub rejected ${what} (HTTP ${status}).` };
}

// GitHub answers a rate limit with 403 as well as 429: no requests left in the
// hour, a Retry-After, or a "secondary rate limit" message. That is a pause,
// not a token without permission.
async function refusalOf(response, what) {
  if (response.status === 403) {
    const headers = response.headers;
    let limited = headers?.get?.('x-ratelimit-remaining') === '0' || Boolean(headers?.get?.('retry-after'));
    if (!limited) limited = /rate limit/i.test(await response.clone().text().catch(() => ''));
    if (limited) return { code: 'rate_limited', retryable: true,
      error: `GitHub's rate limit paused ${what} (HTTP 403); it is worth trying again in a few minutes.` };
  }
  return refusal(response.status, what);
}

/**
 * Queue one render on the owner's GitHub Actions. workflow_dispatch first;
 * a token without Actions:write falls back to repository_dispatch, which needs
 * only Contents:write. `taskId` lets a caller retry the same job: the run is
 * found by its name, so a retried dispatch is still one video.
 */
export async function startGithubVideo(env, topic, seconds = 15, fetcher = fetch, { taskId: given = '' } = {}) {
  if (!credentials(env)) return { ok: false, code: 'not_configured', error: 'The free GitHub video renderer needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO=Vondada/chey-app on the Worker.' };
  const prompt = String(topic || '').trim();
  const duration = Number(seconds);
  if (prompt.length < 3 || prompt.length > 500 || !Number.isInteger(duration) || duration < 5 || duration > 90) {
    return { ok: false, code: 'invalid', error: 'Video topic must be 3-500 characters and duration 5-90 seconds.' };
  }
  const taskId = TASK.test(given) ? given : 'gha_' + crypto.randomUUID().replaceAll('-', '');
  const post = (url, body) => fetcher(url, {
    method: 'POST',
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(14000),
  });
  let response;
  try {
    response = await post('https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches',
      { ref: 'main', inputs: { job_id: taskId, topic: prompt, seconds: String(duration) } });
  } catch {
    // The request may or may not have reached GitHub; the status check finds
    // the run by name if it did, so the same task ID is kept.
    return { ok: false, code: 'unreachable', retryable: true, task_id: taskId,
      error: 'GitHub Actions could not be reached. If the render was queued it will appear under this task; nothing else was started.' };
  }
  if (response.status === 204) return { ok: true, pending: true, task_id: taskId, provider: 'github-actions-offline', dispatch_method: 'workflow_dispatch', stage: 'queued' };
  const first = await refusalOf(response, 'the video workflow');
  // A bad token or a busy GitHub fails the fallback too: say so once.
  if (response.status === 401 || first.retryable) return { ok: false, task_id: taskId, ...first };
  // 403 (no Actions:write), 404 or 422: the Contents-write repository event.
  let fallback;
  try {
    fallback = await post('https://api.github.com/repos/' + REPO + '/dispatches',
      { event_type: 'che_video_render', client_payload: { job_id: taskId, topic: prompt, seconds: String(duration) } });
  } catch {
    return { ok: false, code: 'unreachable', retryable: true, task_id: taskId,
      error: `GitHub refused the video workflow (HTTP ${response.status}), and the repository-dispatch fallback could not be reached.` };
  }
  if (fallback.status === 204) {
    return { ok: true, pending: true, task_id: taskId,
      provider: 'github-actions-offline', dispatch_method: 'repository_dispatch', stage: 'queued' };
  }
  const why = await refusalOf(fallback, 'the repository-dispatch fallback');
  if (why.retryable) return { ok: false, task_id: taskId, ...why };
  return { ok: false, task_id: taskId, code: why.code, retryable: why.retryable,
    error: `GitHub refused both ways to start the free renderer (workflow HTTP ${response.status}, repository HTTP ${fallback.status}). ${first.error} The CHE_GITHUB_TOKEN requires Actions:write or Contents:write for Vondada/chey-app.` };
}

// Minutes after dispatch with no run before CHE says GitHub never started it.
const NEVER_STARTED_MS = 15 * 60_000;

export async function githubVideoStatus(env, taskId, fetcher = fetch, { dispatchedAt = 0, now = Date.now() } = {}) {
  if (!credentials(env)) return { ok: false, code: 'not_configured', error: 'GitHub video renderer is not connected.' };
  if (!TASK.test(String(taskId || ''))) return { ok: false, code: 'invalid', error: 'Invalid GitHub video task ID.' };
  try {
    const root = 'https://api.github.com/repos/' + REPO;
    const list = await fetcher(root + '/actions/workflows/' + WORKFLOW + '/runs?per_page=100', {
      headers: githubHeaders(env), signal: AbortSignal.timeout(15000),
    });
    if (!list.ok) {
      const why = await refusalOf(list, 'the video job lookup');
      // Busy GitHub is a pause, not a failed video.
      if (why.retryable) return { ok: true, pending: true, task_id: taskId, stage: 'checking', detail: why.error };
      return { ok: false, task_id: taskId, code: why.code, error: why.error };
    }
    const data = await readJson(list);
    const job = (data.workflow_runs || []).find(r => r.display_title === 'CHE free render ' + taskId);
    if (!job) {
      if (dispatchedAt && now - dispatchedAt > NEVER_STARTED_MS) {
        return { ok: false, task_id: taskId, code: 'never_started', stage: 'failed',
          error: 'GitHub never started this render: no run appeared 15 minutes after it was queued. Nothing was produced.' };
      }
      return { ok: true, pending: true, task_id: taskId, stage: 'queued', detail: 'Waiting for a GitHub runner to start.' };
    }
    if (job.status !== 'completed') {
      return { ok: true, pending: true, task_id: taskId, run_id: job.id, stage: job.status === 'in_progress' ? 'running' : 'queued' };
    }
    if (job.conclusion !== 'success') {
      const stage = job.conclusion === 'cancelled' ? 'canceled' : job.conclusion === 'timed_out' ? 'timed_out' : 'failed';
      const step = stage === 'failed' ? await failedStep(env, root, job.id, fetcher) : '';
      const reason = stage === 'canceled' ? 'The render was canceled on GitHub'
        : stage === 'timed_out' ? 'The render ran past its 15-minute limit on GitHub'
          : `The render failed on GitHub${step ? ` at step "${step}"` : ''}`;
      return { ok: false, task_id: taskId, run_id: job.id, stage, code: stage,
        error: `${reason} (Actions run ${job.id}). No video was produced.` };
    }
    const artifactsReply = await fetcher(root + '/actions/runs/' + job.id + '/artifacts?per_page=100', {
      headers: githubHeaders(env), signal: AbortSignal.timeout(15000),
    });
    if (!artifactsReply.ok) {
      const why = await refusalOf(artifactsReply, 'the rendered-file listing');
      if (why.retryable) return { ok: true, pending: true, task_id: taskId, run_id: job.id, stage: 'checking', detail: why.error };
      return { ok: false, task_id: taskId, run_id: job.id, code: 'artifact', error: `The rendered files could not be listed (HTTP ${artifactsReply.status}).` };
    }
    const artifacts = await readJson(artifactsReply);
    const named = (artifacts.artifacts || []).filter(a => a.name === 'che-video-' + taskId);
    const artifact = named.find(a => !a.expired);
    if (!artifact) {
      return { ok: false, task_id: taskId, run_id: job.id, code: named.length ? 'expired' : 'artifact',
        error: named.length ? 'The rendered files expired on GitHub (kept 30 days). Ask me for a new render.'
          : 'The render finished without a downloadable artifact.' };
    }
    // Validate actual archive contents, not merely an Action run's success flag.
    const archive = await downloadArchive(env, artifact.id, fetcher);
    const [video, image, manifestBytes] = await Promise.all([
      zipEntry(archive, 'video.mp4'), zipEntry(archive, 'thumbnail.png'), zipEntry(archive, 'manifest.json'),
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const mp4 = mp4Facts(video);
    const png = image.length >= 24 && image[0] === 137 && image[1] === 80 && image[2] === 78 && image[3] === 71;
    const pngView = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const width = png ? pngView.getUint32(16) : 0, height = png ? pngView.getUint32(20) : 0;
    const duration = Number(manifest.duration_seconds);
    const problems = [
      !mp4.ok && 'the MP4 is not a playable H.264/AAC file',
      mp4.ok && Math.abs(mp4.seconds - duration) > 0.5 && `the MP4 lasts ${mp4.seconds.toFixed(1)} s, not the ${duration} s its manifest says`,
      (!png || width !== 1280 || height !== 720) && 'the thumbnail is not a 1280x720 PNG',
      manifest.status !== 'verified' && 'the renderer did not mark it verified',
      !(duration >= 4.7 && duration <= 90.3) && 'its duration is out of range',
      manifest.youtube_uploaded !== false && 'its manifest does not confirm nothing was uploaded',
      !String(manifest.title || '').trim() && 'it has no title',
    ].filter(Boolean);
    if (problems.length) {
      return { ok: false, task_id: taskId, run_id: job.id, code: 'invalid_media',
        error: `The rendered files failed CHE's own checks: ${problems.join('; ')}.` };
    }
    return { ok: true, pending: false, task_id: taskId, verified: true,
      provider: 'github-actions-offline', artifact_id: artifact.id, run_id: job.id,
      duration_seconds: mp4.seconds, duration_verified: true, video_bytes: video.length,
      video_codec: mp4.video, audio_codec: mp4.audio,
      video_width: manifest.video_width, video_height: manifest.video_height,
      thumbnail_width: width, thumbnail_height: height,
      title: String(manifest.title || '').slice(0,100),
      description: String(manifest.description || '').slice(0,700),
      voice_provider: String(manifest.voice_provider || ''),
      retention_days: 30, paid_media: manifest.paid_media === true, youtube_uploaded: false };
  } catch (error) {
    if (error?.retryable) return { ok: true, pending: true, task_id: taskId, stage: 'checking', detail: error.message };
    return { ok: false, task_id: taskId, code: 'unverified',
      error: 'Could not verify GitHub video files: ' + String(error?.message || 'unavailable').slice(0,140) };
  }
}

// The name of the step that failed, so "failed" says where.
async function failedStep(env, root, runId, fetcher) {
  try {
    const reply = await fetcher(root + '/actions/runs/' + runId + '/jobs', { headers: githubHeaders(env), signal: AbortSignal.timeout(10000) });
    if (!reply.ok) return '';
    const jobs = (await readJson(reply)).jobs || [];
    for (const job of jobs) for (const step of job.steps || []) if (step.conclusion === 'failure') return String(step.name || '').slice(0, 80);
  } catch (_) { /* the run ID is still named */ }
  return '';
}

/**
 * What the MP4 itself says, read from its boxes: its length from the movie
 * header (mvhd) and its codecs from the sample descriptions. A file that is
 * only an ftyp header, or has no H.264 video or AAC audio, is not playable.
 */
export function mp4Facts(bytes) {
  const none = { ok: false, seconds: 0, video: '', audio: '' };
  if (!(bytes instanceof Uint8Array) || bytes.length < 32) return none;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (type(4) !== 'ftyp') return none;
  let seconds = 0;
  const find = (from, to, path) => {
    for (let at = from; at + 8 <= to;) {
      let size = view.getUint32(at);
      const name = type(at + 4);
      let header = 8;
      if (size === 1 && at + 16 <= to) { size = Number(view.getBigUint64(at + 8)); header = 16; }
      if (size === 0) size = to - at;
      if (size < header || at + size > to) return;
      if (name === path[0]) {
        if (path.length === 1) return { at, header, size };
        const found = find(at + header, at + size, path.slice(1));
        if (found) return found;
      }
      at += size;
    }
  };
  const mvhd = find(0, bytes.length, ['moov', 'mvhd']);
  if (mvhd) {
    const body = mvhd.at + mvhd.header;
    const version = bytes[body];
    const scale = version === 1 ? view.getUint32(body + 20) : view.getUint32(body + 12);
    const length = version === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
    if (scale > 0) seconds = length / scale;
  }
  // Sample entries sit deep in moov/trak/mdia/minf/stbl/stsd; their four-letter
  // names are enough to tell the codecs apart.
  const moov = find(0, bytes.length, ['moov']);
  const inMoov = moov ? new TextDecoder('latin1').decode(bytes.subarray(moov.at, moov.at + moov.size)) : '';
  const video = /avc1|avc3/.test(inMoov) ? 'h264' : /hvc1|hev1/.test(inMoov) ? 'hevc' : '';
  const audio = /mp4a/.test(inMoov) ? 'aac' : '';
  return { ok: seconds > 0 && Boolean(video) && Boolean(audio), seconds: Math.round(seconds * 100) / 100, video, audio };
}

async function downloadArchive(env, artifactId, fetcher) {
  const response = await fetcher('https://api.github.com/repos/' + REPO + '/actions/artifacts/' + artifactId + '/zip', {
    headers: githubHeaders(env), signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    const why = await refusalOf(response, 'the rendered-file download');
    throw Object.assign(new Error(why.retryable ? why.error : 'Artifact download HTTP ' + response.status), { retryable: why.retryable });
  }
  const size = Number(response.headers.get('content-length') || 0);
  if (size > MAX_ARCHIVE_BYTES) throw new Error('Video artifact exceeds preview limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Video artifact exceeds preview limit.');
  return bytes;
}

async function zipEntry(bytes, sought) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0,bytes.length - 65557); p--) {
    if (view.getUint32(p,true) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error('Video archive ZIP directory is missing.');
  let position = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  for (let i=0;i<count;i++) {
    if (position + 46 > bytes.length || view.getUint32(position,true)!==0x02014b50) throw new Error('Invalid ZIP entry.');
    const method=view.getUint16(position + 10,true);
    const compressed=view.getUint32(position + 20,true);
    const uncompressed=view.getUint32(position + 24,true);
    const nameLen=view.getUint16(position + 28,true), extraLen=view.getUint16(position + 30,true);
    const commentLen=view.getUint16(position + 32,true);
    const local=view.getUint32(position + 42,true);
    const name=new TextDecoder().decode(bytes.slice(position + 46, position + 46 + nameLen));
    position += 46 + nameLen + extraLen + commentLen;
    if (name !== sought && !name.endsWith('/' + sought)) continue;
    if (uncompressed > MAX_ARCHIVE_BYTES || local + 30 > bytes.length || view.getUint32(local,true)!==0x04034b50) throw new Error('Invalid ZIP media size.');
    const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    if (start+compressed>bytes.length) throw new Error('Truncated ZIP media.');
    const data=bytes.slice(start,start+compressed);
    if (method===0) return data;
    if (method===8) {
      const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const unzipped=new Uint8Array(await new Response(stream).arrayBuffer());
      if (unzipped.length!==uncompressed || unzipped.length>MAX_ARCHIVE_BYTES) throw new Error('Corrupt media compression.');
      return unzipped;
    }
    throw new Error('Unsupported ZIP compression.');
  }
  throw new Error('Video archive lacks ' + sought);
}

export async function githubVideoFile(env, artifactId, filename, fetcher = fetch) {
  if (!credentials(env)) return null;
  if (!Number.isSafeInteger(Number(artifactId)) || Number(artifactId) <= 0) return null;
  if (!['video.mp4','thumbnail.png'].includes(filename)) return null;
  const archive = await downloadArchive(env, artifactId, fetcher);
  return zipEntry(archive, filename);
}
