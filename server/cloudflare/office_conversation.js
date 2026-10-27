// Read-only conversation record for one Office agent or one Office task (owner rule, 2026-10-26: the owner opens
// an agent or a task and sees the full conversation, untruncated, with the real state).
//
// Nothing here calls a model and nothing is invented. Every message is built from a stored record that already
// exists: data.team_tasks (request, steering, handoffs, result, CHE review, review feedback, error, provider trail),
// data.office_goals (coordinated job history), data.meetings (War Room board posts and decisions), data.agent_work_log
// (verified outcomes) and data.jobs (coding job evidence: PR number, merge commit). A field with no backing record is
// returned as null, and the app shows "Not recorded". The six states are exact: Queued, Running, Waiting, Blocked,
// Failed, Completed.

export const OFFICE_STATES = Object.freeze(['Queued', 'Running', 'Waiting', 'Blocked', 'Failed', 'Completed']);

// Open = the agent still holds this task. Same meaning as TASK_OPEN in agent_runtime.js.
const OPEN = new Set(['queued', 'running', 'reviewing', 'review_pending', 'needs_review']);
// queueAgentTask stores the owner's request clipped to this length. Flagged per message so the owner can see when
// the stored text itself was cut.
const STORED_REQUEST_LIMIT = 3000;
const AGENT_HISTORY_LIMIT = 30;

const str = (value) => (value == null ? '' : String(value));
// Accepts an ISO string or epoch milliseconds (the runtime stores retry_at as Date.now() + delay). 0, null and
// empty values mean "not recorded", never 1970.
const ts = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const t = Date.parse(str(value));
  return Number.isFinite(t) ? t : null;
};
const iso = (value) => (ts(value) == null ? null : new Date(ts(value)).toISOString());

/**
 * Maps a stored task status to exactly one of the six states. The raw status comes back beside it, so nothing is
 * hidden: a queued task is Queued, never Running; a complete task is Completed only when CHE verified it.
 */
export function officeTaskState(task = {}) {
  const raw = str(task.status);
  switch (raw) {
    case 'queued':
      return { state: 'Queued', raw, reason: 'Waiting to start. Nothing has run for this task yet.' };
    case 'running':
      return { state: 'Running', raw, reason: 'Working now.' };
    case 'reviewing':
      return { state: 'Running', raw, reason: 'CHE is reviewing the result.' };
    case 'review_pending':
      return { state: 'Waiting', raw, reason: 'Waiting for CHE review.' };
    case 'needs_review':
      return { state: 'Waiting', raw, reason: 'Result is not verified yet. It needs a decision.' };
    case 'complete':
      return task.verified_by_che === true
        ? { state: 'Completed', raw, reason: 'Approved by CHE.' }
        : { state: 'Waiting', raw, reason: 'Marked complete, but CHE has not verified it.' };
    case 'advisory':
      return { state: 'Waiting', raw, reason: 'Input to an answer, not reviewed by CHE.' };
    case 'blocked':
      return { state: 'Blocked', raw, reason: str(task.error) || 'Blocked. No reason was recorded.' };
    case 'failed':
      return { state: 'Failed', raw, reason: str(task.error) || 'Failed. No reason was recorded.' };
    case 'rejected':
      return { state: 'Failed', raw, reason: 'Rejected by CHE.' };
    case 'cancelled':
      return { state: 'Failed', raw, reason: 'Cancelled before it finished.' };
    default:
      return { state: 'Waiting', raw, reason: raw ? `Unrecognised stored status "${raw}".` : 'No status recorded.' };
  }
}

function taskSummary(task) {
  const s = officeTaskState(task);
  return {
    id: str(task.id),
    title: str(task.task),
    state: s.state,
    raw_status: s.raw,
    reason: s.reason,
    partner_name: str(task.partner_name),
    partner_id: str(task.partner_id),
    source: str(task.source),
    verified_by_che: task.verified_by_che === true,
    job_id: str(task.job_id),
    created_at: iso(task.created_at),
    updated_at: iso(task.updated_at || task.created_at),
  };
}

// The newest recorded attempt. A running task with no attempt yet says so instead of inventing a step.
function currentStep(task, s) {
  if (s.state === 'Queued') return 'Queued. Not started yet.';
  if (s.raw === 'running') {
    const trail = Array.isArray(task.provider_trail) ? task.provider_trail : [];
    const last = trail[trail.length - 1];
    if (!last) return 'Running. No provider attempt is recorded yet.';
    return `Running. Latest recorded attempt: ${str(last.provider) || 'unknown provider'}${last.model ? ` (${last.model})` : ''}.`;
  }
  return s.reason;
}

