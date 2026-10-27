// Security Core: the security second-in-command. It answers to the host's lead assistant, which answers to the owner,
// and it directs the security specialists. Its state is derived only from real incidents and checks; there is no
// timer or animation that changes it.
import { productConfig } from './config.js';
import { openIncidents } from './incidents.js';

export const AGENT_STATES = Object.freeze(['MONITORING', 'INVESTIGATING', 'CONTAINING', 'RECOVERING', 'SECURED']);

export const SPECIALISTS = Object.freeze([
  { id: 'threat', name: 'Threat analyst', engine: 'threat' },
  { id: 'malware', name: 'Malware reviewer', engine: 'malware' },
  { id: 'identity', name: 'Identity guard', engine: 'identity' },
  { id: 'access', name: 'Access warden', engine: 'access' },
  { id: 'device', name: 'Device monitor', engine: 'device' },
  { id: 'code', name: 'Repository and dependency reviewer', engine: 'repository' },
  { id: 'incident', name: 'Incident lead', engine: 'incident' },
  { id: 'knowledge', name: 'Security librarian', engine: 'knowledge' },
]);

/**
 * The chain of command. `lead` is the host product's assistant (the embedding product names it; a standalone product names its own).
 * Agents in `separate` (for example a coding agent) are peers outside this chain: the security agent does not command
 * them and they do not command it.
 */
export function hierarchy({ owner = 'Owner', lead = 'Lead assistant', separate = [] } = {}, config = productConfig()) {
  return {
    chain: [
      { id: 'owner', name: owner, role: 'owner', reports_to: null },
      { id: 'lead', name: lead, role: 'lead', reports_to: 'owner' },
      { id: 'security', name: config.agent_name, role: 'second_in_command_security', reports_to: 'lead' },
      ...SPECIALISTS.map((s) => ({ ...s, role: 'specialist', reports_to: 'security' })),
    ],
    separate: separate.map((s) => ({ id: String(s.id || s), name: String(s.name || s), relation: 'peer_outside_security_chain' })),
  };
}

/**
 * MONITORING → INVESTIGATING → CONTAINING → RECOVERING → SECURED, from the open real incidents (simulations never
 * count). SECURED needs a check within the last day with no open high-severity events; otherwise it is MONITORING.
 */
export function agentState(store, tenant_id, { lastCheckAt = null, openHighEvents = 0, now = Date.now() } = {}) {
  const open = openIncidents(store, tenant_id);
  const at = (stages) => open.filter((i) => stages.includes(i.stage));
  const containing = at(['CONTAINING']);
  if (containing.length) return { state: 'CONTAINING', reason: `${containing.length} incident(s) being contained.`, incident_ids: containing.map((i) => i.incident_id) };
  const investigating = at(['DETECTED', 'TRIAGED', 'INVESTIGATING']);
  if (investigating.length) return { state: 'INVESTIGATING', reason: `${investigating.length} incident(s) under investigation.`, incident_ids: investigating.map((i) => i.incident_id) };
  const recovering = at(['CONTAINED', 'RECOVERING', 'RECOVERED']);
  if (recovering.length) return { state: 'RECOVERING', reason: `${recovering.length} incident(s) contained and recovering.`, incident_ids: recovering.map((i) => i.incident_id) };
  const fresh = lastCheckAt && now - Date.parse(lastCheckAt) < 86_400_000;
  if (fresh && openHighEvents === 0) return { state: 'SECURED', reason: 'No open incidents, no open high-severity events, and a check ran in the last day. Risk is lower, not zero.', incident_ids: [] };
  return { state: 'MONITORING', reason: fresh ? `${openHighEvents} open high-severity event(s) to review.` : 'No security check in the last day.', incident_ids: [] };
}
