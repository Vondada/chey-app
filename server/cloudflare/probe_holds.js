// Held requests ("Before I delete or remove anything, I need your yes") are kept apart for certification probe turns.
// A probe turn runs as the owner on his own Durable Object, so a request it held used to sit in the owner's own pending
// key: the owner's next "yes" then replayed the probe's text as an owner turn (Codex review on #887: a probe "take milk
// off my shopping list" deleted milk from the owner's real list), and a probe "yes" could release a request the owner
// held. Two layers keep them apart:
//  - The guarantee: every hold a probe turn writes is stamped `probe_context: true`, and a read of a hold key returns
//    only a hold of the reading turn's own context (unstamped = the owner's). This is done once, where every hold is read
//    and written: the Durable Object's storage get and put (guardHolds, installed when the object starts). The context is
//    the probe turn's own async context (AsyncLocalStorage), so it holds even when an owner turn runs while a probe turn
//    waits on the network: the owner's "yes" finds nothing of the probe's to release, and the reverse.
//  - Tidiness: for each probe turn the pending keys are swapped, so a probe hold never overwrites the owner's and is kept
//    under its own key between probe turns.
// Nothing here calls a model or the network.
import { AsyncLocalStorage } from 'node:async_hooks';
import { PENDING_GOOGLE_ACTION_KEY } from './google_services.js';
import { PENDING_APP_ACTION_KEY, PENDING_OWNER_ACTION_KEY, isOwnerYes } from './owner_action_gate.js';
import { PENDING_KEY as PENDING_PRIVACY_KEY } from './privacy_mode.js';

// Every key that holds a request for the owner's yes. 'pending_self_update' is worker.js's PENDING_SELF_UPDATE_KEY.
export const HOLD_KEYS = [PENDING_OWNER_ACTION_KEY, PENDING_APP_ACTION_KEY, PENDING_GOOGLE_ACTION_KEY, PENDING_PRIVACY_KEY, 'pending_self_update'];
export const PROBE_HOLD_PREFIX = 'probe_hold:';
const HOLD = new Set(HOLD_KEYS);
const TURN = new AsyncLocalStorage();

/** Whether the running code belongs to a certification probe turn. */
export const inProbeTurn = () => TURN.getStore() === true;
const probeHold = (value) => Boolean(value && typeof value === 'object' && value.probe_context === true);
const visible = (value) => value === undefined || value === null || probeHold(value) === inProbeTurn();
const stamp = (key, value) => (HOLD.has(key) && inProbeTurn() && value && typeof value === 'object' && !Array.isArray(value) ? { ...value, probe_context: true } : value);

/**
 * Wraps the storage's get and put once, for the hold keys only: a put in a probe turn stamps the hold, and a get returns
 * a hold only to a turn of the same context (anything else reads as no hold). Every other key passes through unchanged.
 * Never throws: a storage without these methods is left as it is.
 */
export function guardHolds(storage) {
  try {
    if (!storage || typeof storage.get !== 'function' || typeof storage.put !== 'function' || storage.__holdGuard) return storage;
    const rawGet = storage.get.bind(storage);
    const rawPut = storage.put.bind(storage);
    Object.defineProperty(storage, '__holdGuard', { value: { rawGet, rawPut } });
    storage.get = async function guardedGet(key, ...rest) {
      const value = await rawGet(key, ...rest);
      if (Array.isArray(key) && value instanceof Map) {
        for (const k of key) if (HOLD.has(k) && !visible(value.get(k))) value.delete(k);
        return value;
      }
      return typeof key === 'string' && HOLD.has(key) && !visible(value) ? undefined : value;
    };
    storage.put = function guardedPut(key, value, ...rest) {
      if (key && typeof key === 'object') return rawPut(Object.fromEntries(Object.entries(key).map(([k, v]) => [k, stamp(k, v)])), value, ...rest);
      return rawPut(key, stamp(key, value), ...rest);
    };
  } catch (_) { /* a storage whose methods cannot be wrapped keeps the swap below */ }
  return storage;
}

/**
 * Runs one probe chat turn in the probe context, with the probe's own held requests in place of the owner's, reading the
 * whole reply inside it (a streamed turn may still be running when its response returns). Returns [response, raw text].
 * The probe's holds are put in place only when its message is a plain yes, the one turn that can release them (any other
 * turn drops a hold anyway).
 */
export async function probeHolds(storage, run, message = '') {
  guardHolds(storage);
  const get = storage.__holdGuard?.rawGet || storage.get.bind(storage);
  const put = storage.__holdGuard?.rawPut || storage.put.bind(storage);
  const yes = isOwnerYes(message);
  const owner = {};
  for (const key of HOLD_KEYS) {
    const held = (await get(key)) ?? null;
    // A probe hold left in the owner's key (a turn cut off before it could tidy up) goes back to the probe's key.
    if (probeHold(held)) await put(PROBE_HOLD_PREFIX + key, held);
    owner[key] = probeHold(held) ? null : held;
    await put(key, yes ? (await get(PROBE_HOLD_PREFIX + key)) ?? null : null);
  }
  try {
    return await TURN.run(true, async () => {
      const response = await run();
      return [response, await response.text().catch(() => '')];
    });
  } finally {
    for (const key of HOLD_KEYS) {
      const now = (await get(key)) ?? null;
      await put(PROBE_HOLD_PREFIX + key, probeHold(now) ? now : null);
      // An owner hold written while the probe turn ran is newer than the one set aside, so it stays.
      await put(key, now && !probeHold(now) ? now : owner[key]);
    }
  }
}
