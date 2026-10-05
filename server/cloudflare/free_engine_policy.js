// Owner rule: CHE answers on free engines only. Switching engines is fine.
// Spending money is not. Token use stays small unless a coding job needs more.

export function freeOpenRouterModel(model) {
  const id = String(model || '').trim() || 'meta-llama/llama-3.3-70b-instruct:free';
  return id.endsWith(':free') ? id : `${id}:free`;
}

export function thriftyMaxTokens(input = {}) {
  const coding = input.che_capability === 'coding' || input.che_strongest === true;
  const cap = coding ? 1400 : 420;
  const requested = Number(input.max_tokens || 0);
  const fallback = coding ? 900 : 280;
  const value = requested > 0 ? requested : fallback;
  return Math.max(64, Math.min(value, cap));
}