// Work in progress outranks work waiting to start: queueAgentTask prepends (tasks are newest first) and runOneTask
// starts the oldest queued task, so an older running task is the real current work and the oldest queued task is
// the one that starts next. Same precedence as the desk headline (lib/agents/che_office_floor_screen.dart).
const ACTIVE_RANK = { running: 0, reviewing: 0, review_pending: 1, needs_review: 1, queued: 2 };
function activeTask(tasks) {
  let best = null;
  let bestRank = Infinity;
  for (const t of tasks) {
    const rank = ACTIVE_RANK[t?.status];
    if (rank == null) continue;
    // Among queued tasks the oldest (last in the list) wins; otherwise the newest.
    if (rank < bestRank || (rank === 2 && bestRank === 2)) {
      best = t;
      bestRank = rank;
    }
  }
  return best;
}

function agentLocalState(data, agent) {
  const tasks = (data.team_tasks || []).filter((t) => t && t.partner_id === agent.id);
  const active = activeTask(tasks);
  const latest = active || tasks[0] || null;
  const s = latest ? officeTaskState(latest) : null;
  // Oldest first: the order runOneTask starts them in.
  const queued = tasks.filter((t) => t.status === 'queued' && t !== active).reverse();
  const verifiedTasks = tasks.filter((t) => t.verified_by_che === true && t.status === 'complete');
  const workLog = (Array.isArray(data.agent_work_log) ? data.agent_work_log : []).filter((e) => e && e.agent_id === agent.id);
  const verifiedAt = [
    ...verifiedTasks.map((t) => ts(t.updated_at || t.created_at)),
    ...workLog.filter((e) => e.verified_by_che === true).map((e) => ts(e.at)),
  ].filter((v) => v != null);
  // A retry the runtime scheduled on an unfinished task (open or blocked) is the agent's next timed action.
  const retrying = tasks.find((t) => t.retry_at && !['complete', 'rejected', 'cancelled'].includes(t.status));
  const retryAt = retrying ? iso(retrying.retry_at) : null;
  const next = retryAt
    ? { text: `Retry scheduled at ${retryAt}.`, at: retryAt }
    : (queued.length ? { text: `Next queued: ${str(queued[0].task)}`, at: iso(queued[0].created_at) } : null);
  const blockers = tasks
    .filter((t) => ['blocked', 'needs_review'].includes(t.status) || (OPEN.has(t.status) && str(t.error)))
    .slice(0, 5)
    .map((t) => ({ task_id: str(t.id), title: str(t.task), state: officeTaskState(t).state, text: officeTaskState(t).reason }));
  if (agent.runtime_status === 'offline' && agent.runtime_task) {
    blockers.push({ task_id: '', title: '', state: 'Blocked', text: str(agent.runtime_task) });
  }
  return {
    tasks,
    active,
    agent: {
      id: str(agent.id),
      name: str(agent.name),
      role: str(agent.role),
      status: s ? s.state : null,
      status_raw: s ? s.raw : null,
      status_reason: s ? s.reason : 'No task recorded for this agent yet.',
      active_task: active ? taskSummary(active) : null,
      current_step: active ? currentStep(active, officeTaskState(active)) : null,
      last_completed: verifiedTasks[0] ? taskSummary(verifiedTasks[0]) : null,
      next_scheduled: next,
      blockers,
      last_update_at: latest ? iso(latest.updated_at || latest.created_at) : null,
      last_verified_at: verifiedAt.length ? new Date(Math.max(...verifiedAt)).toISOString() : null,
    },
  };
}

