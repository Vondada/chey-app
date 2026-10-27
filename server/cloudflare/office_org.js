// The Office organisation (owner master mission, 2026-10-23, Phase 2): Owner → CHE → department heads → specialists.
//
// One roster, read from the existing structures: the heads and their departments are LA_AGENCIA_ROLES (office_company.js,
// the same `department` field the Security Room uses for Knox), identity and appearance are agentView (agent_runtime.js),
// security specialists are the Security Core's (security_core/agent.js), and every other specialist is a live Office agent
// or a provider specialty CHE already hires (office_workforce.js). Work queues, receipts, activity and performance come
// only from stored Office tasks and the per-agent work log; with no records a number is null, never zero-by-default.
// Tool status is CONFIGURED (a credential or connection is present) or NOT CONFIGURED, or NOT CHECKED where this view
// cannot tell; it never says a tool is verified working.

import { agentView, normalizeAgent } from './agent_runtime.js';
import { LA_AGENCIA_ROLES, officeToolBlocker } from './office_company.js';
import { SPECIALISTS as SECURITY_SPECIALISTS } from './security_core/agent.js';

const has = (env, ...keys) => keys.some((k) => String(env?.[k] || '').trim());

// Real tools each department uses: a CHE module that exists, and how this view can tell whether it is set up.
const TOOLS = {
  operations: [
    { id: 'office_jobs', label: 'Coordinated Office jobs and handoffs', module: 'office_jobs.js', configured: () => true },
    { id: 'objective_graph', label: 'Missions (objective graph)', module: 'objective_graph.js', configured: () => true },
    { id: 'command_center', label: 'Command Center', module: 'command_catalog.js', configured: () => true },
  ],
  engineering: [
    { id: 'codex_desk', label: 'Codex desk (work packets)', module: 'codex_packets.js', configured: (env) => has(env, 'CODEX_OWNER_TOKEN', 'CHATGPT_CODEX_TOKEN', 'CHE_OPENAI_API_KEY', 'OPENAI_API_KEY') },
    { id: 'coding_runtime', label: 'CHE coding jobs on GitHub Actions', module: 'coding_runtime.js', configured: (env) => has(env, 'CHE_GITHUB_TOKEN') },
    { id: 'code_index', label: 'Code search', module: 'code_index.js', configured: (env) => has(env, 'CHE_GITHUB_TOKEN') },
  ],
  research: [
    { id: 'browse', label: 'Web reading', module: 'browse_chat.js', configured: () => null },
    { id: 'trend_feed', label: 'Trend feed', module: 'office_company.js', configured: (env) => has(env, 'CHE_TREND_URLS') },
    { id: 'rea', label: 'Reverse-engineering investigations (REA)', module: 'rea_runner.js', configured: (env) => has(env, 'CHE_GITHUB_TOKEN') },
  ],
  security: [
    { id: 'security_core', label: 'Security Core checks', module: 'security_core/index.js', configured: () => true },
    { id: 'secret_scan', label: 'Secret scanner', module: 'security_core/secrets.js', configured: () => true },
    { id: 'repo_review', label: 'Repository and dependency review', module: 'security_intelligence.js', configured: (env) => has(env, 'CHE_GITHUB_TOKEN') },
  ],
  intelligence: [
    { id: 'stripe_reports', label: 'Stripe reports (read-only)', module: 'stripe_store.js', configured: (env) => has(env, 'STRIPE_SECRET_KEY') },
    { id: 'brain_search', label: 'Brain search', module: 'brain_store.js', configured: () => true },
    { id: 'expert', label: 'Expert and legal intelligence (cited sources)', module: 'expert_intelligence.js', configured: () => true },
  ],
  creative: [
    { id: 'visual_studio', label: 'Visual Studio', module: 'visual_studio.js', configured: () => true },
    { id: 'film_studio', label: 'Film Studio', module: 'film_studio.js', configured: (env) => has(env, 'CHE_GITHUB_TOKEN') },
    { id: 'video_line', label: 'YouTube video line', module: 'video_line.js', configured: () => null },
  ],
  markets: [
    { id: 'market_feed', label: 'NQ/MNQ market feed (sources labelled live or delayed)', module: 'market_feed.js', configured: () => true },
    { id: 'markets_desk', label: 'Quotes desk (indices; crypto from CoinGecko, delayed)', module: 'markets.js', configured: () => true },
    { id: 'trading_research', label: 'Strategy research, walk-forward and governor', module: 'trading_research.js', configured: () => true },
    { id: 'alpaca_paper', label: 'Alpaca paper account (stocks, paper only)', module: 'broker_alpaca.js', configured: () => null },
  ],
  experience: [
    { id: 'command_center_screens', label: 'Screen and command metadata', module: 'command_catalog.js', configured: () => true },
    { id: 'visual_studio_review', label: 'Visual briefs (Visual Studio)', module: 'visual_studio.js', configured: () => true },
  ],
  qa: [
    { id: 'che_review', label: "CHE's review verdict on every Office result", module: 'agent_runtime.js', configured: () => true },
    { id: 'deploy_receipt', label: 'Commit and deploy receipts', module: 'deploy_receipt.js', configured: (env) => has(env, 'CHE_GITHUB_TOKEN') },
  ],
};

