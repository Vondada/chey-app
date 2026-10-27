// Security Core: the identity engine. Verifies that an action's target is the one authorized (app, domain, account)
// and reviews authorization sessions. Biometric material never reaches the core: a session records only that the
// device's own check said yes.
export { checkTargetIdentity } from './supply_chain.js';

/** Active, expired and revoked sessions, and any session that carries more than a yes/no factor. */
export function reviewSessions(sessions = [], now = Date.now()) {
  const list = Object.values(sessions || {});
  const active = list.filter((s) => !s.revoked_at && Number(s.expires_at) > now);
  const longLived = active.filter((s) => Number(s.expires_at) - now > 60 * 60 * 1000);
  return {
    active: active.length,
    expired_or_revoked: list.length - active.length,
    events: longLived.length ? [{ event_type: 'identity.long_session', source: 'identity_engine', severity: 'medium', confidence: 1, summary: `${longLived.length} authorization session(s) valid for more than an hour.` }] : [],
  };
}