// The conversation for one task, as recorded. Items with no record time keep a null time (shown as "Not recorded").
// A task has one timestamp (its last update), so result, review and error items use it and say so in time_note.
function taskMessages(task, data) {
  const out = [];
  const who = str(task.partner_name) || 'Agent';
  const s = officeTaskState(task);
  const base = { task_id: str(task.id), task_title: str(task.task), task_state: s.state, task_raw_status: s.raw };
  const requestText = str(task.task);
  const lastWrite = iso(task.updated_at || task.created_at);
  const lastWriteNote = 'Time is the task last-update time; this item has no time of its own.';
  out.push({
    ...base,
    kind: 'request',
    speaker: task.source === 'owner' ? 'Owner' : (str(task.source) || 'Not recorded'),
    to: who,
    at: iso(task.created_at),
    text: requestText,
    details: {
      record_id: str(task.id),
      stored_length: requestText.length,
      stored_limit: STORED_REQUEST_LIMIT,
      cut_when_stored: requestText.length >= STORED_REQUEST_LIMIT,
      kind: str(task.kind) || null,
      browse: task.browse === true,
      use_computer: task.use_computer === true,
      office_job_id: str(task.job_id) || null,
    },
  });
  for (const note of Array.isArray(task.steering) ? task.steering : []) {
    out.push({
      ...base, kind: 'steering', speaker: 'Owner', to: who, at: iso(note.at), text: str(note.text),
      details: { record_id: str(task.id), steering_version: task.steering_version ?? null },
    });
  }
  for (const h of Array.isArray(task.handoffs) ? task.handoffs : []) {
    out.push({
      ...base,
      kind: 'handoff',
      speaker: str(h.from_agent_name) || who,
      to: str(h.to_agent_name) || 'Not recorded',
      at: iso(h.at),
      text: str(h.note) || 'Handed off. No note was recorded.',
      details: { from_provider: str(h.from_provider) || null, to_provider: str(h.to_provider) || null, carried: h.carried || null },
    });
  }
  if (str(task.prior_result)) {
    out.push({ ...base, kind: 'prior_result', speaker: who, to: 'CHE', at: lastWrite, text: str(task.prior_result), details: { record_id: str(task.id), time_note: lastWriteNote } });
  }
  if (str(task.result)) {
    out.push({
      ...base,
      kind: 'result',
      speaker: who,
      to: 'CHE',
      at: lastWrite,
      text: str(task.result),
      details: {
        record_id: str(task.id),
        time_note: lastWriteNote,
        provider_trail: (Array.isArray(task.provider_trail) ? task.provider_trail : []).map((p) => ({
          provider: str(p.provider) || null, model: str(p.model) || null, agent: str(p.agent) || null, at: iso(p.at),
        })),
        artifacts: Array.isArray(task.artifacts) ? task.artifacts.length : null,
        citations: Array.isArray(task.citations) ? task.citations.length : null,
      },
    });
  }
  if (str(task.che_review)) {
    out.push({ ...base, kind: 'review', speaker: 'CHE', to: who, at: lastWrite, text: str(task.che_review), details: { record_id: str(task.id), verified_by_che: task.verified_by_che === true, time_note: lastWriteNote } });
  }
  if (str(task.review_feedback)) {
    out.push({ ...base, kind: 'review_feedback', speaker: 'CHE', to: who, at: lastWrite, text: str(task.review_feedback), details: { record_id: str(task.id), revision_count: task.revision_count ?? null, time_note: lastWriteNote } });
  }
  if (str(task.error)) {
    out.push({ ...base, kind: 'error', speaker: 'Office runtime', to: 'CHE', at: lastWrite, text: str(task.error), details: { record_id: str(task.id), time_note: lastWriteNote } });
  }
  const job = task.job_id ? (data.jobs || []).find((j) => j && j.id === task.job_id) : null;
  if (job) {
    const jobStatus = str(job.state || job.status) || 'not recorded';
    const evidence = [
      job.pr_number ? `PR #${job.pr_number}` : '',
      str(job.pr_url),
      job.merge_commit_sha ? `merge commit ${String(job.merge_commit_sha).slice(0, 12)}` : '',
    ].filter(Boolean);
    out.push({
      ...base,
      kind: 'evidence',
      speaker: 'Coding job record',
      to: 'CHE',
      at: iso(job.updated_at || job.created_at),
      text: evidence.length
        ? `Linked coding job ${job.id}: ${evidence.join(', ')}. Job status: ${jobStatus}.`
        : `Linked coding job ${job.id}. Job status: ${jobStatus}. No PR or commit is recorded.`,
      details: { record_id: str(job.id), pr_number: job.pr_number ?? null, pr_url: str(job.pr_url) || null, merge_commit_sha: str(job.merge_commit_sha) || null },
    });
  }
  for (const goal of (data.office_goals || []).filter((g) => g && g.coordinated)) {
    const onStage = (goal.stages || []).some((st) => st && st.task_id === task.id);
    if (!onStage && !(goal.job_ids || []).includes(task.id)) continue;
    for (const ev of Array.isArray(goal.history) ? goal.history : []) {
      out.push({
        ...base,
        kind: 'job_event',
        speaker: str(ev.actor) || 'Office',
        to: 'Office job',
        at: iso(ev.at),
        text: [str(ev.event), str(ev.detail)].filter(Boolean).join(': '),
        details: { record_id: str(goal.id), job_goal: str(goal.goal || goal.request), stage: str(ev.stage) || null },
      });
    }
  }
  return out;
}

