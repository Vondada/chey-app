// Manifestation Engine: owner-only HTTP routes, the chat route and the Simulation Room scene.
// worker.js calls `manifestRoute` for /api/manifest/* and `manifestChat` before the Simulation Lab's chat
// route, so the Worker grows by two lines. No model call anywhere: replies are built from stored records.

import { LA_AGENCIA_ROLES } from './office_company.js';
import {
  DEFAULT_SAMPLES, FEASIBILITY, MANIFEST_SOURCE, MODELS, ManifestStore, STATUSES,
  advanceToPlan, buildRealizationPlan, buildSpec, recordOutcome, replayRun, sensitivity, simulate,
  simulateAll, speakProject, startProject, sweep, transition, validateEvidence,
} from './manifest_engine.js';
import { round } from './manifest_stats.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const ndjson = (reply, meta) => new Response(`${JSON.stringify({ type: 'delta', delta: reply })}\n${JSON.stringify({ type: 'done', ...meta })}\n`, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
const newId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
const fail = (detail, status = 400) => json({ detail }, status);

/** A model as data (no functions), for GET /api/manifest/models. */
export function modelCard(m) {
  return { id: m.id, version: m.version, domain: m.domain, title: m.title, method: m.method, equations: m.equations, assumptions: m.assumptions, references: m.references, inputs: m.inputs, outputs: m.outputs, primary: m.primary, outcome_metrics: m.outcome_metrics };
}

// ── The Simulation Room scene ──────────────────────────────────────────────────────────────────
const AGENT_BY_DEPARTMENT = Object.fromEntries(Object.entries(LA_AGENCIA_ROLES).map(([name, r]) => [r.department?.id, name]));

/**
 * The project as a room the 3D world can render: a possibility field (one object per candidate, placed by its
 * simulated result and success probability, sized by its uncertainty), the alternatives, the plan steps and the
 * suggested Office workstation. Read-only; every object names the record it came from.
 */
