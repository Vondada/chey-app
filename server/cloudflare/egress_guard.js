// STUB: minimal stand-in until the egress guard from the other lane lands on main.
// Contract: guardOutbound({destination, payload}) -> {allowed, redacted}.
// This stub allows only CHE's own Cloudflare model and does NOT redact anything.
export function guardOutbound({ destination, payload } = {}) {
  const allowed = destination === 'cloudflare-model';
  return { allowed, redacted: allowed ? String(payload ?? '') : '' };
}
