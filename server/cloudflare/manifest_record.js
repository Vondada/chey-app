// Manifestation Engine: the one record per idea and what it remembers.
// - Claims: every number the engine states, with its provenance (sourced, calculated, simulated, assumed,
//   verified_real), so "why do you think that?" always has an answer from the record.
// - Pre-registered success test, failure test and stop rule: written once at FEASIBILITY and never changed;
//   amendments are appended with their time and reason, and VERIFICATION judges against the original.
// - The cheapest real-world test of the riskiest assumption, proposed before PLAN.
// - A per-model track record of predicted vs actual, applied as a visible correction, never hidden.
// - Approval gates on consequential steps, enforced where a step starts running.
// - The spoken briefing, the weekly review (on request only) and pause, resume and stop.
// Pure except the track-record helpers, which take a storage object.

export const PROVENANCE = Object.freeze({
  sourced: 'sourced',
  calculated: 'calculated',
  simulated: 'simulated',
  assumed: 'assumed',
  verified_real: 'verified in the real world',
});
// Consequential step kinds: a step of one of these kinds never starts without a recorded owner approval.
export const APPROVAL_KINDS = Object.freeze(['money', 'account', 'contract', 'deployment', 'device', 'application']);

const clip = (s, n) => String(s ?? '').slice(0, n);
const say = (n) => (n === Infinity ? 'unlimited' : !Number.isFinite(n) ? 'not reached' : Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : String(Number(Number(n).toPrecision(3))));
const unitWord = (u) => (u === '1' || !u ? '' : ` ${u}`);

// ── Data sources ────────────────────────────────────────────────────────────────────────────────
/** A model's data sources with a `stale` flag: older than its `stale_after_days`, as of `now`. */
export function dataSourcesWithAge(model, now = new Date().toISOString()) {
  return (model.data_sources || []).map((d) => {
    const age = d.as_of ? Math.floor((Date.parse(now) - Date.parse(d.as_of)) / 86400_000) : null;
    return { ...d, age_days: age, stale: d.stale_after_days != null && age != null && age > d.stale_after_days };
  });
}

// ── Claims ──────────────────────────────────────────────────────────────────────────────────────
/** Appends claims to the idea's record; ids are sequential and never reused. */
export function appendClaims(project, claims, { stage = project.status, now = new Date().toISOString() } = {}) {
  project.claims = project.claims || [];
  for (const c of claims) {
    if (!PROVENANCE[c.provenance]) throw new Error(`Unknown provenance ${c.provenance}.`);
    project.claims.push({ id: `cl-${project.claims.length + 1}`, stage, at: now, subject: clip(c.subject, 120), value: c.value ?? null, unit: c.unit || '', provenance: c.provenance, basis: c.basis || {}, candidate_id: c.candidate_id || '' });
  }
  return project;
}

/** Claims for the spec: what the owner said is sourced from his statement; every default is an assumption. */
export function specClaims(spec, model) {
  if (!model) return [];
  const out = [];
  for (const p of spec.parsed) {
    const inp = model.inputs.find((i) => i.id === p.id);
    out.push({ subject: inp?.name || p.id, value: p.value, unit: p.unit, provenance: p.source === 'assumption' ? 'assumed' : 'sourced', basis: p.source === 'assumption' ? { source: p.note || 'CHE assumption', said: p.text } : { kind: 'owner_statement', said: p.text, via: p.source } });
  }
  for (const i of model.inputs.filter((x) => x.kind === 'uncertain' && !(x.id in spec.owner_variables))) {
    out.push({ subject: i.name, value: i.nominal, unit: i.unit, provenance: 'assumed', basis: { source: i.source || 'placeholder until you give your own figure', range: [i.lo, i.hi] } });
  }
  return out;
}

/** Claims for a classified candidate: the limiting constraint's calculated numbers. */
export function feasibilityClaims(candidate, model) {
  const f = candidate.feasibility;
  const lc = f?.limiting_constraint;
  const out = [{ subject: `${candidate.name}: feasibility`, value: f?.label || null, unit: '', provenance: f?.evidence_level === 'simulated' ? 'simulated' : 'calculated', basis: { model: model.id, version: model.version, basis: f?.basis || '' }, candidate_id: candidate.id }];
  if (lc?.required_wh_per_kg != null) {
    out.push({ subject: `${candidate.name}: battery energy density needed`, value: lc.required_wh_per_kg, unit: 'Wh/kg', provenance: 'calculated', basis: { formula: 'e_needed = e · t_target / t(m_battery*), with m_battery* the endurance-optimal battery', inputs: { e: candidate.variables.specific_energy, t_target: candidate.variables.target_endurance, m_battery_opt: lc.optimal_battery_kg } }, candidate_id: candidate.id });
  }
  if (lc?.required_price_usd != null) {
    out.push({ subject: `${candidate.name}: price needed to break even at capacity`, value: lc.required_price_usd, unit: 'USD/item', provenance: 'calculated', basis: { formula: 'p = v + F / Q_cap', inputs: { v: candidate.variables.variable_cost, F: candidate.variables.fixed_monthly + candidate.variables.marketing_monthly, Q_cap: candidate.variables.capacity } }, candidate_id: candidate.id });
  }
  return out;
}

