// Periodic production: a machine makes parts in batches, and pauses after every K parts. This module solves the time to
// reach an exact part count two independent ways (a step-by-step simulation and a closed-form formula) and reports them
// only when they agree. It never guesses: a goal missing any parameter returns null and goes to the model unanswered.
//
// Two assumptions give two different answers, so both are always reported:
//   batched     parts come out together at the end of each batch (3 parts every 4 seconds: parts 1-3 at 4 s, 4-6 at 8 s)
//   continuous  parts come out at a steady rate (3 parts per 4 seconds = 0.75 parts per second)
// Pauses apply in both models: a pause follows each completed multiple of K parts only while more parts are still needed.

const UNIT_MS = { second: 1000, seconds: 1000, sec: 1000, secs: 1000, s: 1000, minute: 60000, minutes: 60000, min: 60000, mins: 60000, hour: 3600000, hours: 3600000 };
const MAX_TARGET = 100000;

const toMs = (amount, unit) => {
  const ms = Number(amount) * (UNIT_MS[String(unit).toLowerCase()] ?? NaN);
  return Number.isFinite(ms) ? ms : NaN;
};

/**
 * Reads the parameters of a periodic-production problem from its text. Returns null unless all four are found:
 *   batch:   "N parts every T <unit>"          -> batchSize N, batchMs
 *   pause:   "after every K parts ... stops|pauses for P <unit>" -> pauseEvery K, pauseMs
 *   target:  "produce exactly M parts" (or "produce M parts")    -> target M
 * Quantities are read literally; nothing is inferred when a phrase is missing.
 */
export function parseProduction(text = '') {
  const s = String(text);
  const batch = /(\d+)\s+parts?\s+every\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|hours?)\b/i.exec(s);
  const pause = /after\s+every\s+(\d+)\s+parts?\b[^.?!]*?\b(?:stops?|pauses?|halts?)\b[^.?!]*?\bfor\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|hours?)\b/i.exec(s);
  const target = /\b(?:produce|make|build|manufacture|output)\s+(?:exactly\s+)?(\d+)\s+parts?\b/i.exec(s);
  if (!batch || !pause || !target) return null;
  const parsed = {
    batchSize: Number(batch[1]),
    batchMs: toMs(batch[2], batch[3]),
    pauseEvery: Number(pause[1]),
    pauseMs: toMs(pause[2], pause[3]),
    target: Number(target[1]),
    startingParts: 0,
    initialDelayMs: 0,
  };
  return validate(parsed) ? parsed : null;
}

/** Checks the parameters are positive whole counts and whole milliseconds, so the arithmetic is exact. */
function validate(p) {
  const wholeCount = (n) => Number.isInteger(n) && n >= 1;
  const wholeMs = (ms) => Number.isInteger(ms) && ms >= 1;
  return wholeCount(p.batchSize) && wholeCount(p.pauseEvery) && wholeCount(p.target) && p.target <= MAX_TARGET
    && wholeMs(p.batchMs) && wholeMs(p.pauseMs);
}

/**
 * Method 1, batched: walk the batches one at a time. A pause is added after each multiple of K that the production has
 * passed while still short of the target. Returns { ms, batches, pauses }.
 */
export function simulateBatched({ batchSize, batchMs, pauseEvery, pauseMs, target }) {
  let parts = 0;
  let ms = 0;
  let batches = 0;
  let pauses = 0;
  while (parts < target) {
    const before = parts;
    parts += batchSize;
    batches += 1;
    ms += batchMs;
    // Multiples of pauseEvery passed in this batch, counting only those below the target (a pause needs a later part).
    const passed = Math.floor(Math.min(parts, target - 1) / pauseEvery) - Math.floor(before / pauseEvery);
    if (passed > 0) {
      pauses += passed;
      ms += passed * pauseMs;
    }
  }
  return { ms, batches, pauses };
}

/** Method 2, closed form for the batched model: ceil(target / batch) batches, and one pause per multiple of K below target. */
export function closedFormBatched({ batchSize, batchMs, pauseEvery, pauseMs, target }) {
  const batches = Math.ceil(target / batchSize);
  const pauses = Math.floor((target - 1) / pauseEvery);
  return { ms: batches * batchMs + pauses * pauseMs, batches, pauses };
}

/**
 * The continuous model, exact as a fraction of seconds: the target at batchSize parts per batchMs, plus the same pauses.
 * Returns { numerator, denominator } in seconds, reduced.
 */
export function continuousSeconds({ batchSize, batchMs, pauseEvery, pauseMs, target }) {
  const pauses = Math.floor((target - 1) / pauseEvery);
  // seconds = target*batchMs/(batchSize*1000) + pauses*pauseMs/1000; over the common denominator batchSize*1000
  const numerator = BigInt(target) * BigInt(batchMs) + BigInt(pauses) * BigInt(pauseMs) * BigInt(batchSize);
  const denominator = BigInt(batchSize) * 1000n;
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));

const secondsText = (ms) => (ms / 1000).toString();

/**
 * Solves the problem. Returns null if the text is not a periodic-production problem. Otherwise returns:
 *   status      'verified' when both methods agree on the batched time, else 'disagrees'
 *   batched     { seconds, batches, pauses, methods_agree }
 *   continuous  { numerator, denominator, seconds (2 decimals) }
 *   ambiguity   the explicit statement of the assumption each answer depends on
 */
export function solveProduction(text) {
  const p = parseProduction(text);
  if (!p) return null;
  const sim = simulateBatched(p);
  const closed = closedFormBatched(p);
  const methodsAgree = sim.ms === closed.ms && sim.batches === closed.batches && sim.pauses === closed.pauses;
  const cont = continuousSeconds(p);
  const contSeconds = (Number(cont.numerator) / Number(cont.denominator)).toFixed(2);
  return {
    status: methodsAgree ? 'verified' : 'disagrees',
    parameters: p,
    batched: { seconds: secondsText(sim.ms), batches: sim.batches, pauses: sim.pauses, methods_agree: methodsAgree },
    continuous: { numerator: cont.numerator.toString(), denominator: cont.denominator.toString(), seconds: contSeconds },
    ambiguity: `The answer depends on whether parts come out in batches of ${p.batchSize} at the end of each ${p.batchMs / 1000}-second batch (batched: ${secondsText(sim.ms)} seconds) or at a steady rate (continuous: ${contSeconds} seconds). Both include the ${p.pauseMs / 1000}-second pause after every ${p.pauseEvery} parts, and the count starts at zero with no initial delay.`,
  };
}
