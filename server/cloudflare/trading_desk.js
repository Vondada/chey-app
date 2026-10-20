// CHE's trading desk: one switch between paper, simulated and live trading,
// entry alerts from the skills CHE has learned, and orders on the owner's
// NinjaTrader account.
//
//   paper  CHE's own journal only (default). Alerts are information.
//   sim    NinjaTrader's simulated account. CHE places alerted entries herself.
//   live   NinjaTrader's real account. CHE calls the entry and places it only
//          after the owner says "take the trade" (owner rule: anything that
//          costs money is confirmed first).

import { placeBracket, tick } from './broker_tradovate.js';
import { withoutProhibitions } from './owner_action_gate.js';

const DESK = 'trading_desk';
const ALERT_HOURS = 20; // a daily-bar entry is good until the next session
const ROOTS = { 'es.f': { full: 'ES', micro: 'MES' }, 'nq.f': { full: 'NQ', micro: 'MNQ' } };

export async function readDesk(storage) {
  const desk = (await storage.get(DESK)) || {};
  return {
    mode: ['paper', 'sim', 'live'].includes(desk.mode) ? desk.mode : 'paper',
    qty: Number.isInteger(desk.qty) && desk.qty >= 1 && desk.qty <= 10 ? desk.qty : 1,
    contract: desk.contract === 'full' ? 'full' : 'micro',
    alerts: Array.isArray(desk.alerts) ? desk.alerts : [],
    // The account each mode trades: live orders go only to the one the owner named.
    account: { sim: String(desk.account?.sim || ''), live: String(desk.account?.live || '') },
    listed: desk.listed && Array.isArray(desk.listed.names) ? desk.listed : null,
    // The owner's live limits: the most contracts per order and the most dollars at risk on one order.
    risk_limits: validLimits(desk.risk_limits),
    // When the owner last asked to switch to live; the switch waits for "confirm live trading".
    live_request_at: Number(desk.live_request_at) || 0,
    // The Alpaca PAPER stock order CHE last read back, waiting for "yes, place it" (or its result).
    stock_order: desk.stock_order && typeof desk.stock_order === 'object' && desk.stock_order.order ? desk.stock_order : null,
  };
}

const LIVE_CONFIRM_MS = 2 * 60_000;

function validLimits(limits) {
  const contracts = Number(limits?.maxContracts);
  const dollars = Number(limits?.maxRiskDollars);
  return Number.isInteger(contracts) && contracts >= 1 && contracts <= 10 && dollars >= 1 ? { maxContracts: contracts, maxRiskDollars: dollars } : null;
}

async function saveDesk(storage, desk) {
  desk.alerts = desk.alerts.slice(-50);
  await storage.put(DESK, desk);
}

export const MODE_NAME = { paper: 'paper trading (CHE\'s own journal, no account)', sim: 'your NinjaTrader simulated account', live: 'your NinjaTrader LIVE account, real money' };

function describe(a) {
  return `buy ${a.qty} ${a.root} at ${a.entry}, stop ${a.stop}, target ${a.target}`;
}

/**
 * New entries from this paper tick become alerts: every futures paper trade
 * CHE just opened is also called for NinjaTrader. In sim mode CHE places it
 * herself; in live mode it waits for the owner's yes.
 */
export async function deskTick(storage, book, { now = Date.now(), place = placeBracket } = {}) {
  const desk = await readDesk(storage);
  let changed = false;
  for (const a of desk.alerts) {
    if (a.status === 'pending' && now > Date.parse(a.expires_at)) { a.status = 'expired'; changed = true; }
  }
  for (const t of book?.open || []) {
    const roots = ROOTS[t.symbol];
    if (!roots || desk.alerts.some((a) => a.paper_id === t.id)) continue;
    // Only fresh entries: a paper trade opened hours ago is no longer an entry.
    if (t.opened_at && now - Date.parse(t.opened_at) > 2 * 3600_000) continue;
    const alert = {
      id: crypto.randomUUID(),
      paper_id: t.id,
      at: new Date(now).toISOString(),
      expires_at: new Date(now + ALERT_HOURS * 3600_000).toISOString(),
      root: roots[desk.contract],
      qty: desk.qty,
      entry: t.entry,
      stop: t.stop,
      target: t.target,
      skill: t.strategy,
      why: t.why || '',
      mode: desk.mode,
      account: desk.mode === 'live' ? desk.account.live : desk.mode === 'sim' ? desk.account.sim : '',
      status: 'pending',
      announced: false,
    };
    if (desk.mode === 'paper') alert.status = 'info';
    if (desk.mode === 'sim') alert.status = 'placing';
    desk.alerts.push(alert);
    changed = true;
  }
  if (changed) await saveDesk(storage, desk);
  // Simulated orders: each alert is claimed ("placing", saved above) before
  // the broker is called, so an overlapping tick cannot send it twice.
  for (const alert of desk.alerts.filter((a) => a.status === 'placing' && a.mode === 'sim' && !a.result && !a.error)) {
    const result = await place(storage, 'sim', { ...alert, account: desk.account.sim }).catch((e) => ({ error: String(e?.message || e) }));
    await updateAlert(storage, alert.id, result.ok ? { status: 'placed', result } : { status: 'failed', error: result.error });
  }
  return readDesk(storage);
}

async function updateAlert(storage, id, patch) {
  const desk = await readDesk(storage);
  const alert = desk.alerts.find((a) => a.id === id);
  if (alert) Object.assign(alert, patch);
  await saveDesk(storage, desk);
  return alert;
}

/** Spoken text for alerts the owner has not heard yet, then marks them heard. */
export async function takeAnnouncement(storage, now = Date.now()) {
  const desk = await readDesk(storage);
  const fresh = desk.alerts.filter((a) => !a.announced && (a.status !== 'pending' || now <= Date.parse(a.expires_at)));
  if (!fresh.length) return '';
  for (const a of fresh) a.announced = true;
  await saveDesk(storage, desk);
  return fresh.map(speakAlert).join(' ');
}

