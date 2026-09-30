// Canonical La Agencia roster. Existing matching agents keep their IDs,
// workspaces and task history; this only fills/updates company responsibilities.
export const LA_AGENCIA_ROLES = {
  Nova: { role: 'Product / listings', specialty: 'Product offers, listings and sales-page drafts', provider_preference: 'openai', capability_requirements: ['coding'] },
  Atlas: { role: 'Research', specialty: 'Research, sourcing and competitive checks', provider_preference: 'xai', capability_requirements: ['deep_reasoning'] },
  Mira: { role: 'Customer / support copy', specialty: 'Customer-facing support and service copy', provider_preference: 'xai', capability_requirements: ['text'] },
  Knox: { role: 'Engineering / Codex jobs', specialty: 'Implementation, tests and isolated Codex work packets', provider_preference: 'openai', capability_requirements: ['coding'] },
  Sage: { role: 'Finance / Stripe reports', specialty: 'Read-only Stripe reporting and finance summaries', provider_preference: 'auto', capability_requirements: ['payments_read'] },
  Lyra: { role: 'Content / social', specialty: 'Content, social copy and campaign drafts', provider_preference: 'xai', capability_requirements: ['text'] },
  Iris: { role: 'Ad Studio / paid-social creatives', specialty: 'Ad creatives, visual briefs, captions and same-night social packages', provider_preference: 'xai', capability_requirements: ['text'] },
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

// La Agencia agents need their tool on the server (one owner credential each,
// stored only as Worker secrets). A missing tool blocks the job honestly.
export function officeToolBlocker(env, agent) {
  const pref = String(agent?.provider_preference || '').toLowerCase();
  if (String(agent?.name) === 'Sage' && !env.STRIPE_SECRET_KEY) return 'Blocked: tool not configured (Stripe not connected)';
  if (pref === 'openai' && !(env.CODEX_OWNER_TOKEN || env.CHE_OPENAI_API_KEY || env.OPENAI_API_KEY)) return 'Blocked: tool not configured (Codex)';
  if (pref === 'xai' && !(env.XAI_API_KEY || env.CHE_XAI_API_KEY || env.GROK_API_KEY || env.CHE_XAI_MODEL_URL)) return 'Blocked: tool not configured (Grok)';
  return '';
}

export function isLaAgenciaAgent(agent) {
  return Boolean(agent && LA_AGENCIA_ROLES[agent.name] && String(agent.workspace_key || '').startsWith('office/'));
}

const GOAL_ROUTES = [
  ['Knox', /\b(?:code|coding|build|app|bug|fix|deploy|api|website|site|feature|test|codex)\b/],
  ['Sage', /\b(?:stripe|revenue|finance|money|sales|earnings|invoice|report on (?:sales|money))\b/],
  ['Nova', /\b(?:product|listing|listings|offer|pricing|price|sales page|store|shop)\b/],
  ['Mira', /\b(?:customer|support|reply|replies|email|faq|help desk|service)\b/],
  ['Iris', /\b(?:ads?|ad studio|tonight pack|ad creatives?|flyer|banner|paid social|creative brief|caption pack)\b/],
  ['Lyra', /\b(?:social|post|posts|content|instagram|tiktok|caption|campaign|video|blog)\b/],
  ['Atlas', /\b(?:research|competitor|competitors|find|source|compare|market|look up|fiverr|scout)\b/],
];

// CHE splits one owner goal into Office jobs, one per clause, each routed to
// the La Agencia agent whose role fits. Deterministic so the owner hears
// exactly what was queued.
export function splitGoal(goal) {
  const text = String(goal || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const parts = text
    .split(/(?:[.;]\s+|,?\s+(?:and then|then|and also|also)\s+|,\s+and\s+|\s+and\s+(?=(?:build|write|research|find|make|draft|post|fix|report|create|list|reply|answer|compare|ship)\b))/i)
    .map((part) => part.replace(/[.;,]+$/, '').trim())
    .filter((part) => part.split(' ').length >= 2)
    .slice(0, 6);
  const jobs = (parts.length ? parts : [text]).map((part) => {
    const lower = part.toLowerCase();
    // A leading research verb wins ("research sites like ours" is Atlas's).
    const hit = /^(?:research|find|compare|look up)\b/.test(lower)
      ? ['Atlas']
      : GOAL_ROUTES.find(([, pattern]) => pattern.test(lower));
    return { agent: hit ? hit[0] : 'Atlas', task: part.charAt(0).toUpperCase() + part.slice(1) };
  });
  return jobs;
}
