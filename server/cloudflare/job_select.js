// Which queued background jobs start now (moved out of worker.js for its size budget; behaviour unchanged).
// Keep independent background work parallel, but serialize skill imports.
// Two imports both update office_skills/team and must never race snapshots.
export function selectReadyJobs(jobs, now = Date.now(), limit = 4) {
  const all = Array.isArray(jobs) ? jobs : [];
  const ready = all
    .filter((job) => job.status === 'queued' && !job.dead_letter && (!job.retry_at || job.retry_at <= now));
  const selected = [];
  // A running import occupies the serialized slot across later alarms /
  // concurrent processJobs invocations. Unrelated work can still run.
  let officeSkillImportTaken = all.some((job) =>
    job.kind === 'office_skill_import' && job.status === 'running' && !job.dead_letter);
  // Jobs that share a lane (e.g. the topics of one study request) run one at
  // a time in lane_order, so topic 1 finishes before topic 2 starts.
  const busyLanes = new Set(all.filter((job) => job.lane && job.status === 'running' && !job.dead_letter).map((job) => job.lane));
  const laneHead = new Map();
  for (const job of all) {
    if (!job.lane || job.status !== 'queued' || job.dead_letter) continue;
    const head = laneHead.get(job.lane);
    if (!head || Number(job.lane_order || 0) < Number(head.lane_order || 0)) laneHead.set(job.lane, job);
  }
  for (const job of ready) {
    if (job.lane) {
      if (busyLanes.has(job.lane) || laneHead.get(job.lane) !== job) continue;
      busyLanes.add(job.lane);
    }
    if (job.kind === 'office_skill_import') {
      if (officeSkillImportTaken) continue;
      officeSkillImportTaken = true;
    }
    selected.push(job);
    if (selected.length >= limit) break;
  }
  return selected;
}
