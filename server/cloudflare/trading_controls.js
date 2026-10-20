// Strategy Control Center (owner, 2026-10-20): the owner's limits on CHE's forward-paper
// strategies, enforced where entries happen (liveTick → stepPortfolio's gate), not only shown.
//
// PAPER only. Nothing here can place an order: the only broker actions are cancelling unfilled
// Alpaca PAPER orders on Emergency Stop and closing Alpaca PAPER positions on a confirmed Flatten.
// Every change is one audit record (who, when, what, effect). A change that raises risk is
// returned as a confirmation summary first and applied only when confirmed. A quota is a ceiling,
// never a target: a strategy enters only on its own valid signal, and every blocked or void signal
// is kept with its reason.
import { INTRADAY_CANDIDATES, INTRADAY_COMMON_RULES, INTRADAY_FILTERS, MIN_TRADES, summarize, tradeDayOf } from './trading_evidence.js';

export const CONTROLS = 'trading_controls';
export const DEFAULT_MAX_PER_DAY = 30;
const AUDIT_LIMIT = 300;

// The ranges the owner can set; outside them a change is refused with the range named.
export const RANGES = Object.freeze({
  max_per_day: [0, 200],
  qty: [1, 10],
  max_daily_loss: [50, 20000],
  max_open_positions: [1, 60],
  max_order_qty: [1, 1000],
  cooldown_min: [0, 240],
});
const RAISES = { max_per_day: 1, qty: 1, max_daily_loss: 1, max_open_positions: 1, max_order_qty: 1, cooldown_min: -1 };
export const FIELD_LABEL = Object.freeze({
  max_per_day: 'maximum trades per day',
  qty: 'contracts per trade',
  max_daily_loss: 'maximum daily loss',
  max_open_positions: 'maximum open positions',
  max_order_qty: 'maximum order size',
  cooldown_min: 'cooldown after a closed trade (minutes)',
});
const ACCOUNT_FIELDS = ['max_daily_loss', 'max_open_positions', 'max_order_qty', 'cooldown_min'];
const STRATEGY_FIELDS = ['max_per_day', 'qty'];

export const strategyName = (id) => INTRADAY_CANDIDATES[id]?.name || id;

export function defaultControls() {
  return {
    paused_all: false,
    stop_new_entries: false,
    emergency: null,
    account: { max_daily_loss: 1000, max_open_positions: 30, max_order_qty: 100, cooldown_min: 0 },
    strategies: Object.fromEntries(Object.keys(INTRADAY_CANDIDATES).map((id) => [id, { max_per_day: DEFAULT_MAX_PER_DAY, qty: 1, paused: false, disabled: false }])),
    previous: null,
    audit: [],
    updated_at: null,
  };
}

/** The saved controls over the defaults: a strategy added later starts at the defaults. */
export async function readControls(storage) {
  const saved = (await storage.get(CONTROLS)) || {};
  const base = defaultControls();
  const strategies = {};
  for (const id of Object.keys(base.strategies)) strategies[id] = { ...base.strategies[id], ...(saved.strategies?.[id] || {}) };
  return { ...base, ...saved, account: { ...base.account, ...(saved.account || {}) }, strategies, audit: saved.audit || [] };
}

const snapshot = (c) => ({ paused_all: c.paused_all, stop_new_entries: c.stop_new_entries, emergency: c.emergency, account: { ...c.account }, strategies: structuredClone(c.strategies) });

/** Which strategy ids a scope names: 'all', a strategy id, or 'family:ICT'. */
export function scopeIds(scope) {
  const ids = Object.keys(INTRADAY_CANDIDATES);
  if (!scope || scope === 'all') return ids;
  if (String(scope).startsWith('family:')) {
    const family = String(scope).slice(7).toLowerCase();
    return ids.filter((id) => String(INTRADAY_CANDIDATES[id].family || '').toLowerCase() === family);
  }
  return ids.includes(scope) ? [scope] : [];
}
const scopeLabel = (scope) => (!scope || scope === 'all' ? 'every strategy' : String(scope).startsWith('family:') ? `the ${String(scope).slice(7)} strategies` : strategyName(scope));