export function speakAlert(a) {
  if (a.status === 'placed') return `Trade alert, sir: ${a.why ? `${a.why}. ` : ''}I placed it on ${a.mode === 'live' ? 'your LIVE account' : 'your simulated account'} ${a.result.account}: buy ${a.result.qty} ${a.result.symbol} limit ${a.result.entry}, stop ${a.result.stop}, target ${a.result.target}. Tradovate order ${a.result.order_id}.`;
  if (a.status === 'failed') return `Trade alert, sir: ${describe(a)}. I tried to place it but it failed: ${a.error}`;
  if (a.status === 'info') return `Trade alert, sir (paper only): ${describe(a)}${a.why ? `, because it ${a.why}` : ''}. Say "switch to sim trading" or "switch to live trading" to send entries to NinjaTrader.`;
  if (a.status === 'pending') return `Trade alert, sir, good entry on your LIVE account${a.account ? ` ${a.account}` : ''}: ${describe(a)}${a.why ? `, because it ${a.why}` : ''}. Real money. Say "yes, take the trade" to place it, or "skip it".`;
  return '';
}

// ─── Voice ───────────────────────────────────────────────────────────────

export function deskIntent(message) {
  const stock = stockOrderIntent(message);
  if (stock) return stock;
  const text = String(message || '').toLowerCase().replace(/[’']/g, "'");
  // "Yes, place it" is the Alpaca paper yes: it confirms the paper order CHE just read back. It is never the live
  // alert's approval (blocker 1; that is "yes, take the trade"). A bare "place it" has no yes, so it places nothing:
  // it is answered with the phrase to say.
  const placeIt = /^\s*(yes[,!.]?\s+)?(?:please\s+)?place\s+(?:it|that|the\s+order|that\s+order|the\s+paper\s+order|my\s+order)(?:\s+(?:please|now))?[\s.!]*$/.exec(text);
  // live: false. "yes, place it" is the Alpaca paper yes. It takes a live alert only if no paper read-back is
  // pending, and then it is refused: a live alert is taken only by "yes, take the trade" (see below).
  if (placeIt) return placeIt[1] ? { kind: 'take', place: true, live: false } : { kind: 'place_unconfirmed' };
  // A no to that order. With nothing waiting it is an ordinary "no" and goes on to its own route.
  if (/^\s*(?:no|nope|no thanks|no thank you|don't|dont|do not)(?:[,!.]?\s+(?:don't|dont|do not)\s+(?:place|send)\s+it)?[\s.!]*$|^\s*(?:no[,!.]?\s+)?(?:don't|dont|do not)\s+(?:place|send)\s+(?:it|that|the order|that order)[\s.!]*$|^\s*(?:no[,!.]?\s+)?(?:drop|cancel)\s+(?:it|that order|the order)[\s.!]*$/.test(text)) return { kind: 'stock_no' };
  // "Show me my Alpaca trades", "How is my Alpaca paper account doing?": the Alpaca PAPER dashboard (owner, 2026-10-20).
  if (/\b(?:what|which|show|list|read|tell me|check|any|how|open|see|watch|pull up|bring up)\b[\s\S]{0,40}\balpaca\b[\s\S]{0,25}\b(?:trades?|fills?|positions?|account|portfolio|dashboard|equity|p\s*&\s*l|pnl|performance|executions?)\b/.test(text)) return { kind: 'alpaca_orders' };
  if (/\b(?:what|which|show|list|read|tell me|check|any)\b[\s\S]{0,30}\b(?:alpaca(?:\s+paper)?|paper)\s+orders?\b|^\s*(?:my\s+)?alpaca(?:\s+paper)?\s+orders\s*[?.!]*$|\b(?:did|has)\b[\s\S]{0,25}\b(?:alpaca(?:\s+paper)?|paper)\s+orders?\b[\s\S]{0,20}\bfill/.test(text)) return { kind: 'alpaca_orders' };
  // "What do I need for Tradovate?", "Tradovate steps": Tradovate's own requirements, read as a list.
  if (/\b(?:what|which)\b[\s\S]{0,30}\b(?:need|required|requirements?|steps?|prerequisites?|blocking|missing)\b[\s\S]{0,30}\b(?:tradovate|ninja\s?trader)\b|\b(?:tradovate|ninja\s?trader)(?:\s+api)?\s+(?:steps|requirements|prerequisites)\b|\bhow\s+(?:do|can)\s+i\s+get\b[\s\S]{0,20}\b(?:tradovate|ninja\s?trader)\b[\s\S]{0,15}\bapi\b/.test(text)) return { kind: 'tradovate_steps' };
  // A request to hear them, not a remark about a connection ("my trading connection keeps dropping").
  if (/\b(?:what|which|show|list|read|tell me|check)\b[\s\S]{0,25}\b(?:trading|broker(?:age)?)\s+(?:connections?|status)\b|^\s*(?:my\s+)?(?:trading|broker(?:age)?)\s+(?:connections|status)\s*[?.!]*$|\b(?:which|what)\s+brokers?\b[\s\S]{0,20}\bconnected\b/.test(text)) return { kind: 'connections' };
  // The whole sentence is the confirmation: "confirm live trading is still off?" is a question, not a yes.
  if (/^\s*(?:yes[,!.]?\s+)?confirm\s+(?:the\s+)?(?:switch\s+to\s+)?live\s+trading(?:\s+(?:please|now))?[\s.!]*$/.test(text)) return { kind: 'confirm_live' };
  const alpacaTrading = /\balpaca\b/.test(text) && /\b(?:paper|account|keys?|broker|trading)\b/.test(text);
  if (alpacaTrading && /\b(?:remove|delete|disconnect|unlink|forget)\b/.test(text)) return { kind: 'alpaca_remove' };
  if (alpacaTrading && /\b(?:connect|link|set up|setup|add|hook up)\b/.test(text)) return { kind: 'alpaca_setup' };
  // "Connect Alpaca", "how do I connect alpaca?": the sentence ends at Alpaca, so it means the broker.
  if (/\b(?:connect|link|set up|setup|hook up)\b[\s\S]{0,20}\balpaca[\s?.!]*$/.test(text)) return { kind: 'alpaca_setup' };
  if (/\b(?:connect|link|sign in to|log in to|hook up)\b[\s\S]{0,30}\b(?:ninja\s?trader|tradovate|trading account|funded account|broker)\b/.test(text)) return { kind: 'connect' };
  // "Switch to paper", "go back to paper", "go live", "turn on live trading": the same switches, said
  // shorter (comprehension audit). "Don't go live yet" asks nothing; going live still takes the confirmation.
  const asked = withoutProhibitions(text);
  if (/^\s*(?:(?:hey\s+)?(?:che|chey|chay)[,\s]+)?(?:please\s+|ok\s+|okay\s+|now\s+)?(?:switch|change|go|flip|move)(?:\s+(?:back|over))*\s+to\s+paper(?:\s+(?:trading|mode|account))?(?:\s+(?:now|please))?[\s.!]*$/.test(asked)) return { kind: 'mode', mode: 'paper' };
  if (/^\s*(?:(?:hey\s+)?(?:che|chey|chay)[,\s]+)?(?:please\s+|ok\s+|okay\s+|now\s+|let's\s+)?(?:go\s+live|turn\s+on\s+live(?:\s+(?:trading|mode))?|(?:start|enable)\s+live\s+trading|switch\s+to\s+live)\b/.test(asked)) return { kind: 'mode', mode: 'live' };
  // "Is live trading on?", "are we trading live or paper right now?": the mode, read only.
  if (/\bis\s+live\s+trading\s+(?:on|off|enabled|active|turned\s+on)\b|\b(?:are\s+we|am\s+i|are\s+you)\s+(?:trading\s+)?(?:live|on\s+live|paper|on\s+paper)(?:\s+or\s+(?:on\s+)?(?:paper|live|sim))?(?:\s+(?:trading|right\s+now|now|today))*\s*[?.!]*$/.test(text)) return { kind: 'status' };
  const sw = /\b(?:switch|change|go|flip|move|put|set)\b[\s\S]{0,25}\b(?:to|over to|on|into)\b/.test(text);
  if (sw && /\b(?:live|real)(?:\s+money)?\s+(?:trading|account|mode)\b/.test(text)) return { kind: 'mode', mode: 'live' };
  if (sw && /\b(?:sim|simulated|simulation|demo|practice)\s+(?:trading|account|mode)\b/.test(text)) return { kind: 'mode', mode: 'sim' };
  if (sw && /\bpaper\s+(?:trading|mode)\b/.test(text)) return { kind: 'mode', mode: 'paper' };
  if (/\bwhat\b[\s\S]{0,20}\btrading mode\b|\bam i (?:on|in) (?:live|sim|paper|the live|the sim)\b|\bwhich (?:trading )?account am i\b/.test(text)) return { kind: 'status' };
  // The only place-take is an explicit yes: "yes, take the trade", "yes, place the trade", "yes, take it". A trade
  // phrase without the yes is never a placement (reviewer blocker 1): "take the trade", "place the trade now",
  // "enter the trade", "send the trade" and "confirm the trade" answer with the phrase to say and place nothing.
  // The live alert's own approval: "yes, take the trade", "yes, place the trade", "yes, take it" (live: true).
  if (/^\s*yes[,!.]?\s+(?:please\s+)?(?:take|place)\s+(?:the|that|this)\s+trade(?:\s+(?:please|now))?[\s.!]*$|^\s*yes[,!.]?\s+(?:please\s+)?take\s+it(?:\s+(?:please|now))?[\s.!]*$/.test(text)) return { kind: 'take', place: true, live: true };
  // Other explicit yes phrases ("yes, enter the trade", "yes, send the trade", "yes, confirm the trade") are the paper yes only.
  if (/^\s*yes[,!.]?\s+(?:please\s+)?(?:enter|send|confirm)\s+(?:the|that|this)\s+trade(?:\s+(?:please|now))?[\s.!]*$|^\s*yes[,!.]?\s+(?:please\s+)?(?:enter|send|confirm)\s+it(?:\s+(?:please|now))?[\s.!]*$/.test(text)) return { kind: 'take', place: true, live: false };
  if (/^\s*(?:yes[,!.]?\s+)?(?:please\s+)?(?:take|place|enter|send|confirm)\s+(?:the|that|this)\s+trade\b|^\s*yes[,!.]?\s+(?:take|enter|send|confirm)\s+it\b/.test(text)) return { kind: 'take_unconfirmed' };
  if (/^\s*(?:no[,!.]?\s+)?skip\s+(?:it|the trade|that trade|this trade)\b|^\s*(?:cancel|pass on)\s+(?:the|that|this)\s+(?:trade|alert)\b/.test(text)) return { kind: 'skip' };
  const limit = /\b(?:set|change|make|put)\b[\s\S]{0,30}\b(?:live\s+)?(?:risk\s+)?limits?\b[\s\S]{0,30}?\b(\d{1,2})\s+contracts?\b[\s\S]{0,30}?\$?(\d{1,6}(?:\.\d+)?)\s*(?:dollars?|usd)?\b/.exec(text);
  if (limit) return { kind: 'limits', maxContracts: Number(limit[1]), maxRiskDollars: Number(limit[2]) };
  const size = /\btrade\s+(\d{1,2}|one|two|three|four|five)\s+(micros?|micro contracts?|contracts?|full(?:[\s-]size)? contracts?)\b/.exec(text);
  if (size) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    return { kind: 'size', qty: words[size[1]] || Number(size[1]), contract: /full/.test(size[2]) ? 'full' : /micro/.test(size[2]) ? 'micro' : null };
  }
  if (/\b(?:any|what are|read|tell me)\b[\s\S]{0,20}\b(?:trade alerts?|entry points?|entries|good entr(?:y|ies))\b|\bwhat'?s the trade\b/.test(text) && !/\bbacktest|swing high/.test(text)) return { kind: 'alerts' };
  if (/\b(?:list|what are|which|read|tell me)\b[\s\S]{0,15}\b(?:my\s+)?(?:trading |ninja\s?trader |funded |live |sim |simulated )?accounts\b/.test(text)) return { kind: 'accounts' };
  const pick = /\b(?:use|trade on|trade with|choose|pick|select)\s+(?:the\s+)?account\s+(?:number\s+)?([a-z0-9-]+)\b/.exec(text);
  if (pick) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, first: 1, second: 2, third: 3 };
    const n = words[pick[1]] || (/^\d{1,2}$/.test(pick[1]) ? Number(pick[1]) : null);
    return { kind: 'pick', ...(n ? { number: n } : { name: String(message).match(new RegExp(`account\\s+(?:number\\s+)?(${pick[1]})`, 'i'))?.[1] || pick[1] }) };
  }
  if (/\b(?:balance|how much (?:money )?(?:is|do i have))\b[\s\S]{0,40}\b(?:ninja\s?trader|trading|funded|sim|live)\b[\s\S]{0,10}\baccount\b/.test(text)) return { kind: 'balance' };
  return null;
}

export async function setMode(storage, mode) {
  const desk = await readDesk(storage);
  const before = desk.mode;
  desk.mode = mode;
  desk.live_request_at = 0;
  await saveDesk(storage, desk);
  return { before, mode };
}

// Going live takes two steps (owner directive, issue #344): the first only records the request,
// so CHE can say which broker, account and limits would trade real money; the switch happens
// when the owner says "confirm live trading" within two minutes. Nothing promotes to live alone.
export async function requestLive(storage, now = Date.now()) {
  const desk = await readDesk(storage);
  if (desk.mode === 'live') return { already: true, desk };
  desk.live_request_at = now;
  await saveDesk(storage, desk);
  return { desk };
}

export async function confirmLive(storage, now = Date.now()) {
  const desk = await readDesk(storage);
  if (!desk.live_request_at || now - desk.live_request_at > LIVE_CONFIRM_MS) {
    return { error: 'There is no live switch waiting to be confirmed, sir. Say "switch to live trading" first. Nothing changed.' };
  }
  return setMode(storage, 'live');
}

/** What the owner hears before confirming live: the broker, the exact account and the limits. */
export function speakLiveRequest(desk, conn) {
  const account = desk.account.live ? `account ${desk.account.live}` : 'no live account chosen yet';
  const limits = desk.risk_limits ? `${desk.risk_limits.maxContracts} contract${desk.risk_limits.maxContracts === 1 ? '' : 's'} and $${desk.risk_limits.maxRiskDollars} at risk per order` : 'not set, so no live order could be sent';
  return `Before I switch to LIVE, sir: that is real money on Tradovate, ${account}. Your live limits: ${limits}.${conn?.connected ? '' : ' NinjaTrader is not connected yet.'} Even on live, I place an order only after you approve that exact order. To switch, say "confirm live trading" within two minutes. Nothing changed yet.`;
}

// The owner sets the live limits by voice. Nothing live is sent until they exist.
export async function setRiskLimits(storage, { maxContracts, maxRiskDollars } = {}) {
  const limits = validLimits({ maxContracts, maxRiskDollars });
  if (!limits) return { error: 'Choose 1 to 10 contracts and at least 1 dollar for the live limits, sir. Nothing changed.' };
  const desk = await readDesk(storage);
  desk.risk_limits = limits;
  await saveDesk(storage, desk);
  return { limits };
}

// The owner's "take the trade" approves exactly this alert, as the broker will send it.
function approvalFor(alert, account) {
  return { account, contract: alert.root, qty: alert.qty, entry: tick(alert.entry), stop: tick(alert.stop), target: tick(alert.target), expires_at: Date.parse(alert.expires_at) };
}

export async function setSize(storage, qty, contract) {
  if (!(qty >= 1 && qty <= 10)) return { error: 'Choose 1 to 10 contracts, sir.' };
  const desk = await readDesk(storage);
  desk.qty = qty;
  if (contract) desk.contract = contract;
  await saveDesk(storage, desk);
  return { qty: desk.qty, contract: desk.contract };
}

/** The newest pending live alert the owner can still take. */
export function pendingAlert(desk, now = Date.now()) {
  return [...desk.alerts].reverse().find((a) => a.status === 'pending' && now <= Date.parse(a.expires_at)) || null;
}

/** Owner said "yes, take the trade" (an explicit yes): place the newest pending alert in the current mode. */
export async function takeTrade(storage, { now = Date.now(), place = placeBracket } = {}) {
  const desk = await readDesk(storage);
  const alert = pendingAlert(desk, now);
  if (!alert) return { reply: 'There is no open trade alert to take right now, sir. Nothing was placed.' };
  if (desk.mode === 'paper') return { reply: 'You are in paper trading, sir, so nothing goes to NinjaTrader. Say "switch to sim trading" or "switch to live trading" first. Nothing was placed.' };
  const account = desk.account[desk.mode];
  if (desk.mode === 'live' && !account) return { reply: 'Which live account should this go to, sir? Say "list my trading accounts", then "use account" and its number. Nothing was placed.' };
  // Checked before the alert is claimed, so the alert stays open for when the limits are set.
  if (desk.mode === 'live' && !desk.risk_limits) return { ok: false, reply: 'Set your live risk limits first, sir: say "set my live risk limit to 1 contract and 100 dollars". Nothing was placed.' };
  // Claim the alert before calling the broker: a repeated or overlapping
  // "take the trade" finds it already taken and sends nothing.
  alert.status = 'placing';
  alert.announced = true;
  await saveDesk(storage, desk);
  const result = await place(storage, desk.mode, {
    ...alert, account, approval: desk.mode === 'live' ? approvalFor(alert, account) : null,
    limits: desk.risk_limits, unattended: false,
  }).catch((e) => ({ error: String(e?.message || e) }));
  await updateAlert(storage, alert.id, result.ok ? { status: 'placed', result, mode: desk.mode } : { status: 'failed', error: result.error });
  return {
    ok: Boolean(result.ok),
    reply: result.ok
      ? `Placed on ${desk.mode === 'live' ? 'your LIVE account' : 'your simulated account'} ${result.account}, sir: buy ${result.qty} ${result.symbol} limit ${result.entry}, stop ${result.stop}, target ${result.target}. Tradovate order ${result.order_id}.`
      : `The order was NOT placed, sir. ${result.error}`,
  };
}

export async function skipTrade(storage, now = Date.now()) {
  const desk = await readDesk(storage);
  const alert = pendingAlert(desk, now);
  if (!alert) return 'There is no open trade alert to skip, sir.';
  alert.status = 'skipped';
  alert.announced = true;
  await saveDesk(storage, desk);
  return `Skipped: ${describe(alert)}. Nothing was placed.`;
}

export function speakDeskStatus(desk, conn) {
  const link = conn?.connected ? 'NinjaTrader is connected.' : 'NinjaTrader is not connected yet; say "connect NinjaTrader".';
  const acct = desk.mode !== 'paper' ? (desk.account[desk.mode] ? ` Account: ${desk.account[desk.mode]}.` : desk.mode === 'live' ? ' No live account chosen yet; say "list my trading accounts".' : '') : '';
  const lim = desk.risk_limits;
  const limits = lim
    ? ` Live limits: at most ${lim.maxContracts} contract${lim.maxContracts === 1 ? '' : 's'} and ${lim.maxRiskDollars} dollars at risk per order.`
    : ' Live limits are not set, so no live order can be sent.';
  return `You are on ${MODE_NAME[desk.mode]}, sir.${acct} Size: ${desk.qty} ${desk.contract === 'full' ? 'full-size' : 'micro'} contract${desk.qty === 1 ? '' : 's'}.${limits} ${link}`;
}

/** Saves the accounts just read aloud, so "use account 2" means the second one said. */
export async function rememberListed(storage, mode, names) {
  const desk = await readDesk(storage);
  desk.listed = { mode, names: names.slice(0, 20) };
  await saveDesk(storage, desk);
}

export async function chooseAccount(storage, { number, name }) {
  const desk = await readDesk(storage);
  const listed = desk.listed;
  if (!listed?.names?.length) return { error: 'Say "list my trading accounts" first, sir, so I can read them to you.' };
  const chosen = number ? listed.names[number - 1] : listed.names.find((n) => n.toLowerCase() === String(name).toLowerCase());
  if (!chosen) return { error: `I don't have that account in the list I read, sir. The accounts are: ${listed.names.map((n, i) => `${i + 1}, ${n}`).join('; ')}.` };
  desk.account[listed.mode] = chosen;
  await saveDesk(storage, desk);
  return { mode: listed.mode, account: chosen };
}

// ─── Alpaca PAPER stock orders by voice (issue #344) ────────────────────
//
// "Buy 10 shares of AAPL on Alpaca paper", "sell 5 MSFT paper at limit 410". The whole sentence has
// to be one order; anything left over is said back as not understood, never guessed. CHE reads the
// order back and sends it only after "yes, place it" within two minutes. Options, crypto, futures
// and live accounts are refused with the reason. A paper order is not a money action, but the owner
// approves each order sent to a broker.

const STOCK_CONFIRM_MS = 2 * 60_000;
export const STOCK_ACCOUNT = 'Alpaca PAPER';

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_WORD = `(?:${[...Object.keys(NUMBER_WORDS), 'hundred', 'thousand'].join('|')})`;
const QTY = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|half(?:\s+a)?|${NUMBER_WORD}(?:(?:[\s-]+|\s+and\s+)${NUMBER_WORD})*)`;
// Company names said aloud, resolved to their ticker; the read-back names both.
const COMPANIES = { apple: 'AAPL', microsoft: 'MSFT', tesla: 'TSLA', nvidia: 'NVDA', amazon: 'AMZN', netflix: 'NFLX', google: 'GOOGL', alphabet: 'GOOGL', disney: 'DIS', walmart: 'WMT', intel: 'INTC' };
// The explicit list of symbols CHE reads back as stock orders (B4). A word that is not on it ("reams",
// "boxes", "rolls") is never a symbol, so a shopping sentence cannot become an order.
const TICKERS = new Set(('aapl msft tsla nvda amzn nflx googl goog amd intc dis wmt jpm bac wfc gs ms ba ge xom cvx pfe jnj unh mrk abbv lly '
  + 'ko mcd sbux nke hd orcl crm adbe ibm csco qcom txn avgo pypl abnb pltr sofi rivn nio baba pdd gm vz tmus cmcsa '
  + 'spy qqq iwm dia voo vti tqqq sqqq arkk cl brk.b').split(' '));
// Spelled letters ("a a p l", "A.A.P.L.") or a ticker; never a venue word, a function word or a pronoun.
const SYMBOL = String.raw`(${Object.keys(COMPANIES).join('|')}|(?:[a-z][.\s]){1,4}[a-z]\.?(?=\s|$)|(?!(?:paper|alpaca|shares?|stocks?|it|that|this|them|some|more|the|of|in|on|at|for|to|from|with|and|my|your)\b)[a-z]{1,5}(?:\.[a-z])?)`;
const LEAD = String.raw`(?:(?:hey\s+)?(?:che|chey|chay)[,:]?\s+)?(?:(?:please|ok|okay|now|just|go ahead and|can you|could you|would you|will you|i want to|i want you to|i'd like to|id like to|i would like to|let's|lets)\s+)*`;
const STOCK_VERB = new RegExp(String.raw`^${LEAD}(?:buy|sell|purchase)\b`);
const STOCK_HEAD = new RegExp(String.raw`^${LEAD}(buy|sell|purchase)\s+${QTY}\s+(?:shares?\s+(?:of\s+|in\s+)?)?${SYMBOL}(?:\s+(?:shares?|stocks?))?(?=\s|$)`);
const VENUE = /\b(?:(?:on|in|with|through|using|via|to|from|at)\s+)?(?:(?:my|the|your)\s+)?(?:(?:alpaca\s+)?paper(?:\s+(?:trading|trade))?|alpaca)(?:\s+(?:trading\s+)?(?:account|trading|money|broker))?\b/g;
const LIMIT = /\b(?:(?:with|at|for)\s+)?(?:a\s+)?limit(?:\s+price)?(?:\s+order)?(?:\s+(?:of|at|for))?\s+\$?(\d+(?:\.\d+)?)(?:\s+dollars?)?|\b(?:as\s+)?(?:a\s+)?limit\s+order\s+(?:at|for|of)\s+\$?(\d+(?:\.\d+)?)(?:\s+dollars?)?|\bat\s+\$?(\d+(?:\.\d+)?)(?:\s+dollars?)?(?:\s+limit)?/g;
const MARKET = /\b(?:(?:at|as)\s+)?(?:a\s+|the\s+)?market(?:\s+(?:price|order))?\b/g;
const DAY = /\b(?:(?:good\s+)?for\s+(?:the\s+)?day|day\s+order|today)\b/g;
const FILLER = /\b(?:please|now|right\s+now|for\s+me|sir|thanks|thank\s+you)\b/g;
// "...but don't place it yet", "just read it back": the read-back never sends, so these change nothing.
const NOT_YET = /\b(?:but\s+)?(?:don't|dont|do\s+not)\s+(?:place|send|submit)\s+it(?:\s+yet)?\b|\b(?:and\s+)?(?:just\s+)?read\s+it\s+back(?:\s+(?:to\s+me|first))?\b/g;
const LIVE_WORDS = /\b(?:live|real(?:\s+money)?|funded|cash\s+account|margin\s+account)\b/;
const OPTION_WORDS = /\b(?:options?|calls?|puts?|strike|expir\w*|leaps?|spreads?|straddles?|strangles?|iron\s+condors?)\b|\b[a-z]{1,5}\d{6}[cp]\d{8}\b/;
const CRYPTO_WORDS = /\b(?:crypto(?:currency|currencies)?|bitcoin|btc|ethereum|eth|ether|solana|sol|dogecoin|doge|xrp|litecoin|ltc|cardano|ada|shiba|usdt|usdc|coins?)\b|\b[a-z]{2,5}\s*\/\s*usd\b|\b(?:btc|eth|sol|doge)usdt?\b/;
const FUTURES_ROOTS = /\b(?:mnq|nq|mes|mym|m2k|mcl|mgc)\b/;
const FUTURES_WORDS = /\bfutures?\b|\bcontracts?\b/;
// Also stock tickers (CL is Colgate): a futures root only when no shares are named.
const SHARED_ROOTS = /\b(?:es|ym|rty|cl|gc)\b/;
const UNSUPPORTED_TYPE = /\b(?:stop(?:[\s-]+(?:loss|limit))?|trailing|bracket|oco|good\s+(?:till|til|until)\s+cancel+ed|gtc|extended\s+hours|after\s+hours|pre[\s-]?market)\b/;
const OTHER_CLAUSE = /[,;]|\b(?:and|then|also|after\s+that)\b/;

function wordsToNumber(raw) {
  const s = String(raw || '').toLowerCase().replace(/,/g, '').trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (/^half(?:\s+a)?$/.test(s)) return 0.5;
  let total = 0;
  let current = 0;
  for (const w of s.split(/[\s-]+/).filter((x) => x && x !== 'and')) {
    if (w in NUMBER_WORDS) current += NUMBER_WORDS[w];
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; } else return NaN;
  }
  return total + current;
}

const refused = (reason, text) => ({ kind: 'stock_order', refuse: reason, paper: !LIVE_WORDS.test(text) && !OTHER_CLAUSE.test(text) });

// Spelled letters lose their spaces and dots ("a a p l" is AAPL); a class share keeps its dot (BRK.B).
function symbolAsSaid(raw) {
  return /^(?:[a-z][.\s]){1,4}[a-z]\.?$/.test(raw) ? raw.replace(/[.\s]/g, '') : raw;
}

// The ticker for a word said: a company name or a symbol on the explicit list. Anything else is null.
function tickerFor(said) {
  if (Object.prototype.hasOwnProperty.call(COMPANIES, said)) return COMPANIES[said];
  return TICKERS.has(said) ? said.toUpperCase() : null;
}

/**
 * The owner's Alpaca paper stock order in [message], a refusal with its reason, or null when the
 * sentence is not a broker order at all ("buy paper towels" keeps its own route and money hold).
 * `paper` marks a turn that can only ever be a paper order or a refusal, never real money.
 */
export function stockOrderIntent(message) {
  const raw = String(message || '').trim();
  const text = raw.toLowerCase().replace(/[’']/g, "'").replace(/[?!]+$/g, '').replace(/\.$/, '').trim();
  if (!STOCK_VERB.test(text) || !/\b(?:alpaca|paper)\b/.test(text)) return null;
  const alpaca = /\balpaca\b/.test(text);
  // B4: the stock route claims a sentence only with a stock signal: the word shares, stock or equity, the word
  // Alpaca, or a ticker or company name CHE knows. Without one it is not a broker order at all, so a purchase
  // like "buy 10 reams paper" or "buy 10 rolls of paper towels on Amazon" keeps its own route and money hold.
  const head = STOCK_HEAD.exec(text);
  const said = head ? symbolAsSaid(head[3]) : '';
  const ticker = head ? tickerFor(said) : null;
  const words = /\b(?:shares?|stocks?|equity|equities)\b/.test(text);
  if (!alpaca && !words && !ticker) return null;
  if (LIVE_WORDS.test(text)) return { kind: 'stock_order', refuse: 'CHE sends Alpaca orders only to your Alpaca PAPER account, sir. Live Alpaca trading is not built, and it would need your separate approval first. Nothing was sent.', paper: false };
  if (OPTION_WORDS.test(text)) return refused('CHE does not place option orders yet, sir; that comes later. I can read your Alpaca paper options level: say "what are my trading connections". Nothing was sent.', text);
  if (CRYPTO_WORDS.test(text)) return refused('CHE sends only stock orders to Alpaca paper, sir, not crypto. Nothing was sent.', text);
  if (FUTURES_ROOTS.test(text) || FUTURES_WORDS.test(text) || (SHARED_ROOTS.test(text) && !/\bshares?\b/.test(text))) return refused('Alpaca does not trade futures, sir. Futures paper trading is CHE\'s own paper engine, and Tradovate demo orders stay blocked until Tradovate approves API access. Nothing was sent.', text);
  if (!head) {
    // "Buy some Apple on Alpaca": an order for the broker, but not one CHE can read back exactly.
    return alpaca || words
      ? { kind: 'stock_order', refuse: 'How many shares of which stock, sir? Say it like "buy 10 shares of AAPL on Alpaca paper". Nothing was sent.', paper: false }
      : null;
  }
  // A word that is not on the ticker list or a company name is never a symbol (B4): refused by name, nothing sent.
  if (!ticker) {
    return alpaca || words
      ? { kind: 'stock_order', refuse: `I don't know a stock called ${said.toUpperCase()}, sir. Say its ticker or company name, like "buy 10 shares of AAPL on Alpaca paper". Nothing was sent.`, paper: false }
      : null;
  }
  const qty = wordsToNumber(head[2]);
  if (!Number.isInteger(qty)) return refused('CHE sends whole shares only, 1 to 1,000, sir. Nothing was sent.', text);
  if (qty < 1 || qty > 1000) return refused('Choose 1 to 1,000 shares, sir. Nothing was sent.', text);
  const symbol = ticker;
  let rest = text.slice(head[0].length).replace(NOT_YET, ' ');
  if (UNSUPPORTED_TYPE.test(rest)) return refused('CHE sends Alpaca paper orders as market or limit orders for one trading day only, sir. Say it again as a market or a limit order. Nothing was sent.', text);
  const limits = [...rest.matchAll(LIMIT)].map((m) => Number(m[1] || m[2] || m[3]));
  rest = rest.replace(LIMIT, ' ');
  const market = MARKET.test(rest);
  MARKET.lastIndex = 0;
  rest = rest.replace(MARKET, ' ').replace(VENUE, ' ').replace(DAY, ' ').replace(FILLER, ' ').replace(/\b(?:che|chey|chay)\b/g, ' ');
  const left = rest.replace(/[\s,.]+/g, ' ').trim();
  if (left || limits.length > 1 || (market && limits.length)) {
    // Only a sentence that says Alpaca or shares is called an Alpaca order; "buy 10 apple paper towels" is a purchase.
    if (!alpaca && !words) return null;
    return { kind: 'stock_order', refuse: `I heard an Alpaca paper order, sir, but not all of it${left ? ` ("${left.slice(0, 60)}")` : ''}. Say it like "buy 10 shares of AAPL on Alpaca paper", adding "at limit 410" for a limit order. Nothing was sent.`, paper: false };
  }
  const limit = limits[0];
  if (limits.length && !(limit > 0)) return refused('A limit order needs a price above zero, sir. Nothing was sent.', text);
  return {
    kind: 'stock_order',
    paper: true,
    order: { symbol, name: COMPANIES[said] ? said[0].toUpperCase() + said.slice(1) : '', side: head[1] === 'sell' ? 'sell' : 'buy', qty, type: limits.length ? 'limit' : 'market', limit_price: limits.length ? limit : null },
  };
}

