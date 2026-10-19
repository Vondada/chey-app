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

// "CHE, buy it", "hey Chey buy it" and a bare "CHE buy it" all address CHE.
// "Shay" is also a person's name ("Shay paid me back"), so it needs "hey" or a comma.
const VOCATIVE = String.raw`(?:(?:(?:hey|hi|ok|okay)\s+(?:chey|che|chay|shay)|(?:chey|che|chay)|shay(?=\s*[,:]))\b\s*[,:]?\s*)?`;
const LEAD = String.raw`^(?:${VOCATIVE}(?:(?:please|pls|plz|now|then|also|and|ok|okay|just|to|let's|lets|let\s+us|can you|could you|would you|will you|i want you to|i need you to|i want to|i'd like to|id like to|i am going to|i'm going to|im going to|go ahead and|you should|you must)\s+)*)["'(]?`;
// Verb forms are written out in full so "delete", "deleting", "pays" and
// "purchased" all match without matching unrelated words.
// An order placed with the broker or a shop: "place an order for pizza", "place sell orders", "put in a sell order",
// "place a stop-loss order", "place a GTC order", "place a bracket order", "place an IOC order". Up to three words may sit
// between "place" and "order", so an order type outside any list is held too. "in order to" and "in order of" are not orders
// ("put in order to finish the report"). The word "order" is required, so "place a call to Ann" is not held (review of
// PR #356, rounds 3 and 4).
const ORDER_OBJECT = String.raw`(?:(?:an?|another|some|\d+|my|the)\s+)?(?:[\w-]+\s+){0,3}?orders?\b(?!\s+(?:to|of|by|in|that)\b)`;
const MONEY_VERB = String.raw`(?:bought|buy(?:s|ing)?|purchas(?:e|es|ed|ing)|pay(?:s|ing)?|paid|subscrib(?:e|es|ed|ing)(?:\s+to)?|donat(?:e|es|ed|ing)(?:\s+to)?|charg(?:e|es|ed|ing)|checkout|upgrad(?:e|es|ed|ing)\s+to|renew(?:s|ed|ing)?|top\s+up|sign\s+up\s+for|spend(?:s|ing)?|withdr(?:aw|aws|awing|awn|ew)|cash\s+out|take\s+out\s+(?:\$|\d|money|cash)|make\s+a\s+purchase|place\s+${ORDER_OBJECT}|(?:put|enter|submit)\s+(?:in\s+)?${ORDER_OBJECT}|send(?:s|ing)?\s+(?:money|\$))`;
// "sell" moves money the other way, so a sale of anything is held like a purchase (comprehension audit, issue #350: "can
// you open Robinhood and sell my Tesla shares" was answered with no hold). A bare object counts too: "sell Tesla", "sell
// shares", "sell MNQ", "sell out of my position" (review of PR #356, round 2). These name no sale and are not held:
// "sell me on this idea", "sell-through", "sales", "sell the idea to Ann", and "can you sell things for me?", which asks
// about CHE's ability and not for an order.
const SALE_VERB = String.raw`sell(?:s|ing)?\b(?=\s+[\w$'’])(?!\s*-)(?!\s+things?\b)(?!\s+me\s+on\b)(?!\s+(?:(?:the|this|that|a|an|my|your|our|these|those|some|any|all)\s+)?(?:ideas?|concepts?|arguments?|pitch(?:es)?|points?|team|people|signals?)\b)`;
const SALE_RE = new RegExp(`\\b${SALE_VERB}`, 'i');
const MONEY_ORDER = String.raw`order(?:s|ed|ing)?\s+(?:me\s+|us\s+)?(?:a|an|another|more|some|\d|\$|[a-z]+)`;
const MONEY_TRANSFER = String.raw`(?:transfer(?:s|red|ring)?|wire(?:s|d|ing)?)\s+(?:\$|\d|money|funds|dollars?|to\s)`;
const MONEY_RE = new RegExp(`${LEAD}(?:${MONEY_VERB}\\b|${SALE_VERB}|${MONEY_ORDER}|${MONEY_TRANSFER})`, 'i');
// Strong delete verbs always count. "Order" followed by a bare word is held only
// when it is not "order of/in/by" (checked below), so "order pizza" is held.
// Weak verbs (reset, clear, cancel, drop) count only with a data object, so
// "reset my thoughts" and "clear the screen" are ordinary chat.
const DATA_OBJECT = String.raw`(?:notes?|files?|data|history|memor(?:y|ies)|skills?|keys?|accounts?|saved|learned|everything|all|settings|lists?|chats?|messages?|changes?|subscriptions?|orders?|bookings?|meetings?|appointments?|apps?|jobs?|queue|cache|logs?|records?|photos?|videos?|contacts?|emails?|drafts?|events?|reminders?)`;
const STRONG_DELETE = String.raw`(?:delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|forget(?:s|ting)?|discard(?:s|ed|ing)?|trash(?:es|ed|ing)?|uninstall(?:s|ed|ing)?|unpublish(?:es|ed|ing)?|revok(?:e|es|ed|ing)|get\s+rid\s+of|throw\s+away)`;
const WEAK_DELETE = String.raw`(?:reset(?:s|ting)?|clear(?:s|ed|ing)?(?:\s+out)?|cancel(?:s|ed|ling|ing)?|drop(?:s|ped|ping)?)(?:\s+[\w'$]+){0,4}?\s+${DATA_OBJECT}`;
// The owner's own learning progress ("reset my progress", "clear my trading quiz scores", Knowledge Atlas
// #346). Only "my … progress/scores", never a progress bar, spinner, report or call, or a game's score.
const LEARNING_RESET = String.raw`(?:reset(?:s|ting)?|clear(?:s|ed|ing)?(?:\s+out)?|drop(?:s|ped|ping)?)\s+(?:all\s+(?:of\s+)?)?my\s+(?:(?:coding|trading|learning|study|studying|atlas|knowledge\s+atlas|lesson|quiz|practice)\s+){0,3}(?:progress|scores?)(?!\s+(?:bars?|indicators?|spinners?|reports?|calls?|meetings?|reviews?|widgets?|boards?|screens?|notes?|charts?))`;
const DELETE_RE = new RegExp(`${LEAD}(?:${STRONG_DELETE}|${WEAK_DELETE}|${LEARNING_RESET})\\b`, 'i');
const NEGATED_RE = /\b(?:do\s+not|don't|dont|never|not|no)\s+$/i;
// Signing up makes an account and agrees to its terms, in an app or a service. It is held for the owner's yes like a
// purchase (comprehension audit, issue #350: "Investigate the Notion app and sign me up" was not held). REA reads a
// listing and never signs up, so an investigation that names the app still only reads it.
// A new account is held wherever it is ("create an account on Etsy", "set up an account on Etsy"), and so is a registration
// for anything ("register me for the course"). The gate cannot tell a free registration from a paid one, and a sign-up gives
// personal data, so the owner decides (review of PR #356, round 2). "Set up my account on the phone" names an account the
// owner already has, so it is not held.
const SIGNUP_RE = new RegExp(`${LEAD}(?:sign\\s+(?:me|us|myself|ourselves)\\s+up\\b|(?:create|make)\\s+(?:me\\s+|us\\s+|my\\s+|our\\s+)?(?:an?\\s+|a\\s+new\\s+)?(?:new\\s+)?(?:[a-z][\\w.-]*\\s+)?account\\b|set\\s+up\\s+(?:me\\s+|us\\s+)?(?:an?\\s+|a\\s+new\\s+|new\\s+)(?:[a-z][\\w.-]*\\s+)?account\\b|register\\s+(?:me|us|myself|ourselves)\\s+(?:for|on|with)\\s+[\\w$'’-])`, 'i');

// Each clause of a compound request ("buy X, then delete Y") is checked on its
// own, so a verb that opens any clause counts.
const CLAUSE_BREAK = /[.;!?]|\b(?:then|and then|and|also|after that|afterwards)\b|,/g;
function clausesOf(t) {
  const clauses = [];
  let start = 0;
  for (const m of t.matchAll(CLAUSE_BREAK)) { clauses.push([start, m.index]); start = m.index + m[0].length; }
  clauses.push([start, t.length]);
  return clauses;
}
// A question about what CHE is able to do asks her to do nothing (comprehension audit): "Can you buy things
// for me?" names no purchase, and "Could you pay my bills if I asked?" waits for an ask that has not come.
// "Can you buy me a coffee?" and "Could you pay my electric bill?" name one, so they are still held.
const ABILITY_ASK_RE = new RegExp(String.raw`^${VOCATIVE}(?:can|could|would|will)\s+you\s+(?:ever\s+|actually\s+|really\s+|even\s+)?(?:${MONEY_VERB}|${STRONG_DELETE}|order)\s+(?:things|stuff|anything|something|items|products)(?:\s+(?:for\s+(?:me|us)|online|on\s+my\s+behalf|by\s+yourself|yourself))*$`, 'i');
const IF_I_ASKED_RE = new RegExp(String.raw`^${VOCATIVE}(?:can|could|would|will)\s+you\b[^?]*\bif\s+i\s+(?:asked|told|wanted|said)(?:\s+(?:you|you\s+to|to|so))?$`, 'i');
function abilityQuestion(clause) {
  const c = clause.replace(/[\s?.!]+$/, '');
  return ABILITY_ASK_RE.test(c) || IF_I_ASKED_RE.test(c);
}
function hasVerb(re, t) {
  return clausesOf(t).some(([from, to]) => {
    const c = t.slice(from, to).trim();
    const m = re.exec(c);
    return Boolean(m) && !NEGATED_RE.test(c.slice(0, m.index)) && !abilityQuestion(c);
  });
}

// "Don't place any orders", "do not start a new investigation", "without uploading anything": the
// owner forbids CHE an action. Only an action CHE could take counts: "don't worry about the cost",
// "I don't care", "don't be greedy", "don't forget to buy" and "never mind" forbid nothing (review of
// #351: "No need to ask, pay the electric bill" must still be held).
const CHE_VERB = String.raw`(?:buy|purchase|pay|order|spend|check\s*out|subscribe|donate|charge|transfer|wire|withdraw|sell|short|place|submit|enter|trade|execute|start|begin|run|launch|queue|render|make|create|generate|produce|upload|post|publish|share|send|e-?mail|text|message|call|reply|forward|add|put|delete|remove|erase|wipe|clear|cancel|change|modify|edit|touch|alter|update|write|commit|push|merge|deploy|open|navigate|go|drive|book|schedule|set|remind|guess|invent|assume|use|save|store|record|install|download|switch|turn|connect|disconnect|link|investigate|analy[sz]e|inspect|look|search|read|play|retry|rerun|restart|tell|show|ask|contact|notify|ping|approve|confirm|sign|accept|apply|move|copy|rename|close|reset|fill|log|lock|unlock)`;
const CHE_GERUND = String.raw`(?:buying|purchasing|paying|ordering|spending|subscribing|transferring|withdrawing|selling|shorting|placing|submitting|entering|trading|executing|starting|running|launching|queu(?:e)?ing|rendering|making|creating|generating|producing|uploading|posting|publishing|sharing|sending|e-?mailing|texting|messaging|calling|replying|forwarding|adding|putting|deleting|removing|erasing|wiping|clearing|cancel(?:l)?ing|changing|modifying|editing|touching|altering|updating|writing|committing|pushing|merging|deploying|opening|navigating|going|driving|booking|scheduling|setting|guessing|inventing|assuming|using|saving|storing|recording|installing|downloading|switching|turning|connecting|investigating|analy[sz]ing|inspecting|looking|searching|reading|playing|telling|showing|asking|contacting|notifying|approving|confirming|signing|accepting|applying|moving|copying|renaming|closing|resetting)`;
const PROHIBITION_START = new RegExp(String.raw`\b(?:(?:do\s+not|don['’]?t|never|no\s+need\s+to)\s+(?:(?:actually|ever|even|just|go\s+and|try\s+to)\s+)*(?=${CHE_VERB}\b)|without\s+(?=${CHE_GERUND}\b))`, 'gi');
// A prohibition runs to the end of its sentence, or until the turn turns back to a request ("but tell
// me", "just explain").
const PROHIBITION_END = /[.;!?\n]|,?\s+(?:but|just|only|instead|rather|then|and\s+then)\b|,?\s+and\s+(?=(?:tell|show|give|explain|read|list|check|analy[sz]e|summari[sz]e|describe|report|what|which|how|why|when|where|whether)\b)/i;
// Unpunctuated speech: "dont purchase anything explain your understanding" turns back at a read verb.
const READ_TURN = /\s+(?=(?:explain|tell\s+me|show\s+me|give\s+me|analy[sz]e|summari[sz]e|describe|list|read\s+me)\b)/i;
// A money, order or delete verb after the forbidden one is a new request, unless it continues the
// forbidden list ("..., or pay for anything", "buy or sell anything"): "Don't pay attention to the price,
// buy the tickets." Ending a prohibition early only ever holds more, never less.
const MONEY_STOP = String.raw`(?:buy|purchase|pay|order|spend|prepare|set\s+up|check\s*out|subscribe|donate|transfer|wire|withdraw|sell|short|place|submit|enter|trade|execute|delete|remove|erase|wipe)`;
const NEW_REQUEST = new RegExp(String.raw`(?:,\s*|\s+)(?:please\s+)?${MONEY_STOP}\b`, 'gi');
const LIST_WORD = /\b(?:or|nor)\s*,?\s*$/i;

// The [start, end) spans of the turn's prohibitions.
export function prohibitionSpans(text) {
  const t = String(text || '');
  const spans = [];
  for (const match of t.matchAll(PROHIBITION_START)) {
    if (spans.length && match.index < spans[spans.length - 1][1]) continue;
    const rest = t.slice(match.index + match[0].length);
    // "Don't place any orders except one MNQ long", "don't sell unless MNQ hits 21500": a ban with an
    // exception asks for the exception, so it is not set aside (review of #351).
    if (/\b(?:except|unless|other\s+than|apart\s+from|aside\s+from|besides|but\s+only|save\s+for)\b/i.test(rest.split(/[.;!?\n]/)[0])) continue;
    const first = /^\S+/.exec(rest)?.[0].length || 0;
    const sentence = PROHIBITION_END.exec(rest);
    const read = READ_TURN.exec(rest.slice(first));
    let stop = Math.min(sentence ? sentence.index : rest.length, read ? read.index + first : rest.length);
    for (const next of rest.slice(first, stop).matchAll(NEW_REQUEST)) {
      const before = rest.slice(0, first + next.index);
      if (LIST_WORD.test(before)) continue;
      stop = first + next.index;
      break;
    }
    spans.push([match.index, match.index + match[0].length + stop]);
  }
  return spans;
}

const PROHIBITION_LEAD = /^\s*(?:do\s+not|don['’]?t|never|no\s+need\s+to|without)\s+(?:(?:actually|ever|even|just|go\s+and|try\s+to)\s+)*/i;
/** What one prohibition forbids, from its first verb on: "place any orders" for "don't place any orders". */
export function forbiddenAction(span) {
  return String(span || '').replace(PROHIBITION_LEAD, '');
}

// The turn with its prohibitions taken out, so an action check reads only what the owner asks for.
// `only` keeps every prohibition whose forbidden verb is not one the caller checks: "Don't ask me,
// prepare an MNQ order" forbids asking, not the order.
export function withoutProhibitions(text, { only = null } = {}) {
  const t = String(text || '');
  let out = '';
  let at = 0;
  for (const [start, end] of prohibitionSpans(t).filter(([a, b]) => !only || only.test(forbiddenAction(t.slice(a, b))))) {
    out += `${t.slice(at, start)} `;
    at = end;
  }
  return (out + t.slice(at)).replace(/[ \t]{2,}/g, ' ').trim();
}

// The prohibitions themselves, joined: what the owner told CHE not to do.
export function prohibitedText(text) {
  const t = String(text || '');
  return prohibitionSpans(t).map(([start, end]) => t.slice(start, end)).join('; ');
}

// "I want to buy three apples tomorrow, but don't purchase anything": the owner's own plan, with the
// purchase forbidden to CHE, asks her to spend nothing. A purchase aimed at CHE ("buy it but don't pay
// more than $5", "I want you to buy it") still needs the owner's yes. A limit on what CHE pays means
// CHE pays, so it never counts as forbidding the purchase.
const OWN_PLAN = String.raw`^${VOCATIVE}(?:(?:so|well|and|but|ok|okay|also)\s+)*(?:i\s+(?:want|need|plan|hope|intend|would\s+like)\s+to|i(?:['’]d|d)\s+like\s+to|i\s+am\s+(?:going|planning)\s+to|i(?:['’]m|m)\s+(?:going|planning)\s+to|i\s+will|i['’]ll|i\s+might)\s+`;
const OWN_PLAN_RE = new RegExp(OWN_PLAN, 'i');
const OWN_MONEY_RE = new RegExp(`${OWN_PLAN}(?:${MONEY_VERB}\\b|${SALE_VERB}|${MONEY_ORDER}|${MONEY_TRANSFER})`, 'i');
const BARE_MONEY_RE = new RegExp(`^(?:${MONEY_VERB}\\b|${SALE_VERB}|${MONEY_ORDER}|${MONEY_TRANSFER})`, 'i');
// A ban on every purchase: "don't purchase anything", "don't order anything yet", "don't order them".
// "Don't buy the extended warranty" or "don't order any drinks" forbids one item, not the purchase.
const BLANKET_BAN = /\b(?:do\s+not|don['’]?t|never)\s+(?:(?:actually|ever|even|just)\s+)*(?:buy|purchase|pay\s+for|order|spend|check\s*out|place\s+(?:an?\s+|any\s+)?orders?)(?:\s+(?:anything(?!\s+else)|any\s+(?:orders?|purchases?)|it|them|this|that|yet|now|today|online))*\s*(?=$|[,.;!?]|\s+(?:or|nor|and|but|add|create|explain|just|tell)\b)/gi;
function onlyOwnPlanMoney(t) {
  const bans = [...t.matchAll(BLANKET_BAN)].map((m) => [m.index, m.index + m[0].length]);
  if (!bans.length) return false;
  // "I want to go to Walmart tomorrow and buy apples": the plan carries through its own "and" clauses,
  // never past a comma or "then" ("I want to buy apples, then pay for my Netflix" asks CHE to pay).
  const parts = [];
  let start = 0;
  for (const m of t.matchAll(/[.;!?,]+|\b(?:and\s+then|then|also|after\s+that|afterwards)\b/g)) { parts.push([start, m.index]); start = m.index + m[0].length; }
  parts.push([start, t.length]);
  let own = false;
  for (const [from, to] of clausesOf(t)) {
    const raw = t.slice(from, to);
    const c = raw.trim();
    const m = MONEY_RE.exec(c);
    if (!m || NEGATED_RE.test(c.slice(0, m.index))) continue;
    const at = from + (raw.length - raw.trimStart().length) + m.index + m[0].length - 1;
    if (bans.some(([a, b]) => at >= a && at < b)) continue;
    const part = parts.find(([a, b]) => at >= a && at < b);
    if (!part || !OWN_PLAN_RE.test(t.slice(part[0], part[1]).trim())) return false;
    // "… and buy apples" carries the plan; "… and can you pay the bill", "and please pay it" or "and pay
    // the bill for me" / "and buy me a TV" asks CHE.
    if (!OWN_MONEY_RE.test(c) && !(BARE_MONEY_RE.test(c) && !/\b(?:for\s+(?:me|us)|me|us)\b/i.test(c))) return false;
    own = true;
  }
  return own;
}

// Every kind of consequential action the text asks for, in a stable order.
// Returns [] when the request is ordinary.
export function classifyOwnerActions(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const kinds = [];
  // Unpunctuated speech has no clause marks, so what is left once the prohibitions are out is read too:
  // "dont pay attention to the price buy the tickets".
  const asked = withoutProhibitions(t);
  if ((hasVerb(MONEY_RE, t) || hasVerb(MONEY_RE, asked)) && !onlyOwnPlanMoney(t)) kinds.push('money');
  if (hasVerb(DELETE_RE, t) || hasVerb(DELETE_RE, asked)) kinds.push('delete');
  if ([SIGNUP_RE, SIGNUP_NAMED_RE].some((re) => hasVerb(re, t) || hasVerb(re, asked))) kinds.push('signup');
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
  if (missing.includes('money')) parts.push(SALE_RE.test(text) ? 'spend, buy or sell anything' : 'spend or buy anything');
  if (missing.includes('delete')) parts.push('delete or remove anything');
  if (missing.includes('signup')) parts.push('sign you up for anything');
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
  'paypal', 'robinhood', 'reddit', 'discord', 'twitch', 'threads', 'gmail', 'slack', 'zoom', 'hulu', 'tubi',
  'github', 'grok', 'music', 'notes', 'mail', 'email', 'maps', 'clock', 'camera',
];
// Sorted longest first so "google maps" matches before "maps" would.
const APPS_RE = [...new Set(KNOWN_APPS)].sort((a, b) => b.length - a.length)
  .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
// An account set up with a named service, including one the owner already has ("set up my Notion account"). Only a
// service in KNOWN_APPS is named: clauses split at every full stop, so a site like "chey-test.com" is not read as one.
// "Set up my account on the phone" names no service and is not held.
const SERVICE_NAME = String.raw`(?:${APPS_RE})\b`;
const SIGNUP_NAMED_RE = new RegExp(`${LEAD}(?:set\\s+up\\s+(?:me\\s+|us\\s+|my\\s+|our\\s+)?(?:an?\\s+|a\\s+new\\s+)?(?:new\\s+)?${SERVICE_NAME}\\s+account\\b|set\\s+up\\s+(?:me\\s+|us\\s+|my\\s+|our\\s+)?(?:an?\\s+|a\\s+new\\s+)?(?:new\\s+)?account\\s+(?:with|on|at)\\s+${SERVICE_NAME})`, 'i');

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

// Naming an app is not using it when the app is what CHE studies or reports on (comprehension audit): REA
// reads an app's public listing and code ("run your REA on the Notion app", "investigate the Spotify app"),
// and channel numbers come from CHE's own YouTube connection ("how many subscribers do I have on YouTube").
// Anything that would open, play or read inside the app still needs the owner's permission.
const STUDIED_APP_RE = /\b(?:rea|reverse[- ]engineer\w*|investigat\w*|analy[sz]\w*|inspect\w*|stud(?:y|ying|ied)|compar\w*)\b/i;
const CHANNEL_STATS_RE = /\b(?:subscribers?|views|uploads?|channel|analytics|watch\s+time)\b/i;
const USES_APP_RE = /\b(?:open|launch|play|go\s+to|watch(?!\s+time)|use|show\s+me|read|post|upload|comment|like)\b/i;
function studiesApp(clause, app, named) {
  if (named ? STUDIED_APP_RE.test(clause) : /\b(?:rea|reverse[- ]engineer\w*)\b/i.test(clause)) return true;
  return app === 'youtube' && CHANNEL_STATS_RE.test(clause) && !USES_APP_RE.test(clause);
}

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
    if (implicit && !openApp && studiesApp(clause, implicit, Boolean(named))) continue;
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
  const multi = kinds.includes('signup') ? 'spent, bought, deleted or signed up' : 'spent, bought or deleted';
  const done = kinds.length > 1 ? multi : kinds[0] === 'money' ? 'spent or bought' : kinds[0] === 'signup' ? 'signed up' : 'deleted';
  const need = kinds.length > 1 ? 'Those need' : kinds[0] === 'money' ? 'Spending money needs' : kinds[0] === 'signup' ? 'Signing up needs' : 'Deleting needs';
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
  for (const k of kinds) if (k === 'money' || k === 'delete' || k === 'signup') grant[k] = true;
  return grant;
}
