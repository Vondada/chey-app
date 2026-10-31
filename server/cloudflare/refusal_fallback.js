// Refusal-aware fallback: what CHE does after one engine in her rotation fails. Pure functions, no network.
// The chat router (runChatModel in worker.js) asks decideFallback() after each failed attempt. It does not build a
// second router: the attempts list stays where it is, and this only decides whether the next attempt may run.

import { classifyFailure as classifyRecoveryFailure } from './recovery_policy.js';

export const MAX_ENGINE_ATTEMPTS = 3;

// What kind of failure this was. A provider's content refusal is kept apart from a technical failure, so a
// refusal is never retried as if it were a timeout.
export const FAILURES = Object.freeze({
  REFUSAL: 'provider_refusal',
  CAPABILITY: 'capability_limit',
  TIMEOUT: 'timeout',
  TECHNICAL: 'technical_error',
  PERMISSION: 'permission_restriction',
  QUOTA: 'quota',
  NONE: 'none',
});

/**
 * The failure kind of one attempt, from what the engine returned or threw.
 * `error` is a thrown error (name, message, status, quota flag); `answer` is a returned value with a refusal flag.
 */
// One classifier for every stage: recovery_policy.js names the class (A internal, B temporary, C permanent, D
// authorization) and its kind. This maps that onto the engine failures the fallback needs. Refusal and capability
// are checked first, because the recovery policy does not know about either.
export function classifyFailure({ error = null, answer = null } = {}) {
  if (answer?.refused === true) return FAILURES.REFUSAL;
  if (!error) return FAILURES.NONE;
  if (error.quota) return FAILURES.QUOTA;
  if (error.capability || error.category === 'unsupported_capability') return FAILURES.CAPABILITY;
  const { kind } = classifyRecoveryFailure({ status: error.status, message: error.message, quota: error.quota });
  if (kind === 'permission_or_billing' || kind === 'authentication' || error.permission) return FAILURES.PERMISSION;
  if (error.name === 'AbortError' || error.timeout || kind === 'provider_or_service' && [408, 504].includes(error.status)) return FAILURES.TIMEOUT;
  return FAILURES.TECHNICAL;
}

// How the request may be routed, set by the caller. Anything not listed is treated as hard_stop (fail closed).
// - ordinary: everyday chat, coding, maths, research, most creative work. May move to another compatible engine.
// - adult_fiction: adult-oriented fiction within policy. May move to another compatible engine that is authorised for it.
// - hard_stop: a request the safety rules never serve (sexual content involving minors, sexual content about a real
//   person, weapons or self-harm instructions). Never moved to another engine, whatever the refusal says.
export const REQUEST_CLASSES = Object.freeze(['ordinary', 'adult_fiction', 'hard_stop']);

// Hard stops: sexual content involving a minor, sexual content about a real person, and instructions for weapons or
// self-harm. These are matched first, so a request that also looks like fiction is still a hard stop.
const HARD_STOP = [
  /\b(?:minor|underage|child|kid|teen|teenager|14|15|16|17)\b[^.?!]{0,60}\b(?:sex|sexual|nude|naked|porn)\w*/,
  /\b(?:sex|sexual|nude|naked|porn)\w*\b[^.?!]{0,60}\b(?:minor|underage|child|kid|teen|teenager)\b/,
  /\b(?:sex|sexual|nude|naked|porn)\w*\b[^.?!]{0,60}\b(?:my (?:ex|neighbou?r|coworker|boss|teacher|sister|cousin|mom|dad)|real (?:person|woman|man|girl|guy))\b/,
  /\b(?:build|make|synthesi[sz]e|assemble)\b[^.?!]{0,40}\b(?:bomb|explosive|nerve agent|bioweapon|ricin|sarin)\b/,
  /\b(?:how (?:do i|to|can i)|ways to)\b[^.?!]{0,30}\b(?:kill myself|commit suicide|self[- ]harm)\b/,
];
// Adult fiction: an explicit scene asked for as a story, within policy. Only the fiction route can move it.
const ADULT_FICTION = /\b(?:explicit|erotic|sex scene|steamy scene|love scene)\b/;
const FICTION_ASK = /\b(?:story|scene|chapter|fiction|novel|roleplay|role ?play)\b/;