/**
 * What a change would do, without saving it: the next controls, plain-English effects, and the
 * ways it raises risk (which need the owner's confirmation). Never throws; a bad change says why.
 */
export function planControlChange(current, change = {}) {
  const next = snapshot(current);
  const effects = [];
  const raises = [];
  const kind = String(change.kind || '');
  const ids = scopeIds(change.scope);
  const needIds = () => (ids.length ? '' : `I do not have a strategy called ${change.scope}.`);
  switch (kind) {
    case 'set': {
      const field = String(change.field || '');
      const value = Number(change.value);
      if (!RANGES[field]) return { error: `I cannot set ${field || 'that'}.` };
      const [lo, hi] = RANGES[field];
      if (!Number.isInteger(value) || value < lo || value > hi) return { error: `The ${FIELD_LABEL[field]} must be a whole number from ${lo} to ${hi}. Nothing was changed.` };
      if (ACCOUNT_FIELDS.includes(field)) {
        const before = next.account[field];
        if (before === value) return { error: `The ${FIELD_LABEL[field]} is already ${value}. Nothing was changed.` };
        next.account[field] = value;
        effects.push(`Account ${FIELD_LABEL[field]}: ${before} → ${value}.`);
        if ((value - before) * RAISES[field] > 0) raises.push(impactLine(field, before, value, 'the account'));
      } else {
        if (needIds()) return { error: needIds() };
        if (field === 'qty' && value > next.account.max_order_qty) return { error: `That is above the account's maximum order size of ${next.account.max_order_qty}. Nothing was changed.` };
        for (const id of ids) {
          const before = next.strategies[id][field];
          if (before === value) continue;
          next.strategies[id][field] = value;
          effects.push(`${strategyName(id)}: ${FIELD_LABEL[field]} ${before} → ${value}.`);
          if ((value - before) * RAISES[field] > 0) raises.push(impactLine(field, before, value, strategyName(id)));
        }
        if (!effects.length) return { error: `${scopeLabel(change.scope)} already ${ids.length > 1 ? 'have' : 'has'} ${FIELD_LABEL[field]} ${value}. Nothing was changed.` };
      }
      break;
    }
    case 'pause':
    case 'resume': {
      const paused = kind === 'pause';
      if (!change.scope || change.scope === 'all') {
        if (next.paused_all === paused && ids.every((id) => next.strategies[id].paused === paused)) return { error: `Every strategy is already ${paused ? 'paused' : 'running'}. Nothing was changed.` };
        next.paused_all = paused;
        for (const id of ids) next.strategies[id].paused = paused;
        effects.push(paused ? 'Every strategy is paused: no new entries. Open positions keep their stops and targets.' : 'Every strategy is resumed: each enters again only on its own valid signal.');
      } else {
        if (needIds()) return { error: needIds() };
        for (const id of ids) {
          if (next.strategies[id].paused === paused) continue;
          next.strategies[id].paused = paused;
          effects.push(`${strategyName(id)} ${paused ? 'paused: no new entries' : 'resumed'}.`);
        }
        if (!effects.length) return { error: `${scopeLabel(change.scope)} ${ids.length > 1 ? 'are' : 'is'} already ${paused ? 'paused' : 'running'}. Nothing was changed.` };
        if (!paused && next.paused_all) effects.push('Note: all strategies are still paused, so this takes effect when you resume all.');
      }
      if (!paused) raises.push(`${scopeLabel(change.scope)} can enter new paper trades again.`);
      break;
    }
    case 'disable':
    case 'enable': {
      if (needIds()) return { error: needIds() };
      const disabled = kind === 'disable';
      for (const id of ids) {
        if (next.strategies[id].disabled === disabled) continue;
        next.strategies[id].disabled = disabled;
        effects.push(`${strategyName(id)} ${disabled ? 'disabled (override): it takes no entries until enabled' : 'enabled'}.`);
      }
      if (!effects.length) return { error: `${scopeLabel(change.scope)} ${ids.length > 1 ? 'are' : 'is'} already ${disabled ? 'disabled' : 'enabled'}. Nothing was changed.` };
      if (!disabled) raises.push(`${scopeLabel(change.scope)} can enter new paper trades again.`);
      break;
    }
    case 'stop_entries':
      if (next.stop_new_entries) return { error: 'New entries are already stopped. Nothing was changed.' };
      next.stop_new_entries = true;
      effects.push('New entries are stopped for every strategy. Open positions keep their stops and targets.');
      break;
    case 'allow_entries':
      if (!next.stop_new_entries && !next.emergency) return { error: 'New entries are already allowed. Nothing was changed.' };
      next.stop_new_entries = false;
      if (next.emergency) effects.push('Emergency Stop is cleared.');
      next.emergency = null;
      effects.push('New entries are allowed again; each strategy enters only on its own valid signal.');
      raises.push('CHE\'s paper strategies can enter new trades again.');
      break;
    case 'emergency_stop':
      next.stop_new_entries = true;
      next.emergency = { at: change.at || new Date().toISOString(), by: change.who || 'owner' };
      effects.push('Emergency Stop: new entries are blocked for every strategy and unfilled paper orders are being cancelled.');
      break;
    case 'flatten':
      effects.push('Flatten: every open paper position is closed and unfilled paper orders are cancelled. New entries stay as they are.');
      raises.push('Every open paper position is closed now, at whatever the market gives (Alpaca paper) or as a voided record (CHE\'s MNQ simulations).');
      break;
    case 'restore':
      if (!current.previous) return { error: 'There is no earlier setting to restore. Nothing was changed.' };
      Object.assign(next, structuredClone(current.previous));
      effects.push('The settings before the last change are restored.');
      for (const field of ACCOUNT_FIELDS) {
        const b = current.account[field]; const a = next.account[field];
        if (a !== b) { effects.push(`Account ${FIELD_LABEL[field]}: ${b} → ${a}.`); if ((a - b) * RAISES[field] > 0) raises.push(impactLine(field, b, a, 'the account')); }
      }
      for (const id of Object.keys(next.strategies)) {
        const b = current.strategies[id] || {}; const a = next.strategies[id];
        for (const field of STRATEGY_FIELDS) {
          if (a[field] !== b[field]) { effects.push(`${strategyName(id)}: ${FIELD_LABEL[field]} ${b[field]} → ${a[field]}.`); if ((a[field] - b[field]) * RAISES[field] > 0) raises.push(impactLine(field, b[field], a[field], strategyName(id))); }
        }
        if ((b.paused && !a.paused) || (b.disabled && !a.disabled)) raises.push(`${strategyName(id)} can enter new paper trades again.`);
      }
      if ((current.paused_all && !next.paused_all) || (current.stop_new_entries && !next.stop_new_entries)) raises.push('CHE\'s paper strategies can enter new trades again.');
      break;
    default:
      return { error: `I do not know the control "${kind}".` };
  }
  return { next, effects, raises, kind, scope: change.scope || 'all' };
}

