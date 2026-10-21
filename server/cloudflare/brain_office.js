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

import {
  BRAIN_REGIONS, CheBrainStore, OUTSIDE_CORRESPONDENCE_PATH, backfillConversations, clipWords, contentHash, isSafeText, normalizeRecord,
  projectLegacyState, relabelFlagstaffExchanges,
} from './brain_store.js';
import { hasGitHubMailbox, listMailboxFiles, normalizePeer, readMailboxFile } from './mailbox.js';
import { FREE_ENGINES, consultIntent } from './ai_consult.js';
import { withoutProhibitions } from './owner_action_gate.js';
import { redactSecrets } from './privacy_policy.js';
import { REA_DETAIL_PREFIX, REA_JOBS_KEY } from './rea_runner.js';
import { isSafeMemoryText, redactBrainText } from './research_memory.js';
import { redactSensitive } from './self_skills.js';
import { EVIDENCE_RUNS } from './trading_evidence_runner.js';
import { readArchive as readFlagstaffArchive } from './web_mailbox.js';

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
const LIVE = new Set(['queued', 'assigned', 'running', 'reviewing', 'review_pending', 'needs_review', 'waiting', 'working', 'blocked']);

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
  const kind = String(record.kind || 'record');
  // Names and labels in the source (agent, kind_label, collaborators) can be what tripped the gate:
  // then only the bare keys stay, and the path falls back to the kind.
  let source = { ...(record.source || {}), redacted: true };
  if (!isSafeText(JSON.stringify(source))) {
    source = { ...(source.kind ? { kind: source.kind } : {}), ...(source.agent_id ? { agent_id: source.agent_id } : {}), ...(source.status ? { status: source.status } : {}), ...(source.outcome ? { outcome: source.outcome } : {}), redacted: true, source_withheld: true };
  }
  const path = record.path && isSafeText(String(record.path)) ? record.path : kind;
  const safeTitle = record.title && isSafeText(record.title) ? record.title : `${kind} ${String(record.id).split(':').pop()}`;
  // A labelled field ("Result: …") and its continuation lines are one unit. When any line of a unit
  // trips the gate the whole unit is withheld: a value never survives its label ("Password:" on one
  // line, the password on the next), and a JSON or multi-line result goes as a whole.
  const units = [];
  for (const line of String(record.body || '').split('\n')) {
    if (!units.length || /^[A-Z][A-Za-z'’ ]{0,40}:/.test(line)) units.push([line]); else units[units.length - 1].push(line);
  }
  const kept = [];
  let withheld = 0;
  for (const unit of units) {
    const lines = unit.filter((line) => line.trim());
    if (!lines.length) continue;
    if (lines.every((line) => isSafeText(line)) && isSafeText(lines.join('\n'))) kept.push(...lines); else withheld += 1;
  }
  const notice = kind === 'task'
    ? 'Result withheld: sensitive content; see the task history.'
    : `${withheld === 1 ? 'One part' : `${withheld} parts`} withheld: sensitive content; see the original record.`;
  const body = [...kept, notice].join('\n');
  const places = asList(record.places).filter((place) => place && isSafeText(`${place.region || ''} ${place.path || ''}`));
  const links = asList(record.links).filter((link) => link && isSafeText(JSON.stringify(link)));
  if (!isSafeText(`${safeTitle}\n${body}\n${path}\n${JSON.stringify(places)}\n${JSON.stringify(source)}\n${JSON.stringify(links)}`)) return null;
  return { ...record, title: safeTitle, body, path, source, places, links };
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
    counts[source] = counts[source] || { inspected: 0, imported: 0, skipped: 0, refused: 0, dropped: 0 };
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
      const redacted = redactedRecord(record);
      result = redacted ? store.put(redacted, { origin: 'cloud', now }) : result;
      // Counted as refused only when the outline is really in the Brain; otherwise dropped, said so
      // in the report, and remembered so the same record is not refused again every pass.
      if (['created', 'updated', 'merged', 'unchanged'].includes(result.outcome)) counts[source].refused += 1;
      else { counts[source].dropped += 1; hashes[candidate.id] = hash; }
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
  const out = { rea: { inspected: 0, imported: 0, skipped: 0, refused: 0, dropped: 0 }, trading: { inspected: 0, imported: 0, skipped: 0, refused: 0, dropped: 0 } };
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
      const redacted = redactedRecord(record);
      result = redacted ? store.put(redacted, { origin: 'cloud', now }) : result;
      if (['created', 'updated', 'merged', 'unchanged'].includes(result.outcome)) out[bucket].refused += 1;
      else { out[bucket].dropped += 1; hashes[candidate.id] = hash; }
    }
    if (['created', 'updated', 'merged'].includes(result.outcome)) { out[bucket].imported += 1; hashes[candidate.id] = hash; } else if (result.outcome === 'unchanged') { out[bucket].skipped += 1; hashes[candidate.id] = hash; }
  };
  const reaJobs = asList(await storage.get(REA_JOBS_KEY).catch(() => []));
  for (const job of reaJobs) {
    if (!job?.id) continue;
    const detail = await storage.get(`${REA_DETAIL_PREFIX}${job.id}`).catch(() => null);
    const record = detail && typeof detail === 'object' ? detail : job;
    // A website target is named by its host, never by a URL that may carry a reset token or a session id.
    const hostOf = (url) => { try { return new URL(String(url)).host; } catch (_) { return ''; } };
    const nameOf = (t) => (t && typeof t === 'object' ? t.name || t.label || t.host || hostOf(t.url) || '' : t);
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
  // Flagstaff replies the backfill once filed as the owner's conversations; the mailbox itself is
  // imported only when the owner asks (importOutsideCorrespondence), and its last report is read here.
  const relabeled = relabelFlagstaffExchanges(store, { now });
  const outside = correspondenceStatus(store);
  const lastImport = outside.last_import;
  const sources = [
    { source: 'owner memories (data.memory_records)', inspected: asList(data.memory_records).length, note: 'projected as mem: records' },
    { source: 'research notes (data.memory_notes)', inspected: asList(data.memory_notes).length, note: 'projected as note: records' },
    { source: 'lessons (data.learned_knowledge)', inspected: asList(data.learned_knowledge).length, note: 'projected as know: records' },
    { source: 'nightly reviews', inspected: asList(data.nightly_reviews).length, note: 'projected as review: records' },
    { source: 'library documents', inspected: asList(library).length, note: 'index cards as lib: records; the texts stay in the library tables' },
    { source: 'conversations (brainmem)', inspected: Number(conversations.added) || 0, note: conversations.done ? `backfill complete; ${conversations.added ?? 0} total added` : `backfill in progress; ${conversations.added ?? 0} added so far`, done: Boolean(conversations.done) },
    ...Object.entries(office.counts || {}).map(([source, c]) => ({ source, inspected: c.inspected, imported: c.imported, skipped: c.skipped, refused: c.refused || 0, dropped: c.dropped || 0 })),
    { source: 'REA investigations (rea_jobs + rea_inv:*)', ...investigations.rea },
    { source: 'trading evidence runs (evidence_runs)', ...investigations.trading },
    ...(lastImport ? [{
      source: 'Flagstaff mailbox (che-mailbox branch and the board archive)',
      inspected: lastImport.totals?.messages || 0, imported: (lastImport.totals?.imported || 0) + (lastImport.totals?.updated || 0), skipped: lastImport.totals?.skipped || 0,
      refused: lastImport.totals?.withheld || 0, dropped: lastImport.totals?.dropped || 0,
      note: `outside correspondence, never owner memories or Office worker experience; ${outside.messages} in the Brain; counts from the import of ${String(lastImport.at || '').slice(0, 16).replace('T', ' ')} UTC${lastImport.done ? '' : ', not finished'}`,
    }] : []),
    ...(outside.exchanges || relabeled ? [{ source: 'Flagstaff replies CHE remembered (brainmem)', inspected: outside.exchanges, note: `labeled outside correspondence${relabeled ? `; ${relabeled} relabeled this pass from the owner's conversations` : ''}` }] : []),
  ];
  const unavailable = [
    ...(lastImport ? [] : ['Flagstaff mailbox: not imported yet. The che-mailbox branch is read only when the owner says "import the Flagstaff history"; its messages come in as outside correspondence, never as owner memories or Office worker experience.']),
    'GitHub commits and pull requests: on GitHub, not in CHE\'s storage; coding jobs are recorded from CHE\'s own job records (jobs and the coding runtime).',
    'Conversations before brainmem existed: no copy remains in CHE\'s storage.',
    `Task records older than the recent-list window (${asList(data.team_tasks).length} kept) that were never projected: only their work-log outcome survives (agent_work_log, ${asList(data.agent_work_log).length} entries).`,
  ];
  const report = { at: now, legacy: { projected: legacy.projected, skipped: legacy.skipped }, workers: office.workers, sources, unavailable, conversations_done: Boolean(conversations.done), outside_correspondence: { messages: outside.messages, by_sender: outside.by_sender, exchanges: outside.exchanges, relabeled, last_import: lastImport?.at || null } };
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
      ...sources.map((s) => `- ${s.source}: ${s.inspected} inspected${s.imported != null ? `, ${s.imported} imported, ${s.skipped || 0} already present` : ''}${s.refused ? `, ${s.refused} with details withheld (sensitive content)` : ''}${s.dropped ? `, ${s.dropped} dropped (not storable even as an outline)` : ''}${s.note ? ` (${s.note})` : ''}`),
      ...(sources.some((s) => s.refused) ? ['', `${sources.reduce((a, s) => a + (s.refused || 0), 0)} record${sources.reduce((a, s) => a + (s.refused || 0), 0) === 1 ? '' : 's'} kept only as a safe outline: a result, summary or note named something sensitive, so that part was withheld and is counted here, not lost in silence.`] : []),
      ...(sources.some((s) => s.dropped) ? ['', `${sources.reduce((a, s) => a + (s.dropped || 0), 0)} record${sources.reduce((a, s) => a + (s.dropped || 0), 0) === 1 ? '' : 's'} dropped: not even a safe outline could be stored. The original stays in its own history (task list, REA job or trading run); nothing is claimed as kept.`] : []),
      '', 'Not recoverable from here:',
      ...unavailable.map((u) => `- ${u}`),
    ].join('\n'),
    source: { kind: 'brain_recovery', computed: true, conversations_done: Boolean(conversations.done) },
    verification: 'verified_source',
    created_at: now,
  }, { origin: 'auditor', now });
  return { available: true, ...report };
}

