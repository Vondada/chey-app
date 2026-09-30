// CHE is the only voice in the Office. The owner talks only to CHE; agents
// report only to CHE. Enforced here in code, not only in model prompts.
export const OFFICE_AGENTS = ['nova', 'atlas', 'mira', 'knox', 'sage', 'lyra', 'iris'];
const AGENTS = new Set(OFFICE_AGENTS);

function refusal(message) {
  return Object.assign(new Error(message), { status: 403 });
}

export function assertOwnerTalksToCheOnly(body) {
  const speaker = String(body?.speaker || body?.from || 'owner').toLowerCase();
  const target = String(body?.target || body?.to || 'che').toLowerCase();
  if (speaker === 'owner' && target !== 'che') throw refusal('owner_talks_to_che_only');
  if (AGENTS.has(speaker) && target !== 'che') throw refusal('agents_report_to_che_only');
  if (speaker !== 'owner' && !AGENTS.has(speaker)) throw refusal('unknown_speaker');
  return { speaker, target: 'che' };
}

export function grokEnvelope({ agentId, jobId, prompt }) {
  if (!AGENTS.has(String(agentId || '').toLowerCase())) {
    throw Object.assign(new Error('unknown_agent'), { status: 400 });
  }
  return {
    router: 'che',
    agent_id: String(agentId).toLowerCase(),
    job_id: jobId || null,
    thread_id: codexThreadId(agentId, jobId),
    prompt: String(prompt || ''),
  };
}

export function codexThreadId(agentId, jobId) {
  return `office/${String(agentId).toLowerCase()}/${jobId || 'desk'}`;
}

export function toolBlocker(env) {
  const missing = [];
  if (!env.STRIPE_SECRET_KEY) missing.push('Stripe');
  if (!env.CODEX_OWNER_TOKEN && !env.CHE_OPENAI_API_KEY && !env.OPENAI_API_KEY) missing.push('Codex');
  if (!env.XAI_API_KEY && !env.CHE_XAI_API_KEY && !env.GROK_API_KEY) missing.push('Grok');
  return missing.length ? `Blocked: tool not configured (${missing.join(', ')})` : null;
}

// A Codex work packet: everything one agent's isolated thread needs, with no
// credential inside it. The single owner Codex credential stays a Worker
// secret; each agent gets its own thread under office/<agent>/.
export function codexWorkPacket(agent, task, createdAt = new Date().toISOString()) {
  const agentId = String(agent?.name || agent?.id || '').toLowerCase();
  return {
    kind: 'codex_work_packet',
    version: 1,
    agent_id: agentId,
    agent_name: String(agent?.name || ''),
    role: String(agent?.role || ''),
    workspace: `office/${agentId}`,
    thread_id: codexThreadId(agentId, task?.job_id || task?.id),
    job_id: String(task?.id || ''),
    objective: String(task?.task || ''),
    credential: 'owner_codex',
    constraints: [
      'Report results to CHE only; never message the owner.',
      'Work on a branch; never merge, spend money or open payouts.',
      'Say plainly when something could not be done.',
    ],
    report_to: 'che',
    created_at: createdAt,
  };
}
