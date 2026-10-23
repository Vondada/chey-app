// Coordinated Office jobs (owner master mission, 2026-10-23, Phase 3): one piece of work that needs several
// departments, run as a chain of ordinary Office tasks with real, recorded handoffs.
//
// Nothing here is a second job system. The record is an Office goal (data.office_goals, the same list
// /api/office/goals writes), extended with the fields a coordinated job needs; every stage is an ordinary Office
// task (data.team_tasks) queued through the caller's queueStep, so permissions, tool blockers, Codex packets,
// CHE's review, retries and the Brain's collaboration records all apply unchanged. This module is deterministic
// bookkeeping: it never calls a model and never marks work done that a task did not finish.
//
// Workflow: Understand → Inspect → Plan → Delegate → Act → Verify → Correct → Remember.
// Roles: Nova coordinates, Atlas engineers (Codex desk), Knox reviews security, Vale verifies independently, and
// CHE reports to the owner. A receiving agent accepts a handoff only when every acceptance check passes; a refused
// handoff blocks the job and is escalated to CHE, never skipped.

import { departmentHead, LA_AGENCIA_ROLES } from './office_company.js';

const MAX_JOBS = 100;
const MAX_HISTORY = 60;
const MAX_CORRECTIONS = 1;
export const WORKFLOW = Object.freeze(['understand', 'inspect', 'plan', 'delegate', 'act', 'verify', 'correct', 'remember']);
const OPEN = new Set(['planned', 'running', 'waiting', 'correcting']);
const STAGE_DONE = new Set(['complete']);
const STAGE_STOPPED = new Set(['failed', 'cancelled', 'rejected', 'blocked', 'needs_review', 'advisory']);

// The order departments work in when one job needs several. Verification is always last and never by the
// agent whose work it checks.
const STAGE_ORDER = ['research', 'experience', 'engineering', 'security', 'creative', 'markets', 'intelligence', 'operations', 'qa'];

// What each department contributes to a coordinated job. Words decide which departments a request needs.
const DISCIPLINES = {
  research: { words: /\b(?:research|investigate|sources?|competitors?|find out)\b/i, brief: 'Research what the change needs: sources, facts and unknowns. Do not claim research ran without its sources.' },
  experience: { words: /\b(?:design|redesign|layout|ux|ui|user experience|accessib\w*|voiceover|screen|page|room|prototype|look|cramped)\b/i, brief: 'Design the experience: layout, flow, accessibility and VoiceOver labels. Keep the chrome HUD style.' },
  engineering: { words: /\b(?:build|implement|engineer\w*|code|coding|fix|feature|improve|change|refactor|app)\b/i, brief: 'Plan the implementation from the design: files, changes, tests and risks. Do not claim code was written, merged or deployed unless a coding job receipt exists.' },
  security: { words: /\b(?:security|secure|permissions?|access|secrets?|credentials?|privacy)\b/i, brief: 'Review the planned change for security: access, secrets, permissions and failure modes. Defensive only. Say "no issues found" only for what you actually reviewed.' },
  creative: { words: /\b(?:content|video|post|campaign|ads?|creative|copy)\b/i, brief: 'Produce the creative part: copy, campaign or asset brief.' },
  // A screen called the Trading Room is experience work; markets work is research on markets themselves.
  markets: { words: /\b(?:market research|strategy research|trading strateg\w*|backtest\w*|crypto\w*|stocks?|futures research|paper trad\w*)\b/i, brief: 'Bring the markets view: data sources and their freshness, strategy evidence and risks. Paper only.' },
  intelligence: { words: /\b(?:analy[sz]e|evidence|decision|strategy|business intelligence)\b/i, brief: 'Weigh the evidence and the trade-offs, and state the decision it supports.' },
  qa: { words: /\b(?:test|testing|tests|verify|verification|qa|quality|regression)\b/i, brief: '' },
};

const clip = (value, n) => String(value ?? '').trim().slice(0, n);
const now = () => new Date().toISOString();
const list = (value, n, each = 300) => (Array.isArray(value) ? value : []).map((v) => clip(v, each)).filter(Boolean).slice(0, n);
const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
const jobId = () => `oj-${crypto.randomUUID().slice(0, 8)}`;