/** Claims for a full run: the primary forecast as a simulated range. */
export function runClaims(run, model) {
  const o = model.outputs.find((x) => x.id === model.primary);
  const s = run.summary[model.primary];
  return [{ subject: `${run.candidate_id}: ${o.name}`, value: { low: s.p10, likely: s.p50, high: s.p90 }, unit: o.unit, provenance: 'simulated', basis: { model: run.model.id, version: run.model.version, run_id: run.id, seed: run.seed, samples: run.samples, interval: 'p10–p90' }, candidate_id: run.candidate_id }];
}

/** "Why do you think that?" for a subject: every matching claim with its provenance, read aloud. */
export function whyClaim(project, subject) {
  const words = String(subject || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['why', 'the', 'you', 'think', 'that', 'this', 'what', 'does', 'how', 'manifest', 'manifestation'].includes(w));
  const claims = (project.claims || []).filter((c) => words.length && words.every((w) => `${c.subject} ${c.candidate_id}`.toLowerCase().includes(w)));
  const latest = claims.length ? claims : [];
  const line = (c) => {
    const v = c.value && typeof c.value === 'object' ? `between ${say(c.value.low)} and ${say(c.value.high)}, most likely ${say(c.value.likely)}${unitWord(c.unit)}` : `${typeof c.value === 'number' ? say(c.value) : c.value}${typeof c.value === 'number' ? unitWord(c.unit) : ''}`;
    const b = c.basis || {};
    const why = c.provenance === 'sourced' ? (b.kind === 'owner_statement' ? `you said "${b.said}"` : `from ${b.source || 'a source'}${b.url ? ` (${b.url})` : ''}`)
      : c.provenance === 'calculated' ? `calculated with ${b.formula || 'a formula'}${b.inputs ? ` from ${Object.entries(b.inputs).map(([k, x]) => `${k} ${say(x)}`).join(', ')}` : ''}`
        : c.provenance === 'simulated' ? `simulated by ${b.model} version ${b.version}${b.run_id ? `, run ${b.run_id}, seed ${b.seed}, ${b.samples} samples` : ''}`
          : c.provenance === 'assumed' ? `an assumption: ${b.source || 'not measured'}`
            : `measured in the real world (${b.evidence || b.outcome || 'your report'})`;
    return `${c.subject} is ${v}: ${why}.`;
  };
  return { claims: latest, spoken: latest.length ? latest.slice(-4).map(line).join(' ') : `I have no recorded claim about "${clip(subject, 80)}" in this project, sir.` };
}

// ── Pre-registration ────────────────────────────────────────────────────────────────────────────
const TESTS = {
  physical: (v) => ({
    failure: { metric: 'endurance', op: '<', value: v.target_endurance, unit: 'min', text: `Measured hover endurance with the payload below ${say(v.target_endurance)} minutes.` },
    stop: `If the thrust-stand power is more than 30% above the model's prediction, stop before buying the rest of the parts and recalibrate.`,
  }),
  business: (v) => ({
    failure: { metric: 'units_month1', op: '<', value: 1, unit: 'item/month', text: 'No paying customer in the first 30 days of the pilot.' },
    stop: `No paying customer in 30 days: pivot the offer or price. Cash put in beyond the budget: stop.`,
  }),
  employment: () => ({
    failure: { metric: 'response_rate', op: '<', value: 0.04, unit: '1', text: 'Fewer than 1 reply per 25 applications after 4 weeks.' },
    stop: 'Under 1 reply per 25 applications after 4 weeks: change the résumé or the target role before sending more.',
  }),
};

