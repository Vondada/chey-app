// Receipts at action sites: a verified MP4, a failed render, the phone's install report, and the orders
// CHE actually sent. Each one is written only by execution code and read back without a model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { placedOrders, placedOrdersLine, recordDeviceInstall, recordVideoFailed, recordVideoVerified } from './action_receipts.js';
import { auditEvidenceFrom, auditReply } from './hallucination_auditor.js';
import { liveIntent } from './trading_live_chat.js';
import { RECEIPTS_KEY } from './truth_layer.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const memStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return { get: async (k) => data.get(k), put: async (k, v) => { data.set(k, v); }, data };
};
const at = (msAgo = 60_000) => new Date(NOW - msAgo).toISOString();

test('a verified MP4 receipt makes "the video is ready" pass; a failed one makes it CONTRADICTED; a bare render does not', async () => {
  const storage = memStorage({ [RECEIPTS_KEY]: [{ kind: 'video_render', key: 'video_render:gha_1', task_id: 'gha_1', status: 'queued', at: at() }] });
  let evidence = await auditEvidenceFrom(storage, { now: NOW });
  assert.equal(auditReply('The video is ready.', { evidence, now: NOW }).outcome, 'blocked', 'queued render is not a file');

  await recordVideoVerified(storage, { task_id: 'gha_1', media_id: 'm1', bytes: 430610, seconds: 30, width: 1280, height: 720, source: 'github-actions' });
  storage.data.get(RECEIPTS_KEY).forEach((r) => { r.at = at(); });
  evidence = await auditEvidenceFrom(storage, { now: NOW });
  assert.deepEqual(evidence.videos, [{ id: 'video:gha_1', status: 'complete', mp4_verified: true, playable: true }]);
  assert.equal(auditReply('I created the video.', { evidence, now: NOW }).outcome, 'pass');

  const failed = memStorage({ [RECEIPTS_KEY]: [{ kind: 'video_render', key: 'video_render:gha_2', task_id: 'gha_2', status: 'queued', at: at() }] });
  await recordVideoFailed(failed, { task_id: 'gha_2', error: 'no MP4 header' });
  failed.data.get(RECEIPTS_KEY).forEach((r) => { r.at = at(); });
  const out = auditReply('The video is ready.', { evidence: await auditEvidenceFrom(failed, { now: NOW }), now: NOW });
  assert.equal(out.claims[0].label, 'CONTRADICTED');
});

test('a verified receipt needs an id and never stores more than facts', async () => {
  const storage = memStorage();
  assert.equal(await recordVideoVerified(storage, {}), null);
  const r = await recordVideoVerified(storage, { task_id: 'f1', seconds: 12.5, source: 'film_studio' });
  assert.equal(r.kind, 'video_verified');
  assert.equal(r.mp4_verified, true);
  assert.equal(r.key, 'video_verified:f1');
});

test('the phone\'s install report becomes the only install evidence; junk fields are refused', async () => {
  const storage = memStorage();
  assert.equal(await recordDeviceInstall(storage, { version: '', build: '1' }), null);
  assert.equal(await recordDeviceInstall(storage, { version: '1.4.1', build: '12 drop table' }), null);
  const r = await recordDeviceInstall(storage, { version: '1.4.1025342820', build: '3956317271501', patch: '7' });
  assert.equal(r.key, 'device_install:1.4.1025342820-3956317271501-7');
  storage.data.get(RECEIPTS_KEY).forEach((x) => { x.at = at(); });
  const evidence = await auditEvidenceFrom(storage, { now: NOW });
  assert.deepEqual(evidence.device_installs, [{ id: 'install:1.4.1025342820-3956317271501-7', confirmed: true }]);
  assert.equal(auditReply('The update is installed on your iPhone.', { evidence, now: NOW }).outcome, 'pass');
  assert.equal(auditReply('The update is installed on your iPhone.', { evidence: await auditEvidenceFrom(memStorage(), { now: NOW }), now: NOW }).outcome, 'blocked');
});

test('orders CHE sent are read from receipts: none is an honest none; both brokers are counted with their ids', async () => {
  assert.match(await placedOrdersLine(memStorage(), { now: NOW }), /none\. No broker or paper order receipt exists/);
  const storage = memStorage({ [RECEIPTS_KEY]: [
    { kind: 'paper_order_placed', key: 'alpaca_paper:o1', order_id: 'o1abcdefgh', account: 'paper', symbol: 'AAPL', side: 'buy', qty: 1, at: at(3600_000) },
    { kind: 'paper_order_placed', key: 'alpaca_paper:o2', order_id: 'o2abcdefgh', account: 'paper', symbol: 'MSFT', side: 'sell', qty: 2, at: at() },
    { kind: 'trade_placed', key: 'trade_placed:t9', order_id: 't9', account: 'SIM123', account_mode: 'sim', at: at() },
    { kind: 'trade_placed', key: 'trade_placed:old', order_id: 'old', account_mode: 'sim', at: at(8 * 24 * 3600_000) },
  ] });
  const { total } = await placedOrders(storage, { now: NOW });
  assert.equal(total, 3, 'the eight-day-old order is outside the window');
  const line = await placedOrdersLine(storage, { now: NOW });
  assert.match(line, /2 on Alpaca PAPER \(last: sell 2 MSFT, order o2abcdef\)/);
  assert.match(line, /1 to Tradovate sim \(last order t9\)/);
  const evidence = await auditEvidenceFrom(storage, { now: NOW });
  assert.equal(evidence.trades.length, 3);
  assert.equal(auditReply('I placed an order on AAPL.', { evidence, now: NOW }).outcome, 'pass');
  const noIds = memStorage({ [RECEIPTS_KEY]: [{ kind: 'trade_placed', key: 'trade_placed:1', detail: 'Placed …', at: at() }] });
  assert.equal(auditReply('I placed an order on AAPL.', { evidence: await auditEvidenceFrom(noIds, { now: NOW }), now: NOW }).outcome, 'blocked', 'a receipt without a broker id is not proof');
});

test('the owner\'s trade questions reach the Trading Room read, not the model', () => {
  for (const q of ['What trades did you execute?', 'Did you place any trades today?', 'what did you trade today', 'What trades have you made this week?', 'have you taken any MNQ trades']) {
    const intent = liveIntent(q);
    assert.ok(intent && (intent.kinds || [intent.kind]).includes('trades'), q);
  }
  assert.equal(liveIntent('Place a trade on MNQ now'), null, 'an order is never a read');
  assert.equal(liveIntent('What trades should I make?'), null);
});

test('team tasks prove "finished" only when complete and verified', async () => {
  const evidence = await auditEvidenceFrom(memStorage(), { now: NOW, teamTasks: [{ id: 'a', status: 'complete', verified: true }, { id: 'b', status: 'complete' }, { id: 'c', status: 'running', verified: true }] });
  assert.deepEqual(evidence.tasks.map((t) => [t.id, t.verified]), [['a', true], ['b', false], ['c', true]]);
  assert.equal(auditReply('Atlas has completed the research task.', { evidence, now: NOW }).outcome, 'pass');
  const unverified = await auditEvidenceFrom(memStorage(), { now: NOW, teamTasks: [{ id: 'b', status: 'complete' }] });
  assert.equal(auditReply('Atlas has completed the research task.', { evidence: unverified, now: NOW }).outcome, 'blocked');
});
