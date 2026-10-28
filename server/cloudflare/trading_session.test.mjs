import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeSession, checkOrder, recordTrade, emergencyStop, destinationReady, MAX_SESSION_MS } from './trading_session.js';

const NOW = Date.parse('2026-10-26T15:30:00Z');
const limits = (d) => ({ [d]: { max_session_loss: 500, max_loss_per_trade: 100, max_trades: 3, max_contracts: 2, max_positions: 1 } });
const paper = (over = {}) => authorizeSession({ destinations: ['che_paper'], instruments: ['MNQ'], duration_ms: 3_600_000, limits: limits('che_paper'), ...over }, { now: NOW });
const order = { destination: 'che_paper', instrument: 'MNQ', qty: 1, risk_per_trade: 40 };

test('a paper session is authorized with its limits and an expiry', () => {
  const { session, error } = paper();
  assert.equal(error, '');
  assert.equal(session.expires_at, NOW + 3_600_000);
  assert.deepEqual(session.instruments, ['MNQ']);
});

test('a session must name a destination, an instrument, a duration and every limit', () => {
  assert.match(authorizeSession({ destinations: [], instruments: ['MNQ'], duration_ms: 1000 }, { now: NOW }).error, /destination/);
  assert.match(authorizeSession({ destinations: ['che_paper'], instruments: ['GC'], duration_ms: 1000 }, { now: NOW }).error, /instrument/);
  assert.match(paper({ duration_ms: 0 }).error, /duration/);
  assert.match(paper({ limits: { che_paper: { max_session_loss: 0, max_loss_per_trade: 1, max_trades: 1, max_contracts: 1, max_positions: 1 } } }).error, /every limit/);
});

test('a session cannot run longer than eight hours', () => {
  assert.equal(paper({ duration_ms: 99 * 3_600_000 }).session.expires_at - NOW, MAX_SESSION_MS);
});

test('an in-limit paper order passes; out-of-limit ones are blocked with reasons', () => {
  const { session } = paper();
  assert.deepEqual(checkOrder(session, order, { open_positions: 0 }, { now: NOW }), { ok: true, blockers: [] });
  assert.ok(checkOrder(session, { ...order, qty: 5 }, { open_positions: 0 }, { now: NOW }).blockers.some((b) => /contracts/.test(b)));
  assert.ok(checkOrder(session, { ...order, risk_per_trade: 500 }, { open_positions: 0 }, { now: NOW }).blockers.some((b) => /per-trade/.test(b)));
  assert.ok(checkOrder(session, { ...order, instrument: 'ES' }, { open_positions: 0 }, { now: NOW }).blockers.some((b) => /ES is not/.test(b)));
  assert.ok(checkOrder(session, order, { open_positions: 1 }, { now: NOW }).blockers.some((b) => /position limit/.test(b)));
});

test('orders are refused after the session expires', () => {
  const { session } = paper();
  assert.ok(checkOrder(session, order, { open_positions: 0 }, { now: NOW + 3_600_001 }).blockers.some((b) => /expired/.test(b)));
});

test('a destination not in the session cannot receive orders', () => {
  const { session } = paper();
  assert.ok(checkOrder(session, { ...order, destination: 'fundyouredge' }, {}, { now: NOW }).blockers.some((b) => /not in this session/.test(b)));
});

test('the trade limit stops new orders', () => {
  let { session } = paper();
  for (let i = 0; i < 3; i += 1) session = recordTrade(session, { destination: 'che_paper', pnl: 10 }, { now: NOW });
  assert.ok(checkOrder(session, order, { open_positions: 0 }, { now: NOW }).blockers.some((b) => /3-trade limit/.test(b)));
});

test('losses past the session limit halt that destination at once', () => {
  let { session } = paper();
  session = recordTrade(session, { destination: 'che_paper', pnl: -300 }, { now: NOW });
  assert.equal(session.halted.che_paper, undefined);
  session = recordTrade(session, { destination: 'che_paper', pnl: -250 }, { now: NOW });
  assert.equal(session.halted.che_paper, 'session loss limit reached');
  assert.ok(checkOrder(session, order, { open_positions: 0 }, { now: NOW }).blockers.some((b) => /halted/.test(b)));
});

test('the emergency stop halts every destination and blocks orders', () => {
  const { session } = paper();
  const stopped = emergencyStop(session);
  assert.equal(stopped.emergency, true);
  assert.ok(checkOrder(stopped, order, { open_positions: 0 }, { now: NOW }).blockers.some((b) => /emergency stop/.test(b)));
});

test('funded and personal accounts stay blocked until connection, rules and agreement are verified', () => {
  assert.equal(destinationReady('fundyouredge', {}).ok, false);
  assert.match(destinationReady('fundyouredge', {}).reason, /not verified/);
  const partial = { fundyouredge: { connection_verified: true, rules_verified_source: '', agreement_verified: true } };
  assert.match(destinationReady('fundyouredge', partial).reason, /rules/);
  const full = { fundyouredge: { connection_verified: true, rules_verified_source: 'https://fundyouredge.com/rules', agreement_verified: true } };
  assert.equal(destinationReady('fundyouredge', full).ok, true);
  assert.equal(destinationReady('personal_broker', full).ok, false, 'a verified firm does not verify another destination');
});

test('a funded session is refused by the check while it is unverified', () => {
  const fund = authorizeSession({ destinations: ['fundyouredge'], instruments: ['MNQ'], duration_ms: 3_600_000, limits: limits('fundyouredge') }, { now: NOW });
  const check = checkOrder(fund.session, { ...order, destination: 'fundyouredge' }, { open_positions: 0 }, { now: NOW });
  assert.equal(check.ok, false);
  assert.ok(check.blockers.some((b) => /not verified/.test(b)));
});
