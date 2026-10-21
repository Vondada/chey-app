// The owner's memory search, answered from the Brain store and the Flagstaff archive themselves.
//
// Read-only. Every answer names the records it actually read (id, date, where each was stored, and the sender
// the store recorded), or it says that nothing matched, or that a store could not be read. Who said something
// is never inferred from wording or tone: a speaker is named only when the stored record names one.
const STOP = new Set([
  'about', 'above', 'after', 'again', 'also', 'and', 'are', 'between', 'can', 'could', 'did', 'does', 'dates', 'date',
  'each', 'earlier', 'for', 'from', 'give', 'had', 'have', 'how', 'ids', 'instruction', 'instructions', 'into', 'its',
  'message', 'messages', 'more', 'not', 'one', 'our', 'out', 'over', 'please', 'previous', 'record', 'records', 'search',
  'show', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'till', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'long', 'term', 'memory', 'flagstaff', 'brain', 'claude', 'owner', 'check', 'find', 'look', 'given', 'gave', 'said', 'came', 'made', 'make',
  'distinguish', 'between', 'separate', 'source', 'sources', 'stored', 'store', 'access', 'available', 'right', 'now',
]);

// "Search my long-term memory…", "do you have access to the Flagstaff records", "which instruction came from Claude".
export function memorySearchIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey|shay)[,:]?\s+/i, '');
  if (!text) return false;
  const search = /\b(?:search|check|look\s+(?:through|in|up)|find|dig\s+(?:through|into))\b[\s\S]{0,60}\b(?:long[- ]term\s+memory|my\s+memory|the\s+brain|flagstaff\s+(?:records?|history|archive|messages?))\b/i;
  const access = /\b(?:do\s+you\s+have|can\s+you)\s+(?:access\s+to\s+)?(?:my\s+)?(?:long[- ]term\s+memory|flagstaff\s+(?:records?|history|archive)|the\s+brain)\b/i;
  const attribution = /\b(?:distinguish|tell\s+apart|which\s+(?:instruction|message)\s+(?:came|was)\s+from|who\s+(?:said|wrote|sent))\b[\s\S]{0,160}\b(?:claude|owner)\b/i;
  return search.test(text) || access.test(text) || attribution.test(text);
}

/** The words a memory search matches on: significant words of the owner's question, no names of the stores. */
export function memorySearchTerms(message) {
  const words = String(message || '').toLowerCase().match(/[a-z][a-z0-9']{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w.replace(/'s$/, ''))))].slice(0, 8);
}

function day(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : (text.slice(0, 10) || 'date not recorded');
}

// The sender exactly as the store recorded it. A record with no recorded sender says so.
function storedSender(record) {
  const origin = record.origin || record.source?.origin || '';
  if (origin) return `${origin} (as stored)`;
  return 'sender not recorded';
}

/**
 * The owner's memory search reply.
 * brainHits: array of Brain records from brainStore.search, or null when the store could not be read.
 * archive:   Flagstaff archive messages ({at, from, to, text}), or null when the archive could not be read.
 * Returns { text, records } where records lists the ids the reply names.
 */
export function memorySearchReply(question, { brainHits = null, archive = null, brainCount = null } = {}) {
  const terms = memorySearchTerms(question);
  const accessQuestion = !terms.length && memorySearchIntent(question) && !/\b(?:search|check|find|look|distinguish)\b/i.test(question);
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
  if (!hits.length && !messages.length) {
    return { text: `I searched ${label}, sir. ${searched.join(' ')} Nothing matched, so I have no record to report and I have not filled the gap.`, records: [] };
  }
  const lines = [`I searched ${label}, sir. ${searched.join(' ')}`];
  const records = [];
  for (const r of hits) {
    records.push(r.id);
    lines.push(`- Brain record ${r.id}, ${day(r.created_at)}, stored in ${r.source?.room_label || r.region || 'an unnamed room'}, sender: ${storedSender(r)}. "${r.title || 'untitled'}": ${String(r.body || '').replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  for (const m of messages) {
    const id = `session ${m.session || 'unknown'}, message at ${m.at || 'unknown time'}`;
    records.push(id);
    lines.push(`- Flagstaff ${id}, from "${m.from || 'unknown'}" to "${m.to || 'unknown'}" (as stored): "${String(m.text || '').replace(/\s+/g, ' ').slice(0, 160)}"`);
  }
  return { text: lines.join('\n'), records };
}
