// The owner's memory search, answered from the Brain store and the Flagstaff archive themselves.
//
import { storedSpeaker } from './memory_provenance.js';
import { retrievalBody } from './brain_store.js';

// Read-only. Every answer names the records it actually read (id, date, where each was stored, and the sender
// the store recorded), or it says that nothing matched, or that a store could not be read. Who said something
// is never inferred from wording or tone: a speaker is named only when the stored record names one.
const STOP = new Set([
  'about', 'above', 'after', 'again', 'also', 'and', 'are', 'between', 'can', 'could', 'did', 'does', 'dates', 'date',
  'each', 'earlier', 'for', 'from', 'give', 'had', 'have', 'how', 'ids', 'instruction', 'instructions', 'into', 'its',
  'message', 'messages', 'more', 'not', 'one', 'our', 'out', 'over', 'please', 'previous', 'record', 'records', 'search',
  'show', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'till', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'long', 'term', 'memory', 'flagstaff', 'brain', 'claude', 'owner', 'check', 'find', 'look', 'given', 'gave', 'said', 'came', 'made', 'make', 'tell', 'told', 'said', 'give', 'gave', 'sent', 'wrote', 'write', 'reported', 'report',
  'distinguish', 'between', 'separate', 'source', 'sources', 'stored', 'store', 'access', 'available', 'right', 'now',
]);

// "Search my long-term memory…", "do you have access to the Flagstaff records", "which instruction came from Claude".
export function memorySearchIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey|shay)[,:]?\s+/i, '');
  if (!text) return false;
  const search = /\b(?:search|check|look\s+(?:through|in|up)|find|dig\s+(?:through|into))\b[\s\S]{0,60}\b(?:long[- ]term\s+memory|my\s+memory|the\s+brain|flagstaff\s+(?:records?|history|archive|messages?))\b/i;
  const access = /\b(?:do\s+you\s+have|can\s+you)\s+(?:access\s+to\s+)?(?:my\s+)?(?:long[- ]term\s+memory|flagstaff\s+(?:records?|history|archive)|the\s+brain)\b/i;
  const attribution = /\b(?:distinguish|tell\s+apart|which\s+(?:instruction|message)\s+(?:came|was)\s+from|who\s+(?:said|wrote|sent))\b[\s\S]{0,160}\b(?:claude|owner)\b/i;
  // "What did Claude tell you about Atlas?", "what instruction did I give you about Atlas": a named speaker's words.
  const speakerWords = /\b(?:what|which|who)\b[\s\S]{0,100}\b(?:Claude|Atlas|Nova|Mira|Knox|Sage|Lyra|Iris|Flagstaff|ChatGPT|Codex|Gemini|Grok|Copilot|Cursor)\b[\s\S]{0,40}\b(?:said|say|told|tell|wrote|write|reported|report|instructed|instruct|sent|send|recommended|recommend|suggested|suggest|asked|ask|finished|finish|confirmed|confirm)\b/i;
  const ownInstruction = /\b(?:instructions?|messages?|notes?|requests?)\b[\s\S]{0,40}\b(?:did\s+I\s+(?:give|tell|send|write)\s+you|I\s+(?:gave|told|sent)\s+you)\b/i;
  const cameFrom = /\b(?:came|comes|coming)\s+from\s+(?:me|the\s+owner|you|Claude|Atlas|Flagstaff)\b/i;
  // A named speaker's words to the owner: only when the question is about what was said to you or me ("What did Claude tell you"),
  // so "What did ChatGPT say?" stays with the mailbox.
  const toOwner = /\b(?:you|me|my|I)\b/i.test(text);
  return search.test(text) || access.test(text) || attribution.test(text) || (toOwner && speakerWords.test(text)) || ownInstruction.test(text) || cameFrom.test(text);
}

/** The words a memory search matches on: significant words of the owner's question, no names of the stores. */
export function memorySearchTerms(message) {
  const words = String(message || '').toLowerCase().match(/[a-z][a-z0-9']{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w.replace(/'s$/, ''))))].slice(0, 8);
}

