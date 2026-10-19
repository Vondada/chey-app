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
  if (a.status === 'pending') return `Trade alert, sir, good entry on your LIVE account${a.account ? ` ${a.account}` : ''}: ${describe(a)}${a.why ? `, because it ${a.why}` : ''}. Real money. Say "take the trade" to place it, or "skip it".`;
  return '';
}

// ─── Voice ───────────────────────────────────────────────────────────────

export function deskIntent(message) {
  const text = String(message || '').toLowerCase().replace(/[’']/g, "'");
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
  if (/^\s*(?:yes[,!.]?\s+)?(?:take|place|enter|send)\s+(?:the|that|this)\s+trade\b|^\s*confirm\s+(?:the|that)\s+trade\b|^\s*yes[,!.]?\s+(?:take|place)\s+it\b/.test(text)) return { kind: 'take' };
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

/** Owner said "take the trade": place the newest pending alert in the current mode. */
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
