// Paid OpenRouter is a LAST resort for CHE coding. This only checks a key's
// server-enforced monthly cap; it never creates credit or sends a paid request.
// Keep this file dependency-free so the existing GitHub runner can call it.
export const MAX_CODING_PAID_USD = 15;

export function validateMonthlyCap(payload, ceiling = MAX_CODING_PAID_USD) {
  const key = payload?.data;
  if (!key || typeof key !== 'object') return { ok: false, reason: 'No API-key status was returned.' };
  if (key.is_management_key || key.is_provisioning_key) return { ok: false, reason: 'Use a restricted inference key, not a management key.' };
  const limit = Number(key.limit);
  const left = Number(key.limit_remaining);
  if (key.limit === null || !Number.isFinite(limit) || limit <= 0 || limit > ceiling)
    return { ok: false, reason: 'Paid coding key must have a monthly cap of $15 or less.' };
  if (key.limit_reset !== 'monthly')
    return { ok: false, reason: 'Paid coding key must reset its spending cap monthly.' };
  if (key.include_byok_in_limit !== true)
    return { ok: false, reason: 'Paid coding key must count BYOK against its limit (and avoid separate billable BYOK connections).' };
  if (key.limit_remaining === null || !Number.isFinite(left) || left < 0.5)
    return { ok: false, reason: 'Paid coding key has under $0.50 remaining this month.' };
  return { ok: true, limit, remaining: left };
}

export async function paidGate({ env = process.env, fetcher = fetch } = {}) {
  if (env.CHE_CODING_PAID_FALLBACK !== 'true') {
    return { ok: false, reason: 'Paid fallback has not been approved and enabled.' };
  }
  const key = String(env.CHE_CODING_OPENROUTER_PAID_KEY || '').trim();
  if (!key) return { ok: false, reason: 'No separate capped paid key is configured.' };
  try {
    const response = await fetcher('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { ok: false, reason: `Could not verify the paid key (HTTP ${response.status}).` };
    return validateMonthlyCap(await response.json());
  } catch (_) {
    return { ok: false, reason: 'Could not verify the paid key with OpenRouter.' };
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await paidGate();
  if (!result.ok) {
    console.error(`Paid coding fallback blocked: ${result.reason}`);
    process.exitCode = 2;
  } else {
    console.log(`Paid coding fallback cap verified: $${result.limit}/month; $${result.remaining.toFixed(2)} remains.`);
  }
}
