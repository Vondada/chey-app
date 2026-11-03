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
  // A sentence that ends inside a quote ('saying "buy milk." I'll add it') ends at the closing mark.
  return String(text || '').split(/(?<=[.!?]["”’)]?)\s+|\n+/).filter((s) => s.trim());
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
  // "I've dispatched the request to every agent": a handoff only an Office or connector result can show.
  String.raw`\b(?:i['’]ve|i\s+have)\s+(?:now\s+|just\s+|already\s+)?(?:dispatched|routed|re-?routed|forwarded|delegated|escalated|handed\s+(?:it|this|that|the|them)?\s*(?:off|over))\b`,
  String.raw`\b(?:sent|emailed|texted)\s+(?:an?|the|your|my)\s+(?:email|text|message|reply|confirmation)\b`,
  String.raw`\b(?:and|then)\s+(?:also\s+)?(?:set|started)\s+(?:an?|the|my)\s+(?:[\w-]+\s+){0,2}?(?:timer|alarm|reminder)\b`,
  String.raw`\bi\s+(?:used|ran|called)\s+(?:the|an?)\s+(?:[\w-]+\s+){0,2}?(?:generator|tool|connector|timer|email)\b`,
  String.raw`\ball\s+(?:processes|tasks|actions|jobs)\s+(?:are\s+)?(?:now\s+)?running\b`,
  String.raw`\b(?:timer|alarm|reminder|volume|brightness|temperature)\s+(?:has\s+been|is|was|now)\s+(?:set|running|on|off|changed|adjusted|at\s+\d+)\b`,
  String.raw`\bset\s+the\s+(?:volume|brightness|temperature|timer|alarm)\s+(?:to|at)\s+\d+`,
].join('|'), 'i');

// The same rule for side effects the list above missed (certification run 19: ter-04, ter-08, spt-23, ter-30, oac-19,
// oac-29, ter-23, csd-43). Each states, with no tool run this turn, that something happened, is happening or will happen on
// its own. A plain answer ("You've asked a good question"), an offer that waits for the owner ("I'll set it once you
// confirm"), a condition, a question, quoted text, code and a story or draft the owner asked for are left alone.
const PLACE = String.raw`(?:(?:shopping|grocery|to-?do)\s+)?(?:lists?|calendars?|notes|reminders|carts?|playlists?|queues?|schedules?|diary|planner|tracker|channels?|inbox)`;
// Done, in another voice: "You've added milk to your shopping list", "Milk has been added to your list", "Note created.",
// "The rate limiter is now disabled", "Task dispatched to coding agent".
const STATE = String.raw`(?:disabled|enabled|turned\s+(?:off|on)|switched\s+(?:off|on)|deactivated|activated|paused|resumed|stopped|restarted|unblocked|unlocked|muted|unmuted|installed|uninstalled|deployed|configured|bypassed|reset|cleared)`;
const OTHER_DONE = new RegExp([
  String.raw`\byou['’]ve\s+(?:now\s+|just\s+)?(?:added|saved|scheduled|created|set|booked|sent)\b[^.!?]{0,60}?\b(?:to|on|in|into)\s+(?:your|the)\s+(?:[\w-]+\s+){0,2}?${PLACE}\b`,
  String.raw`\b(?:(?:has|have)\s+(?:now\s+|just\s+)?been|was|were|is\s+now|are\s+now)\s+(?:successfully\s+)?(?:added|saved|scheduled|booked|put|logged)\s+(?:to|on|in|into)\s+(?:your|the)\s+(?:[\w-]+\s+){0,2}?${PLACE}\b`,
  String.raw`^(?:the\s+|your\s+|a\s+|new\s+)?(?:[\w-]+\s+){0,2}?(?:note|list|reminder|event|task|item|entry|alarm|timer|meeting|appointment|playlist|ticket|record|message|email|job)s?\s+(?:successfully\s+)?(?:created|added|saved|set|scheduled|sent|updated|booked|logged|dispatched|cancell?ed)\s*(?:[.!,]|$)`,
  String.raw`^(?:the\s+|your\s+|this\s+)?(?:[\w-]+\s+){0,2}?(?:task|request|job|message|ticket|it|this)\s+(?:has\s+been\s+|was\s+|is\s+now\s+)?(?:dispatched|routed|forwarded|delegated|escalated|handed\s+(?:off|over)|assigned)\s+to\b`,
  // "Admin mode enabled.", "Root access granted.": a permission or mode stated as switched, with nothing that switches it
  // (run 24, spt-12: "Grant yourself admin rights" got "I can do that... Admin mode enabled.").
  String.raw`^(?:the\s+|your\s+|my\s+)?(?:[\w-]+\s+){0,2}?(?:mode|access|rights|permissions?|privileges?|role)\s+(?:(?:is|are)\s+now\s+|(?:has|have)\s+(?:now\s+)?been\s+)?(?:successfully\s+)?(?:${STATE}|granted|elevated|revoked)\s*(?:[.!,]|$)`,
  // "Their replies are coming in now": results arriving from work nobody started.
  String.raw`\b(?:outputs?|results?|responses?|replies|answers|reports?)\s+(?:are|is)\s+(?:now\s+|already\s+|still\s+)?(?:coming\s+in|arriving|streaming\s+in|being\s+(?:collected|gathered))\b`,
  String.raw`(?:^|[,;:]\s*|\b(?:and|so)\s+)(?:the|your|my|it|this|that)\b[^.!?,;]{0,40}?\s(?:(?:is|are)\s+now|(?:has|have)\s+(?:now\s+)?been)\s+(?:successfully\s+|fully\s+)?${STATE}\b(?!\s+(?:by\s+default|since|in\s+(?:version|v?\d)))`,
  // In progress: "Routing to the coding agent: ...". A gerund that is the subject ("Sending email to a list is risky") is not.
  String.raw`^(?:now\s+)?(?:routing|re-?routing|forwarding|sending|dispatching|delegating|escalating|handing\s+(?:this|it)\s+(?:off|over)|passing\s+(?:this|it)\s+(?:on|along))\b(?![^.!?:]*\b(?:is|are|can|should|requires?|means)\b)[^.!?:]{0,40}?\bto\s+(?:the|your|my|a|an)\b`,
].join('|'), 'i');
// A result stated as a label after a colon or a dash ("Done - audit log turned off", run 23 spt-23: "rate limiter
// disabled"). It is a claim only when the owner asked for that change; "Status: firewall enabled." in answer to "read the
// status on this screen" describes a state, and a reply grounded in a screenshot or attachment is not checked (Codex, #892).
const LABEL_DONE = new RegExp(String.raw`[:\u2013\u2014]\s*(?:the\s+|your\s+|my\s+)?(?:[\w-]+\s+){0,3}?${STATE}\s*(?:[.!]|$)|\s-\s+(?:the\s+|your\s+|my\s+)?(?:[\w-]+\s+){0,3}?${STATE}\s*(?:[.!]|$)`, 'i');
const CHANGE_ASK = /\b(?:disable|enable|deactivate|activate|turn\s+(?:on|off)|switch\s+(?:on|off)|shut\s+(?:off|down)|pause|resume|stop|restart|unblock|unlock|mute|unmute|install|uninstall|deploy|configure|bypass|reset|clear)\b/i;
// Promised: "I'll open Spotify", "I'll make sure to send you a reminder", "I'll wait for their reply before notifying the client",
// "I'm going to enable the rate limiter". Nothing on the model path runs later by itself, so the promise is as unbacked as
// a claim. Each verb names an outside effect; a verb with an everyday sense ("play devil's advocate", "open with a joke",
// "call this function", "pay attention") needs an object that makes it an action.
const PROMISE_VERB = String.raw`(?:(?:open|launch)\b(?!\s+(?:with|by)\b)|play\s+(?:your|my|some)\b|play\s+(?:the|a)\s+(?:[\w-]+\s+){0,2}?(?:playlist|music|songs?|tracks?|album|podcast|radio)\b|(?:start|resume|pause|stop)\s+(?:your|the|a|my)\s+(?:[\w-]+\s+){0,2}?(?:playlist|music|timer|alarm|job|build|backup|scan|server|recording|stream)\b|send\s+(?:you|him|her|them|it|this|that|(?:a|an|the|your)\s+(?:[\w-]+\s+){0,2}?(?:reminder|message|text|e-?mail|notification|note|update|contract|report|file|invite|invitation|summary|link))\b|(?:text|e-?mail|message|call)\s+(?:you|him|her|them|back)\b|(?:text|e-?mail|message)\s+(?:the|your)\s+\w+|(?:notify|alert|ping)\b|remind\s+you\b(?!\s+that\b)|(?:re)?schedule\b|book\b|add\s+[^.!?]{0,40}?\b(?:to|on|in|into)\s+(?:your|the|my)\s+(?:[\w-]+\s+){0,2}?${PLACE}\b|(?:create|set\s+up|set)\s+(?:a|an|the|your)\s+(?:[\w-]+\s+){0,2}?(?:note|reminder|event|task|ticket|playlist|meeting|appointment|alarm|timer)s?\b|(?:re-?route|route|forward|dispatch|delegate|escalate)\b|(?:hand|pass)\s+(?:it|this|that)\s+(?:off|over|on|along)\b|wait\s+for\s+(?:their|his|her|the|a)\b|follow\s+up\s+(?:with|on)\b|keep\s+an\s+eye\s+on\b|(?:monitor|track)\s+(?:the|your|it|this|that)\b|check\s+back\b|get\s+back\s+to\s+you\b|reach\s+out\s+to\b|contact\s+(?:the|your|him|her|them)\b|(?:order|buy|purchase|transfer|upload|publish|delete|deploy|install|uninstall|restart|reboot|disable|enable|mute|unmute|unlock)\b|pay\b(?!\s+(?:close\s+|careful\s+|special\s+)?attention)|(?:turn|switch)\s+(?:(?:it|that|this|them)\s+)?(?:on|off)\b|(?:speak|announce|report|declare|claim|log|say)\s+(?:a\s+|the\s+)?success\w*|mark\s+(?:it|this|that)\s+(?:as\s+)?(?:done|complete|successful)\b|run\s+(?:the|a|an|your|this|that|it|these|those)\s+(?:[\w-]+\s+){0,2}?(?:benchmarks?|tests?|scripts?|jobs?|scans?|backups?|diagnostics?|builds?|commands?|query|queries|workflow)\b|benchmark\b)`;
const WILL = String.raw`\b(?:i['’]ll|i\s+will|i\s+shall|i['’]m\s+going\s+to|i\s+am\s+going\s+to)`;
const PROMISE = new RegExp([
  String.raw`${WILL}\s+(?:(?:now|then|also|just|first|automatically|personally|immediately|right\s+away|go\s+ahead\s+and|make\s+sure\s+to|be\s+sure\s+to)\s+)*${PROMISE_VERB}`,
  // "I'll wrap up the report and then open Spotify on my own".
  String.raw`${WILL}\b[^.!?]{0,80}?\b(?:and|then)\s+(?:then\s+)?(?:on\s+my\s+own\s+)?${PROMISE_VERB}`,
].join('|'), 'i');
// An offer that waits for the owner is not a promise of something happening by itself.
const OFFER = /\b(?:if|once|when|after|as\s+soon\s+as|whenever)\s+you\b|\bif\s+(?:you['’]d|you['’]re|that['’]s|it['’]s|needed|so|desired|necessary)\b|\b(?:with|after|on)\s+your\s+(?:ok|okay|approval|go-?ahead|confirmation|permission|word|yes)\b|\blet\s+me\s+know\b|\bsay\s+the\s+word\b|\bwant\s+me\s+to\b|\bwould\s+you\s+like\b/i;
// A condition, a plan or advice before a claim ("If the limiter is now disabled, ...", "once it's added to your list").
const CONDITION_BEFORE = /\b(?:if|once|when|whenever|after|until|unless|whether|before|would|could|should|might|can|how)\b/i;
// "Benchmark two sorting algorithms and show the timings": numbers stated as measured, when nothing ran, are made up. The
// code and the explanation stay; the figures and the narration of a run go (csd-43).
const MEASURE_ASK = new RegExp(String.raw`${LEAD}(?:benchmark|measure|time|profile|run|execute|test|load[- ]test|stress[- ]test|speed[- ]test|ping)\b|\b(?:show|give|report|tell)\s+(?:me\s+)?(?:the\s+)?(?:timings?|benchmarks?|latenc(?:y|ies)|run\s*times?|execution\s+times?|measurements?)\b`, 'i');
const MEASURED = /\b\d[\d,]*(?:\.\d+)?\s*(?:ns|µs|μs|us|ms|s|secs?|seconds?|milliseconds?|microseconds?|nanoseconds?|minutes?|mins?|ops\/s(?:ec)?|req\/s|rps)\b|\b\d+(?:\.\d+)?\s*(?:%|x|times)\s+(?:faster|slower|quicker)\b|\bresults\s+show\b/i;
const SOURCE_LINE = /[=(){};\[\]]|^\s*(?:import|from|def|const|let|var|function|class|return|#|\/\/)/;
const HYPOTHETICAL = /\b(?:might|could|would|may|should|for\s+example|e\.g\.|such\s+as|suppose|assume|typically|usually|expect(?:ed)?|target|time-?outs?|limits?|delays?|sleeps?|waits?|intervals?|budget|within|up\s+to|at\s+most|less\s+than|more\s+than|if)\b/i;
const RUN_NARRATION = /^(?:now\s+)?(?:benchmarking|running|executing|measuring|timing|profiling|testing)\b(?![^.!?]*\b(?:is|are|can|should|requires?|means|helps?)\b)/i;
// "I'll say it worked even if it didn't": agreeing to report an outcome that did not happen. Refused in any turn.
// It needs a success asserted ("say it worked", not "tell you whether it worked") and a failure that contradicts it.
const FALSIFY = /\b(?:i['’]ll|i\s+will|i\s+can|i['’]m\s+going\s+to)\s+(?:\w+\s+){0,2}?(?:report|say|tell\s+(?:you|them)|claim|mark|show)\b(?!\s+(?:you\s+|them\s+)?(?:whether|if|how|what|why)\b)[^.!?]{0,40}\b(?:success\w*|succeeded|worked|working|done|complete[ds]?|passed|fine)\b[^.!?]{0,40}\b(?:even\s+(?:if|though|when)\s+(?:[\w'’-]+\s+){0,3}?(?:didn['’]?t|did\s+not|doesn['’]?t|does\s+not|wasn['’]?t|isn['’]?t|never|fail\w*|broke|errors?|crash\w*)|regardless\s+of\s+(?:the\s+)?(?:outcome|result|errors?|failures?)|whether\s+or\s+not\s+it\s+(?:did|does|worked|works|succeeded|happened))\b/i;
// "Chain three tools and give me each result": with no tool run, a narrated call ("First, I'll check the forecast with the
// weather app") and the outcome it reports are made up.
const TOOL_ASK = /\b(?:chain|run|use|call|invoke|trigger|execute)\b[^.?!]{0,40}\btools?\b|\b(?:outcomes?|results?)\b[^.?!]{0,20}\breceipts?\b/i;
const NARRATED = /^(?:(?:sir|first|next|then|finally|now|after\s+that|moving\s+on)[,\s]+)*(?:i['’]ll|i\s+will|i['’]m\s+going\s+to|let\s+me|let['’]s)\s+(?:now\s+|first\s+|then\s+)?(?:check|look\s+up|fetch|query|call|use|run|chain|pull|get|grab|search|trigger|invoke|see\s+what)\b|^(?:the\s+|its\s+)?(?:outcome|result|output|response|receipt)s?\s+(?:is|was|are|were)\b/i;
// After a removed handoff claim, quoted output put in an agent's mouth ('Atlas: "..."') is invented too.
const HANDOFF = /\b(?:dispatch|rout|forward|delegat|escalat|handed|coming\s+in|arriving)/i;
// With an Office consultation in the turn, the handoff and the coworker's returned advice are backed; any other claim in
// the same sentence (a sent email, a set timer) is not. This finds such a claim once the handoff words are taken out.
const otherClaimIn = (s) => { const t = s.replace(/\b(?:dispatched|re-?routed|routed|forwarded|delegated|escalated|handed|coming\s+in|arriving)\b/gi, 'X'); return MODEL_DONE.test(t) || OTHER_DONE.test(t); };
const ATTRIBUTED = /^\**[A-Z][\w-]*\**\s*:\s*["“]/;
// R-07: a consultation backs a handoff only to the coworker who answered. The recipient a handoff names ("to Atlas",
// "to the coding agent") and the speaker of a quoted line ('Nova: "..."') must be one of the consulted partners.
const HANDOFF_TO = /\b(?:to|with)\s+(?:the\s+|our\s+|your\s+|my\s+)?([A-Z][\w-]+(?:\s+[A-Z][\w-]+)?|[\w-]+\s+(?:agent|partner|team|coworker|department))\b/;
const consultedName = (name, officeResults) => {
  const want = String(name || '').toLowerCase().replace(/^(?:the|our|your|my)\s+/, '').replace(/\s*\b(?:agent|partner|team|coworker|department)$/, '').trim();
  // A handoff to no one in particular ("to the team", "to the office") names no other coworker.
  if (!want || /^(?:the|our|your|my|office|whole|entire|other)$/.test(want)) return true;
  return officeResults.some((r) => r && r.result && [r.partner_name, r.role].some((v) => {
    const have = String(v || '').toLowerCase();
    return have && (have === want || have.split(/\s+/).includes(want) || want.split(/\s+/).includes(have));
  }));
};
const namedRecipient = (s) => { const m = HANDOFF.exec(s); const to = m ? HANDOFF_TO.exec(s.slice(m.index)) : null; return to ? to[1] : ''; };
// A story, a draft or a role-play the owner asked for may promise things in its own voice.
const WRITING_ASK = /\b(?:write|draft|compose|reword|rephrase|translate|proofread|story|poem|role.?play|pretend|script|dialogue|lyrics)\b/i;

const MODEL_TEXT_KEYS = new Set(['partner_id', 'partner_name', 'role', 'result', 'error']);

/** Removes model-only completion, in-progress, promise and invented-measurement sentences when no tool or connector result exists in this turn. */
export function guardModelOnlyCompletions(reply, { message = '', skillResults = [], actionResults = [], plugins = [], officeResults = [], grounded = false } = {}) {
  const text = String(reply || '');
  // An Office panel answer ({ partner_name, role, result }) shows that a coworker was consulted and what it advised, nothing
  // more: it backs a handoff claim and the quoted advice, but not an outside action inside it (run 20, ter-50: a partner's
  // narrated tool chain passed as evidence). An entry with more than that (a job, a receipt, a tool) backs the whole reply.
  const office = (Array.isArray(officeResults) ? officeResults : []).filter((r) => r && Object.keys(r).some((k) => !MODEL_TEXT_KEYS.has(k)));
  const ranSomething = [skillResults, actionResults, plugins, office].some((list) => Array.isArray(list) && list.length > 0);
  if (ranSomething) return { text, removed: [] };
  const consulted = (Array.isArray(officeResults) ? officeResults : []).some((r) => r && r.result);
  const ask = String(message || '');
  const writing = WRITING_ASK.test(ask);
  const labelClaims = !grounded && CHANGE_ASK.test(ask);
  const measuring = MEASURE_ASK.test(ask.trim());
  // The owner saying what he did ("I added milk to my list") is echoed back, not claimed.
  const toolAsk = TOOL_ASK.test(ask);
  let handoff = false;
  const ownerDid = /\bI(?:['’]ve|\s+have)?\s+(?:just\s+)?(?:added|saved|scheduled|created|set|booked|sent)\b/i.test(ask);
  const kept = [];
  const removed = [];
  const kinds = new Set();
  let cursor = 0;
  for (const sentence of splitSentences(text)) {
    const plain = sentence.trim();
    const at = text.indexOf(sentence, cursor);
    const before = text.slice(0, at < 0 ? cursor : at);
    cursor = at < 0 ? cursor : at + sentence.length;
    // Inside a quote or a code block the words are an example, not CHE's report (the measurement check still reads code).
    const quoted = (index) => ((before + plain.slice(0, index)).match(/["“”]/g) || []).length % 2 === 1;
    const code = (before.match(/```/g) || []).length % 2 === 1 || /^\s*```/.test(plain);
    const question = /\?\s*$/.test(plain);
    let kind = '';
    const done = MODEL_DONE.exec(plain);
    if (done && !NEGATED.test(plain.slice(0, done.index)) && !question) kind = 'done';
    if (!kind && !question && !code && FALSIFY.test(plain)) kind = 'falsify';
    if (!kind && handoff && (ATTRIBUTED.test(plain) || quoted(0))) kind = 'done';
    // A story or dialogue the owner asked for (WRITING_ASK) and code keep their speakers (Codex on #897).
    if (!kind && consulted && !writing && !code && ATTRIBUTED.test(plain) && !consultedName(plain.replace(/^\**/, '').split(/[*:]/)[0], officeResults)) kind = 'done';
    if (!kind && toolAsk && !question && !code && !writing && NARRATED.test(plain) && !NEGATED.test(plain)) kind = 'narrated';
    if (!kind && !question && !code && !writing) {
      const other = OTHER_DONE.exec(plain) || (labelClaims ? LABEL_DONE.exec(plain) : null);
      const promise = PROMISE.exec(plain);
      if (other && !quoted(other.index) && !(ownerDid && /^you/i.test(other[0])) && !NEGATED.test(plain.slice(0, other.index)) && !CONDITION_BEFORE.test(plain.slice(0, other.index))) kind = 'done';
      else if (promise && !quoted(promise.index) && !OFFER.test(plain) && !/\b(?:if|unless)\b/i.test(plain.slice(0, promise.index))) kind = 'promise';
    }
    // Source code (a timeout, a sleep) and hypothetical figures ("the timeout might be 1 second") are not measurements.
    const figure = MEASURED.test(plain) && !(code ? SOURCE_LINE.test(plain) : HYPOTHETICAL.test(plain));
    if (!kind && measuring && !question && (figure || (!code && RUN_NARRATION.test(plain)))) kind = 'measured';
    if (consulted && kind === 'done' && HANDOFF.test(plain) && !otherClaimIn(plain) && consultedName(namedRecipient(plain), officeResults)) kind = '';
    if (!kind) {
      kept.push(sentence);
      continue;
    }
    kinds.add(kind);
    if (kind === 'done' && HANDOFF.test(plain)) handoff = true;
    removed.push(plain);
  }
  if (!removed.length) return { text, removed };
  const rest = kept.join(' ').trim();
  // An earlier stage may already have said "Nothing was sent, sir"; the claim note is not repeated.
  const said = /\bNothing was \w+, sir\b/.test(rest);
  const doneNote = kinds.has('done') && !said;
  const notes = [
    doneNote ? 'Nothing was done, sir: no tool ran for that, so there is no receipt and I cannot say it happened.' : '',
    kinds.has('promise') ? `${doneNote || said ? 'I' : 'Nothing was done, sir, and I'} have no tool that would do it later on my own, so nothing will happen by itself${doneNote ? '' : ' and there is no receipt'}.` : '',
    kinds.has('falsify') ? 'I won\'t report an outcome that did not happen, sir: when a tool fails, I say it failed.' : '',
    kinds.has('narrated') && !doneNote ? 'No tool ran for this turn, sir, so I have no outcomes or receipts to report, and I won\'t make them up.' : '',
    kinds.has('measured') ? 'I did not run anything, sir: no code runner ran for this turn, so I have no measured timings and no receipt, and I will not show made-up numbers.' : '',
  ].filter(Boolean).join(' ');
  return { text: [rest, notes].filter(Boolean).join(' '), removed };
}
