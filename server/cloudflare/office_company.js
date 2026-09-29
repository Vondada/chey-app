// Canonical La Agencia roster. Existing matching agents keep their IDs,
// workspaces and task history; this only fills/updates company responsibilities.
export const LA_AGENCIA_ROLES = {
  Nova: { role: 'Product / listings', specialty: 'Product offers, listings and sales-page drafts', provider_preference: 'openai', capability_requirements: ['coding'] },
  Atlas: { role: 'Research', specialty: 'Research, sourcing and competitive checks', provider_preference: 'xai', capability_requirements: ['deep_reasoning'] },
  Mira: { role: 'Customer / support copy', specialty: 'Customer-facing support and service copy', provider_preference: 'xai', capability_requirements: ['text'] },
  Knox: { role: 'Engineering / Codex jobs', specialty: 'Implementation, tests and isolated Codex work packets', provider_preference: 'openai', capability_requirements: ['coding'] },
  Sage: { role: 'Finance / Stripe reports', specialty: 'Read-only Stripe reporting and finance summaries', provider_preference: 'auto', capability_requirements: ['payments_read'] },
  Lyra: { role: 'Content / social', specialty: 'Content, social copy and campaign drafts', provider_preference: 'xai', capability_requirements: ['text'] },
};

export function ensureLaAgenciaRoster(data) {
  const at = new Date().toISOString();
  for (const [name, spec] of Object.entries(LA_AGENCIA_ROLES)) {
    let agent = data.team.find((a) => String(a.name || '').toLowerCase() === name.toLowerCase() && !a.retired);
    if (!agent) {
      agent = { id: crypto.randomUUID(), name, kind: 'CHE AI coworker', status: 'available', introduced: true, created_at: at };
      data.team.push(agent);
    }
    agent.role = spec.role;
    agent.specialty = spec.specialty;
    agent.provider_preference = spec.provider_preference;
    agent.capability_requirements = spec.capability_requirements;
    agent.permissions = ['office_workspace', 'che_memory_read_filtered'];
    agent.reports_to = 'CHE';
    agent.owner_messaging = false;
    agent.can_merge_code = false;
    agent.can_spend_money = false;
    agent.can_open_payouts = false;
    agent.workspace_key = 'office/' + name.toLowerCase();
    agent.updated_at = agent.updated_at || at;
  }
  data.team = data.team.filter((a) => a && !a.retired).slice(-24);
  return data.team;
}

export function officeToolBlocker(env, agent) {
  const pref = String(agent?.provider_preference || '').toLowerCase();
  if (pref === 'openai' && !(env.CHE_OPENAI_API_KEY || env.OPENAI_API_KEY)) return 'Blocked: Codex/OpenAI tool not configured';
  if (pref === 'xai' && !(env.XAI_API_KEY || env.CHE_XAI_API_KEY || env.CHE_XAI_MODEL_URL)) return 'Blocked: Grok/xAI tool not configured';
  if (String(agent?.name) === 'Sage' && !env.STRIPE_SECRET_KEY) return 'Blocked: Stripe not connected';
  return '';
}
