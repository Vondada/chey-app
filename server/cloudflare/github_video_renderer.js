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

export async function startGithubVideo(env, topic, seconds = 15, fetcher = fetch) {
  if (!credentials(env)) return { ok: false, error: 'GitHub video renderer needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO.' };
  const prompt = String(topic || '').trim();
  const duration = Number(seconds);
  if (prompt.length < 3 || prompt.length > 500 || !Number.isInteger(duration) || duration < 5 || duration > 90) {
    return { ok: false, error: 'Video topic must be 3-500 characters and duration 5-90 seconds.' };
  }
  const taskId = 'gha_' + crypto.randomUUID().replaceAll('-', '');
  let response;
  try {
    response = await fetcher('https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches', {
      method: 'POST',
      headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { job_id: taskId, topic: prompt, seconds: String(duration) } }),
      signal: AbortSignal.timeout(14000),
    });
  } catch {
    return { ok: false, error: 'GitHub Actions could not be reached. No render was queued.' };
  }
  if (response.status !== 204) {
    return { ok: false, error: 'GitHub video runner rejected the dispatch (HTTP ' + response.status + '). Confirm Actions permission and the installed workflow.' };
  }
  return { ok: true, pending: true, task_id: taskId, provider: 'github-actions-offline', stage: 'queued' };
}

export async function githubVideoStatus(env, taskId, fetcher = fetch) {
  if (!credentials(env)) return { ok: false, error: 'GitHub video renderer is not connected.' };
  if (!TASK.test(String(taskId || ''))) return { ok: false, error: 'Invalid GitHub video task ID.' };
  try {
    const root = 'https://api.github.com/repos/' + REPO;
    const list = await fetcher(root + '/actions/workflows/' + WORKFLOW + '/runs?event=workflow_dispatch&per_page=100', {
      headers: githubHeaders(env), signal: AbortSignal.timeout(15000),
    });
    if (!list.ok) return { ok: false, error: 'Video job lookup failed (HTTP ' + list.status + ').' };
    const data = await readJson(list);
    const job = (data.workflow_runs || []).find(r => r.display_title === 'CHE free render ' + taskId);
    if (!job) return { ok: true, pending: true, task_id: taskId, stage: 'queued', detail: 'Waiting for GitHub runner to start.' };
    if (job.status !== 'completed') return { ok: true, pending: true, task_id: taskId, stage: job.status };
    if (job.conclusion !== 'success') return { ok: false, task_id: taskId, stage: 'failed', error: 'Render job failed; inspect GitHub Actions run ' + job.id + '.' };
    const artifactsReply = await fetcher(root + '/actions/runs/' + job.id + '/artifacts?per_page=100', {
      headers: githubHeaders(env), signal: AbortSignal.timeout(15000),
    });
    if (!artifactsReply.ok) return { ok: false, task_id: taskId, error: 'Rendered files could not be listed.' };
    const artifacts = await readJson(artifactsReply);
    const artifact = (artifacts.artifacts || []).find(a => a.name === 'che-video-' + taskId && !a.expired);
    if (!artifact) return { ok: false, task_id: taskId, error: 'Render finished without a downloadable artifact.' };
    // Validate actual archive contents, not merely an Action run's success flag.
    const archive = await downloadArchive(env, artifact.id, fetcher);
    const [video, image, manifestBytes] = await Promise.all([
      zipEntry(archive, 'video.mp4'), zipEntry(archive, 'thumbnail.png'), zipEntry(archive, 'manifest.json'),
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const mp4 = video.length >= 12 && String.fromCharCode(...video.slice(4,8)) === 'ftyp';
    const png = image.length >= 24 && image[0] === 137 && image[1] === 80 && image[2] === 78 && image[3] === 71;
    const pngView = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const width = png ? pngView.getUint32(16) : 0, height = png ? pngView.getUint32(20) : 0;
    const duration = Number(manifest.duration_seconds);
    if (!mp4 || !png || width !== 1280 || height !== 720 || manifest.status !== 'verified' ||
      !(duration >= 4.7 && duration <= 90.3) || manifest.youtube_uploaded !== false) {
      return { ok: false, task_id: taskId, error: 'Renderer artifact failed independent media checks.' };
    }
    return { ok: true, pending: false, task_id: taskId, verified: true,
      provider: 'github-actions-offline', artifact_id: artifact.id, run_id: job.id,
      duration_seconds: duration, duration_verified: true,
      video_width: manifest.video_width, video_height: manifest.video_height,
      thumbnail_width: width, thumbnail_height: height,
      title: String(manifest.title || '').slice(0,100),
      description: String(manifest.description || '').slice(0,700),
      retention_days: 30, paid_media: false, youtube_uploaded: false };
  } catch (error) {
    return { ok: false, task_id: taskId,
      error: 'Could not verify GitHub video files: ' + String(error?.message || 'unavailable').slice(0,140) };
  }
}

async function downloadArchive(env, artifactId, fetcher) {
  const response = await fetcher('https://api.github.com/repos/' + REPO + '/actions/artifacts/' + artifactId + '/zip', {
    headers: githubHeaders(env), signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error('Artifact download HTTP ' + response.status);
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
