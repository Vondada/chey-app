// Durable provider health + cooldown store.
// Isolate memory is a cache. Durable Object / Worker storage is the source
// of truth so a new isolate does not forget a 401 or 429.

const HEALTH_KEY = 'ai_health';
const COOLDOWN_KEY = 'ai_provider_cooldown';

export async function loadHealth(storage) {
  if (!storage?.get) return {};
  try {
    const value = await storage.get(HEALTH_KEY);
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

export async function saveHealth(storage, health) {
  if (!storage?.put || !health) return;
  try { await storage.put(HEALTH_KEY, health); } catch (_) { /* best effort */ }
}

export async function loadCooldowns(storage, now = Date.now()) {
  if (!storage?.get) return new Map();
  try {
    const value = await storage.get(COOLDOWN_KEY);
    const rows = value && typeof value === 'object' ? value : {};
    const map = new Map();
    for (const [id, row] of Object.entries(rows)) {
      const until = Number(row?.until || row) || 0;
      if (until > now) map.set(id, until);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

export async function saveCooldowns(storage, cooldownMap, extras = {}) {
  if (!storage?.put) return;
  const rows = {};
  for (const [id, until] of cooldownMap.entries()) {
    rows[id] = {
      until,
      ...(extras[id] || {}),
    };
  }
  try { await storage.put(COOLDOWN_KEY, rows); } catch (_) { /* best effort */ }
}

export function noteProviderOutcome(health, providerId, {
  ok,
  status = 0,
  category = '',
  model = '',
  latencyMs = null,
  retryAfterMs = 0,
  now = Date.now(),
} = {}) {
  const id = String(providerId).split(':')[0];
  const row = health[id] || {
    success: 0,
    failure: 0,
    score: 1,
    last_success_at: null,
    last_failure_at: null,
    last_status: 0,
    last_category: '',
    last_model: '',
    last_working_model: '',
    latency_ms: null,
    recent_failure_count: 0,
    retry_after_ms: 0,
  };
  if (ok) {
    row.success += 1;
    row.last_success_at = now;
    row.last_status = 200;
    row.last_category = 'ok';
    row.recent_failure_count = 0;
    if (model) row.last_working_model = model;
    if (Number.isFinite(latencyMs)) row.latency_ms = latencyMs;
    row.score = Math.min(1, (row.score || 1) * 0.8 + 0.2);
  } else {
    row.failure += 1;
    row.last_failure_at = now;
    row.last_status = status;
    row.last_category = category;
    row.recent_failure_count = (row.recent_failure_count || 0) + 1;
    row.retry_after_ms = retryAfterMs || 0;
    row.score = Math.max(0, (row.score || 1) * 0.6);
  }
  if (model) row.last_model = model;
  health[id] = row;
  return row;
}

export function capacityMode(used, limit) {
  if (!limit) return 'normal';
  const ratio = used / limit;
  if (ratio >= 0.95) return 'emergency';
  if (ratio >= 0.70) return 'reserve';
  return 'normal';
}

export function shouldHoldCapacity({ used = 0, limit = 0, ownerChat = false, emergency = false } = {}) {
  if (!limit) return false;
  const mode = capacityMode(used, limit);
  if (mode === 'normal') return false;
  if (emergency || ownerChat) return mode === 'emergency' && used >= limit;
  return true;
}
