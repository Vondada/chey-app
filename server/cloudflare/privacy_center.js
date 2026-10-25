// CHE Privacy Center, Worker side (owner, 2026-10-25; spec: docs/CHE_MODAL_FREE_FIRST_USAGE_PRIVACY.md stage 5,
// built as documented in docs/CHE_PRIVACY_CENTER.md). Kept apart from GPU and compute features.
//
// The Privacy Center itself lives on the owner's iPhone (lib/rooms/che_privacy_center_room.dart): consent,
// the inventory, broker actions and the password breach check never come to this server. The Worker does
// three things only:
//   1. The SSN guard (defense in depth): every JSON body is cleaned of Social Security numbers before any
//      route, memory, log or model sees it, and a chat turn that carried one gets a fixed reply instead.
//   2. Voice routing: "open Privacy Center" and the /privacy-center command answer with open_screen, so the
//      phone opens the room. Nothing is turned on, checked or removed from here.
//   3. Names of the services the owner connected in CHE (GET /api/privacy/services): names and where they
//      came from, never a token, fingerprint, account or secret.

import { redactSsn, redactSsnDeep, SSN_REDACTION } from './security_core/ssn.js';

export const PRIVACY_SOURCE = 'che_privacy_center';

export const SSN_REPLY = 'I did not keep that. CHE never stores a Social Security number: I removed it before anything was saved, logged or sent to an AI. '
  + 'When a service needs your number, enter it yourself on that service\'s official site: ssa.gov/myaccount for Social Security, '
  + 'irs.gov for an Identity Protection PIN, and Equifax, Experian and TransUnion to freeze your credit. '
  + 'Say "open Privacy Center" for those official links.';

/**
 * Cleans a parsed request body of SSNs. Returns the cleaned body, how many were removed, and whether the
 * chat message itself carried one (that turn gets SSN_REPLY and nothing else).
 */
export function guardSsnBody(body) {
  if (!body || typeof body !== 'object') return { body, removed: 0, inMessage: false };
  const inMessage = typeof body.message === 'string' && redactSsn(body.message).count > 0;
  const counter = { count: 0 };
  const clean = redactSsnDeep(body, counter);
  return { body: counter.count ? clean : body, removed: counter.count, inMessage };
}

/** The done fields of the fixed SSN reply. */
export const SSN_DONE = Object.freeze({ source: 'che_ssn_guard', ok: true, ssn_removed: true, model_calls: 0 });

export { SSN_REDACTION };

