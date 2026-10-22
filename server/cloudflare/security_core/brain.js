// Security Core: the security knowledge categories a host's knowledge store ("Brain") files security records under.
// The core only declares them; the host registers them through whatever hook its store offers.

export const SECURITY_BRAIN_CATEGORIES = Object.freeze([
  { id: 'security_threats', name: 'Security: Threats and Detections', portability: 'SHARED_SECURITY' },
  { id: 'security_incidents', name: 'Security: Incidents and Lessons', portability: 'CUSTOMER_PRIVATE' },
  { id: 'security_policies', name: 'Security: Policies', portability: 'PRODUCT_GENERAL' },
  { id: 'security_access', name: 'Security: Access and Identity', portability: 'CUSTOMER_PRIVATE' },
  { id: 'security_code', name: 'Security: Code, Dependencies and Secrets', portability: 'SHARED_SECURITY' },
  { id: 'security_devices', name: 'Security: Devices and Physical', portability: 'CUSTOMER_PRIVATE' },
  { id: 'security_simulations', name: 'Security: Simulations and Drills', portability: 'PRODUCT_GENERAL' },
]);

/** Calls each hook that exists (a host may have none yet); returns which ones accepted the categories. */
export function registerSecurityCategories(hooks = {}) {
  const done = [];
  for (const [name, fn] of Object.entries(hooks)) {
    if (typeof fn !== 'function') continue;
    try { fn(SECURITY_BRAIN_CATEGORIES.map(({ id, name: n }) => ({ id, name: n }))); done.push(name); } catch (_) { /* a missing store is not fatal */ }
  }
  return done;
}
