// "Did the blue cube picture finish?" (reliability inventory: STILL BROKEN, no route; it fell to ordinary chat, where the
// model could invent an outcome). Answered from records only: the Modal picture jobs (media.js MODAL_IMAGE_KEY, kept
// current by the alarm's reconcileModalImages) and the saved Gallery items. Nothing is started, no model is called.

const DONE = String.raw`(?:finish(?:ed)?|done|ready|complete(?:d)?|work(?:ed)?|come\s+out|go\s+through|fail(?:ed)?|save[d]?)`;
const PICTURE = String.raw`(?:picture|image|photo|render|drawing|pic)`;
const ASK = [
  new RegExp(String.raw`\b(?:did|has|have|is|was)\b[^.?!]{0,50}\b${PICTURE}s?\b[^.?!]{0,40}\b${DONE}\b`, 'i'),
  new RegExp(String.raw`\b(?:check(?:\s+on)?|status\s+of|what\s+happened\s+(?:to|with))\s+(?:the\s+|my\s+)?(?:previous|last|latest|earlier|that)?\s*(?:[\w-]+\s+){0,4}?${PICTURE}\b`, 'i'),
  new RegExp(String.raw`\bhow(?:'s|\s+is)\s+(?:the|my|that)\s+(?:[\w-]+\s+){0,3}?${PICTURE}\s+(?:coming|going|doing)\b`, 'i'),
];
// Making or showing a picture belongs to its own routes.
const OTHER = /\b(?:make|create|generate|draw|render\s+(?:a|an|me)|show\s+me|open|send|delete)\b/i;
const STOP = new Set(['did', 'has', 'have', 'is', 'was', 'the', 'my', 'a', 'an', 'of', 'that', 'this', 'check', 'on', 'status', 'what', 'happened',
  'to', 'with', 'previous', 'last', 'latest', 'earlier', 'picture', 'pictures', 'image', 'images', 'photo', 'render', 'drawing', 'pic', 'finish',
  'finished', 'done', 'ready', 'complete', 'completed', 'work', 'worked', 'come', 'out', 'go', 'through', 'fail', 'failed', 'save', 'saved', 'yet',
  'how', 'coming', 'going', 'doing', 'its', 'it', 'sir', 'che', 'chay', 'chey', 'hey', 'you', 'your', 'from', 'earlier', 'today']);

/** The words that name the picture ("blue cube"), or null when the message is not a picture-status question. */
export function pictureStatusIntent(message) {
  const text = String(message || '').trim();
  if (!text || OTHER.test(text) || !ASK.some((re) => re.test(text))) return null;
  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  return { words };
}

const matches = (words, ...texts) => {
  if (!words.length) return true;
  const hay = texts.join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
};
const stamp = (iso) => (iso ? `${String(iso).slice(0, 16).replace('T', ' at ')} UTC` : 'an unrecorded time');

/** The answer, from the job records and the saved Gallery items. */
export function pictureStatusReply({ words = [] } = {}, { jobs = [], items = [] } = {}) {
  const named = words.length ? `"${words.join(' ')}" ` : '';
  const job = [...jobs].reverse().find((j) => matches(words, j.title || '', j.prompt || ''));
  if (job) {
    const id = job.call_id ? ` (job ${job.call_id})` : '';
    if (job.state === 'saved') return { state: 'saved', text: `Yes, sir: the ${named}picture finished${id}. It is saved in the Gallery as ID ${job.item?.id || 'unknown'}, started ${stamp(job.created_at)}.`, media_id: job.item?.id || null };
    if (job.state === 'failed') return { state: 'failed', text: `No, sir: the ${named}picture failed${id}: ${job.error || 'no reason was recorded'}. Nothing was saved, and I started nothing new.` };
    return { state: 'running', text: `Not yet, sir: the ${named}picture${id} was started ${stamp(job.created_at)} and has no result recorded yet. I check it on the next pass; nothing new was started.` };
  }
  const item = [...items].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).find((i) => matches(words, i.title || '', i.prompt || ''));
  if (item) return { state: 'saved', text: `Yes, sir: a ${named}picture is saved in the Gallery as ID ${item.id}, created ${stamp(item.created_at)}.`, media_id: item.id };
  return { state: 'none', text: `I have no picture job or saved picture ${named ? `matching ${named.trim()}` : 'on record'}, sir, so I can't say it finished. Nothing new was started.` };
}
