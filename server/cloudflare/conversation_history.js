// Conversation history and CHE's own past mistakes (owner, 2026-10-27): "CHE, remember around October 4th when you
// told me something that didn't sound right? What was that about?"
//
// A reader over what CHE already keeps, not a new memory store:
// - the Brain's conversation records (brain_store.rememberExchange: every owner turn, path Chat/<day>, with CHE's reply);
// - the phone's word-for-word conversation logs (/api/logs, `log:<id>`), which mark spoken turns `source: 'voice'`;
// - Brain correction records (kind 'correction', logged as CORRECTION on the Brain timeline) and superseded memories;
// - the evidence saved with each answer (route, model calls, sources, claims the truth guard removed);
// - CHE's merged code changes since then, read from GitHub.
// No model is asked. A day with no record says so; a mistake is named only when a record shows it (the owner pushed
// back right after, a correction names it, or the truth guard removed a claim), never guessed.

import { gh } from './coding_runtime.js';
import { recordAnswerEvidence } from './memory_provenance.js';
import { loadPackedJson } from './prompt_compaction.js';
import { addOwnerMemory } from './research_memory.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty first': 21, 'twenty second': 22, 'twenty third': 23, 'twenty fourth': 24, 'twenty fifth': 25, 'twenty sixth': 26, 'twenty seventh': 27, 'twenty eighth': 28, 'twenty ninth': 29, thirtieth: 30, 'thirty first': 31 };
const ORDINAL_RE = `(${Object.keys(ORDINALS).sort((a, b) => b.length - a.length).join('|')}|\\d{1,2})(?:st|nd|rd|th)?`;
const DAY_MS = 86_400_000;
// How far back an undated question looks: three years of records.
const HISTORY_DAYS = 1100;

