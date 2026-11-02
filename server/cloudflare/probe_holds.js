// Held requests ("Before I delete or remove anything, I need your yes") are kept apart for certification probe turns.
// A probe turn runs as the owner on his own Durable Object, so a request it held used to sit in the owner's own pending
// key: the owner's next "yes" then replayed the probe's text as an owner turn (Codex review on #887: a probe "take milk
// off my shopping list" deleted milk from the owner's real list), and a probe "yes" could release a request the owner
// held.
//
// Every hold is read and written through the Durable Object's storage, so the separation is done there, once
// (guardHolds, installed when the object starts), for the hold keys only:
//  - In a probe turn each hold key is read, written and deleted under its own probe key (`probe_hold:<key>`). Owner turns
//    use the plain key. A probe turn never reads, moves or restores an owner hold, and an owner turn never sees a probe
//    hold. The turn's context is its own async context (AsyncLocalStorage), so this holds even when an owner turn runs
//    while a probe turn waits on the network.
//  - Defence in depth: a hold written in a probe turn is stamped `probe_context: true`, and a hold whose stamp does not
//    match the reading turn's context reads as no hold (an older probe hold left in an owner key is never released).
// Nothing here calls a model or the network.
import { AsyncLocalStorage } from 'node:async_hooks';
import { PENDING_GOOGLE_ACTION_KEY } from './google_services.js';
import { PENDING_APP_ACTION_KEY, PENDING_OWNER_ACTION_KEY } from './owner_action_gate.js';
import { PENDING_KEY as PENDING_PRIVACY_KEY } from './privacy_mode.js';

// Every key that holds a request for the owner's yes. 'pending_self_update' is worker.js's PENDING_SELF_UPDATE_KEY.
export const HOLD_KEYS = [PENDING_OWNER_ACTION_KEY, PENDING_APP_ACTION_KEY, PENDING_GOOGLE_ACTION_KEY, PENDING_PRIVACY_KEY, 'pending_self_update'];
export const PROBE_HOLD_PREFIX = 'probe_hold:';
const HOLD = new Set(HOLD_KEYS);
const TURN = new AsyncLocalStorage();

/** Whether the running code belongs to a certification probe turn. */
export const inProbeTurn = () => TURN.getStore() === true;
/** The storage key a hold key means in the running turn's context; every other key is itself. */
export const holdKey = (key) => (typeof key === 'string' && HOLD.has(key) && inProbeTurn() ? PROBE_HOLD_PREFIX + key : key);
const probeHold = (value) => Boolean(value && typeof value === 'object' && value.probe_context === true);
const visible = (value) => value === undefined || value === null || probeHold(value) === inProbeTurn();
const stamp = (key, value) => (HOLD.has(key) && inProbeTurn() && value && typeof value === 'object' && !Array.isArray(value) ? { ...value, probe_context: true } : value);

/**
 * Wraps the storage's get, put and delete once, for the hold keys only (see above). Every other key passes through
 * unchanged. Never throws: a storage whose methods cannot be wrapped is left as it is.
 */
export function guardHolds(storage) {
  try {
    if (!storage || typeof storage.get !== 'function' || typeof storage.put !== 'function' || storage.__holdGuard) return storage;
    const rawGet = storage.get.bind(storage);
    const rawPut = storage.put.bind(storage);
    const rawDelete = typeof storage.delete === 'function' ? storage.delete.bind(storage) : null;
    Object.defineProperty(storage, '__holdGuard', { value: { rawGet, rawPut, rawDelete } });
    storage.get = async function guardedGet(key, ...rest) {
      if (Array.isArray(key)) {
        const found = await rawGet(key.map(holdKey), ...rest);
        if (!(found instanceof Map)) return found;
        const out = new Map();
        for (const k of key) if (found.has(holdKey(k)) && (!HOLD.has(k) || visible(found.get(holdKey(k))))) out.set(k, found.get(holdKey(k)));
        return out;
      }
      const value = await rawGet(holdKey(key), ...rest);
      return typeof key === 'string' && HOLD.has(key) && !visible(value) ? undefined : value;
    };
    storage.put = function guardedPut(key, value, ...rest) {
      if (key && typeof key === 'object') return rawPut(Object.fromEntries(Object.entries(key).map(([k, v]) => [holdKey(k), stamp(k, v)])), value, ...rest);
      return rawPut(holdKey(key), stamp(key, value), ...rest);
    };
    if (rawDelete) storage.delete = function guardedDelete(key, ...rest) { return rawDelete(Array.isArray(key) ? key.map(holdKey) : holdKey(key), ...rest); };
  } catch (_) { /* a storage whose methods cannot be wrapped */ }
  return storage;
}

/**
 * Runs one probe chat turn in the probe context, reading the whole reply inside it (a streamed turn may still be running
 * when its response returns). Returns [response, raw reply text].
 */
export async function probeHolds(run) {
  return TURN.run(true, async () => {
    const response = await run();
    return [response, await response.text().catch(() => '')];
  });
}
