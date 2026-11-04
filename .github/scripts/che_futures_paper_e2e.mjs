// Live end-to-end test of CHE's futures paper simulator on the DEPLOYED Worker (futures_paper.js), through the probe
// route, which trades the separate test account only (never the owner's). Prices are the real delayed CME bars the
// Worker reads. Every step's receipt is printed and saved to futures-paper-e2e.json; any failed check exits 1.
//
//   CHE_WORKER=https://... CHE_PROBE_TOKEN=... RUN_ID=... node .github/scripts/che_futures_paper_e2e.mjs
//
// Steps: clean slate (flatten + reconcile) → a market bracket order (ack, fill, position) → the same client id again
// (duplicate, no second fill) → rejected orders (off-tick, over the limit) → a resting order cancelled → the bracket's
// stop or target executed by a later delayed bar (polled up to STOP_WAIT_MIN) → a second position and an emergency
// flatten → reconciliation of the whole ledger. Connection loss cannot be caused on the live feed; it is covered by
// server/cloudflare/futures_paper.test.mjs with a feed that stops answering.
import { writeFileSync, appendFileSync } from 'node:fs';

const base = String(process.env.CHE_WORKER || '').replace(/\/$/, '');
const token = String(process.env.CHE_PROBE_TOKEN || '');
const run = String(process.env.RUN_ID || Date.now());
const STOP_WAIT_MIN = Number(process.env.STOP_WAIT_MIN || 35);
const log = [];
const checks = [];
const summary = (line) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };

