// CHE speaks new blockers without being asked. Dedup keys persist on the
// Durable Object (passed in as `spoken`) so a poll never repeats a line, and a
// cleared blocker that comes back is spoken again.

function toolName(status) {
  const inner = String(status).match(/\(([^)]+)\)/);
  return inner ? inner[1].trim() : '';
}

export function cheBlockerSpeech(agentName, status, spoken = new Set()) {
  const s = String(status || '');
  if (!s.startsWith('Blocked:')) return null;
  const key = `${String(agentName).toLowerCase()}:${s}`;
  if (spoken.has(key)) return null;
  spoken.add(key);
  if (s.startsWith('Blocked: tool not configured')) {
    const tool = toolName(s) || 'a required tool';
    return `CHE here. Blocked: tool not configured. ${agentName} cannot start until ${tool} is connected on the Worker.`;
  }
  return `CHE here. ${agentName} is blocked. ${s.replace(/^Blocked:\s*/, '')}`;
}

// Walks the board's desks and returns CHE's new spoken lines. `spokenKeys` is
// the persisted array; it is rewritten to only the blockers still active.
export function newBlockerAnnouncements(desks, spokenKeys = []) {
  const spoken = new Set(spokenKeys);
  const active = new Set();
  const lines = [];
  for (const desk of desks || []) {
    if (desk?.state !== 'blocked') continue;
    active.add(`${String(desk.name).toLowerCase()}:${desk.status}`);
    const line = cheBlockerSpeech(desk.name, desk.status, spoken);
    if (line) lines.push(line);
  }
  return { lines, keys: [...spoken].filter((k) => active.has(k)) };
}
