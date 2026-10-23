// Canonical La Agencia roster (report to CHE, the Office Boss). Existing matching agents keep their IDs,
// workspaces and task history; this only fills/updates company responsibilities.
// Scout is not a separate person: research and scouting belong to Mira, the Research and Education Director.
//
// Department heads (owner master mission, 2026-10-23): Owner → CHE → department heads → specialists. Each head is an
// EXISTING Office agent (the seven founding agents, plus Orion and Vale from the Office's own name pool, who already
// carry personas in agent_runtime.js). Roles moved with the reorganisation are recorded in docs/CHE_ORGANIZATION_AUDIT.md:
// engineering (Codex jobs) moved from Knox to Atlas so Knox's security review stays independent of the work it reviews;
// research moved from Atlas to Mira; ad creatives moved from Iris to Lyra. Agents keep their IDs and task history.
export const LA_AGENCIA_ROLES = {
  Nova: { role: 'Operations / coordination', specialty: 'Coordinates Office jobs: one accountable owner, supporting agents, dependencies and handoffs; also product offers, listings and sales-page drafts', provider_preference: 'auto', capability_requirements: ['deep_reasoning'],
    department: { id: 'operations', title: 'Chief Operations Officer' } },
  Atlas: { role: 'Engineering / Codex jobs', specialty: 'Implementation, Codex packets and CHE coding jobs, and Roblox/Luau experience drafts (games, weapons, UGC clothing, passes)', provider_preference: 'openai', model_preference: 'gpt-5.3-codex', capability_requirements: ['coding'],
    department: { id: 'engineering', title: 'Chief Technology Officer' } },
  Mira: { role: 'Research / education', specialty: 'Research, sourcing, competitive checks and trend topics from connected feeds; lessons and explanations; customer support copy and translation. Does not invent demand.', provider_preference: 'auto', capability_requirements: ['deep_reasoning'],
    department: { id: 'research', title: 'Research and Education Director' } },
  Knox: { role: 'Security / protection', specialty: 'Security reviews, access and permission checks, threat and incident investigation, credential-exposure checks, and the Security Core specialists. Defensive only.', provider_preference: 'auto', capability_requirements: ['deep_reasoning'],
    // Department head (owner, 2026-10-23): Knox is the Office Security Chief over the Security Core. There is one
    // roster and one identity per agent.
    department: { id: 'security', title: 'Office Security Chief' } },
  Sage: { role: 'Intelligence / strategy', specialty: 'Evidence analysis, decision support and business intelligence; read-only Stripe finance reports', provider_preference: 'auto', capability_requirements: ['deep_reasoning'],
    department: { id: 'intelligence', title: 'Intelligence and Strategy Director' } },
  Lyra: { role: 'Creative production', specialty: 'Content, social copy, campaigns, ad creatives and paid-social packages, video, design and music concepts', provider_preference: 'auto', capability_requirements: ['text'],
    department: { id: 'creative', title: 'Creative Production Director' } },
  Orion: { role: 'Markets / trading research', specialty: 'Market and strategy research and paper trading with their records (futures, stocks, crypto, forex, options). Paper only; live orders are never placed by an agent.', provider_preference: 'auto', capability_requirements: ['deep_reasoning'],
    department: { id: 'markets', title: 'Markets and Trading Research Director' } },
  Iris: { role: 'Experience / accessibility', specialty: 'App design, UX, layouts, prototypes, VoiceOver and accessibility reviews, and visual briefs', provider_preference: 'auto', capability_requirements: ['text'],
    department: { id: 'experience', title: 'Experience and Accessibility Director' } },
  Vale: { role: 'Quality assurance / verification', specialty: 'Independent verification of finished work against its acceptance criteria: test evidence, regression checks and release readiness. Never verifies its own work.', provider_preference: 'auto', capability_requirements: ['deep_reasoning'],
    department: { id: 'qa', title: 'Quality Assurance Director' } },
};

