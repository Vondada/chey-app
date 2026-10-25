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
import { GpuQueue, VIEW_NAMES, publicJob } from './gpu_queue.js';
import { listMedia, readBlob } from './media.js';

export const PROBE_KEY = 'creation:probe';
export const PROBE_TITLE = 'Cloud engine check (automatic test)';
const MAX_PROBE_JOBS = 10;

// ── Character acceptance run (owner, 2026-10-25; tools/creation_accept.mjs drives it) ───────────────────────────────
// The real Create Person flow: three described characters (one per look), the photoreal one with a synthetic fictional
// reference and the same description built without it, chained edits as new versions with their own jobs, then a fresh
// reopen of each saved project. Projects are reused across runs (a new version each run), so My Creations gains at most
// four labelled test projects. Nothing here marks a job generated: the driver counts only completed jobs whose GLB
// matches the receipt's sha256, and status says the same in `generated`.
export const ACCEPT_KEY = 'creation:probe:accept';
const MAX_ACCEPT_JOBS = 30;
const MAX_RUNS = 5;
export const ACCEPT_PEOPLE = {
  photoreal: 'a 35-year-old woman, tall, athletic, long wavy dark hair, denim jacket, realistic',
  hybrid: 'a broad-shouldered man in his 40s, short curly hair, leather jacket, game-style',
  stylized: 'a slim young adult, afro, hoodie, stylized cartoon look',
};
export const acceptTitle = (key) => `Character check: ${key === 'photoreal_noref' ? 'photoreal without reference' : key} (automatic test)`;