/** The pre-registered tests, written once when the project enters FEASIBILITY. */
export function preregister(project, now = new Date().toISOString()) {
  if (project.preregistration) return project.preregistration;
  const v = { ...project.spec.variables };
  const success = project.spec.success_criteria[0];
  const t = TESTS[project.domain]?.(v);
  if (!success || !t) return null;
  project.preregistration = {
    recorded_at: now,
    original: { success_test: { ...success }, failure_test: t.failure, stop_rule: t.stop },
    amendments: [],
  };
  return project.preregistration;
}

/** An amendment is appended with its time and reason; the original is never changed. */
export function amendPreregistration(project, { field, text, reason }, now = new Date().toISOString()) {
  if (!project.preregistration) throw Object.assign(new Error('Nothing is pre-registered yet.'), { status: 409 });
  if (!['success_test', 'failure_test', 'stop_rule'].includes(field)) throw Object.assign(new Error('field is success_test, failure_test or stop_rule.'), { status: 400 });
  if (String(reason || '').trim().length < 3) throw Object.assign(new Error('An amendment needs a reason.'), { status: 400 });
  project.preregistration.amendments.push({ field, text: clip(text, 400), reason: clip(reason, 300), at: now });
  return project.preregistration;
}

const holds = (op, a, b) => (op === '>=' ? a >= b : op === '<=' ? a <= b : op === '<' ? a < b : op === '>' ? a > b : a === b);

/** Judges the real outcomes against the ORIGINAL pre-registered tests. null means no real result yet. */
export function judge(project) {
  const pre = project.preregistration?.original;
  if (!pre) return { success: null, failure_triggered: null, against: 'none' };
  const latest = (metric) => [...(project.outcomes || [])].reverse().find((o) => o.metric === metric);
  const s = latest(pre.success_test.metric);
  const f = latest(pre.failure_test.metric);
  return {
    against: 'original', recorded_at: project.preregistration.recorded_at, amendments: project.preregistration.amendments.length,
    success: s ? holds(pre.success_test.op, s.observed, pre.success_test.value) : null, success_outcome: s?.id || null,
    failure_triggered: f ? holds(pre.failure_test.op, f.observed, pre.failure_test.value) : null, failure_outcome: f?.id || null,
  };
}

// ── The cheapest real-world test of the riskiest assumption ──────────────────────────────────────
const EXPERIMENTS = {
  figure_of_merit: { title: 'Thrust-stand test of one motor and propeller', measures: 'hover_power', unit: 'W', steps: ['Clamp one motor and propeller to a kitchen scale behind a guard.', 'Raise throttle to the hover thrust CHE gives; read volts × amps.', 'Multiply by the number of rotors and tell CHE the watts.'], time: '2 hours' },
  drive_efficiency: null,
  specific_energy: { title: 'Weigh the battery and read its rated energy', measures: 'specific_energy', unit: 'Wh/kg', steps: ['Weigh the battery on a kitchen scale.', 'Read its rated watt-hours (or volts × amp-hours) from the label.', 'Tell CHE both; she divides.'], time: '10 minutes' },
  usable_fraction: null,
  avionics_power: { title: 'Measure the idle electrical draw', measures: 'avionics_power', unit: 'W', steps: ['Power the flight controller, radio and camera with motors off.', 'Read volts × amps.'], time: '15 minutes' },
  price: { title: 'Ask ten likely customers to pay or book at your price', measures: 'price', unit: 'USD/item', steps: ['Offer the service at your price to ten likely customers.', 'Count how many say yes or book.'], time: '1 week' },
  units_month1: { title: 'A two-week pre-booking test', measures: 'units_month1', unit: 'item/month', steps: ['Take bookings for two weeks before buying anything.', 'Double the count for a month and tell CHE.'], time: '2 weeks' },
  growth_monthly: null,
  variable_cost: { title: 'Two real quotes for the per-sale costs', measures: 'variable_cost', unit: 'USD/item', steps: ['Get two written prices for the supplies one sale uses.'], time: '2 days' },
  fixed_monthly: { title: 'Two real quotes for the monthly costs', measures: 'fixed_monthly', unit: 'USD/month', steps: ['Get two written prices for insurance and the other monthly costs.'], time: '2 days' },
  startup_cost: { title: 'Two real quotes for the start-up items', measures: 'startup_cost', unit: 'USD', steps: ['Get two written prices for each start-up item.'], time: '3 days' },
  response_rate: { title: 'Send 20 applications and count the replies after two weeks', measures: 'response_rate', unit: '1', steps: ['Send 20 applications to jobs you would take.', 'After two weeks, divide the replies by 20 and tell CHE.'], time: '2 weeks' },
  interview_rate: { title: 'Track how many replies become interviews', measures: 'interview_rate', unit: '1', steps: ['For the replies you get, count how many lead to an interview.'], time: '3 weeks' },
  offer_rate: { title: 'Two practice interviews with honest feedback', measures: 'offer_rate', unit: '1', steps: ['Ask two people in the field for a mock interview and their verdict.'], time: '1 week' },
};
EXPERIMENTS.drive_efficiency = EXPERIMENTS.figure_of_merit;
EXPERIMENTS.usable_fraction = EXPERIMENTS.specific_energy;
EXPERIMENTS.growth_monthly = EXPERIMENTS.units_month1;