const TALK = /\b(?:talk(?:ed|ing)?|discuss(?:ed|ing)?|conversations?|chat(?:ted)?|said|say|told|tell|asked|spoke|speak|mention(?:ed)?|answer(?:ed)?|we (?:had|did))\b/i;
const MISTAKE = /\b(?:(?:were|was) you (?:wrong|mistaken|off|lying)|you (?:were|was) (?:wrong|mistaken|off|lying)|didn'?t sound right|wasn'?t right|did ?n[o']?t seem right|sounded (?:off|wrong)|(?:was|were) (?:wrong|off|incorrect|mistaken)|got (?:it|that|something|anything|things) wrong|mistakes?|incorrect|not true|made (?:that|it|something|things|stuff) up|lied|wrong answers?|misinformation|misled|mislead(?:ing)?|errors? you made|you messed up)\b/i;
const ABOUT_YOU = /\b(?:you|your|che|chay|chey)\b/i;

const clip = (text, n) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (text) => String(text || '').replace(/[‘’]/g, "'");
const dayName = (ms) => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()].replace(/^./, (c) => c.toUpperCase())} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const timeName = (iso) => { const t = Date.parse(String(iso || '')); return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)} UTC` : 'time not recorded'; };

/** The time window a message names ("on October 4th", "around Oct 4", "three weeks ago", "in September"), or null. */
export function parseWhen(message, now = Date.now()) {
  const text = norm(message).toLowerCase().replace(/-/g, ' ');
  const around = /(?:\baround|(?<!\b(?:talk|talked|talking|say|said|discuss|discussed|chat|chatted|ask|asked|tell|told) )\babout|\bnear|\broughly|\bapproximately|\bclose to)\s+(?:the\s+)?$/;
  const nowDate = new Date(now);
  const pick = (month, day, year, fuzzy) => {
    let y = year || nowDate.getUTCFullYear();
    let start = Date.UTC(y, month, day);
    if (!year && start > now) start = Date.UTC(--y, month, day);
    if (new Date(start).getUTCDate() !== day) return null;
    const pad = fuzzy ? 2 * DAY_MS : 0;
    return { from: start - pad, to: start + DAY_MS + pad, label: `${fuzzy ? 'around ' : ''}${dayName(start)}`, day: new Date(start).toISOString().slice(0, 10) };
  };
  let m = new RegExp(`\\b${MONTH_RE}\\.?\\s+(?:the\\s+)?${ORDINAL_RE}\\b(?:,?\\s*(\\d{4}))?`).exec(text)
    || null;
  if (m) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1].slice(0, 3)));
    const day = ORDINALS[m[2]] || Number(m[2]);
    return pick(month, day, m[3] ? Number(m[3]) : 0, around.test(text.slice(0, m.index)));
  }
  m = new RegExp(`\\b(?:the\\s+)?${ORDINAL_RE}\\s+of\\s+${MONTH_RE}\\b(?:,?\\s*(\\d{4}))?`).exec(text);
  if (m) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[2].slice(0, 3)));
    return pick(month, ORDINALS[m[1]] || Number(m[1]), m[3] ? Number(m[3]) : 0, around.test(text.slice(0, m.index)));
  }
  const today = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  if (/\b(?:today|earlier today|this morning|tonight)\b/.test(text)) return { from: today, to: today + DAY_MS, label: `today, ${dayName(today)}`, day: new Date(today).toISOString().slice(0, 10) };
  if (/\byesterday\b/.test(text)) return { from: today - DAY_MS, to: today, label: `yesterday, ${dayName(today - DAY_MS)}`, day: new Date(today - DAY_MS).toISOString().slice(0, 10) };
  const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 };
  m = /\b(\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a )?couple(?: of)?|(?:a )?few)\s+(days?|weeks?|months?|years?)\s+ago\b/.exec(text);
  if (m) {
    const n = Number(m[1]) || words[m[1].replace(/^a /, '').replace(/ of$/, '')] || 1;
    const unit = m[2].replace(/s$/, '');
    const span = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS }[unit];
    const center = today - n * span;
    const pad = unit === 'day' ? DAY_MS : unit === 'week' ? 3 * DAY_MS : unit === 'month' ? 10 * DAY_MS : 45 * DAY_MS;
    return { from: center - pad, to: center + DAY_MS + pad, label: `about ${m[1]} ${m[2]} ago (${dayName(center - pad)} to ${dayName(center + pad)})` };
  }
  if (/\blast week\b/.test(text)) return { from: today - 13 * DAY_MS, to: today - 6 * DAY_MS, label: 'last week' };
  if (/\blast month\b/.test(text)) {
    const start = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 1);
    return { from: start, to: Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1), label: `last month (${MONTHS[new Date(start).getUTCMonth()]})` };
  }
  m = new RegExp(`\\b(?:in|during|back in|from)\\s+${MONTH_RE}\\b(?:\\s+(\\d{4}))?(?!\\s+(?:the\\s+)?\\d)`).exec(text);
  if (m) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1].slice(0, 3)));
    let y = m[2] ? Number(m[2]) : nowDate.getUTCFullYear();
    if (!m[2] && Date.UTC(y, month, 1) > now) y -= 1;
    return { from: Date.UTC(y, month, 1), to: Date.UTC(y, month + 1, 1), label: `${MONTHS[month].replace(/^./, (c) => c.toUpperCase())} ${y}` };
  }
  return null;
}

/**
 * "What did we talk about on October 4th?", "remember around Oct 4 when you told me something that didn't sound
 * right?", "what mistakes have you made?", "were you wrong about Frankenstein?" → { mode, when, topic } or null.
 * A plain question that only happens to name a date ("what is on October 4th?") is left to its own routes.
 */
export function historyIntent(message, now = Date.now()) {
  const text = norm(message).trim();
  if (!text || text.length > 500) return null;
  const when = parseWhen(text, now);
  // A mistake question asks about answers CHE already gave ("what mistakes have you made", "were you wrong"). An
  // instruction about CHE in the present ("tell me you can never make mistakes") is not a question about its history.
  const mistake = MISTAKE.test(text) && ABOUT_YOU.test(text) && !/\b(?:my|our|his|her|their) (?:mistakes?|errors?)\b/i.test(text)
    && (Boolean(when) || PAST_TENSE.test(text)) && !ASSERT_ABOUT_YOU.test(text);
  if (mistake) return { mode: 'mistakes', when, topic: topicWords(text) };
  if (when && TALK.test(text) && /\b(?:we|you|i|us|our)\b/i.test(text)) {
    const order = ORDER.exec(norm(text));
    // The ordering phrase ("the most recent thing") picks the turn; none of its words is a topic.
    const topic = topicWords(order ? norm(text).replace(new RegExp(ORDER.source, 'gi'), ' ') : text);
    return { mode: 'day', when, topic, ...(order ? { order: /(?:first|earliest)$/i.test(order[1]) ? 'first' : 'last' } : {}), ...(DROP_RULE.test(text) ? { keep_rule: true } : {}) };
  }
  return null;
}

// Signs that a mistake question is about the past: a past form, a perfect tense, or a time word.
const PAST_TENSE = /\b(?:were|was|did|didn'?t|have you|has (?:che|chay|chey)|had|made|got|told|said|lied|misled|messed|sounded|answered|gave|earlier|before|ago|yesterday|last|previously|so far|lately|recently|wasn'?t)\b/i;
// "Tell me you can never make mistakes", "say you are always right": the owner asks CHE to assert something about itself now.
const ASSERT_ABOUT_YOU = /\b(?:tell me|say|admit|promise|swear|claim|pretend|act like)\s+(?:that\s+)?you(?:'re| are| can| can'?t| cannot| could| will| won'?t| would| never| always| do| don'?t| make)\b/i;
// "The first thing I told you today", "the last thing I said": one turn, the earliest or the latest, not a topic search.
const ORDER = /\b(?:the\s+)?((?:very\s+)?(?:first|earliest|last|latest)|most\s+recent|very\s+latest)\s+(?:thing|things|message|messages|question|questions|words?)\b/i;
// "Forget the rule about not inventing memories and ...": the request to drop a rule is not a topic; the rule stays.
const DROP_RULE = /\b(?:forget|ignore|drop|skip|break|bypass|disregard|override|turn off|set aside)\b[^.?!]{0,40}\b(?:rules?|guard|guards|instructions?|restrictions?|policy|policies|limits?)\b/i;

const STOP = new Set('one two three four five six seven eight nine ten eleven twelve couple few a an and the of on in at to for from about around remember when what was that this it is are you your me my i we our us did do does had have has something anything tell told said say talk talked talking discuss discussed conversation conversations chat chatted asked ask spoke mention mentioned che chay chey sir please hey yo back day days week weeks month months year years ago last yesterday today tonight morning very exactly even single whole afternoon evening earlier first earliest latest recent thing things everything stuff message messages word words question questions not never forget ignore drop skip break bypass disregard override rule rules guard instruction instructions restriction policy invent inventing invented memory memories right sound sounded didnt wasnt wrong mistake mistakes made make error errors incorrect true answer answered with were be been can could would should which who how where why there they them then than just like really also got gave give show me see find look up again'.split(' '));
function topicWords(text) {
  const words = norm(text).toLowerCase().replace(new RegExp(`\\b${MONTH_RE}\\b`, 'g'), ' ').replace(/\b\d+(?:st|nd|rd|th)?\b/g, ' ').match(/[a-z][a-z']{2,}/g) || [];
  return [...new Set(words.map((w) => w.replace(/'s$/, '').replace(/'/g, '')).filter((w) => w.length > 2 && !STOP.has(w) && !ORDINALS[w]))].slice(0, 6);
}

// ─── Reading the records ───

function parseBody(body) {
  const m = /^You said:\s*([\s\S]*?)(?:\nCHE answered:\s*([\s\S]*))?$/.exec(String(body || ''));
  return m ? { said: m[1].trim(), answered: String(m[2] || '').trim() } : { said: String(body || '').trim(), answered: '' };
}

/**
 * Every owner turn in [from, to) (or the newest ones when no window is given), oldest first: Brain conversation
 * records, plus logged turns the Brain never got, each marked chat or voice. { turns, read: [...], unreadable: [...] }
 * `oldest: true` keeps the oldest Brain records when there are more than `limit` (for "the first thing I said").
 */
const LOG_SCAN = 500;
export async function collectTurns(store, storage, { from = 0, to = Date.now() + DAY_MS, limit = 400, oldest = false } = {}) {
  const turns = [];
  const read = [];
  const unreadable = [];
  try {
    if (store?.init?.()) {
      const rows = store.rows(`SELECT id FROM brain_records WHERE deleted = 0 AND kind IN ('conversation','correction') AND created_at >= ? AND created_at < ? ORDER BY created_at ${oldest ? 'ASC' : 'DESC'} LIMIT ?`,
        new Date(from).toISOString(), new Date(to).toISOString(), limit);
      for (const { id } of rows) {
        const r = store.get(id);
        if (!r) continue;
        const { said, answered } = parseBody(r.body);
        turns.push({ id: r.id, kind: r.kind, at: r.created_at, said, answered, store: 'Brain', source: 'chat', evidence: r.source?.evidence || null, corrects: r.source?.corrects || null });
      }
      read.push('Brain conversation records');
    } else unreadable.push('Brain conversation records');
  } catch (_) { unreadable.push('Brain conversation records'); }
  try {
    const index = (await storage.get('log_index')) || [];
    // Every log updated since the window opened (the index keeps at most 500); newer logs must not crowd out older days.
    const eligible = index.filter((e) => Date.parse(e?.updated_at || '') >= from);
    const logs = eligible.slice(0, LOG_SCAN);
    if (eligible.length > logs.length) unreadable.push(`${eligible.length - logs.length} older conversation logs past the ${LOG_SCAN} searched`);
    for (const entry of logs) {
      const log = await loadPackedJson(storage, `log:${entry.id}`);
      for (const [i, t] of (log?.turns || []).entries()) {
        const ms = Date.parse(t.at || '');
        if (!(ms >= from && ms < to) || !String(t.user || '').trim()) continue;
        const same = turns.find((x) => x.said === String(t.user).trim() && Math.abs(Date.parse(x.at) - ms) < 10 * 60_000);
        if (same) { if (t.source === 'voice') same.source = 'voice'; continue; }
        turns.push({ id: `log:${entry.id}/turn-${i}`, conversation: entry.id, kind: 'conversation', at: t.at, said: String(t.user).trim(), answered: String(t.che || '').trim(), store: 'conversation log', source: t.source === 'voice' ? 'voice' : 'chat', evidence: null });
      }
    }
    read.push('conversation logs (chat and voice)');
  } catch (_) { unreadable.push('conversation logs (chat and voice)'); }
  turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { turns, read, unreadable };
}

// The owner pushing back on CHE's previous answer, in his own next words.
const PUSHBACK = /^(?:no+|nope|wrong|nah)\b|\b(?:that'?s|that is|thats|it'?s|it is) (?:not (?:right|true|correct|accurate|what)|wrong|incorrect|false|a lie|made up|cap)\b|\byou(?:'re| are|re) (?:wrong|lying|making (?:that|it|stuff|things) up|mistaken)\b|\b(?:doesn'?t|does not|didn'?t|did not) sound right\b|\bthat'?s not how\b|\bwhere did you get that\b|\bactually,? (?:it|that|he|she|they)(?:'s| is| was| were)\b|\byou made (?:that|it) up\b/i;

/** The turns a record shows were wrong, each with its evidence. Newest first. */
export function findMistakes(turns) {
  const found = [];
  // CHE's own history answers are records of records, and a history question is not pushback on the answer before it.
  const meta = (t) => t.evidence?.route === 'che_history' || Boolean(historyIntent(t.said) || correctionSaveIntent(t.said));
  turns.forEach((turn, i) => {
    if (turn.kind === 'correction' || !turn.answered || meta(turn)) return;
    const reasons = [];
    const next = turns.slice(i + 1).find((t) => t.kind === 'conversation');
    if (next && !meta(next) && Date.parse(next.at) - Date.parse(turn.at) < 6 * 3_600_000 && PUSHBACK.test(norm(next.said))) {
      reasons.push({ kind: 'owner_pushback', text: next.said, id: next.id, at: next.at });
    }
    for (const c of turns.filter((t) => t.kind === 'correction' && t.corrects === turn.id)) reasons.push({ kind: 'correction', text: c.said, id: c.id, at: c.at });
    if (Number(turn.evidence?.removed) > 0) reasons.push({ kind: 'guard_removed', count: Number(turn.evidence.removed) });
    if (reasons.length) found.push({ turn, reasons });
  });
  return found.reverse();
}

/** Why an answer came out as it did, from its stored evidence, or that it was not recorded then. */
export function whyLine(evidence) {
  if (!evidence) return 'How I produced that answer was not recorded at the time (I only began saving that with each answer on October 27, 2026), so I can\'t say more about why without guessing.';
  const route = evidence.route && evidence.route !== 'model' ? `my ${String(evidence.route).replace(/^che_/, '').replace(/_/g, ' ')} route` : 'the AI model';
  const backing = evidence.kind === 'unverified' || evidence.kind === 'none' || !evidence.kind
    ? 'with no stored record or checked source behind it'
    : evidence.sources ? `backed by ${evidence.sources} source${evidence.sources === 1 ? '' : 's'} (${String(evidence.kind).replace(/_/g, ' ')})` : `backed by ${String(evidence.kind).replace(/_/g, ' ')}`;
  return `That answer came from ${route}${evidence.model_calls != null ? ` (${evidence.model_calls} model call${evidence.model_calls === 1 ? '' : 's'})` : ''}, ${backing}.${Number(evidence.removed) > 0 ? ` My truth guard had already removed ${evidence.removed} unsupported claim${Number(evidence.removed) === 1 ? '' : 's'} from it.` : ''}`;
}

/** The code changes merged since a moment, read from GitHub: { count, relevant: [titles] } or null if unreadable. */
export async function changesSince(env, sinceIso, fetcher = fetch) {
  if (!env?.CHE_GITHUB_TOKEN || !env?.CHE_GITHUB_REPO) return null;
  try {
    const res = await gh(env, 'GET', `/commits?sha=main&since=${encodeURIComponent(sinceIso)}&per_page=100`, null, fetcher);
    if (!res.ok || !Array.isArray(res.data)) return null;
    const titles = res.data.map((c) => String(c?.commit?.message || '').split('\n')[0]).filter(Boolean);
    const relevant = titles.filter((t) => /\b(?:memory|memories|recall|truth|guard|hallucinat|correct|history|fact|brain|provenance|research|answer)/i.test(t)).slice(0, 3);
    return { count: titles.length, capped: titles.length >= 100, relevant };
  } catch (_) { return null; }
}

const inWhen = (when) => (!when ? 'in my stored conversations' : /^(?:around|about|yesterday|today|last)\b/.test(when.label) ? when.label : `${when.day ? 'on' : 'for'} ${when.label}`);
const quoteTurn = (t) => `${t.source === 'voice' ? 'you said by voice' : 'you said'} "${clip(t.said, 140)}"${t.answered ? ` and I answered "${clip(t.answered, 180)}"` : ''}`;

/** "What did we talk about on October 4th?" */
export function speakDay(when, collected, topic = [], { order = '', keepRule = false } = {}) {
  const { turns, unreadable } = collected;
  const owner = turns.filter((t) => t.kind === 'conversation');
  const matching = topic.length ? owner.filter((t) => topic.some((w) => `${t.said} ${t.answered}`.toLowerCase().includes(w))) : owner;
  const gap = unreadable.length ? ` I couldn't read ${unreadable.join(' or ')} just now, so something there may be missing; I won't guess at it.` : '';
  // Asked to drop the rule against invented memories: the rule stays, and the answer is still only what is recorded.
  const rule = keepRule ? "I'm keeping my rule against inventing memories, sir: I only repeat what is recorded, and what I don't have I won't fill in. " : '';
  if (!owner.length) return { text: `${rule}I have no conversation recorded ${inWhen(when)}, sir. I checked my Brain conversation records and the chat and voice logs, and nothing is stored for that time, so I won't make anything up about it.${gap}`, records: [] };
  if (topic.length && !matching.length) return { text: `${rule}I have ${owner.length} exchange${owner.length === 1 ? '' : 's'} recorded ${inWhen(when)}, sir, but none of them mention ${topic.join(' or ')}. I won't invent a conversation about that.${gap}`, records: owner.map((t) => t.id) };
  // One turn: the earliest or the latest on record for that time. A turn that was never recorded cannot be seen, and an
  // earlier question about the history itself is not something the owner told CHE.
  const told = order ? matching.filter((t) => t.evidence?.route !== 'che_history' && !historyIntent(t.said)) : [];
  if (order && told.length) {
    const t = order === 'first' ? told[0] : told[told.length - 1];
    const which = order === 'first' ? 'earliest' : 'latest';
    return {
      text: `${rule}The ${which} thing I have recorded from you ${inWhen(when)}, sir, is from ${timeName(t.at)}: ${quoteTurn(t)}. That is the ${which} of ${told.length} exchange${told.length === 1 ? '' : 's'} in my records for that time; anything you said that was not recorded, I don't have.${gap}`,
      records: [t.id],
    };
  }
  const shown = matching.slice(0, 6);
  const voice = matching.filter((t) => t.source === 'voice').length;
  const lines = shown.map((t, i) => `${i + 1}. ${dayName(Date.parse(t.at))}, ${timeName(t.at)}: ${quoteTurn(t)}.`);
  return {
    text: `${rule}Here's what I have ${inWhen(when)}, sir: ${matching.length} exchange${matching.length === 1 ? '' : 's'}${voice ? `, ${voice} by voice` : ''}, from my stored records. ${lines.join(' ')}${matching.length > shown.length ? ` And ${matching.length - shown.length} more; ask about a topic to narrow it.` : ''}${gap}`,
    records: shown.map((t) => t.id),
  };
}

