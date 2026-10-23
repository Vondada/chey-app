// Film Studio assembly on the owner's GitHub Actions (che-film-render.yml), the same free path as the Visual Studio
// and video renderers. One dispatch fans out to one runner per segment (up to 20 at once); each runner renders its
// segment with tools/che_film_render.py, and a final job joins them without re-encoding and uploads the film to R2
// through CHE in parts. CHE calls a film done only after reading the stored MP4 back from R2 and checking it.

import { credentials, githubHeaders, mp4Facts, readJson, refusalOf } from './github_video_renderer.js';

const REPO = 'Vondada/chey-app';
export const FILM_WORKFLOW = 'che-film-render.yml';
export const FILM_RENDER_TOKEN_MS = 6 * 3600_000;
export const UPLOAD_PART_BYTES = 50 * 1024 * 1024;

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function newAssemblyJob(film, segments, now = Date.now()) {
  const id = 'fgha_' + crypto.randomUUID().replaceAll('-', '');
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  return { job: { id, film_id: film.id, token_hash: await sha256(token), expires: now + FILM_RENDER_TOKEN_MS, segments, dispatched_ms: now, state: 'dispatching' }, token };
}

export async function assemblyTokenOpens(job, token, now = Date.now()) {
  return Boolean(job && token && now < job.expires && (await sha256(String(token))) === job.token_hash);
}

export async function startFilmRender(env, job, { base, token }, fetcher = fetch) {
  if (!credentials(env)) return { ok: false, error: 'Assembly runs on your GitHub Actions and needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker.' };
  try {
    const res = await fetcher(`https://api.github.com/repos/${REPO}/actions/workflows/${FILM_WORKFLOW}/dispatches`, {
      method: 'POST', headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { job_id: job.id, source: base, token, segments: String(job.segments) } }), signal: AbortSignal.timeout(15000),
    });
    if (res.status === 204) return { ok: true };
    const why = await refusalOf(res, 'the film render workflow', env);
    return { ok: false, retryable: Boolean(why.retryable), error: why.error };
  } catch { return { ok: false, retryable: true, error: 'GitHub Actions could not be reached. Nothing was started.' }; }
}

/** The GitHub side of an assembly. Done means only "the runners finished"; the film itself is judged from R2. */
export async function filmRenderStatus(env, job, fetcher = fetch, now = Date.now()) {
  const root = `https://api.github.com/repos/${REPO}`;
  try {
    const list = await fetcher(`${root}/actions/workflows/${FILM_WORKFLOW}/runs?per_page=30`, { headers: githubHeaders(env), signal: AbortSignal.timeout(15000) });
    if (!list.ok) { const why = await refusalOf(list, 'the film render lookup', env); return why.retryable ? { pending: true } : { ok: false, error: why.error }; }
    const run = ((await readJson(list)).workflow_runs || []).find((r) => r.display_title === `CHE film render ${job.id}`);
    if (!run) return now - job.dispatched_ms > 15 * 60_000 ? { ok: false, error: 'GitHub never started the film assembly (no run after 15 minutes).' } : { pending: true, stage: 'queued' };
    if (run.status !== 'completed') return { pending: true, stage: run.status, run_id: run.id, run_started_ms: Date.parse(run.run_started_at || run.created_at || '') || null };
    if (run.conclusion !== 'success') return { ok: false, run_id: run.id, error: `The assembly ${run.conclusion === 'timed_out' ? 'ran past its time limit' : 'failed'} on GitHub (Actions run ${run.id}). No film was made.` };
    return { ok: true, finished: true, run_id: run.id, minutes: Math.max(1, Math.round((Date.parse(run.updated_at) - Date.parse(run.run_started_at || run.created_at)) / 60000)) };
  } catch { return { pending: true }; }
}

/** Checks the GitHub token reaches the repository and learns whether it is public (public Actions minutes are free). */
export async function validateGithub(env, fetcher = fetch) {
  if (!credentials(env)) return { ok: false, error: 'not set up' };
  try {
    const res = await fetcher(`https://api.github.com/repos/${REPO}`, { headers: githubHeaders(env), signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, error: `GitHub answered ${res.status}` };
    const repo = await readJson(res);
    return { ok: true, public: repo.private === false };
  } catch { return { ok: false, error: 'GitHub could not be reached' }; }
}

/**
 * Reads the stored film back from storage and checks it the way verifyVideoMedia checks a renderer's file, then further:
 * a real MP4 (ftyp), H.264 video and AAC audio, the planned frame size, and a length within 2% of the assembled
 * timeline. The file is written with +faststart, so its index is in the first bytes read. `media` is the store from
 * che_media_store.js (CHE's own store, or R2 when bound); this check does not depend on which one.
 */
export async function verifyFilmObject(media, key, { expectedSeconds, width = 1280, height = 720 } = {}) {
  const head = await media.head(key).catch(() => null);
  if (!head) return { ok: false, error: 'The film file is not in storage.' };
  const take = Math.min(head.size, 24 * 1024 * 1024);
  const obj = await media.get(key, { length: take }).catch(() => null);
  if (!obj) return { ok: false, error: 'The film file could not be read back from storage.' };
  const bytes = obj.body;
  const facts = mp4Facts(bytes);
  if (!facts.ok) return { ok: false, error: 'The stored file is not a playable MP4 with H.264 video and AAC audio.', facts };
  if (facts.width !== width || facts.height !== height) return { ok: false, error: `The film is ${facts.width}x${facts.height}, not ${width}x${height}.`, facts };
  if (expectedSeconds && Math.abs(facts.seconds - expectedSeconds) > Math.max(2, expectedSeconds * 0.02)) return { ok: false, error: `The film is ${facts.seconds} seconds long, not the ${expectedSeconds} assembled.`, facts };
  return { ok: true, verified: true, bytes: head.size, ...facts };
}
