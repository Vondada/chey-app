// Owner-facing action gate. CHE may act on her own, but the owner rules require
// her to ask first before spending money or deleting/removing anything, and to
// open an app only after explicit permission for that app. These checks run in
// code, not only in the model's instructions.

const LEAD = String.raw`^(?:(?:please|now|then|also|and|ok|okay)\s+)*`;

const MONEY_RE = new RegExp(
  `${LEAD}(?:buy|purchase|pay(?:\\s+for)?|subscribe(?:\\s+to)?|order|transfer|wire|donate\\s+to)\\b|` +
  `\\b(?:buy|purchase|order|subscribe to)\\b[\\s\\S]{0,40}\\b(?:domain|plan|subscription|license)\\b`,
);
const DELETE_RE = new RegExp(
  `${LEAD}(?:delete|remove|erase|wipe|clear out|get rid of|throw away|unpublish|revoke)\\b`,
);

// Returns what kind of consequential action the text asks for, or '' when none.
export function classifyOwnerAction(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return '';
  if (MONEY_RE.test(t)) return 'money';
  if (DELETE_RE.test(t)) return 'delete';
  return '';
}

// Decision for one request. `grant` is the owner's explicit, recent yes for this
// exact action kind (for example { money: true }). Without it, the action is
// held and CHE must ask aloud first.
export function gateOwnerAction(text, grant = {}) {
  const kind = classifyOwnerAction(text);
  if (!kind) return { allowed: true, kind: '' };
  if (grant && grant[kind] === true) return { allowed: true, kind };
  return {
    allowed: false,
    kind,
    ask: kind === 'money'
      ? 'Before I spend or buy anything, I need your yes. Should I go ahead?'
      : 'Before I delete or remove anything, I need your yes. Should I go ahead?',
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
