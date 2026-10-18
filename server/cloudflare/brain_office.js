// The Office in CHE's Brain: CHE at the center, one brain per internal Office
// worker (Nova, Atlas, Mira, Knox, Sage, Lyra, Iris and any other registered
// internal worker), every worker's experience kept as Brain records with real
// attribution, and the historical recovery that fills them from every source
// CHE already has.
//
// Nothing here invents work. A worker's brain holds the tasks it was given and
// what came back, the handoffs it took part in, the skills it was taught, the
// notes it wrote, and the outcomes CHE's review recorded. External AIs (Claude,
// ChatGPT, Codex, Grok, Gemini and the rest, including temporary provider
// workers) never appear as Office worker brains. Writing these records never
// changes any model's weights; it gives CHE and her workers something to
// retrieve before they repeat the same research.

import { BRAIN_REGIONS, CheBrainStore, backfillConversations, contentHash, isSafeText, normalizeRecord, projectLegacyState } from './brain_store.js';
import { REA_DETAIL_PREFIX, REA_JOBS_KEY } from './rea_runner.js';
import { EVIDENCE_RUNS } from './trading_evidence_runner.js';

export const CHE_CORE_ID = 'che:core';
/** Names that belong to outside systems, never to an Office worker brain. */
export const EXTERNAL_AI = /^(?:claude|chatgpt|chat\s*gpt|gpt|openai|codex|gemini|google|grok|xai|cursor|copilot|mistral|anthropic|deepseek|llama|meta|perplexity)\b/i;