export function manifestScene(project) {
  const rows = project.comparison?.rows || [];
  const p50s = rows.filter((r) => r.primary && Number.isFinite(r.primary.p50)).map((r) => r.primary.p50);
  const [lo, hi] = p50s.length ? [Math.min(...p50s), Math.max(...p50s)] : [0, 1];
  const norm = (v) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  const objects = project.candidates.map((c) => {
    const row = rows.find((r) => r.candidate_id === c.id) || {};
    const f = c.feasibility || {};
    const width = row.primary && Number.isFinite(row.primary.p90) && Number.isFinite(row.primary.p10) && row.primary.p50 ? Math.abs(row.primary.p90 - row.primary.p10) / Math.abs(row.primary.p50) : null;
    return {
      id: `candidate:${c.id}`, kind: 'candidate', candidate_id: c.id, label: c.name, description: c.description,
      class: f.class || 'unknown', class_label: FEASIBILITY[f.class || 'unknown'], best: project.comparison?.best === c.id,
      success_probability: row.success_probability ?? null, primary: row.primary || null,
      cost_usd: row.cost_high != null && Number.isFinite(row.cost_high) ? [round(row.cost_low, 0), round(row.cost_high, 0)] : null,
      limiting_constraint: f.limiting_constraint || null, violated: f.violated || [],
      field: { x: row.primary && Number.isFinite(row.primary.p50) ? round(norm(row.primary.p50), 4) : null, y: row.success_probability ?? 0, spread: width == null ? null : round(Math.min(1, width), 4) },
      provenance: row.run_id ? 'simulated' : 'prediction', source: { store: 'manifest_runs', id: row.run_id || '' },
      spoken: `${c.name}: ${FEASIBILITY[f.class || 'unknown']}.${row.primary ? ` ${row.primary.id.replace(/_/g, ' ')} median ${row.primary.p50}${row.primary.unit === '1' ? '' : ` ${row.primary.unit}`}, between ${row.primary.p10} and ${row.primary.p90}.` : ''}${row.success_probability != null ? ` Met its goals in ${Math.round(row.success_probability * 100)}% of runs.` : ''}${f.reasons?.[0] ? ` ${f.reasons[0]}` : ''}`,
    };
  });
  const alternatives = (project.candidates[0]?.feasibility?.alternatives || []).map((a) => ({ id: `alternative:${a.id}`, kind: 'alternative', label: a.name, class: a.class, class_label: FEASIBILITY[a.class], numbers: a.numbers || null, provenance: a.numbers ? 'prediction' : 'not modelled', spoken: `${a.name}: ${a.text}` }));
  const steps = (project.plan?.steps || []).map((s) => ({ id: `step:${s.id}`, kind: 'step', step_id: s.id, label: s.title, who: s.who, status: s.status, milestone: s.milestone, consequential: s.consequential, verification: s.verification, spoken: `Step ${s.id.slice(1)}, ${s.title}. ${s.status === 'verified' ? 'Verified with evidence.' : `Not verified yet; needs ${s.verification.replace('_', ' ')}.`}` }));
  const dept = project.plan?.office?.department;
  return {
    scene: 'manifest', id: project.id, title: project.title, status: project.status, domain: project.domain,
    ladder: STATUSES.map((s, i) => ({ status: s, reached: STATUSES.indexOf(project.status) >= i || (project.status === 'BLOCKED' && STATUSES.indexOf(project.blocked_from) >= i) })),
    room: { id: 'simulation', host: 'crew_world', note: 'Rendered inside the walkable crew world (assets/characters/app/index.html) as its Simulation Room.' },
    axes: { x: rows[0]?.primary ? `${rows[0].primary.id} (median, scaled across candidates)` : null, y: 'probability of meeting every goal (Monte Carlo)', spread: '(p90 − p10) / p50' },
    objects: [...objects, ...alternatives, ...steps],
    stations: dept ? [{ id: dept, agent: AGENT_BY_DEPARTMENT[dept] || null, assignment: 'suggested', task_id: null, note: 'No Office task has been queued for this project.' }] : [],
    spoken: speakProject(project), updated_at: project.updated_at,
  };
}

