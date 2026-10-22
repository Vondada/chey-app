// Security Core: capability security. The veto every capability promotion passes through. It reads only the
// capability record (a plain object), so any product's capability registry can call it.
import { scanSecrets } from './secrets.js';

const RISKY_ACTIONS = /^(?:delete|remove|pay|purchase|transfer|order|subscribe|send_money|physical[:_].*|unlock|disable_alarm)$/i;

/**
 * { ok, reasons }. Vetoes: no passing security check, wildcard network/credential/file access, a credential stored in
 * the record, risky actions or paid external execution without owner approval, and high risk without owner approval.
 */
export function vetoCapability(cap = {}) {
  const reasons = [];
  if (!cap || typeof cap !== 'object') return { ok: false, reasons: ['no capability record'] };
  if (!cap.checks?.security?.ok) reasons.push('the security review has not passed');
  const perms = cap.permissions || {};
  for (const kind of ['network', 'credentials', 'files', 'devices']) if ([].concat(perms[kind] || []).includes('*')) reasons.push(`wildcard ${kind} access`);
  const text = JSON.stringify({ ...cap, history: undefined, previous: undefined });
  if (scanSecrets(text).length) reasons.push('a credential-shaped value is stored in the capability record');
  const ownerApproves = cap.approval_policy === 'owner';
  const risky = [].concat(perms.actions || []).filter((a) => RISKY_ACTIONS.test(String(a)));
  if (risky.length && !ownerApproves) reasons.push(`risky actions (${risky.join(', ')}) without owner approval`);
  if (cap.execution === 'external_paid' && !ownerApproves) reasons.push('paid external execution without owner approval');
  if (cap.risk_level === 'high' && !ownerApproves) reasons.push('high risk without owner approval');
  return { ok: reasons.length === 0, reasons };
}
