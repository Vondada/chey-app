// Security Core: product configuration. The core is written so it can ship as its own product later, so nothing here
// names a host product, a brand or any price; those belong to whichever product layer embeds the core.

export const SECURITY_CORE_VERSION = '1.0.0';

// The thirteen engines every product layer gets. Order is the order they are listed to the owner.
export const ENGINE_NAMES = Object.freeze([
  'threat', 'malware', 'identity', 'access', 'device', 'repository', 'dependency',
  'incident', 'knowledge', 'policies', 'event_model', 'capability_security', 'workflow_library',
]);

const DEFAULTS = Object.freeze({
  product_name: 'Security Core', // a product layer replaces this; the core never hard-codes a brand
  agent_name: 'Security',
  edition: 'embedded',           // embedded in a host product, or standalone
  host_product: null,
  default_tenant: 'default',
  max_events_per_tenant: 500,
  max_incidents_per_tenant: 100,
});

const ALLOWED = new Set(Object.keys(DEFAULTS));

/** The effective configuration. Unknown keys are dropped, so pricing or billing settings cannot ride in here. */
export function productConfig(overrides = {}) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(overrides || {})) if (ALLOWED.has(k) && v !== undefined) out[k] = v;
  out.edition = out.edition === 'standalone' ? 'standalone' : 'embedded';
  return Object.freeze(out);
}

export const clip = (v, n) => String(v ?? '').slice(0, n);

export function shortId(prefix = '') {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);
export const severityRank = (s) => Math.max(0, SEVERITIES.indexOf(s));