// ─── Voice routing ───────────────────────────────────────────────────────
// The same phrases the phone handles on the device (lib/security/che_privacy_center.dart cheParsePrivacyVoice).
// The phone answers them itself; these are for /privacy-center and any client that sends them here.
const speech = (m) => String(m || '').trim().toLowerCase().replace(/[’]/g, "'")
  .replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chay|chey|shay)(?![a-z'])[\s,.:;!?-]*/, '')
  .replace(/^(?:please|can you|could you)\s+/, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();

const CENTER = "(?:the |my |che's )?privacy (?:center|centre)";

/** What the owner asked of the Privacy Center, or null. */
export function privacyIntent(message) {
  const t = speech(message);
  if (!t || t.length > 200) return null;
  if (new RegExp(`^(?:turn on|switch on|enable|start|activate) ${CENTER}$`).test(t)) return { kind: 'turn_on' };
  if (new RegExp(`^(?:turn off|switch off|disable|stop|deactivate) ${CENTER}$`).test(t)) return { kind: 'turn_off' };
  if (new RegExp(`^(?:open|show(?: me)?|go to|take me to|bring up) ${CENTER}(?: (?:page|screen|room))?$|^${CENTER}$`).test(t)) return { kind: 'open' };
  if (/^(?:check|scan) (?:my |all my |the )?(?:saved |vault )?passwords? (?:for (?:breaches|leaks)|against (?:breaches|have i been pwned))$|^(?:have|were|are) (?:any of )?my passwords? (?:been )?(?:leaked|breached|pwned|exposed)$/.test(t)) return { kind: 'passwords' };
  if (/^(?:show|list|read|check)(?: me)? (?:the )?(?:data brokers?|people[- ]search sites?)$|^remove me from (?:data brokers?|people[- ]search sites?)$/.test(t)) return { kind: 'brokers' };
  if (/^(?:freeze my credit|(?:how do i |help me )?(?:freeze|lock) my credit|credit (?:freeze|monitoring))$/.test(t)) return { kind: 'credit' };
  if (/^(?:has|was|is) my email (?:been )?(?:in a |part of a )?(?:breach|breached|leaked|pwned)$/.test(t)) return { kind: 'email' };
  return null;
}

const SPOKEN = {
  open: 'Opening Privacy Center.',
  turn_on: 'Opening Privacy Center. Its consent is kept only on your iPhone: say "turn on Privacy Center" there and it records your words and the time.',
  turn_off: 'Opening Privacy Center. Turning it off and deleting its data happens on your iPhone, after you confirm there.',
  passwords: 'Opening Privacy Center. The password check runs only on your iPhone: the passwords stay in its vault, and only the first five characters of each password\'s fingerprint go to Have I Been Pwned.',
  brokers: 'Opening Privacy Center to the people-search sites and their official opt-out pages. Nothing is submitted without your yes.',
  credit: 'Opening Privacy Center to the credit freeze links: Equifax, Experian and TransUnion, the CFPB page and IdentityTheft.gov. You enter your details directly on those sites.',
  email: 'Checking an email against breaches automatically needs Have I Been Pwned\'s paid API key, so CHE cannot do it at no cost. I opened Privacy Center: its Have I Been Pwned link lets you search your email yourself on their site for free.',
};

/** The reply for a privacy request: words plus the done fields that open the room on the phone. */
export function privacyReply(ask, { owner = true } = {}) {
  if (!owner) return { text: 'Only the CHE owner can open the Privacy Center. Nothing was opened.', fields: { source: PRIVACY_SOURCE, ok: false, model_calls: 0 } };
  const kind = SPOKEN[ask?.kind] ? ask.kind : 'open';
  return { text: SPOKEN[kind], fields: { source: PRIVACY_SOURCE, ok: true, model_calls: 0, open_screen: 'privacy_center', privacy_action: kind } };
}

/** "/privacy-center turn on": the command's words go through the same intent. */
export function privacyCommand(input, opts = {}) {
  const words = String(input || '').trim();
  const ask = privacyIntent(words) || privacyIntent(`${words} privacy center`) || { kind: 'open' };
  const r = privacyReply(ask, opts);
  return opts.command ? [r.text, { ...r.fields, command: opts.command }] : r;
}

/** A Privacy Center chat turn for the owner: [text, done fields], or null. */
export function privacyTurn(message) {
  const ask = privacyIntent(message);
  if (!ask) return null;
  const r = privacyReply(ask);
  return [r.text, r.fields];
}

/** GET /api/privacy/services: { services: [{ name, source }] } from the connectors and onboarding records. */
export async function privacyServices(connectors, storage) {
  return { services: privacyServiceNames(connectors, await onboardingRecords(storage)) };
}

// ─── Connected services: names only ──────────────────────────────────────
// Connectors the owner signs in to or adds a key for (command_catalog.js CONNECTORS); built-in CHE parts are not
// services he connected.
const EXTERNAL = {
  broker: 'NinjaTrader / Tradovate', youtube: 'YouTube', gmail: 'Gmail', drive: 'Google Drive', calendar: 'Google Calendar',
  google_ads: 'Google Ads', voice: 'ElevenLabs or Fish voice', github: 'GitHub', stripe: 'Stripe', sms: 'Twilio SMS',
};
const titled = (id) => String(id || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);

/**
 * The services connected in CHE: [{ name, source }]. `connectors` is commandConnectors() output, `onboarding`
 * the stored service-onboarding records. Only names leave this function.
 */
export function privacyServiceNames(connectors = {}, onboarding = [], names = {}) {
  const out = new Map();
  for (const [id, label] of Object.entries(EXTERNAL)) {
    if (connectors?.[id]?.state === 'ready') out.set(label.toLowerCase(), { name: label, source: 'Connected in CHE' });
  }
  for (const rec of Array.isArray(onboarding) ? onboarding : []) {
    if (rec?.state !== 'verified' || !rec.provider) continue;
    const name = String(names[rec.provider] || titled(rec.provider));
    if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, source: 'Set up through CHE service onboarding' });
  }
  return [...out.values()];
}

/** The stored onboarding records, read by prefix. Failures read as none. */
export async function onboardingRecords(storage) {
  try {
    const listed = await storage.list({ prefix: 'onboarding:' });
    return [...listed.values()].filter((r) => r && typeof r === 'object');
  } catch (_) {
    return [];
  }
}
