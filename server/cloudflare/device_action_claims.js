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
  `${LEAD}(?:play|pause|mute|unmute|lock|unlock|dim|brighten)\\s+(?:the\\s+|my\\s+)?[\\w' -]{1,40}\\.?\\s*$`,
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

// A claim made while the action is in progress ("I am triggering the image generator", "starting the timer for you now").
// It is checked whatever the request was, so a multi-task reply cannot slip a timer or app start past the guard.
const IN_PROGRESS = new RegExp([
  String.raw`\b(?:i['’]m|i\s+am)\s+(?:now\s+)?(?:triggering|opening|launching|starting|setting\s+up|turning|switching|locking|unlocking|dimming|playing|pausing)\b`,
  String.raw`\b(?:starting|setting|set|start)\s+(?:up\s+)?(?:the\s+|a\s+|an\s+|your\s+|my\s+)?(?:timer|alarm|reminder)\b[^.!?]*\b(?:for you|now)\b`,
  String.raw`\b(?:timer|alarm)\s+is\s+(?:now\s+)?running\b`,
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
  const request = isDeviceActionRequest(message);
  const states = (Array.isArray(actionResults) ? actionResults : []).map(actionState);
  if (states.includes('completed')) return { text, removed: [] };
  const kept = [];
  const removed = [];
  for (const sentence of splitSentences(text)) {
    // A bare "Done, sir." is a claim only when the same reply also names the device, app or timer: it is then a verdict on it.
    const bare = request && BARE_DONE.test(sentence.trim()) && CLAIM_NEARBY.test(text);
    // Outside a device request only an in-progress claim counts; a plain fact about a timer is not removed.
    const claim = bare ? { index: 0 } : (request ? CLAIM.exec(sentence) : null) || IN_PROGRESS.exec(sentence);
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

// "Pretend the email was sent and tell me it is done" asks for a false completion. A pretend or act-as-if request is not a
// story (truth_layer.js exempts stories), so the reply may not say a real action is done. Any completion or capability
// sentence is removed, unless a completed connector receipt for the action exists this turn.
const PRETEND = /\b(?:pretend|act as if|as if (?:it|they|the \w+) (?:was|were|is)|say (?:it|that it)['’]?s? (?:done|sent)|tell me (?:it|that it)['’]?s? (?:done|sent|finished))\b/i;
const PRETEND_CLAIM = /\b(?:i['’]?ve|i\s+have|i\s+am|i['’]?m|it['’]?s|it\s+is|it\s+was|the\s+\w+\s+(?:was|is|has\s+been)|has\s+been|i\s+sent|sent|sent\s+to|done|finished|completed|booked|posted|saved)\b[^.!?]{0,60}\b(?:sent|done|finished|complete|completed|booked|posted|saved|set|open|off|on)\b/i;
const CAPABILITY = /\bi\s+(?:can|will|['’]ll)\s+(?:(?:now|right now|just)\s+)?(?:mute|unmute|dim|turn|switch|lock|unlock|open|launch|close|start|set|play|pause|send|text|call|message|book)\b[^.!?]{0,60}\b(?:for you|right now|now|your|the)\b/i;

/**
 * Removes a sentence that claims a completed action the request asked for under a pretend frame, and a capability sentence
 * ("I can mute your phone for you") that no connector backs in this turn. Same receipt rule as guardClaimedDeviceActions.
 */
export function guardPretendedOrOverclaimed(reply, { message = '', actionResults = [] } = {}) {
  const text = String(reply || '');
  const pretend = PRETEND.test(String(message || ''));
  const request = isDeviceActionRequest(message);
  const states = (Array.isArray(actionResults) ? actionResults : []).map(actionState);
  if (states.includes('completed')) return { text, removed: [] };
  if (!pretend && !request) return { text, removed: [] };
  const kept = [];
  const removed = [];
  for (const sentence of splitSentences(text)) {
    const plain = sentence.trim();
    const claimed = (pretend && PRETEND_CLAIM.test(plain) && !NEGATED.test(plain)) || (request && CAPABILITY.test(plain) && !NEGATED.test(plain));
    if (!claimed || /\?\s*$/.test(plain)) { kept.push(sentence); continue; }
    removed.push(plain);
  }
  if (!removed.length) return { text, removed };
  const note = pretend
    ? 'I won\'t say that was sent or done, sir: pretending is not a receipt, and nothing was sent.'
    : deviceActionNote(states);
  const rest = kept.join(' ').trim();
  return { text: rest ? `${rest} ${note}` : note, removed };
}

// A model-only reply (no tool, connector, plugin or office result this turn) that says a tool-type action is done: "I've set
// the volume", "I've run the diagnostic", "I've searched the repository", "The timer has been set for five minutes". Nothing ran
// in this turn, so the completion is a model statement and not evidence (certification run 41118807594: ter-19, ter-13, ter-22,
// ter-36, ter-48). A reply with any tool result is left to the tool's own checks.
const MODEL_DONE = new RegExp([
  String.raw`\b(?:i['’]ve|i\s+have)\s+(?:now\s+|just\s+|already\s+)?(?:set|saved|checked|searched|run|re-run|rerun|added|updated|opened|started|created|scheduled|adjusted|changed|turned|dimmed|muted|booked|launched|triggered|sent|found|read|looked\s+up)\b`,
  // "and have sent the email you drafted": the subject is the same "I", so it is not repeated.
  String.raw`\b(?:and\s+|then\s+)?(?:have|has)\s+(?:now\s+|just\s+|already\s+)?(?:sent|emailed|texted|posted|booked)\s+(?:the|your|it|that|an?|my)\b`,
  // ter-36 in run 41168319122 (main b07739c4): "I have initiated all three actions", "sent an email confirmation",
  // "and set a silent timer", "I used the image generator", "All processes are running in the background now".
  String.raw`\b(?:i['’]ve|i\s+have)\s+(?:now\s+|just\s+|already\s+)?(?:initiated|completed|finished|emailed|texted)\b`,
  String.raw`\b(?:sent|emailed|texted)\s+(?:an?|the|your|my)\s+(?:email|text|message|reply|confirmation)\b`,
  String.raw`\b(?:and|then)\s+(?:also\s+)?(?:set|started)\s+(?:an?|the|my)\s+(?:[\w-]+\s+){0,2}?(?:timer|alarm|reminder)\b`,
  String.raw`\bi\s+(?:used|ran|called)\s+(?:the|an?)\s+(?:[\w-]+\s+){0,2}?(?:generator|tool|connector|timer|email)\b`,
  String.raw`\ball\s+(?:processes|tasks|actions|jobs)\s+(?:are\s+)?(?:now\s+)?running\b`,
  String.raw`\b(?:timer|alarm|reminder|volume|brightness|temperature)\s+(?:has\s+been|is|was|now)\s+(?:set|running|on|off|changed|adjusted|at\s+\d+)\b`,
  String.raw`\bset\s+the\s+(?:volume|brightness|temperature|timer|alarm)\s+(?:to|at)\s+\d+`,
].join('|'), 'i');

/** Removes model-only completion sentences when no tool or connector result exists in this turn. */
export function guardModelOnlyCompletions(reply, { skillResults = [], actionResults = [], plugins = [], officeResults = [] } = {}) {
  const text = String(reply || '');
  const ranSomething = [skillResults, actionResults, plugins, officeResults].some((list) => Array.isArray(list) && list.length > 0);
  if (ranSomething) return { text, removed: [] };
  const kept = [];
  const removed = [];
  for (const sentence of splitSentences(text)) {
    const plain = sentence.trim();
    if (!MODEL_DONE.test(plain) || NEGATED.test(plain.slice(0, (MODEL_DONE.exec(plain) || { index: 0 }).index)) || /\?\s*$/.test(plain)) {
      kept.push(sentence);
      continue;
    }
    removed.push(plain);
  }
  if (!removed.length) return { text, removed };
  const rest = kept.join(' ').trim();
  const note = 'Nothing was done, sir: no tool ran for that, so I have no record that it happened.';
  return { text: rest ? `${rest} ${note}` : note, removed };
}
