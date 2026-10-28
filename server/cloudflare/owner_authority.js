// Live owner authority: the owner's own rules for what CHE may do, set and changed by ordinary words (voice or typed) and
// enforced in code at the action boundary. A rule is data in Durable Object storage, so it survives a restart, and nothing
// here reads or depends on a model, so switching models cannot change or bypass it.
//
// Rules the owner sets:
//   - a deny rule (a prohibition) blocks the capability at once, for good or until its time runs out;
//   - an ask rule keeps the normal hold: CHE asks the owner's yes before acting;
//   - an allow rule releases the capability once (one_time), for a task or a time window (timed, task, session), or, for
//     money-free capabilities only, permanently. A money allow carries a spending limit and is used up by each spend.
// Standing owner rules that no command can lift: CHE never spends, transfers, buys, subscribes or signs up without a yes,
// and never keeps a standing approval to spend, delete or sign up (permanent allows for money, delete and signup are refused).
// A change that grants an allow is held until the owner's own yes on his device. Revoking or denying takes effect at once.

export const AUTHORITY_KEY = 'che:owner_authority:v1';
export const AUTHORITY_PENDING_KEY = 'che:owner_authority:pending';
export const AUTHORITY_PENDING_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 40;
const SESSION_MS = 12 * 60 * 60 * 1000;
const TASK_MS = 60 * 60 * 1000;
const MAX_TIMED_MS = 24 * 60 * 60 * 1000;
const STANDING_NO_ALLOW = new Set(['money', 'delete', 'signup']);
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, sixty: 60, half: 0.5 };

const norm = (text) => String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/^(?:hey |ok |okay )?(?:che|chay|chey)[,:]?\s+/, '').replace(/\s+/g, ' ').trim();

/** Empty authority state. */
export function emptyAuthority() {
  return { v: 1, rules: [], history: [], last_subject: null, last_decision: null, previous: null };
}

export async function loadAuthority(storage) {
  try { return { ...emptyAuthority(), ...((await storage.get(AUTHORITY_KEY)) || {}) }; } catch (_) { return emptyAuthority(); }
}

export async function saveAuthority(storage, state) {
  await storage.put(AUTHORITY_KEY, { ...state, history: state.history.slice(-HISTORY_LIMIT) });
}

/** The capability a sentence is about: money, delete, signup, app, or null when none is named. */
export function capabilityOf(text) {
  const t = norm(text);
  if (/\b(?:sign up|sign me up|create an account|make an account|register me)\b/.test(t)) return 'signup';
  if (/\b(?:delete|remove|erase|wipe|discard|uninstall)\b/.test(t)) return 'delete';
  if (/\b(?:buy|buying|purchase|spend|spending|pay|paying|subscribe|subscription|transfer|wire|donate|sell)\b/.test(t) || /\border\b(?! (?:to|of|by|in|that)\b)/.test(t)) return 'money';
  if (/\b(?:open|launch)\b/.test(t) && /\bapp\b/.test(t)) return 'app';
  return null;
}

/** The dollar amount a sentence names ("$40", "40 dollars", "40 bucks"), or null. */
export function amountOf(text) {
  const t = norm(text);
  const m = /\$\s?(\d[\d,]*(?:\.\d+)?)/.exec(t) || /(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|bucks|usd)\b/.exec(t);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** A duration in ms from "30 minutes", "one hour", "half an hour", "2 hours". Null when none is named. */
export function durationOf(text) {
  const t = norm(text);
  const m = /\b(?:for|next|in)\s+(?:the\s+next\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|forty|sixty|half)\s+(?:an?\s+)?(minutes?|mins?|hours?|hrs?)|half\s+an?\s+(hour))\b/.exec(t);
  if (!m) return null;
  if (m[3]) return 30 * 60 * 1000;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  const unit = m[2].startsWith('h') ? 60 * 60 * 1000 : 60 * 1000;
  return Math.min(MAX_TIMED_MS, Math.round(n * unit));
}

/**
 * The owner command in a sentence, or null for ordinary chat. Every command needs a word that names a rule or a
 * permission, so "lift the weights for 30 minutes" is not a rule change. Returns { op, effect?, scope?, capability?,
 * duration_ms?, spend_limit_usd?, needs_duration?, raw }.
 */
