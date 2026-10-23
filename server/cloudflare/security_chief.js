// The Office Security Chief: the visible identity of the Security Core's second-in-command.
//
// The chief is an EXISTING Office agent, never a new one: Knox, whose established persona already "hunts for failure
// modes, security holes and bad assumptions" (agent_runtime.js PERSONAS) and whose profile lists "Failure-mode and
// security review" (CORE_AGENT_PROFILES). This module only maps that identity onto the Security Core's chain
// (security_core/agent.js: Owner → lead (CHE) → security → 8 specialists). The engines, specialists, permissions,
// incident records and history are unchanged; this is presentation and routing.
//
// Permissions are shown as CONFIGURED (what the access registry grants) separately from VERIFIED (checks that
// actually ran and were recorded). Activity is only recorded checks and audit entries, never a narrated claim.
//
// Conduct: the chief monitors, warns, records and proposes owner-confirmed protective controls. It never harms,
// threatens, traps, confronts or retaliates, and never weakens life-safety protections (security_core/physical.js).

import { CORE_AGENT_PROFILES, PERSONAS, agentView } from './agent_runtime.js';
import { departmentHead } from './office_company.js';
import { SPECIALISTS } from './security_core/agent.js';
import { scopeWords } from './security_visibility.js';

// The identity lives in the shared Office roster (office_company.js LA_AGENCIA_ROLES, `department`); this reads it.
const HEAD = departmentHead('security');
export const SECURITY_CHIEF_NAME = HEAD?.name || 'Knox';
export const SECURITY_CHIEF_TITLE = HEAD?.title || 'Office Security Chief';

export const SECURITY_CHIEF_RESPONSIBILITIES = Object.freeze([
  'Runs CHE\'s security checks and reports the results to CHE',
  'Directs the eight security specialists',
  'Reviews who and what has access, and flags access wider than needed',
  'Opens and tracks security incidents; lockdown and other protective controls need the owner\'s confirmation',
]);

export const SECURITY_CHIEF_CONDUCT = Object.freeze([
  'Monitors, warns and records; never harms, threatens, traps, confronts or retaliates.',
  'Physical security is monitoring, warnings, recording and owner-confirmed protective controls only.',
  'Never disables an alarm\'s emergency behavior or any smoke or life-safety device.',
]);

/** The roster agent who is the chief, or null when Knox is not on the active Office roster. */
export function chiefAgent(data = {}) {
  return (data.team || []).find((a) => a && !a.retired && String(a.name || '').toLowerCase() === SECURITY_CHIEF_NAME.toLowerCase()) || null;
}

/**
 * One identity and activity record for the chief, the same everywhere (Office, Security Room, chat).
 * `principal` is the Security Core's 'security' access principal (configured scopes); `coverage` is the
 * visibility coverage (verified checks); `state` is the Security Core agent state.
 */
export function securityChief(data = {}, { principal = null, coverage = null, state = null, audit = [], checks = [] } = {}) {
  const agent = chiefAgent(data);
  const view = agent ? agentView(agent, data) : null;
  const profile = CORE_AGENT_PROFILES[SECURITY_CHIEF_NAME] || {};
  const configured = (principal?.scopes || []).map((s) => ({ scope: s, words: scopeWords(s) }));
  const verified = (coverage?.checks || []).filter((c) => c.state === 'checked' && !c.stale).map((c) => ({ id: c.id, label: c.label, at: c.at }));
  const activity = [
    ...checks.map((c) => ({ at: c.at, kind: 'check', text: `Security check: ${c.findings ?? 0} finding${c.findings === 1 ? '' : 's'}${c.advisories == null ? '; dependencies not checked' : ''}${c.deploy_checked ? '' : '; deployment not checked'}`, verified: true })),
    ...audit.map((a) => ({ at: a.at, kind: 'audit', text: `${String(a.action || 'action').replace(/_/g, ' ')}${a.detail ? `: ${a.detail}` : ''}`, verified: true })),
  ].filter((x) => x.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 10);
  return {
    name: SECURITY_CHIEF_NAME,
    title: SECURITY_CHIEF_TITLE,
    on_roster: Boolean(agent),
    agent_id: agent?.id || null,
    roster_note: agent ? '' : 'Knox appears on the Office roster once the Office is opened; the Security Core runs either way.',
    office_role: view?.role || 'Engineering / Codex jobs',
    supervisor: 'CHE',
    reports_to: 'CHE',
    chain: ['Owner', 'CHE', SECURITY_CHIEF_NAME, 'Specialists'],
    personality: view?.personality || PERSONAS[SECURITY_CHIEF_NAME] || '',
    appearance: view?.appearance || profile.appearance || null,
    strengths: view?.strengths || profile.strengths || [],
    responsibilities: [...SECURITY_CHIEF_RESPONSIBILITIES],
    conduct: [...SECURITY_CHIEF_CONDUCT],
    specialists: SPECIALISTS.map((s) => ({ id: s.id, name: s.name, reports_to: SECURITY_CHIEF_NAME })),
    permissions_configured: configured,
    integrations_verified: verified,
    status: state ? { state: state.state, reason: state.reason } : { state: 'UNKNOWN', reason: 'No security state recorded yet.' },
    recent_verified_activity: activity,
  };
}

/**
 * "CHE, have Knox check security", "ask Knox to run a security check", "Knox, check security".
 * Strict on purpose: a sentence that merely mentions Knox ("Knox's notes", "Knox fixed the bug", "check Knox's
 * code") is not a security request.
 */
export function securityChiefIntent(message = '') {
  const t = String(message || '').trim().toLowerCase().replace(/[’]/g, "'")
    .replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chey|chay)\b[\s,.:;!?-]*/, '').replace(/^(?:please|can you|could you)\s+/, '').replace(/[.!?]+$/, '').trim();
  const check = '(?:check|run|do|perform) (?:a |the |our |my |your |che\'s )?(?:full )?security(?: check| scan| audit| review)?|check (?:on )?(?:my |our |your |che\'s )?security|run (?:a |the )?security (?:check|scan|audit|review)|review (?:my |our |the )?security|do a security (?:check|sweep|scan)';
  const re = new RegExp(`^(?:(?:have|ask|get|tell) knox (?:to )?(?:${check})|knox[,:]? (?:please )?(?:${check})|(?:${check}) with knox)$`);
  return re.test(t) ? { action: 'chief_check' } : null;
}

/** CHE's spoken report of Knox's check: which checks ran, when, their findings, and what was not checked. */
export function speakChiefReport(chief, { findings = [], coverage }) {
  const ran = coverage.checks.filter((c) => c.state === 'checked' && !c.stale);
  const notRan = coverage.checks.filter((c) => c.state !== 'checked' || c.stale);
  const when = ran[0]?.at ? ran[0].at.replace('T', ' ').slice(0, 16) + ' UTC' : null;
  const parts = [`Knox ran the security check${when ? ` at ${when}` : ''}, sir.`];
  parts.push(ran.length ? `Checked: ${ran.map((c) => c.label.toLowerCase()).join(', ')}.` : 'No check completed.');
  parts.push(findings.length
    ? `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${findings.slice(0, 3).map((f, i) => `${i + 1}. ${f}`).join('; ')}.`
    : 'No findings from those checks.');
  if (notRan.length) parts.push(`Not checked: ${notRan.map((c) => c.label.toLowerCase()).join(', ')}.`);
  parts.push(`Knox reports to me; ${chief.on_roster ? 'Knox\'s desk in the Office and the Security Room have the full record' : 'the Security Room has the full record'}.`);
  return parts.join(' ');
}
