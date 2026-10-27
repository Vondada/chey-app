// A fresh staging probe token must never reuse a Durable Object with an older captured env.
// Identity only: authentication and the existing live checks remain unchanged.
export const MEMORY_PROBE_OBJECT = 'memory-truth-probe';

export async function probeObjectName(token) {
  if (typeof token !== 'string' || !token || token.length > 4096) throw new Error('A current authenticated probe token is required');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const suffix = [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${MEMORY_PROBE_OBJECT}-${suffix}`;
}

// Legacy identity is retained for existing hermetic tests; no owner name or prefix match is accepted.
export function isMemoryProbeObject(name) {
  return name === MEMORY_PROBE_OBJECT || /^memory-truth-probe-[a-f0-9]{32}$/.test(String(name || ''));
}