function impactLine(field, before, after, who) {
  if (field === 'max_per_day') return `${who}: up to ${after - before} more paper entries a day (${before} → ${after}).`;
  if (field === 'qty') return `${who}: each trade's size and its dollar risk become ${r2(after / before)} times larger (${before} → ${after} MNQ).`;
  if (field === 'max_daily_loss') return `${who}: CHE may lose up to $${after.toLocaleString('en-US')} in a day before blocking entries, up from $${before.toLocaleString('en-US')}.`;
  if (field === 'max_open_positions') return `${who}: up to ${after} positions open at once, up from ${before}.`;
  if (field === 'max_order_qty') return `${who}: a single order may be up to ${after}, up from ${before}.`;
  if (field === 'cooldown_min') return `${who}: the wait after a closed trade drops from ${before} to ${after} minutes.`;
  return `${who}: ${FIELD_LABEL[field]} ${before} → ${after}.`;
}
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Apply a change for `who`. A risk increase without `confirm` returns needs_confirmation and the
 * impact, and saves nothing. Every applied change is one audit record; the settings before it are
 * kept so "restore previous settings" can undo it.
 */
export async function applyControlChange(storage, change, { who = 'owner', confirm = false, now = Date.now() } = {}) {
  const current = await readControls(storage);
  const at = new Date(now).toISOString();
  const plan = planControlChange(current, { ...change, at, who });
  if (plan.error) return { ok: false, error: plan.error, controls: current };
  if (plan.raises.length && !confirm) {
    return { ok: false, needs_confirmation: true, summary: plan.effects, impact: plan.raises, change, controls: current };
  }
  const record = { at, who, action: plan.kind, scope: plan.scope, summary: plan.effects.join(' '), effect: plan.effects, raised_risk: plan.raises.length > 0, confirmed: plan.raises.length > 0 ? true : undefined };
  const saved = { ...plan.next, previous: plan.kind === 'restore' ? null : snapshot(current), audit: [...current.audit, record].slice(-AUDIT_LIMIT), updated_at: at };
  await storage.put(CONTROLS, saved);
  return { ok: true, record, controls: await readControls(storage) };
}

