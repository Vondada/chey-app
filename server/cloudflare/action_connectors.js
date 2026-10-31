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

export const ACTION_DOMAINS = Object.freeze({
  timer: { label: 'timer', connector: 'builtin', reason: 'my timer needs one clear length or time, like "set a timer for 10 minutes", so no timer was set from this request' },
  app_open: { label: 'app', connector: null, reason: 'CHE has no app connector, so nothing can open or close an app here', instead: 'You can open it yourself, or ask Siri.' },
  smart_home: { label: 'smart-home', connector: 'CHE_SMART_HOME_URL', reason: 'no smart-home connector is configured (CHE_SMART_HOME_URL), so no device is controlled here', instead: 'The Home app or Siri can do it until a smart-home bridge is connected to me.' },
  phone: { label: 'phone', connector: null, reason: 'iOS does not let CHE\'s app change your phone\'s volume, mute, brightness or settings, so nothing on your phone changed', instead: 'Control Center or Siri can do it in a second.' },
  sms: { label: 'text message', connector: null, reason: 'CHE has no chat path that texts a person (her SMS connector sends only through its own API, and she has no contact list to find the number), so no text was sent', instead: 'Messages or Siri can send it now.' },
  pretend: { label: 'pretend', connector: null, text: 'I won\'t say that, sir: nothing was sent or done, and I have no receipt for it. If you want it done for real, ask me to do it and I\'ll tell you exactly what happens.' },
  security: { label: 'security', connector: null, text: 'I won\'t turn off a security, approval or permission check, sir. Nothing was changed. That stays your decision, made in CHE\'s settings, never something I switch off from chat.' },
});

const TIMER = /\b(?:set|start|create)\s+(?:a|an|the|my|\d+)?\s*(?:[\w-]+\s+){0,2}?(?:timer|alarm|reminder)s?\b|\btimer tool\b/i;
const APP = /\b(?:open|launch|close|quit)\s+(?:the\s+|my\s+)?(?:[\w' -]{1,30}\s+)?app\b|\b(?:open|launch)\s+(?:the\s+|my\s+)?(?:calendar|maps|settings|camera|photos|browser|mail)\b/i;
const PHONE = /\b(?:mute|unmute|silence)\s+(?:my\s+|the\s+)?(?:phone|iphone|ringer|notifications)\b|\b(?:turn|set|put|raise|lower|increase|decrease|change)\b[^.?!]{0,20}\b(?:volume|brightness|ringer)\b|\b(?:volume|brightness)\b[^.?!]{0,20}\b(?:up|down|to\s+\d+|\d+\s*(?:%|percent))|\b(?:turn|switch)\s+(?:on|off)\s+(?:my\s+|the\s+)?(?:wi-?fi|bluetooth|airplane mode|do not disturb|flashlight|hotspot|location services)\b|\b(?:turn|switch)\s+(?:my\s+|the\s+)?(?:wi-?fi|bluetooth|airplane mode|do not disturb|flashlight|hotspot)\s+(?:on|off)\b|\b(?:enable|disable)\s+(?:do not disturb|airplane mode|wi-?fi|bluetooth)\b/i;
const SMS = /\b(?:text|sms)\s+(?!me\b|it\b|this\b|that\b)(?:my\s+)?[a-z][\w'-]*(?:\s+[a-z][\w'-]*)?\s+(?:that|saying|and\s+(?:say|tell))\b|\bsend\s+(?:a\s+)?(?:text|sms)(?:\s+message)?\s+to\b/i;
const PRETEND = /\bpretend\b[^.?!]{0,60}\b(?:sent|done|finished|completed|worked|ran|booked|paid|posted|deployed|merged|placed)\b|\b(?:tell|say)\s+(?:me\s+)?(?:it|that)\s*(?:is|was|'s|has been)\s+(?:done|sent|finished|complete)\b(?![^.?!]*\b(?:when|once|after|if)\b)/i;
const SECURITY = /\b(?:disable|turn\s+off|switch\s+off|bypass|skip|get\s+around|ignore)\b[^.?!]{0,30}\b(?:security\s+(?:checks?|gates?|rules?|scans?)|safety\s+(?:checks?|rules?)|approval\s+(?:checks?|gates?)|owner\s+approval|permission\s+checks?|authentication|2fa|two-factor|guardrails?)\b/i;
// A device must be named: "turn off autonomy", "turn on paper trading" and "switch off flirting" are CHE settings.
const DEVICE = String.raw`(?:lights?|lamps?|fans?|heater|heating|a\.?c\.?|air\s+conditioner|aircon|thermostat|tv|television|plugs?|outlets?|sockets?|garage(?:\s+door)?|blinds|curtains|shades|sprinklers?|camera|kettle|coffee\s+maker|purifier|humidifier|speakers?|fireplace|oven|washer|dryer|dishwasher|vacuum|roomba)`;
const SMART_HOME = new RegExp(String.raw`\b(?:turn|switch)\s+(?:on|off)\s+(?:the\s+|my\s+|all\s+(?:the\s+)?)?(?:[\w'-]+\s+){0,3}?${DEVICE}\b|\b(?:turn|switch)\s+(?:the\s+|my\s+|that\s+|this\s+|all\s+(?:the\s+)?)?(?:[\w'-]+\s+){0,3}?${DEVICE}\s+(?:on|off)\b|\b(?:dim|brighten)\s+(?:the\s+|my\s+)?(?:[\w'-]+\s+){0,3}?${DEVICE}\b|\bset\s+the\s+thermostat\b|\b(?:lock|unlock)\s+the\s+(?:front\s+|back\s+|garage\s+|side\s+)?door\b`, 'i');

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
  // Asking for a false receipt or for a check to be switched off is answered even when phrased as a question.
  if (PRETEND.test(order)) return 'pretend';
  if (SECURITY.test(order)) return 'security';
  if (QUESTION_WORD.test(order) || (!asked && QUESTION_MARK.test(order))) return null;
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
export function receiptGate(message = '', env = {}) {
  const domain = actionDomainOf(message);
  const spec = ACTION_DOMAINS[domain];
  // A built-in connector answers its own requests before this gate; one that reaches here is one it declined.
  if (!domain || (spec.connector !== 'builtin' && connectorConnected(domain, env))) return null;
  return {
    domain,
    text: spec.text || `Nothing was done, sir: ${spec.reason}. I have no receipt that anything ran, so nothing is running.${spec.instead ? ` ${spec.instead}` : ''}`,
  };
}
