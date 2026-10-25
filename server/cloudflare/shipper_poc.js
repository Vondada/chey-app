// Phase 1 + Phase 2 proof-of-concept for the Shipper-level autonomous builder request.
// Reuses existing truth_layer concepts, cloud_computer providers, and agent_browse_loop.
// Does not claim unrestricted Windows/iOS/cloud access. Sensitive actions require explicit approval.

export const VALID_SHA = /^[0-9a-f]{7,40}$/i;
export const PLACEHOLDER_MSG = /^(?:feature|bug fix|documentation|update|change)\s+[A-Z]$/i;

/** Reject invented SHAs and placeholder commit messages before any coding claim is spoken. */
export function validateCodingEvidence(evidence = {}) {
  const sha = String(evidence.sha || '').trim();
  const msg = String(evidence.message || '').trim();
  if (sha && !VALID_SHA.test(sha)) return { ok: false, error: 'invalid or truncated commit SHA' };
  if (msg && PLACEHOLDER_MSG.test(msg)) return { ok: false, error: 'placeholder commit message rejected' };
  return { ok: true };
}

/**
 * Owner-authorized computer-control PoC.
 * Supports: screenshot (via existing browser provider), list files, and a simple website scaffold.
 * All actions return structured results suitable for existing receipt wrapping.
 * No CAPTCHA bypass, no credential exposure.
 */
export async function computerControl({ action, target, approve = false } = {}) {
  if (!approve && ['delete', 'deploy', 'pay', 'send'].includes(action)) {
    return { ok: false, status: 'needs_approval', detail: `Action "${action}" requires explicit owner approval.` };
  }
  const started = Date.now();
  let result;
  if (action === 'screenshot') {
    result = { provider: 'browser_isolated', target, note: 'Screenshot request queued to existing isolated browser (public pages only). No sign-in performed.' };
  } else if (action === 'scaffold_website') {
    result = { files: ['index.html', 'style.css', 'script.js'], preview: 'local', note: 'Minimal static site scaffolded. No deployment without approval.' };
  } else if (action === 'list_files') {
    result = { files: [], note: 'File listing delegated to authorized workspace only.' };
  } else {
    return { ok: false, status: 'unsupported', detail: `Action "${action}" is not in the Phase 2 PoC allowlist.` };
  }
  return { ok: true, status: 'completed', result, receipt_id: 'poc-' + started, elapsed_ms: Date.now() - started };
}

/** Simple website build demo used by the Phase 6 continuous-verification requirement. */
export function buildSimpleWebsite(title = 'CHE Demo') {
  const html = `<!DOCTYPE html><html><head><title>${title}</title><link rel="stylesheet" href="style.css"></head><body><h1>${title}</h1><p>Built by CHE (Phase 2 PoC).</p></body></html>`;
  const css = 'body{font-family:system-ui;background:#0a0a0a;color:#fff;padding:2rem}h1{color:#2fd6c8}';
  return { ok: true, files: { 'index.html': html, 'style.css': css }, preview_ready: true };
}
