// Provider evidence: what CHE may say about a GPU or render provider, from the evidence it actually holds.
//
// Four different facts, kept apart, each with its own time and source:
//   1. credential   — a key is saved in CHE's Keys (presence only; the value is never read here).
//   2. authenticated — the provider accepted that key in a real call (a checked timestamp).
//   3. gpu_allocated — a session reported a GPU (the device name, from the provider or the worker).
//   4. rendered     — a render job completed with an output file, a SHA-256 and a duration.
//
// Only (4) proves a provider works. A saved key is never "connected", and a successful login is never "rendering".
// Pure functions: the caller reads the stored evidence and passes it in. Nothing here calls a provider.

export const PROVIDER_STATES = Object.freeze(['not_configured', 'credential_only', 'authenticated', 'gpu_allocated', 'rendered']);
const SHA256 = /^[a-f0-9]{64}$/;
const GPU_NAME = /\b(?:T4|L4|A10G?|A100|H100|V100|P100|RTX\s?\d{3,4}\w*|GeForce\s?\w+|Tesla\s?\w+)\b/i;

const isTime = (v) => Number.isFinite(Date.parse(v || ''));

/**
 * Derive the four facts and the single honest state from one provider's evidence record.
 * `evidence` = { credential_present, authenticated_at, gpu: { name, allocated_at }, render: { job_id, status, sha256, seconds, output } }
 */
export function providerState(evidence = {}) {
  const credential = evidence.credential_present === true;
  const authenticated = credential && isTime(evidence.authenticated_at);
  const gpuName = String(evidence.gpu?.name || '').trim();
  const gpuAllocated = authenticated && isTime(evidence.gpu?.allocated_at) && GPU_NAME.test(gpuName);
  const r = evidence.render || {};
  const rendered = gpuAllocated && Boolean(r.job_id) && r.status === 'complete' && SHA256.test(String(r.sha256 || '')) && Number(r.seconds) > 0 && Boolean(r.output);
  const state = rendered ? 'rendered' : gpuAllocated ? 'gpu_allocated' : authenticated ? 'authenticated' : credential ? 'credential_only' : 'not_configured';
  return {
    credential,
    authenticated,
    gpu_allocated: gpuAllocated,
    rendered,
    gpu_name: gpuAllocated ? gpuName : null,
    state,
    // The one sentence CHE may say aloud for this provider. It never says "connected" or "works" below "rendered".
    say: SAY[state],
  };
}

const SAY = {
  not_configured: 'No key is saved for this provider.',
  credential_only: 'A key is saved, but it has not been checked with the provider yet.',
  authenticated: 'The provider accepted the key. No GPU has been allocated yet.',
  gpu_allocated: 'A GPU was allocated, but no render has completed.',
  rendered: 'A render completed on the provider, with a checksum and a receipt.',
};

/** Rank providers by the state that counts, then by the owner's order. Only `rendered` providers are trusted for a job. */
export function trustedProviders(list = []) {
  const rank = (s) => PROVIDER_STATES.indexOf(s);
  return list
    .map((p) => ({ id: p.id, ...providerState(p.evidence) }))
    .filter((p) => p.state !== 'not_configured')
    .sort((a, b) => rank(b.state) - rank(a.state));
}