/** Add effects measured after an action (orders cancelled, positions still open) to its audit record. */
export async function noteAuditEffect(storage, at, lines) {
  const c = await readControls(storage);
  const audit = c.audit.map((r) => (r.at === at ? { ...r, effect: [...(r.effect || []), ...lines], summary: [r.summary, ...lines].join(' ') } : r));
  await storage.put(CONTROLS, { ...c, audit });
}

// Days are CME trading days (18:00 New York to 17:00), the same day the strategies trade by.
const dayOf = (info) => info.day ?? tradeDayOf(info.time);

/**
 * The entry gate stepPortfolio asks before a signal becomes an order (stage 'signal') and before
 * that order fills (stage 'fill'). It returns null to allow or the plain reason it was blocked.
 * `account` carries today's realized net and the open-position count from the tick.
 */
export function makeEntryGate(controls, account = {}) {
  const state = { open: account.open_positions || 0 };
  return (pf, info) => {
    const s = controls.strategies[pf.candidate] || { max_per_day: DEFAULT_MAX_PER_DAY, qty: 1 };
    if (controls.emergency) return 'Emergency Stop is on';
    if (controls.stop_new_entries) return 'new entries are stopped';
    if (s.disabled) return 'this strategy is disabled';
    if (controls.paused_all) return 'all strategies are paused';
    if (s.paused) return 'this strategy is paused';
    if (info.stage === 'fill') return null;
    const day = dayOf(info);
    const today = pf.day_entries?.day === day ? pf.day_entries.n : 0;
    if (today >= s.max_per_day) return `its daily maximum of ${s.max_per_day} entries was reached`;
    if (Number.isFinite(account.realized_today) && account.realized_today <= -controls.account.max_daily_loss) return `the account's maximum daily loss of $${controls.account.max_daily_loss} was reached`;
    if (state.open >= controls.account.max_open_positions) return `the account's maximum of ${controls.account.max_open_positions} open positions was reached`;
    if ((pf.qty || 1) > controls.account.max_order_qty) return `its size of ${pf.qty} is above the account's maximum order size of ${controls.account.max_order_qty}`;
    const cool = controls.account.cooldown_min * 60;
    if (cool > 0 && pf.last_exit_time != null && (Date.parse(info.time) - Date.parse(pf.last_exit_time)) / 1000 < cool) return `it is inside the ${controls.account.cooldown_min}-minute cooldown after its last trade`;
    pf.day_entries = { day, n: today + 1 };
    state.open += 1;
    return null;
  };
}

