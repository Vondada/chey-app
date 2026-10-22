// Visual Studio renders on the owner's GitHub Actions (che-edit-render.yml), the same free path as CHE's video
// renderer. The Action fetches the edit document and its source files from the Worker with a one-time token that
// expires, renders with ffmpeg/Pillow (tools/che_edit_render.py), measures the output, and uploads it. CHE calls a
// render ready only after it has downloaded the artifact and checked the file itself.

import { credentials, downloadArchive, githubHeaders, mp4Facts, readJson, refusalOf, zipEntry } from './github_video_renderer.js';

const REPO = 'Vondada/chey-app';
const WORKFLOW = 'che-edit-render.yml';
export const RENDER_TOKEN_MS = 2 * 60 * 60_000;

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/// A new render job: its id, the one-time token for the Action (returned once, stored only as a hash) and expiry.
export async function newRenderJob(spec, now = Date.now()) {
  const id = 'gha_' + crypto.randomUUID().replaceAll('-', '');
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  return { job: { id, token_hash: await sha256(token), expires: now + RENDER_TOKEN_MS, assets: spec.assets, kind: spec.doc.kind, expected: spec.duration, canvas: spec.doc.canvas, stage: 'preparing', progress: 0.05, started_at: new Date(now).toISOString() }, token };
}

/// Whether a token opens this job: right job, same hash, not expired.
export async function tokenOpens(job, token, now = Date.now()) {
  return Boolean(job && token && now < job.expires && (await sha256(String(token))) === job.token_hash);
}

export async function startEditRender(env, job, { base, token }, fetcher = fetch) {
  if (!credentials(env)) return { ok: false, code: 'not_configured', error: 'Rendering runs on your GitHub Actions and needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO=Vondada/chey-app on the Worker.' };
  const post = (url, body) => fetcher(url, { method: 'POST', headers: { ...githubHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(14000) });
  const inputs = { job_id: job.id, source: base, token };
  let res;
  try {
    res = await post(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs });
  } catch { return { ok: false, code: 'unreachable', retryable: true, error: 'GitHub Actions could not be reached. Nothing was started.' }; }
  if (res.status === 204) return { ok: true };
  const first = await refusalOf(res, 'the edit render workflow', env);
  if (res.status === 401 || first.retryable) return { ok: false, ...first };
  try {
    res = await post(`https://api.github.com/repos/${REPO}/dispatches`, { event_type: 'che_edit_render', client_payload: inputs });
  } catch { return { ok: false, code: 'unreachable', retryable: true, error: 'GitHub refused the workflow and the fallback could not be reached.' }; }
  if (res.status === 204) return { ok: true };
  const why = await refusalOf(res, 'the edit render fallback', env);
  return { ok: false, ...why };
}

/// The render's state from GitHub. Ready only when the artifact downloads and its file passes CHE's own checks:
/// an MP4 with H.264 + AAC at the canvas size and the timeline's length, or a PNG at the canvas size.
export async function editRenderStatus(env, job, fetcher = fetch, now = Date.now()) {
  if (!credentials(env)) return { ok: false, error: 'Rendering is not connected.' };
  const root = `https://api.github.com/repos/${REPO}`;
  try {
    const list = await fetcher(`${root}/actions/workflows/${WORKFLOW}/runs?per_page=50`, { headers: githubHeaders(env), signal: AbortSignal.timeout(15000) });
    if (!list.ok) { const why = await refusalOf(list, 'the render lookup', env); return why.retryable ? { ok: true, pending: true, stage: 'checking' } : { ok: false, error: why.error }; }
    const run = ((await readJson(list)).workflow_runs || []).find((r) => r.display_title === `CHE edit render ${job.id}`);
    if (!run) return now - Date.parse(job.started_at) > 15 * 60_000 ? { ok: false, error: 'GitHub never started this render (no run after 15 minutes). Nothing was produced.' } : { ok: true, pending: true, stage: 'queued' };
    if (run.status !== 'completed') return { ok: true, pending: true, stage: run.status === 'in_progress' ? 'running' : 'queued', run_id: run.id };
    if (run.conclusion !== 'success') return { ok: false, run_id: run.id, error: `The render ${run.conclusion === 'timed_out' ? 'ran past its time limit' : 'failed'} on GitHub (Actions run ${run.id}). No file was produced.` };
    const arts = await fetcher(`${root}/actions/runs/${run.id}/artifacts?per_page=20`, { headers: githubHeaders(env), signal: AbortSignal.timeout(15000) });
    const artifact = ((await readJson(arts)).artifacts || []).find((a) => a.name === `che-edit-${job.id}` && !a.expired);
    if (!artifact) return { ok: false, run_id: run.id, error: 'The render finished without a downloadable file.' };
    const archive = await downloadArchive(env, artifact.id, fetcher);
    const manifest = JSON.parse(new TextDecoder().decode(await zipEntry(archive, 'manifest.json')));
    if (manifest.status !== 'verified') return { ok: false, error: `The renderer did not verify its output: ${manifest.error || 'unknown reason'}.` };
    return { ok: true, pending: false, run_id: run.id, artifact_id: artifact.id, ...(await checkOutput(job, archive)) };
  } catch (err) {
    return err?.retryable ? { ok: true, pending: true, stage: 'checking' } : { ok: false, error: `Could not verify the render: ${String(err?.message || err).slice(0, 160)}` };
  }
}

/// CHE's own check of the rendered file, independent of the renderer's word.
export async function checkOutput(job, archive) {
  if (job.kind === 'video') {
    const bytes = await zipEntry(archive, 'video.mp4');
    const mp4 = mp4Facts(bytes);
    const problems = [
      !mp4.ok && 'the MP4 is not a playable H.264/AAC file',
      mp4.width && (mp4.width !== job.canvas.w || mp4.height !== job.canvas.h) && `the MP4 is ${mp4.width}x${mp4.height}, not ${job.canvas.w}x${job.canvas.h}`,
      mp4.ok && Math.abs(mp4.seconds - job.expected) > 0.4 && `it lasts ${mp4.seconds} s, not ${job.expected} s`,
    ].filter(Boolean);
    if (problems.length) return { verified: false, error: `The rendered file failed CHE's checks: ${problems.join('; ')}.` };
    return { verified: true, file: 'video.mp4', bytes: bytes.length, verification: { codec: `${mp4.video}/${mp4.audio}`, width: mp4.width, height: mp4.height, seconds: mp4.seconds } };
  }
  const bytes = await zipEntry(archive, 'edited.png');
  const png = bytes.length > 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = png ? view.getUint32(16) : 0;
  const h = png ? view.getUint32(20) : 0;
  if (!png || w !== job.canvas.w || h !== job.canvas.h) return { verified: false, error: `The exported image is not a ${job.canvas.w}x${job.canvas.h} PNG.` };
  return { verified: true, file: 'edited.png', bytes: bytes.length, png: bytes, verification: { width: w, height: h } };
}