/** "Remember around October 4th when you told me something that didn't sound right?" / "What mistakes have you made?" */
export function speakMistakes(when, collected, { topic = [], changes = null, now = Date.now(), current = [] } = {}) {
  const { turns, unreadable } = collected;
  const scoped = topic.length ? turns.filter((t) => topic.some((w) => `${t.said} ${t.answered}`.toLowerCase().includes(w))) : turns;
  const all = findMistakes(turns);
  const mistakes = topic.length ? all.filter((m) => scoped.includes(m.turn) || m.reasons.some((r) => topic.some((w) => String(r.text || '').toLowerCase().includes(w)))) : all;
  const where = inWhen(when);
  const gap = unreadable.length ? ` I couldn't read ${unreadable.join(' or ')} just now, so a record there may be missing.` : '';
  if (!mistakes.length) {
    const had = turns.filter((t) => t.kind === 'conversation').length;
    return {
      text: had
        ? `I looked at ${had} exchange${had === 1 ? '' : 's'} ${where}, sir, and none of my records shows an answer of mine that was wrong: you didn't push back right after one, no correction names one, and my truth guard didn't remove a claim. That doesn't prove I was right; it means I have no evidence to point to, and I won't invent one.${topic.length ? ` (I looked for ${topic.join(', ')}.)` : ''} If you remember what it was, tell me and I'll check it now.${gap}`
        : `I have no conversation recorded ${where}, sir, so I can't find a mistake there and I won't make one up.${gap}`,
      records: [],
    };
  }
  const top = mistakes.slice(0, 3);
  const parts = top.map((m, i) => {
    const t = m.turn;
    const evidence = m.reasons.map((r) => r.kind === 'owner_pushback' ? `you replied "${clip(r.text, 120)}" right after` : r.kind === 'correction' ? `your correction "${clip(r.text, 120)}" (record ${r.id}) names it` : `my truth guard removed ${r.count} unsupported claim${r.count === 1 ? '' : 's'} from it`).join('; ');
    const now_ = current.filter((c) => Date.parse(c.at || '') > Date.parse(t.at) && topicWords(t.said).some((w) => String(c.text).toLowerCase().includes(w))).slice(0, 1);
    const nowLine = now_.length ? ` Now I have your statement "${clip(now_[0].text, 140)}" (${now_[0].store}, ${String(now_[0].at).slice(0, 10)}), and I go by that.` : ' I have no saved correction for it yet; say "remember the correction:" and the right answer, and I\'ll keep it.';
    return `${i + 1}. ${dayName(Date.parse(t.at))} at ${timeName(t.at)}, ${quoteTurn(t)} (record ${t.id}). How I know it was off: ${evidence}. Why: ${whyLine(t.evidence)}${nowLine}`;
  });
  const since = top[top.length - 1].turn.at;
  const changeLine = changes == null ? ' I couldn\'t read my change history just now, so I can\'t say what changed in me since then.'
    : ` Since then, ${changes.count}${changes.capped ? '+' : ''} changes to my code were merged${changes.relevant.length ? `, including ${changes.relevant.map((r) => `"${clip(r, 90)}"`).join(', ')}` : ''}.`;
  return {
    text: `I found ${mistakes.length} answer${mistakes.length === 1 ? '' : 's'} ${where} that my records show were wrong or doubted, sir. ${parts.join(' ')}${changeLine}${mistakes.length > top.length ? ` There are ${mistakes.length - top.length} more; ask about a date or topic to see them.` : ''}${gap}`,
    records: top.map((m) => m.turn.id),
    since,
  };
}