// ─── Follow-ups on the reply just given (subject-loss audit, 2026-10-24) ───
// "Tell me more about that" and "who wrote it?" right after a memory search re-run that search's terms (from the
// owner's question that produced it) and name the sender each record stores; "Claude" or "owner" need not be said.
// "Tell me more" right after an Office desk reply ("CHE here. Atlas — …") is about that agent's board. Only the
// reply immediately before counts, so an unrelated "tell me more" keeps its ordinary route.
const MORE_ASK = /^(?:tell me more(?: about (?:that|it|this|them|those))?|more(?: details?| detail| info(?:rmation)?)?(?: (?:on|about) (?:that|it|this))?|(?:what|anything) else(?: (?:did|does) (?:it|that|they) say)?|go on|elaborate(?: on (?:that|it))?|expand on (?:that|it)|read (?:it|that|them|the (?:full |whole )?records?)(?: to me)?(?: in full)?|(?:what|which) records? (?:did you find|was that|were those))[\s?.!]*$/i;
const AUTHOR_ASK = /^(?:who (?:wrote|said|sent|reported|made|recorded|authored|stored) (?:it|that|this|them|those|the records?)|who(?:'s| is| was) (?:the )?(?:author|sender|source)(?: of (?:it|that|this))?|where did (?:it|that|this) come from|who (?:is|was) (?:it|that) from|from whom(?: (?:was|is) (?:it|that))?|who said so)[\s?.!]*$/i;
const SEARCH_REPLY = /^I searched (?:again )?(?:for "([^"]{1,200})"|without a topic)/;
const DESK_REPLY = /^CHE here\. ([A-Z][a-z]+) — /;
const FOLLOWUP_HEAD = /^(?:(?:hey|hi|ok|okay)[,\s]+)?(?:che|chay|chey|shay)\b[,:]?\s*|^(?:and|so|but|also)[,\s]+|^(?:please|can you|could you|would you)\s+/i;
const FOLLOWUP_TAIL = /[\s,]+(?:please|sir|che|chay|chey|shay)\s*([?.!]*)$/i;
function followupAsk(message) {
  let t = String(message || '').trim().replace(/[’]/g, "'").replace(/\s+/g, ' ');
  for (let i = 0; i < 2; i += 1) t = t.replace(FOLLOWUP_HEAD, '');
  t = t.replace(FOLLOWUP_TAIL, '$1').trim();
  if (!t || t.length > 80) return '';
  if (AUTHOR_ASK.test(t)) return 'author';
  if (MORE_ASK.test(t)) return 'more';
  return '';
}

/**
 * What a short follow-up refers to, or null:
 *   { referent: 'memory_search', ask: 'more' | 'author', terms }  the search CHE's last reply reported
 *   { referent: 'office_agent', ask: 'more', agentId }             the agent whose desk CHE's last reply read
 */
export function memorySearchFollowup(message, history = []) {
  const ask = followupAsk(message);
  if (!ask) return null;
  const list = Array.isArray(history) ? history : [];
  let i = list.length - 1;
  while (i >= 0 && String(list[i]?.role) !== 'assistant') i -= 1;
  if (i < 0) return null;
  const reply = String(list[i]?.content || list[i]?.text || '').trim();
  const desk = DESK_REPLY.exec(reply);
  if (desk) return ask === 'more' ? { referent: 'office_agent', ask, agentId: desk[1].toLowerCase() } : null;
  const searched = SEARCH_REPLY.exec(reply);
  if (!searched) return null;
  let j = i - 1;
  while (j >= 0 && String(list[j]?.role) !== 'user') j -= 1;
  const asked = j >= 0 ? memorySearchTerms(String(list[j]?.content || list[j]?.text || '')) : [];
  const terms = asked.length ? asked : String(searched[1] || '').split(' ').filter(Boolean);
  return { referent: 'memory_search', ask, terms };
}

function day(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : (text.slice(0, 10) || 'date not recorded');
}

// The sender exactly as the store recorded it (memory_provenance storedSpeaker). A record with none says so.
function storedSender(record) {
  const { speaker } = storedSpeaker(record);
  return speaker ? `${speaker} (as stored)` : 'sender not recorded';
}

/**
 * The owner's memory search reply.
 * brainHits: array of Brain records from brainStore.search, or null when the store could not be read.
 * archive:   Flagstaff archive messages ({at, from, to, text}), or null when the archive could not be read.
 * followup:  memorySearchFollowup's result for "tell me more" / "who wrote it?": its terms are searched instead of
 *            the question's words; 'more' reads each record at greater length, 'author' names only the stored senders.
 * Returns { text, records } where records lists the ids the reply names.
 */
export function memorySearchReply(question, { brainHits = null, archive = null, brainCount = null, followup = null } = {}) {
  const terms = followup?.terms?.length ? followup.terms : memorySearchTerms(question);
  const accessQuestion = !followup && !terms.length && memorySearchIntent(question) && !/\b(?:search|check|find|look|distinguish)\b/i.test(question);
  if (accessQuestion) {
    const parts = [];
    parts.push(brainHits === null ? 'The Brain store could not be read just now.' : `The Brain store is readable${brainCount === null ? '' : `, with ${brainCount} records`}.`);
    parts.push(archive === null ? 'The Flagstaff archive could not be read just now.' : `The Flagstaff archive is readable, with ${archive.length} archived message${archive.length === 1 ? '' : 's'}.`);
    parts.push('Ask me to search with a topic, and I will list only the records that match.');
    return { text: `Yes, sir. ${parts.join(' ')}`, records: [] };
  }
  if (brainHits === null && archive === null) {
    return { text: 'I could not read the Brain store or the Flagstaff archive just now, sir, so I cannot search them. Nothing was searched and nothing is claimed from them.', records: [] };
  }
  const label = terms.length ? `for "${terms.join(' ')}"` : 'without a topic, so no record could match';
  const hits = (brainHits || []).slice(0, 5);
  const messages = (archive || []).filter((m) => terms.some((t) => String(m?.text || '').toLowerCase().includes(t)))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 5);
  const searched = [
    brainHits === null ? 'The Brain store could not be read, so it was not searched.' : `The Brain store returned ${(brainHits || []).length} matching record${(brainHits || []).length === 1 ? '' : 's'}.`,
    archive === null ? 'The Flagstaff archive could not be read, so it was not searched.' : `The Flagstaff archive returned ${messages.length} matching message${messages.length === 1 ? '' : 's'} out of ${archive.length} archived.`,
  ];
  const records = [];
  // "Who wrote it?": only the sender each record stores (memory_provenance storedSpeaker). No author is inferred.
  if (followup?.ask === 'author') {
    if (!hits.length && !messages.length) {
      return { text: `I searched ${label}, sir, and no record matched, so there is no author to name. I have not guessed one.`, records: [] };
    }
    const lines = [`I searched ${label}, sir. Who each matching record names as its sender, as stored:`];
    for (const r of hits) {
      records.push(r.id);
      const { speaker } = storedSpeaker(r);
      lines.push(`- Brain record ${r.id}, ${day(r.created_at)}: ${speaker ? `sender ${speaker}` : 'no sender recorded, so I cannot say who wrote it'}.`);
    }
    for (const m of messages) {
      const id = `session ${m.session || 'unknown'}, message at ${m.at || 'unknown time'}`;
      records.push(id);
      lines.push(`- Flagstaff ${id}: from "${m.from || 'unknown'}" to "${m.to || 'unknown'}" (as stored).`);
    }
    return { text: lines.join('\n'), records };
  }
  const again = followup?.ask === 'more' ? 'again ' : '';
  if (!hits.length && !messages.length) {
    const gap = again ? 'Nothing matched, so there is no more to tell, and I have not filled the gap.' : 'Nothing matched, so I have no record to report and I have not filled the gap.';
    return { text: `I searched ${again}${label}, sir. ${searched.join(' ')} ${gap}`, records: [] };
  }
  const lines = [`I searched ${again}${label}, sir. ${searched.join(' ')}`];
  const bodyMax = again ? 600 : 240;
  for (const r of hits) {
    records.push(r.id);
    lines.push(`- Brain record ${r.id}, ${day(r.created_at)}, stored in ${r.source?.room_label || r.region || 'an unnamed room'}, sender: ${storedSender(r)}. "${r.title || 'untitled'}": ${retrievalBody(r).replace(/\s+/g, ' ').slice(0, bodyMax)}`);
  }
  for (const m of messages) {
    const id = `session ${m.session || 'unknown'}, message at ${m.at || 'unknown time'}`;
    records.push(id);
    lines.push(`- Flagstaff ${id}, from "${m.from || 'unknown'}" to "${m.to || 'unknown'}" (as stored): "${String(m.text || '').replace(/\s+/g, ' ').slice(0, again ? 400 : 160)}"`);
  }
  return { text: lines.join('\n'), records };
}
