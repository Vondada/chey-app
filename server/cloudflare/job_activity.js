// Live feedback for background jobs: a short, timestamped log of what CHE is
// checking and doing, so the owner can see and hear progress as it happens.
// Capped at the newest 40 lines, each at most 240 characters.
export function noteJobActivity(job, text, now = new Date()) {
  if (!job || !text) return;
  const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!line) return;
  job.activity = [...(Array.isArray(job.activity) ? job.activity : []), { at: now.toISOString(), text: line }].slice(-40);
}