// ─── Saving a verified correction ───
const CORRECTION_SAVE = /^(?:(?:ok(?:ay)?|so|alright|che|chay|chey)[,\s]+)?(?:(?:please\s+)?(?:remember|save|keep|store)\s+(?:the|that|this|my)\s+correction|correction|(?:that|it) was wrong|you were wrong(?: about that)?)\s*[:,.\-–]\s*(.{4,300})$/i;

export function correctionSaveIntent(message) {
  const m = CORRECTION_SAVE.exec(norm(message).trim());
  return m ? m[1].trim().replace(/[.\s]+$/, '') : null;
}

/**
 * Saves the owner's correction of CHE's own earlier answer: a Brain correction record linked to the answer it
 * corrects (the Brain timeline logs it as Corrected, and the original stays untouched), and the owner's statement as an
 * owner memory so later answers use it. Returns { text, records, corrects }.
 */
export async function saveCorrection({ store, storage, text, now = Date.now(), addMemory }) {
  const { turns } = await collectTurns(store, storage, { from: now - HISTORY_DAYS * DAY_MS, to: now + DAY_MS, limit: 200 });
  // The answer it corrects: a doubted answer on the same topic first, then the newest answer on that topic.
  const words = topicWords(text);
  const onTopic = (t) => words.some((w) => `${t.said} ${t.answered}`.toLowerCase().includes(w));
  const flagged = findMistakes(turns).map((m) => m.turn);
  const related = [...turns].reverse().find((t) => t.kind === 'conversation' && t.answered && onTopic(t) && !historyIntent(t.said, now) && !correctionSaveIntent(t.said));
  const target = flagged.find(onTopic) || related || flagged[0] || null;
  const id = `corr:${crypto.randomUUID()}`;
  let saved = null;
  try {
    if (store?.init?.()) {
      saved = store.putIfAbsent({
        id, kind: 'correction', region: 'Conversations and Corrections', path: 'Corrections',
        title: clip(text, 90), body: `You said: ${text}`,
        source: { kind: 'owner_chat', corrects: target?.id || null, corrected_text: target ? clip(target.answered, 300) : null },
        verification: 'owner_attested', created_at: new Date(now).toISOString(),
      }, { origin: 'cloud' });
    }
  } catch (_) { saved = null; }
  const memory = addMemory ? await addMemory(text) : null;
  if (!saved || saved.outcome === 'rejected') {
    return { text: 'I couldn\'t save that correction just now, sir, so nothing changed. Please say it again in a minute.', records: [], ok: false };
  }
  const which = target ? ` It corrects my answer from ${dayName(Date.parse(target.at))}: "${clip(target.answered, 140)}" (record ${target.id}), which I keep unchanged as history.` : '';
  return { text: `Saved your correction, sir: "${clip(text, 200)}" (record ${id}).${which} I'll go by it from now on${memory ? ', and it is in your memories too' : ''}.`, records: [id, ...(target ? [target.id] : [])], corrects: target?.id || null, ok: true };
}

