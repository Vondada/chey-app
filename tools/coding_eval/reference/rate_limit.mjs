export class TokenBucket {
  #capacity;
  #refillPerSecond;
  #state = new Map();

  constructor({ capacity, refillPerSecond } = {}) {
    if (!(Number.isFinite(capacity) && capacity > 0)) throw new RangeError('capacity must be a positive number');
    if (!(Number.isFinite(refillPerSecond) && refillPerSecond > 0)) throw new RangeError('refillPerSecond must be a positive number');
    this.#capacity = capacity;
    this.#refillPerSecond = refillPerSecond;
  }

  take(key, now) {
    if (!Number.isFinite(now)) throw new TypeError('now must be a finite number of milliseconds');
    const state = this.#state.get(key) || { tokens: this.#capacity, last: now };
    const elapsedSeconds = Math.max(0, now - state.last) / 1000;
    const tokens = Math.min(this.#capacity, state.tokens + elapsedSeconds * this.#refillPerSecond);
    state.last = Math.max(state.last, now);
    state.tokens = tokens;
    this.#state.set(key, state);
    if (tokens >= 1) {
      state.tokens = tokens - 1;
      return true;
    }
    return false;
  }
}
