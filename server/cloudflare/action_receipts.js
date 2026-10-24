// Receipts written where an action really finishes, so the hallucination auditor and CHE's own
// answers can say "yes" from a record instead of failing closed. Nothing here calls a model.
//
//  - video_verified / video_failed: a rendered MP4 passed (or failed) its real file check.
//  - device_install: the paired phone reported the build it is running (POST /api/device/installed).
//  - placed orders: the paper_order_placed (Alpaca PAPER) and trade_placed (Tradovate sim/live) receipts,
//    read back for "what trades did you execute?". Reading them never places anything.
import { loadReceipts, recordReceipt } from './truth_layer.js';

const WEEK_MS = 7 * 24 * 3600_000;

/** A finished MP4 that passed its header, size and duration checks. Only call after the real check. */
export async function recordVideoVerified(storage, { task_id = '', media_id = '', bytes = 0, seconds = 0, width = 0, height = 0, source = '' } = {}) {
  const id = String(task_id || media_id || '');
  if (!id) return null;
  return recordReceipt(storage, {
    kind: 'video_verified', key: `video_verified:${id}`, task_id: String(task_id || ''), media_id: String(media_id || ''),
    status: 'complete', mp4_verified: true, playable: true,
    bytes: Number(bytes) || 0, seconds: Number(seconds) || 0, width: Number(width) || 0, height: Number(height) || 0, source: String(source || '').slice(0, 40),
  }).catch(() => null);
}

/** A render that ended without a verified file. The error is clipped; no reply text is stored. */
export async function recordVideoFailed(storage, { task_id = '', error = '', source = '' } = {}) {
  const id = String(task_id || '');
  if (!id) return null;
  return recordReceipt(storage, { kind: 'video_failed', key: `video_failed:${id}`, task_id: id, status: 'failed', error: String(error || '').slice(0, 200), source: String(source || '').slice(0, 40) }).catch(() => null);
}

const BUILD_FIELD = /^[\w.+-]{1,40}$/;
/** The phone's own report of what it runs. Returns the receipt, or null when the fields are not a build. */
export async function recordDeviceInstall(storage, { version = '', build = '', patch = '' } = {}) {
  const v = String(version || '').trim(); const b = String(build || '').trim(); const p = String(patch || '').trim();
  if (!BUILD_FIELD.test(v) || !BUILD_FIELD.test(b) || (p && !BUILD_FIELD.test(p))) return null;
  return recordReceipt(storage, { kind: 'device_install', key: `device_install:${v}-${b}-${p || 'none'}`, version: v, build: b, patch: p, confirmed: true });
}

/** Orders CHE actually sent, from receipts only. */
export async function placedOrders(storage, { now = Date.now(), sinceMs = WEEK_MS } = {}) {
  const receipts = await loadReceipts(storage, { sinceMs, now });
  const alpaca = receipts.filter((r) => r.kind === 'paper_order_placed');
  const tradovate = receipts.filter((r) => r.kind === 'trade_placed');
  return { alpaca, tradovate, total: alpaca.length + tradovate.length };
}

const orderLine = (r) => [r.side, r.qty, r.symbol].filter(Boolean).join(' ') || 'order';
/** One spoken sentence about sent orders, for the Trading Room's "trades" read. Honest "none" when none. */
export async function placedOrdersLine(storage, { now = Date.now() } = {}) {
  const { alpaca, tradovate, total } = await placedOrders(storage, { now });
  if (!total) return 'Orders I actually sent in the last 7 days: none. No broker or paper order receipt exists.';
  const parts = [];
  if (alpaca.length) { const last = alpaca.at(-1); parts.push(`${alpaca.length} on Alpaca PAPER (last: ${orderLine(last)}${last.order_id ? `, order ${String(last.order_id).slice(0, 8)}` : ''})`); }
  if (tradovate.length) { const last = tradovate.at(-1); parts.push(`${tradovate.length} to Tradovate ${last.account_mode === 'live' ? 'LIVE' : 'sim'}${last.order_id ? ` (last order ${String(last.order_id).slice(0, 12)})` : ''}`); }
  return `Orders I actually sent in the last 7 days, from receipts: ${parts.join('; ')}.`;
}
