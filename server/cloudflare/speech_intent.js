// CHE understands the owner the way a capable person does: a speech mistake is
// corrected from context, "that one" and "do it again" are resolved from the
// recent turns, and the turn is sorted into a kind of request. It runs before
// the owner gates and the reply model. It never approves anything: money and
// delete holds still run on the words it hands on (owner_action_gate.js).
import { classifyOwnerActions, prohibitedText } from './owner_action_gate.js';

// Names CHE is likely to be asked about. Fuzzy matching only looks at these.
export const KNOWN_TERMS = [
  'CHE', 'Shorebird', 'SideStore', 'TestFlight', 'ChatGPT', 'Claude', 'Grok', 'Gemini',
  'Codex', 'Copilot', 'Cursor', 'Flagstaff', 'GitHub', 'YouTube', 'Cloudflare', 'ElevenLabs',
  'Kokoro', 'Porcupine', 'Flutter', 'Xcode', 'iPhone', 'Stripe', 'Twilio', 'Wrangler', 'Realtime',
];

// Context words that make a sound-alike a technology name rather than an English word.
const TECH_CONTEXT = /\b(app|apps|build|builds|patch|patches|release|releases|ipa|install|installed|update|updates|phone|iphone|ios|deploy|deployed|github|worker|xcode|sideload|version|crash|crashed|broken|fail|fails|failing|signing|certificate)\b/i;

// Exact speech-to-text mishearings that are always the same name.
const ALIASES = [
  { heard: 'chagpt', meant: 'ChatGPT' },
  { heard: 'chat gpt', meant: 'ChatGPT' },
  { heard: 'chat g p t', meant: 'ChatGPT' },
  { heard: 'git hub', meant: 'GitHub' },
  { heard: 'you tube', meant: 'YouTube' },
  { heard: 'eleven labs', meant: 'ElevenLabs' },
  { heard: 'cloud flare', meant: 'Cloudflare' },
  { heard: 'flag staff', meant: 'Flagstaff' },
  { heard: 'test flight', meant: 'TestFlight' },
  // These sound like ordinary words, so they count only next to tech words.
  { heard: 'showbird', meant: 'Shorebird', tech: true },
  { heard: 'shore bird', meant: 'Shorebird', tech: true },
  { heard: 'show bird', meant: 'Shorebird', tech: true },
  { heard: 'size store', meant: 'SideStore', tech: true },
  { heard: 'sighed store', meant: 'SideStore', tech: true },
  { heard: 'side store', meant: 'SideStore', tech: true },
];

// Informal speech turned into plain words before the turn is classified.
const SLANG = [
  [/\bgonna\b/gi, 'going to'], [/\bwanna\b/gi, 'want to'], [/\bgotta\b/gi, 'got to'],
  [/\blemme\b/gi, 'let me'], [/\bgimme\b/gi, 'give me'], [/\bkinda\b/gi, 'kind of'],
  [/\bsorta\b/gi, 'sort of'], [/\bdunno\b/gi, "don't know"], [/\bnah\b/gi, 'no'],
  [/\b(?:pls|plz)\b/gi, 'please'], [/\bu\b/gi, 'you'], [/\bur\b/gi, 'your'],
  [/\bthx\b/gi, 'thanks'], [/\btmrw\b/gi, 'tomorrow'], [/\brn\b/gi, 'right now'],
];

