// Canonical La Agencia roster (report to CHE, the Office Boss). Existing matching agents keep their IDs,
// workspaces and task history; this only fills/updates company responsibilities.
export const LA_AGENCIA_ROLES = {
  Nova: { role: 'Product / listings', specialty: 'Product offers, listings and sales-page drafts', provider_preference: 'openai', capability_requirements: ['coding'] },
  Atlas: { role: 'Research', specialty: 'Research, sourcing and competitive checks', provider_preference: 'auto', capability_requirements: ['deep_reasoning'] },
  Mira: { role: 'Customer / support copy', specialty: 'Customer-facing support, service copy, and translation / multilingual drafts', provider_preference: 'auto', capability_requirements: ['text'] },
  Knox: { role: 'Engineering / Codex jobs', specialty: 'Implementation, tests, Codex packets, and Roblox/Luau experience drafts (games, weapons, UGC clothing, passes)', provider_preference: 'openai', model_preference: 'gpt-5.3-codex', capability_requirements: ['coding'] },
  Sage: { role: 'Finance / Stripe reports', specialty: 'Read-only Stripe reporting and finance summaries', provider_preference: 'auto', capability_requirements: ['payments_read'] },
  Lyra: { role: 'Content / social', specialty: 'Content, social copy and campaign drafts', provider_preference: 'auto', capability_requirements: ['text'] },
  Iris: { role: 'Ad Studio / paid-social creatives', specialty: 'Ad creatives, visual briefs, captions and same-night social packages', provider_preference: 'auto', capability_requirements: ['text'] },
  Scout: { role: 'Trend scout', specialty: 'Finds topic titles from connected feeds for the video desk. Does not invent demand.', provider_preference: 'auto', capability_requirements: ['research'] },
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
    agent.model_preference = spec.model_preference || agent.model_preference || '';
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
  if (String(agent?.name) === 'Scout' && !env.CHE_TREND_URLS) return 'Blocked: tool not configured (no trend feed)';
  if (pref === 'openai' && !(env.CODEX_OWNER_TOKEN || env.CHE_OPENAI_API_KEY || env.OPENAI_API_KEY)) return 'Blocked: tool not configured (Codex)';
  if (pref === 'xai' && !(env.XAI_API_KEY || env.CHE_XAI_API_KEY || env.GROK_API_KEY || env.CHE_XAI_MODEL_URL)) return 'Blocked: tool not configured (Grok)';
  return '';
}

export function isLaAgenciaAgent(agent) {
  return Boolean(agent && LA_AGENCIA_ROLES[agent.name] && String(agent.workspace_key || '').startsWith('office/'));
}

const GOAL_ROUTES = [
  ['Knox', /\b(?:code|coding|build|app|bug|fix|deploy|api|website|site|feature|test|codex|roblox|luau|ugc|game\s*pass|classif|cluster|k-?means|k-?nn|ml\b|machine learning)\b/],
  ['Sage', /\b(?:stripe|revenue|finance|money|sales|earnings|invoice|report on (?:sales|money))\b/],
  ['Nova', /\b(?:product|listing|listings|offer|pricing|price|sales page|store|shop|roblox\s+pass|game\s*pass|ugc)\b/],
  ['Mira', /\b(?:customer|support|reply|replies|email|faq|help desk|service|translat|locale|language|multilingual)\b/],
  ['Iris', /\b(?:ads?|ad studio|tonight pack|ad creatives?|flyer|banner|paid social|creative brief|caption pack)\b/],
  ['Scout', /\b(?:scout|trending|trends|topic|topics|what's hot|what is hot|video ideas)\b/],
  ['Lyra', /\b(?:social|post|posts|content|instagram|tiktok|caption|campaign|video|blog|clothing|avatar|ugc)\b/],
  ['Atlas', /\b(?:research|competitor|competitors|find|source|compare|market|look up|fiverr|metrics|evaluat|learning notes)\b/],
];

export function splitGoal(goal) {
  const text = String(goal || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const parts = text
    .split(/(?:[.;]\s+|,?\s+(?:and then|then|and also|also)\s+|,\s+and\s+|\s+and\s+(?=(?:build|write|research|find|make|draft|post|fix|report|create|list|reply|answer|compare|ship|scout)\b))/i)
    .map((part) => part.replace(/[.;,]+$/, '').trim())
    .filter((part) => part.split(' ').length >= 2)
    .slice(0, 6);
  const jobs = (parts.length ? parts : [text]).map((part) => {
    const lower = part.toLowerCase();
    const hit = /^(?:scout|find trending|find topics)\b/.test(lower)
      ? ['Scout']
      : /^(?:research|find|compare|look up)\b/.test(lower)
        ? ['Atlas']
        : GOAL_ROUTES.find(([, pattern]) => pattern.test(lower));
    return { agent: hit ? hit[0] : 'Atlas', task: part.charAt(0).toUpperCase() + part.slice(1) };
  });
  return jobs;
}

const RESTRICTED_ACTIONS = [
  { flag: 'can_merge_code', label: 'merge code', pattern: /\bmerg(?:e|es|ing)\b[^.]*\b(?:pr|pull request|branch|code|main)\b|\bpush(?:ing)? (?:it )?(?:straight )?to main\b/i },
  { flag: 'can_open_payouts', label: 'open Stripe payouts or move money', pattern: /\bpayouts?\b|\b(?:transfer|withdraw|wire) (?:the )?(?:money|funds|balance)\b/i },
  { flag: 'can_spend_money', label: 'spend money', pattern: /^(?:please )?(?:buy|purchase|pay(?: for)?|order|subscribe(?: to)?|spend|refund|renew)\b/i },
];

export function agentActionGuard(agent, text) {
  const task = String(text || '').trim();
  for (const action of RESTRICTED_ACTIONS) {
    if (action.pattern.test(task) && agent?.[action.flag] !== true) {
      return `Needs owner approval: agents cannot ${action.label}. CHE will ask the owner first.`;
    }
  }
  return '';
}
