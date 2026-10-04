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
      id: `meeting:${m.id}`, kind: 'war_room', title: clip(m.objective || m.title || m.topic || m.goal || 'War Room meeting', 90),
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
  // Office work as it is really recorded: each agent's assignments from CHE,
  // CHE's steering, the agent's delivered result and CHE's review.
  const byAgent = new Map();
  for (const t of Array.isArray(data.team_tasks) ? data.team_tasks : []) {
    if (!t?.partner_id) continue;
    const name = clip(t.partner_name || 'Agent', 40);
    const list = byAgent.get(t.partner_id) || { name, messages: [] };
    list.messages.push({ from: 'CHE', to: name, kind: 'task', text: clip(t.task, 3000), at: t.created_at || '' });
    for (const st of Array.isArray(t.steering) ? t.steering : []) list.messages.push({ from: 'CHE', to: name, kind: 'steering', text: clip(st.text, 3000), at: st.at || '' });
    if (t.result) list.messages.push({ from: name, to: 'CHE', kind: 'result', text: clip(t.result, 3000), at: t.updated_at || '' });
    if (t.review_feedback) list.messages.push({ from: 'CHE', to: name, kind: 'review', text: clip(t.review_feedback, 3000), at: t.updated_at || '' });
    byAgent.set(t.partner_id, list);
  }
  const seenAgents = new Set(threads.filter((t) => t.kind === 'office').map((t) => t.id));
  for (const [id, { name, messages }] of byAgent) {
    const msgs = messages.filter((m) => m.text).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (!msgs.length || seenAgents.has(`agent:${id}`)) continue;
    threads.push({ id: `agent:${id}`, kind: 'office', title: name, participants: [...new Set(msgs.map((x) => x.from))], status: '', messages: msgs.slice(-60), updated_at: lastAt(msgs) });
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
