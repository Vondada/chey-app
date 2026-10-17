// Paid OpenRouter is a LAST resort for CHE coding. This checks the capped key's own
// status through OpenRouter's key endpoint: the monthly cap, and whether separately
// billed BYOK provider keys could spend outside that cap. It never creates credit or
// sends a paid request. Keep this file dependency-free: the runner calls it from a
// trusted copy taken from the base commit.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const MAX_CODING_PAID_USD = 15;

// Only the key's numeric and boolean status fields, plus the reset interval and the
// field names. The key's label and any key text are never returned or logged.
export function keyStatusSummary(payload) {
  const key = payload && typeof payload.data === 'object' && payload.data ? payload.data : {};
  const fields = Object.keys(key).sort();
  const values = {};
  for (const name of fields) {
    const value = key[name];
    if (name === 'limit_reset' && typeof value === 'string') values[name] = value;
    else if ((typeof value === 'number' || typeof value === 'boolean' || value === null) && /limit|usage|byok|provision|management|free/i.test(name)) values[name] = value;
  }
  return { fields, values };
}

// `byokConfirmedNone` is the owner's confirmation that this OpenRouter account has no
// BYOK provider keys. With no BYOK keys there is no BYOK route, so no setting is needed.
export function validateMonthlyCap(payload, ceiling = MAX_CODING_PAID_USD, { byokConfirmedNone = false } = {}) {
  const key = payload?.data;
  if (!key || typeof key !== 'object') return { ok: false, reason: 'No API-key status was returned.' };
  if (key.is_management_key || key.is_provisioning_key) return { ok: false, reason: 'Use a restricted inference key, not a management key.' };
  const limit = Number(key.limit);
  const left = Number(key.limit_remaining);
  if (key.limit === null || !Number.isFinite(limit) || limit <= 0 || limit > ceiling)
    return { ok: false, reason: 'Paid coding key must have a monthly cap of $15 or less.' };
  if (key.limit_reset !== 'monthly')
    return { ok: false, reason: 'Paid coding key must reset its spending cap monthly.' };
  if (key.limit_remaining === null || !Number.isFinite(left) || left < 0.5)
    return { ok: false, reason: 'Paid coding key has under $0.50 remaining this month.' };
  // BYOK: a route only exists when provider keys were added to the account.
  if (key.include_byok_in_limit === true) return { ok: true, limit, remaining: left, byok: 'counted_in_cap' };
  if (!byokConfirmedNone) {
    return {
      ok: false,
      reason: 'Paid coding is blocked until BYOK is ruled out. Either turn on "include BYOK in limit" for this key, or confirm this OpenRouter account has no BYOK provider keys and set the repository variable CHE_CODING_OPENROUTER_NO_BYOK to true.',
    };
  }
  // Live tripwire: BYOK spend on this key this month means a BYOK route is in use.
  const byokSpend = key.byok_usage_monthly;
  if (typeof byokSpend === 'number' && Number.isFinite(byokSpend) && byokSpend > 0) {
    return { ok: false, reason: 'This key has separately billed BYOK spend this month, which the cap does not count. Paid coding stays blocked.' };
  }
  return { ok: true, limit, remaining: left, byok: 'confirmed_none' };
}

export async function paidGate({ env = process.env, fetcher = fetch } = {}) {
  if (env.CHE_CODING_PAID_FALLBACK !== 'true') {
    return { ok: false, reason: 'Paid fallback has not been approved and enabled.' };
  }
  const key = String(env.CHE_CODING_OPENROUTER_PAID_KEY || '').trim();
  if (!key) return { ok: false, reason: 'No separate capped paid key is configured.' };
  const byokConfirmedNone = String(env.CHE_CODING_OPENROUTER_NO_BYOK || '').trim() === 'true';
  try {
    const response = await fetcher('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { ok: false, reason: `Could not verify the paid key (HTTP ${response.status}).` };
    const payload = await response.json();
    return { ...validateMonthlyCap(payload, MAX_CODING_PAID_USD, { byokConfirmedNone }), summary: keyStatusSummary(payload) };
  } catch (_) {
    return { ok: false, reason: 'Could not verify the paid key with OpenRouter.' };
  }
}

// Run as a script: report the key's status fields (no secrets), then the verdict.
// The comparison is by real path, so a checkout under any directory name still runs
// the check; a failed check always exits non-zero.
const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = await paidGate();
  if (result.summary) console.log(`Key status: ${JSON.stringify(result.summary)}`);
  if (!result.ok) {
    console.error(`Paid coding fallback blocked: ${result.reason}`);
    process.exitCode = 2;
  } else {
    console.log(`Paid coding fallback cap verified: $${result.limit}/month; $${result.remaining.toFixed(2)} remains; BYOK: ${result.byok}.`);
  }
}