const usd = (x) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const shares = (n) => `${n} share${n === 1 ? '' : 's'}`;

function describeStock(o) {
  return `${o.side} ${shares(o.qty)} of ${o.symbol}${o.name ? ` (${o.name})` : ''}, ${o.type === 'limit' ? `limit order at ${usd(o.limit_price)}` : 'market order'}, good for one trading day`;
}

/** The read-back: the exact order and the account, and what the owner says to send it. */
export function speakStockOrder(pending) {
  return `Alpaca PAPER order, sir, no real money: ${describeStock(pending.order)}. Account: ${STOCK_ACCOUNT}. To send it, say "yes, place it" within two minutes; say "no" to drop it. Nothing has been sent yet.`;
}

/** Alpaca's receipt in words. A fill is said only when the receipt records one. */
export function speakStockReceipt(r = {}, { brief = false } = {}) {
  const id = r.id ? `order ending ${String(r.id).slice(-4)}` : 'no order id';
  const price = r.type === 'limit' && r.limit_price != null ? ` at ${usd(r.limit_price)}` : '';
  const filled = Number(r.filled_qty) > 0
    ? (Number(r.filled_qty) >= Number(r.qty) && r.status === 'filled'
      ? `Filled: ${r.filled_qty} at ${r.filled_avg_price != null ? usd(r.filled_avg_price) : 'a price Alpaca did not report'}.`
      : `Partly filled so far: ${r.filled_qty} of ${r.qty}${r.filled_avg_price != null ? ` at ${usd(r.filled_avg_price)}` : ''}.`)
    : brief ? 'No fill yet.' : 'No fill yet; say "check my Alpaca paper orders" to hear its status later.';
  return `Alpaca's receipt: ${id}, ${r.side} ${r.qty} ${r.symbol} ${r.type || 'order'}${price}, status ${r.status || 'unknown'}. ${filled}`;
}