// ── Chat ────────────────────────────────────────────────────────────────────────────────────────
const WAKE = /^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+|can\s+you\s+|could\s+you\s+)*/i;
const STATUS = /^(?:(?:open|show|read)\s+(?:me\s+)?(?:my\s+|the\s+)?)?manifest(?:ation)?\s+(?:engine\s+)?(?:status|projects?|room)\s*$|^(?:open|show)\s+(?:me\s+)?(?:my\s+|the\s+)?manifestation\s+(?:engine|projects?|room)\s*$|^(?:what(?:'s|\s+is)\s+the\s+)?status\s+of\s+my\s+manifestation\s+projects?\s*$/i;
const CREATE = /^(?:manifest|manifestation\s+(?:project|engine))\b[\s,:-]*(?:for\s+|this:?\s+)?(.+)$/i;

/** { kind: 'status' } | { kind: 'create', goal } | null. Deterministic. */
export function manifestIntent(message) {
  const body = String(message || '').replace(/[’]/g, "'").trim().replace(WAKE, '').replace(/[.?!]+$/, '').trim();
  if (!body || body.length > 1500) return null;
  if (STATUS.test(body)) return { kind: 'status' };
  const m = CREATE.exec(body);
  if (m && m[1].trim().split(/\s+/).length >= 2) return { kind: 'create', goal: m[1].trim() };
  if (/^manifest(?:ation)?\s*$/i.test(body)) return { kind: 'status' };
  return null;
}

/** The chat route: a Response, or null when the message is not for the engine. */
export async function manifestChat(message, storage, ownerDevice) {
  const ask = manifestIntent(message);
  if (!ask) return null;
  if (!ownerDevice) return ndjson('Only the CHE owner can use the Manifestation Engine, sir. Nothing was created.', { source: MANIFEST_SOURCE, ok: false, model_calls: 0 });
  const store = new ManifestStore(storage);
  if (ask.kind === 'status') {
    const list = await store.list();
    if (!list.length) return ndjson('There are no manifestation projects yet, sir. Say "manifest" and your goal, for example "manifest a drone that carries 1 kg for 25 minutes".', { source: MANIFEST_SOURCE, ok: true, model_calls: 0, project_id: '' });
    const lines = list.slice(0, 5).map((p, i) => `${i + 1}. ${p.title}: ${p.status}.`);
    return ndjson(`Your manifestation projects, newest first, sir. ${lines.join(' ')}`, { source: MANIFEST_SOURCE, ok: true, model_calls: 0, project_id: list[0].id, status: list[0].status });
  }
  const started = await startProject(store, ask.goal, { newId });
  if (started.refused) return ndjson(`I won't take that on, sir. ${started.spec.safety.notes.join(' ')} Nothing was created.`, { source: MANIFEST_SOURCE, ok: false, model_calls: 0, project_id: '' });
  const p = started.project;
  return ndjson(speakProject(p), { source: MANIFEST_SOURCE, ok: p.status !== 'BLOCKED', model_calls: 0, project_id: p.id, status: p.status });
}

// ── HTTP routes ─────────────────────────────────────────────────────────────────────────────────
// worker.js has already read the request body; it passes it in. Read it here only when it did not.
async function bodyOf(request, parsed) {
  if (parsed && typeof parsed === 'object') return parsed;
  try { return (await request.json()) || {}; } catch (_) { return {}; }
}

function valuesFrom(b) {
  if (Array.isArray(b.values)) return b.values;
  if (!Number.isFinite(Number(b.from)) || !Number.isFinite(Number(b.to))) return [];
  const n = Math.max(2, Math.min(50, Math.round(Number(b.steps) || 5)));
  return Array.from({ length: n }, (_, i) => Number(b.from) + (i * (Number(b.to) - Number(b.from))) / (n - 1));
}

const editable = (p) => ['SIMULATION', 'PLAN'].includes(p.status);

/** /api/manifest/* for the owner. Returns a Response, or null when the path is not the engine's. */
export async function manifestRoute(request, path, storage, ownerDevice, parsedBody = null) {
  if (!path.startsWith('/api/manifest')) return null;
  if (!ownerDevice) return fail('Only the CHE owner can use the Manifestation Engine.', 403);
  const store = new ManifestStore(storage);
  const method = request.method;
  try {
    if (path === '/api/manifest/models' && method === 'GET') return json({ models: Object.values(MODELS).map(modelCard) });
    if (path === '/api/manifest/spec' && method === 'POST') {
      const b = await bodyOf(request, parsedBody);
      if (!String(b.request || '').trim()) return fail('Say the goal in "request".');
      return json({ spec: buildSpec(b.request, { overrides: b.variables || {} }) });
    }
    if (path === '/api/manifest/projects' && method === 'GET') return json({ projects: await store.list() });
    if (path === '/api/manifest/projects' && method === 'POST') {
      const b = await bodyOf(request, parsedBody);
      if (!String(b.request || '').trim()) return fail('Say the goal in "request".');
      const started = await startProject(store, b.request, { overrides: b.variables || {}, auto: b.auto !== false, newId, samples: Number(b.samples) || DEFAULT_SAMPLES });
      if (started.refused) return json({ refused: true, spec: started.spec, detail: started.spec.safety.notes.join(' ') }, 422);
      return json({ project: started.project, spoken: speakProject(started.project) }, 201);
    }
    const runMatch = /^\/api\/manifest\/runs\/(mr-[A-Za-z0-9-]{1,64})(\/replay)?$/.exec(path);
    if (runMatch) {
      const run = await store.getRun(runMatch[1]);
      if (!run) return fail('No such run.', 404);
      if (!runMatch[2] && method === 'GET') return json({ run });
      if (runMatch[2] && method === 'POST') { const r = replayRun(run); return json({ identical: r.identical, reason: r.reason || '' }); }
      return fail('Method not allowed.', 405);
    }
    const m = /^\/api\/manifest\/projects\/(mp-[A-Za-z0-9-]{1,64})(?:\/([a-z]+))?$/.exec(path);
    if (!m) return fail('No such Manifestation Engine route.', 404);
    let project = await store.get(m[1]);
    if (!project) return fail('No such project.', 404);
    const action = m[2] || '';
    if (method === 'GET' && !action) return json({ project, spoken: speakProject(project) });
    if (method === 'GET' && action === 'scene') return json({ scene: manifestScene(project) });
    if (method === 'GET' && action === 'candidates') return json({ candidates: project.candidates, comparison: project.comparison });
    if (method !== 'POST') return fail('Method not allowed.', 405);
    const b = await bodyOf(request, parsedBody);
    const model = project.spec.model ? MODELS[project.spec.model.id] : null;
    const candidate = () => {
      const c = project.candidates.find((x) => x.id === (b.candidate_id || project.plan?.candidate_id || project.comparison?.best));
      if (!c) throw Object.assign(new Error('No such candidate.'), { status: 404 });
      return c;
    };
    const variablesOf = (c) => ({ ...c.variables, ...(project.calibration[c.id]?.variables || {}) });
    switch (action) {
      case 'advance': {
        if (!['IDEA', 'RESEARCH', 'FEASIBILITY', 'SIMULATION'].includes(project.status)) return fail(`The project is at ${project.status}; advance runs only up to the plan.`, 409);
        project = await advanceToPlan(store, project, { newId });
        return json({ project, spoken: speakProject(project) });
      }
      case 'simulate': {
        if (!model) return fail('This project has no model.', 409);
        const c = candidate();
        const changed = Object.fromEntries(Object.entries(b.variables || {}).filter(([k, v]) => model.inputs.some((i) => i.id === k) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]));
        if (b.adopt) {
          // The owner's change becomes the candidate's design; every candidate is re-run under the same conditions.
          if (!editable(project)) return fail(`Variables can change only during SIMULATION or PLAN (now ${project.status}).`, 409);
          Object.assign(c.variables, changed);
          c.changes = [...(c.changes || []), { by: 'owner', variables: changed, at: new Date().toISOString() }];
          await simulateAll(store, project, { now: new Date().toISOString(), newId });
          if (project.plan?.candidate_id === c.id || project.status === 'PLAN') project.plan = buildRealizationPlan(project, project.plan?.candidate_id || project.comparison.best, await store.getRun(project.latest_runs[project.plan?.candidate_id || project.comparison.best]));
          project.updated_at = new Date().toISOString();
          await store.put(project);
          return json({ run: await store.getRun(project.latest_runs[c.id]), comparison: project.comparison, project });
        }
        const run = simulate(model, { ...variablesOf(c), ...changed }, { seed: Number.isInteger(b.seed) ? b.seed : undefined, samples: Number(b.samples) || DEFAULT_SAMPLES, id: newId('mr'), kind: 'what_if', candidate_id: c.id });
        await store.putRun(run);
        project.runs.push({ id: run.id, kind: run.kind, candidate_id: c.id, seed: run.seed, samples: run.samples, success_probability: run.success_probability, calibrated: false, created_at: run.created_at });
        await store.put(project);
        return json({ run });
      }
      case 'sweep': {
        if (!model) return fail('This project has no model.', 409);
        const c = candidate();
        return json({ sweep: sweep(model, variablesOf(c), { variable: b.variable, values: valuesFrom(b), outputs: Array.isArray(b.outputs) && b.outputs.length ? b.outputs : [model.primary], samples: Math.min(2000, Number(b.samples) || 400), seed: Number.isInteger(b.seed) ? b.seed : 1 }) });
      }
      case 'sensitivity': {
        if (!model) return fail('This project has no model.', 409);
        const c = candidate();
        return json({ sensitivity: sensitivity(model, variablesOf(c), { output: b.output || model.primary, ranges: project.calibration[c.id]?.ranges || null }) });
      }
      case 'compare': {
        if (!model || !editable(project)) return fail(`Comparison runs during SIMULATION or PLAN (now ${project.status}).`, 409);
        await simulateAll(store, project, { now: new Date().toISOString(), newId });
        await store.put(project);
        return json({ comparison: project.comparison });
      }
      case 'plan': {
        if (project.status !== 'PLAN') return fail(`A plan is built at PLAN (now ${project.status}).`, 409);
        const c = candidate();
        if (c.feasibility?.class === 'incompatible') return fail('That candidate is incompatible with physical constraints; choose another or an alternative.', 409);
        project.plan = buildRealizationPlan(project, c.id, await store.getRun(project.latest_runs[c.id]));
        project.updated_at = new Date().toISOString();
        await store.put(project);
        return json({ plan: project.plan });
      }
      case 'status': {
        const now = new Date().toISOString();
        if (b.to === 'EXECUTION') {
          const statement = String(b.authorization?.statement || '').trim();
          if (statement.length < 2) return fail('Execution needs your authorization: send authorization.statement in your own words.', 409);
          project.authorizations.push({ scope: 'execution', by: 'owner', statement: statement.slice(0, 300), at: now });
        }
        const r = transition(project, String(b.to || ''), { reason: b.reason || (b.to === 'EXECUTION' ? 'Owner authorized execution.' : ''), now });
        if (!r.ok) return json({ ok: false, detail: r.error, status: project.status }, 409);
        await store.put(r.project);
        return json({ ok: true, project: r.project });
      }
      case 'authorize': {
        const step = project.plan?.steps.find((s) => s.id === b.step_id);
        if (!step) return fail('No such plan step.', 404);
        const statement = String(b.statement || '').trim();
        if (statement.length < 2) return fail('Say the authorization in your own words in "statement".');
        project.authorizations.push({ scope: 'step', step_id: step.id, kind: step.consequential || 'step', by: 'owner', statement: statement.slice(0, 300), at: new Date().toISOString() });
        await store.put(project);
        return json({ ok: true, authorizations: project.authorizations });
      }
      case 'evidence': {
        const now = new Date().toISOString();
        const checked = await validateEvidence(project, b, { submitted_by: 'owner', now, id: newId('me') });
        project.evidence.push(checked.record);
        let outcome = null;
        const step = project.plan?.steps.find((s) => s.id === b.step_id);
        if (checked.accepted && step) {
          step.status = 'verified';
          step.evidence_ids.push(checked.record.id);
          const metric = checked.record.observed?.metric;
          if (checked.record.kind === 'measurement' && metric && model?.outcome_metrics.includes(metric)) {
            await store.put(project);
            outcome = await recordOutcome(store, project, { metric, value: checked.record.observed.value, unit: checked.record.observed.unit, note: `From evidence ${checked.record.id}.` }, { now, newId });
            project = await store.get(project.id);
          }
          // Gates decide; nothing is skipped. EXECUTION → VERIFICATION → COMPLETE only when evidence allows.
          for (const to of ['VERIFICATION', 'COMPLETE']) {
            const r = transition(project, to, { reason: `Evidence ${checked.record.id} accepted.`, now });
            if (r.ok) project = r.project;
          }
        }
        project.updated_at = now;
        await store.put(project);
        return json({ accepted: checked.accepted, reason: checked.reason, evidence: checked.record, step: project.plan?.steps.find((s) => s.id === b.step_id) || null, outcome, status: project.status }, checked.accepted ? 200 : 422);
      }
      case 'outcome': {
        if (!model) return fail('This project has no model.', 409);
        const outcome = await recordOutcome(store, project, { metric: String(b.metric || ''), value: Number(b.value), unit: String(b.unit || ''), candidate_id: b.candidate_id, note: b.note || '' }, { newId });
        return json({ outcome });
      }
      default:
        return fail('No such Manifestation Engine route.', 404);
    }
  } catch (error) {
    return fail(String(error?.message || error).slice(0, 300), error?.status || 400);
  }
}