/** The smallest experiment that tests the assumption the forecast depends on most (from the run's drivers). */
export function cheapestTest(run, model, now = new Date().toISOString()) {
  const drivers = run?.drivers || [];
  const pick = drivers.find((d) => EXPERIMENTS[d.input]) || null;
  if (!pick) return null;
  const e = EXPERIMENTS[pick.input];
  return {
    assumption: pick.input, name: pick.name, why: `${model.outputs.find((o) => o.id === model.primary).name} swings by ${say(pick.swing)}${unitWord(run.summary[model.primary].unit)} across this assumption's range, more than any other.`,
    title: e.title, instructions: e.steps, time: e.time, measures: e.measures, unit: e.unit,
    cost: null, cost_note: 'Uses what you have where possible; no price data source is wired for anything you would buy.',
    report_as: { route: 'outcome', metric: e.measures, unit: e.unit }, run_id: run.id, proposed_at: now,
  };
}

// ── Track record per model ─────────────────────────────────────────────────────────────────────
const trackKey = (model) => `manifest_track:${model.id}@${model.version}`;

/** Adds one predicted-vs-actual pair to the model's track record. */
export async function updateTrackRecord(storage, model, { metric, predicted, actual, project_id, outcome_id, at }) {
  if (!(predicted > 0) || !(actual > 0)) return null;
  const t = (await storage.get(trackKey(model))) || { model: model.id, version: model.version, by_metric: {} };
  const m = t.by_metric[metric] || { n: 0, sum_log: 0, sum_log2: 0, records: [] };
  const lr = Math.log(actual / predicted);
  m.n += 1;
  m.sum_log += lr;
  m.sum_log2 += lr * lr;
  m.records = [...m.records, { project_id, outcome_id, predicted, actual, at }].slice(-50);
  t.by_metric[metric] = m;
  await storage.put(trackKey(model), t);
  return t;
}

export async function loadTrackRecord(storage, model) {
  return (await storage.get(trackKey(model))) || { model: model.id, version: model.version, by_metric: {} };
}

/** The model's bias per metric: geometric mean of actual / predicted over every recorded outcome. */
export function biasOf(track) {
  return Object.fromEntries(Object.entries(track?.by_metric || {}).map(([metric, m]) => {
    const mean = m.sum_log / m.n;
    const sd = m.n > 1 ? Math.sqrt(Math.max(0, (m.sum_log2 - m.n * mean * mean) / (m.n - 1))) : null;
    return [metric, { n: m.n, factor: Number(Math.exp(mean).toPrecision(4)), sd_log: sd == null ? null : Number(sd.toPrecision(3)) }];
  }));
}

/** The correction shown beside a run's raw forecast (never replacing it). */
export function biasCorrection(run, track) {
  const bias = biasOf(track);
  const out = {};
  for (const [metric, b] of Object.entries(bias)) {
    const s = run.summary[metric];
    if (!s) continue;
    out[metric] = { n: b.n, factor: b.factor, corrected: { low: Number((s.p10 * b.factor).toPrecision(4)), likely: Number((s.p50 * b.factor).toPrecision(4)), high: Number((s.p90 * b.factor).toPrecision(4)) }, note: `This model has been ${b.factor < 1 ? 'optimistic' : 'pessimistic'} by a factor of ${b.factor} over ${b.n} real outcome${b.n === 1 ? '' : 's'}.` };
  }
  return out;
}

