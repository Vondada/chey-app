// Security Core: the event model and a tenant-scoped event bus. Every engine reports through this one shape, so a
// future standalone product can serve many customers from the same code: each tenant's events live in their own
// partition and no call can read or change another tenant's events.
import { SEVERITIES, clip, productConfig, shortId } from './config.js';
import { redactDeep } from './secrets.js';

export const EVENT_FIELDS = Object.freeze([
  'event_id', 'timestamp', 'event_type', 'source', 'affected_resource', 'severity', 'confidence',
  'evidence_refs', 'status', 'actions_taken', 'verification', 'tenant_id', 'customer_scope',
]);
export const EVENT_STATUSES = Object.freeze(['open', 'investigating', 'contained', 'resolved', 'dismissed']);
// 'simulation' marks an event produced by a drill. It is never mixed into real status, scores or animations.
export const VERIFICATION = Object.freeze(['unverified', 'verified', 'failed', 'simulation']);

const TENANT_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

export function validTenant(id) { return typeof id === 'string' && TENANT_RE.test(id); }

/**
 * One event. Text fields pass through the secret scanner, so a credential can never be stored in an event; evidence
 * is referenced (evidence_refs), not copied in.
 */
export function createEvent(input = {}, { tenant_id, now = new Date().toISOString() } = {}) {
  if (!validTenant(tenant_id)) throw new Error('An event needs a valid tenant.');
  const found = [];
  const text = (v, n) => clip(redactDeep(clip(v, n * 2), found), n);
  const confidence = Number(input.confidence);
  const event = {
    event_id: clip(input.event_id, 40) || shortId('ev_'),
    timestamp: input.timestamp && !Number.isNaN(Date.parse(input.timestamp)) ? new Date(input.timestamp).toISOString() : now,
    event_type: text(input.event_type || 'observation', 60).replace(/[^\w.:-]/g, '_'),
    source: text(input.source || 'unknown', 60),
    affected_resource: text(input.affected_resource || '', 120),
    severity: SEVERITIES.includes(input.severity) ? input.severity : 'info',
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    evidence_refs: [].concat(input.evidence_refs || []).slice(0, 20).map((r) => text(r, 200)),
    summary: text(input.summary || '', 300),
    status: EVENT_STATUSES.includes(input.status) ? input.status : 'open',
    actions_taken: [].concat(input.actions_taken || []).slice(0, 20).map((a) => text(a, 160)),
    verification: VERIFICATION.includes(input.verification) ? input.verification : 'unverified',
    tenant_id,
    customer_scope: text(input.customer_scope || tenant_id, 64),
  };
  if (found.length) event.redacted = [...new Set(found)];
  return event;
}

export function emptyStore() { return { v: 1, tenants: {} }; }

function partition(store, tenant_id) {
  if (!validTenant(tenant_id)) throw new Error('Unknown tenant.');
  store.tenants ||= {};
  store.tenants[tenant_id] ||= { events: [], incidents: [], knowledge: [], lockdown: null, checks: [] };
  return store.tenants[tenant_id];
}

/** The partition for one tenant; every engine that stores per-customer state goes through this. */
export function tenantState(store, tenant_id) { return partition(store, tenant_id); }

/**
 * The bus for one tenant. A publish that names another tenant is refused; queries and updates see only this tenant's
 * partition. Subscribers are in-memory (per request) and receive only this tenant's events.
 */
export function openBus(store, tenant_id, config = productConfig()) {
  const part = partition(store, tenant_id);
  const subscribers = new Set();
  return {
    tenant_id,
    publish(input = {}) {
      if (input.tenant_id && input.tenant_id !== tenant_id) throw new Error('Cross-tenant publish refused.');
      if (input.event_id && part.events.some((e) => e.event_id === input.event_id)) return part.events.find((e) => e.event_id === input.event_id);
      const event = createEvent(input, { tenant_id });
      part.events = [event, ...part.events].slice(0, config.max_events_per_tenant);
      for (const fn of subscribers) { try { fn(event); } catch (_) { /* a subscriber failure never loses the event */ } }
      return event;
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    get(event_id) { return part.events.find((e) => e.event_id === event_id) || null; },
    query({ type = null, minSeverity = null, status = null, since = null, includeSimulations = false, limit = 100 } = {}) {
      const min = minSeverity ? SEVERITIES.indexOf(minSeverity) : 0;
      const t0 = since ? Date.parse(since) : 0;
      return part.events.filter((e) => (!type || e.event_type === type)
        && SEVERITIES.indexOf(e.severity) >= min
        && (!status || [].concat(status).includes(e.status))
        && (!t0 || Date.parse(e.timestamp) >= t0)
        && (includeSimulations || e.verification !== 'simulation')).slice(0, limit);
    },
    /** Status, actions and verification only: what was observed is never rewritten. */
    update(event_id, { status, action, verification } = {}) {
      const e = part.events.find((x) => x.event_id === event_id);
      if (!e) return null;
      if (status && EVENT_STATUSES.includes(status)) e.status = status;
      if (action) e.actions_taken = [...e.actions_taken, clip(redactDeep(String(action)), 160)].slice(-20);
      if (verification && VERIFICATION.includes(verification) && e.verification !== 'simulation') e.verification = verification;
      return e;
    },
  };
}
