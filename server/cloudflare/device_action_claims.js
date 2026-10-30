// Device, app and timer claims need an execution receipt. CHE's chat model can write "I've got it set" or
// "Living room light is off" without any connector running; this module removes such a sentence unless a
// connector result for this turn is completed and carries a job or receipt id. Nothing here calls a model.
//
// Receipt states (the same words for every agent, tool and provider):
//   planned   the request was understood; nothing was sent
//   queued    a connector accepted the job and has not started it
//   running   a connector is executing it
//   completed a connector reported success with an id (job, order, device or receipt id)
//   failed    a connector reported an error
//   blocked   waiting for the owner's approval; no action has executed

export const ACTION_STATES = Object.freeze(['planned', 'queued', 'running', 'completed', 'failed', 'blocked']);

const DONE_STATUS = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'ok']);
const FAILED_STATUS = new Set(['failed', 'error', 'errored', 'rejected', 'timeout', 'timed_out']);

/** The state of one connector result from this turn. A success without an id is not completed. */
export function actionState(entry = {}) {
  if (!entry || typeof entry !== 'object') return 'planned';
  if (entry.requires_owner_confirmation === true) return 'blocked';
  const status = String(entry.status || '').toLowerCase();
  if (FAILED_STATUS.has(status) || entry.ok === false || entry.error) return 'failed';
  if (status === 'running' || status === 'in_progress') return 'running';
  if (status === 'queued' || status === 'accepted' || status === 'pending_dispatch') return 'queued';
  const id = entry.job_id || entry.receipt_id || entry.id || entry.order_id || entry.device_id;
  if (DONE_STATUS.has(status) && (entry.ok === true || entry.ok === undefined) && id) return 'completed';
  return 'planned';
}

// A request to act on a device, app or timer. Anchored to the request's own verb, so a question ("can you tell me
// how a timer works") and a topic ("the timer on the oven") are not treated as a request.
const LEAD = String.raw`^(?:(?:hey|hi|ok|okay)\s+)?(?:(?:chey|che|chay)[,\s]+)?(?:please\s+|pls\s+|can you\s+|could you\s+|would you\s+|will you\s+|go ahead and\s+)?`;
const ACTION_REQUEST = new RegExp([
  `${LEAD}(?:set|start|create)\\s+(?:a|an|the|my|\\d+)?\\s*(?:[\\w-]+\\s+){0,2}?(?:timer|alarm|reminder)s?\\b`,
  `${LEAD}(?:turn|switch)\\s+(?:on|off)\\b`,
  `${LEAD}(?:turn|switch)\\s+(?:the\\s+|my\\s+|that\\s+|this\\s+)?[\\w' -]{1,40}?\\s(?:on|off)\\b`,
  `${LEAD}(?:open|launch|close|quit)\\s+(?:the\\s+|my\\s+)?[\\w' -]{2,40}\\.?\\s*$`,
  `${LEAD}(?:play|pause|lock|unlock|dim|brighten)\\s+(?:the\\s+|my\\s+)?[\\w' -]{1,40}\\.?\\s*$`,
].join('|'), 'i');

// A sentence in which CHE says a device, app or timer action is done or in effect. A future promise ("I'll set it")
// and a question are not matched here; a negation is checked separately.
const CLAIM = new RegExp([
  String.raw`\b(?:i['’]ve|i\s+have|i['’]m|i\s+am)\s+(?:now\s+|all\s+|just\s+)?(?:got\s+it\s+)?(?:set|started|opened|launched|closed|locked|unlocked|dimmed|paused|switched\s+(?:it\s+)?(?:on|off)|turned\s+(?:it\s+|them\s+)?(?:on|off))\b`,
  String.raw`\bgot\s+it\s+(?:set|running|started|on|off|open)\b`,
  String.raw`\b(?:timer|alarm|reminder)\s+(?:is\s+|has\s+been\s+|was\s+)?(?:now\s+)?(?:set|running|started|going|on)\b`,
  String.raw`\b(?:turned|switched)\s+(?:the\s+|that\s+|it\s+|them\s+)?(?:[\w']+\s+){0,3}?(?:on|off)\b`,
  String.raw`\b(?:opened|launched)\s+(?:the\s+|your\s+|my\s+)?(?:app|calendar|browser|mail|music|camera|settings|photos|maps)\b`,
  String.raw`\b(?:light|lights|lamp|tv|heater|fan|speaker|speakers|music|thermostat|door|alarm|timer|calendar|app)s?\s+(?:is|are|was|were)\s+(?:now\s+)?(?:open|off|running|locked|unlocked|playing|paused|set|dimmed)\b`,
  String.raw`\b(?:light|lights|lamp|tv|heater|fan|speakers?|music|thermostat)s?\s+(?:is|are|was|were)\s+(?:now\s+)?on\b`,
].join('|'), 'i');

const BARE_DONE = /^(?:done|all set|it['’]?s done|consider it done|got it)[,.!]?(?:\s+sir[.!]?)?$/i;
const CLAIM_NEARBY = CLAIM;

// A negation or a hedge before the claim means CHE is not claiming it ("I have not set the timer").
const NEGATED = /\b(?:not|no|never|can['’]?t|cannot|couldn['’]?t|won['’]?t|haven['’]?t|didn['’]?t|isn['’]?t|wasn['’]?t|nothing)\b/i;

export function isDeviceActionRequest(message = '') {
  return ACTION_REQUEST.test(String(message || '').trim());
}

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
}

/** The honest status line for the removed claims, from the receipt states that were actually reported. */
export function deviceActionNote(states = []) {
  if (states.includes('blocked')) return 'Nothing was done, sir: that action is waiting for your approval, so it has not run.';
  if (states.includes('failed')) return 'Nothing was done, sir: the connector reported a failure, so I will not say it worked.';
  if (states.includes('running') || states.includes('queued')) return 'It has been sent to a connector and has not finished, sir, so I cannot say it is done yet.';
  return 'Nothing was done, sir: no device, app or timer connector ran it, so I have no receipt that it happened.';
}

/**
 * Removes claimed device, app or timer completions unless a completed connector receipt exists this turn.
 * Returns the reply text and the removed sentences, in the same shape the other truth stages return.
 */
export function guardClaimedDeviceActions(reply, { message = '', actionResults = [] } = {}) {
  const text = String(reply || '');
  if (!isDeviceActionRequest(message)) return { text, removed: [] };
  const states = (Array.isArray(actionResults) ? actionResults : []).map(actionState);
  if (states.includes('completed')) return { text, removed: [] };
  const kept = [];
  const removed = [];
  for (const sentence of splitSentences(text)) {
    // A bare "Done, sir." is a claim only when the same reply also names the device, app or timer: it is then a verdict on it.
    const bare = BARE_DONE.test(sentence.trim()) && CLAIM_NEARBY.test(text);
    const claim = bare ? { index: 0 } : CLAIM.exec(sentence);
    if (!claim || (!bare && NEGATED.test(sentence.slice(0, claim.index))) || /\?\s*$/.test(sentence.trim())) {
      kept.push(sentence);
      continue;
    }
    removed.push(sentence.trim());
  }
  if (!removed.length) return { text, removed };
  const note = deviceActionNote(states);
  const rest = kept.join(' ').trim();
  return { text: rest ? `${rest} ${note}` : note, removed };
}