export function parseAuthorityCommand(text) {
  const t = norm(text);
  if (!t || t.length > 400) return null;
  const NAMES_RULE = /\b(?:restrictions?|rules?|permissions?|authori[sz]ations?|approvals?|settings?|allowances?)\b/;
  const REFERS = /\b(?:this|that|it|the same|those|these)\b/;
  if (/\b(?:what|which) (?:rules? )?(?:changed|changes)\b|\brule history\b|\bshow (?:my )?(?:rule )?(?:changes|history)\b/.test(t) && NAMES_RULE.test(t) || /\brule history\b/.test(t)) return { op: 'history', raw: t };
  if (NAMES_RULE.test(t) && /\b(?:what|which|tell me|list|show|read|all|current|active)\b/.test(t) && !/\b(?:revoke|lift|allow|never|always|remove|restore|make)\b/.test(t)) return { op: 'list', raw: t };
  if (/\bwhy (?:did|do|have) you (?:refuse|hold|held|block|blocked|deny|denied|stop|stopped|decline)\b/.test(t)) return { op: 'why', raw: t };
  if (/\brestore (?:my |the )?(?:previous|last|old|prior|earlier) (?:settings?|rules?|permissions?|authori[sz]ations?)\b/.test(t)) return { op: 'restore', raw: t };
  if (/\b(?:revoke|withdraw|take back)\b/.test(t) && (NAMES_RULE.test(t) || REFERS.test(t))) return { op: 'revoke', capability: capabilityOf(t), raw: t };
  if (/\bnever (?:do|say|use|try|make|send|spend|buy|delete|sign up for) (?:this|that|it|the same|those|these)(?: thing)? again\b|\bnever do that again\b/.test(t)) return { op: 'create', effect: 'deny', scope: 'permanent', capability: capabilityOf(t), raw: t };
  if (/\balways ask me (?:first |before )/.test(t)) return { op: 'create', effect: 'ask', scope: 'permanent', capability: capabilityOf(t), raw: t };
  if (/\bmake (?:this|that|it) a permanent (?:rule|restriction|permission|approval|authori[sz]ation)\b/.test(t)) return { op: 'create', effect: /\b(?:never|don't|do not|stop|no|forbid|prohibit)\b/.test(t) ? 'deny' : 'ask', scope: 'permanent', capability: capabilityOf(t), raw: t, makes_permanent: true };
  if (/\b(?:lift|allow|authori[sz]e|permit|unlock)\b/.test(t) && (REFERS.test(t) || NAMES_RULE.test(t))) {
    const duration = durationOf(t);
    if (/\btemporar(?:y|ily)\b/.test(t) && !duration) return { op: 'create', effect: 'allow', scope: 'timed', capability: capabilityOf(t), needs_duration: true, raw: t };
    if (duration) return { op: 'create', effect: 'allow', scope: 'timed', duration_ms: duration, capability: capabilityOf(t), spend_limit_usd: amountOf(t), raw: t };
    return { op: 'create', effect: 'allow', scope: 'one_time', capability: capabilityOf(t), spend_limit_usd: amountOf(t), raw: t };
  }
  if (/\b(?:you'?re|you are|you have my|i authori[sz]e you to|i allow you to|you may|you can) (?:authori[sz]ed|allowed|permitted|cleared)?\b/.test(t) && /\b(?:authori[sz]ed|allowed|permitted|cleared|go ahead)\b/.test(t) && REFERS.test(t)) {
    return { op: 'create', effect: 'allow', scope: 'one_time', capability: capabilityOf(t), spend_limit_usd: amountOf(t), raw: t };
  }
  return null;
}

/** Drops rules whose time has passed; the owner's prior policy applies again without any action. */
export function pruneExpired(state, now) {
  const kept = state.rules.filter((r) => !r.expires_at || r.expires_at > now);
  if (kept.length === state.rules.length) return state;
  const gone = state.rules.filter((r) => !kept.includes(r)).map((r) => ({ at: now, op: 'expired', rule_id: r.id, capability: r.capability, effect: r.effect, by: 'time', summary: ruleSentence(r) }));
  return { ...state, rules: kept, history: [...state.history, ...gone].slice(-HISTORY_LIMIT) };
}

/** A rule as a plain sentence the owner can hear. */
export function ruleSentence(r) {
  const what = r.capability ? `${r.capability} actions` : 'every action';
  const when = r.expires_at ? `until ${new Date(r.expires_at).toISOString().slice(11, 16)} UTC` : r.scope === 'one_time' ? 'for one use' : r.scope === 'permanent' ? 'permanently' : r.scope;
  const cap = r.spend_limit_usd != null ? ` up to $${r.spend_limit_usd} left $${r.remaining_usd}` : '';
  const verb = { deny: 'Never allowed', ask: 'Always ask first for', allow: 'Allowed' }[r.effect] || r.effect;
  return `${verb}: ${what}, ${when}${cap}. Set on ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
}

/** Creates one rule. Refuses standing allows for money, delete and signup. Returns { rule } or { refused }. */
export function makeRule({ effect, scope, capability = null, duration_ms = null, spend_limit_usd = null, now, source = '' }) {
  if (effect === 'allow' && scope === 'permanent' && STANDING_NO_ALLOW.has(capability)) {
    return { refused: `CHE never keeps a standing approval to ${capability === 'money' ? 'spend or buy' : capability === 'delete' ? 'delete or remove' : 'sign you up for'} anything, sir. Each one needs your yes at the time. Nothing was changed.` };
  }
  if (effect === 'allow' && capability === 'money' && !(spend_limit_usd > 0)) {
    return { refused: 'A money approval needs a spending limit in dollars, sir, like "allow it for 40 dollars for 30 minutes". Nothing was changed.' };
  }
  const expires = scope === 'timed' ? (duration_ms || 30 * 60 * 1000) : scope === 'task' ? TASK_MS : scope === 'session' ? SESSION_MS : null;
  const rule = {
    id: `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    effect, scope, capability,
    created_at: now,
    created_by: 'owner',
    expires_at: expires ? now + expires : null,
    spend_limit_usd: spend_limit_usd ?? null,
    remaining_usd: spend_limit_usd ?? null,
    source: String(source).slice(0, 200),
  };
  return { rule };
}

/**
 * The decision for an action, from the active rules only. A deny always wins. A money allow is used only when its
 * remaining limit covers the amount; an amount that is not named is never allowed. Otherwise the normal hold applies.
 * Returns { decision: 'deny'|'allow'|'ask', rule, reason }.
 */
export function decideAction(state, { capability, text = '', now }) {
  const active = pruneExpired(state, now).rules;
  const cap = capability || capabilityOf(text);
  const applies = (r) => !r.capability || r.capability === cap;
  const deny = active.find((r) => r.effect === 'deny' && applies(r));
  if (deny) return { decision: 'deny', rule: deny, reason: `Your rule says never: ${ruleSentence(deny)}` };
  const allow = active.find((r) => r.effect === 'allow' && r.capability === cap);
  if (allow) {
    if (cap === 'money') {
      const amount = amountOf(text);
      if (amount == null) return { decision: 'ask', rule: null, reason: 'That spend names no amount, so your limit cannot be checked. I need your yes.' };
      if (amount > allow.remaining_usd) return { decision: 'ask', rule: allow, reason: `That is $${amount}, more than the $${allow.remaining_usd} left on your approval. I need your yes.` };
    }
    return { decision: 'allow', rule: allow, reason: `Allowed by your rule: ${ruleSentence(allow)}` };
  }
  const ask = active.find((r) => r.effect === 'ask' && applies(r));
  if (ask) return { decision: 'ask', rule: ask, reason: `Your rule asks first: ${ruleSentence(ask)}` };
  return { decision: 'ask', rule: null, reason: 'No rule covers this, so CHE asks your yes first.' };
}

/** Uses up a one-time allow, or takes its amount off a money allow. Returns the next state. */
export function consumeAllow(state, rule, { amount = null, now }) {
  if (!rule || rule.effect !== 'allow') return state;
  const rules = state.rules.flatMap((r) => {
    if (r.id !== rule.id) return [r];
    if (r.capability === 'money' && amount != null) {
      const remaining = Math.round((r.remaining_usd - amount) * 100) / 100;
      return remaining > 0 ? [{ ...r, remaining_usd: remaining }] : [];
    }
    return r.scope === 'one_time' ? [] : [r];
  });
  return { ...state, rules, history: [...state.history, { at: now, op: 'used', rule_id: rule.id, capability: rule.capability, by: 'action', summary: `Used: ${ruleSentence(rule)}` }].slice(-HISTORY_LIMIT) };
}

/** Records the last decision and the subject it concerned, for "why did you refuse that" and "that" references. */
export function recordDecision(state, { decision, capability, reason, now }) {
  return { ...state, last_subject: capability ? { capability, at: now } : state.last_subject, last_decision: { at: now, decision, capability: capability || null, reason } };
}

/** Plain-sentence list of the rules in force now, for "tell me all your current restrictions". */
export function listRules(state, now) {
  const active = pruneExpired(state, now).rules;
  if (!active.length) return 'You have no rules of your own set right now, sir. CHE still asks your yes before any money, delete or sign-up action.';
  return `You have ${active.length} rule${active.length === 1 ? '' : 's'} in force, sir. ${active.map((r, i) => `${i + 1}. ${ruleSentence(r)}`).join(' ')}`;
}

/** The change history as sentences, newest first, for "what changed" and voice readback. */
export function historySentences(state, limit = 10) {
  return state.history.slice(-limit).reverse().map((h) => `${new Date(h.at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${h.summary || `${h.op} ${h.rule_id || ''}`}`);
}

/**
 * Carries out one owner command and returns the reply. Revokes and denials take effect at once. A grant of an allow is
 * held for the owner's own yes (a confirmation, not a voice check), and a plain yes on a later turn applies it.
 * Returns { text, changed }.
 */
export async function authorityCommandReply(storage, cmd, { now = Date.now() } = {}) {
  let state = pruneExpired(await loadAuthority(storage), now);
  const subject = cmd.capability || state.last_subject?.capability || null;
  const name = subject ? `${subject} actions` : 'that';

  if (cmd.op === 'list') return { text: listRules(state, now), changed: false };
  if (cmd.op === 'why') {
    const d = state.last_decision;
    return { text: d ? `I ${d.decision === 'allow' ? 'let it go ahead' : d.decision === 'deny' ? 'refused it' : 'held it for your yes'}, sir. ${d.reason} That was at ${new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : 'I have no recent refusal or hold recorded, sir.', changed: false };
  }
  if (cmd.op === 'history') return { text: historySentences(state).join(' ') || 'No rule has changed yet, sir.', changed: false };

  if (cmd.op === 'revoke') {
    const matches = state.rules.filter((r) => !subject || !r.capability || r.capability === subject);
    if (!matches.length) return { text: `I have no rule for ${name} to revoke, sir. Nothing changed.`, changed: false };
    if (matches.length > 1 && !subject) return { text: `Which one, sir? ${matches.map((r, i) => `${i + 1}. ${ruleSentence(r)}`).join(' ')} Name the action and I will revoke it.`, changed: false };
    const gone = matches.slice(0, 1);
    state = { ...state, previous: state.rules, rules: state.rules.filter((r) => !gone.includes(r)), history: [...state.history, { at: now, op: 'revoked', rule_id: gone[0].id, capability: gone[0].capability, by: 'owner', summary: `Revoked: ${ruleSentence(gone[0])}` }] };
    await saveAuthority(storage, state);
    return { text: `Revoked, sir. ${ruleSentence(gone[0])} is gone now, and the normal rule applies again.`, changed: true };
  }

  if (cmd.op === 'restore') {
    if (!state.previous) return { text: 'There are no earlier settings to restore, sir. Nothing changed.', changed: false };
    await storage.put(AUTHORITY_PENDING_KEY, { kind: 'restore', rules: state.previous, at: now });
    return { text: 'Say yes to restore your previous rules, sir. Nothing has changed yet.', changed: false };
  }

  // create
  if (cmd.needs_duration) return { text: `For how long, sir? Say, for example, "allow ${name} for 30 minutes".`, changed: false };
  if (!subject) return { text: `Which action, sir? Name it, like "buying", "deleting" or "signing up", and I will set it.`, changed: false };
  if (cmd.effect === 'allow') {
    const duration = cmd.duration_ms ?? null;
    const scope = cmd.scope || 'one_time';
    const made = makeRule({ effect: 'allow', scope, capability: subject, duration_ms: duration, spend_limit_usd: cmd.spend_limit_usd ?? null, now, source: cmd.raw });
    if (made.refused) return { text: made.refused, changed: false };
    const when = made.rule.expires_at ? `until ${new Date(made.rule.expires_at).toISOString().slice(11, 16)} UTC` : 'for one use';
    const cap = cmd.spend_limit_usd != null ? `, up to $${cmd.spend_limit_usd}` : '';
    await storage.put(AUTHORITY_PENDING_KEY, { kind: 'grant', rule: made.rule, at: now });
    return { text: `Say yes to allow ${name} ${when}${cap}, sir. Nothing has changed until you do.`, changed: false };
  }
  const made = makeRule({ effect: cmd.effect, scope: cmd.scope, capability: subject, now, source: cmd.raw });
  if (made.refused) return { text: made.refused, changed: false };
  state = { ...state, previous: state.rules, rules: [...state.rules, made.rule], history: [...state.history, { at: now, op: 'created', rule_id: made.rule.id, capability: subject, by: 'owner', summary: `Set: ${ruleSentence(made.rule)}` }] };
  await saveAuthority(storage, state);
  const word = cmd.effect === 'deny' ? 'Never again' : 'Asking you first';
  return { text: `${word}, sir: ${name}. ${ruleSentence(made.rule)}`, changed: true };
}

/** A pending grant or restore from an earlier turn: applied on the owner's plain yes, dropped on anything else. */
export async function takePendingAuthority(storage, message, { now = Date.now(), isYes }) {
  let pending = null;
  try { pending = await storage.get(AUTHORITY_PENDING_KEY); } catch (_) { return null; }
  if (!pending) return null;
  // Anything other than a yes drops the pending change and lets the message through as ordinary chat.
  await storage.put(AUTHORITY_PENDING_KEY, null);
  if (!isYes(message)) return null;
  if (now - Number(pending.at || 0) > AUTHORITY_PENDING_MS) return { text: 'Nothing changed, sir. The rule was not confirmed in time.', changed: false };
  let state = await loadAuthority(storage);
  if (pending.kind === 'restore') {
    state = { ...state, previous: state.rules, rules: pending.rules.filter((r) => !r.expires_at || r.expires_at > now), history: [...state.history, { at: now, op: 'restored', by: 'owner', summary: 'Restored your previous rules' }] };
    await saveAuthority(storage, state);
    return { text: 'Restored your previous rules, sir.', changed: true };
  }
  const rule = { ...pending.rule, created_at: now, expires_at: pending.rule.expires_at ? now + (pending.rule.expires_at - pending.rule.created_at) : null };
  state = { ...state, previous: state.rules, rules: [...state.rules, rule], history: [...state.history, { at: now, op: 'granted', rule_id: rule.id, capability: rule.capability, by: 'owner', summary: `Granted: ${ruleSentence(rule)}` }] };
  await saveAuthority(storage, state);
  return { text: `Confirmed, sir. ${ruleSentence(rule)}`, changed: true };
}

/**
 * The check at an action boundary (a hold point). Returns { decision, reply } and records the decision. A money allow
 * within its limit is used up here, so the action goes ahead without a second hold; the caller must not ask again.
 */
export async function authorityGate(storage, { text, capability, now = Date.now() }) {
  let state = pruneExpired(await loadAuthority(storage), now);
  const cap = capability || capabilityOf(text);
  if (!cap) return { decision: 'none', reply: '' };
  const result = decideAction(state, { capability: cap, text, now });
  if (result.decision === 'allow') state = consumeAllow(state, result.rule, { amount: cap === 'money' ? amountOf(text) : null, now });
  state = recordDecision(state, { decision: result.decision, capability: cap, reason: result.reason, now });
  await saveAuthority(storage, state);
  return { decision: result.decision, reply: result.decision === 'deny' ? `I will not do that, sir. ${result.reason} Nothing was done.` : '', rule: result.rule };
}