/**
 * A paper stock order checked against the controls before it reaches Alpaca: Emergency Stop and
 * stopped entries, the maximum order size, a repeat of the same order within a minute, and (for a
 * limit buy) the buying power. Returns the reason it is refused, or ''.
 */
export function stockOrderProblem(controls, order = {}, { journal = [], buyingPower = null, now = Date.now() } = {}) {
  if (controls.emergency) return 'Emergency Stop is on, so no new paper order was sent. Say "allow new entries" to clear it.';
  if (controls.stop_new_entries) return 'New entries are stopped, so no new paper order was sent. Say "allow new entries" to lift it.';
  const qty = Number(order.qty);
  if (qty > controls.account.max_order_qty) return `${qty} shares is above your maximum order size of ${controls.account.max_order_qty}, so nothing was sent.`;
  const symbol = String(order.symbol || '').toUpperCase();
  const side = String(order.side || '').toLowerCase();
  const recent = journal.find((r) => r.symbol === symbol && r.side === side && Number(r.qty) === qty && now - Date.parse(r.recorded_at || 0) < 60_000);
  if (recent) return `The same order (${side} ${qty} ${symbol}) was sent less than a minute ago, so this repeat was not sent.`;
  const limit = Number(order.limit_price);
  if (side === 'buy' && Number.isFinite(limit) && limit > 0 && Number.isFinite(buyingPower) && qty * limit > buyingPower) {
    return `That needs about $${r2(qty * limit).toLocaleString('en-US')} and the paper account has $${r2(buyingPower).toLocaleString('en-US')} of buying power, so nothing was sent.`;
  }
  return '';
}

/** One line per strategy for the control screen and for speech: limit, today's entries, state. */
export function controlsView(controls, portfolios = [], now = Date.now()) {
  const day = tradeDayOf(now);
  return Object.keys(controls.strategies).map((id) => {
    const s = controls.strategies[id];
    const mine = portfolios.filter((pf) => pf.candidate === id);
    const entries = mine.reduce((n, pf) => n + (pf.day_entries?.day === day ? pf.day_entries.n : 0), 0);
    const skips = mine.flatMap((pf) => (pf.skips || []).map((k) => ({ ...k, variant: `${pf.filter}${pf.params?.target_r ? ` ${pf.params.target_r}R` : ''}` })))
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    const state = controls.emergency ? 'emergency stop' : controls.stop_new_entries ? 'entries stopped' : s.disabled ? 'disabled' : (controls.paused_all || s.paused) ? 'paused' : 'running';
    return {
      id, name: strategyName(id), family: INTRADAY_CANDIDATES[id].family || '', state, ...s,
      variants: mine.length, entries_today: entries,
      signals_today: mine.reduce((n, pf) => n + (pf.signals || []).filter((x) => tradeDayOf(x.time) === day).length, 0), open_positions: mine.filter((pf) => pf.open).length,
      signals_total: mine.reduce((n, pf) => n + (pf.counts?.signals || 0), 0),
      skipped_total: mine.reduce((n, pf) => n + (pf.counts?.skipped || 0), 0),
      recent_skips: skips.slice(0, 5),
    };
  });
}

