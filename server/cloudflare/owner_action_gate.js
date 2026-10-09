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

const VOCATIVE = String.raw`(?:(?:hey|hi|ok|okay)\s+(?:chey|che|chay)\s*,?\s*)?`;
const LEAD = String.raw`^(?:${VOCATIVE}(?:(?:please|pls|plz|now|then|also|and|ok|okay|just|to|let's|lets|let\s+us|can you|could you|would you|will you|i want you to|i need you to|i want to|i'd like to|id like to|i am going to|i'm going to|im going to|go ahead and|you should|you must)\s+)*)["'(]?`;
// Verb forms are written out in full so "delete", "deleting", "pays" and
// "purchased" all match without matching unrelated words.
const MONEY_VERB = String.raw`(?:bought|buy(?:s|ing)?|purchas(?:e|es|ed|ing)|pay(?:s|ing)?|paid|subscrib(?:e|es|ed|ing)(?:\s+to)?|donat(?:e|es|ed|ing)(?:\s+to)?|charg(?:e|es|ed|ing)|checkout|upgrad(?:e|es|ed|ing)\s+to|renew(?:s|ed|ing)?|top\s+up|sign\s+up\s+for|spend(?:s|ing)?|withdr(?:aw|aws|awing|awn|ew)|cash\s+out|take\s+out\s+(?:\$|\d|money|cash)|make\s+a\s+purchase|place\s+an?\s+order|send(?:s|ing)?\s+(?:money|\$))`;
const MONEY_ORDER = String.raw`order(?:s|ed|ing)?\s+(?:me\s+|us\s+)?(?:a|an|another|more|some|\d|\$|[a-z]+)`;
const MONEY_TRANSFER = String.raw`(?:transfer(?:s|red|ring)?|wire(?:s|d|ing)?)\s+(?:\$|\d|money|funds|dollars?|to\s)`;
const MONEY_RE = new RegExp(`${LEAD}(?:${MONEY_VERB}\\b|${MONEY_ORDER}|${MONEY_TRANSFER})`, 'i');
// Strong delete verbs always count. "Order" followed by a bare word is held only
// when it is not "order of/in/by" (checked below), so "order pizza" is held.
// Weak verbs (reset, clear, cancel, drop) count only with a data object, so
// "reset my thoughts" and "clear the screen" are ordinary chat.
const DATA_OBJECT = String.raw`(?:notes?|files?|data|history|memor(?:y|ies)|skills?|keys?|accounts?|saved|learned|everything|all|settings|lists?|chats?|messages?|changes?|subscriptions?|orders?|bookings?|meetings?|appointments?|apps?|jobs?|queue|cache|logs?|records?|photos?|videos?|contacts?|emails?|drafts?|events?|reminders?)`;
const STRONG_DELETE = String.raw`(?:delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|forget(?:s|ting)?|discard(?:s|ed|ing)?|trash(?:es|ed|ing)?|uninstall(?:s|ed|ing)?|unpublish(?:es|ed|ing)?|revok(?:e|es|ed|ing)|get\s+rid\s+of|throw\s+away)`;
const WEAK_DELETE = String.raw`(?:reset(?:s|ting)?|clear(?:s|ed|ing)?(?:\s+out)?|cancel(?:s|ed|ling|ing)?|drop(?:s|ped|ping)?)(?:\s+[\w'$]+){0,4}?\s+${DATA_OBJECT}`;
const DELETE_RE = new RegExp(`${LEAD}(?:${STRONG_DELETE}|${WEAK_DELETE})\\b`, 'i');
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

// Apps CHE can open or act in, in the lowercase names the rest of CHE uses.
// Short or ambiguous aliases (x, ig, fb, drive, yt) are left out on purpose:
// matching them would hold innocent turns like "on the x axis". Every false
// hold costs the owner one yes; a missed grant would skip the ask entirely.
const KNOWN_APPS = [
  'app store', 'google calendar', 'google maps', 'google drive', 'google docs', 'microsoft teams',
  'prime video', 'yahoo mail', 'pluto tv', 'disney+', 'tradingview', 'ninjatrader', 'tradesea',
  'instagram', 'snapchat', 'facebook', 'linkedin', 'whatsapp', 'messenger', 'telegram',
  'chatgpt', 'youtube', 'spotify', 'outlook', 'notion', 'pinterest', 'netflix',
  'weather', 'reminders', 'messages', 'settings', 'safari', 'photos', 'calendar', 'amazon',
  'paypal', 'reddit', 'discord', 'twitch', 'threads', 'gmail', 'slack', 'zoom', 'hulu', 'tubi',
  'github', 'grok', 'music', 'notes', 'mail', 'email', 'maps', 'clock', 'camera',
];
// Sorted longest first so "google maps" matches before "maps" would.
const APPS_RE = [...new Set(KNOWN_APPS)].sort((a, b) => b.length - a.length)
  .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