async function call(method, sub, body) {
  const res = await fetch(`${base}/api/probe/futures-paper${sub}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  log.push({ at: new Date().toISOString(), method, sub, body: body || null, status: res.status, receipt: json.receipt || null, text: json.text || null });
  return { status: res.status, json };
}
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  summary(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = (x) => Math.round(x * 4) / 4;

async function main() {
  if (!base || !token) throw new Error('CHE_WORKER and CHE_PROBE_TOKEN are required');
  summary(`## CHE futures paper simulator, live end-to-end (test account), run ${run}`);
  // 0. Clean slate.
  const flat0 = await call('POST', '/flatten', {});
  check('clean slate: flatten answered', flat0.status === 200, flat0.json.text);
  const view0 = await call('GET', '/?root=MES');
  const mes = view0.json.feeds?.MES || {};
  summary(`MES feed: ${mes.status} from ${mes.source}, contract ${mes.contract}, last bar ${mes.bar_time} (${Math.round((mes.age_s || 0) / 60)} min old), session ${mes.session}, fresh ${mes.fresh}`);
  check('the feed is labelled DELAYED (not live)', mes.status === 'DELAYED', mes.status);
  if (!mes.fresh) {
    check('a fresh delayed MES price exists (CME session open)', false, `fresh=${mes.fresh}, session ${mes.session}; market orders are correctly refused now. Run again while CME is open.`);
    return;
  }
  const ref = mes.price;
  // 1. A market bracket: tight stop (two ticks under the fill), wide target, so a later bar most likely runs the stop.
  const entry = await call('POST', '/order', { root: 'MES', side: 'buy', qty: 1, type: 'market', stop_loss: tick(ref - 0.25), take_profit: tick(ref + 6), client_id: `e2e-${run}-1` });
  const er = entry.json.receipt || {};
  check('market order acknowledged with an order id', entry.status === 200 && /^O-\d+$/.test(er.order_id || ''), `${er.order_id} ${er.order_status}`);
  check('market order filled at the delayed price plus one tick', er.status === 'success' && er.fill_price === tick(ref + 0.25), `fill ${er.fill_price} from ${ref} (${er.price_time})`);
  const pos1 = (entry.json.account?.positions || []).find((p) => p.root === 'MES');
  check('position shows long 1 MES at the fill price', pos1?.qty === 1 && pos1?.avg === er.fill_price, JSON.stringify(pos1));
  const legs = (entry.json.account?.working || []).filter((o) => o.parent_id === er.order_id);
  check('the bracket stop loss and take profit are working', legs.length === 2 && legs.some((o) => o.role === 'stop_loss') && legs.some((o) => o.role === 'take_profit'), legs.map((o) => `${o.role} ${o.type} ${o.price}`).join(', '));
  // 2. Duplicate.
  const dup = await call('POST', '/order', { root: 'MES', side: 'buy', qty: 1, type: 'market', client_id: `e2e-${run}-1` });
  check('the same client id is refused as a duplicate', dup.json.duplicate === true && dup.json.receipt?.status === 'duplicate', dup.json.text);
  const view1 = await call('GET', '/?root=MES');
  check('the duplicate made no second fill', (view1.json.positions || []).find((p) => p.root === 'MES')?.qty === 1);
  // 3. Rejections.
  const offTick = await call('POST', '/order', { root: 'MES', side: 'buy', qty: 1, type: 'limit', price: tick(ref - 50) + 0.1, client_id: `e2e-${run}-2` });
  check('an off-tick price is rejected', offTick.status === 422 && offTick.json.receipt?.status === 'rejected', offTick.json.receipt?.reason);
  const tooMany = await call('POST', '/order', { root: 'NQ', side: 'buy', qty: 3, type: 'limit', price: 1000, client_id: `e2e-${run}-3` });
  check('an order over the contract limit is rejected', tooMany.json.receipt?.status === 'rejected', tooMany.json.receipt?.reason);
  // 4. A resting order, then cancelled.
  const rest = await call('POST', '/order', { root: 'MES', side: 'buy', qty: 1, type: 'limit', price: tick(ref - 100), client_id: `e2e-${run}-4` });
  check('a resting limit order is accepted and working', rest.json.receipt?.status === 'accepted', rest.json.receipt?.order_id);
  const cancel = await call('POST', '/cancel', { id: rest.json.receipt?.order_id });
  check('the resting order is cancelled', cancel.json.receipt?.status === 'success', cancel.json.text);
  // 5. The bracket exit, filled by a later delayed bar.
  let exit = null;
  for (let i = 0; i < STOP_WAIT_MIN && !exit; i++) {
    await sleep(60_000);
    const v = await call('GET', '/?root=MES');
    const fills = v.json.recent_fills || [];
    const legIds = new Set(legs.map((o) => o.id));
    exit = fills.find((f) => legIds.has(f.order_id)) || null;
    if (exit) {
      const leg = legs.find((o) => o.id === exit.order_id);
      const sibling = (v.json.recent_orders || []).find((o) => o.oco === leg.oco && o.id !== leg.id);
      check(`the bracket ${leg.role === 'stop_loss' ? 'stop loss (stop execution)' : 'take profit'} filled from a delayed bar`, true, `${exit.side} ${exit.qty} MES at ${exit.price}: ${exit.basis}`);
      check('its bracket partner was cancelled (one cancels the other)', sibling?.status === 'cancelled', `${sibling?.id} ${sibling?.status}`);
      check('the position is flat after the exit', !(v.json.positions || []).some((p) => p.root === 'MES'));
    }
  }
  if (!exit) check('a bracket leg filled within the wait', false, `no MES bar reached the stop or target within ${STOP_WAIT_MIN} minutes`);
  // 6. Emergency flatten with an open position and working orders.
  const second = await call('POST', '/order', { root: 'MES', side: 'sell', qty: 2, type: 'market', stop_loss: tick(ref + 40), client_id: `e2e-${run}-5` });
  check('a second position opened (short 2 MES)', second.json.receipt?.status === 'success', second.json.text);
  const flat = await call('POST', '/flatten', {});
  check('emergency flatten closed every position and cancelled every working order', flat.json.receipt?.status === 'success' && (flat.json.closed || []).length >= 1 && (flat.json.cancelled || []).length >= 1, flat.json.text);
  const after = await call('GET', '/?root=MES');
  check('nothing is open after the flatten', !(after.json.positions || []).length && !(after.json.working || []).length);
  // 7. Reconciliation of the whole ledger.
  const rec = await call('GET', '/reconcile');
  check('reconciliation: positions, cash and P&L match the fill ledger', rec.json.status === 'success', rec.json.diffs?.join('; ') || `${rec.json.fills} fills, cash ${rec.json.cash}, realized ${rec.json.realized}, commissions ${rec.json.commissions}`);
}

main().catch((error) => check('the run completed', false, error?.message || error)).finally(() => {
  writeFileSync('futures-paper-e2e.json', JSON.stringify({ run, checks, log }, null, 2));
  const failed = checks.filter((c) => !c.ok);
  summary(`\n${checks.length - failed.length} of ${checks.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
});
