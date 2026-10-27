// CHE's own forward-recorded Rithmic dataset (owner research-partner rule, 2026-10-23).
//
// The iPhone holds the Rithmic session (its password never leaves the phone) and builds 1-minute candles from real
// Rithmic trades (lib/rithmic/rithmic_candles.dart). It sends each CLOSED candle here; this file checks and stores
// them as source=rithmic, recorded by the owner's iPhone. Over time this is CHE's own verified MNQ minute data.
//
// - A candle is accepted only when it is self-consistent (low <= open/close <= high, whole minute, not in the
//   future, non-negative volume). Nothing is filled in: a minute the phone did not record stays missing, and the
//   read says how many minutes are missing.
// - The first stored version of a minute wins: closed candles are final, a different resend is counted as a
//   conflict, never overwritten.
// - Kept: the last KEEP_DAYS days per contract, in hour records of at most 60 candles. Older hours are dropped when
//   new data arrives, so storage stays bounded.

export const RITHMIC_SOURCE = 'rithmic';
export const KEEP_DAYS = 120;
const PREFIX = 'rithmic_1m:';
const INDEX = 'rithmic_1m_index:';
const MAX_BATCH = 500;
const SYMBOL = /^[A-Z]{1,4}[FGHJKMNQUVXZ]\d{1,2}$/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** Why one candle is refused, or '' when it is acceptable. */
export function candleProblem(c, now = Date.now()) {
  if (!c || typeof c !== 'object') return 'not a candle';
  if (c.source !== RITHMIC_SOURCE) return 'source must be rithmic';
  if (!SYMBOL.test(String(c.symbol || ''))) return 'symbol must be a futures contract such as MNQZ6';
  const t = Date.parse(c.t);
  if (!Number.isFinite(t) || t % 60000 !== 0) return 'time must be a whole UTC minute';
  if (t + 60000 > now + 5000) return 'a candle is sent only after its minute has closed';
  const [o, h, l, cl] = [num(c.o), num(c.h), num(c.l), num(c.c)];
  if ([o, h, l, cl].some((v) => v == null || v <= 0)) return 'open, high, low and close must be positive numbers';
  if (l > Math.min(o, cl) || h < Math.max(o, cl) || l > h) return 'high and low must contain open and close';
  if (int(c.v) == null || int(c.trades) == null || c.trades < 1) return 'volume and trade count must be whole numbers, at least one trade';
  if (int(c.buy_volume ?? 0) == null || int(c.sell_volume ?? 0) == null) return 'aggressor volumes must be whole numbers';
  if (c.delta != null && (!Number.isInteger(c.delta) || c.delta !== (c.buy_volume ?? 0) - (c.sell_volume ?? 0))) return 'delta must equal buy minus sell volume';
  return '';
}

const hourOf = (iso) => iso.slice(0, 13); // 2026-10-23T14

function clean(c, receivedAt) {
  return {
    t: new Date(Date.parse(c.t)).toISOString(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, trades: c.trades,
    buy_volume: c.buy_volume ?? 0, sell_volume: c.sell_volume ?? 0, delta: c.delta ?? null,
    exchange: String(c.exchange || 'CME').slice(0, 8), source: RITHMIC_SOURCE, recorded_by: 'owner iPhone', received_at: receivedAt,
  };
}

/** Stores a batch of closed candles from the owner's iPhone. */
export async function storeRithmicCandles(storage, candles, { now = Date.now() } = {}) {
  if (!Array.isArray(candles)) return { ok: false, error: 'candles must be a list' };
  if (candles.length > MAX_BATCH) return { ok: false, error: `at most ${MAX_BATCH} candles per request` };
  const receivedAt = new Date(now).toISOString();
  const refused = [];
  const byKey = new Map();
  for (const [i, c] of candles.entries()) {
    const problem = candleProblem(c, now);
    if (problem) { refused.push({ index: i, problem }); continue; }
    const row = clean(c, receivedAt);
    const key = `${PREFIX}${c.symbol}:${hourOf(row.t)}`;
    if (!byKey.has(key)) byKey.set(key, { symbol: c.symbol, rows: [] });
    byKey.get(key).rows.push(row);
  }
  let stored = 0, duplicates = 0, conflicts = 0;
  const touched = new Map();
  for (const [key, { symbol, rows }] of byKey) {
    const hour = (await storage.get(key)) || { symbol, candles: {} };
    for (const row of rows) {
      const minute = row.t.slice(14, 16);
      const had = hour.candles[minute];
      if (!had) { hour.candles[minute] = row; stored++; continue; }
      const same = ['o', 'h', 'l', 'c', 'v'].every((k) => had[k] === row[k]);
      if (same) duplicates++; else conflicts++;
    }
    await storage.put(key, hour);
    if (!touched.has(symbol)) touched.set(symbol, new Set());
    touched.get(symbol).add(key.slice(PREFIX.length + symbol.length + 1));
  }
  const cutoff = new Date(now - KEEP_DAYS * 86400000).toISOString().slice(0, 13);
  for (const [symbol, hours] of touched) {
    const index = new Set((await storage.get(`${INDEX}${symbol}`)) || []);
    for (const h of hours) index.add(h);
    const keep = [...index].sort();
    const old = keep.filter((h) => h < cutoff);
    for (const h of old) await storage.delete(`${PREFIX}${symbol}:${h}`);
    await storage.put(`${INDEX}${symbol}`, keep.filter((h) => h >= cutoff));
  }
  return { ok: true, source: RITHMIC_SOURCE, stored, duplicates, conflicts, refused: refused.length, refusals: refused.slice(0, 20), kept_days: KEEP_DAYS };
}

/** The recorded candles for one contract between two times, with real coverage: nothing is filled in. */
export async function readRithmicCandles(storage, { symbol, from = null, to = null, now = Date.now() } = {}) {
  if (!SYMBOL.test(String(symbol || ''))) return { ok: false, error: 'symbol must be a futures contract such as MNQZ6' };
  const hours = (await storage.get(`${INDEX}${symbol}`)) || [];
  const end = to ? Date.parse(to) : now;
  const start = from ? Date.parse(from) : end - 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { ok: false, error: 'from and to must be times, from before to' };
  const wanted = hours.filter((h) => h >= new Date(start).toISOString().slice(0, 13) && h <= new Date(end).toISOString().slice(0, 13));
  const got = wanted.length ? await storage.get(wanted.map((h) => `${PREFIX}${symbol}:${h}`)) : new Map();
  const candles = [];
  for (const h of wanted) {
    const hour = got.get(`${PREFIX}${symbol}:${h}`);
    for (const row of Object.values(hour?.candles || {})) {
      const t = Date.parse(row.t);
      if (t >= start && t <= end) candles.push(row);
    }
  }
  candles.sort((a, b) => a.t.localeCompare(b.t));
  const first = candles[0]?.t || null, last = candles.at(-1)?.t || null;
  const span = first ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) + 1 : 0;
  return {
    ok: true, symbol, source: RITHMIC_SOURCE, recorded_by: 'owner iPhone', timeframe: '1m', candles,
    coverage: { first, last, minutes_recorded: candles.length, minutes_in_span: span, minutes_missing: span - candles.length,
      note: 'Minutes are missing when the phone did not record them (CHE in the background, the feed down, or no trades). They are never filled in.' },
    kept_days: KEEP_DAYS, hours_recorded: hours.length,
  };
}
