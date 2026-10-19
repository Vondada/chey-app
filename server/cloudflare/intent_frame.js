// One owner turn, two forms (owner, issue #345): the exact words, kept as said, and a compact frame
// for cheap routing and short context. The frame is read from the whole sentence and holds only words
// the owner said. It never replaces the words for approval, quoting or composing exact text. When a
// constraint would be lost (a "not", a number, a time, a condition, a name), the frame says it is not
// lossless and the full words are used instead.
import { classifyOwnerActions, prohibitedText, withoutProhibitions } from './owner_action_gate.js';
import { classifyOwnerTurn } from './speech_intent.js';

const MODE = {
  cancel: 'cancel', question: 'question', explain: 'explain', plan: 'plan', action: 'do', followup: 'followup',
  correction: 'correction', yes: 'answer', no: 'answer', greeting: 'chat', thanks: 'chat', chitchat: 'chat', unclear: 'unclear',
};
const WAKE = /^\s*(?:(?:hey|hi|ok|okay)\s+)?(?:che|chey|chay|shay)\b\s*[,:]?\s*/i;
const FILLER = /^(?:(?:please|pls|so|and|but|also|just|then|ok|okay|well|um|uh)\s+)+/i;
// "I want to / I'm going to …": the owner's own plan. "I want you to …" and "can you …" ask CHE.
const OWN_PLAN = /^(?:i\s+(?:want|need|plan|hope|intend|would\s+like|have)\s+to|i(?:['’]d|d)\s+like\s+to|i(?:['’]m|m|\s+am)\s+(?:going|planning)\s+to|i\s+will|i['’]ll)\s+/i;
const ASK_CHE = /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need)\s+you\s+to\s+|go\s+ahead\s+and\s+)/i;
// A sentence that calls off the turn at its end: "Buy two apples, actually, cancel that."
const SELF_CANCEL = /(?:^|[,.;!?—–-]\s*)(?:(?:actually|wait|no|oh)[,\s]+)*(?:cancel\s+(?:that|it|this|all\s+(?:of\s+)?that)|scratch\s+that|forget\s+(?:it|that)|never\s*mind)(?:\s+(?:please|sir))?\s*[.!]*\s*$/i;
// A plain request: "buy 3 apples online now", "place a paper trade", "email Sarah the report".
const IMPERATIVE = /^(?:please\s+)?(?:buy|order|pay|place|sell|send|e-?mail|text|call|message|draft|make|create|add|put|remind|schedule|book|set|find|search|look\s+up|get|give|tell|show|read|open|play|start|stop|cancel|delete|remove|move|copy|save|share|post|publish|upload|download|write|fix|build|run|check|analy[sz]e|research|summari[sz]e|translate|turn|switch|go)\b/i;
// Work and learning requests that name what they act on: "Investigate the Doodle app", "Inspect the
// latest main SHA", "Quiz me on option spreads", "Remember that my favorite food is pizza", "connect my
// Alpaca account". Measured 2026-10-19 on 923 owner sentences after earlier turns: reading-model calls
// 175 -> 97, and 76 -> 12 of them on turns a deterministic route then answers from the exact words. Not here: verbs that only point
// at earlier talk or could hide a delete, a publish or a sign-in ("clean up", "clear", "reset",
// "approve", "star", "sign out", "log in", "take", "apply", "answer"); those keep their reading, and
// so does a work request that also names money, a delete or a publish.
const WORK_REQUEST = /^(?:please\s+)?(?:investigate|inspect|audit|implement|debug|diagnose|repair|trace|verify|review|compare|describe|brainstorm|backtest|study|learn|teach|quiz|remember|memori[sz]e|scout|list|prepare|connect|continue|resume|retry|recover|reopen|look\s+(?:at|in|into|through|over)|walk\s+me\s+through|work\s+with)\b/i;
const STEP_BREAK = /\s*(?:[.;!?]+|\s+then\s+(?=(?:buy|get|go|send|make|add|find|give|tell|show|book|call|text|email|e-mail|draft|place|put|set|check|read|open|play|create|remind)\b)|[,—–]\s*(?:and\s+)?then\b|,?\s+and\s+then\b|,\s+and\b|\s+and\s+(?=(?:buy|get|go|send|make|add|find|give|tell|show|book|call|text|email|e-mail|draft|place|put|set|check|read|open|play|create|remind)\b))\s*/i;
// Constraints with no verb of their own: "not today", "not live", "not yet".
const BARE_NOT = /(?:^|[,;]\s*|\bbut\s+)(not\s+(?:yet|now|today|tonight|tomorrow|live|real|this\s+\w+|the\s+\w+|\w+))\b/gi;
const TIME = /\b(?:right\s+now|now|today|tonight|tomorrow(?:\s+(?:morning|afternoon|evening|night))?|yesterday|later|soon|this\s+(?:morning|afternoon|evening|week|weekend|month)|next\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:at|by|before|after|until)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|\d{1,2}(?::\d{2})?\s*(?:am|pm)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2})\b/gi;
const QUANTITY = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:%|percent\b)?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a\s+dozen|half)\b/gi;
const CONDITION = /\b(?:only\s+if|if|unless|until|as\s+long\s+as|provided\s+that|except|before|after)\b[^,.;!?]*/gi;
// Every word that can change what the owner meant. Each must survive into the compact form.
const CRITICAL = /\b(?:don['’]?t|do\s+not|never|not|no|nor|without|only|unless|if|until|except|before|after|instead|actually|yet)\b|\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\b|\b(?:today|tonight|tomorrow|yesterday|now|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|half)\b/gi;
const NAME = /(?<![.!?]\s|^)\b[A-Z][a-zA-Z'’-]{1,}\b/g;
const NOT_NAMES = new Set(['I', 'CHE', 'Che', 'Chey', 'Chay', 'Shay', 'OK', 'Ok', 'Okay']);

const words = (s) => String(s || '').toLowerCase().replace(/[’]/g, "'").replace(/\bdo not\b/g, "don't").replace(/\bdont\b/g, "don't");
const uniq = (list) => [...new Set(list.map((x) => x.trim()).filter(Boolean))];

function stepsOf(text) {
  return uniq(withoutProhibitions(text).split(STEP_BREAK).map((part) => part
    .replace(WAKE, '').replace(FILLER, '').replace(ASK_CHE, '').replace(OWN_PLAN, '').replace(FILLER, '')
    .replace(BARE_NOT, '').replace(/[,\s]+(?:but|and|or|so|then)?[,\s]*$/i, '').replace(/^[,\s]+/, '')))
    .filter((part) => /[a-z]{2}/i.test(part) && !/^(?:but|and|or|so|then|please|sir)$/i.test(part));
}

/** The frame for one owner turn. `text` is kept exactly; `compact` is what may stand in for it. */
export function intentFrame(input) {
  const text = String(input || '').trim();
  const body = text.replace(WAKE, '').replace(FILLER, '');
  const turn = classifyOwnerTurn(body);
  const cancelled = SELF_CANCEL.test(text);
  const ownPlan = OWN_PLAN.test(body) && !/\byou\b/i.test(body.split(/[,.;!?]/)[0]);
  let mode = cancelled ? 'cancel' : MODE[turn.kind] || 'unclear';
  if (mode === 'unclear' && IMPERATIVE.test(body.replace(FILLER, ''))) mode = 'do';
  // A work request that also names money, a delete or a publish keeps its reading, so the reading's
  // "Just to be sure…?" still comes first, as before.
  if (mode === 'unclear' && !turn.consequential && WORK_REQUEST.test(body.replace(FILLER, ''))) mode = 'do';
  if (ownPlan && (mode === 'do' || mode === 'unclear' || mode === 'chat')) mode = 'plan';
  const doNot = uniq([...prohibitedText(text).split('; '), ...[...text.matchAll(BARE_NOT)].map((m) => m[1])]);
  const frame = {
    text,
    mode,
    actor: ownPlan ? 'owner' : mode === 'do' ? 'che' : 'owner',
    steps: cancelled ? [] : stepsOf(text),
    do_not: doNot,
    // Times the owner asked for; "not today" is a constraint, kept in do_not.
    time: uniq((withoutProhibitions(text).replace(BARE_NOT, ' ').match(TIME) || [])),
    quantity: uniq((text.match(QUANTITY) || [])),
    conditions: uniq((text.match(CONDITION) || [])),
    needs_yes: cancelled ? [] : classifyOwnerActions(text),
  };
  frame.compact = compactFrame(frame);
  const kept = words(frame.compact);
  const missing = uniq([...(text.match(CRITICAL) || []), ...(text.match(NAME) || []).filter((n) => !NOT_NAMES.has(n))]
    .filter((token) => !new RegExp(`(?:^|[^a-z0-9'])${words(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(kept)));
  frame.lossless = !cancelled ? missing.length === 0 : true;
  frame.missing = missing;
  frame.confidence = frame.mode !== 'unclear' && frame.lossless ? 0.9 : 0.4;
  return frame;
}

/** "plan: go to Walmart tomorrow; buy apples | not: don't order anything yet". */
export function compactFrame(frame) {
  if (frame.mode === 'cancel') return 'cancel: the owner called this off';
  const parts = [`${frame.mode}${frame.actor === 'owner' && frame.mode === 'plan' ? ' (owner)' : ''}: ${frame.steps.join('; ') || '-'}`];
  if (frame.do_not.length) parts.push(`not: ${frame.do_not.join('; ')}`);
  const conditions = frame.conditions.filter((c) => !frame.steps.some((s) => s.includes(c)));
  if (conditions.length) parts.push(`if: ${conditions.join('; ')}`);
  if (frame.needs_yes.length) parts.push(`needs yes: ${frame.needs_yes.join(', ')}`);
  return parts.join(' | ');
}
