// CHE's words about a tool outcome. The verified facts (job id, HTTP status, the handler's own reason, what was charged)
// are copied in exactly as the handler recorded them. CHE's sentences are written around them here, in code, so no model
// can change a fact, and a simple status answer needs no model call at all.

/** The responder recorded in the reply's meta: this layer, not a model. */
export const COMPOSER = 'deterministic_composer';

/** Keeps the first copy of each sentence and drops any later repeat, so a closing line is never said twice. */
export function oncePerSentence(text) {
  const seen = new Set();
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      const key = s.toLowerCase().replace(/[.!?]+$/, '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ');
}

/**
 * The next useful step for a refused Modal picture, from the handler's facts only. It never retries on its own: a paid call
 * is only repeated when the owner asks again.
 */
export function nextStepForRefusal({ http_status, modal_reason }) {
  if (http_status === 422 && /width|height|size|\[256/i.test(modal_reason || '')) {
    return 'The next step is to ask again at a size Modal accepts (256 or 512 pixels). I will not repeat the paid call on my own.';
  }
  if (http_status === 422) {
    return 'The next step is to ask again with a simpler description, once you have read Modal\'s reason above. I will not repeat the paid call on my own.';
  }
  if (!http_status) {
    return 'Modal did not answer, so the call may or may not have started. Check Modal\'s job list before you ask again, so nothing is paid twice.';
  }
  return 'The next step is to check that Modal is connected and try once more when you ask. I will not repeat the paid call on my own.';
}

/** The sentences for a Modal picture that was started: the job id and what is still to come, never a claim of an image. */
export function startedPictureText({ call_id }) {
  return oncePerSentence(
    `I started the picture on Modal's GPU, sir (provider: Modal, job ${call_id}). It is not in your Gallery yet. Nothing is saved until Modal's result passes its checks.`,
  );
}

/**
 * The sentences for a Modal picture that was refused. `facts` is the handler's own record: http_status, modal_reason
 * (null when Modal gave none) and budget_state ('released' = nothing charged, 'reserved' = outcome unknown).
 */
export function refusedPictureText(facts) {
  const { http_status, modal_reason, budget_state } = facts;
  const answer = http_status
    ? `Modal answered HTTP ${http_status}${modal_reason ? ` and said: ${modal_reason}` : ' without a reason'}.`
    : 'Modal did not answer.';
  const charge = budget_state === 'released'
    ? 'nothing was charged'
    : 'the worst-case test reserve stays on the ledger until the outcome is known';
  return oncePerSentence([
    'I did not start a Modal GPU picture, sir.',
    answer,
    `Nothing was generated and ${charge}; no other engine was used.`,
    nextStepForRefusal(facts),
  ].join(' '));
}
