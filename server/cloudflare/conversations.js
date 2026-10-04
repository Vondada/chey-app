// Every conversation between CHE's AIs and agents, shaped as phone group
// chats: War Room meetings, Office agent threads and coding-crew discussions.
// Read-only views of real records; nothing here writes or invents messages.

export const CREW_THREADS_KEY = 'che_crew_threads';
const MAX_CREW_THREADS = 60;

const clip = (v, n) => String(v ?? '').slice(0, n);

// Saves one coding job's crew discussion (planners, engineers, reviewers).
export async function recordCrewThread(storage, { request, discussion, outcome }) {
  if (!storage?.put || !Array.isArray(discussion) || !discussion.length) return;
  let threads = [];
  try { threads = (await storage.get(CREW_THREADS_KEY)) || []; } catch (_) {}
  if (!Array.isArray(threads)) threads = [];
  const at = new Date().toISOString();
  threads.push({
    id: crypto.randomUUID(),
    title: clip(String(request || 'Coding job').replace(/^\s*(?:update|change) your code\s*:?\s*/i, ''), 90),
    outcome: clip(outcome, 200),
    at,
    messages: discussion.slice(-40).map((m) => ({ from: clip(m.from || 'Crew', 40), text: clip(m.msg ?? m.text, 1500), at })),
  });
  await storage.put(CREW_THREADS_KEY, threads.slice(-MAX_CREW_THREADS)).catch?.(() => null);
}

function lastAt(messages, fallback) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].at) return messages[i].at;
  return fallback || '';
}

// All threads, newest activity first.
export function conversationThreads(data = {}, crewThreads = []) {
  const threads = [];
  for (const m of Array.isArray(data.meetings) ? data.meetings : []) {
    const messages = (Array.isArray(m.board) ? m.board : []).map((p) => ({
      from: clip(p.from || 'Agent', 40), to: p.to ? clip(p.to, 40) : null, kind: clip(p.kind, 20), text: clip(p.text, 3000), at: p.at || m.updated_at || m.created_at || '',
    })).filter((p) => p.text);
    if (!messages.length) continue;
    threads.push({
      id: `meeting:${m.id}`, kind: 'war_room', title: clip(m.title || m.topic || m.goal || 'War Room meeting', 90),
      participants: [...new Set(messages.map((p) => p.from))], status: m.status || '', messages, updated_at: lastAt(messages, m.updated_at),
    });
  }
  for (const a of Array.isArray(data.agents) ? data.agents : []) {
    const messages = (Array.isArray(a.messages) ? a.messages : []).map((x) => ({
      from: clip(x.from || a.name, 40), to: x.to ? clip(x.to, 40) : null, text: clip(x.text, 3000), at: x.at || '',
    })).filter((x) => x.text);
    if (!messages.length) continue;
    threads.push({
      id: `agent:${a.id}`, kind: 'office', title: clip(a.name || 'Agent', 60),
      participants: [...new Set(messages.map((x) => x.from))], status: a.status || '', messages, updated_at: lastAt(messages),
    });
  }
  for (const t of Array.isArray(crewThreads) ? crewThreads : []) {
    const messages = Array.isArray(t.messages) ? t.messages : [];
    if (!messages.length) continue;
    threads.push({
      id: `crew:${t.id}`, kind: 'crew', title: clip(t.title || 'Coding job', 90),
      participants: [...new Set(messages.map((x) => x.from))], status: t.outcome || '', messages, updated_at: t.at || lastAt(messages),
    });
  }
  return threads.sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
}
