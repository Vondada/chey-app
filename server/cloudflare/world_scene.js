// CHE Spatial World (owner, 2026-10-20; design: mailbox/briefs/SPATIAL-WORLD.md on che-mailbox).
// A scene is a read-only projection of real records into objects the phone draws: avatars, cards,
// the recommended path. Every object names the record it comes from (`source`) and carries a
// fact-check provenance label; an object with no record is never made. Pure: no writes, no model
// calls, the same input always gives the same scene, and `version` changes only when it does.

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function hash(value) {
  let h = 0x811c9dc5;
  const text = JSON.stringify(value);
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** The meeting's stage as the room shows it. */
export const MEETING_STAGES = Object.freeze({
  gathering: 'The team is gathering at the table.',
  drafting: 'Each agent is drafting their part.',
  cross_check: 'The agents are cross-checking each other.',
  synthesizing: 'CHE is combining the drafts into one plan.',
  complete: 'The meeting is done, with one recommended path.',
  failed: 'The meeting stopped before a plan.',
});

// A post's kind as a card, and what it is worth: every agent line is model output, never a fact.
const CARD = {
  brief: { kind: 'brief', provenance: 'owner_request', label: 'Brief' },
  draft: { kind: 'draft', provenance: 'model_output', label: 'Draft' },
  critique: { kind: 'critique', provenance: 'model_output', label: 'Cross-check' },
};

const PROVENANCE_SPOKEN = {
  owner_request: 'your request',
  model_output: 'an agent\'s output, not verified',
  che_synthesis_unverified: 'CHE\'s synthesis, not verified',
  live: 'live state',
};

/**
 * The Meeting Room for one War Room meeting (agent_runtime.js conveneMeeting). `agents` is the
 * runtime roster (agentView), for each avatar's live status. Returns the scene object.
 */
export function meetingScene(meeting, agents = []) {
  if (!meeting?.id) return null;
  const byId = new Map((agents || []).map((a) => [a.id, a]));
  const board = Array.isArray(meeting.board) ? meeting.board : [];
  const drafts = board.filter((p) => p.kind === 'draft');
  const stage = meeting.status === 'drafting' && !drafts.length ? 'gathering' : (MEETING_STAGES[meeting.status] ? meeting.status : 'drafting');
  const objects = [];
  const edges = [];

  (meeting.participants || []).forEach((p, i) => {
    const live = byId.get(p.agent_id);
    const status = live?.status || 'meeting';
    objects.push({
      id: `agent:${p.agent_id}`, kind: 'avatar', label: `${p.name}, ${p.role}`, name: p.name, role: p.role,
      status, zone: `seat:${i + 1}`, provenance: 'live',
      source: { store: 'agent_runtime.team', id: p.agent_id },
      spoken: `${p.name}, ${p.role}: ${live?.task ? clip(live.task, 80) : status}.`,
      detail: clip(p.responsibility, 300),
    });
  });

  const nameToAgent = new Map((meeting.participants || []).map((p) => [p.name, `agent:${p.agent_id}`]));
  const draftByAuthor = new Map();
  board.forEach((post, index) => {
    const card = CARD[post.kind];
    if (!card) return; // the synthesis is the recommended path below, not a card
    const id = `post:${index}`;
    const author = nameToAgent.get(post.from) || (post.from === 'CHE' ? 'che' : '');
    if (post.kind === 'draft') draftByAuthor.set(post.from, id);
    const target = post.kind === 'critique' && post.to ? draftByAuthor.get(post.to) : '';
    objects.push({
      id, kind: card.kind, label: post.kind === 'critique' && post.to ? `${post.from} → ${post.to}: ${card.label}` : `${post.from}: ${card.label}`,
      status: post.failed ? 'failed' : 'posted', zone: author ? `before:${author}` : 'table', provenance: card.provenance,
      source: { store: 'meeting.board', id: String(index) },
      text: String(post.text || ''), preview: clip(post.text, 140), author: post.from, at: post.at || '',
      spoken: `${post.from}'s ${card.label.toLowerCase()}${post.failed ? ', which failed' : ''}: ${clip(post.text, 160)}`,
    });
    if (author) edges.push({ from: id, to: author, type: 'by' });
    if (target) edges.push({ from: id, to: target, type: 'critiques' });
  });

  // Synthesis results exist only once CHE has written them; each points at the meeting record.
  for (const [field, kind, label] of [['recommendations', 'suggestion', 'Suggestion'], ['decisions', 'decision', 'Decision'], ['conflicts', 'conflict', 'Conflict']]) {
    (Array.isArray(meeting[field]) ? meeting[field] : []).forEach((text, i) => {
      objects.push({
        id: `${kind}:${i}`, kind, label: `${label} ${i + 1}`, status: 'proposed', zone: 'table', provenance: 'che_synthesis_unverified',
        source: { store: `meeting.${field}`, id: String(i) }, text: String(text), preview: clip(text, 140),
        spoken: `${label} ${i + 1}: ${clip(text, 200)}`,
      });
    });
  }
  if (String(meeting.final_plan || '').trim()) {
    objects.push({
      id: 'plan', kind: 'path', label: 'Recommended path', status: 'proposed', zone: 'center', provenance: 'che_synthesis_unverified',
      source: { store: 'meeting.final_plan', id: meeting.id }, text: String(meeting.final_plan), preview: clip(meeting.final_plan, 200),
      spoken: `The recommended path: ${clip(meeting.final_plan, 400)}`,
    });
  }

  const suggestions = objects.filter((o) => o.kind === 'suggestion').length;
  const posted = objects.filter((o) => o.kind === 'draft' || o.kind === 'critique').length;
  const names = (meeting.participants || []).map((p) => p.name);
  const spoken = [
    `${names.length} agent${names.length === 1 ? '' : 's'} at the table${names.length ? `: ${names.join(', ')}` : ''}.`,
    MEETING_STAGES[stage],
    posted ? `${posted} card${posted === 1 ? '' : 's'} on the table.` : '',
    suggestions ? `${suggestions} suggestion${suggestions === 1 ? '' : 's'}.` : '',
    meeting.final_plan ? 'One recommended path, CHE\'s synthesis, not verified.' : '',
    stage === 'failed' && meeting.error ? clip(meeting.error, 160) : '',
  ].filter(Boolean).join(' ');

  const scene = {
    scene: 'meeting', id: meeting.id, title: clip(meeting.objective, 160), objective: String(meeting.objective || ''),
    stage, progress: Number.isFinite(meeting.progress) ? meeting.progress : 0, spoken,
    objects: objects.map((o) => ({ ...o, provenance_spoken: PROVENANCE_SPOKEN[o.provenance] || o.provenance })),
    edges, updated_at: meeting.updated_at || '',
  };
  scene.version = hash([scene.stage, scene.progress, scene.objects.map((o) => [o.id, o.status, o.zone, o.text || ''])]);
  return scene;
}

// "Start a meeting with the team about X", "team meeting on X", "call a meeting about X".
// "War room" stays with the multi-AI panel it already opens.
const MEETING = /^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+|can you\s+|could you\s+|let's\s+|lets\s+)?(?:start|call|hold|have|open|begin|run)\s+(?:a\s+|the\s+)?(?:(?:team\s+)?meeting(?:\s+with\s+(?:the\s+|my\s+)?(?:team|agents|crew|office))?|team\s+meeting)(?:\s+(?:about|on|for|to discuss|to plan)\s+(.+?))?[.?!]*$/i;

/** Parses the spoken command; null when it is not one. `topic` is '' when none was named. */
export function meetingCommand(message) {
  const m = MEETING.exec(String(message || '').trim());
  if (!m) return null;
  return { topic: clip(m[1] || '', 1200) };
}

// ── Project plan (Concept-to-Plan, owner 2026-10-20; project_plan.js) ───────────────────────────
const PLAN_PROVENANCE_SPOKEN = {
  estimate: 'CHE\'s estimate, not a quote',
  derived: 'grouped by CHE from the plan',
  sourced: 'read from a public source',
  speculative: 'speculative, not available today',
  fiction: 'fiction, not real technology',
  policy: 'CHE\'s safety rule',
  owner_request: 'your request',
};

/** The plan as a scene: groups (lanes), item cards with real fields, dependency edges, speculative, safety and source objects. */
export function planScene(plan) {
  if (!plan?.id) return null;
  const src = (id) => ({ store: 'project_plans', id: `${plan.id}#${id}` });
  const objects = [];
  const edges = [];
  (plan.systems || []).forEach((system, i) => {
    objects.push({ id: `system:${system.id}`, kind: 'system', label: system.name, status: 'group', zone: `lane:${i + 1}`, provenance: 'derived', source: src(`system:${system.id}`), spoken: `${system.name}: ${system.items.length} item${system.items.length === 1 ? '' : 's'}.` });
  });
  const systemId = new Map((plan.systems || []).map((s) => [s.name, s.id]));
  for (const item of plan.items || []) {
    const b = item.cost?.balanced || [0, 0];
    objects.push({
      id: `item:${item.id}`, kind: item.kind, label: item.name, status: item.required ? 'required' : 'optional', zone: `system:${systemId.get(item.system)}`,
      provenance: 'estimate', source: src(item.id), system: item.system, purpose: item.purpose,
      size: item.size, size_label: item.size_label, complexity: item.complexity, stage: item.stage, priority: item.priority,
      per: item.per, cost: item.cost, options: item.options, effort_hours: item.effort_hours, needs: item.needs, asked: Boolean(item.asked), confidence: item.confidence,
      text: `${item.purpose}. Cheapest: ${item.options.cheapest}. Balanced: ${item.options.balanced}. Premium: ${item.options.premium}.`,
      preview: item.purpose,
      spoken: `${item.name}: ${item.purpose}. ${item.required ? 'Required' : 'Optional'}, ${item.size_label}, complexity ${item.complexity} of 5, stage ${item.stage}. Balanced option: ${item.options.balanced}, about $${b[0].toLocaleString('en-US')} to $${b[1].toLocaleString('en-US')}${item.per === 'unit' ? ' per unit' : item.per === 'month' ? ' a month' : ''}.`,
    });
    for (const need of item.needs || []) edges.push({ from: `item:${item.id}`, to: `item:${need}`, type: 'needs' });
  }
  (plan.speculative || []).forEach((s, i) => objects.push({ id: `speculative:${i}`, kind: 'speculative', label: s.name, status: s.provenance, zone: 'edge', provenance: s.provenance, source: src(`speculative:${i}`), text: s.why, preview: s.why, spoken: `${s.name}: ${s.why}.` }));
  [...(plan.safety?.excluded || []), ...(plan.safety?.notes || [])].forEach((text, i) => objects.push({ id: `safety:${i}`, kind: 'safety', label: `Safety ${i + 1}`, status: plan.safety.level, zone: 'edge', provenance: 'policy', source: src(`safety:${i}`), text, preview: clip(text, 140), spoken: text }));
  (plan.sources || []).forEach((s, i) => objects.push({ id: `source:${i}`, kind: 'source', label: s.title, status: 'read', zone: 'edge', provenance: 'sourced', source: { store: 'public_source', id: s.url }, url: s.url, text: s.text, preview: clip(s.text, 140), spoken: `${s.title}: ${clip(s.text, 200)}` }));
  const scene = {
    scene: 'plan', id: plan.id, title: plan.title, objective: plan.request, stage: plan.refused ? 'refused' : 'complete', progress: 1,
    spoken: plan.spoken, type: plan.type, type_label: plan.type_label, structure: plan.structure, structure_label: plan.structure_label,
    tiers: plan.tiers || {}, stages: plan.stages || [], complexity: plan.complexity || '', feasibility: plan.feasibility || '',
    assumptions: plan.assumptions || [], open_questions: plan.open_questions || [], next_actions: plan.next_actions || [],
    requirements: plan.requirements || [], estimate_basis: plan.estimate_basis || {}, safety_level: plan.safety?.level || 'ok',
    objects: objects.map((o) => ({ ...o, provenance_spoken: PLAN_PROVENANCE_SPOKEN[o.provenance] || o.provenance })),
    edges, updated_at: plan.created_at || '',
  };
  scene.version = hash([scene.id, scene.objects.map((o) => [o.id, o.status])]);
  return scene;
}

// ── Simulation Lab (owner 2026-10-20; sim_lab.js) ──────────────────────────────────────────────
const SIM_PROVENANCE_SPOKEN = {
  simulated: 'a simulated result, not a measurement',
  prediction: 'a mathematical prediction, not a simulation',
  measured: 'an experimental measurement',
  proven: 'a proven real-world result',
  assumption: 'an assumption of the model',
  open: 'unresolved',
  policy: 'CHE\'s safety rule',
  reference: 'a reference for the method, not read in this run',
};

/** A lab run as a scene: candidates with their uncertainty and parts, eliminations with reasons, findings, assumptions and open problems. */
export function simScene(run) {
  if (!run?.id) return null;
  const src = (id) => ({ store: 'sim_runs', id: `${run.id}#${id}` });
  const objects = [];
  for (const m of run.models || []) {
    const unit = m.model.primary.unit;
    for (const c of m.candidates) {
      objects.push({
        id: `candidate:${m.model.id}:${c.id}`, kind: 'candidate', label: `${m.model.label}: design ${c.rank}`, status: c.beyond_today.length ? 'beyond_today' : 'realistic',
        zone: `model:${m.model.id}`, provenance: 'simulated', source: src(`${m.model.id}:${c.id}`), model: m.model.id, rank: c.rank,
        params: c.params, metrics: c.metrics, primary: c.primary, cost: c.cost, feasibility: c.feasibility, score: c.score, dims: c.dims, parts: c.parts, beyond_today: c.beyond_today,
        text: `${m.model.primary.name} ${c.primary.p50} ${unit} (p10 ${c.primary.p10}, p90 ${c.primary.p90}); met every constraint in ${Math.round(c.feasibility * 100)}% of Monte Carlo runs; about $${c.cost.nominal.toLocaleString('en-US')}.`,
        preview: `${c.primary.p50} ${unit}, ${Math.round(c.feasibility * 100)}% feasible`,
        spoken: `${m.model.label}, design ${c.rank}: ${m.model.primary.name.toLowerCase()} about ${c.primary.p50} ${unit}, between ${c.primary.p10} and ${c.primary.p90}. Met every constraint in ${Math.round(c.feasibility * 100)}% of runs. About $${c.cost.nominal.toLocaleString('en-US')}.${c.beyond_today.length ? ` Needs ${c.beyond_today.join(' and ').toLowerCase()} beyond today's technology.` : ''}`,
      });
    }
    m.eliminated.forEach((e) => objects.push({
      id: `eliminated:${m.model.id}:${e.id}`, kind: 'elimination', label: e.reason, status: 'eliminated', zone: `model:${m.model.id}`, provenance: 'prediction', source: src(`${m.model.id}:eliminated:${e.id}`), count: e.count, model: m.model.id,
      text: `${e.count.toLocaleString('en-US')} designs: ${e.reason}.`, preview: `${e.count.toLocaleString('en-US')} designs`, spoken: `${e.count.toLocaleString('en-US')} designs failed: ${e.reason}.`,
    }));
    if (m.closest_miss) objects.push({ id: `closest:${m.model.id}`, kind: 'closest_miss', label: `${m.model.label}: closest miss`, status: 'infeasible', zone: `model:${m.model.id}`, provenance: 'prediction', source: src(`${m.model.id}:closest`), params: m.closest_miss.params, metrics: m.closest_miss.metrics, text: `Still fails: ${m.closest_miss.fails.join('; ')}.`, preview: 'No design met every constraint', spoken: `No design met every constraint. The closest still fails: ${m.closest_miss.fails.join('; ')}.` });
    (m.model.references || []).forEach((r, i) => objects.push({ id: `reference:${m.model.id}:${i}`, kind: 'reference', label: r.title, status: 'reference', zone: 'edge', provenance: 'reference', source: { store: 'public_source', id: r.url }, url: r.url, text: m.model.method, preview: r.url, spoken: `${r.title}: the method behind the ${m.model.label.toLowerCase()} model.` }));
  }
  (run.findings || []).forEach((f, i) => objects.push({ id: `finding:${i}`, kind: 'finding', label: `Finding ${i + 1}`, status: f.evidence, zone: 'findings', provenance: f.evidence, source: src(`finding:${i}`), text: f.text, preview: clip(f.text, 140), spoken: f.text }));
  (run.assumptions || []).forEach((a, i) => objects.push({ id: `assumption:${i}`, kind: 'assumption', label: `Assumption ${i + 1}`, status: 'assumed', zone: 'notes', provenance: 'assumption', source: src(`assumption:${i}`), text: a, preview: clip(a, 140), spoken: a }));
  (run.unresolved || []).forEach((a, i) => objects.push({ id: `unresolved:${i}`, kind: 'unresolved', label: `Open problem ${i + 1}`, status: 'open', zone: 'notes', provenance: 'open', source: src(`unresolved:${i}`), text: a, preview: clip(a, 140), spoken: a }));
  [...(run.hazard_notes || []), ...(run.safety?.excluded || []), ...(run.safety?.notes || [])].forEach((text, i) => objects.push({ id: `safety:${i}`, kind: 'safety', label: `Safety ${i + 1}`, status: run.safety?.level || 'ok', zone: 'edge', provenance: 'policy', source: src(`safety:${i}`), text, preview: clip(text, 140), spoken: text }));
  const scene = {
    scene: 'sim', id: run.id, title: run.title, objective: run.request, plan_id: run.plan_id || '', stage: run.refused ? 'refused' : 'complete', progress: 1,
    spoken: run.spoken, type: run.type || '', type_label: run.type_label || '', seed: run.seed ?? null, budget: run.budget ?? null, requested_budget: run.requested_budget ?? null,
    totals: run.totals || {}, readiness: run.readiness || {}, roadmap: run.roadmap || [], evidence_levels: run.evidence_levels || {},
    missing_capabilities: run.missing_capabilities || [], safety_level: run.safety?.level || 'ok',
    models: (run.models || []).map((m) => ({
      id: m.model.id, version: m.model.version, label: m.model.label, method: m.model.method, primary: m.model.primary, params: m.model.params,
      uncertain: m.model.uncertain, seed: m.seed, budget: m.budget, stop: m.stop, counts: m.counts, rounds: m.rounds,
    })),
    objects: objects.map((o) => ({ ...o, provenance_spoken: SIM_PROVENANCE_SPOKEN[o.provenance] || o.provenance })),
    edges: [], updated_at: run.created_at || '',
  };
  scene.version = hash([scene.id, scene.objects.map((o) => [o.id, o.status])]);
  return scene;
}