// ─── Owner words (voice or typed) → one control change ─────────────────────────────────────────
// Called by the trading desk's own intent parser (trading_desk.js deskIntent), so there is no
// second router. A question about a control ("what does Emergency Stop do?") is not a command.
const NAMES = [
  [/\bict\b/, 'family:ICT'],
  [/\bema\b|\bpullback\b/, 'ema-pullback-5m'],
  [/\brsi\b/, 'rsi-revert-5m'],
  [/\bvwap\b/, 'vwap-revert-5m'],
  [/\bopening range\b|\borb\b/, 'orb-15m'],
  [/\bsilver bullet\b/, 'silver-bullet-5m'],
  [/\border blocks?\b/, 'order-block-5m'],
  [/\bfair value gap\b|\bfvg\b/, 'fvg-retest-5m'],
  [/\bprevious[- ]day (?:high|low)\b|\bpdh|\bpdl/, 'pdhl-sweep-5m'],
  [/\bstructure shift\b|\bmss\b/, 'sweep-mss-5m'],
  [/\bsweep and reclaim\b|\breclaim\b/, 'sweep-reclaim-5m'],
];
export function scopeFromWords(text) {
  if (/\b(?:all|every|each|everything)\b/.test(text)) return 'all';
  for (const [re, id] of NAMES) if (re.test(text)) return id;
  return '';
}
const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100 };
const numberIn = (text) => {
  const m = /\b(\d{1,4})\b/.exec(text);
  if (m) return Number(m[1]);
  for (const [w, n] of Object.entries(NUMBER_WORDS).sort((a, b) => b[0].length - a[0].length)) if (new RegExp(`\\b${w}\\b`).test(text)) return n;
  return null;
};

