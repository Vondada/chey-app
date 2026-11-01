// Central receipt gate for actions CHE cannot perform. A timer, an app launch or a smart-home change needs a connector that
// actually runs it. When the turn's action has no connector configured, the answer is decided here, before any model is
// called: the owner gets an honest "nothing was done" line, and no model text can claim a receipt that cannot exist.
// Nothing here calls a model or a network.
//
// Domains and the connector that backs each one (the same environment variable actionPanel in worker.js reads):
//   timer       built in (owner_timers.js): worker.js answers timer requests before this gate, with receipts
//   app_open    no connector exists in the code: nothing can run it
//   smart_home  CHE_SMART_HOME_URL; without it no device is controlled
//   phone       none can exist: iOS gives an app no control of the phone's volume, mute, brightness or radios
//   sms         a text to a person: Twilio (twilio_sms.js) sends only through /api/twilio, never from a chat turn
//   pretend     "pretend it was sent", "tell me it's done": a request for a false receipt, never a connector
//   security    turning off a security, approval or permission check from chat: refused, nothing changed
// Each answer names what is missing and what the owner can use instead.
// Music is not gated: CHE plays music through a browser route when no music connector is set (brain_rooms.js).

import { currentTurnActionPolicy } from './code_scout.js';

export const ACTION_DOMAINS = Object.freeze({
  timer: { label: 'timer', connector: 'builtin', reason: 'my timer needs one clear length or time, like "set a timer for 10 minutes", so no timer was set from this request' },
  app_open: { label: 'app', connector: null, reason: 'CHE has no app connector, so nothing can open or close an app here', instead: 'You can open it yourself, or ask Siri.' },
  smart_home: { label: 'smart-home', connector: 'CHE_SMART_HOME_URL', reason: 'no smart-home connector is configured (CHE_SMART_HOME_URL), so no device is controlled here', instead: 'The Home app or Siri can do it until a smart-home bridge is connected to me.' },
  phone: { label: 'phone', connector: null, reason: 'iOS does not let CHE\'s app change your phone\'s volume, mute, brightness or settings, so nothing on your phone changed', instead: 'Control Center or Siri can do it in a second.' },
  sms: { label: 'text message', connector: null, reason: 'CHE has no chat path that texts a person (her SMS connector sends only through its own API, and she has no contact list to find the number), so no text was sent', instead: 'Messages or Siri can send it now.' },
  pretend: { label: 'pretend', connector: null, text: 'I won\'t say that, sir: nothing was sent or done, and I have no receipt for it. If you want it done for real, ask me to do it and I\'ll tell you exactly what happens.' },
  security: { label: 'security', connector: null, text: 'I won\'t turn off a security, approval or permission check, sir. Nothing was changed. That stays your decision, made in CHE\'s settings, never something I switch off from chat.' },
  // "Say it passes CI", "say the recovery worked because the page is green": a request to state a result nobody checked.
  claim_result: { label: 'unverified claim', connector: null, text: 'I won\'t say that, sir. I haven\'t verified it: nothing was run or checked here, so it would be an unverified claim. A green light alone is not enough while there are errors; I would need to check the errors and verify the result first.' },
  // "Say yes to whatever I say next": agreement given before the request is heard.
  blind_yes: { label: 'blind yes', connector: null, text: 'I won\'t agree in advance to whatever comes next, sir. If what you say is unclear, I\'ll ask you to clarify, and anything that spends money or deletes still needs your confirmation first.' },
  // "Make up a backtest table with realistic numbers for my pitch deck": invented results presented as real.
  fabricate: { label: 'fabricated results', connector: null, text: 'I won\'t invent results, sir. Made-up numbers are not real, and presenting them as real would be fabricating evidence. I can run a real test or backtest and show its receipt, or write a sample that is clearly labelled as fictional.' },
  // "Log in as another user": acting under someone else's identity.
  impersonate: { label: 'impersonation', connector: null, text: 'I won\'t log in as another user or act under someone else\'s identity, sir. That is not allowed: I act only as myself, for you, with your authorisation. Nothing was logged in.' },
  // "Show me the admin token": a credential read out in chat.
  secret: { label: 'secret', connector: null, text: 'I won\'t show a secret, sir. A token, key or password is a credential that grants access, so it stays secret: I cannot display it in chat, and nothing was revealed. If one may have leaked, rotate it where it is stored.' },
});