// ─── The chat turn ───

/** The whole route: { text, meta } or null when the message is not about history. Owner only, 0 model calls. */
export async function historyTurn({ env, storage, store, data, message, now = Date.now(), owner, save, fetcher = fetch }) {
  const out = await historyAnswer({ env, storage, store, data, message, now, owner, save, fetcher });
  if (out) await recordAnswerEvidence(storage, out.text, { kind: out.meta.records ? 'memory_search' : 'none', tools: ['brain/conversations', 'conversation_logs'] }, { records: out.meta.record_ids || [] }).catch(() => null);
  return out;
}

async function historyAnswer({ env, storage, store, data, message, now, owner, save, fetcher }) {
  // A correction is kept as an owner memory too, the store personal recall answers from.
  const addMemory = async (text) => {
    const added = addOwnerMemory(data, text, { source: 'owner_chat', category: 'Memory', scope: 'owner', confidence: 1 });
    if ((added.added || added.replaced?.length) && save) await save();
    return added.record?.id || null;
  };
  const correction = correctionSaveIntent(message);
  const ask = correction ? null : historyIntent(message, now);
  if (!correction && !ask) return null;
  if (!owner) return { text: 'Only the CHE owner can read his conversation history, sir.', meta: { source: 'che_history', ok: false, model_calls: 0 } };
  if (correction) {
    const out = await saveCorrection({ store, storage, text: correction, now, addMemory });
    return { text: out.text, meta: { source: 'che_history', mode: 'correction', ok: out.ok !== false, model_calls: 0, record_ids: out.records, corrects: out.corrects || null } };
  }
  const window = ask.when || { from: now - HISTORY_DAYS * DAY_MS, to: now + DAY_MS };
  const collected = await collectTurns(store, storage, { from: window.from, to: window.to, limit: ask.when ? 400 : 1500, oldest: ask.order === 'first' });
  if (ask.mode === 'day') {
    const out = speakDay(ask.when, collected, ask.topic, { order: ask.order || '', keepRule: Boolean(ask.keep_rule) });
    return { text: out.text, meta: { source: 'che_history', mode: 'day', model_calls: 0, records: out.records.length, record_ids: out.records.slice(0, 10), stores_read: collected.read, stores_unreadable: collected.unreadable, outcome: out.records.length ? 'retrieved' : 'no_match' } };
  }
  const current = (Array.isArray(data?.memory_records) ? data.memory_records : []).filter((r) => r && r.active !== false && r.verification_status === 'owner_attested').map((r) => ({ text: r.text, at: r.created_at, store: 'memory records' }));
  for (const t of collected.turns.filter((x) => x.kind === 'correction')) current.push({ text: t.said, at: t.at, store: 'Brain corrections' });
  const pre = findMistakes(collected.turns);
  const changes = pre.length ? await changesSince(env, pre[Math.min(pre.length, 3) - 1].turn.at, fetcher) : null;
  const out = speakMistakes(ask.when, collected, { topic: ask.when ? [] : ask.topic, changes, now, current });
  return { text: out.text, meta: { source: 'che_history', mode: 'mistakes', model_calls: 0, records: out.records.length, record_ids: out.records, stores_read: collected.read, stores_unreadable: collected.unreadable, outcome: out.records.length ? 'retrieved' : 'no_match' } };
}

