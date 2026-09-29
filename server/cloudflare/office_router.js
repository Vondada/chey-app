const AGENTS = new Set(['nova', 'atlas', 'mira', 'knox', 'sage', 'lyra']);

export function assertOwnerTalksToCheOnly(body) {
  const speaker = String(body?.speaker || body?.from || 'owner').toLowerCase();
  const target = String(body?.target || body?.to || 'che').toLowerCase();
  if (AGENTS.has(speaker)) {
    throw Object.assign(new Error('agents_report_to_che_only'), { status: 403 });
  }
  if (speaker === 'owner' && target !== 'che') {
    throw Object.assign(new Error('owner_talks_to_che_only'), { status: 403 });
  }
}

export function grokEnvelope({ agentId, jobId, prompt }) {
  if (!AGENTS.has(String(agentId || '').toLowerCase())) {
    throw Object.assign(new Error('unknown_agent'), { status: 400 });
  }
  return {
    router: 'che',
    agent_id: String(agentId).toLowerCase(),
    job_id: jobId || null,
    prompt: String(prompt || ''),
  };
}

export function codexThreadId(agentId, jobId) {
  return `office/${String(agentId).toLowerCase()}/${jobId || 'desk'}`;
}

export function toolBlocker(env) {
  const missing = [];
  if (!env.STRIPE_SECRET_KEY) missing.push('Stripe');
  if (!env.CODEX_OWNER_TOKEN && !env.CHATGPT_CODEX_TOKEN) missing.push('Codex');
  if (!env.XAI_API_KEY && !env.GROK_API_KEY) missing.push('Grok');
  return missing.length ? `Blocked: tool not configured (${missing.join(', ')})` : null;
}