/** Saves the order CHE just read back; a new request replaces an older one. */
export async function requestStockOrder(storage, order, now = Date.now()) {
  const desk = await readDesk(storage);
  desk.stock_order = { order, client_order_id: `che-${crypto.randomUUID()}`, asked_at: now, status: 'waiting' };
  await saveDesk(storage, desk);
  return desk.stock_order;
}

/** The order read back in the last two minutes, whatever became of it, or null. */
export function pendingStockOrder(desk, now = Date.now()) {
  const o = desk.stock_order;
  return o && now - Number(o.asked_at || 0) <= STOCK_CONFIRM_MS ? o : null;
}

/** The owner's no: the order is dropped unless it was already sent. */
export async function dropStockOrder(storage, now = Date.now()) {
  const desk = await readDesk(storage);
  const o = pendingStockOrder(desk, now);
  if (!o) return null;
  if (o.status === 'placed') return { already: true, order: o };
  desk.stock_order = null;
  await saveDesk(storage, desk);
  return { dropped: true, order: o };
}

/**
 * A "yes, place it" while an Alpaca PAPER record exists and is no longer pending (B2): the record is cleared
 * and nothing is sent. Its paper result never becomes permission for a live or sim alert.
 */
export async function clearStockOrder(storage) {
  const desk = await readDesk(storage);
  const o = desk.stock_order;
  if (!o) return null;
  desk.stock_order = null;
  await saveDesk(storage, desk);
  return o;
}

