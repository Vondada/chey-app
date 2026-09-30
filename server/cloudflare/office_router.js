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