function meetingItems(meeting) {
  const items = [];
  const base = { meeting_id: str(meeting.id), meeting_objective: str(meeting.objective), meeting_status: str(meeting.status) };
  for (const post of Array.isArray(meeting.board) ? meeting.board : []) {
    items.push({
      ...base,
      kind: 'meeting',
      speaker: str(post.from) || 'Not recorded',
      to: str(post.to) || 'War Room',
      at: iso(post.at),
      text: str(post.text),
      details: { post_kind: str(post.kind) || null, agent_id: str(post.agent_id) || null, failed: post.failed === true },
    });
  }
  const outcomes = [
    ...(Array.isArray(meeting.decisions) ? meeting.decisions.map((d) => ['Decision', d]) : []),
    ...(Array.isArray(meeting.conflicts) ? meeting.conflicts.map((d) => ['Conflict', d]) : []),
    ...(Array.isArray(meeting.recommendations) ? meeting.recommendations.map((d) => ['Recommendation', d]) : []),
  ];
  for (const [label, text] of outcomes) {
    items.push({
      ...base,
      kind: 'meeting_outcome',
      speaker: 'CHE',
      to: 'War Room',
      at: iso(meeting.updated_at || meeting.created_at),
      text: `${label}: ${str(text)}`,
      details: { record_id: str(meeting.id), time_note: 'Time is the War Room last-update time.' },
    });
  }
  return items;
}

// Oldest first, so the newest message is last. Messages with no recorded time keep their build order and go after
// the timed ones; their time is shown as "Not recorded".
function sortMessages(messages) {
  return messages
    .map((m, i) => ({ m, i, t: ts(m.at) }))
    .sort((a, b) => {
      if (a.t == null && b.t == null) return a.i - b.i;
      if (a.t == null) return 1;
      if (b.t == null) return -1;
      return a.t - b.t || a.i - b.i;
    })
    .map((x, n) => ({ seq: n + 1, ...x.m }));
}

/**
 * The read record for the owner's conversation screen. Pass exactly one of taskId or agentId. Returns
 * { error, status } when the id is not in the record.
 */
export function officeConversation(data, { taskId = '', agentId = '', generatedAt = new Date().toISOString() } = {}) {
  const teamTasks = Array.isArray(data?.team_tasks) ? data.team_tasks : [];
  const team = Array.isArray(data?.team) ? data.team : [];
  const meetings = Array.isArray(data?.meetings) ? data.meetings : [];
  if (taskId) {
    const task = teamTasks.find((t) => t && t.id === taskId);
    if (!task) return { error: 'There is no Office task with that id.', status: 404 };
    const agent = team.find((a) => a && a.id === task.partner_id) || null;
    return {
      scope: 'task',
      generated_at: generatedAt,
      agent: agent ? agentLocalState(data, agent).agent : null,
      task: taskSummary(task),
      tasks: [taskSummary(task)],
      messages: sortMessages(taskMessages(task, data)),
      meetings: [],
      notes: [],
    };
  }
  if (agentId) {
    const agent = team.find((a) => a && !a.retired && a.id === agentId);
    if (!agent) return { error: 'There is no Office agent with that id.', status: 404 };
    const local = agentLocalState(data, agent);
    const tasks = local.tasks.slice(0, AGENT_HISTORY_LIMIT);
    const messages = [];
    for (const t of tasks) messages.push(...taskMessages(t, data));
    const agentMeetings = meetings
      .filter((m) => m && (m.participants || []).some((p) => p.agent_id === agent.id))
      .slice(0, 10);
    for (const m of agentMeetings) messages.push(...meetingItems(m));
    return {
      scope: 'agent',
      generated_at: generatedAt,
      agent: local.agent,
      task: local.agent.active_task || (tasks[0] ? taskSummary(tasks[0]) : null),
      tasks: tasks.map(taskSummary),
      messages: sortMessages(messages),
      meetings: agentMeetings.map((m) => ({ id: str(m.id), objective: str(m.objective), status: str(m.status), created_at: iso(m.created_at), updated_at: iso(m.updated_at) })),
      notes: local.tasks.length > AGENT_HISTORY_LIMIT ? [`Only the newest ${AGENT_HISTORY_LIMIT} tasks are shown.`] : [],
    };
  }
  return { error: 'Give an agent_id or a task_id.', status: 400 };
}