/** The reply to a "yes, place it" that found an old Alpaca paper record. Nothing live is placed in any case. */
export function speakStaleStockOrder(o, { alertOpen = false } = {}) {
  const live = alertOpen ? ' A live trade alert is still waiting; say "yes, take the trade" to place it, or "skip it".' : '';
  if (o.status === 'placed') return `That ${STOCK_ACCOUNT} order was already sent, sir, and it stands, once. ${o.receipt ? speakStockReceipt(o.receipt) : ''} Nothing more was sent, and nothing live was placed.${live}`;
  if (o.status === 'placing' || o.status === 'unclear') return `I cannot confirm whether Alpaca placed that paper order, sir. Nothing else was sent, and nothing live was placed.${live} Say "check my Alpaca paper orders" to see its status.`;
  if (o.status === 'failed') return `That ${STOCK_ACCOUNT} order was not sent, sir, and nothing live was placed.${live} Say the order again and I will read it back.`;
  return `The ${STOCK_ACCOUNT} order I read back waited more than two minutes, sir, so nothing was sent.${live} ${alertOpen ? '' : 'Say the order again and I will read it back.'}`.replace(/ $/, '');
}

/** Spoken when the owner says "place it" without the yes that makes it a placing order (B1). Places nothing. */
export const PLACE_NEEDS_YES = 'Nothing was placed, sir. To place an order, say "yes, place it" as one sentence, so I know it is your yes.';

