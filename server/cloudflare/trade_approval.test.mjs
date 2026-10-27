// Trade approval with mock broker responses only. No network, no broker, no storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_TTL_MS, buildProposal, modifyProposal, reviewProposal, approveProposal,
  recheckForSubmit, submitOnce, recordEvent, fingerprint, riskDollars,
} from './trade_approval.js';

const NOW = Date.parse('2026-10-26T15:00:00Z');
const setup = { account: 'SIM-1', symbol: 'MNQZ6', side: 'buy', qty: 1, entry: 20000, stop: 19990, target: 20020, point_value: 2, strategy: 'EMA 20 pullback' };
const freshData = { last_bar_ms: NOW - 10_000, delayed: false };
const brokerOk = { connected: true, trading_permitted: true, account_id: 'SIM-1', kind: 'mock' };
const acctOk = { funded: false, buying_power: 100_000, realized_today: 0, max_daily_loss: 500, open_positions: 0, max_open_positions: 2, open_symbols: [] };
const okCtx = { data: freshData, broker: brokerOk, account: acctOk };
const make = () => buildProposal(setup, { now: NOW, nonce: 'n1' });

test('a proposal shows the order, risk and a unique id', () => {
  const p = make();
  assert.equal(p.state, 'proposed');
  assert.match(p.order_id, /^CHE-[0-9a-f]{8}$/);
  assert.equal(riskDollars(p.order), 20, '10 points x $2 per point x 1 contract');
  assert.notEqual(buildProposal(setup, { now: NOW, nonce: 'n2' }).order_id, p.order_id, 'a different proposal gets a different id');
});

test('a clean proposal passes every check for paper and live', () => {
  const p = make();
  assert.deepEqual(reviewProposal(p, okCtx, { now: NOW, choice: 'paper' }), []);
  assert.deepEqual(reviewProposal(p, okCtx, { now: NOW, choice: 'live' }), []);
});

test('a delayed or stale price blocks a live order but not a paper test', () => {
  const p = make();
  const delayed = { ...okCtx, data: { last_bar_ms: NOW - 10_000, delayed: true } };
  assert.ok(reviewProposal(p, delayed, { now: NOW, choice: 'live' }).some((b) => /delayed/.test(b)));
  assert.deepEqual(reviewProposal(p, delayed, { now: NOW, choice: 'paper' }), []);
  const stale = { ...okCtx, data: { last_bar_ms: NOW - 120_000, delayed: false } };
  assert.ok(reviewProposal(p, stale, { now: NOW, choice: 'paper' }).some((b) => /not fresh/.test(b)));
});

test('each live account rule blocks the order with its own reason', () => {
  const p = make();
  const cases = [
    [{ broker: { ...brokerOk, connected: false } }, /broker is not connected/],
    [{ broker: { ...brokerOk, trading_permitted: false } }, /trading permission/],
    [{ account: { ...acctOk, buying_power: 100 } }, /buying power/],
    [{ account: { ...acctOk, realized_today: -600 } }, /daily loss/],
    [{ account: { ...acctOk, open_positions: 2 } }, /open-position/],
    [{ account: { ...acctOk, open_positions: 1, open_symbols: ['MNQZ6'] } }, /already open/],
    [{ broker: { ...brokerOk, account_id: 'OTHER' } }, /does not match/],
    [{ emergency: true }, /Emergency Stop/],
  ];
  for (const [patch, want] of cases) {
    const blockers = reviewProposal(p, { ...okCtx, ...patch }, { now: NOW, choice: 'live' });
    assert.ok(blockers.some((b) => want.test(b)), `${want} not in ${JSON.stringify(blockers)}`);
  }
});

test('a funded account is blocked until its firm rules are verified and fresh', () => {
  const p = make();
  const funded = { ...okCtx, account: { ...acctOk, funded: true } };
  assert.ok(reviewProposal(p, funded, { now: NOW, choice: 'live' }).some((b) => /not been verified/.test(b)));
  const old = { ...funded, firm_rules: { verified_at_ms: NOW - 25 * 3_600_000, source: 'firm page', max_contracts: 5 } };
  assert.ok(reviewProposal(p, old, { now: NOW, choice: 'live' }).some((b) => /24 hours/.test(b)));
  const capped = { ...funded, firm_rules: { verified_at_ms: NOW, source: 'firm page', max_contracts: 0 } };
  assert.ok(reviewProposal(p, capped, { now: NOW, choice: 'live' }).some((b) => /at most 0 contracts/.test(b)));
  const ok = { ...funded, firm_rules: { verified_at_ms: NOW, source: 'firm page', max_contracts: 5 } };
  assert.deepEqual(reviewProposal(p, ok, { now: NOW, choice: 'live' }), []);
});

test('changing the order clears the approval and changes the fingerprint', () => {
  const p = make();
  const ap = approveProposal(p, { choice: 'paper', confirmed_fingerprint: p.fingerprint, now: NOW }).proposal;
  const m = modifyProposal(ap, { qty: 2 }, { now: NOW });
  assert.notEqual(m.fingerprint, p.fingerprint);
  assert.deepEqual(m.approvals, []);
  assert.equal(m.state, 'proposed');
  assert.equal(fingerprint({ ...p.order, qty: 2 }), m.fingerprint);
});

