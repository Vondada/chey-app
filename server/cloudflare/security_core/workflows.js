// Security Core: the security workflow library. Each playbook is a list of engine steps. Steps marked
// `confirm` stop for the owner's explicit yes; the host product executes steps through its own adapters.

export const SECURITY_WORKFLOWS = Object.freeze([
  { id: 'security_check', name: 'Run a security check', steps: [
    { engine: 'threat', action: 'evaluate' }, { engine: 'device', action: 'review' }, { engine: 'access', action: 'review' },
    { engine: 'dependency', action: 'review' }, { engine: 'capability_security', action: 'review' }, { engine: 'event_model', action: 'publish' },
  ] },
  { id: 'contain_incident', name: 'Contain an incident', steps: [
    { engine: 'incident', action: 'triage' }, { engine: 'identity', action: 'revoke_sessions' },
    { engine: 'access', action: 'preview_lockdown' }, { engine: 'access', action: 'activate_lockdown', confirm: true },
    { engine: 'incident', action: 'mark_contained' },
  ] },
  { id: 'recover', name: 'Recover after an incident', steps: [
    { engine: 'identity', action: 'list_credentials_to_rotate' }, { engine: 'policies', action: 'restore_trusted_snapshot', confirm: true },
    { engine: 'incident', action: 'mark_recovered' }, { engine: 'knowledge', action: 'capture_lesson' },
  ] },
  { id: 'dependency_review', name: 'Review dependencies', steps: [{ engine: 'dependency', action: 'review' }, { engine: 'repository', action: 'scan' }] },
  { id: 'access_review', name: 'Review access', steps: [{ engine: 'access', action: 'review' }, { engine: 'access', action: 'revoke_unused', confirm: true }] },
  { id: 'drill', name: 'Run a safe simulation', steps: [{ engine: 'incident', action: 'simulate' }] },
]);

export function workflowById(id) { return SECURITY_WORKFLOWS.find((w) => w.id === id) || null; }

/** Steps that need the owner's yes before they run. */
export function confirmationsNeeded(id) { return (workflowById(id)?.steps || []).filter((s) => s.confirm).map((s) => `${s.engine}.${s.action}`); }