export function ensureLaAgenciaRoster(data) {
  const at = new Date().toISOString();
  for (const agent of data.team || []) {
    if (String(agent?.name || '').toLowerCase() === 'scout' && !agent.retired) {
      agent.retired = true;
      agent.retired_reason = 'Scout is Atlas.';
      agent.updated_at = at;
    }
  }
  for (const [name, spec] of Object.entries(LA_AGENCIA_ROLES)) {
    let agent = data.team.find((a) => String(a.name || '').toLowerCase() === name.toLowerCase() && !a.retired);
    if (!agent) {
      agent = { id: crypto.randomUUID(), name, kind: 'CHE AI coworker', status: 'available', introduced: true, created_at: at };
      data.team.push(agent);
    }
    // A reassigned agent keeps a record of the job it held before (owner, 2026-10-23: keep history).
    if (agent.role && agent.role !== spec.role) {
      agent.role_history = [...(Array.isArray(agent.role_history) ? agent.role_history : []), { role: agent.role, specialty: agent.specialty || '', until: at }].slice(-10);
    }
    agent.role = spec.role;
    agent.specialty = spec.specialty;
    agent.provider_preference = spec.provider_preference;
    agent.model_preference = spec.model_preference || agent.model_preference || '';
    agent.capability_requirements = spec.capability_requirements;
    if (spec.department) agent.department = { ...spec.department };
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

export function officeToolBlocker(env, agent, task = '') {
  const pref = String(agent?.provider_preference || '').toLowerCase();
  const scoutTask = /\b(?:scout|trending|trends|topic|topics)\b/i.test(String(task));
  // Sage's Stripe reports need Stripe; Sage's analysis and strategy work does not.
  const stripeTask = /\b(?:stripe|revenue|sales|payouts?|invoices?|finance|financial|money|earned|income)\b/i.test(String(task));
  if (String(agent?.name) === 'Sage' && stripeTask && !env.STRIPE_SECRET_KEY) return 'Blocked: tool not configured (Stripe not connected)';
  if (String(agent?.name) === 'Mira' && scoutTask && !env.CHE_TREND_URLS) return 'Blocked: tool not configured (no trend feed)';
  if (pref === 'openai' && !(env.CODEX_OWNER_TOKEN || env.CHE_OPENAI_API_KEY || env.OPENAI_API_KEY)) return 'Blocked: tool not configured (Codex)';
  if (pref === 'xai' && !(env.XAI_API_KEY || env.CHE_XAI_API_KEY || env.GROK_API_KEY || env.CHE_XAI_MODEL_URL)) return 'Blocked: tool not configured (Grok)';
  return '';
}

export function isLaAgenciaAgent(agent) {
  return Boolean(agent && LA_AGENCIA_ROLES[agent.name] && String(agent.workspace_key || '').startsWith('office/'));
}

// Most specific first. The department heads (owner, 2026-10-23): security → Knox, engineering → Atlas, verification →
// Vale, markets → Orion, finance and strategy → Sage, operations and products → Nova, customers and lessons → Mira,
// experience and accessibility → Iris, creative → Lyra, research → Mira.
const GOAL_ROUTES = [
  ['Knox', /\b(?:security|secure|vulnerab\w*|secrets? scan\w*|leaked (?:key|token|secret)s?|credential exposure|permissions? review|access review|least privilege|threats?|incidents?|malware|phishing|intrusion)\b/],
  ['Atlas', /\b(?:code|coding|build|app|bug|fix|deploy|api|website|site|feature|codex|roblox|luau|ugc|game\s*pass|classif|cluster|k-?means|k-?nn|ml\b|machine learning)\b/],
  ['Vale', /\b(?:qa|quality assurance|verify|verification|regression|release readiness|acceptance tests?|test plan|tests?|testing)\b/],
  ['Orion', /\b(?:trad(?:e|es|ing)|stocks?|crypto(?:currenc(?:y|ies))?|bitcoin|btc|ethereum|futures|mnq|forex|earnings|tickers?|watchlists?|backtest\w*|paper trad\w*)\b/],
  ['Sage', /\b(?:stripe|revenue|finance|money|sales|earnings|invoice|report on (?:sales|money)|business intelligence|decision support|swot)\b/],
  ['Nova', /\b(?:product|listing|listings|offer|pricing|price|sales page|store|shop|roblox\s+pass|game\s*pass|ugc|operations|coordinate|project plan|workflows?|automation)\b/],
  ['Mira', /\b(?:customer|support|reply|replies|email|faq|help desk|service|translat|locale|language|multilingual|lessons?|tutor\w*|teach|course)\b/],
  ['Iris', /\b(?:ux|ui|user experience|accessib\w*|voiceover|layouts?|prototypes?|wireframes?|onboarding flow|app design)\b/],
  ['Lyra', /\b(?:ads?|ad studio|tonight pack|ad creatives?|flyer|banner|paid social|creative brief|caption pack)\b/],
  ['Mira', /\b(?:scout|trending|trends|topic|topics|what's hot|what is hot|video ideas|research|competitor|competitors|find|source|compare|market|look up|fiverr|metrics|evaluat|learning notes)\b/],
  ['Lyra', /\b(?:social|post|posts|content|instagram|tiktok|caption|campaign|video|blog|clothing|avatar|ugc)\b/],
];

// An Office agent the owner names ("Atlas, research…", "have Mira write…", "Atlas and Mira research…")
// gets that slice of work. A name counts only capitalised and followed by a comma or a work verb, so
// "Sage green lamps", "Iris flowers" and "Knox's notes" are ordinary words.
const OFFICE_NAMES = ['Nova', 'Atlas', 'Mira', 'Knox', 'Sage', 'Lyra', 'Orion', 'Iris', 'Vale'];
const NAME_ALT = OFFICE_NAMES.join('|');
const SPLIT_VERBS = 'build|write|research|find|make|draft|post|fix|report|create|list|reply|answer|compare|ship|scout|analy[sz]e|design|translate|summari[sz]e|review|plan|prepare|verify|test|check|audit|backtest|coordinate';
const NAMED_LEAD = new RegExp(String.raw`^(?:(?:[Pp]lease|[Tt]hen|[Aa]nd|[Aa]lso|[Aa]sk|[Hh]ave|[Gg]et|[Tt]ell|[Ll]et)\s+)*((?:${NAME_ALT})(?:\s*(?:,|and)\s*(?:${NAME_ALT}))*)(?=,|\s+(?:to\s+|please\s+)?(?:${SPLIT_VERBS})\b)`);
const SPLIT_AT_NAME = new RegExp(String.raw`\s+and\s+(?=(?:have\s+|ask\s+|get\s+)?(?:${NAME_ALT})(?:,|\s+(?:to\s+|please\s+)?(?:${SPLIT_VERBS})\b))`);

export function splitGoal(goal) {
  const text = String(goal || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const parts = text
    .split(/(?:[.;]\s+|,?\s+(?:and then|then|and also|also)\s+|,\s+and\s+|\s+and\s+(?=(?:build|write|research|find|make|draft|post|fix|report|create|list|reply|answer|compare|ship|scout)\b))/i)
    .flatMap((part) => part.split(SPLIT_AT_NAME).reduce((out, piece) => {
      // "Atlas and Mira research…" is one shared job: a piece that is only names joins the next one.
      if (out.length && new RegExp(`^(?:${NAME_ALT})(?:\\s*(?:,|and)\\s*(?:${NAME_ALT}))*$`).test(out[out.length - 1])) out[out.length - 1] += ` and ${piece}`;
      else out.push(piece);
      return out;
    }, []))
    .map((part) => part.replace(/[.;,]+$/, '').trim())
    .filter((part) => part.split(' ').length >= 2)
    .slice(0, 6);
  const jobs = (parts.length ? parts : [text]).flatMap((part) => {
    const lower = part.toLowerCase();
    const task = part.charAt(0).toUpperCase() + part.slice(1);
    const named = NAMED_LEAD.exec(part);
    if (named) {
      const agents = [...new Set(named[1].split(/\s*(?:,|and)\s*/).filter((n) => OFFICE_NAMES.includes(n)))];
      if (agents.length) return agents.map((agent) => ({ agent, task }));
    }
    const hit = /^(?:research|find|compare|look up|scout|find trending|find topics)\b/.test(lower)
      ? ['Mira']
      : GOAL_ROUTES.find(([, pattern]) => pattern.test(lower));
    return [{ agent: hit ? hit[0] : 'Mira', task }];
  });
  return jobs.slice(0, 6);
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

/** The roster name and department record of the agent heading a department ('security' → Knox), or null. */
export function departmentHead(departmentId) {
  const hit = Object.entries(LA_AGENCIA_ROLES).find(([, spec]) => spec.department?.id === departmentId);
  return hit ? { name: hit[0], ...hit[1].department } : null;
}