const YES_RE = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|confirmed|yes please|yes do it|yes go ahead|please do it|go for it)$/;
const NO_RE = /^(no|nope|cancel|stop|never mind|nevermind|don't|dont|forget it|no thanks|not that|wait no|hold on)$/;
const GREET_RE = /^(hi|hey|hello|yo|good (morning|afternoon|evening)|what's up|whats up|sup)\b/;
const THANKS_RE = /^(thanks|thank you|cheers|appreciate it)\b/;
const CORRECTION_RE = /\b(i meant|when i say|not what i (meant|mean))\b/;
const REFERENCE_RE = /\b(that one|that thing|that problem|the same (thing|one)|same thing|do (it|that|this|the same)(?: again)?|do the same|the (previous|last|other|earlier) (one|problem|thing|issue|request)|the other one|fix (it|that)|what about (now|that|this)|how about (now|that)|and now|try (it|that) again|try again|that again|do it again)\b/;
const FOLLOWUP_START_RE = /^(why|how come|and|also|what about|how about|so)\b/;
const EXPLAIN_RE = /\b(explain|what does|what do|what is|what's|what are|how does|how do|how is|why does|why is|help me understand|walk me through|break (it|this|that) down|what it means)\b/;
const PLAN_RE = /\b(plan|should i|what should|next steps?|strategy|roadmap|help me decide|options for|pros and cons|which is better)\b/;
// An action verb counts only where it is asked for: at the start of the request,
// after a lead like "can you" or "let me", or in "can you <verb>". So "why did the
// build fail" stays a question, because "build" is a noun there.
const ACTION_VERB = 'open|launch|send|post|play|replay|rewind|search|find|read|write|draft|make|create|build|fix|update|merge|deploy|publish|delete|remove|buy|order|pay|set|remind|call|text|email|schedule|book|run|check|generate|upload|download|install|restart|cancel|look up|research|translate|summari[sz]e|save|share|add|change|turn on|turn off|start|ask|tell|show|put';
const ACTION_LEAD = "(?:(?:please|pls|just|also|and|ok|okay|so|now|then|go ahead and|let me|i need you to|i want you to|i want to|i need to|i have to|i would like to|i'd like to|we need to|help me|can you|could you|would you|will you)\\s+)*";
const ACTION_START_RE = new RegExp(`^${ACTION_LEAD}(?:${ACTION_VERB})\\b`);
const ACTION_ANYWHERE_RE = new RegExp(`\\b(?:can|could|would|will) you (?:${ACTION_VERB})\\b`);
const QUESTION_RE = /^(who|what|when|where|why|how|is|are|was|were|can|could|do|does|did|will|would|should|which)\b/;
const PUBLISH_RE = /\b(publish|unpublish|make (it )?public|post (it )?publicly|subscribe|merge|deploy|release it|transfer)\b/;
const COMPLETION_RE = /\b(done|sent|deleted|opened|merged|published|finished|i (have )?(sent|deleted|opened|merged|published|paid|bought))\b/i;
const READING_INTENTS = new Set(['question', 'explain', 'plan', 'action', 'followup', 'chitchat', 'unclear']);
const CANCEL_RE = /\b(never mind|nevermind|forget (it|that)|scratch that|cancel that|actually no)\b/;
// A cancel calls off only what it points back to (comprehension audit, issue #350). "Forget that my
// favorite color is blue" asks CHE to forget a memory, "don't forget that…" asks her to remember, and
// "never mind that, what's my favorite food?" drops the earlier thing and asks a new question.
const CANCEL_PHRASE = String.raw`(?:never\s*mind(?:\s+(?:that|it|this))?|forget\s+(?:it|that|this)|scratch\s+that|cancel\s+that|actually\s+no)`;
const LEAD_CANCEL_RE = new RegExp(String.raw`^\s*(?:(?:oh|ok|okay|wait|actually|no|hey|che|chey|chay)[,\s]+)*(${CANCEL_PHRASE})\b\s*([,.;:!?—–-]+)?\s*([\s\S]*)$`, 'i');
const NOT_A_CANCEL_RE = /\b(?:don't|dont|do not|never) (?:you )?forget\b|\bforget (?:that|this) (?!(?:please|sir|then|okay|ok)\b)\w/;
const REST_FILLER_RE = /^(?:please|sir|then|okay|ok|thanks|thank you)?[\s.!?]*$/i;

// 'cancel', the new request after a leading cancel, or null.
const NEW_REQUEST_START = /^(?:what|whats|what's|who|where|when|why|how|which|is|are|do|does|did|can|could|would|will|tell|show|read|check|give|find|just|please|let's)\b/i;
function cancelShape(raw) {
  const lead = LEAD_CANCEL_RE.exec(raw);
  if (lead) {
    let rest = lead[3].trim();
    if (REST_FILLER_RE.test(rest)) return 'cancel';
    // "Forget that my favorite color is blue": a memory to forget, not a cancel.
    if (/^forget\s+(?:that|this)$/i.test(lead[1]) && !lead[2]) return null;
    // "Never mind the weather, what's on my calendar?": the words before the first break are what is
    // dropped. With no break and no new question or request, the whole turn is dropped as before.
    if (!lead[2] && !NEW_REQUEST_START.test(rest)) {
      const brk = /[,.;:!?—–]\s*/.exec(rest);
      if (!brk) return 'cancel';
      rest = rest.slice(brk.index + brk[0].length).trim();
      if (REST_FILLER_RE.test(rest)) return 'cancel';
    }
    return { rest };
  }
  return null;
}
// A "that one" or "fix it" can point back to any substantive owner statement.
const SUBSTANTIVE = new Set(['action', 'plan', 'explain', 'question', 'unclear']);

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cuts text to a word boundary. No ellipsis: the text may be spoken aloud.
export function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '').trim();
}

// What decides whether CHE may act: a "don't" or a condition. Never left out.
const LIMIT_RE = /\b(?:don['’]?t|do\s+not|never|not|no|without|unless|if|until|till|except|only)\b/i;
// What bounds a request: a date or time, a number or an amount. Left out last.
const DETAIL_RE = /\b(?:before|after|today|tonight|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|weekend|(?:jan|febr)uary|march|april|june|july|august|september|october|november|december)\b|\d|[$€£%]/i;
// A clause ends at punctuation, or where a joining word or a "don't" opens the next one.
const CLAUSE_BREAK = /(?<=[,;:.!?])\s+|\s+(?=(?:but|and|or|so|unless|except|if|because|when|while|though|although|don['’]?t|do\s+not|never)\b)/i;

// Bounds owner text without losing what limits it (issue #345). The start says what he wants
// and the end often says "but don't": both stay, and so does every clause with a "don't" or a
// condition, even past `max` (clauses matching `also` too). Dates and amounts stay unless even
// they do not fit. What is left out is marked with its size, never dropped silently.
export function clipKeepingLimits(text, max, also = null) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const clauses = [];
  let at = 0;
  for (const piece of t.split(CLAUSE_BREAK)) {
    const prev = clauses[clauses.length - 1];
    // A lone "but" or "and" belongs to the clause it opens.
    if (prev && !t.slice(prev[0], prev[1]).includes(' ')) prev[1] = at + piece.length;
    else clauses.push([at, at + piece.length]);
    at += piece.length + 1;
  }
  const last = clauses.length - 1;
  // 2: a limit, always kept; 1: a date or an amount; 0: anything else.
  const rank = clauses.map(([start, end]) => {
    const part = t.slice(start, end);
    if (LIMIT_RE.test(part) || (also && also.test(part))) return 2;
    return DETAIL_RE.test(part) ? 1 : 0;
  });
  // The start and the end always stay. Other clauses nearest the end go first, so the start
  // still reads as he said it; dates and amounts go only if the rest still does not fit.
  let size = t.length;
  const shown = clauses.map(() => true);
  for (const drop of [0, 1]) {
    for (let i = last - 1; i > 0 && size > max; i--) {
      if (rank[i] !== drop) continue;
      shown[i] = false;
      size -= clauses[i][1] - clauses[i][0] + 1;
    }
  }
  const ranges = clauses.filter((_, i) => shown[i]).map(([start, end]) => [start, end]);
  if (size > max) {
    // Still too long: a long start keeps its first words and a long end its last ones.
    const room = Math.max(40, Math.floor((max - 40) / 2));
    if (ranges.length === 1) ranges.push([...ranges[0]]);
    const head = ranges[0];
    const tail = ranges[ranges.length - 1];
    if (head[1] - head[0] > room) head[1] = head[0] + clip(t.slice(head[0], head[1]), room).length;
    // A long end that limits the request keeps its first words, where its "don't" is ("but never
    // remove the ones I starred" must not become "remove the ones I starred"); any other end keeps its last.
    const tailIndex = clauses.findIndex(([start]) => start === tail[0]);
    if (tail[1] - tail[0] > room && rank[tailIndex] === 2) tail[1] = tail[0] + clip(t.slice(tail[0], tail[1]), room).length;
    else if (tail[1] - tail[0] > room) tail[0] = tail[1] - t.slice(tail[1] - room, tail[1]).replace(/^\S*\s+/, '').length;
  }
  let out = t.slice(ranges[0][0], ranges[0][1]);
  for (let i = 1; i < ranges.length; i++) {
    const gap = ranges[i][0] - ranges[i - 1][1];
    out += gap <= 1 ? ' ' : ` … [${gap - 2} characters not shown] … `;
    out += t.slice(ranges[i][0], ranges[i][1]);
  }
  const rest = t.length - ranges[ranges.length - 1][1];
  return rest > 0 ? `${out} … [${rest} characters not shown]` : out;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

// A rough sound key: spelling variants that sound alike collapse to one key.
export function phoneticKey(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/kn/g, 'n').replace(/wr/g, 'r')
    .replace(/^x/, 's').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k')
    .replace(/x/g, 'ks').replace(/z/g, 's');
  const rest = w.slice(1).replace(/[aeiouyhw]/g, '');
  return (w[0] + rest).replace(/(.)\1+/g, '$1');
}

function bestTerm(joined) {
  if (joined.length < 6) return '';
  let best = null;
  for (const term of KNOWN_TERMS) {
    const t = term.toLowerCase();
    if (t.length < 6 || t === joined || t[0] !== joined[0]) continue;
    const d = editDistance(joined, t);
    const limit = t.length >= 8 ? 2 : 1;
    const sounds = phoneticKey(joined) === phoneticKey(t);
    if (d <= limit || (sounds && d <= 3)) {
      if (!best || d < best.d) best = { term, d };
    }
  }
  return best ? best.term : '';
}

// Sound-alike fixes for one- and two-word spans, next to tech words only.
function fuzzyTerms(text, changes) {
  const tokens = [...text.matchAll(/[A-Za-z][A-Za-z']*/g)].map((m) => ({
    word: m[0], start: m.index, end: m.index + m[0].length,
  }));
  const edits = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const span of [2, 1]) {
      const group = tokens.slice(i, i + span);
      if (group.length < span) continue;
      const meant = bestTerm(group.map((t) => t.word).join('').toLowerCase());
      if (meant) {
        const end = group[group.length - 1].end;
        edits.push({ start: tokens[i].start, end, heard: text.slice(tokens[i].start, end), meant });
        i += span - 1;
        break;
      }
    }
  }
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.meant + out.slice(e.end);
    changes.push({ heard: e.heard, meant: e.meant });
  }
  return out;
}

// Fixes likely speech-to-text mistakes. Returns the corrected text and each change,
// so the caller can say what it understood. Only context-safe rules apply.
export function correctSpokenTerms(text) {
  const changes = [];
  let out = String(text || '');
  const tech = TECH_CONTEXT.test(out);
  out = out.replace(/^((?:hey|hi|hello|ok|okay|yo)\s+)?(shay|chay|chey|chee)(?=[\s,.!?]|$)/i, (match, lead = '', name) => {
    changes.push({ heard: name, meant: 'CHE' });
    return `${lead}CHE`;
  });
  for (const alias of ALIASES) {
    if (alias.tech && !tech) continue;
    const pattern = new RegExp(`\\b${alias.heard.split(' ').map(escapeRe).join('\\s+')}\\b`, 'gi');
    out = out.replace(pattern, (heard) => {
      if (heard !== alias.meant) changes.push({ heard, meant: alias.meant });
      return alias.meant;
    });
  }
  if (tech) out = fuzzyTerms(out, changes);
  return { text: out, changes };
}

// Informal words in plain form. Used to classify; the owner's own words are kept.
export function expandSlang(text) {
  let out = String(text || '');
  for (const [pattern, plain] of SLANG) out = out.replace(pattern, plain);
  return out;
}

function normalizeForKind(text) {
  return expandSlang(text).toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The action the owner named, in plain words, for the one-question clarification.
function verbFor(text) {
  const t = normalizeForKind(text);
  if (/\b(delete|remove|erase|wipe|trash|discard|uninstall)\b/.test(t)) return 'delete';
  if (/\b(buy|purchase|pay|order|subscribe|donate|transfer)\b/.test(t)) return 'pay for';
  if (/\b(sell|sells|selling)\b/.test(t)) return 'sell';
  if (/\bmerge\b/.test(t)) return 'merge';
  if (/\bdeploy\b/.test(t)) return 'deploy';
  if (/\bpublish\b/.test(t)) return 'publish';
  return 'do';
}

// Sorts one owner turn into a kind of request. Deterministic and cheap.
export function classifyOwnerTurn(text, { lastUser = '', hasHeldAction = false } = {}) {
  const raw = String(text || '').trim();
  const s = normalizeForKind(raw);
  const consequential = classifyOwnerActions(raw).length > 0 || PUBLISH_RE.test(s);
  const words = s ? s.split(' ').length : 0;
  const turn = (kind, extra = {}) => ({ kind, consequential, reference: false, ...extra });
  if (!s) return turn('unclear', { confidence: 0 });
  if (YES_RE.test(s)) return turn('yes', { held: hasHeldAction });
  // Cancel is checked before no: "never mind" and "forget it" call the request off.
  const shape = cancelShape(raw);
  if (shape === 'cancel') return turn('cancel');
  // With an action held, a turn that opens with a cancel calls it off whatever follows. "Actually no, yes" or
  // "never mind. Yes." must never hand the "yes" on as a release (comprehension audit, issue #350).
  if (shape?.rest && hasHeldAction) return turn('cancel');
  if (shape?.rest) return { ...classifyOwnerTurn(shape.rest, { lastUser, hasHeldAction }), rest: shape.rest };
  if (CANCEL_RE.test(s) && !NOT_A_CANCEL_RE.test(s)) return turn('cancel');
  if (NO_RE.test(s)) return turn('no');
  if (GREET_RE.test(s) && words <= 5) return turn('greeting');
  if (THANKS_RE.test(s) && words <= 4) return turn('thanks');
  if (CORRECTION_RE.test(s)) return turn('correction');
  // "Do it now: fix the login bug in your app" names its own action. "Do it now" is emphasis there, not a reference to
  // the last request, so the order is never swapped for an earlier one (review of #356, round 3: a dropped order is a failure).
  const ownAction = s.replace(/^(?:just |please )?do (?:it|this|that)(?: (?:now|right now|today|asap))? (?=\S)/, '');
  if (ownAction !== s && ACTION_START_RE.test(ownAction)) return turn('action');
  if (REFERENCE_RE.test(s)) return turn('followup', { reference: true });
  const actionLike = ACTION_START_RE.test(s) || ACTION_ANYWHERE_RE.test(s);
  // "why?" and "and the other one?" lean on the last request; a full new question does not.
  if (FOLLOWUP_START_RE.test(s) && words <= 4 && !actionLike) return turn('followup', { reference: true });
  if (EXPLAIN_RE.test(s)) return turn('explain');
  if (PLAN_RE.test(s)) return turn('plan');
  if (actionLike) return turn('action');
  if (QUESTION_RE.test(s) || raw.endsWith('?')) return turn('question');
  if (words <= 3) return turn('chitchat');
  return turn('unclear', { confidence: lastUser ? 0.4 : 0.2 });
}

// The most the chat takes in one message, so any turn the owner sent is read whole here.
const TURN_MAX = 16000;

function recentTurns(history) {
  const list = Array.isArray(history) ? history.slice(-8) : [];
  return list
    .map((item) => ({ role: String(item?.role || ''), text: clipKeepingLimits(item?.content || item?.text || '', TURN_MAX) }))
    .filter((item) => item.text);
}

// The most recent owner turn of the wanted kinds, skipping references and yes/no.
function findUserTurn(recent, current, kinds) {
  const now = normalizeForKind(current);
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i];
    if (item.role !== 'user') continue;
    if (normalizeForKind(item.text) === now) continue;
    const kind = classifyOwnerTurn(item.text);
    // Whole: "that one" acts on the earlier request, so its last "don't" must come along.
    if (kinds.has(kind.kind) && !kind.reference) return item.text;
  }
  return '';
}

// CHE's own confirmation question (applyModelReading), and only as her whole last reply:
// "Just to be sure, do you want me to X? Say yes, or tell me what you mean." X is the pending
// meaning; it is asked whole, so it can be long, and runs to the first question mark. The phone
// sends a reply's words without its route, so a reply that merely contains such words (a quoted
// mailbox message, a story, a model's offer) never sets up a "yes".
const CONFIRM_QUESTION = /^just to be sure, do you want me to ([^?]{3,}?)\? say yes, or tell me what you mean\.?$/i;
function pendingMeaning(recent) {
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role !== 'assistant') continue;
    const m = CONFIRM_QUESTION.exec(String(recent[i].text || '').trim());
    return m ? m[1].trim() : '';
  }
  return '';
}