const RESPONSIBILITIES = {
  operations: ['Turns a request into one coordinated job: accountable owner, supporting agents, order and dependencies', 'Detects overlapping work and keeps one owner per resource', 'Hands work between departments and records every handoff'],
  engineering: ['Plans and carries out code changes through the Codex desk and CHE coding jobs', 'Owns Codex packets and Roblox/Luau drafts', 'Never merges, deploys or spends without the owner'],
  research: ['Research, sourcing and competitive checks with sources', 'Lessons and explanations', 'Customer support copy and translation'],
  security: ['Security reviews of every engineering change', 'Access, permission and credential-exposure checks', 'Directs the eight Security Core specialists; defensive only'],
  intelligence: ['Weighs evidence and trade-offs for decisions', 'Business intelligence', 'Read-only Stripe finance reports'],
  creative: ['Content, social and campaigns', 'Ad creatives and paid-social packages', 'Video, design and music concepts'],
  markets: ['Market and strategy research with labelled data sources', 'Paper trading and its journals', 'Never places live orders'],
  experience: ['Layouts, flows and prototypes', 'VoiceOver and accessibility reviews', 'Keeps the chrome HUD style'],
  qa: ['Independent verification of finished work against its acceptance criteria', 'Regression and release-readiness checks', 'Never verifies its own work'],
};

// Office provider specialties (office_workforce.js) and the department each one works under.
const SPECIALTY_DEPARTMENT = {
  research: 'research', reasoning: 'intelligence', coding: 'engineering', creative: 'creative', analysis: 'intelligence',
  security: 'security', review: 'qa', legal: 'intelligence', music_manager: 'creative', health: 'research', finance: 'intelligence', engineering: 'engineering',
};

export const ESCALATION = Object.freeze([
  'A head that cannot finish (missing tool, refused handoff, failed stage) escalates to CHE, who tells the owner.',
  'Money, live trading, merging, deploying, publishing, deleting, contacting customers and security-permission changes always go to the owner first.',
  'A disagreement between heads goes to Nova to pick one accountable owner; CHE decides if Nova cannot.',
]);

export const HANDOFF_RULES = Object.freeze([
  'Work moves only through a recorded handoff with its context and evidence.',
  'The receiving head accepts only when it heads that kind of work, earlier stages are finished, its tools and permissions are available, and it is not verifying its own work.',
  'A refused handoff stops the job and is escalated; it is never skipped.',
]);

function departmentOf(agent) {
  return agent?.department?.id || LA_AGENCIA_ROLES[agent?.name]?.department?.id || '';
}

function performance(data, agent) {
  const mine = (data.team_tasks || []).filter((t) => t.partner_id === agent.id || t.partner_name === agent.name);
  if (!mine.length) return { tasks: 0, completed: null, failed: null, blocked: null, open: null, completion_rate: null, median_minutes: null, note: 'No Office tasks recorded yet.' };
  const count = (pred) => mine.filter(pred).length;
  const completed = count((t) => t.status === 'complete');
  const failed = count((t) => ['failed', 'rejected'].includes(t.status));
  const durations = mine.filter((t) => t.status === 'complete' && t.run_started_at && t.updated_at)
    .map((t) => (Date.parse(t.updated_at) - Date.parse(t.run_started_at)) / 60000).filter((m) => Number.isFinite(m) && m >= 0).sort((a, b) => a - b);
  const finished = completed + failed;
  return {
    tasks: mine.length,
    completed,
    failed,
    blocked: count((t) => t.status === 'blocked'),
    open: count((t) => ['queued', 'running', 'reviewing', 'review_pending', 'needs_review'].includes(t.status)),
    completion_rate: finished ? Math.round((completed / finished) * 100) / 100 : null,
    median_minutes: durations.length ? Math.round(durations[Math.floor(durations.length / 2)] * 10) / 10 : null,
    note: 'From stored Office tasks only.',
  };
}