test('a live approval needs the exact fingerprint and the destination account', () => {
  const p = make();
  assert.match(approveProposal(p, { choice: 'live', confirmed_fingerprint: 'deadbeef', confirmed_account: 'SIM-1', now: NOW }).error, /changed/);
  assert.match(approveProposal(p, { choice: 'live', confirmed_fingerprint: p.fingerprint, confirmed_account: 'OTHER', now: NOW }).error, /account/);
  const ok = approveProposal(p, { choice: 'live', confirmed_fingerprint: p.fingerprint, confirmed_account: 'SIM-1', now: NOW });
  assert.equal(ok.error, '');
  assert.deepEqual(ok.proposal.approvals.map((a) => a.leg), ['live']);
});

test('Paper + My Account needs two approvals, and paper does not stand in for live', () => {
  const p = make();
  const both = approveProposal(p, { choice: 'both', confirmed_fingerprint: p.fingerprint, confirmed_account: 'SIM-1', now: NOW }).proposal;
  assert.deepEqual(both.approvals.map((a) => a.leg).sort(), ['live', 'paper']);
  const paperOnly = approveProposal(p, { choice: 'paper', confirmed_fingerprint: p.fingerprint, now: NOW }).proposal;
  const check = recheckForSubmit(paperOnly, 'live', okCtx, { now: NOW });
  assert.equal(check.ok, false);
  assert.match(check.reason, /no live approval/);
});

test('an approval expires after two minutes', () => {
  const p = make();
  const ap = approveProposal(p, { choice: 'paper', confirmed_fingerprint: p.fingerprint, now: NOW }).proposal;
  const at = (ms) => ({ ...okCtx, data: { last_bar_ms: ms - 10_000, delayed: false } });
  assert.equal(recheckForSubmit(ap, 'paper', at(NOW + APPROVAL_TTL_MS - 1), { now: NOW + APPROVAL_TTL_MS - 1 }).ok, true);
  assert.match(recheckForSubmit(ap, 'paper', at(NOW + APPROVAL_TTL_MS + 1), { now: NOW + APPROVAL_TTL_MS + 1 }).reason, /expired/);
});

test('submission rechecks the risk and refuses to send past a new blocker', () => {
  const p = make();
  const ap = approveProposal(p, { choice: 'live', confirmed_fingerprint: p.fingerprint, confirmed_account: 'SIM-1', now: NOW }).proposal;
  const later = { ...okCtx, account: { ...acctOk, realized_today: -600 } };
  assert.match(recheckForSubmit(ap, 'live', later, { now: NOW }).reason, /daily loss/);
});

test('an order is sent once; a repeat with the same id is refused', async () => {
  const p = make();
  const ap = approveProposal(p, { choice: 'paper', confirmed_fingerprint: p.fingerprint, now: NOW }).proposal;
  const submitted = new Set();
  const calls = [];
  const submit = async (o) => { calls.push(o); return { ack_id: 'MOCK-1', status: 'acknowledged' }; };
  const first = await submitOnce(ap, 'paper', okCtx, { submitted, submit, now: NOW });
  const second = await submitOnce(ap, 'paper', okCtx, { submitted, submit, now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.ack_id, 'MOCK-1');
  assert.equal(second.ok, false);
  assert.match(second.reason, /duplicate refused/);
  assert.equal(calls.length, 1, 'the adapter was called once');
});

test('a broker error is reported as an error, not as a fill', async () => {
  const p = make();
  const ap = approveProposal(p, { choice: 'paper', confirmed_fingerprint: p.fingerprint, now: NOW }).proposal;
  const submit = async () => { throw new Error('rejected: insufficient margin'); };
  const result = await submitOnce(ap, 'paper', okCtx, { submitted: new Set(), submit, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.error, true);
  assert.match(result.reason, /insufficient margin/);
});

test('a simulated fill is labelled as simulated, never a broker fill', () => {
  const p = make();
  const sim = recordEvent(p, { state: 'filled', source: 'paper_engine', qty: 1, price: 20001 }, { now: NOW });
  assert.equal(sim.events.at(-1).label, 'simulated fill (not a broker fill)');
  const real = recordEvent(p, { state: 'filled', source: 'broker', qty: 1, price: 20001, ack_id: 'B-9' }, { now: NOW });
  assert.equal(real.events.at(-1).label, 'broker fill');
  assert.equal(real.state, 'filled');
});

test('partial fills, rejections and cancellations are recorded with their state', () => {
  const p = make();
  assert.equal(recordEvent(p, { state: 'partial', source: 'broker', qty: 1 }, { now: NOW }).state, 'partial');
  assert.equal(recordEvent(p, { state: 'rejected', source: 'broker', message: 'no margin' }, { now: NOW }).state, 'rejected');
  assert.equal(recordEvent(p, { state: 'cancelled', source: 'broker' }, { now: NOW }).state, 'cancelled');
  assert.equal(recordEvent(p, { state: 'unknown-state', source: 'broker' }, { now: NOW }).state, 'error');
});

test('a repeat of the same order within a minute is blocked by the journal', () => {
  const p = make();
  const journal = [{ fingerprint: p.fingerprint, state: 'acknowledged', at: new Date(NOW - 20_000).toISOString() }];
  assert.ok(reviewProposal(p, okCtx, { now: NOW, choice: 'paper', journal }).some((b) => /last minute/.test(b)));
});