/** A bare "place it" (no yes): names the phrase for what is waiting. Places nothing. */
export function speakPlaceNeedsYes(desk, now = Date.now()) {
  if (pendingStockOrder(desk, now) || pendingAlert(desk, now)) return speakTakeNeedsYes(desk, now);
  return PLACE_NEEDS_YES;
}

/**
 * A trade phrase with no explicit yes ("take the trade", "place the trade now") places nothing, live or paper.
 * It names the phrase for what is waiting: an Alpaca paper read-back owns every yes while it waits (so it is
 * named first), then a live alert.
 */
export function speakTakeNeedsYes(desk, now = Date.now()) {
  if (pendingStockOrder(desk, now)) return `Nothing was placed, sir. To send the order to ${STOCK_ACCOUNT}, say "yes, place it" as one sentence; say "no" to drop it.`;
  if (pendingAlert(desk, now)) return 'Nothing was placed, sir. To place this trade, say "yes, take the trade" as one sentence; say "skip it" to pass.';
  return 'Nothing was placed, sir. There is no open trade alert.';
}

/**
 * "Yes, place it": sends the order read back within the last two minutes, once. Its request id
 * makes a retried yes the same order: a placed one is reported again from its receipt, and a
 * claim left by an interrupted request reaches Alpaca under the same id, which it accepts once.
 */
