// The Office's job queue rules (owner, 2026-10-26, "work like a real business"). Pure functions over the existing
// team_tasks records: a job has an owner, a priority and a due time, and it counts as done only with evidence (a
// result plus a test run, a changed file, or CHE's own check). The runtime and the Office view both call these.

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

/** The evidence a job carries: the result, the tests it ran and the files it changed. */
export function evidenceOf(task) {
  const e = task && typeof task.evidence === 'object' && task.evidence ? task.evidence : {};
  return {
    result: String(task?.result || '').trim(),
    tests: Array.isArray(e.tests) ? e.tests.filter(Boolean) : [],
    files: Array.isArray(e.files) ? e.files.filter(Boolean) : [],
  };
}

/** Whether a job may count as done, and what is still missing if not. */
export function closeCheck(task) {
  const e = evidenceOf(task);
  const missing = [];
  if (!e.result) missing.push('a result');
  if (!e.tests.length && !e.files.length && task?.verified_by_che !== true) missing.push('a test run, a changed file, or a check by CHE');
  return { ok: missing.length === 0, missing };
}

/** The state a job shows in the queue. A "done" with no evidence is shown as needs_evidence, never as done. */
export function jobState(task) {
  const status = String(task?.status || '');
  if (status === 'done' || status === 'completed') return closeCheck(task).ok ? 'done' : 'needs_evidence';
  if (status === 'blocked') return 'blocked';
  if (status === 'running' || status === 'reviewing') return 'running';
  return 'queued';
}

const rank = (p) => {
  const i = PRIORITIES.indexOf(String(p || 'normal'));
  return i < 0 ? PRIORITIES.indexOf('normal') : i;
};

/** Open jobs in the order they should be worked: priority, then the earliest due time (none last), then arrival. */
export function queueOrder(tasks) {
  return (tasks || [])
    .filter((t) => !['done', 'completed'].includes(String(t?.status || '')))
    .map((t, index) => ({ t, index }))
    .sort((a, b) => {
      const byPriority = rank(a.t.priority) - rank(b.t.priority);
      if (byPriority) return byPriority;
      const da = Date.parse(a.t.due_at || '') || Infinity;
      const db = Date.parse(b.t.due_at || '') || Infinity;
      if (da !== db) return da < db ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ t }) => t);
}

/** Open jobs per owner, so an overloaded member is visible before more work is given to them. */
export function workload(tasks) {
  const counts = {};
  for (const t of tasks || []) {
    if (['done', 'completed'].includes(String(t?.status || '')) || !t?.owner_id) continue;
    counts[t.owner_id] = (counts[t.owner_id] || 0) + 1;
  }
  return counts;
}
