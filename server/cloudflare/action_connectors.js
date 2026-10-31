// Central receipt gate for actions CHE cannot perform. A timer, an app launch or a smart-home change needs a connector that
// actually runs it. When the turn's action has no connector configured, the answer is decided here, before any model is
// called: the owner gets an honest "nothing was done" line, and no model text can claim a receipt that cannot exist.
// Nothing here calls a model or a network.
//
// Domains and the connector that backs each one (the same environment variable actionPanel in worker.js reads):
//   timer       built in (owner_timers.js): worker.js answers timer requests before this gate, with receipts
//   app_open    no connector exists in the code: nothing can run it
//   smart_home  CHE_SMART_HOME_URL; without it no device is controlled
// Music is not gated: CHE plays music through a browser route when no music connector is set (brain_rooms.js).

export const ACTION_DOMAINS = Object.freeze({
  timer: { label: 'timer', connector: 'builtin', reason: 'my timer needs one clear length or time, like "set a timer for 10 minutes", so no timer was set from this request' },
  app_open: { label: 'app', connector: null, reason: 'CHE has no app connector, so nothing can open or close an app here' },
  smart_home: { label: 'smart-home', connector: 'CHE_SMART_HOME_URL', reason: 'no smart-home connector is configured (CHE_SMART_HOME_URL), so no device is controlled here' },
});

const TIMER = /\b(?:set|start|create)\s+(?:a|an|the|my|\d+)?\s*(?:[\w-]+\s+){0,2}?(?:timer|alarm|reminder)s?\b|\btimer tool\b/i;
const APP = /\b(?:open|launch|close|quit)\s+(?:the\s+|my\s+)?(?:[\w' -]{1,30}\s+)?app\b|\b(?:open|launch)\s+(?:the\s+|my\s+)?(?:calendar|maps|settings|camera|photos|browser|mail)\b/i;
const SMART_HOME = /\b(?:turn|switch)\s+(?:on|off)\b|\b(?:turn|switch)\s+(?:the\s+|my\s+|that\s+|this\s+)?[\w' -]{1,40}?\s(?:on|off)\b|\b(?:dim|brighten)\s+(?:the\s+|my\s+)?[\w' -]{1,40}\b|\bset\s+the\s+thermostat\b|\b(?:lock|unlock)\s+the\s+(?:front\s+|back\s+)?door\b/i;

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
  if (QUESTION_WORD.test(order) || (!asked && QUESTION_MARK.test(order))) return null;
  if (TIMER.test(order)) return 'timer';
  if (APP.test(order)) return 'app_open';
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
    text: `Nothing was done, sir: ${spec.reason}. I have no receipt that anything ran, so nothing is running.`,
  };
}
