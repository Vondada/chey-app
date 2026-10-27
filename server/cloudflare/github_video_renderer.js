// Free original-media renderer via the owner's existing GitHub Actions.
// Artifacts remain accessible only through the paired CHE media endpoint.
// No paid model, external render account, public file host or YouTube upload.
const REPO = 'Vondada/chey-app';
const WORKFLOW = 'che-video-render.yml';
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const TASK = /^gha_[a-f0-9]{32}$/;

export function credentials(env) {
  return String(env.CHE_GITHUB_REPO || '') === REPO && Boolean(env.CHE_GITHUB_TOKEN);
}

// GitHub refuses any API request without a User-Agent (HTTP 403, "Request
// forbidden by administrative rules"), and a Cloudflare Worker's fetch sends
// none. Without this header every dispatch from the Worker failed with 403
// whatever the token's permissions were.
const USER_AGENT = 'CHE-Video-Renderer';

export function githubHeaders(env) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + env.CHE_GITHUB_TOKEN,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
}

// GitHub's own words about a refusal, safe to show and log: its message, the
// request ID GitHub support can look up, and the permissions the call needed.
// Anything shaped like a token is removed; the token itself is never included.
function scrub(text, env) {
  let out = String(text || '');
  const token = String(env?.CHE_GITHUB_TOKEN || '');
  if (token.length >= 8) out = out.split(token).join('[hidden]');
  return out.replace(/\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]{8,}/g, '[hidden]').replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function githubDetail(response, bodyText, env) {
  let body = {};
  try { body = JSON.parse(bodyText || '{}'); } catch (_) { body = { message: bodyText }; }
  const header = (name) => scrub(response?.headers?.get?.(name) || '', env);
  const detail = { http: response?.status || 0 };
  const message = scrub(body?.message || '', env);
  if (message) detail.message = message;
  if (header('x-github-request-id')) detail.request_id = header('x-github-request-id');
  if (header('x-accepted-github-permissions')) detail.accepted_permissions = header('x-accepted-github-permissions');
  if (header('x-github-sso')) detail.sso = header('x-github-sso');
  const docs = String(body?.documentation_url || '');
  if (/^https:\/\/docs\.github\.com\//.test(docs)) detail.documentation_url = docs.slice(0, 200);
  return detail;
}

export async function readJson(response) {
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
export async function refusalOf(response, what, env) {
  const text = await response.clone().text().catch(() => '');
  const github = githubDetail(response, text, env);
  const said = github.message ? ` GitHub said: "${github.message}"${github.request_id ? ` (request ${github.request_id})` : ''}.` : '';
  if (response.status === 403) {
    const headers = response.headers;
    const limited = headers?.get?.('x-ratelimit-remaining') === '0' || Boolean(headers?.get?.('retry-after')) || /rate limit/i.test(text);
    if (limited) return { code: 'rate_limited', retryable: true, github,
      error: `GitHub's rate limit paused ${what} (HTTP 403); it is worth trying again in a few minutes.` };
    if (/user-agent/i.test(github.message || '')) return { code: 'request_rejected', retryable: false, github,
      error: `GitHub rejected CHE's request for ${what} (HTTP 403) because it had no User-Agent header. This is a CHE defect, not your token.${said}` };
    if (github.sso) return { code: 'sso_required', retryable: false, github,
      error: `GitHub refused ${what} (HTTP 403): the token is not authorized for single sign-on.${said} Owner action: authorize the token for SSO in GitHub's token settings.` };
    if (/not accessible by (?:personal access token|integration)/i.test(github.message || '')) {
      const needs = github.accepted_permissions ? ` GitHub says this call needs: ${github.accepted_permissions}.` : '';
      return { code: 'forbidden', retryable: false, github,
        error: `GitHub refused ${what} (HTTP 403): CHE_GITHUB_TOKEN is missing a permission this call needs.${needs}${said} Owner action: add that permission for Vondada/chey-app to the token saved as CHE_GITHUB_TOKEN.` };
    }
    // A 403 GitHub did not explain is reported as itself, not guessed at.
    return { code: 'forbidden', retryable: false, github,
      error: `GitHub refused ${what} (HTTP 403).${said}${github.accepted_permissions ? ` Permissions this call accepts: ${github.accepted_permissions}.` : ''}` };
  }
  const why = refusal(response.status, what);
  return { ...why, github, error: why.error + said };
}

/**
 * Queue one render on the owner's GitHub Actions. workflow_dispatch first;
 * a token without Actions:write falls back to repository_dispatch, which needs
 * only Contents:write. `taskId` lets a caller retry the same job: the run is
 * found by its name, so a retried dispatch is still one video.
 */
export async function startGithubVideo(env, topic, seconds = 15, fetcher = fetch, { taskId: given = '', spec = '' } = {}) {
  if (!credentials(env)) return { ok: false, code: 'not_configured', error: 'The free GitHub video renderer needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO=Vondada/chey-app on the Worker.' };
  const prompt = String(topic || '').trim();
  const duration = Number(seconds);
  if (prompt.length < 3 || prompt.length > 500 || !Number.isInteger(duration) || duration < 5 || duration > 90) {
    return { ok: false, code: 'invalid', error: 'Video topic must be 3-500 characters and duration 5-90 seconds.' };
  }
  // A Creator Studio storyboard (creator_studio.studioRenderSpec) travels as
  // one JSON string input; the renderer checks it again before drawing.
  const storyboard = String(spec || '');
  if (storyboard) {
    let parsed = null;
    try { parsed = JSON.parse(storyboard); } catch (_) { parsed = null; }
    if (storyboard.length > 16000 || parsed?.v !== 1 || Number(parsed.seconds) !== duration) {
      return { ok: false, code: 'invalid', error: 'The storyboard is not one the renderer accepts (version 1, at most 16,000 characters, the same length as the video).' };
    }
  }
  const extra = storyboard ? { spec: storyboard } : {};
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
      { ref: 'main', inputs: { job_id: taskId, topic: prompt, seconds: String(duration), ...extra } });
  } catch {
    // The request may or may not have reached GitHub; the status check finds
    // the run by name if it did, so the same task ID is kept.
    return { ok: false, code: 'unreachable', retryable: true, task_id: taskId,
      error: 'GitHub Actions could not be reached. If the render was queued it will appear under this task; nothing else was started.' };
  }
  if (response.status === 204) return { ok: true, pending: true, task_id: taskId, provider: 'github-actions-offline', dispatch_method: 'workflow_dispatch', stage: 'queued' };
  const first = await refusalOf(response, 'the video workflow', env);
  // A bad token or a busy GitHub fails the fallback too: say so once.
  if (response.status === 401 || first.retryable) return { ok: false, task_id: taskId, ...first };
  // 403 (no Actions:write), 404 or 422: the Contents-write repository event.
  let fallback;
  try {
    fallback = await post('https://api.github.com/repos/' + REPO + '/dispatches',
      { event_type: 'che_video_render', client_payload: { job_id: taskId, topic: prompt, seconds: String(duration), ...extra } });
  } catch {
    return { ok: false, code: 'unreachable', retryable: true, task_id: taskId,
      error: `GitHub refused the video workflow (HTTP ${response.status}), and the repository-dispatch fallback could not be reached.` };
  }
  if (fallback.status === 204) {
    return { ok: true, pending: true, task_id: taskId,
      provider: 'github-actions-offline', dispatch_method: 'repository_dispatch', stage: 'queued' };
  }
  const why = await refusalOf(fallback, 'the repository-dispatch fallback', env);
  if (why.retryable) return { ok: false, task_id: taskId, ...why };
  const sameDefect = why.code === 'request_rejected' && first.code === 'request_rejected';
  return { ok: false, task_id: taskId, code: sameDefect ? 'request_rejected' : why.code, retryable: why.retryable,
    github: { workflow_dispatch: first.github, repository_dispatch: why.github },
    error: `GitHub refused both ways to start the free renderer (workflow HTTP ${response.status}, repository HTTP ${fallback.status}). ${first.error} ${why.error}${sameDefect ? '' : ' Starting a render needs Actions: write (workflow) or Contents: write (repository event) on Vondada/chey-app.'}` };
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
      const why = await refusalOf(list, 'the video job lookup', env);
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
      const why = await refusalOf(artifactsReply, 'the rendered-file listing', env);
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
    // The frame size the MP4 itself declares wins over the manifest's word.
    const frameWidth = mp4.width || Number(manifest.video_width) || 0;
    const frameHeight = mp4.height || Number(manifest.video_height) || 0;
    const problems = [
      !mp4.ok && 'the MP4 is not a playable H.264/AAC file',
      mp4.width && (mp4.width !== Number(manifest.video_width) || mp4.height !== Number(manifest.video_height)) && `the MP4 is ${mp4.width}x${mp4.height}, not the ${manifest.video_width}x${manifest.video_height} its manifest says`,
      manifest.format === '9:16' && frameWidth * 16 !== frameHeight * 9 && 'the MP4 is not vertical 9:16',
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
      video_width: frameWidth, video_height: frameHeight, frame_size_verified: Boolean(mp4.width),
      format: String(manifest.format || ''), episode: String(manifest.episode || '').slice(0, 8),
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
  // The frame size from the first track header that has one (the video
  // track; an audio track's tkhd says 0x0). 16.16 fixed point.
  let width = 0, height = 0;
  if (moov) {
    for (let at = moov.at + moov.header; at + 8 <= moov.at + moov.size && !width;) {
      const size = view.getUint32(at);
      if (size < 8 || at + size > moov.at + moov.size) break;
      if (type(at + 4) === 'trak') {
        const tkhd = find(at + 8, at + size, ['tkhd']);
        if (tkhd) {
          const body = tkhd.at + tkhd.header;
          const offset = bytes[body] === 1 ? 88 : 76;
          if (body + offset + 8 <= tkhd.at + tkhd.size) {
            width = view.getUint32(body + offset) >>> 16;
            height = view.getUint32(body + offset + 4) >>> 16;
          }
        }
      }
      at += size;
    }
  }
  return { ok: seconds > 0 && Boolean(video) && Boolean(audio), seconds: Math.round(seconds * 100) / 100, video, audio, width, height };
}

export async function downloadArchive(env, artifactId, fetcher) {
  let response = await fetcher('https://api.github.com/repos/' + REPO + '/actions/artifacts/' + artifactId + '/zip', {
    headers: githubHeaders(env), signal: AbortSignal.timeout(25000), redirect: 'manual',
  });
  // GitHub answers with a short-lived signed link to its file storage. That
  // link is fetched without the GitHub token: the token must not leave GitHub,
  // and the storage service refuses a request that carries a foreign one.
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') || '' : '';
  if (location) {
    if (!/^https:\/\//.test(location)) throw new Error('Artifact download redirect was not HTTPS.');
    response = await fetcher(location, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error('Artifact storage download HTTP ' + response.status);
  }
  if (!response.ok) {
    const why = await refusalOf(response, 'the rendered-file download', env);
    throw Object.assign(new Error(why.retryable ? why.error : 'Artifact download HTTP ' + response.status), { retryable: why.retryable });
  }
  const size = Number(response.headers.get('content-length') || 0);
  if (size > MAX_ARCHIVE_BYTES) throw new Error('Video artifact exceeds preview limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Video artifact exceeds preview limit.');
  return bytes;
}

export async function zipEntry(bytes, sought) {
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
  if (!['video.mp4','thumbnail.png','edited.png'].includes(filename)) return null;
  const archive = await downloadArchive(env, artifactId, fetcher);
  return zipEntry(archive, filename);
}

/**
 * Read-only check of the free renderer's GitHub access, for the deploy check
 * and the owner: is the token recognized, can it see the repository and the
 * workflow, is the workflow enabled, and what does GitHub itself say. Nothing
 * is dispatched, and no token value or fingerprint is ever returned.
 */
export async function githubVideoDiagnosis(env, fetcher = fetch, { source = '' } = {}) {
  const token = String(env.CHE_GITHUB_TOKEN || '');
  const kind = !token ? 'missing' : token.startsWith('github_pat_') ? 'fine-grained personal access token'
    : token.startsWith('ghp_') ? 'classic personal access token' : token.startsWith('ghs_') ? 'GitHub App installation token'
      : token.startsWith('gho_') ? 'OAuth app token' : 'unrecognized format';
  const report = { repo_setting: scrub(env.CHE_GITHUB_REPO || '', env), token_present: Boolean(token), token_kind: kind,
    token_source: source, user_agent: USER_AGENT, checks: [] };
  if (!credentials(env)) {
    report.verdict = token ? `CHE_GITHUB_REPO is "${report.repo_setting}", not Vondada/chey-app.` : 'CHE_GITHUB_TOKEN is not on the Worker.';
    return report;
  }
  const root = 'https://api.github.com/repos/' + REPO;
  const look = async (name, url) => {
    const check = { name };
    try {
      const reply = await fetcher(url, { headers: githubHeaders(env), signal: AbortSignal.timeout(10000) });
      const text = await reply.text().catch(() => '');
      Object.assign(check, githubDetail(reply, text, env), { ok: reply.ok });
      let data = {};
      try { data = JSON.parse(text); } catch (_) { /* not JSON */ }
      if (reply.ok && name === 'user') check.login = scrub(data.login || '', env);
      if (reply.ok && name === 'repository') Object.assign(check, { visible: data.full_name === REPO, default_branch: scrub(data.default_branch || '', env) });
      if (reply.ok && name === 'workflow') Object.assign(check, { state: scrub(data.state || '', env), path: scrub(data.path || '', env) });
      if (reply.ok && name === 'rate_limit') check.core_remaining = Number(data.resources?.core?.remaining ?? -1);
      const expires = reply.headers?.get?.('github-authentication-token-expiration');
      if (expires) report.token_expires = scrub(expires, env);
      const scopes = reply.headers?.get?.('x-oauth-scopes');
      if (scopes) report.classic_scopes = scrub(scopes, env);
    } catch (_) {
      Object.assign(check, { ok: false, http: 0, message: 'GitHub could not be reached.' });
    }
    report.checks.push(check);
    return check;
  };
  const repo = await look('repository', root);
  await look('user', 'https://api.github.com/user');
  const workflow = await look('workflow', root + '/actions/workflows/' + WORKFLOW);
  await look('rate_limit', 'https://api.github.com/rate_limit');
  report.verdict = repo.http === 401 ? 'GitHub does not recognize CHE_GITHUB_TOKEN (HTTP 401): it is invalid, expired or revoked.'
    : /user-agent/i.test(repo.message || '') ? 'GitHub rejected the request itself (no User-Agent); this is a CHE defect.'
      : repo.http === 404 ? 'The token cannot see Vondada/chey-app: the repository is not selected for this token, or it belongs to another account.'
        : !repo.ok ? `GitHub refused the repository lookup (HTTP ${repo.http}).`
          : workflow.http === 404 ? 'The token sees the repository but not che-video-render.yml (missing on main, or no Actions: read).'
            : !workflow.ok ? `GitHub refused the workflow lookup (HTTP ${workflow.http}).`
              : workflow.state && workflow.state !== 'active' ? `The video workflow is ${workflow.state} on GitHub. Owner action: enable it under Actions.`
                : 'The token is recognized and can read the repository and the video workflow. Only a dispatch proves Actions: write.';
  return report;
}