// "open X" as the owner says it: the verb names the app outright, with a
// clean end after it. No "my" or "the" before the name, so "use my notes to
// answer this" (CHE's own memory, not the Notes app) never grants anything.
const APP_OPEN_RE = new RegExp(`${LEAD}(?:open|launch|play|go\\s+to|watch|use|show\\s+me)\\s+(${APPS_RE})(?=$|[.,!?;]|\\s+(?:and|to|now|please)\\b)`, 'i');
const OPEN_VERB_RE = /\b(?:open|launch|play|go\s+to|watch|use|show\s+me)\b/i;
// "the notes app" and friends: the word "app" makes the name unambiguous.
const APP_NAMED_RE = new RegExp(`(?:${APPS_RE})\\s+app\\b`, 'i');
// A turn that needs an app without opening it: "read my last note in notes",
// "what's on spotify". "my" is never allowed before the name, so "in my notes"
// (CHE's own memory) stays ordinary chat. GitHub is left out: repo research
// goes through CHE's own API ("study X on GitHub", "the github readme"), not
// through the owner's app — only an explicit "open github" grants it.
const IMPLICIT_APPS_RE = [...new Set(KNOWN_APPS.filter((a) => a !== 'github'))].sort((a, b) => b.length - a.length)
  .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const APP_IN_RE = new RegExp(`\\b(?:in|on)\\s+(?:the\\s+)?(${IMPLICIT_APPS_RE})\\b`, 'i');

// An app is explicitly granted only if the open verb targets that exact app.
// A mention such as "open the report and explain why the Notes app is slow"
// is not owner permission to access Notes.
const APP_NAMED_OPEN_RE = new RegExp(
  LEAD + '(?:open|launch|play|go\\s+to|watch|use|show\\s+me)\\s+(?:the\\s+)?(' +
    APPS_RE + ')\\s+app(?=$|[.,!?;]|\\s+(?:and|to|now|please)\\b)', 'i',
);

// Classify each clause independently. A single explicit open must never
// bypass another app mentioned later in the same owner request.
export function classifyAppAccesses(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const explicit = [], required = [];
  if (!t) return { explicit, required };
  const clauses = t.split(/[.;!?]|\b(?:and then|and|then|also|after that)\b/i);
  for (const part of clauses) {
    const clause = part.trim();
    if (!clause) continue;
    const direct = APP_OPEN_RE.exec(clause) || APP_NAMED_OPEN_RE.exec(clause);
    const openApp = direct ? direct[1].toLowerCase() : '';
    if (openApp && !explicit.includes(openApp)) explicit.push(openApp);
    const named = APP_NAMED_RE.exec(clause);
    const implicit = named ? named[0].toLowerCase().replace(/\s+app$/, '')
      : (APP_IN_RE.exec(clause)?.[1]?.toLowerCase() || '');
    if (implicit && implicit !== openApp && !required.includes(implicit)) required.push(implicit);
  }
  return { explicit, required: required.filter((app) => !explicit.includes(app)) };
}

// Retain existing single-app helpers for other call sites.
export function classifyExplicitAppOpen(text) {
  return classifyAppAccesses(text).explicit[0] || '';
}
export function classifyAppNeed(text) {
  return classifyAppAccesses(text).required[0] || '';
}

// Another AI's money or delete request is never carried out, whatever it says.
// The reply names what did not happen and the owner's next step, instead of a
// bare refusal. Returns '' when the request has no money or delete action.
export function peerActionReply(text) {
  const kinds = classifyOwnerActions(text);
  if (!kinds.length) return '';
  const done = kinds.length > 1 ? "spent, bought or deleted" : kinds[0] === 'money' ? 'spent or bought' : 'deleted';
  const need = kinds.length > 1 ? 'Those need' : kinds[0] === 'money' ? 'Spending money needs' : 'Deleting needs';
  return `I haven't ${done} anything. ${need} the owner's direct yes, and I don't act on requests from other AIs. If the owner wants it, the owner can ask me directly, and I'll confirm exactly what I'll do before I do it.`;
}

// A held request waits in Durable Object storage under this key until the owner
// answers. Only a plain yes at the start of the next turn releases it.
export const PENDING_OWNER_ACTION_KEY = 'che:pending_owner_action';
export const PENDING_OWNER_ACTION_MS = 10 * 60 * 1000;

// The apps the owner has granted, in Durable Object storage, and the held
// "may I use X" request waiting for his yes. Grants are permanent: one yes,
// or one explicit "open X", allows that app from then on.
export const APPS_GRANTED_KEY = 'che:allowed_apps';
export const PENDING_APP_ACTION_KEY = 'che:pending_app_action';
export const PENDING_APP_ACTION_MS = 10 * 60 * 1000;

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
