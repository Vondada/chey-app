// Codex work packets. One owner Codex credential lives on the Worker only
// (CODEX_OWNER_TOKEN); packets never carry it, and agents never see it.
// Isolation is a real per-job thread id and workspace, not a tag.
import { codexThreadId } from './office_router.js';

export function makeWorkPacket({ jobId, agentId, goal, files = [] }) {
  const agent = String(agentId || '').toLowerCase();
  return {
    packet_id: `pkt_${jobId}`,
    job_id: jobId,
    agent_id: agent,
    thread_id: codexThreadId(agent, jobId),
    workspace: `codex-ws/${agent}/${jobId}`,
    goal: String(goal || ''),
    files: Array.isArray(files) ? files.map(String).slice(0, 50) : [],
    constraints: ['report_to_che_only', 'no_merge', 'no_spend', 'no_payouts'],
    status: 'queued',
    created_at: new Date().toISOString(),
  };
}

// Marks a packet running when the owner credential exists, otherwise blocks
// it honestly. Returns a new object; the token is read, never copied in.
export function startCodexJob(env, packet) {
  const hasToken = Boolean(env?.CODEX_OWNER_TOKEN || env?.CHATGPT_CODEX_TOKEN);
  if (!hasToken) return { ...packet, status: 'Blocked: tool not configured (Codex)' };
  return { ...packet, status: 'running', started_at: new Date().toISOString() };
}

// Persists a packet on the Durable Object state (bounded), replacing any
// earlier packet for the same job.
export function savePacket(data, packet) {
  data.office_packets = Array.isArray(data.office_packets) ? data.office_packets : [];
  data.office_packets = data.office_packets.filter((p) => p.packet_id !== packet.packet_id);
  data.office_packets.unshift(packet);
  data.office_packets = data.office_packets.slice(0, 100);
  return packet;
}
