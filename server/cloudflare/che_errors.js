// Structured CHE engine errors.
// Owner chat never receives raw provider dumps. Diagnostics stay on the Worker.

export const ERROR_CATEGORIES = [
  'retryable_provider_error',
  'temporary_cloud_unavailable',
  'network_offline',
  'voice_unavailable',
  'capability_missing',
  'authentication_required',
  'owner_action_required',
  'permanent_provider_failure',
  'model_retired',
];

const OWNER_MESSAGES = {
  retryable_provider_error: "One moment, sir. I'm still working on that.",
  temporary_cloud_unavailable: "One moment, sir. I'm still working on that.",
  network_offline: "I can't reach the internet right now, sir. I'll keep going with what I have on this phone.",
  voice_unavailable: "My spoken voice is down, sir. I still have your text and the iPhone voice as backup.",
  capability_missing: "That tool isn't connected right now, sir.",
  authentication_required: "I can't do that one right now, sir. Nothing was done, and I won't keep you waiting on it.",
  owner_action_required: "I need you for this next step, sir.",
  permanent_provider_failure: "I can't do that one right now, sir. Nothing was done, and I won't keep you waiting on it.",
  model_retired: "I can't do that one right now, sir. Nothing was done, and I won't keep you waiting on it.",
};

export function classifyHttpStatus(status, message = '') {
  const text = String(message || '').toLowerCase();
  const code = Number(status) || 0;
  if (code === 401) return 'authentication_required';
  if (code === 402) return 'permanent_provider_failure';
  if (code === 403) return 'permanent_provider_failure';
  if (code === 404 || /not found|retired|does not exist|no longer available|unknown model/i.test(text)) {
    return 'model_retired';
  }
  if (code === 429) return 'retryable_provider_error';
  if ([500, 502, 503, 504].includes(code)) return 'retryable_provider_error';
  if (/enospc|no space left/i.test(text)) return 'retryable_provider_error';
  if (/quota|allowance|neurons|4006/i.test(text)) return 'retryable_provider_error';
  if (/timeout|abort|network|fetch failed/i.test(text)) return 'temporary_cloud_unavailable';
  if (code >= 400) return 'retryable_provider_error';
  return 'temporary_cloud_unavailable';
}

export function cooldownMsFor(category, status, retryAfterMs = 0) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, 1_000), 3_600_000);
  }
  if (category === 'authentication_required' || category === 'permanent_provider_failure') return 3_600_000;
  if (category === 'model_retired') return 10 * 60_000;
  if (Number(status) === 429) return 60_000;
  if ([500, 502, 503, 504].includes(Number(status))) return 20_000;
  return 20_000;
}

export function parseRetryAfter(header, now = Date.now()) {
  if (header == null || header === '') return 0;
  const raw = String(header).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return 0;
}

export function ownerFacingMessage(category, fallback) {
  return OWNER_MESSAGES[category] || fallback || OWNER_MESSAGES.temporary_cloud_unavailable;
}

export function makeEngineError({
  category = 'temporary_cloud_unavailable',
  quota = false,
  diagnostic = '',
  configured = true,
} = {}) {
  const message = configured
    ? ownerFacingMessage(category)
    : 'CHE needs at least one working free AI provider key while Cloudflare is resting.';
  const error = new Error(message);
  error.category = ERROR_CATEGORIES.includes(category) ? category : 'temporary_cloud_unavailable';
  error.retryable = !['owner_action_required'].includes(error.category);
  error.quota = Boolean(quota);
  error.diagnostic = String(diagnostic || '').slice(0, 1500);
  error.owner_safe = true;
  return error;
}

export function sanitizeOwnerText(text) {
  const raw = String(text || '');
  if (!raw) return ownerFacingMessage('temporary_cloud_unavailable');
  if (/all ai engines failed|enospc|stack trace|<html|pollinations|llm7|401|402|404|429|gsk_|sk-|AIza|Bearer /i.test(raw)
      && raw.length > 120) {
    return ownerFacingMessage('temporary_cloud_unavailable');
  }
  if (/all ai engines failed|retry limit reached/i.test(raw)) {
    return ownerFacingMessage('temporary_cloud_unavailable');
  }
  return raw.slice(0, 280);
}
