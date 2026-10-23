// Canonical La Agencia roster (report to CHE, the Office Boss). Existing matching agents keep their IDs,
// workspaces and task history; this only fills/updates company responsibilities.
// Scout is not a separate person. Atlas is the scout.
export const LA_AGENCIA_ROLES = {
  Nova: { role: 'Product / listings', specialty: 'Product offers, listings and sales-page drafts', provider_preference: 'openai', capability_requirements: ['coding'] },
  Atlas: { role: 'Research / scout', specialty: 'Research, sourcing, competitive checks, and trend topics from connected feeds. Does not invent demand.', provider_preference: 'auto', capability_requirements: ['deep_reasoning'] },
  Mira: { role: 'Customer / support copy', specialty: 'Customer-facing support, service copy, and translation / multilingual drafts', provider_preference: 'auto', capability_requirements: ['text'] },
  Knox: { role: 'Engineering / Codex jobs', specialty: 'Implementation, tests, Codex packets, and Roblox/Luau experience drafts (games, weapons, UGC clothing, passes)', provider_preference: 'openai', model_preference: 'gpt-5.3-codex', capability_requirements: ['coding'],
    // Department head (owner, 2026-10-23): Knox is the Office Security Chief over the Security Core. The Org lane
    // extends this same field for other heads; there is one roster and one identity per agent.
    department: { id: 'security', title: 'Office Security Chief' } },
  Sage: { role: 'Finance / Stripe reports', specialty: 'Read-only Stripe reporting and finance summaries', provider_preference: 'auto', capability_requirements: ['payments_read'] },
  Lyra: { role: 'Content / social', specialty: 'Content, social copy and campaign drafts', provider_preference: 'auto', capability_requirements: ['text'] },
  Iris: { role: 'Ad Studio / paid-social creatives', specialty: 'Ad creatives, visual briefs, captions and same-night social packages', provider_preference: 'auto', capability_requirements: ['text'] },
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
  if (String(agent?.name) === 'Sage' && !env.STRIPE_SECRET_KEY) return 'Blocked: tool not configured (Stripe not connected)';
  if (String(agent?.name) === 'Atlas' && scoutTask && !env.CHE_TREND_URLS) return 'Blocked: tool not configured (no trend feed)';
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
  ['Atlas', /\b(?:scout|trending|trends|topic|topics|what's hot|what is hot|video ideas|research|competitor|competitors|find|source|compare|market|look up|fiverr|metrics|evaluat|learning notes)\b/],
  ['Lyra', /\b(?:social|post|posts|content|instagram|tiktok|caption|campaign|video|blog|clothing|avatar|ugc)\b/],
];

// An Office agent the owner names ("Atlas, research…", "have Mira write…", "Atlas and Mira research…")
// gets that slice of work. A name counts only capitalised and followed by a comma or a work verb, so
// "Sage green lamps", "Iris flowers" and "Knox's notes" are ordinary words.
const OFFICE_NAMES = ['Nova', 'Atlas', 'Mira', 'Knox', 'Sage', 'Lyra', 'Iris'];
const NAME_ALT = OFFICE_NAMES.join('|');
const SPLIT_VERBS = 'build|write|research|find|make|draft|post|fix|report|create|list|reply|answer|compare|ship|scout|analy[sz]e|design|translate|summari[sz]e|review|plan|prepare';
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
      ? ['Atlas']
      : GOAL_ROUTES.find(([, pattern]) => pattern.test(lower));
    return [{ agent: hit ? hit[0] : 'Atlas', task }];
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