// ─── Outside correspondence (Flagstaff) ────────────────────────────────────
//
// The Flagstaff mailbox is the che-mailbox branch (mailbox/*.jsonl and mailbox/archive/*.jsonl)
// plus the web board's locked sessions in CHE's own storage. Every message there becomes one
// Brain record of outside correspondence: what another AI wrote (or what CHE wrote to it), with
// its file, message id, sender, recipient and time. It is advice, never an order; never the
// owner's words, so "what did I tell you" never reads it; and never an Office worker's experience,
// so it has its own folder, kind and verification label.

export const CORRESPONDENCE_KIND = 'correspondence';
const CORRESPONDENCE_CURSOR = 'correspondence_cursor';
const CORRESPONDENCE_REPORT = 'correspondence_import';
const MAX_MESSAGE_CHARS = 60_000;
const PEER_LABELS = {
  claude: 'Claude', chatgpt: 'ChatGPT', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor', copilot: 'Copilot', grok: 'Grok',
  opencode: 'OpenCode', che: 'CHE', 'che-autopilot': 'CHE autopilot', flagstaff369: 'the Flagstaff board', unknown: 'an unnamed sender',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function peerLabel(peer) {
  const id = String(peer || '');
  return PEER_LABELS[id] || id.replace(/^\w/, (c) => c.toUpperCase()) || 'an unnamed sender';
}

function spokenDate(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'an unknown date';
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Words that hand over access, though no key word is said: "credentials …", "the login is …",
// "… gets you in". In outside mail a sentence like that is withheld whole.
const ACCESS_WORDS = /\b(?:credentials?|passphrase|pass\s*word|user\s*name|log\s*-?\s*in|sign\s*-?\s*in|signin)\b|\b(?:gets?|lets?|will\s+get|will\s+let)\s+(?:you|me|him|her|them|us|anyone|someone|che)\s+(?:in|into)\b/i;
const WITHHELD = '[withheld: sensitive content]';

/**
 * A message's words with every secret-looking part withheld. Multi-line secrets go first and whole:
 * a private key block from BEGIN to END, and a JWT with every one of its segments wherever they
 * appear, so no line of one survives the line split. Token shapes are then scrubbed
 * (privacy_policy.redactSecrets), and each sentence is left out, marked and counted when the memory
 * gate refuses it (research_memory.isSafeMemoryText: key and code words, broker keys, user:password
 * pairs, password-like tokens), when it looks like a token or a private key
 * (self_skills.redactSensitive), or when it hands over access (ACCESS_WORDS). The rest keeps its words.
 */
export function redactCorrespondence(text) {
  let withheld = 0;
  let value = String(text ?? '').replace(/\u0000/g, '');
  value = value.replace(/-----BEGIN [A-Z0-9 ]{3,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{3,40}-----|$)/g, () => { withheld += 1; return WITHHELD; });
  const segments = new Set();
  value = value.replace(/\beyJ[A-Za-z0-9_-]{8,}(?:(?:\.|[ \t]*\n\s*\.|\.[ \t]*\n\s*)[A-Za-z0-9_-]{8,}){0,2}/g, (jwt) => {
    for (const piece of jwt.split(/\s*\.\s*/)) if (piece.length >= 8) segments.add(piece);
    withheld += 1;
    return WITHHELD;
  });
  for (const piece of segments) value = value.split(piece).join(WITHHELD);
  const scrubbed = redactSecrets(value);
  withheld += Math.max(0, (scrubbed.match(/\[redacted\]/g) || []).length - (value.match(/\[redacted\]/g) || []).length);
  const lines = scrubbed.split('\n').map((line) => {
    if (!line.trim()) return '';
    let dropped = 0;
    // Sentences end at punctuation followed by a space, so a link, an address or a file name stays whole.
    const kept = line.split(/(?<=[.!?;|])\s+/).map((sentence) => `${sentence} `).filter((sentence) => {
      if (!sentence.trim() || sentence.trim() === WITHHELD) return true;
      // redactSensitive reads any 32-character run as a token; ids and paths are not (a commit, a
      // message UUID, a file path), and a real token among them still trips isSafeMemoryText.
      const forTokens = sentence.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{7,64}\b/gi, 'id').replace(/(?:[\w.-]+\/)+[\w.-]+/g, 'path');
      if (isSafeMemoryText(sentence) && !redactSensitive(forTokens).removed && !ACCESS_WORDS.test(sentence)) return true;
      dropped += 1;
      return false;
    });
    withheld += dropped;
    const out = kept.join('').trim();
    return dropped ? `${out}${out ? ' ' : ''}${WITHHELD}` : out;
  });
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), withheld };
}

