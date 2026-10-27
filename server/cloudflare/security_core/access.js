// Security Core: access control for agents, tools, apps and devices, and the lockdown preview. Least privilege: a
// principal holds only the scopes it was granted, a wildcard is always flagged, and lockdown shows its effects
// before it can be turned on.
import { clip } from './config.js';
import { sha256 } from './supply_chain.js';

export const PRINCIPAL_KINDS = Object.freeze(['agent', 'tool', 'app', 'device']);

/** A principal: something that can act. Unknown kinds are refused; scopes default to none. */
export function principal({ id, kind, name = '', scopes = [], last_used_at = null, status = 'active', note = '' } = {}) {
  if (!PRINCIPAL_KINDS.includes(kind)) throw new Error('Unknown principal kind.');
  return { id: clip(id, 80), kind, name: clip(name || id, 80), scopes: [...new Set([].concat(scopes).map((s) => clip(s, 80)))].slice(0, 40), last_used_at, status, note: clip(note, 200) };
}

/** True only for an exact granted scope (or a granted prefix ending in ':*'). */
export function allowed(p, scope) {
  if (!p || p.status !== 'active') return false;
  return p.scopes.some((g) => g === scope || (g.endsWith(':*') && g !== '*' && scope.startsWith(g.slice(0, -1))));
}

/** Least-privilege review: wildcards, stale grants and broad credential or delete scopes are listed by principal. */
export function reviewAccess(principals = [], now = Date.now()) {
  const findings = [];
  for (const p of principals) {
    if (p.scopes.includes('*')) findings.push({ id: p.id, kind: p.kind, severity: 'high', issue: 'holds every scope (wildcard)' });
    for (const s of p.scopes) if (/^(?:credentials|delete|money|payments?):\*$/.test(s)) findings.push({ id: p.id, kind: p.kind, severity: 'medium', issue: `broad scope ${s}` });
    if (p.scopes.length && p.last_used_at && now - Date.parse(p.last_used_at) > 30 * 86_400_000) findings.push({ id: p.id, kind: p.kind, severity: 'low', issue: 'granted scopes unused for over 30 days' });
  }
  const counts = Object.fromEntries(PRINCIPAL_KINDS.map((k) => [k, principals.filter((p) => p.kind === k).length]));
  return { principals: principals.length, counts, findings, least_privilege: findings.every((f) => f.severity === 'low') };
}

/**
 * Lockdown preview. `mechanisms` are what the host product's lockdown really enforces (each { id, effect }); the
 * preview lists those plus what stays as it is, so nothing is claimed that the host does not do. The token binds
 * an activation to this exact preview for ten minutes.
 */
export async function previewLockdown({ mechanisms = [], keeps = [], principals = [], active = false } = {}, now = Date.now()) {
  const effects = mechanisms.map((m) => ({ id: clip(m.id, 60), effect: clip(m.effect, 200) }));
  const unaffected = keeps.map((k) => clip(k, 200));
  const affected = principals.filter((p) => p.status === 'active').map((p) => ({ id: p.id, kind: p.kind, name: p.name }));
  const body = { effects, unaffected, affected_count: affected.length, active };
  const token = (await sha256(new TextEncoder().encode(JSON.stringify(body) + Math.floor(now / 600_000)))).slice(0, 24);
  return { ...body, affected: affected.slice(0, 50), token, expires_at: new Date(now + 600_000).toISOString(), requires_confirmation: true };
}

/** Activation needs the preview's token and an explicit confirmation; anything else is refused with the reason. */
export async function confirmLockdown({ token = '', confirm = false, preview = null } = {}, now = Date.now()) {
  if (confirm !== true) return { ok: false, reason: 'explicit_confirmation_required' };
  if (!preview || !token || token !== preview.token) return { ok: false, reason: 'preview_token_mismatch' };
  if (Date.parse(preview.expires_at) < now) return { ok: false, reason: 'preview_expired' };
  return { ok: true, effects: preview.effects };
}