export function controlIntent(message) {
  const text = String(message || '').toLowerCase().replace(/[’']/g, "'").replace(/^\s*(?:hey\s+)?(?:che|chey|chay)[,\s]+/, '');
  // The strategy simulation (che_strategy_sim) has its own pause, resume and status words.
  if (/\bsim(?:ulation)?s?\b/.test(text) && !/\b(?:ict|ema|emergency|kill switch|entries)\b/.test(text)) return null;
  const question = /^\s*(?:what|how|is|are|does|do|can|could|explain|tell me what)\b/.test(text);
  const trading = /\b(?:strateg(?:y|ies)|ict|ema|rsi|vwap|entries|entry|trades?|trading|positions?|orders?|silver bullet|order blocks?|fvg|opening range)\b/.test(text);
  if (/\bwhy\b[\s\S]{0,60}\b(?:skip(?:ped)?|did ?n[o']t (?:take|enter|trade)|no trades?|not trade|blocked)\b/.test(text) && trading) {
    return { kind: 'controls_why', scope: scopeFromWords(text) };
  }
  if (question) {
    if (/\b(?:trading |strategy )?(?:limits|controls)\b/.test(text) && trading) return { kind: 'controls_view' };
    return null;
  }
  if (/\b(?:emergency stop|kill switch)\b/.test(text) && !/\b(?:clear|lift|reset|turn off|cancel the)\b/.test(text)) return { kind: 'controls', change: { kind: 'emergency_stop' } };
  if (/\b(?:clear|lift|reset|turn off)\b[\s\S]{0,15}\b(?:emergency stop|kill switch)\b|\b(?:allow|resume|restart|turn on)\b[\s\S]{0,10}\b(?:all\s+)?new (?:entries|trades)\b/.test(text)) return { kind: 'controls', change: { kind: 'allow_entries' } };
  if (/\bstop\b[\s\S]{0,10}\b(?:all\s+)?new (?:entries|trades)\b|\bno (?:more )?new (?:entries|trades)\b/.test(text)) return { kind: 'controls', change: { kind: 'stop_entries' } };
  if (/\bflatten\b/.test(text) && trading) return { kind: 'controls', change: { kind: 'flatten' } };
  if (/\b(?:restore|undo|revert)\b[\s\S]{0,30}\b(?:settings?|change|controls?|limits?)\b/.test(text) && (trading || /\bsettings?\b/.test(text))) return { kind: 'controls', change: { kind: 'restore' } };
  if (!trading) return null;
  const scope = scopeFromWords(text);
  const pause = /\b(?:pause|hold)\b/.test(text) ? 'pause' : /\b(?:resume|unpause)\b/.test(text) ? 'resume' : '';
  if (pause && /\bstrateg(?:y|ies)\b|\bict\b|\bema\b/.test(text)) return { kind: 'controls', change: { kind: pause, scope: scope || 'all' } };
  if (/\b(?:disable|turn off|switch off)\b/.test(text) && scope && scope !== 'all') return { kind: 'controls', change: { kind: 'disable', scope } };
  if (/\b(?:enable|turn on|switch on)\b/.test(text) && scope && scope !== 'all') return { kind: 'controls', change: { kind: 'enable', scope } };
  const perDay = /\b(?:max(?:imum)?|limit|cap)\b[\s\S]{0,25}\btrades?\b|\btrades?\s+(?:per|a|each)\s+day\b|\b(?:per|a|each)\s+day\b/.test(text);
  const size = /\b(?:size|contracts?|quantity|qty)\b/.test(text);
  if (perDay || size) {
    const field = perDay ? 'max_per_day' : 'qty';
    const n = numberIn(text);
    if (/\b(?:set|make|change|put)\b/.test(text) && n != null) return { kind: 'controls', change: { kind: 'set', scope: scope || 'all', field, value: n } };
    const up = /\b(?:increase|raise|more|up)\b/.test(text); const down = /\b(?:decrease|lower|reduce|less|fewer|down)\b/.test(text);
    if (up || down) return { kind: 'controls', change: { kind: 'step', scope: scope || 'all', field, by: (up ? 1 : -1) * (n ?? (field === 'qty' ? 1 : 5)) } };
  }
  return null;
}

/** A relative change ("increase the maximum trades") becomes the exact value for each strategy. */
export function resolveStep(controls, change) {
  if (change.kind !== 'step') return change;
  const ids = scopeIds(change.scope);
  const values = [...new Set(ids.map((id) => controls.strategies[id][change.field]))];
  const [lo, hi] = RANGES[change.field];
  if (values.length !== 1) return { ...change, kind: 'set', value: NaN, error: `Those strategies have different ${FIELD_LABEL[change.field]} settings (${values.join(', ')}). Say the number you want, for example "set every strategy to 30 per day".` };
  return { kind: 'set', scope: change.scope, field: change.field, value: Math.max(lo, Math.min(hi, values[0] + change.by)) };
}

export function speakControlsView(view, controls) {
  const head = controls.emergency ? `Emergency Stop is on since ${controls.emergency.at}. ` : controls.stop_new_entries ? 'New entries are stopped. ' : controls.paused_all ? 'All strategies are paused. ' : '';
  const lines = view.map((r, i) => `${i + 1}, ${r.name}${r.family === 'ICT' ? ' (ICT)' : ''}: ${r.state}, ${r.entries_today} of ${r.max_per_day} entries today, ${r.qty} MNQ`);
  return `${head}Your paper strategy limits, sir. ${lines.join('. ')}. Account: maximum daily loss $${controls.account.max_daily_loss}, at most ${controls.account.max_open_positions} open positions, maximum order size ${controls.account.max_order_qty}. Paper only; live trading is off.`;
}

export function speakSkipReasons(view, scope) {
  const rows = scope && scope !== 'all' ? view.filter((r) => scopeIds(scope).includes(r.id)) : view;
  const skips = rows.flatMap((r) => r.recent_skips.map((k) => ({ ...k, name: r.name }))).sort((a, b) => String(b.time).localeCompare(String(a.time)));
  if (!skips.length) return `There is no skipped signal on record${rows.length === 1 ? ` for ${rows[0].name}` : ''}, sir. A strategy only enters on its own valid signal, so a quiet day can simply mean no signal formed.`;
  const k = skips[0];
  const more = skips.slice(1, 3).map((x) => `${x.name} at ${x.time}: ${x.reason}`);
  return `The latest skipped signal: ${k.name} at ${k.time}, ${k.side}${k.why ? ` (${k.why})` : ''}. Why: ${k.reason}.${more.length ? ` Before that: ${more.join('; ')}.` : ''}`;
}

export function speakControlResult(result) {
  if (result.needs_confirmation) {
    return `This raises risk, sir. ${result.summary.join(' ')} Impact: ${result.impact.join(' ')} Say "yes, confirm" to apply it, or "no" to leave everything as it is. Nothing has changed yet.`;
  }
  if (!result.ok) return result.error;
  return `Done, sir. ${result.record.effect.join(' ')}`;
}

// ─── Strategy registry (owner, 2026-10-20) ──────────────────────────────────────────────────────
// What each strategy is, from its own code: rules, timeframe, data, variants, limits, paper and
// backtest results. A strategy is in the ICT group only when its written rules implement an ICT
// concept; a concept with no implementing strategy is listed as not implemented, never implied.
export const ICT_CONCEPTS = Object.freeze([
  { id: 'mss', name: 'Market structure shift / break of structure', strategies: ['sweep-mss-5m', 'sweep-reclaim-5m'] },
  { id: 'sweep', name: 'Liquidity sweeps', strategies: ['sweep-mss-5m', 'sweep-reclaim-5m', 'pdhl-sweep-5m'] },
  { id: 'fvg', name: 'Fair value gaps', strategies: ['fvg-retest-5m', 'silver-bullet-5m'] },
  { id: 'order_block', name: 'Order blocks', strategies: ['order-block-5m'] },
  { id: 'displacement', name: 'Displacement (a bar body of at least 1.5 ATR)', strategies: ['order-block-5m'] },
  { id: 'ny_session', name: 'New York session filter (Silver Bullet: 10:00–11:00 and 14:00–15:00)', strategies: ['silver-bullet-5m'] },
  { id: 'london_session', name: 'London session filter', strategies: [], note: 'Not implemented: no strategy filters on the London session yet.' },
  { id: 'premium_discount', name: 'Premium / discount (dealing range)', strategies: [], note: 'Not implemented: no strategy checks premium or discount yet.' },
]);

const DATA_SOURCE = 'Yahoo MNQ=F 1-minute bars built into 5-minute bars (DELAYED public data). Paper only.';

export function strategyRegistry({ specs = [], trades = [], backtest = null } = {}) {
  const out = {};
  for (const [id, c] of Object.entries(INTRADAY_CANDIDATES)) {
    const mine = specs.filter((x) => x.c === id);
    const targets = [...new Set(mine.map((x) => x.target_r))];
    const paper = summarize(trades.filter((t) => t.strategy === id));
    const bt = (backtest?.rows || []).filter((r) => r.strategy === id).map((r) => ({
      variant: `${INTRADAY_FILTERS[r.filter]?.name || r.filter}, ${r.target_r}R`, trades: r.stats.trades, net_pnl: r.stats.net_pnl,
      expectancy_r: r.stats.expectancy_r, oos_trades: r.oos?.trades ?? null, oos_expectancy_r: r.oos?.expectancy_r ?? null,
    }));
    out[id] = {
      description: c.name,
      rules: c.rules,
      common_rules: INTRADAY_COMMON_RULES,
      target: id === 'vwap-revert-5m' ? 'VWAP' : `${targets.map((t) => `${t}R`).join(' or ')} (a multiple of the risk to the stop)`,
      exit: `At the stop, at the target, or flat by ${c.flat != null ? '15:55' : '16:55'} New York, whichever comes first.`,
      timeframe: id === 'orb-15m' ? '5-minute bars; the range is 9:30–9:45 New York' : '5-minute bars',
      data: DATA_SOURCE,
      variants: mine.map((x) => `${INTRADAY_FILTERS[x.f]?.name || x.f}, ${x.target_r}R`),
      ict_concepts: ICT_CONCEPTS.filter((k) => k.strategies.includes(id)).map((k) => k.name),
      paper: { trades: paper.trades, wins: paper.wins, losses: paper.losses, net_pnl: paper.net_pnl, expectancy_r: paper.expectancy_r, enough: paper.trades >= MIN_TRADES, min_trades: MIN_TRADES },
      backtest: bt.length ? { at: backtest.at, data: backtest.data, variants: bt } : null,
    };
  }
  return out;
}