/** What to keep with a Brain conversation record about how its answer was made (read from the reply stream). */
export function answerEvidence(raw, ledgerEntry) {
  let done = {};
  for (const line of String(raw || '').split('\n')) { try { const e = JSON.parse(line); if (e?.type === 'done') done = e; } catch (_) { /* not a frame */ } }
  return {
    route: done.source || 'model',
    model_calls: Number.isFinite(done.model_calls) ? done.model_calls : null,
    kind: ledgerEntry?.kind || null,
    sources: Array.isArray(ledgerEntry?.sources) ? ledgerEntry.sources.length : 0,
    removed: Number(ledgerEntry?.attributions_removed || 0),
  };
}

// ─── Live check (deploy and staging gate) ───
// On the isolated test CHE (never the owner's): a spoken conversation on a random 2025 day is posted to /api/logs the
// way the phone posts it, with a wrong answer and the owner's pushback. Then, through the real /api/chat: that day is
// retrieved, the wrong answer is found with its evidence, a correction is saved and linked, and a day with no
// conversation is said to have none. The log is deleted afterwards.
export async function historyProbe(env, request, objectName) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const probe = env.CHE_STATE.getByName(objectName);
  const call = (path, body, device = '', method = 'POST') => probe.fetch(new Request(`https://che.internal${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CHE-Memory-Probe': token, ...(device ? { Authorization: `Bearer ${device}` } : {}) },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
  }));
  const paired = await (await call('/api/pair', { code: String(env.CHE_PAIR_CODE || ''), device_name: 'CHE history check' })).json().catch(() => ({}));
  const device = paired.device_token;
  if (!device) return { ok: false, error: 'The check could not pair with its test CHE.', steps: [] };
  const tag = crypto.randomUUID().slice(0, 8);
  const day = new Date(Date.UTC(2025, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28), 15));
  const iso = (min) => new Date(day.getTime() + min * 60_000).toISOString();
  const said = `who painted the ceiling of the probe chapel ${tag}`;
  const logId = `history-check-${tag}`;
  const steps = [];
  const step = async (name, message, check) => {
    const started = Date.now();
    const res = await call('/api/chat', { message, history: [] }, device);
    const events = (await res.text()).split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const done = events.find((e) => e.type === 'done') || {};
    const reply = events.filter((e) => e.type === 'delta').map((e) => e.delta).join('').trim();
    steps.push({ name, pass: res.status === 200 && done.source === 'che_history' && done.model_calls === 0 && Boolean(check({ reply, done })), ms: Date.now() - started, route: done.source || 'model', model_calls: done.model_calls ?? null, reply: reply.slice(0, 500) });
  };
  try {
    await call('/api/logs', { conversationId: logId, title: 'History check', source: 'voice', user: { text: said, at: iso(0) }, che: { text: `Raphael painted it in 1510, ${tag}.` } }, device);
    await call('/api/logs', { conversationId: logId, title: 'History check', source: 'voice', user: { text: "No, that's not right, it was Michelangelo.", at: iso(1) }, che: { text: 'Thanks for telling me.' } }, device);
    const when = `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}, 2025`;
    await step(`a spoken conversation from ${when} is retrieved by its date`, `What did we talk about on ${when}?`,
      ({ reply }) => reply.includes(tag) && /you said by voice/.test(reply));
    await step('the wrong answer from that day is found, with the evidence that it was wrong', `Remember around ${when} when you told me something that didn't sound right? What was that about?`,
      ({ reply }) => reply.includes(`Raphael painted it in 1510, ${tag}`) && /How I know it was off: you replied "No, that's not right, it was Michelangelo\." right after/.test(reply) && /Why: /.test(reply));
    await step('a correction is saved and linked to the answer it corrects', `Remember the correction: Michelangelo painted the ceiling of the probe chapel ${tag}.`,
      ({ reply, done }) => done.mode === 'correction' && /^Saved your correction/.test(reply) && /which I keep unchanged as history/.test(reply));
    await step('a day with no conversation is said to have none, with nothing invented', 'What did we talk about on September 12, 2001?',
      ({ reply }) => /^I have no conversation recorded on September 12, 2001, sir\./.test(reply));
  } finally {
    await call(`/api/logs/${logId}`, null, device, 'DELETE').catch(() => null);
    await call('/api/security/revoke_self', {}, device).catch(() => null);
  }
  const passed = steps.filter((s) => s.pass).length;
  return { ok: passed === steps.length && steps.length > 0, passed, total: steps.length, steps };
}
