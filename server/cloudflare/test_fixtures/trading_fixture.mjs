// TEST FIXTURE, NOT MARKET DATA. A seeded random walk with regime changes, on CME hours (Sunday 18:00 to Friday 17:00
// New York, daily break 17:00–18:00, holidays closed), so the timeframe engine, sessions and strategies can be tested
// deterministically. Results from it prove the machinery only; they say nothing about NQ or MNQ.
import { cmeOpen } from '../trading_research.js';

export function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** 15-second (or any) bars from `start` for `days` calendar days, only while CME is open. */
export function fixtureBars({ start = '2024-03-03T23:00:00Z', days = 5, stepMs = 15_000, seed = 42, price = 18000 } = {}) {
  const rand = seeded(seed);
  const out = [];
  let p = price; let drift = 0; let vol = 1.2;
  const t0 = Date.parse(start);
  for (let t = t0; t < t0 + days * 86_400_000; t += stepMs) {
    if (!cmeOpen(t)) continue;
    if (rand() < 0.002) drift = (rand() - 0.5) * 0.6;          // regime change
    if (rand() < 0.002) vol = 0.6 + rand() * 1.8;
    const o = p;
    const steps = Math.max(1, Math.round(stepMs / 15_000));
    let h = o; let l = o;
    for (let k = 0; k < steps; k++) {
      p = Math.max(1000, p + drift + (rand() - 0.5) * 2 * vol);
      h = Math.max(h, p); l = Math.min(l, p);
    }
    const q = (x) => Math.round(x * 4) / 4;
    const bar = { t: new Date(t).toISOString(), o: q(o), h: q(h), l: q(l), c: q(p), v: 10 + Math.floor(rand() * 90) };
    bar.h = Math.max(bar.h, bar.o, bar.c); bar.l = Math.min(bar.l, bar.o, bar.c);
    out.push(bar);
  }
  return out;
}

/** Daily bars (one per weekday) for long-history tests. */
export function fixtureDaily({ from = '2004-01-05', years = 20, seed = 9, price = 1500 } = {}) {
  const rand = seeded(seed);
  const out = [];
  let p = price; let drift = 0.3;
  const t0 = Date.parse(`${from}T00:00:00Z`);
  for (let d = 0; d < years * 365.25; d++) {
    const t = t0 + d * 86_400_000;
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (rand() < 0.01) drift = (rand() - 0.45) * 8;
    const o = p; p = Math.max(100, p + drift + (rand() - 0.5) * 40);
    const h = Math.max(o, p) + rand() * 15; const l = Math.min(o, p) - rand() * 15;
    const q = (x) => Math.round(x * 4) / 4;
    out.push({ t: new Date(t).toISOString(), o: q(o), h: q(h), l: q(l), c: q(p), v: 1000 });
  }
  return out;
}