// Full reading of one owner turn: corrected words, the kind, the consequence, and
// either the text to act on or one short question. Never approves an action.
export function interpretOwnerTurn(rawText, { history = [], hasHeldAction = false } = {}) {
  const raw = String(rawText || '').trim();
  const { text: corrected, changes } = correctSpokenTerms(raw);
  const recent = recentTurns(history);
  const turn = classifyOwnerTurn(corrected, { hasHeldAction });
  // "Never mind that, what's on my calendar?": the new request is what is read and routed.
  if (turn.rest) return interpretOwnerTurn(turn.rest, { history, hasHeldAction });
  const base = { text: corrected, kind: turn.kind, consequential: turn.consequential, reference: turn.reference, changes, clarify: null, passthrough: false, referent: '' };

  // The owner called it off: nothing is run, and CHE says so plainly.
  if (turn.kind === 'cancel') return { ...base, passthrough: true, clarify: 'Okay, I have dropped that.' };
  if (turn.kind === 'yes' || turn.kind === 'no') {
    // A held request is released by the gate, which needs the owner's exact yes.
    if (hasHeldAction || turn.kind === 'no') return { ...base, passthrough: true };
    // "yes" answers only CHE's own confirmation question. Any other "yes" or "okay"
    // is an acknowledgement and never repeats an earlier request.
    const pending = pendingMeaning(recent);
    if (pending) return { ...base, text: pending, referent: pending };
    return { ...base, passthrough: true };
  }

  if (turn.reference) {
    const lastUser = findUserTurn(recent, corrected, SUBSTANTIVE);
    if (!lastUser) {
      // A bare "why?" with no earlier turn goes to the reply, which can answer or ask.
      // Only an explicit reference with nothing to point at ("fix it") needs a question.
      if (!REFERENCE_RE.test(normalizeForKind(corrected))) return base;
      const question = turn.consequential ? `Which one should I ${verbFor(raw)}? Tell me its name first.` : 'Which one do you mean?';
      return { ...base, clarify: question };
    }
    if (turn.consequential) {
      return { ...base, clarify: `Which one should I ${verbFor(raw)}? Tell me its name first.`, referent: lastUser };
    }
    return { ...base, text: `About the earlier request, "${lastUser}": ${corrected}`, referent: lastUser };
  }
  return base;
}