async function acceptRoute(ctx, path, request, studio) {
  const { storage, now, env = {} } = ctx;
  const acc = (await storage.get(ACCEPT_KEY)) || { projects: {}, runs: [], jobs: [] };
  acc.projects ||= {}; acc.runs ||= []; acc.jobs ||= [];
  const url = new URL(request.url);
  const save = async () => { acc.jobs = acc.jobs.slice(-MAX_ACCEPT_JOBS); acc.runs = acc.runs.slice(-MAX_RUNS); await storage.put(ACCEPT_KEY, acc); };
  const track = (id) => { if (id && !acc.jobs.includes(id)) acc.jobs.push(id); };
  const runOf = (id) => acc.runs.find((r) => r.id === id);

  if (path === '/api/creations/probe/accept/start') {
    if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
    const body = await request.json().catch(() => ({}));
    const ref = String(body?.reference_b64 || body?.reference_base64 || '');
    const keys = ['photoreal', ...(ref ? ['photoreal_noref'] : []), 'hybrid', 'stylized'];
    const run = { id: `acc_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, at: new Date((now || Date.now)()).toISOString(), items: [] };
    for (const key of keys) {
      const description = ACCEPT_PEOPLE[key.replace(/_noref$/, '')];
      let id = acc.projects[key] && (await studio.find(acc.projects[key])).p ? acc.projects[key] : null;
      if (!id) {
        const made = await studio.create({ kind: 'person', description, title: acceptTitle(key), generate: false });
        if (!made.ok) return json({ ok: false, stage: 'create', key, detail: made.detail }, 409);
        id = made.project.id; acc.projects[key] = id;
      } else {
        // A reused project starts this run from the described person again, as a new version (earlier ones stay).
        const fresh = await studio.redescribe(id, description);
        if (!fresh.ok) return json({ ok: false, stage: 'describe', key, detail: fresh.detail }, 409);
      }
      if (key === 'photoreal' && ref) {
        const r = await studio.setReference(id, { image_base64: ref, consent: 'fictional' });
        if (!r.ok) return json({ ok: false, stage: 'reference', key, detail: r.detail }, 409);
      }
      const out = await studio.generate(id);
      if (!out.ok) return json({ ok: false, stage: 'generate', key, project_id: id, detail: out.detail }, 409);
      await studio.step(id, 'save');
      track(out.job.id);
      run.items.push({ key, project_id: id, job_id: out.job.id, version: out.project.version, duplicate: Boolean(out.duplicate) });
    }
    acc.runs.push(run); await save();
    const engine = await studio.engine();
    return json({ ok: true, run_id: run.id, items: run.items, engine: { automatic: engine.automatic, waiting_reason: engine.waiting_reason || '' } });
  }

  if (path === '/api/creations/probe/accept/edit') {
    if (request.method !== 'POST') return json({ detail: 'Use POST.' }, 405);
    const body = await request.json().catch(() => ({}));
    const run = runOf(String(body?.run_id || ''));
    if (!run) return json({ ok: false, detail: 'No such acceptance run.' }, 404);
    const key = String(body.key || '').slice(0, 40); const baseKey = String(body.base_key || key.replace(/_[a-z]+$/, ''));
    const base = run.items.find((x) => x.key === baseKey);
    if (!base) return json({ ok: false, detail: `No item ${baseKey} in this run.` }, 404);
    if (!/^[a-z0-9_]{1,40}$/.test(key) || run.items.some((x) => x.key === key)) return json({ ok: false, detail: 'key must be new in this run (letters, digits, _).' }, 409);
    // Each edit is a new version of the same project with its own job, queued at once (the queue never merges jobs of
    // different settings, so chained edits run as separate jobs without waiting for each other).
    const edit = await studio.edit(base.project_id, String(body.text || '').slice(0, 300));
    if (!edit.ok) return json({ ok: false, detail: edit.detail }, 409);
    if (!edit.changed) return json({ ok: false, detail: `Nothing changed: ${edit.spoken}`, applied: edit.applied, unsupported: edit.unsupported }, 409);
    const out = await studio.generate(base.project_id);
    if (!out.ok) return json({ ok: false, detail: out.detail }, 409);
    await studio.step(base.project_id, 'save');
    track(out.job.id);
    const item = { key, project_id: base.project_id, job_id: out.job.id, version: out.project.version, applied: edit.applied, unsupported: edit.unsupported, duplicate: Boolean(out.duplicate) };
    run.items.push(item); await save();
    return json({ ok: true, item });
  }

  const run = runOf(String(url.searchParams.get('run') || ''));
  if (!run) return json({ ok: false, detail: 'No such acceptance run.' }, 404);
  if (path === '/api/creations/probe/accept/status' && request.method === 'GET') {
    await studio.capacity();
    const jobs = await new GpuQueue(storage, now).jobs();
    const items = run.items.map((it) => {
      const job = jobs.find((j) => j.id === it.job_id);
      if (!job) return { ...it, state: 'missing', generated: false, error: 'That job is gone.' };
      const v = publicJob(job);
      return { key: it.key, project_id: it.project_id, job_id: it.job_id, version: it.version, state: v.state, display_state: v.display_state, status_line: v.status_line,
        worker_name: v.worker_name, receipt: job.receipt || null, device_line: v.device_line, reference_line: v.reference_line,
        model: v.model ? { sha256: v.model.sha256, bytes: v.model.bytes } : null, rig: v.rig,
        previews: Object.keys(job.previews || {}).map((deg) => VIEW_NAMES[deg] || deg), error: job.error || '', history: (job.history || []).slice(-20),
        generated: v.state === 'completed' && Boolean(v.model) && job.receipt?.model?.sha256 === v.model.sha256 };
    });
    return json({ ok: true, run_id: run.id, items });
  }
  if (path === '/api/creations/probe/accept/reopen' && request.method === 'GET') {
    // A fresh studio over storage: what My Creations would open now, not what this run remembers.
    const fresh = new CreationStudio(storage, now, { env });
    const seen = new Set(); const items = [];
    for (const it of [...run.items].reverse()) {
      if (seen.has(it.project_id)) continue; seen.add(it.project_id);
      const got = await fresh.get(it.project_id);
      if (!got.ok) { items.push({ key: it.key, project_id: it.project_id, detail: got.detail }); continue; }
      const p = got.project; const lm = p.last_model;
      items.push({ key: it.key, project_id: it.project_id, title: p.title, saved_version: p.version, saved_at: p.saved_at, versions: p.versions_count,
        glb_job_id: lm?.job_id || null, glb_version: lm?.version || null, glb_url: lm?.url || null, model_sha256: lm?.sha256 || null,
        reference: p.reference ? { sha256: p.reference.sha256, consent: p.reference.consent } : null });
    }
    return json({ ok: true, run_id: run.id, items: items.reverse() });
  }
  return json({ detail: 'Not found.' }, 404);
}

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
  if (path.startsWith('/api/creations/probe/accept/')) return acceptRoute(ctx, path, request, studio);
  const jobId = String(new URL(request.url).searchParams.get('job') || '');
  const acc = (await storage.get(ACCEPT_KEY)) || { jobs: [] };
  if (!rec.jobs.includes(jobId) && !(acc.jobs || []).includes(jobId)) return json({ detail: 'Not a job this check started.' }, 404);
  const q = new GpuQueue(storage, now);
  if (path === '/api/creations/probe/preview.png' && request.method === 'GET') {
    // A finished preview of a check's job, by view name (front, three-quarter, side) or angle.
    const job = (await q.jobs()).find((j) => j.id === jobId);
    const name = String(new URL(request.url).searchParams.get('name') || '').replace(/\.png$/, '');
    const view = Object.entries(VIEW_NAMES).find(([deg, n]) => n === name || deg === name)?.[0] ?? name;
    const mediaId = job?.previews?.[view];
    const item = mediaId && (await listMedia(storage)).find((x) => x.id === mediaId);
    const bytes = item && (await readBlob(env, storage, item));
    if (!bytes?.length) return json({ detail: 'No such preview for that job.' }, 404);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': item.mime_type || 'image/png', 'Content-Length': String(bytes.length) } });
  }
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