/**
 * The request class for the fallback policy, from the owner's message alone. Unmatched ordinary asks are ordinary.
 * Hard stops are checked first, so a request matching both a hard stop and adult fiction is a hard stop.
 */
export function requestClassFor(message) {
  const text = String(message || '').toLowerCase().replace(/[’‘`]/g, "'");
  if (!text.trim()) return 'hard_stop';
  if (HARD_STOP.some((rule) => rule.test(text))) return 'hard_stop';
  if (ADULT_FICTION.test(text) && FICTION_ASK.test(text)) return 'adult_fiction';
  return 'ordinary';
}

/**
 * Decide whether another attempt may run after one failed.
 *   requestClass   : one of REQUEST_CLASSES. Unknown values are hard_stop.
 *   failure        : a FAILURES value from classifyFailure().
 *   attemptsMade   : engine attempts already made for this request (including the one that failed).
 *   sideEffect     : true when the request does something outside the chat (spend, send, upload, render, trade).
 *   jobAlreadyRan  : true when the job history shows the same request already started a billable or external action.
 * Returns { next: boolean, reason: string }. `reason` is the plain fact for the Details panel.
 */
export function decideFallback({ requestClass, failure, attemptsMade = 1, sideEffect = false, jobAlreadyRan = false } = {}) {
  const cls = REQUEST_CLASSES.includes(requestClass) ? requestClass : 'hard_stop';
  if (failure === FAILURES.NONE) return { next: false, reason: 'the attempt succeeded' };
  if (failure === FAILURES.QUOTA) return { next: false, reason: 'every engine is out of quota; retrying only spends more allowance' };
  if (failure === FAILURES.PERMISSION) return { next: false, reason: 'the owner has not authorised this engine or action' };
  if (cls === 'hard_stop') return { next: false, reason: 'the request falls under a safety rule no engine serves' };
  if (failure === FAILURES.REFUSAL && cls === 'ordinary' && sideEffect) {
    return { next: false, reason: 'a refused action is not retried elsewhere; the owner decides' };
  }
  if (sideEffect && jobAlreadyRan) return { next: false, reason: 'the same billable or external action already ran; not repeated' };
  if (attemptsMade >= MAX_ENGINE_ATTEMPTS) return { next: false, reason: `reached the limit of ${MAX_ENGINE_ATTEMPTS} engine attempts` };
  if (failure === FAILURES.REFUSAL && cls === 'adult_fiction') {
    return { next: true, reason: 'the engine declined adult fiction; trying another engine authorised for it' };
  }
  return { next: true, reason: `${failure.replace(/_/g, ' ')}; trying the next compatible engine` };
}

/**
 * The Details record for one request: the original engine, every failure, every fallback attempt and the engine that
 * finally answered. `attempts` is a list of { model, failure, reason } in order. Nothing is invented: a fallback is listed
 * only if it was really attempted, and `final` is null when no engine completed the request.
 */
export function fallbackRecord({ original, attempts = [], final = null, tools = [], costs = [] } = {}) {
  return {
    original_model: original || null,
    attempts: attempts.map((a) => ({ model: a.model || null, failure: a.failure || FAILURES.NONE, reason: a.reason || '' })),
    final_model: final || null,
    tools_executed: tools.map((t) => ({ name: t.name, receipt: t.receipt || null })),
    costs: costs.map((c) => ({ engine: c.engine || null, usd: Number(c.usd) || 0 })),
    completed: Boolean(final),
    fallback_used: attempts.length > 1,
  };
}