function clip(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

/** The permanent, internal Office roster: registered agents that are not temporary provider workers or outside AIs. */
export function internalWorkers(data = {}) {
  return asList(data.team).filter((agent) => agent && agent.id && agent.name && !agent.temporary && !EXTERNAL_AI.test(String(agent.name).trim()))
    .map((agent) => ({
      id: String(agent.id),
      name: clip(agent.name, 40),
      role: clip(agent.role || agent.title, 80),
      responsibilities: asList(agent.responsibilities).map((item) => clip(item, 160)).filter(Boolean).slice(0, 12),
      skill_ids: asList(agent.skill_ids).map(String),
      retired: Boolean(agent.retired),
      runtime_status: clip(agent.runtime_status, 20),
    }));
}

function agentIndex(workers) {
  const byId = new Map();
  const byName = new Map();
  for (const worker of workers) {
    byId.set(worker.id, worker);
    byName.set(worker.name.toLowerCase(), worker);
  }
  return { byId, byName, find: (idOrName) => byId.get(String(idOrName || '')) || byName.get(String(idOrName || '').trim().toLowerCase()) || null };
}

const DONE = new Set(['done', 'complete', 'completed', 'succeeded', 'success', 'approved', 'merged']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected', 'dead_letter']);
const LIVE = new Set(['queued', 'assigned', 'running', 'reviewing', 'waiting', 'working']);

function outcomeOf(status) {
  const value = String(status || '').toLowerCase();
  if (DONE.has(value)) return 'done';
  if (FAILED.has(value)) return 'failed';
  if (LIVE.has(value)) return 'live';
  return 'unknown';
}

// ─── Records ───────────────────────────────────────────────────────────────

export function coreRecord(workers) {
  const names = workers.filter((w) => !w.retired).map((w) => w.name);
  return {
    id: CHE_CORE_ID,
    kind: 'core',
    region: BRAIN_REGIONS.self,
    path: 'Core',
    places: [{ region: BRAIN_REGIONS.agents, path: 'CHE' }],
    title: 'CHE',
    body: `CHE is the Office Boss and the central brain. Her Office workers${names.length ? `: ${names.join(', ')}` : ' are not registered yet'}. Each worker keeps its own experience; CHE indexes all of it and coordinates what they share.`,
    source: { kind: 'office_core', workers: names },
    verification: 'owner_attested',
    links: workers.map((w) => ({ type: 'related_to', to: `agent:${w.id}` })),
  };
}

export function workerRecord(worker) {
  return {
    id: `agent:${worker.id}`,
    kind: 'worker',
    region: BRAIN_REGIONS.agents,
    path: worker.name,
    title: worker.name,
    body: [
      `${worker.name}${worker.role ? `, ${worker.role}` : ''}, an internal Office worker who reports to CHE.`,
      worker.responsibilities.length ? `Responsibilities: ${worker.responsibilities.join('; ')}.` : '',
      worker.retired ? 'Retired from the roster; the experience stays.' : '',
    ].filter(Boolean).join('\n'),
    source: { kind: 'office_worker', role: worker.role, retired: worker.retired, skills: worker.skill_ids.length },
    verification: 'owner_attested',
    links: [{ type: 'related_to', to: CHE_CORE_ID }],
  };
}

/** One task as the worker's experience: what was asked, what came back, how it was judged, who else took part. */
export function taskRecord(task, index, workLog = null) {
  const owner = index.find(task.partner_id) || index.find(task.partner_name);
  const status = clip(task.status, 30) || 'unknown';
  const outcome = outcomeOf(status);
  const handoffs = asList(task.handoffs).filter(Boolean).map((h) => ({
    from: index.find(h.from_agent_id || h.from_agent_name || h.from),
    to: index.find(h.to_agent_id || h.to_agent_name || h.to),
    at: clip(h.at, 40),
  }));
  const links = [];
  const places = [];
  if (owner) { links.push({ type: 'produced_by_agent', to: `agent:${owner.id}` }); places.push({ region: BRAIN_REGIONS.agents, path: owner.name }); }
  for (const h of handoffs) {
    if (h.to && h.to.id !== owner?.id) { links.push({ type: 'escalated_to', to: `agent:${h.to.id}` }); places.push({ region: BRAIN_REGIONS.agents, path: h.to.name }); }
    if (h.from && h.from.id !== owner?.id) { links.push({ type: 'produced_by_agent', to: `agent:${h.from.id}` }); places.push({ region: BRAIN_REGIONS.agents, path: h.from.name }); }
  }
  if (task.memory_note_id) links.push({ type: 'learned_from', to: `note:${task.memory_note_id}` });
  if (task.job_id) links.push({ type: 'related_to', to: `job:${task.job_id}` });
  const verified = task.verified_by_che === true || workLog?.verified_by_che === true;
  const body = [
    `Task: ${clip(task.task, 3000)}`,
    `Status: ${status}${verified ? ' (checked by CHE)' : ''}.`,
    task.result ? `Result: ${String(task.result).slice(0, 20_000)}` : '',
    task.error ? `Error: ${clip(task.error, 2000)}` : '',
    task.review_feedback ? `CHE's review: ${clip(task.review_feedback, 2000)}` : '',
    Number(task.revision_count) > 0 ? `Revisions: ${Number(task.revision_count)}.` : '',
    asList(task.steering).length ? `Steering from the owner: ${asList(task.steering).map((s) => clip(typeof s === 'string' ? s : s?.text || s?.note, 200)).filter(Boolean).join(' | ')}` : '',
    handoffs.length ? `Handoffs: ${handoffs.map((h) => `${h.from?.name || 'someone'} → ${h.to?.name || 'someone'}${h.at ? ` (${h.at.slice(0, 10)})` : ''}`).join('; ')}.` : '',
    asList(task.citations).length ? `Sources: ${asList(task.citations).map((c) => clip(typeof c === 'string' ? c : c?.url || c?.source, 200)).filter(Boolean).slice(0, 10).join(' ')}` : '',
  ].filter(Boolean).join('\n');
  return {
    id: `task:${task.id}`,
    kind: 'task',
    region: BRAIN_REGIONS.tasks,
    path: outcome === 'live' ? 'Active' : 'Historical',
    places,
    title: clip(task.task || task.title, 160),
    body,
    source: {
      kind: 'team_task', agent: owner?.name || clip(task.partner_name, 40), agent_id: owner?.id || '', status, outcome,
      verified_by_che: verified, source_label: clip(task.source, 40), job_id: clip(task.job_id, 80), kind_label: clip(task.kind, 40),
      collaborators: [...new Set(handoffs.flatMap((h) => [h.from?.name, h.to?.name]).filter((n) => n && n !== owner?.name))],
      updated_at: clip(task.updated_at, 40),
    },
    verification: verified ? 'verified_source' : 'unverified_reference',
    links,
    created_at: task.created_at,
  };
}

/** A handoff between two workers: real collaboration, attributed to both. */
export function handoffRecord(handoff, taskId, index) {
  const from = index.find(handoff.from_agent_id || handoff.from_agent_name || handoff.from);
  const to = index.find(handoff.to_agent_id || handoff.to_agent_name || handoff.to);
  if (!from || !to || from.id === to.id) return null;
  const at = clip(handoff.at, 40);
  return {
    id: `handoff:${clip(taskId, 80) || 'none'}:${from.id}:${to.id}:${at || 'undated'}`,
    kind: 'collaboration',
    region: BRAIN_REGIONS.agents,
    path: from.name,
    places: [{ region: BRAIN_REGIONS.agents, path: to.name }],
    title: `${from.name} handed work to ${to.name}`,
    body: `${from.name} handed ${taskId ? 'a task' : 'work'} to ${to.name}${at ? ` on ${at.slice(0, 10)}` : ''}.${handoff.reason || handoff.note ? ` Reason: ${clip(handoff.reason || handoff.note, 400)}` : ''}`,
    source: { kind: 'handoff', from: from.name, to: to.name, task_id: clip(taskId, 80) },
    verification: 'verified_source',
    links: [
      { type: 'produced_by_agent', to: `agent:${from.id}` },
      { type: 'escalated_to', to: `agent:${to.id}` },
      ...(taskId ? [{ type: 'related_to', to: `task:${taskId}` }] : []),
    ],
    created_at: at || undefined,
  };
}

/** A work-log entry whose task is no longer in the recent list: the outcome survives on its own. */
export function workLogRecord(entry, index) {
  const worker = index.find(entry.agent_id) || index.find(entry.agent);
  if (!worker) return null;
  const at = clip(entry.at, 40);
  return {
    id: `work:${worker.id}:${clip(entry.task_id, 80) || at}`,
    kind: 'work',
    region: BRAIN_REGIONS.agents,
    path: worker.name,
    places: [{ region: BRAIN_REGIONS.tasks, path: 'Historical' }],
    title: `${worker.name}: ${clip(entry.status, 20) || 'work'}${entry.verified_by_che ? ', checked by CHE' : ''}`,
    body: `${worker.name} finished a task on ${at.slice(0, 10) || 'an unknown date'} with status ${clip(entry.status, 20) || 'unknown'}${entry.verified_by_che ? ', checked by CHE' : ''}.${entry.error ? ' A failure was recorded.' : ''} The task's own record is no longer in the recent list; this outcome is what remains.`,
    source: { kind: 'agent_work_log', task_id: clip(entry.task_id, 80), status: clip(entry.status, 20), verified_by_che: Boolean(entry.verified_by_che), memory_note_id: clip(entry.memory_note_id, 120) },
    verification: entry.verified_by_che ? 'verified_source' : 'unverified_reference',
    links: [
      { type: 'produced_by_agent', to: `agent:${worker.id}` },
      ...(entry.memory_note_id ? [{ type: 'learned_from', to: `note:${entry.memory_note_id}` }] : []),
    ],
    created_at: at || undefined,
  };
}

export function skillRecord(skill, index) {
  const owners = asList(skill.assigned_agents).map((name) => index.find(name)).filter(Boolean);
  return {
    id: `skill:${skill.id}`,
    kind: 'skill',
    region: BRAIN_REGIONS.skills,
    path: owners[0]?.name || 'Office',
    places: owners.slice(1).map((w) => ({ region: BRAIN_REGIONS.skills, path: w.name })),
    title: clip(skill.name, 120),
    body: [
      `When: ${clip(skill.trigger || skill.when, 300)}`,
      ...asList(skill.steps).map((step, i) => `${i + 1}. ${clip(step, 500)}`),
      skill.notes ? `Notes: ${clip(skill.notes, 1200)}` : '',
    ].filter(Boolean).join('\n'),
    source: { kind: 'office_skill', assigned: owners.map((w) => w.name), source_label: clip(skill.source, 40) },
    verification: skill.verified === true ? 'verified_source' : 'unverified_reference',
    links: owners.map((w) => ({ type: 'produced_by_agent', to: `agent:${w.id}` })),
    created_at: skill.created_at,
  };
}

export function jobRecord(job) {
  const status = clip(job.status, 30) || 'unknown';
  return {
    id: `job:${job.id}`,
    kind: 'job',
    region: BRAIN_REGIONS.tasks,
    path: `Jobs/${clip(job.kind, 40) || 'other'}`,
    title: clip(job.title || job.prompt, 160),
    body: [
      `Kind: ${clip(job.kind, 40) || 'unknown'}. Status: ${status}. Attempts: ${Number(job.attempts) || 0}.`,
      job.prompt ? `Request: ${clip(job.prompt, 4000)}` : '',
      job.result ? `Result: ${String(job.result).slice(0, 20_000)}` : '',
      job.error ? `Error: ${clip(job.error, 2000)}` : '',
      job.dead_letter ? 'Dead-lettered: CHE stopped retrying.' : '',
    ].filter(Boolean).join('\n'),
    source: { kind: 'job', job_kind: clip(job.kind, 40), status, outcome: outcomeOf(status), dead_letter: Boolean(job.dead_letter) },
    verification: 'unverified_reference',
    created_at: job.created_at,
  };
}

function textOf(item, keys) {
  for (const key of keys) if (item?.[key]) return String(item[key]);
  return '';
}

export function genericRecord(prefix, item, { kind, region, path, titleKeys, bodyKeys, verification = 'unverified_reference' }) {
  if (!item?.id) return null;
  const title = clip(textOf(item, titleKeys), 160) || `${kind} ${item.id}`;
  const body = bodyKeys.map((key) => (item[key] == null ? '' : `${key.replace(/_/g, ' ')}: ${typeof item[key] === 'string' ? clip(item[key], 4000) : JSON.stringify(item[key]).slice(0, 4000)}`)).filter(Boolean).join('\n') || title;
  return {
    id: `${prefix}:${item.id}`, kind, region, path, title, body,
    source: { kind: prefix, status: clip(item.status, 30) },
    verification,
    created_at: item.created_at || item.at,
  };
}

/**
 * A record the Brain's secret gate refused, kept without the part that tripped it. The task text
 * stays when it is safe on its own; the result, error and review are withheld. Same id, same
 * places and links, so the worker's experience and the task's attribution survive. Null when
 * even the safe outline cannot be written.
 */
export function redactedRecord(record) {
  if (!record?.id) return null;
  const source = { ...(record.source || {}), redacted: true };
  const safeTitle = record.title && isSafeText(record.title) ? record.title : `${record.kind || 'record'} ${String(record.id).split(':').pop()}`;
  // Every line that is safe on its own stays (a task's text and status, a skill's steps, a
  // worker's other responsibilities); only the lines that tripped the gate are withheld.
  const lines = String(record.body || '').split('\n');
  const kept = lines.filter((line) => line.trim() && isSafeText(line));
  const withheld = lines.length - kept.length;
  const notice = record.kind === 'task'
    ? 'Result withheld: sensitive content; see the task history.'
    : `${withheld === 1 ? 'One line' : `${withheld} lines`} withheld: sensitive content; see the original record.`;
  const body = [...kept, notice].join('\n');
  if (!isSafeText(`${safeTitle}\n${body}`)) return null;
  return { ...record, title: safeTitle, body, source };
}

// ─── Projection ────────────────────────────────────────────────────────────

/**
 * Writes the Office into the Brain from the state blob: CHE's core, each internal worker, every
 * task with its attribution and collaboration, handoffs, work-log outcomes whose tasks have
 * scrolled off, skills, jobs, projects, goals, objectives and meetings. Skips by hash, so a
 * second run with the same data writes nothing. Returns counts per source.
 */
export function projectOfficeExperience(store, data = {}, { now } = {}) {
  if (!store.init()) return { available: false };
  const workers = internalWorkers(data);
  const index = agentIndex(workers);
  const seen = store.meta('office_hashes', {});
  const hashes = seen && typeof seen === 'object' ? seen : {};
  const counts = {};
  const considered = new Set();
  const consider = (source, record) => {
    if (!record) return;
    counts[source] = counts[source] || { inspected: 0, imported: 0, skipped: 0, refused: 0 };
    counts[source].inspected += 1;
    const candidate = normalizeRecord(record);
    if (candidate.error) return;
    considered.add(candidate.id);
    const hash = contentHash(candidate);
    if (hashes[candidate.id] === hash) { counts[source].skipped += 1; return; }
    const current = store.get(candidate.id);
    if (current?.deleted) { hashes[candidate.id] = hash; counts[source].skipped += 1; return; }
    let result = store.put(record, { origin: 'cloud', now });
    if (result.outcome === 'rejected') {
      // The secret gate refused the full record: keep what is safe under the same id and say
      // what was withheld, so the experience is counted as refused, never lost in silence.
      counts[source].refused += 1;
      const redacted = redactedRecord(record);
      result = redacted ? store.put(redacted, { origin: 'cloud', now }) : result;
    }
    if (['created', 'updated', 'merged', 'unchanged'].includes(result.outcome)) {
      hashes[candidate.id] = hash;
      if (result.outcome === 'unchanged') counts[source].skipped += 1; else counts[source].imported += 1;
    }
  };

  consider('office_core', coreRecord(workers));
  for (const worker of workers) consider('office_workers', workerRecord(worker));

  const tasks = asList(data.team_tasks).filter((t) => t?.id);
  const taskIds = new Set(tasks.map((t) => String(t.id)));
  const workLog = asList(data.agent_work_log).filter(Boolean);
  const workByTask = new Map(workLog.filter((e) => e?.task_id).map((e) => [String(e.task_id), e]));
  // The same handoff is known to the task (with its reason) and to both agents' histories: one record, the task's version first.
  const handoffs = new Map();
  for (const task of tasks) {
    consider('team_tasks', taskRecord(task, index, workByTask.get(String(task.id)) || null));
    for (const h of asList(task.handoffs).filter(Boolean)) { const record = handoffRecord(h, task.id, index); if (record && !handoffs.has(record.id)) handoffs.set(record.id, record); }
  }
  for (const agent of asList(data.team)) {
    for (const h of asList(agent?.handoff_history).filter(Boolean)) { const record = handoffRecord(h, h.task_id, index); if (record && !handoffs.has(record.id)) handoffs.set(record.id, record); }
  }
  for (const record of handoffs.values()) consider('handoffs', record);
  for (const entry of workLog) {
    if (entry?.task_id && taskIds.has(String(entry.task_id))) continue;
    consider('agent_work_log', workLogRecord(entry, index));
  }
  for (const skill of asList(data.office_skills)) if (skill?.id) consider('office_skills', skillRecord(skill, index));
  for (const job of asList(data.jobs)) if (job?.id) consider('jobs', jobRecord(job));
  for (const project of asList(data.projects)) consider('projects', genericRecord('project', project, { kind: 'project', region: BRAIN_REGIONS.projects, path: 'Projects', titleKeys: ['title', 'name', 'task', 'goal'], bodyKeys: ['summary', 'description', 'status', 'kind', 'metrics', 'result'] }));
  for (const goal of asList(data.office_goals)) consider('office_goals', genericRecord('goal', goal, { kind: 'goal', region: BRAIN_REGIONS.projects, path: 'Office goals', titleKeys: ['goal', 'title'], bodyKeys: ['goal', 'status', 'job_ids'] }));
  for (const objective of asList(data.objectives)) consider('objectives', genericRecord('objective', objective, { kind: 'objective', region: BRAIN_REGIONS.projects, path: 'Objectives', titleKeys: ['title', 'goal', 'objective', 'request'], bodyKeys: ['goal', 'status', 'summary', 'outcome', 'steps'] }));
  for (const meeting of asList(data.meetings)) consider('meetings', genericRecord('meeting', meeting, { kind: 'meeting', region: BRAIN_REGIONS.conversations, path: 'War Room', titleKeys: ['title', 'topic', 'subject'], bodyKeys: ['summary', 'decisions', 'notes', 'status', 'outcome'] }));

  // Only the ids still in the state blob keep a hash: a record that scrolled out is never
  // considered again, so its hash would only grow this row toward the storage limit.
  store.setMeta('office_hashes', Object.fromEntries(Object.entries(hashes).filter(([id]) => considered.has(id))));
  return { available: true, at: now || new Date().toISOString(), workers: workers.length, counts };
}

/** Tasks about to leave the recent list are written to the Brain first, so the window is a cache, not a ceiling. */
export function archiveTasks(store, tasks, data = {}, { now } = {}) {
  if (!store.init() || !asList(tasks).length) return 0;
  const index = agentIndex(internalWorkers(data));
  const seen = store.meta('office_hashes', {});
  const hashes = seen && typeof seen === 'object' ? seen : {};
  let written = 0;
  for (const task of tasks) {
    if (!task?.id) continue;
    const record = taskRecord(task, index);
    // Already in the Brain unchanged (the projection saw this very content): leave it, so an
    // owner's edit to the record is never overwritten by the archive step.
    const candidate = normalizeRecord(record);
    if (!candidate.error && hashes[candidate.id] === contentHash(candidate) && store.get(candidate.id) && !store.get(candidate.id).deleted) continue;
    let result = store.put(record, { origin: 'cloud', now });
    if (result.outcome === 'rejected') {
      const redacted = redactedRecord(record);
      if (redacted) result = store.put(redacted, { origin: 'cloud', now });
    }
    if (['created', 'updated', 'merged'].includes(result.outcome)) written += 1;
  }
  return written;
}

/** REA investigations and trading evidence runs live in their own storage keys; they become Brain records too. */
export async function projectInvestigations(store, storage, { now } = {}) {
  if (!store.init() || !storage?.get) return { rea: { inspected: 0, imported: 0 }, trading: { inspected: 0, imported: 0 } };
  const out = { rea: { inspected: 0, imported: 0, skipped: 0, refused: 0 }, trading: { inspected: 0, imported: 0, skipped: 0, refused: 0 } };
  // Their own hash map: the Office projection prunes office_hashes to the ids it saw, which would
  // forget these and re-write every investigation (over an owner's edit) each run.
  const seen = store.meta('investigation_hashes', {});
  const hashes = seen && typeof seen === 'object' ? seen : {};
  const considered = new Set();
  const consider = (bucket, record) => {
    if (!record) return;
    out[bucket].inspected += 1;
    const candidate = normalizeRecord(record);
    if (candidate.error) return;
    considered.add(candidate.id);
    const hash = contentHash(candidate);
    if (hashes[candidate.id] === hash || store.get(candidate.id)?.deleted) { out[bucket].skipped += 1; hashes[candidate.id] = hash; return; }
    let result = store.put(record, { origin: 'cloud', now });
    if (result.outcome === 'rejected') {
      // An investigation can quote a login page or a token in a URL: the safe outline is kept
      // under the same id and the refusal is counted, never silent.
      out[bucket].refused += 1;
      const redacted = redactedRecord(record);
      result = redacted ? store.put(redacted, { origin: 'cloud', now }) : result;
    }
    if (['created', 'updated', 'merged'].includes(result.outcome)) { out[bucket].imported += 1; hashes[candidate.id] = hash; } else if (result.outcome === 'unchanged') { out[bucket].skipped += 1; hashes[candidate.id] = hash; }
  };
  const reaJobs = asList(await storage.get(REA_JOBS_KEY).catch(() => []));
  for (const job of reaJobs) {
    if (!job?.id) continue;
    const detail = await storage.get(`${REA_DETAIL_PREFIX}${job.id}`).catch(() => null);
    const record = detail && typeof detail === 'object' ? detail : job;
    const nameOf = (t) => (t && typeof t === 'object' ? t.name || t.host || t.url || '' : t);
    const target = clip(nameOf(record.target) || nameOf(job.target), 120) || 'investigation';
    const label = (x) => (x && typeof x === 'object' ? x.name || x.title || x.label || '' : x);
    const evidence = asList(record.features).flatMap((f) => asList(f?.evidence)).length + asList(record.evidence).length;
    consider('rea', {
      id: `rea:${job.id}`,
      kind: 'investigation',
      region: BRAIN_REGIONS.rea,
      path: target,
      title: clip(record.title || job.title || `REA: ${target}`, 160),
      body: [
        `Target: ${target}. Status: ${clip(record.status || job.status, 30) || 'unknown'}.`,
        record.summary ? `Summary: ${clip(record.summary, 6000)}` : '',
        asList(record.features).length ? `Features found: ${asList(record.features).map((f) => clip(label(f), 120)).filter(Boolean).slice(0, 40).join('; ')}` : '',
        asList(record.architecture).length ? `Architecture: ${asList(record.architecture).map((a) => clip(label(a), 120)).filter(Boolean).slice(0, 20).join('; ')}` : '',
        `Evidence items: ${evidence}.`,
      ].filter(Boolean).join('\n'),
      source: { kind: 'rea_investigation', status: clip(record.status || job.status, 30), evidence_items: evidence, detail_stored: Boolean(detail) },
      verification: evidence > 0 ? 'verified_source' : 'unverified_reference',
      links: [{ type: 'result_of_experiment', to: `rea:${job.id}` }].filter(() => false),
      created_at: record.created_at || job.created_at || record.at,
    });
  }
  const runs = asList(await storage.get(EVIDENCE_RUNS).catch(() => []));
  runs.forEach((run, i) => {
    if (!run || typeof run !== 'object') return;
    // An id-less run is named by its time, never by its index, which shifts when the log is cut.
    const id = clip(run.id, 80) || clip(run.at || run.started_at || run.created_at, 40);
    if (!id) return;
    consider('trading', {
      id: `trade:${id}`,
      kind: 'experiment',
      region: BRAIN_REGIONS.trading,
      path: 'Evidence runs',
      places: [{ region: BRAIN_REGIONS.experiments, path: 'Trading' }],
      title: clip(run?.title || run?.name || `Trading evidence run ${id}`, 160),
      body: [
        `Status: ${clip(run?.status, 30) || 'unknown'}.`,
        run?.symbol ? `Market: ${clip(run.symbol, 40)}.` : '',
        run?.summary ? `Summary: ${clip(run.summary, 6000)}` : '',
        run?.result ? `Result: ${typeof run.result === 'string' ? clip(run.result, 6000) : JSON.stringify(run.result).slice(0, 6000)}` : '',
        run?.error ? `Error: ${clip(run.error, 1000)}` : '',
        'Paper or evidence run: not live money, not financial advice.',
      ].filter(Boolean).join('\n'),
      source: { kind: 'trading_evidence_run', status: clip(run?.status, 30), paper: true },
      verification: 'unverified_reference',
      created_at: run?.at || run?.started_at || run?.created_at,
    });
  });
  store.setMeta('investigation_hashes', Object.fromEntries(Object.entries(hashes).filter(([id]) => considered.has(id))));
  return out;
}

/**
 * Everything the Brain can recover from what CHE already holds, in one pass: the legacy stores,
 * the Office, the investigations and a batch of the older conversation records. Resumable: the
 * brainmem cursor and the hash maps carry across calls. Returns the recovery report, which is
 * also kept as a Brain record and in brain_meta.
 */
export async function recoverHistory(store, storage, data = {}, { library = [], batch = 500, now = new Date().toISOString() } = {}) {
  if (!store.init()) return { available: false };
  const legacy = projectLegacyState(store, data, { now, library, tasks: false });
  const office = projectOfficeExperience(store, data, { now });
  const investigations = await projectInvestigations(store, storage, { now });
  const conversations = await backfillConversations(store, storage, { batch, now });
  const flagstaffHead = storage?.get ? await storage.get('flagstaff_mailbox_head').catch(() => null) : null;
  const sources = [
    { source: 'owner memories (data.memory_records)', inspected: asList(data.memory_records).length, note: 'projected as mem: records' },
    { source: 'research notes (data.memory_notes)', inspected: asList(data.memory_notes).length, note: 'projected as note: records' },
    { source: 'lessons (data.learned_knowledge)', inspected: asList(data.learned_knowledge).length, note: 'projected as know: records' },
    { source: 'nightly reviews', inspected: asList(data.nightly_reviews).length, note: 'projected as review: records' },
    { source: 'library documents', inspected: asList(library).length, note: 'index cards as lib: records; the texts stay in the library tables' },
    { source: 'conversations (brainmem)', inspected: Number(conversations.added) || 0, note: conversations.done ? `backfill complete; ${conversations.added ?? 0} total added` : `backfill in progress; ${conversations.added ?? 0} added so far`, done: Boolean(conversations.done) },
    ...Object.entries(office.counts || {}).map(([source, c]) => ({ source, inspected: c.inspected, imported: c.imported, skipped: c.skipped, refused: c.refused || 0 })),
    { source: 'REA investigations (rea_jobs + rea_inv:*)', ...investigations.rea },
    { source: 'trading evidence runs (evidence_runs)', ...investigations.trading },
  ];
  const unavailable = [
    'Flagstaff archives: the conversations with outside AIs live on the che-mailbox branch of the repository and in the Flagstaff board; they are not stored in CHE\'s Worker, so this pass cannot import them. They are outside correspondence, not Office worker experience.' + (flagstaffHead ? ' The mailbox head pointer exists here.' : ''),
    'GitHub commits and pull requests: on GitHub, not in CHE\'s storage; coding jobs are recorded from CHE\'s own job records (jobs and the coding runtime).',
    'Conversations before brainmem existed: no copy remains in CHE\'s storage.',
    `Task records older than the recent-list window (${asList(data.team_tasks).length} kept) that were never projected: only their work-log outcome survives (agent_work_log, ${asList(data.agent_work_log).length} entries).`,
  ];
  const report = { at: now, legacy: { projected: legacy.projected, skipped: legacy.skipped }, workers: office.workers, sources, unavailable, conversations_done: Boolean(conversations.done) };
  store.setMeta('recovery_report', report);
  const day = now.slice(0, 10);
  store.put({
    id: `audit:recovery:${day}`,
    kind: 'audit',
    region: BRAIN_REGIONS.audits,
    path: 'Recovery',
    title: `Historical recovery ${day}`,
    body: [
      `Historical recovery pass on ${day}: ${sources.length} sources inspected, ${office.workers} internal Office workers.`,
      '', 'Imported this pass:',
      ...sources.map((s) => `- ${s.source}: ${s.inspected} inspected${s.imported != null ? `, ${s.imported} imported, ${s.skipped || 0} already present` : ''}${s.refused ? `, ${s.refused} with details withheld (sensitive content)` : ''}${s.note ? ` (${s.note})` : ''}`),
      ...(sources.some((s) => s.refused) ? ['', `${sources.reduce((a, s) => a + (s.refused || 0), 0)} record${sources.reduce((a, s) => a + (s.refused || 0), 0) === 1 ? '' : 's'} kept only as a safe outline: a result, summary or note named something sensitive, so that part was withheld and is counted here, not lost in silence.`] : []),
      '', 'Not recoverable from here:',
      ...unavailable.map((u) => `- ${u}`),
    ].join('\n'),
    source: { kind: 'brain_recovery', computed: true, conversations_done: Boolean(conversations.done) },
    verification: 'verified_source',
    created_at: now,
  }, { origin: 'auditor', now });
  return { available: true, ...report };
}

// ─── Views ─────────────────────────────────────────────────────────────────

/** CHE at the center and every internal worker's brain with real counts, for the Brain Room and the switcher. */
export function workerBrains(store, data = {}) {
  if (!store.init()) return { available: false, core: null, workers: [] };
  const workers = internalWorkers(data);
  const count = (region, path, kind = null) => {
    const rows = kind
      ? store.rows('SELECT COUNT(DISTINCT r.id) AS n FROM brain_records r JOIN brain_places p ON p.record_id = r.id WHERE r.deleted = 0 AND p.region = ? AND p.path = ? AND r.kind = ?', region, path, kind)
      : store.rows('SELECT COUNT(DISTINCT r.id) AS n FROM brain_records r JOIN brain_places p ON p.record_id = r.id WHERE r.deleted = 0 AND p.region = ? AND p.path = ?', region, path);
    return Number(rows[0]?.n) || 0;
  };
  const list = workers.map((worker) => {
    const place = [BRAIN_REGIONS.agents, worker.name];
    const outcomes = { done: 0, failed: 0, live: 0 };
    for (const row of store.sql.exec("SELECT r.source AS source FROM brain_records r JOIN brain_places p ON p.record_id = r.id WHERE r.deleted = 0 AND p.region = ? AND p.path = ? AND r.kind = 'task'", ...place)) {
      let source = {};
      try { source = JSON.parse(row.source || '{}'); } catch (_) { source = {}; }
      const outcome = source.outcome || 'unknown';
      if (outcome in outcomes) outcomes[outcome] += 1;
    }
    const collaborators = new Set();
    for (const row of store.sql.exec("SELECT r.source AS source FROM brain_records r JOIN brain_places p ON p.record_id = r.id WHERE r.deleted = 0 AND p.region = ? AND p.path = ? AND r.kind IN ('collaboration', 'task')", ...place)) {
      let source = {};
      try { source = JSON.parse(row.source || '{}'); } catch (_) { source = {}; }
      for (const name of [source.from, source.to, ...asList(source.collaborators)]) if (name && name !== worker.name) collaborators.add(name);
    }
    // When the worker last did something, from the work records themselves (a task's own date), never
    // the time the projection wrote them; null when only the hub record exists.
    const last = store.rows("SELECT MAX(r.created_at) AS at FROM brain_records r JOIN brain_places p ON p.record_id = r.id WHERE r.deleted = 0 AND p.region = ? AND p.path = ? AND r.kind IN ('task', 'collaboration', 'work', 'skill')", ...place)[0]?.at || null;
    return {
      id: `agent:${worker.id}`,
      agent_id: worker.id,
      name: worker.name,
      role: worker.role,
      retired: worker.retired,
      records: count(...place),
      tasks: outcomes,
      collaborations: count(...place, 'collaboration'),
      skills: count(BRAIN_REGIONS.skills, worker.name, 'skill'),
      work_outcomes: count(...place, 'work'),
      collaborators: [...collaborators].sort(),
      last_activity: last,
      // No work ever recorded: the brain is empty and says so, never "learning".
      state: count(...place) <= 1 ? 'no experience yet' : worker.runtime_status === 'working' || worker.runtime_status === 'waiting' ? 'working' : 'idle',
    };
  });
  const total = Number(store.rows('SELECT COUNT(*) AS n FROM brain_records WHERE deleted = 0')[0]?.n) || 0;
  return {
    available: true,
    core: { id: CHE_CORE_ID, name: 'CHE', records: total, workers: list.length },
    workers: list,
    excluded: asList(data.team).filter((a) => a?.name && (a.temporary || EXTERNAL_AI.test(String(a.name).trim()))).map((a) => ({ name: clip(a.name, 40), reason: a.temporary ? 'temporary provider worker' : 'outside AI' })),
  };
}