/** The departments a request needs, in working order. Engineering brings a security review; every job ends with Vale. */
export function disciplinesFor(request, explicit = []) {
  const text = String(request || '');
  const wanted = new Set((Array.isArray(explicit) ? explicit : []).filter((d) => DISCIPLINES[d]));
  if (!wanted.size) for (const [id, spec] of Object.entries(DISCIPLINES)) if (spec.words.test(text)) wanted.add(id);
  if (wanted.has('engineering')) wanted.add('security');
  const work = [...wanted].filter((d) => d !== 'qa');
  if (!work.length) work.push('research');
  return [...STAGE_ORDER.filter((d) => work.includes(d)), 'qa'];
}

function head(discipline) {
  const found = departmentHead(discipline);
  return found ? found.name : null;
}

function valeBrief(job) {
  return [
    'Independently verify the finished stages of this Office job against its acceptance criteria. You did none of this work.',
    'Start your answer with exactly "VERDICT: PASS" or "VERDICT: FAIL", then one line per acceptance criterion saying met, not met, or not checkable from the records, and why.',
    'Judge only what the stage results below show. A claim with no record (a test, a merge, a deploy) is not checkable, and an unchecked criterion is not met.',
    `Acceptance criteria:\n${job.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
  ].join('\n');
}

function stageTask(job, stage, priorResults) {
  const lines = [
    `Office job ${job.id} (coordinated by Nova; accountable: ${job.accountable}). Request: ${job.request}`,
    stage.discipline === 'qa' ? valeBrief(job) : DISCIPLINES[stage.discipline]?.brief || '',
    job.acceptance_criteria.length && stage.discipline !== 'qa' ? `Acceptance criteria for the whole job:\n${job.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '',
    stage.correction ? `CORRECTION REQUESTED BY VALE:\n${stage.correction}` : '',
    priorResults.length ? `WORK SO FAR (handed to you with its evidence):\n${priorResults.join('\n\n')}` : '',
  ];
  return lines.filter(Boolean).join('\n\n').slice(0, 2900);
}

function addHistory(job, actor, event, detail = '') {
  job.history.push({ at: now(), actor, event, detail: clip(detail, 400), stage: job.workflow_stage });
  job.history = job.history.slice(-MAX_HISTORY);
  job.updated_at = now();
}

function setStage(job, stage) {
  if (WORKFLOW.includes(stage)) job.workflow_stage = stage;
}

function overlapping(data, job) {
  const mine = new Set(job.targets.map(norm));
  if (!mine.size) return null;
  return (data.office_goals || []).find((other) => other !== job && other.coordinated && OPEN.has(other.status)
    && (other.targets || []).some((t) => mine.has(norm(t)))) || null;
}

/**
 * Nova's plan for a request: one accountable owner, supporting agents, stages in dependency order, acceptance
 * criteria, priority and targets. Collisions with another open job on the same target are detected here: the new
 * job waits for that job and names its accountable owner, so the two never change the same thing at once.
 */
export function planOfficeJob(data, body = {}) {
  const request = clip(body.request || body.goal, 2000);
  if (!request) return { error: 'Describe the work for the Office.' };
  const disciplines = disciplinesFor(request, body.disciplines);
  const stages = disciplines.map((discipline, i) => ({
    id: `s${i + 1}`,
    discipline,
    agent: head(discipline),
    depends_on: i ? [`s${i}`] : [],
    status: 'pending',
    task_id: null,
    accepted: null,
  }));
  const missing = stages.filter((s) => !s.agent);
  if (missing.length) return { error: `No department head for ${missing.map((s) => s.discipline).join(', ')}.` };
  const work = stages.filter((s) => s.discipline !== 'qa');
  const named = clip(body.accountable, 40);
  const accountable = (named && LA_AGENCIA_ROLES[named] ? named : '')
    || (work.find((s) => s.discipline === 'engineering') || work[0]).agent;
  const acceptance = list(body.acceptance_criteria || body.acceptance, 8);
  const job = {
    id: jobId(),
    goal: request,
    request,
    coordinated: true,
    coordinator: head('operations') || 'Nova',
    accountable,
    supporting: [...new Set(stages.map((s) => s.agent).filter((name) => name !== accountable))],
    acceptance_criteria: acceptance.length ? acceptance : [
      `The request is done as asked: ${request.slice(0, 200)}`,
      'Every stage result is recorded with its evidence.',
      'Security was reviewed for any change to code, access or data.',
    ],
    priority: Math.max(0, Math.min(9, Number.isFinite(Number(body.priority)) ? Math.round(Number(body.priority)) : 5)),
    depends_on: list(body.depends_on, 6, 40),
    targets: list(body.targets, 8, 120),
    tools_required: [...new Set(stages.map((s) => (s.discipline === 'engineering' ? 'Codex desk (Atlas)' : s.discipline === 'security' ? 'Security Core checks (Knox)' : 'Office task runtime')))],
    permissions_required: ['office_workspace', 'che_memory_read_filtered'],
    approvals: 'Merging, deploying, spending, publishing and deleting stay owner-approved; no stage can do them.',
    cost: { measured: null, note: 'Not measured: Office tasks do not record provider cost yet.' },
    stages,
    handoffs: [],
    evidence: [],
    verification: { status: 'unverified', by: head('qa') || 'Vale', at: null, basis: '' },
    rollback: 'Each stage is a separate Office task; cancelling the job cancels the stage that is open. Nothing a stage plans is applied to CHE without a coding job, and coding jobs keep their own revert.',
    corrections: 0,
    workflow_stage: 'understand',
    status: 'planned',
    job_ids: [],
    history: [],
    created_at: now(),
    updated_at: now(),
  };
  addHistory(job, 'CHE', 'understood', request);
  setStage(job, 'inspect');
  const clash = overlapping(data, job);
  if (clash) {
    job.collision = { with: clash.id, targets: job.targets.filter((t) => (clash.targets || []).map(norm).includes(norm(t))), accountable: clash.accountable };
    if (!job.depends_on.includes(clash.id)) job.depends_on.push(clash.id);
    addHistory(job, 'Nova', 'collision', `Overlaps job ${clash.id} on ${job.collision.targets.join(', ')}; ${clash.accountable} stays accountable there and this job waits for it.`);
  }
  setStage(job, 'plan');
  addHistory(job, 'Nova', 'planned', `Accountable: ${accountable}. Supporting: ${job.supporting.join(', ') || 'none'}. Stages: ${stages.map((s) => `${s.agent} (${s.discipline})`).join(' → ')}.`);
  data.office_goals = Array.isArray(data.office_goals) ? data.office_goals : [];
  data.office_goals.push(job);
  data.office_goals = data.office_goals.slice(-MAX_JOBS);
  return { job };
}

function taskById(data, id) {
  return (data.team_tasks || []).find((t) => t.id === id) || null;
}

function dependenciesMet(data, job) {
  return job.depends_on.every((id) => {
    const other = (data.office_goals || []).find((g) => g.id === id);
    return !other || !OPEN.has(other.status);
  });
}

/**
 * The receiving agent's acceptance of a handoff: each check is recorded, and the handoff is accepted only when all
 * pass. `blocker(agent, text)` is the caller's tool/permission check (office tool blockers and action guards).
 */
export function acceptanceChecks(data, job, stage, blocker = () => '') {
  const agent = (data.team || []).find((a) => a && !a.retired && a.name === stage.agent);
  const dept = agent?.department?.id || LA_AGENCIA_ROLES[stage.agent]?.department?.id || '';
  const before = job.stages.filter((s) => stage.depends_on.includes(s.id));
  const checks = [
    { check: 'on the roster', ok: Boolean(agent) },
    { check: `heads ${stage.discipline}`, ok: dept === stage.discipline },
    { check: 'earlier stages finished', ok: before.every((s) => STAGE_DONE.has(s.status)) },
    { check: 'jobs this one depends on are finished', ok: dependenciesMet(data, job) },
    { check: 'not verifying its own work', ok: stage.discipline !== 'qa' || !job.stages.some((s) => s !== stage && s.agent === stage.agent && STAGE_DONE.has(s.status)) },
  ];
  const tool = agent ? blocker(agent, `${stage.discipline} stage of ${job.request}`) : '';
  checks.push({ check: 'tools and permissions available', ok: !tool, detail: tool || '' });
  return { agent, checks, accepted: checks.every((c) => c.ok) };
}

function stageResults(data, job, upTo) {
  return job.stages.filter((s) => upTo.depends_on.includes(s.id) || job.stages.indexOf(s) < job.stages.indexOf(upTo))
    .filter((s) => STAGE_DONE.has(s.status))
    .map((s) => {
      const t = taskById(data, s.task_id);
      return `${s.agent} (${s.discipline}, task ${s.task_id}): ${clip(t?.result, 900) || '(no result text)'}`;
    });
}

function valeVerdict(text) {
  const first = String(text || '').trim().split('\n')[0] || '';
  if (/^\W*VERDICT\s*:\s*PASS\b/i.test(first)) return 'pass';
  if (/^\W*VERDICT\s*:\s*FAIL\b/i.test(first)) return 'fail';
  return null;
}

function startStage(data, job, stage, { queueStep, blocker }) {
  const { agent, checks, accepted } = acceptanceChecks(data, job, stage, blocker);
  const prior = job.stages.filter((s) => stage.depends_on.includes(s.id)).map((s) => s.agent);
  const handoff = {
    job_id: job.id,
    stage: stage.id,
    from_agent_name: prior[0] || job.coordinator,
    to_agent_name: stage.agent,
    at: now(),
    accepted,
    checks,
    note: accepted ? `${stage.agent} accepted the ${stage.discipline} stage.` : `${stage.agent} could not accept: ${checks.filter((c) => !c.ok).map((c) => c.detail || c.check).join('; ')}.`,
  };
  job.handoffs.push(handoff);
  job.handoffs = job.handoffs.slice(-30);
  stage.accepted = { at: handoff.at, accepted, checks };
  if (!accepted) {
    stage.status = 'refused';
    job.status = 'waiting';
    addHistory(job, stage.agent, 'handoff refused', `${handoff.note} Escalated to CHE.`);
    return true;
  }
  setStage(job, stage.discipline === 'qa' ? 'verify' : (job.stages.indexOf(stage) === 0 ? 'delegate' : 'act'));
  const task = queueStep(agent, stageTask(job, stage, stageResults(data, job, stage)), {
    job_id: job.id,
    kind: 'office_stage',
  });
  // The Brain reads task.handoffs for collaboration records: the stage carries the handoff that started it.
  task.handoffs = [...(Array.isArray(task.handoffs) ? task.handoffs : []), {
    from_agent_name: handoff.from_agent_name, to_agent_name: handoff.to_agent_name, note: handoff.note, at: handoff.at,
  }];
  task.office_job_id = job.id;
  task.office_stage = stage.id;
  stage.task_id = task.id;
  stage.status = task.status === 'blocked' ? 'blocked' : 'running';
  job.job_ids = [...new Set([...job.job_ids, task.id])];
  job.status = stage.status === 'blocked' ? 'waiting' : 'running';
  addHistory(job, stage.agent, stage.status === 'blocked' ? 'stage blocked' : 'stage started', stage.status === 'blocked' ? task.error : `Task ${task.id}.`);
  return true;
}

/** One deterministic pass over every open coordinated job. Returns true when anything changed. */
export function advanceOfficeJobs(data, { queueStep, blocker = () => '' } = {}) {
  let changed = false;
  for (const job of data.office_goals || []) {
    if (!job?.coordinated || !OPEN.has(job.status)) continue;
    if (!dependenciesMet(data, job)) continue;
    // Follow the stage that is running.
    for (const stage of job.stages) {
      if (!['running', 'blocked'].includes(stage.status) || !stage.task_id) continue;
      const task = taskById(data, stage.task_id);
      if (!task) {
        stage.status = 'failed';
        job.status = 'failed';
        addHistory(job, 'Nova', 'stage lost', `Task ${stage.task_id} no longer exists.`);
        changed = true;
        continue;
      }
      if (STAGE_DONE.has(task.status)) {
        stage.status = 'complete';
        stage.finished_at = task.updated_at || now();
        job.evidence.push({ kind: 'office_task', task_id: task.id, agent: stage.agent, stage: stage.id, at: stage.finished_at });
        addHistory(job, stage.agent, 'stage finished', `Task ${task.id} passed CHE's review.`);
        if (stage.discipline === 'qa') {
          const verdict = valeVerdict(task.result);
          if (verdict === 'pass') {
            job.verification = { status: 'verified', by: stage.agent, at: stage.finished_at, basis: `Vale's independent review of the recorded stage results (task ${task.id}). Tests count only where a stage links a test run.` };
            job.status = 'verified';
            setStage(job, 'remember');
            addHistory(job, 'CHE', 'verified', 'Vale verified the job; CHE reports it to the owner.');
          } else if (verdict === 'fail' && job.corrections < MAX_CORRECTIONS) {
            const fix = job.stages.find((s) => s.agent === job.accountable && s.discipline !== 'qa') || job.stages.find((s) => s.discipline !== 'qa');
            job.corrections += 1;
            setStage(job, 'correct');
            job.status = 'correcting';
            // The accountable stage and everything after it run again, with Vale's findings.
            const from = job.stages.indexOf(fix);
            for (const s of job.stages.slice(from)) Object.assign(s, { status: 'pending', task_id: null, accepted: null, correction: s === fix ? clip(task.result, 1500) : '' });
            addHistory(job, 'Vale', 'verification failed', `Correction ${job.corrections}: back to ${fix.agent}.`);
          } else {
            job.verification = { status: verdict === 'fail' ? 'failed' : 'unverified', by: stage.agent, at: stage.finished_at, basis: verdict === 'fail' ? `Vale found unmet criteria (task ${task.id}) after ${job.corrections} correction(s).` : `Vale's answer gave no PASS or FAIL verdict (task ${task.id}).` };
            job.status = 'failed';
            addHistory(job, 'Vale', verdict === 'fail' ? 'verification failed' : 'no verdict', 'Escalated to CHE; the job is not reported as done.');
          }
        }
        changed = true;
      } else if (STAGE_STOPPED.has(task.status)) {
        if (stage.status !== task.status) {
          stage.status = task.status === 'blocked' ? 'blocked' : 'failed';
          job.status = stage.status === 'blocked' ? 'waiting' : 'failed';
          addHistory(job, stage.agent, `stage ${task.status}`, `${clip(task.error, 300) || 'No detail.'} Escalated to CHE.`);
          changed = true;
        }
      }
    }
    if (!OPEN.has(job.status)) continue;
    // A refused handoff is offered again once its checks pass (say, Codex was connected); until then nothing is
    // recorded again, so a waiting job does not fill its history.
    const refused = job.stages.find((s) => s.status === 'refused');
    if (refused) {
      if (acceptanceChecks(data, job, refused, blocker).accepted) changed = startStage(data, job, refused, { queueStep, blocker }) || changed;
      continue;
    }
    // Hand off to the next stage whose dependencies are done.
    const next = job.stages.find((s) => s.status === 'pending' && s.depends_on.every((id) => STAGE_DONE.has(job.stages.find((x) => x.id === id)?.status)));
    if (next && !job.stages.some((s) => s.status === 'running')) changed = startStage(data, job, next, { queueStep, blocker }) || changed;
  }
  return changed;
}

/** Owner-visible view of a coordinated job. */
export function officeJobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    request: job.request,
    status: job.status,
    workflow_stage: job.workflow_stage,
    coordinator: job.coordinator,
    accountable: job.accountable,
    supporting: job.supporting,
    priority: job.priority,
    depends_on: job.depends_on,
    targets: job.targets,
    collision: job.collision || null,
    acceptance_criteria: job.acceptance_criteria,
    stages: job.stages.map((s) => ({ id: s.id, discipline: s.discipline, agent: s.agent, status: s.status, task_id: s.task_id, depends_on: s.depends_on, accepted: s.accepted })),
    handoffs: job.handoffs,
    tools_required: job.tools_required,
    permissions_required: job.permissions_required,
    approvals: job.approvals,
    cost: job.cost,
    evidence: job.evidence,
    verification: job.verification,
    rollback: job.rollback,
    corrections: job.corrections,
    history: job.history,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

export function officeJobsView(data) {
  return (data.office_goals || []).filter((g) => g?.coordinated).slice(-30).reverse().map(officeJobView);
}

/** What CHE says about a job: built only from its record. */
export function speakOfficeJob(job) {
  if (!job) return 'CHE here. I could not find that Office job.';
  const stages = job.stages.map((s) => `${s.agent} ${s.discipline}: ${s.status}`).join('; ');
  const verdict = job.verification.status === 'verified'
    ? `Vale verified it: ${job.verification.basis}`
    : job.verification.status === 'failed' ? `Vale did not verify it: ${job.verification.basis}` : 'Not verified yet.';
  const refused = job.handoffs.filter((h) => !h.accepted).slice(-1)[0];
  return [
    `CHE here. Office job ${job.id}: ${job.status}.`,
    `Nova coordinates; ${job.accountable} is accountable.`,
    `Stages: ${stages}.`,
    refused ? `Blocked handoff: ${refused.note}` : '',
    verdict,
  ].filter(Boolean).join(' ');
}