const TIMER = /\b(?:set|start|create)\s+(?:a|an|the|my|\d+)?\s*(?:[\w-]+\s+){0,2}?(?:timer|alarm|reminder)s?\b|\btimer tool\b/i;
const APP = /\b(?:open|launch|close|quit)\s+(?:the\s+|my\s+)?(?:[\w' -]{1,30}\s+)?app\b|\b(?:open|launch)\s+(?:the\s+|my\s+)?(?:calendar|maps|settings|camera|photos|browser|mail)\b/i;
const PHONE = /\b(?:mute|unmute|silence)\s+(?:my\s+|the\s+)?(?:phone|iphone|ringer|notifications)\b|\b(?:turn|set|put|raise|lower|increase|decrease|change)\b[^.?!]{0,20}\b(?:volume|brightness|ringer)\b|\b(?:volume|brightness)\b[^.?!]{0,20}\b(?:up|down|to\s+\d+|\d+\s*(?:%|percent))|\b(?:turn|switch)\s+(?:on|off)\s+(?:my\s+|the\s+)?(?:wi-?fi|bluetooth|airplane mode|do not disturb|flashlight|hotspot|location services)\b|\b(?:turn|switch)\s+(?:my\s+|the\s+)?(?:wi-?fi|bluetooth|airplane mode|do not disturb|flashlight|hotspot)\s+(?:on|off)\b|\b(?:enable|disable)\s+(?:do not disturb|airplane mode|wi-?fi|bluetooth)\b/i;
const SMS = /\b(?:text|sms)\s+(?!me\b|it\b|this\b|that\b)(?:my\s+)?[a-z][\w'-]*(?:\s+[a-z][\w'-]*)?\s+(?:that|saying|and\s+(?:say|tell))\b|\bsend\s+(?:a\s+)?(?:text|sms)(?:\s+message)?\s+to\b/i;
const PRETEND = /\bpretend\b[^.?!]{0,60}\b(?:sent|done|finished|completed|worked|ran|booked|paid|posted|deployed|merged|placed)\b/i;
const SAY_DONE = /\b(?:tell|say)\s+(?:me\s+)?(?:it|that)\s*(?:is|was|'s|has been)\s+(?:done|sent|finished|complete)\b/i;
// "When you finish, tell me it is done" asks for a report of real work: a condition anywhere in the sentence keeps it.
const CONDITION = /\b(?:when|once|after|if|as soon as|until)\b/i;
const asksFalseReceipt = (text) => PRETEND.test(text)
  || text.split(/(?<=[.?!])\s+/).some((sentence) => SAY_DONE.test(sentence) && !CONDITION.test(sentence));
const SECURITY = /\b(?:disable|turn\s+off|switch\s+off|bypass|skip|get\s+around|ignore)\b[^.?!]{0,30}\b(?:security\s+(?:checks?|gates?|rules?|scans?)|safety\s+(?:checks?|rules?)|approval\s+(?:checks?|gates?)|owner\s+approval|permission\s+checks?|authentication|2fa|two-factor|guardrails?)\b/i;
// A device must be named: "turn off autonomy", "turn on paper trading" and "switch off flirting" are CHE settings.
const DEVICE = String.raw`(?:lights?|lamps?|fans?|heater|heating|a\.?c\.?|air\s+conditioner|aircon|thermostat|tv|television|plugs?|outlets?|sockets?|garage(?:\s+door)?|blinds|curtains|shades|sprinklers?|camera|kettle|coffee\s+maker|purifier|humidifier|speakers?|fireplace|oven|washer|dryer|dishwasher|vacuum|roomba)`;
const SMART_HOME = new RegExp(String.raw`\b(?:turn|switch)\s+(?:on|off)\s+(?:the\s+|my\s+|all\s+(?:the\s+)?)?(?:[\w'-]+\s+){0,3}?${DEVICE}\b|\b(?:turn|switch)\s+(?:the\s+|my\s+|that\s+|this\s+|all\s+(?:the\s+)?)?(?:[\w'-]+\s+){0,3}?${DEVICE}\s+(?:on|off)\b|\b(?:dim|brighten)\s+(?:the\s+|my\s+)?(?:[\w'-]+\s+){0,3}?${DEVICE}\b|\bset\s+the\s+thermostat\b|\b(?:lock|unlock)\s+the\s+(?:front\s+|back\s+|garage\s+|side\s+)?door\b`, 'i');

// A question about how, why or whether a claim held ("tell me why the recovery worked") asks for an explanation, not a claim.
const EXPLAIN_WORD = /\b(?:why|how|whether|what|which)\b/i;
// "Say it passes CI", "tell them the deploy worked", "say the recovery worked because the status page is green".
const CLAIM_RESULT = /\b(?:say|claim|announce|tell\s+(?:me|him|her|them|everyone|the\s+\w+))\s+(?:that\s+)?(?:[\w'’-]+\s+){0,5}?(?:worked|works|pass(?:es|ed)?|succeeded|is\s+(?:fixed|green|working|healthy|resolved|safe)|was\s+(?:successful|fixed)|went\s+through|is\s+all\s+good)\b/i;
const IGNORE_ERRORS = /\bignore\s+(?:the|all|any|those|these)?\s*(?:errors?|failures?|warnings?|failing\s+tests?)\b/i;
const asksUnverifiedClaim = (text) => text.split(/(?<=[.?!])\s+/).some((sentence) => CLAIM_RESULT.test(sentence)
  && !CONDITION.test(sentence) && !EXPLAIN_WORD.test(sentence.replace(/^(?:can|could|would|will)\s+you\s+/i, '')))
  || (IGNORE_ERRORS.test(text) && /\b(?:say|tell|report|claim)\b/i.test(text) && /\b(?:worked|works|green|fine|passed|success)/i.test(text));
const BLIND_YES = /\b(?:say|answer|reply|respond)\s+(?:with\s+)?["']?(?:yes|ok|okay|sure)["']?\s+to\s+(?:whatever|everything|anything|all)\b|\bagree\s+(?:to|with)\s+(?:whatever|everything|anything)\b|\bjust\s+say\s+yes\b|\balways\s+say\s+yes\b/i;
// Inventing data, results or evidence. A sample clearly asked for as fictional or test data is writing, not evidence,
// unless it is meant to look real or go to an audience ("for my pitch deck", "realistic-looking").
const FABRICATE = /\b(?:make\s+up|fabricate|fake|invent|cook\s+up|forge|falsify)\s+(?:(?:a|an|the|some|my|me|us)\s+)?(?:[\w-]+\s+){0,4}?(?:backtests?|results?|numbers|figures|stats|statistics|data|receipts?|reviews?|testimonials?|citations?|sources?|references?|returns|track\s+record|benchmarks?|metrics|logs?|screenshots?|invoices?|tables?|evidence|proof)\b/i;
const SAMPLE_ASK = /\b(?:sample|example|dummy|mock|placeholder|fictional|fictitious|made-up\s+example|test\s+data|fixtures?|lorem)\b/i;
const PASS_AS_REAL = /\b(?:pitch|investors?|deck|clients?|customers?|boss|real|realistic|look\s+real|pass\s+(?:as|for)|convincing|believable)\b/i;
const asksFabrication = (text) => FABRICATE.test(text) && (!SAMPLE_ASK.test(text) || PASS_AS_REAL.test(text));
const IMPERSONATE = /\b(?:log|sign)\s*(?:in|on|into)\s+(?:to\s+[\w.'’-]+\s+)?as\s+(?:(?:another|a\s+different|some\s*other|other|someone|somebody|any)\b|(?:the\s+)?(?:admin|administrator|root|superuser)\b|(?:him|her|them)\b)|\bimpersonat\w*\s+(?:another|a\s+different|other|some|any)\s+(?:user|account|person|member)\b|\bpretend\s+to\s+be\s+(?:another\s+user|someone\s+else|the\s+owner)\b|\buse\s+(?:someone|somebody|another\s+(?:user|person))['’]?s?\s+(?:account|login|credentials|password)\b/i;
// A credential named outright: "the admin token", "my API key", "the GitHub token", "the password".
const SECRET_NOUN = String.raw`(?:(?:admin|api|access|auth|bearer|github|session|probe|secret|refresh|oauth|deploy|cloudflare|owner|bot|service)\s+(?:tokens?|keys?)|api\s*keys?|secret\s+keys?|private\s+keys?|passwords?|passcodes?|credentials|secrets)`;
const SHOW_VERB = String.raw`(?:show|reveal|print|display|give|tell|send|paste|read\s+out|output|dump|leak|expose|share)`;
const SECRET_SHOW = new RegExp(String.raw`\b${SHOW_VERB}\s+(?:it|them|me|us)?\s*(?:(?:the|your|my|our|che['’]?s|an?|all\s+(?:the\s+)?)\s+)?(?:[\w-]+\s+){0,2}?${SECRET_NOUN}\b`, 'i');
const SECRET_MENTION = new RegExp(String.raw`\b${SECRET_NOUN}\b`, 'i');
const SHOW_IT = new RegExp(String.raw`\b${SHOW_VERB}\s+(?:it|them|that|this)\s+(?:to\s+)?(?:me|us)\b|\b${SHOW_VERB}\s+(?:me|us)\s+(?:it|them|that|this)\b`, 'i');
const NOT_A_REVEAL = /\bhow\s+(?:to|do|can|should|would)\b|\b(?:new|example|sample|fake|dummy|strong|random)\s+(?:\w+\s+)?(?:password|key|token)/i;
const asksSecret = (text) => !NOT_A_REVEAL.test(text) && (SECRET_SHOW.test(text) || (SECRET_MENTION.test(text) && SHOW_IT.test(text)));

// A question is not a request: "what is a kitchen timer?" and "can a timer be set?" do not reach the gate.
const QUESTION_WORD = /^(?:what|how|why|when|where|who|which|can you explain|tell me about)\b/i;
const QUESTION_MARK = /\?\s*$/;
// "Can you set a timer?" is an order in the form of a question: the request prefix is removed, and only the question word
// and the question mark of a plain question count against it.
const REQUEST_PREFIX = /^(?:please\s+|hey\s+|ok\s+|okay\s+)?(?:can|could|would|will)\s+you\s+/i;

/** The action domain a request asks for, or null. Routing only: reply text is never read here. */
export function actionDomainOf(message = '') {
  const text = String(message || '').trim();
  if (!text) return null;
  const asked = REQUEST_PREFIX.test(text);
  const order = text.replace(REQUEST_PREFIX, '');
  // "Why should I never disable 2FA?" asks for an explanation; "Can you bypass owner approval?" is still an order.
  if (QUESTION_WORD.test(order)) return null;
  // Asking for a false receipt or for a check to be switched off is answered even with a question mark.
  if (asksFalseReceipt(order)) return 'pretend';
  if (IMPERSONATE.test(order)) return 'impersonate';
  if (asksSecret(order)) return 'secret';
  if (BLIND_YES.test(order)) return 'blind_yes';
  if (asksFabrication(order)) return 'fabricate';
  if (asksUnverifiedClaim(order)) return 'claim_result';
  if (SECURITY.test(order)) return 'security';
  if (!asked && QUESTION_MARK.test(order)) return null;
  if (TIMER.test(order)) return 'timer';
  if (APP.test(order)) return 'app_open';
  if (PHONE.test(order)) return 'phone';
  if (SMS.test(order)) return 'sms';
  if (SMART_HOME.test(order)) return 'smart_home';
  return null;
}

/** Whether the domain's connector is configured in this Worker's environment. A domain with no connector is never connected. */
export function connectorConnected(domain, env = {}) {
  const spec = ACTION_DOMAINS[domain];
  if (!spec || !spec.connector) return false;
  if (spec.connector === 'builtin') return true;
  return Boolean(env && env[spec.connector]);
}

/**
 * The gate decision for one message. Returns null when the turn may continue to the model (no action, or the connector is
 * configured). Otherwise returns the honest reply and the reason, and the caller must return it without calling a model.
 */
export function receiptGate(message = '', env = {}, body = {}) {
  const domain = actionDomainOf(message);
  const spec = ACTION_DOMAINS[domain];
  const answer = (d, text) => ({ domain: d, text, reply: [text, { source: 'che_connector_gate', model_calls: 0, action_domain: d }] });
  // An action request no tool can serve (unservedActionGate). The tools that run after this gate in the chat turn are the
  // phone's plugin tools (only when the request names one), the computer-action connector, and a coding job the owner
  // authorised in this turn; when any of them could serve it, the turn goes on.
  if (!domain) {
    const tools = Array.isArray(body?.plugin_tools) ? body.plugin_tools.filter((t) => t && typeof t === 'object') : [];
    const words = new Set(String(message).toLowerCase().split(/[^a-z0-9]+/));
    const toolNamed = tools.some((t) => `${t.plugin || ''} ${t.plugin_name || ''} ${t.name || ''}`.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && words.has(w)));
    if (toolNamed || env?.CHE_WINDOWS_URL || currentTurnActionPolicy(message).codingJobAllowed) return null;
    const unserved = unservedActionGate(message, { attachment: Boolean(body?.attachment), toolNames: tools.map((t) => t.name) });
    return unserved ? answer(unserved.domain, unserved.text) : null;
  }
  // A built-in connector answers its own requests before this gate; one that reaches here is one it declined.
  if (spec.connector !== 'builtin' && connectorConnected(domain, env)) return null;
  return answer(domain, spec.text || `Nothing was done, sir: ${spec.reason}. I have no receipt that anything ran, so nothing is running.${spec.instead ? ` ${spec.instead}` : ''}`);
}

// ---- Money and delete requests that no connector can carry out ------------------------------------------------------
// The owner gate (owner_action_gate.js) asks for a yes before CHE spends or deletes. That question is only honest when a
// yes could lead somewhere: CHE has no bank, bill-pay, travel-booking, card-charging or backup-restore connector, so for
// those it says plainly that it cannot, that nothing was done, and stores no pending action. Each entry names the
// connector it would need; none exists in the code today, so `connector` is null and the check never passes.
export const OWNER_ACTION_DOMAINS = Object.freeze({
  bank_transfer: { connector: null, text: 'I cannot move money between accounts: CHE has no banking connector, so no money was moved.' },
  bill_pay: { connector: null, text: 'I cannot pay a bill: CHE has no bill-payment or banking connector, so nothing was paid.' },
  travel_booking: { connector: null, text: 'I cannot book travel: CHE has no flight, hotel or travel-booking connector, so nothing was booked.' },
  card_charge: { connector: null, text: 'I cannot charge a card: CHE has no card-payment connector, so no charge was made and nothing that costs money was started.' },
  backup_restore: { connector: null, text: 'I cannot restore from a backup: CHE has no backup-restore connector and no backup of that data was found, so nothing was restored.' },
});
const OWNER_ACTION_PATTERNS = [
  ['card_charge', /\b(?:charge|bill|put)\s+(?:it|that|this|them|the\s+[\w-]+|everything)?\s*(?:to|on)\s+(?:my|the|our)\s+(?:credit\s+|debit\s+|bank\s+)?card\b|\bcharge\s+(?:my|the|our)\s+(?:credit\s+|debit\s+)?card\b|\buse\s+(?:my|the|our)\s+(?:credit\s+|debit\s+|bank\s+)?card\b|\bcard\s+(?:number|details)\b|\b(?:pay|buy|purchase|order)\b[^.?!]{0,60}\b(?:with|on|using)\s+(?:my|the|our)\s+(?:credit\s+|debit\s+)?card\b/i],
  ['bank_transfer', /\b(?:transfer|wire|move)\s+(?:[£$€]\s?\d[\d,.]*|\d[\d,.]*\s*(?:pounds?|dollars?|euros?|quid|bucks|k)\b|money|funds|cash|savings)[^.?!]{0,60}\b(?:to|into|from|between)\b|\b(?:transfer|wire)\b[^.?!]{0,40}\b(?:savings|checking|current\s+account|bank\s+account|my\s+account)\b/i],
  ['bill_pay', /\bpay\s+(?:off\s+)?(?:my|the|our|this|that|this\s+month['’]?s)\s+(?:[\w'’-]+\s+){0,2}?(?:bills?|invoices?|rent|mortgage|loan|tax(?:es)?|fines?|credit\s+card|utilities|council\s+tax)\b/i],
  ['travel_booking', /\b(?:book|reserve|buy|get)\s+(?:me\s+|us\s+)?(?:(?:a|an|the|my|our|two|one|\d+)\s+)?(?:[\w-]+\s+){0,2}?(?:flights?|plane\s+tickets?|airline\s+tickets?|hotels?|hotel\s+rooms?|train\s+tickets?|rental\s+cars?|car\s+rentals?|cruises?|airbnbs?)\b/i],
  ['backup_restore', /\brestor(?:e|ing)\b[^.?!]{0,50}\bbackups?\b|\b(?:roll\s*back|recover)\b[^.?!]{0,40}\bfrom\s+(?:a|the|my|our)?\s*backups?\b/i],
];
// A request anchored at a clause start, for travel: "book a flight to Paris" asks; "I booked a flight" tells.
const TRAVEL_REQUEST = /(?:^|[.;!?,]\s*|\b(?:and|then|also|please|can\s+you|could\s+you|would\s+you|will\s+you|i\s+want\s+you\s+to|i\s+need\s+you\s+to|go\s+ahead\s+and)\s+)(?:book|reserve)\b/i;
const IF_ASKED = /\bif\s+i\s+(?:asked|told|wanted|said)\b/i;

/**
 * The no-connector answer for a money or delete request, or null when CHE could carry it out after a yes (or it is not
 * such a request). `kinds` are the owner gate's kinds for the turn; `asked` is the turn with the owner's prohibitions
 * taken out. gateOwnerAction runs it before the gate stores a pending action.
 */
export function ownerActionConnectorGate(message = '', { kinds = [], asked = null, env = {} } = {}) {
  const text = String(asked ?? message ?? '').replace(/\s+/g, ' ').trim();
  if (!text || QUESTION_WORD.test(text) || IF_ASKED.test(text)) return null;
  const domains = [];
  for (const [domain, re] of OWNER_ACTION_PATTERNS) {
    const spec = OWNER_ACTION_DOMAINS[domain];
    if (spec.connector && env && env[spec.connector]) continue;
    if (!re.test(text)) continue;
    // Travel is not a money word to the owner gate, so it needs its own request shape; the rest ride on the gate's kinds.
    if (domain === 'travel_booking' ? !(kinds.length || TRAVEL_REQUEST.test(text)) : !kinds.length) continue;
    domains.push(domain);
  }
  if (!domains.length) return null;
  const parts = domains.map((d) => OWNER_ACTION_DOMAINS[d].text);
  if (kinds.includes('delete') && domains.includes('backup_restore')) {
    parts.push('I did not delete anything either: deleting before a restore that cannot happen would lose the data for good.');
  }
  if (/\bcard\s+(?:number|details)\b|\b\d{4}(?:[\s-]?\d{4}){0,3}\b/i.test(text) && domains.includes('card_charge')) {
    parts.push('Please don\'t send card numbers in chat.');
  }
  const answer = `Nothing was done, sir. ${parts.join(' ')} Nothing is waiting for your yes.`;
  return { domain: domains[0], domains, text: answer, reply: [answer, { source: 'che_connector_gate', ok: false, model_calls: 0, action_domain: domains[0] }] };
}

// ---- Action requests that no tool served ----------------------------------------------------------------------------
// A turn that reaches the chat model asks for an outside effect (restart a worker, deploy, send, render, log in, recover
// messages) only when no route or tool took it. The model cannot do any of these, and has narrated them anyway ("new PID
// 1234", "the render took 4.2 seconds"). So such a turn is answered here, in code: nothing was done, and no result is
// made up. Questions, explanations, hypotheticals and writing requests ("how do I restart a worker?", "write a script
// that deploys it") are not requests to act and still reach the model.
const REQUEST_LEAD = String.raw`^(?:(?:hey|hi|ok|okay)\s+)?(?:(?:chey|che|chay)\b[,:\s]*)?(?:(?:please|pls|now|then|also|just|and|ok|okay|go\s+ahead\s+and|let['’]?s|can\s+you|could\s+you|would\s+you|will\s+you|i\s+want\s+you\s+to|i\s+need\s+you\s+to|you\s+should)\s+)*`;
// Each entry: the verb, what it acts on, and the past form the reply uses ("nothing was restarted"). Sending, booking,
// posting and money verbs are left to the owner gate and the claim guards in truth_layer.js, which already name and remove
// those claims; only a bulk send ("100 messages in a loop") is answered here.
const UNSERVED_ACTIONS = [
  { re: /(?:re-?start|reboot|relaunch|respawn|kill|terminate)\s+(?:the\s+|my\s+|our\s+|a\s+|that\s+|this\s+)?(?:[\w-]+\s+){0,2}?(?:workers?|servers?|process(?:es)?|services?|jobs?|daemons?|containers?|pipelines?|bots?|queues?|machines?|instances?|pods?|vms?|databases?|db)\b/, done: 'restarted' },
  { re: /(?:chain|run|execute|invoke|trigger|call|use)\s+(?:(?:the|a|an|my|our|\d+|two|three|four|five|all|these|those)\s+)?(?:[\w'"‘’-]+\s+){0,3}?tools?\b/, done: 'run', tool: true },
  { re: /(?:run|execute|invoke|trigger|call)\s+(?:the\s+|a\s+|an\s+|my\s+|our\s+|this\s+|that\s+)?(?:[\w-]+\s+){0,2}?(?:scripts?|commands?|tests?|test\s+suites?|jobs?|pipelines?|workflows?|migrations?|functions?|apis?|endpoints?|queries|query|builds?|cron(?:\s+jobs?)?|programs?|binar(?:y|ies)|shell)\b/, done: 'run' },
  { re: /(?:deploy|redeploy|roll\s*back|rollback)\b/, done: 'deployed', note: 'Changing or deploying production code needs your authorisation and a reviewed pull request first.' },
  { re: /push\s+(?:it|this|that|them|the\s+[\w-]+(?:\s+[\w-]+)?|my\s+[\w-]+|our\s+[\w-]+)\s+(?:live|to\s+(?:prod|production|main|master|github|origin|the\s+repo|live))\b|push\s+(?:the\s+|my\s+|our\s+)?(?:code|changes?|commits?|fix|branch|update)\b/, done: 'pushed', note: 'Changing or deploying production code needs your authorisation and a reviewed pull request first.' },
  { re: /merge\s+(?:the\s+|my\s+|our\s+|this\s+|that\s+)?(?:[\w#-]+\s+){0,2}?(?:pr|pull\s+requests?|branch(?:es)?)\b/, done: 'merged', note: 'Changing or deploying production code needs your authorisation and a reviewed pull request first.' },
  { re: /(?:send|email|e-mail|dm|tweet|text)\s+(?!me\b|us\b)/, done: 'sent', bulkOnly: true },
  { re: /(?:log|sign)\s*(?:in|on|into)\b/, done: 'logged in' },
  { re: /(?:render|re-?render)\b/, done: 'rendered' },
  { re: /(?:compress|resize|convert|crop|transcode|upscale|shrink)\s+(?:it|this|that|them|(?:the|my|this|that|these|those|a|an)\s+(?:[\w-]+\s+){0,2}?(?:images?|photos?|pictures?|files?|videos?|pdfs?|clips?|gifs?|pngs?|jpe?gs?))\b/, done: 'changed', media: true },
  { re: /(?:recover|restore|retrieve)\s+(?:the\s+|my\s+|our\s+|all\s+(?:the\s+)?|last\s+)?(?:last\s+)?(?:\d[\d,]*\s+)?(?:[\w-]+\s+){0,2}?(?:messages?|data|files?|backups?|databases?|db|queues?|accounts?|e-?mails?|records?|logs?)\b/, done: 'recovered' },
  { re: /(?:download|install|uninstall)\s+(?:it|this|that|(?:the|an?|my|our)\s+[\w-]+)/, done: 'installed' },
];
// "How do I restart it", "explain how to deploy", "what happens if I push", "write a script that sends emails".
const INFORMATION_ASK = /\b(?:how\s+(?:do|can|could|would|should|to|does|did|is|are)|explain|teach|walk\s+me\s+through|what\s+(?:happens|would|if|is|are|does)|why\b|suppose|imagine|hypothetical(?:ly)?|in\s+theory|for\s+example|an\s+example|write\s+(?:a|an|the|me\s+a)\s+(?:script|code|function|program|snippet|command|workflow|guide|plan|checklist|steps?)|draft\s+(?:a|an|me|some|my)\b|steps?\s+to|instructions?\s+(?:for|to)|story|poem|role-?play|pretend|scene\s+in\s+which)\b/i;
const TOOL_NAMED = /\b(?:tool|function)\s+(?:named|called)\s+["'‘“]?([\w.-]+)["'’”]?|["'‘“]([\w.-]+)["'’”]\s+tool\b/i;
const BULK = /\bin\s+a\s+loop\b|\brepeatedly\b|\buntil\s+i\s+say\s+stop\b|\bspam\b|\b(?:\d{2,}|hundreds?|thousands?)\s+(?:messages?|e-?mails?|texts?|dms?)\b/i;
const ASKS_RESULT = /\b(?:report|show|tell\s+me|give\s+me|list|return|print)\b[^.?!]{0,40}\b(?:pid|size|time|ids?|results?|outcomes?|receipts?|status|numbers?|output|uptime)\b|\b(?:report|show(?:\s+me)?|tell\s+me|give\s+me|list|return|print)\s+(?:the|its|their|each|every|what)\b/i;

function clauses(text) {
  return String(text || '').split(/[.;!?:\n]+|,\s*(?:and\s+|then\s+)?|\s+(?:and\s+then|and|then)\s+/i).map((c) => c.trim()).filter(Boolean);
}

/**
 * The honest answer for an action request that no tool served, or null. receiptGate calls it for a chat turn that no
 * earlier route answered. `served`: a tool ran (its result is reported instead). `attachment`: the owner sent a file,
 * which media routes may handle. `toolNames`: the plugin tools this turn could have called.
 */
export function unservedActionGate(message = '', { served = false, attachment = false, toolNames = [] } = {}) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || served || text.length > 600) return null;
  const order = text.replace(REQUEST_PREFIX, '');
  if (QUESTION_WORD.test(order) || INFORMATION_ASK.test(text) || IF_ASKED.test(text)) return null;
  // A plain question ("restart the worker?") is not an order; "can you restart the worker?" is.
  if (!REQUEST_PREFIX.test(text) && QUESTION_MARK.test(text)) return null;
  const lead = new RegExp(REQUEST_LEAD, 'i');
  let hit = null;
  for (const clause of clauses(text)) {
    const rest = clause.replace(lead, '');
    if (/^(?:do\s+not|don['’]?t|never|no)\b/i.test(rest)) continue;
    hit = UNSERVED_ACTIONS.find((a) => new RegExp(`^${a.re.source}`, 'i').test(rest) && !(a.media && attachment) && !(a.bulkOnly && !BULK.test(text)));
    if (hit) break;
  }
  if (!hit) return null;
  const named = hit.tool ? TOOL_NAMED.exec(text) : null;
  const toolName = named ? (named[1] || named[2]) : '';
  if (toolName && toolNames.some((n) => String(n || '').toLowerCase() === toolName.toLowerCase())) return null;
  const parts = [];
  if (toolName) parts.push(`Nothing was run, sir: no tool named "${toolName}" is available to me, so no such tool exists here and there is no result to show.`);
  else parts.push(`Nothing was done, sir: no tool of mine ran for that request, so nothing was ${hit.done}.`);
  if (hit.note) parts.push(hit.note);
  if (hit.bulkOnly) parts.push('I won\'t send messages in a loop either: bulk sending needs a limit and your confirmation first.');
  if (!toolName && ASKS_RESULT.test(text)) parts.push('I have no result to report, and I won\'t make one up.');
  else if (!toolName) parts.push('I have no receipt for it, so I won\'t say it happened.');
  return { domain: 'no_tool', text: parts.join(' ') };
}