// ── Steps: approval gates in the execution path ────────────────────────────────────────────────
/** Starts, fails or resets a plan step. A consequential step cannot run without a recorded owner approval. */
export function setStepStatus(project, stepId, status, { now = new Date().toISOString(), note = '' } = {}) {
  const step = project.plan?.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, error: 'No such plan step.' };
  if (!['running', 'failed', 'todo'].includes(status)) return { ok: false, error: 'A step can be set running, failed or back to todo; it becomes verified only through evidence.' };
  if (step.status === 'verified') return { ok: false, error: 'A verified step stays verified.' };
  if (status === 'running') {
    if (!['EXECUTION', 'VERIFICATION'].includes(project.status)) return { ok: false, error: `Steps run only after execution is authorized (the project is at ${project.status}).` };
    if (step.approval_required && !project.authorizations.some((a) => a.step_id === step.id)) {
      return { ok: false, error: `Step ${step.id} involves ${step.consequential}; it needs your recorded approval before it can run.`, approval_required: true };
    }
  }
  step.status = status;
  step.history = [...(step.history || []), { status, at: now, note: clip(note, 200) }];
  project.updated_at = now;
  return { ok: true, step };
}

// ── Voice: briefing, weekly review, pause and stop ─────────────────────────────────────────────
/** A short briefing for one idea: stage, forecast range, blocker, pending approval with its cost, numbered options. */
export function briefing(project) {
  const lines = [`${project.title}. Stage: ${project.status}.`];
  const best = project.comparison?.rows.find((r) => r.candidate_id === project.comparison.best);
  if (best?.primary) lines.push(`Best option, ${best.name}: ${best.primary.id.replace(/_/g, ' ')} most likely ${say(best.primary.p50)}${unitWord(best.primary.unit)}, between ${say(best.primary.p10)} and ${say(best.primary.p90)} (80% range). ${best.label.charAt(0).toUpperCase()}${best.label.slice(1)}.`);
  const c = project.candidates.find((x) => x.id === project.comparison?.best);
  if (c?.feasibility?.confidence) lines.push(`Confidence: ${c.feasibility.confidence}.`);
  if (project.status === 'BLOCKED') lines.push(`Blocked: ${project.history.at(-1).reason}`);
  const pending = (project.plan?.steps || []).filter((s) => s.approval_required && !project.authorizations.some((a) => a.step_id === s.id) && s.status !== 'verified');
  if (pending[0]) lines.push(`Waiting for your approval: step ${pending[0].id.slice(1)}, ${pending[0].title}, cost ${Array.isArray(pending[0].cost_usd) ? `$${pending[0].cost_usd[0].toLocaleString('en-US')} to $${pending[0].cost_usd[1].toLocaleString('en-US')}` : 'unknown, no price data source'}.`);
  const options = [];
  if (project.first_test && !['COMPLETE', 'FAILED'].includes(project.status)) options.push(`Run the cheapest test first: ${project.first_test.title}.`);
  if (pending[0]) options.push(`Approve step ${pending[0].id.slice(1)}.`);
  if (['SIMULATION', 'PLAN'].includes(project.status)) options.push('Change a variable and rerun.');
  if (project.status === 'PLAN') options.push('Authorize execution.');
  if (project.status === 'BLOCKED' && project.paused) options.push('Resume it.');
  else if (!['COMPLETE', 'FAILED'].includes(project.status)) options.push('Pause it.');
  if (!['COMPLETE', 'FAILED'].includes(project.status)) options.push('Stop it for good (the record is kept).');
  lines.push(`Options: ${options.map((o, i) => `${i + 1}. ${o}`).join(' ')}`);
  return { spoken: lines.join(' '), options };
}

/** What changed in the last seven days, built from the records only. Generated when asked, never on a schedule. */
export function weeklyReview(projects, now = new Date().toISOString()) {
  const since = Date.parse(now) - 7 * 86400_000;
  const items = [];
  for (const p of projects) {
    const moves = p.history.filter((h) => Date.parse(h.at) >= since && h.from);
    const outcomes = (p.outcomes || []).filter((o) => Date.parse(o.at) >= since);
    const evidence = (p.evidence || []).filter((e) => e.accepted && Date.parse(e.at) >= since);
    if (!moves.length && !outcomes.length && !evidence.length) continue;
    items.push({ id: p.id, title: p.title, status: p.status, moves: moves.map((h) => `${h.from} to ${h.to}`), outcomes: outcomes.length, evidence: evidence.length });
  }
  const spoken = items.length
    ? `This week, sir: ${items.map((it, i) => `${i + 1}. ${it.title}: now ${it.status}${it.moves.length ? `, moved ${it.moves.join(', then ')}` : ''}${it.evidence ? `, ${it.evidence} piece${it.evidence === 1 ? '' : 's'} of evidence accepted` : ''}${it.outcomes ? `, ${it.outcomes} real outcome${it.outcomes === 1 ? '' : 's'} compared` : ''}.`).join(' ')}`
    : 'Nothing changed in your manifestation projects this week, sir.';
  return { since: new Date(since).toISOString(), items, spoken };
}
