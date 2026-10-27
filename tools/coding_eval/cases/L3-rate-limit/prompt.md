Write `rate_limit.mjs`, an ES module with a named export class `TokenBucket`. It is a per-key token-bucket limiter. The caller passes the clock in, so the code must not call `Date.now()`.

- `constructor({ capacity, refillPerSecond })`: both must be positive finite numbers, otherwise throw `RangeError`.
- `take(key, now)`: `now` is milliseconds. Each key starts full.
  - First refill the bucket for the time since that key was last seen: `refillPerSecond` times the elapsed seconds, capped at `capacity`.
  - If at least one token is available, spend one and return `true`. Otherwise return `false` and spend nothing.
- Keys are independent.
- If `now` goes backwards, add no tokens (treat the elapsed time as 0). The last-seen time for the key stays at the latest time seen, not the earlier one.
- A `now` that is not a finite number throws `TypeError`.
