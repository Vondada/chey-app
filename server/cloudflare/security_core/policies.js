// Security Core: policies. Versioned rules every engine and every product layer obeys. They are defensive only: the
// core never attacks, retaliates, probes systems it was not given, or claims a system cannot be breached.

export const POLICY_VERSION = '2026-10-22.1';

export const POLICIES = Object.freeze([
  { id: 'least_privilege', rule: 'Every agent, tool, app and device holds only the scopes it was granted; wildcards are flagged.' },
  { id: 'defensive_only', rule: 'No offensive hacking, exploitation, retaliation or counter-attack, ever.' },
  { id: 'owned_scope_only', rule: 'Only systems the owner or customer registered are inspected; unrelated systems are never probed or scanned.' },
  { id: 'no_plaintext_secrets', rule: 'Events, ledgers, knowledge and logs hold credential kinds and locations, never the values.' },
  { id: 'evidence_not_attribution', rule: 'An event says what was observed; nobody is named as an attacker without evidence.' },
  { id: 'simulations_isolated', rule: 'Drills run in an isolated store, are labelled SIMULATION and never touch real systems or scores.' },
  { id: 'confirm_disruptive', rule: 'Lockdown and other disruptive actions show their effects first and need explicit confirmation.' },
  { id: 'security_veto', rule: 'A capability cannot be promoted while the security review fails.' },
  { id: 'physical_no_harm', rule: 'Physical responses are limited to notifying and recording; nothing autonomous may harm, trap or confront a person.' },
  { id: 'honest_claims', rule: 'Status lowers risk; no system is described as unhackable or perfectly safe.' },
]);

const OFFENSIVE = /\b(?:exploit|attack|hack back|retaliat\w*|counter-?attack|ddos|brute[- ]?force|crack|phish|deface|take ?down|dox)\b/i;
const PROBE = /\b(?:port[- ]?scan|scan|probe|fingerprint|enumerate|crawl)\b/i;
const CLAIM = /\b(?:unhackable|cannot be hacked|can't be hacked|100% (?:safe|secure)|perfectly (?:safe|secure)|impossible to (?:hack|breach))\b/i;

/**
 * Decides whether an action is allowed by policy. `owned` is the list of resources this tenant registered; a probe of
 * anything else is refused.
 */
export function evaluateAction({ verb = '', target = '', owned = [] } = {}) {
  const v = String(verb);
  if (OFFENSIVE.test(v)) return { allowed: false, policy: 'defensive_only', reason: 'Offensive or retaliatory actions are never taken.' };
  if (PROBE.test(v) && !owned.includes(String(target))) return { allowed: false, policy: 'owned_scope_only', reason: `${target || 'That system'} is not a registered system, so it is not inspected.` };
  return { allowed: true, policy: null, reason: '' };
}

/** Text that would overclaim safety is refused before it is shown or spoken. */
export function overclaims(text = '') { return CLAIM.test(String(text)) && !/\b(?:no|never|not)\b[^.]{0,40}\b(?:unhackable|100%|perfectly|impossible)/i.test(String(text)); }