export async function confirmStockOrder(storage, { now = Date.now(), place } = {}) {
  const desk = await readDesk(storage);
  const o = pendingStockOrder(desk, now);
  if (!o) return { ok: false, reply: 'There is no Alpaca paper order waiting for your yes, sir. Nothing was sent.' };
  if (o.status === 'placed') return { ok: true, repeated: true, receipt: o.receipt, reply: `That order was already sent to ${STOCK_ACCOUNT}, sir, once. ${speakStockReceipt(o.receipt)}` };
  if (o.status === 'failed' || o.status === 'unclear') return { ok: false, reply: `${o.detail} Ask me again for a new order.` };
  o.status = 'placing';
  await saveDesk(storage, desk);
  const result = await place({ ...o.order, client_order_id: o.client_order_id }).catch((e) => ({ ok: false, unclear: true, detail: `I cannot confirm whether Alpaca placed that paper order, sir (${String(e?.message || e).slice(0, 80)}). I will not send it again; say "check my Alpaca paper orders".` }));
  const after = await readDesk(storage);
  if (after.stock_order?.client_order_id === o.client_order_id) {
    Object.assign(after.stock_order, result.ok ? { status: 'placed', receipt: result.receipt } : { status: result.unclear ? 'unclear' : 'failed', detail: result.detail });
    await saveDesk(storage, after);
  }
  if (!result.ok) return { ok: false, unclear: Boolean(result.unclear), reply: result.detail };
  return { ok: true, receipt: result.receipt, reply: `Sent to ${STOCK_ACCOUNT}, sir: ${describeStock(o.order)}. ${speakStockReceipt(result.receipt)}` };
}