const READING_PROMPT = 'You are the listening layer for CHE, a personal assistant. The owner speaks, so speech-to-text can mishear words. Use the recent turns to work out what he means, and resolve words like "that one" or "do it again". Reply with JSON only: {"intent":"question|explain|plan|action|followup|chitchat|unclear","meaning":"his request in plain words","confidence":0.0 to 1.0,"clarify":"one short question if you cannot tell, otherwise empty"}. Never invent facts and never say anything was done.';

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('interpretation timed out')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

// Strict parse of the model's JSON. Anything else is ignored.
export function parseReading(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
  const intent = String(data?.intent || '');
  if (!READING_INTENTS.has(intent)) return null;
  const confidence = Number(data?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return {
    intent,
    meaning: clipKeepingLimits(String(data?.meaning || ''), 400),
    confidence,
    clarify: clip(String(data?.clarify || ''), 200),
  };
}

const readingCache = new Map();
const READING_TTL_MS = 10 * 60 * 1000;
const READING_CACHE_MAX = 200;

export function clearInterpretationCache() {
  readingCache.clear();
}

// "What is on my screen?" CHE can answer it only from what the phone sends
// about its screen; with nothing sent, a model would only guess.
export function asksAboutScreen(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, '')
    .replace(/^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:che|chay|chey|shay)[\s,.:!]+/, '')
    .replace(/^(?:please|can you|could you)\s+/, '').trim();
  return /^(?:(?:tell me |say )?what(?:'s| is) on (?:my|the|this) (?:screen|page)(?: (?:right )?now)?|what am i looking at|what (?:screen|page) am i on|describe (?:my|the|this) (?:screen|page)|what do you see on (?:my|the) screen|(?:take a )?look at (?:my|the|this) screen(?: now)?|(?:can|do) you see (?:my|the|this) screen(?: now)?|see my screen|what do you see(?: now)?)$/.test(t);
}

// Asks the reply model only for turns the rules could not read. Cached and capped,
// and a failure simply means no reading.
export async function interpretWithModel({ runText, text, history = [], timeoutMs = 4000, now = Date.now() }) {
  // The reading model sees at most 600 characters; a longer turn would be read from its start
  // only, missing a late "don't" (issue #345). It gets no reading, and the full text goes on.
  if (String(text || '').length > 600) return null;
  const recent = recentTurns(history).slice(-3).map((item) => ({ role: item.role, text: clipKeepingLimits(item.text, 160) }));
  const key = `${normalizeForKind(text)}|${recent.map((item) => item.text).join('|')}`;
  const cached = readingCache.get(key);
  if (cached && now - cached.at < READING_TTL_MS) return cached.reading;
  const messages = [
    { role: 'system', content: READING_PROMPT },
    { role: 'user', content: JSON.stringify({ recent, heard: String(text || '') }) },
  ];
  let raw;
  try {
    raw = await withTimeout(Promise.resolve().then(() => runText(messages)), timeoutMs);
  } catch (_) {
    return null;
  }
  const reading = parseReading(raw);
  if (reading) {
    if (readingCache.size >= READING_CACHE_MAX) readingCache.delete(readingCache.keys().next().value);
    readingCache.set(key, { at: now, reading });
  }
  return reading;
}

// Lowercase words, with "do not" and "don't" as one word, so a reworded limit still counts.
function wordSet(text) {
  return new Set(String(text || '').toLowerCase().replace(/\bdo\s+not\b|\bdon['’]?t\b/g, 'not').match(/[a-z0-9$']+/g) || []);
}

// Combines a model reading with the rule reading. The model can add a likely meaning
// or ask a question; it can never approve or mark a turn as a yes.
export function applyModelReading(interpretation, reading) {
  if (!reading || interpretation.kind !== 'unclear' || interpretation.passthrough) return interpretation;
  if (reading.intent === 'unclear' && !reading.meaning && !reading.clarify) return interpretation;
  if (COMPLETION_RE.test(reading.meaning) || COMPLETION_RE.test(reading.clarify)) return interpretation;
  const meaningConsequential = classifyOwnerActions(reading.meaning).length > 0 || PUBLISH_RE.test(normalizeForKind(reading.meaning));
  if (meaningConsequential) {
    // The question names the whole meaning, plus any "don't" of the owner's that the reading
    // left out, so a yes to it carries his limit (issue #345).
    const meaning = reading.meaning.replace(/[.!?]+$/, '');
    const said = wordSet(meaning);
    const missed = prohibitedText(interpretation.text).split('; ')
      .filter((limit) => limit && ![...wordSet(limit)].every((word) => said.has(word)));
    return {
      ...interpretation,
      consequential: true,
      clarify: `Just to be sure, do you want me to ${meaning}${missed.length ? `, but ${missed.join(', and ')}` : ''}? Say yes, or tell me what you mean.`,
    };
  }
  if (reading.confidence < 0.5) {
    if (!reading.clarify) return interpretation;
    const question = reading.clarify.endsWith('?') ? reading.clarify : `${reading.clarify}?`;
    return { ...interpretation, clarify: question };
  }
  return {
    ...interpretation,
    kind: reading.intent,
    confidence: reading.confidence,
    modelRead: true,
    text: `${interpretation.text}\n(Likely meaning from context: ${reading.meaning})`,
  };
}
