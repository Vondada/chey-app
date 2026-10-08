// Owner-facing action gate. CHE may act on her own, but the owner rules require
// her to ask first before spending money or deleting/removing anything, and to
// open an app only after explicit permission for that app. These checks run in
// code, not only in the model's instructions.
//
// Matching is anchored to the request's own verb: at the start of the request,
// or after a request lead-in such as "can you", "go ahead and", "I want to" or
// a quote mark. Words like "in order" or "remove the owner approval check"
// inside a coding instruction are subject matter, not an owner request to spend
// or delete. Negated forms ("do not delete") are never gated.

const LEAD = String.raw`^(?:(?:please|pls|now|then|also|and|ok|okay|just|to|let's|lets|can you|could you|would you|will you|go ahead and|i want to|i'd like to|id like to|i need you to)\s+)*["'(]?`;
const MONEY_VERB = String.raw`(?:buy|purchase|pay|subscribe(?:\s+to)?|donate(?:\s+to)?|charge|checkout|upgrade\s+to|renew|top\s+up|sign\s+up\s+for|spend)`;
const MONEY_ORDER = String.raw`order\s+(?:me\s+|us\s+)?(?:a|an|another|more|some|\d|\$)`;
const MONEY_TRANSFER = String.raw`(?:transfer|wire)\s+(?:\$|\d|money|funds|dollars?|to\s)`;
const MONEY_RE = new RegExp(`${LEAD}(?:${MONEY_VERB}\\b|${MONEY_ORDER}|${MONEY_TRANSFER})`, 'i');
const DELETE_VERB = String.raw`(?:delete|remove|erase|wipe|clear(?:\s+out)?|forget|reset|cancel|discard|trash|uninstall|drop|unpublish|revoke|get\s+rid\s+of|throw\s+away)`;
const DELETE_RE = new RegExp(`${LEAD}${DELETE_VERB}\\b`, 'i');
const NEGATED_RE = /\b(?:do\s+not|don't|dont|never|not|no)\s+$/i;

// Each clause of a compound request ("buy X, then delete Y") is checked on its
// own, so a verb that opens any clause counts.
function hasVerb(re, t) {
  const clauses = t.split(/[.;!?]|\b(?:then|and then|and|also|after that|afterwards)\b|,/);
  return clauses.some((clause) => {
    const c = clause.trim();
    const m = re.exec(c);
    return Boolean(m) && !NEGATED_RE.test(c.slice(0, m.index));
  });
}

// Every kind of consequential action the text asks for, in a stable order.
// Returns [] when the request is ordinary.
export function classifyOwnerActions(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const kinds = [];
  if (hasVerb(MONEY_RE, t)) kinds.push('money');
  if (hasVerb(DELETE_RE, t)) kinds.push('delete');
  return kinds;
}

// Single-kind view kept for callers that only need the first kind.
export function classifyOwnerAction(text) {
  return classifyOwnerActions(text)[0] || '';
}

// Decision for one request. `grant` holds the owner's explicit, recent yes per
// kind (for example { money: true }). The request is allowed only when every
// kind it contains has a grant. Without one, CHE must ask aloud first.
export function gateOwnerAction(text, grant = {}) {
  const kinds = classifyOwnerActions(text);
  if (!kinds.length) return { allowed: true, kind: '', kinds: [] };
  const missing = kinds.filter((k) => !(grant && grant[k] === true));
  if (!missing.length) return { allowed: true, kind: kinds[0], kinds };
  const parts = [];
  if (missing.includes('money')) parts.push('spend or buy anything');
  if (missing.includes('delete')) parts.push('delete or remove anything');
  return {
    allowed: false,
    kind: missing[0],
    kinds,
    ask: `Before I ${parts.join(' or ')}, I need your yes. Should I go ahead?`,
  };
}

// Apps need the owner's explicit permission before CHE opens or acts in them.
// `allowedApps` is the set the owner has granted, keyed by lowercase app name.
export function gateAppAccess(appName, allowedApps = []) {
  const name = String(appName || '').toLowerCase().trim();
  if (!name) return { allowed: false, ask: 'Which app should I open?' };
  const granted = (allowedApps || []).map((a) => String(a).toLowerCase().trim());
  if (granted.includes(name)) return { allowed: true, app: name };
  return {
    allowed: false,
    app: name,
    ask: `You have not given me permission to use ${name} yet. Say yes to allow it, and I will open it.`,
  };
}

// A held request waits in Durable Object storage under this key until the owner
// answers. Only a plain yes at the start of the next turn releases it.
export const PENDING_OWNER_ACTION_KEY = 'che:pending_owner_action';
export const PENDING_OWNER_ACTION_MS = 10 * 60 * 1000;

const YES_PHRASES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'confirm', 'confirmed', 'go ahead', 'do it', 'yes go ahead', 'yes do it', 'please do it', 'yes please do it']);

export function isOwnerYes(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  return YES_PHRASES.has(t);
}

// Grant object that releases exactly the kinds a held request contained.
export function grantForKinds(kinds = []) {
  const grant = {};
  for (const k of kinds) if (k === 'money' || k === 'delete') grant[k] = true;
  return grant;
}
