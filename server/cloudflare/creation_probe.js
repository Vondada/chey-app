// The Creation Engine's live end-to-end check (owner, 2026-10-24: "press Generate, start a worker, build a full-body
// character in Blender, save the GLB, and open it in CHE"). The deploy workflow (che-worker-deploy.yml, creation check)
// calls these routes with that deploy's one-time probe token; nothing else can open them.
//
// It uses the owner's real Creation Studio, not a copy: one project, "Cloud engine check (automatic test)", built from
// CHE's own original character preset, and the same CreationStudio.generate() the app's Generate button calls. The
// Creation Engine then starts its free GitHub CPU worker itself (creation_orchestrator.js), exactly as for the owner.
// The project stays in My Creations, labelled as a test, so the owner can open the real result on the iPhone. Each
// run adds one version's job to that one project; nothing of the owner's is changed or removed.
import { CreationStudio } from './creation_studio.js';
import { GpuQueue, publicJob } from './gpu_queue.js';

export const PROBE_KEY = 'creation:probe';
export const PROBE_TITLE = 'Cloud engine check (automatic test)';
const MAX_PROBE_JOBS = 10;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** POST start → { project_id, job_id, spoken }; GET status?job= → the job as the app sees it; GET model.glb?job= → the GLB. */
export async function creationProbeRoute(ctx, path, request) {
  const { storage, env = {}, now, fetcher } = ctx;
  const rec = (await storage.get(PROBE_KEY)) || { project_id: null, jobs: [] };
  const studio = new CreationStudio(storage, now, { env, fetcher });
  if (path === '/api/creations/probe/start') {
    if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
    let id = rec.project_id && (await studio.find(rec.project_id)).p ? rec.project_id : null;
    if (!id) {
      const made = await studio.create({ kind: 'person', base: 'che', title: PROBE_TITLE });
      if (!made.ok) return json({ ok: false, stage: 'create', detail: made.detail }, 409);
      id = made.project.id;
    }
    // Optional reference fixture (character realism): a synthetic, fictional image the check sends as
    // { reference_base64 }; always recorded as consent "fictional". A run without one builds without a photo.
    const opts = await request.json().catch(() => ({}));
    if (opts?.reference_base64) {
      const ref = await studio.setReference(id, { image_base64: opts.reference_base64, consent: 'fictional' });
      if (!ref.ok) return json({ ok: false, stage: 'reference', project_id: id, detail: ref.detail }, 409);
    } else if ((({ p }) => p?.versions?.[p.current]?.reference)(await studio.find(id))) {
      await studio.removeReference(id);
    }
    const out = await studio.generate(id);
    if (!out.ok) return json({ ok: false, stage: 'generate', project_id: id, detail: out.detail }, 409);
    rec.project_id = id;
    rec.jobs = [...rec.jobs.filter((j) => j !== out.job.id), out.job.id].slice(-MAX_PROBE_JOBS);
    await storage.put(PROBE_KEY, rec);
    const engine = await studio.engine();
    return json({ ok: true, project_id: id, job_id: out.job.id, duplicate: out.duplicate, spoken: out.spoken,
      engine: { automatic: engine.automatic, waiting_reason: engine.waiting_reason || '' } });
  }
  const jobId = String(new URL(request.url).searchParams.get('job') || '');
  if (!rec.jobs.includes(jobId)) return json({ detail: 'Not a job this check started.' }, 404);
  const q = new GpuQueue(storage, now);
  if (path === '/api/creations/probe/status' && request.method === 'GET') {
    await studio.capacity();
    const job = (await q.jobs()).find((j) => j.id === jobId);
    if (!job) return json({ detail: 'That job is gone.' }, 404);
    const view = publicJob(job);
    const dispatches = ((await storage.get('gpu:dispatches')) || []).slice(-5);
    return json({ ok: true, project_id: rec.project_id, job: { id: view.id, state: view.state, display_state: view.display_state, status_line: view.status_line,
      worker_id: view.worker_id, worker_class: view.worker_class, worker_name: view.worker_name, model: view.model, rig: view.rig, checkpoints: view.checkpoints, history: (job.history || []).slice(-20),
      receipt: job.receipt || null, device_line: view.device_line, reference_line: view.reference_line, previews: Object.keys(job.previews || {}), error: job.error || '' }, dispatches });
  }
  if (path === '/api/creations/probe/model.glb' && request.method === 'GET') {
    const bytes = await q.modelBytes(env, jobId);
    if (!bytes) return json({ detail: 'No 3D model for that job yet.' }, 404);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length) } });
  }
  return json({ detail: 'Not found.' }, 404);
}