function specialistsFor(data, dept, headName) {
  const out = [];
  if (dept === 'security') {
    for (const s of SECURITY_SPECIALISTS) out.push({ name: s.name, kind: 'Security Core specialist', id: s.id });
  }
  for (const [specialty, d] of Object.entries(SPECIALTY_DEPARTMENT)) {
    if (d === dept) out.push({ name: specialty.replace(/_/g, ' '), kind: 'Provider specialist CHE can hire', id: `specialty:${specialty}` });
  }
  for (const agent of data.team || []) {
    if (!agent || agent.retired || LA_AGENCIA_ROLES[agent.name] || agent.name === headName) continue;
    const text = `${agent.role || ''} ${agent.specialty || ''}`.toLowerCase();
    const guess = /secur/.test(text) ? 'security' : /cod|engineer|implement/.test(text) ? 'engineering' : /trad|market/.test(text) ? 'markets'
      : /qa|review|verif|test/.test(text) ? 'qa' : /content|social|creative|video|ad/.test(text) ? 'creative' : /research|source/.test(text) ? 'research' : '';
    if (guess === dept) out.push({ name: agent.name, kind: agent.temporary ? 'Temporary Office agent' : 'Office agent', id: agent.id, role: agent.role || '' });
  }
  return out;
}

/** One head's full record: identity, department, responsibilities, tools, permissions, queue, receipts, activity, performance. */
export function headRecord(data, env, agent) {
  normalizeAgent(agent);
  const dept = departmentOf(agent);
  const spec = LA_AGENCIA_ROLES[agent.name] || {};
  const view = agentView(agent, data);
  const queue = (data.team_tasks || []).filter((t) => (t.partner_id === agent.id || t.partner_name === agent.name) && ['queued', 'running', 'reviewing', 'review_pending', 'needs_review', 'blocked'].includes(t.status))
    .slice(0, 10).map((t) => ({ id: t.id, task: String(t.task || '').slice(0, 140), status: t.status, office_job_id: t.office_job_id || null, error: t.error || '' }));
  const receipts = (data.agent_work_log || []).filter((e) => e.agent_id === agent.id || e.agent === agent.name).slice(0, 10)
    .map((e) => ({ task_id: e.task_id, status: e.status, verified_by_che: e.verified_by_che, at: e.at }));
  const blocker = officeToolBlocker(env || {}, agent, '');
  return {
    id: agent.id,
    name: agent.name,
    title: spec.department?.title || agent.department?.title || '',
    department: dept,
    reports_to: 'CHE',
    role: agent.role || '',
    role_history: Array.isArray(agent.role_history) ? agent.role_history : [],
    personality: agent.personality || '',
    appearance: view.appearance || null,
    look: agent.look || null,
    responsibilities: RESPONSIBILITIES[dept] || [],
    tools: (TOOLS[dept] || []).map((t) => {
      const c = t.configured(env || {});
      return { id: t.id, label: t.label, module: t.module, status: c === true ? 'configured' : c === false ? 'not configured' : 'not checked' };
    }),
    permissions: {
      granted: Array.isArray(agent.permissions) ? agent.permissions : [],
      can_merge_code: agent.can_merge_code === true,
      can_spend_money: agent.can_spend_money === true,
      can_open_payouts: agent.can_open_payouts === true,
      owner_messaging: agent.owner_messaging === true,
    },
    operational_status: blocker || (queue.some((t) => t.status === 'running') ? 'Working' : queue.length ? 'Has queued work' : 'Idle'),
    work_queue: queue,
    receipts,
    recent_activity: (agent.handoff_history || []).slice(-5).reverse().map((h) => ({ at: h.at, text: `Handoff ${h.from} → ${h.to} (task ${h.task_id})` })),
    performance: performance(data, agent),
    specialists: specialistsFor(data, dept, agent.name),
    handoff_rules: HANDOFF_RULES,
    escalation: ESCALATION,
  };
}

/** The whole organisation, top down. */
export function officeOrg(data, env) {
  const heads = Object.keys(LA_AGENCIA_ROLES)
    .map((name) => (data.team || []).find((a) => a && !a.retired && a.name === name))
    .filter(Boolean)
    .map((agent) => headRecord(data, env, agent));
  return {
    owner: { name: 'Owner', authority: 'Final authority' },
    che: { name: 'CHE', role: "The owner's primary assistant; sets priorities, reports to the owner. Other agents report through CHE." },
    heads,
    missing_heads: Object.keys(LA_AGENCIA_ROLES).filter((name) => !heads.some((h) => h.name === name)),
    escalation: ESCALATION,
    handoff_rules: HANDOFF_RULES,
  };
}

/** What CHE says for "who runs the Office?": built only from the roster. */
export function speakOfficeOrg(org) {
  const lines = org.heads.map((h) => `${h.name}, ${h.title}`);
  return `CHE here. You lead; I report to you. ${org.heads.length} department heads report to me: ${lines.join('; ')}.${org.missing_heads.length ? ` Not on the roster yet: ${org.missing_heads.join(', ')}.` : ''}`;
}
