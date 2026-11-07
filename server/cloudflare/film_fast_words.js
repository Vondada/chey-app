// The words that turn fast mode on for one film (film_fast.js). Kept free of imports so film_studio.filmIntent can use
// it without loading the compute router. Fast mode is never assumed: Modal must be named, or "fast mode" said.
export const FAST_WORDS = /\b(?:use|with|on|using|via|through|in)\s+modal\b|\bfast mode\b/i;
const NOT_FAST = /\b(?:not|no|don't|do not|never|without)\b[^.]{0,20}\b(?:modal|fast mode)\b/i;

export function fastAsked(text = '') {
  const t = String(text || '').replace(/[’]/g, "'");
  return FAST_WORDS.test(t) && !NOT_FAST.test(t);
}

/** The words with the fast-mode phrase taken out, so "re-render Brewed Anarchy with Modal" still names the film. */
export const withoutFastWords = (text = '') => String(text || '').replace(/[,\s]*\b(?:and\s+)?(?:make it fast\s+)?(?:use|with|on|using|via|through|in)\s+modal\b(?:\s+for (?:this|the|my) (?:film|movie|one))?|[,\s]*\b(?:in\s+|with\s+)?fast mode\b/gi, '').trim();

const money = (n) => `$${(Math.round(Number(n || 0) * 100) / 100).toFixed(2)}`;
/** What the finished film says about fast mode: its real cost, or why it ran free. '' for a free film. */
export function fastDoneLine(film) {
  const f = film?.fast;
  if (!f) return '';
  if (f.declined) return ` Fast mode did not run: ${String(f.declined).replace(/\.$/, '')}.`;
  if (Number.isFinite(f.cost_usd)) return ` Fast mode on Modal cost ${money(f.cost_usd)}${f.cost_provenance === 'OBSERVED' ? ` (${f.gpu_seconds} GPU seconds, measured)` : ' (counted at its worst case)'}; I estimated ${money(f.estimate_usd)}.`;
  return '';
}