// SHA-256 keeps externally authored IDs out of primary keys, including the ID-less fallback.
// Synchronous because Brain record projection and reply links are synchronous.
const MAIL_HASH_K = [];
const MAIL_HASH_INITIAL = [];
for (let n = 2; MAIL_HASH_K.length < 64; n += 1) {
  let prime = true;
  for (let d = 2; d * d <= n; d += 1) if (n % d === 0) { prime = false; break; }
  if (prime) {
    if (MAIL_HASH_INITIAL.length < 8) MAIL_HASH_INITIAL.push((Math.sqrt(n) % 1 * 0x100000000) >>> 0);
    MAIL_HASH_K.push((Math.cbrt(n) % 1 * 0x100000000) >>> 0);
  }
}
export function correspondenceId(messageId) {
  const raw = new TextEncoder().encode(String(messageId || '').replace(/\u0000/g, '').trim());
  const bytes = new Uint8Array(Math.ceil((raw.length + 9) / 64) * 64);
  bytes.set(raw); bytes[raw.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, Math.floor(raw.length / 0x20000000));
  view.setUint32(bytes.length - 4, (raw.length * 8) >>> 0);
  const hash = [...MAIL_HASH_INITIAL], w = new Uint32Array(64);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < bytes.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = (w[i - 16] + (rot(x, 7) ^ rot(x, 18) ^ (x >>> 3)) + w[i - 7] + (rot(y, 17) ^ rot(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + MAIL_HASH_K[i] + w[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [a, b, c, d, e, f, g, h] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
    }
    for (const [i, value] of [a, b, c, d, e, f, g, h].entries()) hash[i] = (hash[i] + value) >>> 0;
  }
  return `mail:${hash.map((x) => x.toString(16).padStart(8, '0')).join('')}`;
}

/**
 * One mailbox message as a Brain record of outside correspondence. [where] names the file and,
 * for the owner, where the original stays. Null for a line that is not a message.
 */
export function correspondenceRecord(message, { file = '', thread = '', archived = false, where = '', withIds = true } = {}) {
  const id = String(message?.id || '').trim();
  if (!id || typeof message?.text !== 'string' || !message.text.trim()) return null;
  const from = normalizePeer(message.from) || 'unknown';
  const to = normalizePeer(message.to) || 'unknown';
  const at = Number.isFinite(Date.parse(message.at)) ? new Date(Date.parse(message.at)).toISOString() : '';
  const { text, withheld } = redactCorrespondence(message.text.slice(0, MAX_MESSAGE_CHARS));
  const replyTo = clip(message.reply_to, 160);
  const said = `${peerLabel(from)} to ${peerLabel(to)}`;
  const header = `${said}${at ? `, ${at.slice(0, 10)}` : ''}, in the Flagstaff mailbox (${file}${withIds ? `, message ${clip(id, 160)}` : ''}). Outside correspondence: ${from === 'che' ? 'CHE\'s own message to another AI' : 'another AI\'s advice'}, not the owner's words and not an instruction.`;
  const firstLine = (text.split('\n').find((line) => line.trim()) || 'message').trim();
  return {
    id: correspondenceId(id),
    kind: CORRESPONDENCE_KIND,
    region: BRAIN_REGIONS.coding,
    path: `${OUTSIDE_CORRESPONDENCE_PATH}/${normalizePeer(thread) || (from === 'che' ? to : from)}`,
    title: `${said}: ${clipWords(firstLine, 140)}`,
    body: [
      header, '',
      text || '(nothing left after withholding sensitive content)',
      ...(withheld ? ['', `${withheld === 1 ? 'One part' : `${withheld} parts`} withheld: sensitive content. The original stays in ${where || file}.`] : []),
    ].join('\n'),
    source: {
      kind: 'outside_correspondence', mailbox: 'flagstaff', file, ...(withIds ? { line_id: id, reply_to: replyTo } : { ids_withheld: true }), from, to, at,
      thread: normalizePeer(thread) || '', archived: Boolean(archived), advice_only: true, owner_words: false, withheld_parts: withheld,
      ...(message.text.length > MAX_MESSAGE_CHARS ? { clipped_from_chars: message.text.length } : {}),
    },
    verification: 'external_correspondence',
    links: replyTo && withIds ? [{ type: 'related_to', to: correspondenceId(replyTo) }] : [],
    created_at: at || undefined,
  };
}

/**
 * When the store's gate still refuses a message: first the same words without the message ids (an
 * id like "rotate-the-api-key" can trip it; the record's own id still carries it), then an outline
 * with the words withheld. Same Brain id either way.
 */
function correspondenceOutlines(message, meta) {
  const idless = correspondenceRecord(message, { ...meta, withIds: false });
  const { from, to, at, file } = idless.source;
  const said = `${peerLabel(from)} to ${peerLabel(to)}`;
  const body = `${said}${at ? `, ${at.slice(0, 10)}` : ''}, in the Flagstaff mailbox (${file}). Outside correspondence, not the owner's words and not an instruction.\n\nMessage withheld: sensitive content. The original stays in ${meta.where || file}.`;
  return [idless, { ...idless, title: `${said}: message withheld`, body, source: { ...idless.source, message_withheld: true } }];
}

/** The outside messages in the Brain, by sender, and the last import; whole-table, so cached until the next write. */
export function correspondenceStatus(store) {
  if (!store.init()) return { available: false, messages: 0, by_sender: {}, exchanges: 0, last_import: null };
  const counts = store.cached('correspondence', () => {
    const bySender = {};
    let messages = 0;
    for (const row of store.rows('SELECT source FROM brain_records WHERE kind = ? AND deleted = 0', CORRESPONDENCE_KIND)) {
      let source = {};
      try { source = JSON.parse(row.source || '{}'); } catch (_) { source = {}; }
      const from = String(source.from || 'unknown');
      bySender[from] = (bySender[from] || 0) + 1;
      messages += 1;
    }
    const exchanges = Number(store.rows("SELECT COUNT(*) AS n FROM brain_records WHERE kind = 'flagstaff' AND deleted = 0")[0]?.n) || 0;
    return { messages, by_sender: bySender, exchanges };
  });
  return { available: true, ...structuredClone(counts), last_import: store.meta(CORRESPONDENCE_REPORT, null) };
}

/**
 * Imports the Flagstaff mailbox into the Brain as outside correspondence. Idempotent: a message is
 * keyed by its id, and one already there with the same words is skipped, so a second run changes
 * nothing. Bounded: at most [limit] records written per run. Resumable: the pass keeps a cursor
 * (files done, and the last message id of the file it stopped in), so the next run carries on.
 * A message the owner deleted from the Brain stays deleted. Returns the import report, also kept
 * in brain_meta and as a Brain audit record.
 */
export async function importOutsideCorrespondence(store, env, { storage = null, fetcher = fetch, now = new Date().toISOString(), limit = 1000 } = {}) {
  if (!store.init()) return { available: false, reason: 'Brain storage is not available.' };
  const budget = Math.max(1, Math.min(Number(limit) || 1000, 2000));
  const relabeled = relabelFlagstaffExchanges(store, { now });
  const connected = hasGitHubMailbox(env);
  const files = [];
  const errors = [];
  const seen = new Set();
  let written = 0;
  let stopped = '';

  // One batch of messages from one file: stored hashes are read 90 ids at a time (the Durable
  // Object's bound-parameter limit). Returns the id it stopped after when the budget ran out.
  const consider = (messages, meta, stats) => {
    const items = [];
    for (const message of messages) {
      const record = correspondenceRecord(message, meta);
      if (record) items.push({ message, record }); else stats.not_messages += 1;
    }
    const stored = new Map();
    const ids = items.map((item) => item.record.id);
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      for (const row of store.rows(`SELECT id, hash, deleted FROM brain_records WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) stored.set(row.id, row);
    }
    let last = '';
    for (const { message, record } of items) {
      stats.messages += 1;
      const existing = stored.get(record.id);
      if (seen.has(record.id) || (meta.fillOnly && existing)) { stats.skipped += 1; last = record.id; continue; }
      seen.add(record.id);
      if (existing && Number(existing.deleted) === 1) { stats.deleted_by_owner += 1; last = record.id; continue; }
      if (existing && existing.hash === contentHash(normalizeRecord(record))) { stats.skipped += 1; last = record.id; continue; }
      if (written >= budget) { stats.messages -= 1; return { stoppedAfter: last }; }
      let result = store.put(record, { origin: 'cloud', now });
      let outline = false;
      if (result.outcome === 'rejected') {
        const alternatives = correspondenceOutlines(message, meta);
        for (let i = 0; i < alternatives.length; i += 1) {
          result = store.put(alternatives[i], { origin: 'cloud', now });
          // The second alternative withholds the words: counted as withheld, never as whole.
          if (result.outcome !== 'rejected') { outline = i === 1; break; }
        }
      }
      last = record.id;
      if (result.outcome === 'created') stats.imported += 1;
      else if (result.outcome === 'updated' || result.outcome === 'merged') stats.updated += 1;
      else if (result.outcome === 'unchanged' || result.outcome === 'deleted') { stats.skipped += 1; continue; }
      else { stats.dropped += 1; continue; }
      written += 1;
      if (outline || record.source.withheld_parts) stats.withheld += 1;
    }
    return {};
  };
  const blank = (path) => ({ path, lines: 0, messages: 0, imported: 0, updated: 0, skipped: 0, withheld: 0, dropped: 0, not_messages: 0, deleted_by_owner: 0 });

  let listing = null;
  if (connected) {
    listing = await listMailboxFiles(env, fetcher).catch((error) => ({ error: `Mailbox read failed (${clip(error?.message || error, 160)}).`, files: [], head: '' }));
    if (listing.error) errors.push(listing.error);
  }
  const head = listing && !listing.error ? listing.head : '';
  const noBranch = Boolean(listing && !listing.error && !listing.head);
  let pass = store.meta(CORRESPONDENCE_CURSOR, null);
  // Nothing moved on the branch since a finished pass: no file is read again.
  const upToDate = Boolean(head && pass?.done && pass.head === head);
  if (head && !upToDate) {
    if (!pass || pass.done || !Array.isArray(pass.files_done)) pass = { head, started_at: now, files_done: [], current: null, done: false };
    for (const file of listing.files) {
      if (pass.files_done.includes(file.path)) continue;
      const read = await readMailboxFile(env, file.path, fetcher, head)
        .catch((error) => ({ error: `Mailbox read failed (${clip(error?.message || error, 160)}).`, messages: [], lines: 0 }));
      const stats = blank(file.path);
      stats.lines = Number(read.lines) || 0;
      if (read.error) { stats.error = read.error; errors.push(`${file.path}: ${read.error}`); files.push(stats); continue; }
      // Lines that parse but are not messages (the autopilot's activity log) count as not messages too.
      stats.not_messages = Math.max(0, stats.lines - read.messages.length);
      const resumeAt = pass.current?.path === file.path && pass.current.after_id ? read.messages.findIndex((m) => correspondenceId(m?.id) === pass.current.after_id) : -1;
      const out = consider(read.messages.slice(resumeAt + 1), { file: file.path, thread: file.thread, archived: file.archive, where: `${file.path} on the che-mailbox branch` }, stats);
      files.push(stats);
      if (out.stoppedAfter !== undefined) {
        pass.current = { path: file.path, after_id: out.stoppedAfter || (resumeAt >= 0 ? pass.current.after_id : '') };
        stopped = file.path;
        break;
      }
      pass.files_done.push(file.path);
      pass.current = null;
      store.setMeta(CORRESPONDENCE_CURSOR, pass);
    }
    // A pass is finished only when every file was read in full; its head is the one it started
    // from, so messages added to an earlier file while it ran are picked up by the next pass.
    if (!stopped && !errors.length && !listing.more) pass.done = true;
    store.setMeta(CORRESPONDENCE_CURSOR, pass);
  }
  // The web board's locked sessions in CHE's own storage. The GitHub copy of a message wins; these
  // only add messages GitHub never had (a board used while GitHub was not connected).
  if (storage && !stopped) {
    const sessions = await readFlagstaffArchive(storage).catch(() => []);
    const stats = blank('CHE’s Flagstaff board archive');
    for (const session of asList(sessions).slice(-200)) {
      const out = consider(asList(session?.messages).filter(Boolean), { file: `flagstaff_archive/${clip(session?.id, 60)}`, thread: '', archived: true, fillOnly: true, where: 'CHE’s Flagstaff board archive' }, stats);
      if (out.stoppedAfter !== undefined) { stopped = stats.path; break; }
    }
    if (stats.messages || stats.not_messages) files.push(stats);
  }

  const totals = blank('all');
  delete totals.path;
  for (const file of files) for (const key of Object.keys(totals)) totals[key] += Number(file[key]) || 0;
  const status = correspondenceStatus(store);
  const report = {
    available: true, at: now, connected, head, up_to_date: upToDate, no_branch: noBranch,
    done: connected && !errors.length && (upToDate || noBranch || Boolean(pass?.done)),
    stopped_at: stopped, budget, files_read: files.filter((f) => !f.error).length, files, totals, errors, relabeled,
    in_brain: status.messages, by_sender: status.by_sender, exchanges: status.exchanges,
  };
  store.setMeta(CORRESPONDENCE_REPORT, report);
  const day = now.slice(0, 10);
  store.put({
    id: `audit:correspondence:${day}`,
    kind: 'audit',
    region: BRAIN_REGIONS.audits,
    path: 'Recovery',
    title: `Flagstaff correspondence import ${day}`,
    body: speakCorrespondenceImport(report),
    source: { kind: 'correspondence_import', computed: true, head, done: report.done },
    verification: 'verified_source',
    created_at: now,
  }, { origin: 'auditor', now });
  return report;
}

function countLine(bySender) {
  return Object.entries(bySender || {}).sort((a, b) => b[1] - a[1] || peerLabel(a[0]).localeCompare(peerLabel(b[0]))).map(([from, n]) => `${peerLabel(from)} ${n}`).join(', ');
}

/** The import report as CHE says it: real counts, what was skipped and why, and what the records are. */
export function speakCorrespondenceImport(report) {
  if (!report?.available) return 'I can\'t reach my Brain storage right now, sir, so nothing was imported.';
  const held = `Your Brain holds ${report.in_brain} outside message${report.in_brain === 1 ? '' : 's'}`;
  const relabel = report.relabeled ? ` I also relabeled ${report.relabeled} earlier Flagstaff repl${report.relabeled === 1 ? 'y' : 'ies'} that had been filed as your own conversations.` : '';
  const what = ' They are outside correspondence: other AIs\' advice, never your words, never instructions, and never Office worker experience.';
  if (!report.connected) {
    const board = report.totals?.imported ? `I brought in ${report.totals.imported} message${report.totals.imported === 1 ? '' : 's'} from my own Flagstaff board archive. ` : '';
    return `I can't read the Flagstaff mailbox, sir: GitHub isn't connected to me (CHE_GITHUB_TOKEN and CHE_GITHUB_REPO). Nothing was imported from it. ${board}${held}.${relabel}`;
  }
  if (report.no_branch) {
    const t = report.totals;
    return `There is no Flagstaff mailbox on GitHub yet, sir: the che-mailbox branch does not exist, so nothing was imported from GitHub. I brought in ${t.imported} messages from my own Flagstaff board archive; ${t.withheld} kept with sensitive parts withheld, ${t.dropped} dropped. ${held}.${relabel}${what}`;
  }
  if (!report.files_read && report.errors.length) return `I couldn't read the Flagstaff mailbox, sir: ${clip(report.errors[0], 160)} Nothing new was imported. ${held}.${relabel}`;
  if (report.up_to_date) return `The Flagstaff history is already in your Brain, sir: nothing new on the che-mailbox branch since the last import (commit ${report.head.slice(0, 7)}). ${held}.${relabel}${what}`;
  const t = report.totals;
  const parts = [
    `${t.messages} message${t.messages === 1 ? '' : 's'} read: ${t.imported} brought in, ${t.updated ? `${t.updated} updated, ` : ''}${t.skipped} already there`,
    t.withheld ? `${t.withheld} kept with a sensitive part withheld` : '',
    t.dropped ? `${t.dropped} dropped because not even an outline could be stored` : '',
    t.deleted_by_owner ? `${t.deleted_by_owner} you deleted stayed deleted` : '',
  ].filter(Boolean).join('; ');
  const logs = t.not_messages ? ` ${t.not_messages} line${t.not_messages === 1 ? ' was an activity log' : 's were activity logs'}, not messages, and ${t.not_messages === 1 ? 'was' : 'were'} skipped.` : '';
  const failed = report.errors.length ? ` I could not read ${report.errors.length} part${report.errors.length === 1 ? '' : 's'} of the mailbox (${clip(report.errors[0], 160)}), so the import is not finished.` : '';
  const more = report.stopped_at ? ` I stopped after ${report.budget} records to keep this pass bounded; say "import the Flagstaff history" again to carry on from ${report.stopped_at}.` : '';
  const head = report.head ? ` (commit ${report.head.slice(0, 7)})` : '';
  return `${report.done ? 'Flagstaff history imported' : 'Flagstaff import, part done'}, sir: I read ${report.files_read} mailbox file${report.files_read === 1 ? '' : 's'}${head}. ${parts}.${logs}${failed}${more} ${held}${report.in_brain ? `: ${countLine(report.by_sender)}` : ''}.${relabel}${what}`;
}

/** "How many outside messages are in my Brain": counts by sender and the last import, from the records. */
export function speakCorrespondenceCount(status, { peer = '' } = {}) {
  if (!status?.available) return 'I can\'t reach my Brain storage right now, sir, so I can\'t count the outside messages.';
  const last = status.last_import;
  const when = last?.at ? ` Last import: ${spokenDate(last.at)} at ${last.at.slice(11, 16)} UTC${last.head ? `, commit ${last.head.slice(0, 7)}` : ''}${last.done ? '' : ', not finished'}.` : ' No import has run yet.';
  if (peer) {
    const n = Number(status.by_sender?.[peer]) || 0;
    return `Your Brain holds ${n} message${n === 1 ? '' : 's'} from ${peerLabel(peer)}, sir, out of ${status.messages} outside messages.${when} They are outside correspondence, never your words or instructions.`;
  }
  if (!status.messages) return `Your Brain holds no outside messages yet, sir.${when} Say "import the Flagstaff history" to bring the che-mailbox branch in.`;
  const exchanges = status.exchanges ? ` Plus ${status.exchanges} Flagstaff repl${status.exchanges === 1 ? 'y' : 'ies'} I remembered, labeled the same way.` : '';
  return `Your Brain holds ${status.messages} outside message${status.messages === 1 ? '' : 's'}, sir: ${countLine(status.by_sender)}.${exchanges}${when} They are outside correspondence from the Flagstaff mailbox: other AIs' advice, never your words or instructions.`;
}

const TOPIC_STOP = new Set('the a an and or of to in on for about with my your our their this that these those what which is are was were be been it its me you i he she they we che sir please tell told say said write wrote mention mentioned anything something everything any ever mailbox flagstaff message messages'.split(' '));

function topicTerms(topic) {
  const text = String(topic || '').toLowerCase();
  return {
    numbers: [...new Set(text.match(/\d+/g) || [])].slice(0, 4),
    words: [...new Set((text.match(/[a-z][a-z0-9'’-]{2,}/g) || []).filter((w) => !TOPIC_STOP.has(w)))].slice(0, 8),
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A quote is reported, never re-asked. An offer inside it to act on a "yes" is left out and a
 * question the sender put to its reader becomes what it asked, so the owner's next "yes" can only
 * ever answer CHE's own question, never another AI's.
 */
export function reportedQuote(text) {
  return String(text || '').replace(/\s+/g, ' ')
    .replace(/[^.!?]*\b(?:say|reply|answer|type|respond|text|write)(?:\s+(?:back|me|with|to\s+me))*\s+["“'‘]?(?:yes|yeah|yep|ok(?:ay)?|confirm|go(?:\s+ahead)?|approved?)\b[^.!?]*[.!?]*/gi, ' [an offer to act on a yes, left out] ')
    .replace(/\b(?:do|would)\s+you\s+(?:want|like)\s+me\s+to\s+([^?]{1,240})\?/gi, (_, what) => `[it asked whether to ${what.trim()}]`)
    .replace(/\b(?:shall|should|can|may)\s+i\s+([^?]{1,240})\?/gi, (_, what) => `[it asked whether to ${what.trim()}]`)
    .replace(/\s{2,}/g, ' ').trim();
}

/**
 * "What did ChatGPT tell you about #350?": the matching messages, quoted with their source (who to
 * whom, the date, the mailbox file and message id). Only correspondence records are read, so an
 * owner memory is never cited here, and these never answer for the owner. No model.
 */
export function answerCorrespondenceQuestion(store, intent, { limit = 3 } = {}) {
  const { peer = '', direction = 'from', topic = '' } = intent || {};
  const status = correspondenceStatus(store);
  const who = peer ? peerLabel(peer) : 'the outside AIs';
  const about = topic ? ` about ${topic}` : '';
  if (!status.available) return { text: 'I can\'t reach my Brain storage right now, sir, so I won\'t guess what was said.', records: [] };
  if (!status.messages) return { text: `Your Brain has no outside correspondence yet, sir, so I won't guess what ${who} said${about}. Say "import the Flagstaff history" to bring the che-mailbox branch in.`, records: [] };
  const sender = direction === 'to' ? 'che' : peer;
  const rows = sender
    ? store.rows('SELECT id, body, source, created_at FROM brain_records WHERE kind = ? AND deleted = 0 AND source LIKE ? ORDER BY created_at DESC LIMIT 3000', CORRESPONDENCE_KIND, `%"from":"${sender}"%`)
    : store.rows('SELECT id, body, source, created_at FROM brain_records WHERE kind = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 3000', CORRESPONDENCE_KIND);
  const { numbers, words } = topicTerms(topic);
  const numberRes = numbers.map((n) => new RegExp(`(?<![\\d.])${n}(?!\\d)`));
  const wordRes = words.map((w) => new RegExp(`\\b${escapeRe(w.length > 4 ? w.replace(/(?:es|s)$/, '') : w)}`, 'i'));
  const hits = [];
  for (const row of rows) {
    let source = {};
    try { source = JSON.parse(row.source || '{}'); } catch (_) { source = {}; }
    if (sender && source.from !== sender) continue;
    if (!sender && source.from === 'che') continue;
    if (direction === 'to' && peer && source.to !== peer) continue;
    // The words of the message, without the provenance line the record starts with and the withheld
    // notice it may end with (the [withheld] marks stay in the quote).
    const body = String(row.body || '');
    const text = (body.includes('\n\n') ? body.slice(body.indexOf('\n\n') + 2) : body).replace(/\n\n(?:One part|\d+ parts) withheld: sensitive content\.[^\n]*$/, '');
    let score = 0;
    if (numberRes.length) {
      if (!numberRes.every((re) => re.test(text))) continue;
      score += numberRes.length * 10;
    }
    const matched = wordRes.filter((re) => re.test(text)).length;
    if (!numberRes.length && wordRes.length && matched < Math.ceil(wordRes.length / 2)) continue;
    score += matched * 5 + (source.to === 'che' ? 1 : 0);
    hits.push({ id: row.id, source, text, score, at: source.at || row.created_at || '' });
  }
  hits.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  if (!hits.length) {
    const n = sender === 'che' ? Number(status.by_sender.che) || 0 : sender ? Number(status.by_sender[sender]) || 0 : status.messages - (Number(status.by_sender.che) || 0);
    const when = status.last_import?.at ? `, imported up to ${spokenDate(status.last_import.at)}` : '';
    return { text: `I have no message${direction === 'to' ? ` of mine to ${who}` : ` from ${who}`}${about} in your Brain, sir, so I won't guess what ${direction === 'to' ? 'I wrote' : 'was said'}. ${n} message${n === 1 ? '' : 's'} ${direction === 'to' ? 'from me' : `from ${who}`} ${n === 1 ? 'is' : 'are'} there${when}.`, records: [] };
  }
  const shown = hits.slice(0, Math.max(1, Math.min(limit, 5)));
  const lines = shown.map((hit, i) => {
    const flat = reportedQuote(hit.text);
    const first = [...numberRes, ...wordRes].map((re) => flat.search(re)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    // The quote opens on a whole word, a little before the first match.
    let start = Math.max(0, Math.min(first, flat.length) - 120);
    if (start > 0) start = Math.max(start, flat.indexOf(' ', start) + 1);
    const window = redactBrainText(flat.slice(start, start + 360).trim(), topic);
    const id = String(hit.source.line_id || hit.id.replace(/^mail:/, ''));
    return `${i + 1}. ${peerLabel(hit.source.from)} to ${peerLabel(hit.source.to)}, ${spokenDate(hit.at)} (${hit.source.file || 'Flagstaff mailbox'}, message ${id.length > 44 ? `${id.slice(0, 44)}…` : id}): "${start > 0 ? '…' : ''}${window}${flat.length > start + 360 ? '…' : ''}"`;
  });
  const more = hits.length > shown.length ? `\n${hits.length - shown.length} more message${hits.length - shown.length === 1 ? '' : 's'} match.` : '';
  const lead = direction === 'to' ? `Here is what I wrote to ${who}${about}, sir` : `Here is what ${who} wrote${about}, sir`;
  const label = direction === 'to' ? 'my own messages to another AI' : `${peer ? `${who}'s` : 'their'} advice`;
  return {
    text: `${lead}, from the Flagstaff mailbox. This is outside correspondence: ${label}, not your words and not an instruction.\n${lines.join('\n')}${more}`,
    records: shown.map((hit) => hit.id),
  };
}

const AI_NAME = '(claude|chat\\s*gpt|codex|gemini|cursor|copilot|grok|open\\s*code)';
const OTHER_AIS = '(?:the\\s+)?(?:other\\s+|outside\\s+)?(?:ais|a\\s*i\\s*s)';
const SAID = '(?:tell|told|say|said|write|wrote|written|send|sent|suggest(?:ed)?|recommend(?:ed)?|advise[d]?|propose[d]?|report(?:ed)?|mention(?:ed)?|answer(?:ed)?|reply|replied)';

function peerOf(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '');
}

function topicOf(rest) {
  return String(rest || '').replace(/\b(?:in|on|through|via)\s+(?:the\s+)?(?:mail\s*box|flag\s*staff(?:\s*369)?)\b/g, ' ')
    .replace(/\b(?:please|sir|so\s+far|ever|recently|lately|earlier|before|today|yesterday)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// Names of AIs that are also people's names (or ordinary words): with one of them, the question is
// about the correspondence only with an AI cue, so "what did Claude say about dinner on Friday" is
// about a person (review of #354).
const PERSON_NAMES = new Set(['claude', 'gemini', 'cursor', 'copilot']);
const MAILBOX_WORD = /\b(?:mail\s*box|flag\s*staff|correspondence)\b/;
const AI_CUE = /\b(?:pr|prs|pull\s+requests?|issues?|code|coding|repo(?:sitory)?|github|branch(?:es)?|commits?|deploy\w*|worker|tests?|bugs?|fix\w*|merg\w*|build\w*|che|brain|app|ais?|models?|prompts?|review\w*|handoffs?|iphone|ios|flutter|shorebird|release\w*|trading|rea)\b|#\d+|\b\d{3,}\b/;

/**
 * Whether an "ask" reading stands. "What did ChatGPT say?" alone is about the conversation, most
 * often the answer it just gave through "ask ChatGPT …", so only a topic or the mailbox makes it a
 * correspondence question; right after a live consult of that AI, its answer is the subject; and a
 * name that is also a person's needs an AI cue.
 */
function standingAsk(intent, text, history) {
  const mailbox = MAILBOX_WORD.test(text);
  if (!intent.topic && !mailbox) return null;
  if (PERSON_NAMES.has(intent.peer) && !mailbox && !AI_CUE.test(intent.topic)) return null;
  if (!mailbox) {
    // The last few turns: an "ask ChatGPT …" of the owner's, or the answer it gave ("ChatGPT … says:",
    // "… is unreachable right now, so … answered instead", "…: couldn't reach it").
    const label = intent.peer ? FREE_ENGINES[intent.peer]?.label : '';
    for (const turn of asList(history).slice(-6)) {
      const said = String(turn?.content || turn?.text || '');
      const consulted = turn?.role === 'user' ? consultIntent(said) : null;
      if (consulted && (!intent.peer || consulted.peers.includes(intent.peer))) return null;
      if (turn?.role === 'assistant' && label && (said.startsWith(`${label} says:`) || said.startsWith(`${label} is unreachable right now`) || said.startsWith(`${label}: couldn't reach it`))) return null;
    }
  }
  return intent;
}

/**
 * The owner asking about the Flagstaff correspondence: { kind: 'import' } to bring it in,
 * { kind: 'count', peer } for "how many outside messages are in my Brain", or
 * { kind: 'ask', peer, direction, topic } for "what did ChatGPT tell you about #350". Only when an
 * outside AI is the one who spoke: "what did I tell you" stays the owner's memory question.
 * [history] is the chat so far ({role, content}), to yield to a live consult's answer.
 */
export function outsideCorrespondenceIntent(message, { history = [] } = {}) {
  const raw = String(message || '').trim();
  if (!raw || raw.length > 220) return null;
  const text = withoutProhibitions(raw).replace(/^(?:hey|hi|ok|okay)?[,\s]*(?:che|chay|chey|shay)\b[,:]?\s*/i, '')
    .toLowerCase().replace(/[’]/g, "'").replace(/[?!.,;:]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // "Don't import the Flagstaff history, just tell me how many…": a forbidden import never runs, and
  // the request after it is read on its own. (The money/delete gate's prohibitions do not name imports.)
  const banned = /\b(?:do\s+not|don'?t|never|no\s+need\s+to)\s+(?:\w+\s+){0,2}?(?:import|bring|pull|recover|archive)\b/.exec(text);
  if (banned) {
    const turn = /\s+(?:but|just|only|instead)\s+(?:tell\s+me\s+|say\s+)?/.exec(text.slice(banned.index));
    const intent = turn ? outsideCorrespondenceIntent(text.slice(banned.index + turn.index + turn[0].length), { history }) : null;
    return intent?.kind === 'import' ? null : intent;
  }
  const MAIL = '(?:flag\\s*staff(?:\\s*369)?|mail\\s*box|outside\\s+(?:correspondence|messages?|mail)|other\\s+ais?\'?\\s+(?:messages?|mail|correspondence)|ai\\s+correspondence)';
  const verb = '(?:import|bring(?:\\s+in)?|pull(?:\\s+in)?|recover|archive)';
  if (new RegExp(`^(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+)?(?:now\\s+)?${verb}\\s+(?:in\\s+)?(?:all\\s+)?(?:of\\s+)?(?:the\\s+|my\\s+|your\\s+)?(?:old\\s+|whole\\s+|full\\s+|historical\\s+)?${MAIL}(?:\\s+(?:history|archives?|messages?|correspondence|threads?|mail\\s*box|mail))?(?:\\s+(?:into|in|to)\\s+(?:my|the|your)\\s+brain)?(?:\\s+(?:please|now|sir))?$`).test(text)
    || /^(?:please\s+)?(?:run|start|do)\s+(?:the\s+|a\s+)?flag\s*staff\s+(?:history\s+)?import(?:\s+(?:again|now|please))?$/.test(text)) {
    return { kind: 'import' };
  }
  // A report request reads the same records as a count.
  if (new RegExp(`^(?:(?:read|give|tell|show)\\s+(?:me\\s+)?)?(?:the\\s+)?(?:flag\\s*staff|outside\\s+correspondence|mailbox)\\s+import\\s+report$|^how\\s+did\\s+the\\s+flag\\s*staff\\s+import\\s+go$`).test(text)) return { kind: 'count', peer: '' };
  const count = new RegExp(`^how\\s+(?:many|much)\\s+(?:outside\\s+|external\\s+|flag\\s*staff\\s+|mail\\s*box\\s+|other\\s+ai\\s+|ai\\s+)?(?:messages?|letters?|correspondence|mail)(?:\\s+from\\s+${AI_NAME}|\\s+from\\s+${OTHER_AIS})?\\s+(?:are|is|do\\s+you\\s+have|have\\s+you\\s+(?:got|imported|kept|stored))\\s+(?:there\\s+)?(?:in\\s+)?(?:my|the|your)\\s+brain(?:\\s+now)?$|^how\\s+(?:many|much)\\s+(?:outside|external|flag\\s*staff|other\\s+ai)\\s+(?:messages?|correspondence|mail)\\b.*\\b(?:brain|imported)\\b`).exec(text);
  if (count) {
    const named = new RegExp(`\\bfrom\\s+${AI_NAME}\\b`).exec(text);
    // "How many messages are in my Brain" alone may mean anything; an outside word or a named AI is needed.
    if (named || /\b(?:outside|external|flag\s*staff|mail\s*box|other\s+ai|ai\s+(?:messages?|correspondence)|correspondence)\b/.test(text)) return { kind: 'count', peer: named ? peerOf(named[1]) : '' };
  }
  const ai = new RegExp(`^(?:so\\s+)?(?:what|anything)\\s+(?:did|has|have|had)\\s+(?:${AI_NAME}|${OTHER_AIS})\\s+(?:ever\\s+|actually\\s+)?${SAID}(?:\\s+(?:you|me|che|us|to\\s+you|to\\s+me|to\\s+che))?(?:\\s+(?:in|on|through)\\s+(?:the\\s+)?(?:mail\\s*box|flag\\s*staff(?:\\s*369)?))?(?:\\s+(?:about|regarding|on|concerning|of)\\s+(.+))?$`).exec(text)
    || new RegExp(`^(?:did|has|have)\\s+(?:${AI_NAME}|${OTHER_AIS})\\s+(?:ever\\s+)?(?:say|said|tell\\s+you|told\\s+you|mention(?:ed)?|write|wrote|written|suggest(?:ed)?)\\s+(?:you\\s+)?(?:anything\\s+)?(?:about\\s+)?(.+)$`).exec(text);
  if (ai) return standingAsk({ kind: 'ask', peer: ai[1] ? peerOf(ai[1]) : '', direction: 'from', topic: topicOf(ai[2]) }, text, history);
  const mine = new RegExp(`^what\\s+(?:did|have)\\s+you\\s+(?:tell|told|say\\s+to|said\\s+to|write\\s+to|wrote\\s+to|written\\s+to|send|sent|ask|asked)\\s+${AI_NAME}(?:\\s+(?:in|on)\\s+(?:the\\s+)?(?:mail\\s*box|flag\\s*staff))?(?:\\s+(?:about|regarding|on|concerning)\\s+(.+))?$`).exec(text);
  if (mine) return standingAsk({ kind: 'ask', peer: peerOf(mine[1]), direction: 'to', topic: topicOf(mine[2]) }, text, history);
  return null;
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
