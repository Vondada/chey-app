// Cancelling a queued coding job by voice or typing (owner, 2026-10-19: "Cancel that fake commit by
// Che"). One rule for every route: only the owner, only a job that is still "queued", and the record
// is kept with its status set to "cancelled" and who cancelled it and when. Nothing is deleted.
//
// POST /api/job/cancel and the Command Center's /che-cancel-job share cancelQueuedJob. The spoken
// forms reach that same command through codingCancelIntent; resolveCodingCancel picks the job from
// the words and the conversation, and never guesses between two queued jobs. Deterministic, no model.
import { noteJobActivity } from './job_activity.js';

export const CODING_CANCEL_SOURCE = 'che_coding_cancel';
const CODING_KIND = 'self_development';
// Marks CHE's numbered list, so a spoken number on the next turn picks from it.
const LIST_ASK = 'Which coding job should I cancel?';

/** Cancels one job if it is still queued. Returns true when it changed the record. */
export function cancelQueuedJob(job, { via = 'api', now = new Date() } = {}) {
  if (!job || job.status !== 'queued') return false;
  const at = now.toISOString();
  const ranBefore = Number(job.attempts || 0) > 0;
  job.status = 'cancelled';
  job.updated_at = at;
  job.cancelled_at = at;
  job.cancelled_by = 'owner';
  job.cancelled_via = via;
  noteJobActivity(job, ranBefore ? 'Cancelled by the owner while it waited to retry.' : 'Cancelled by the owner before it started.', now);
  return true;
}

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9,
};
const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|[1-9](?:st|nd|rd|th))';
const numberOf = (w) => (/^\d{1,2}$/.test(w) ? Number(w) : NUMBER_WORDS[w] || null);

function spoken(message) {
  let t = String(message || '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:(?:hey|hi|ok|okay)[\s,.!]+)?(?:che|chey|chay|shay)(?![a-z'])[\s,.:;!?-]*/, '');
  for (let i = 0; i < 3; i += 1) {
    t = t.replace(/^(?:please|can you|could you|would you|will you|i want you to|i need you to|go ahead and|just|now)\s+/, '');
  }
  return t.replace(/[\s,]+(?:please|now|right now|for me|thanks|thank you)\s*([.!?]*)$/, '$1').replace(/[.!?]+$/, '').trim();
}

const text = (turn) => String(turn?.content || turn?.text || '');
const lastAssistant = (history) => [...(Array.isArray(history) ? history : [])].reverse().find((h) => String(h?.role) === 'assistant');

// A job id as said or typed: 8 or more hex characters, spaces and dashes allowed ("c2987a73",
// "C2987A73", "c 2987 a73"). Returns it lowercased without separators, or ''.
function idFrom(words) {
  const t = String(words || '').toLowerCase().replace(/^(?:number|id|#)\s*/, '').replace(/^#/, '').trim();
  if (!/^[0-9a-f][0-9a-f\s-]*$/.test(t)) return '';
  const id = t.replace(/[\s-]+/g, '');
  return id.length >= 8 && id.length <= 32 ? id : '';
}

const VERB = '(?:cancel|call off|abort|scrap|kill|stop)';
// "that coding job", "the last coding job", "that fake commit", "the queued job".
const REFERENCE = new RegExp(`^${VERB}\\s+(?:(that|this|the|my|your|che's)\\s+)?(?:(last|latest|most recent|newest|recent|new|queued)\\s+)?(?:(fake|bogus|wrong|accidental|mistaken|unwanted)\\s+)?(?:(?:queued|new)\\s+)?(coding job|code job|coding task|coding commit|coding change|coding update|commit|job|update)(?:\\s+(.+))?$`);
// What may follow the noun: who made it ("by Che", "you just started"), and nothing else, so a
// second request in the same sentence ("… and buy milk") never rides along unheard.
const WHO = '(?:che|chey|chay|shay|chee|you)';
const WHEN = '(?:\\s+(?:earlier|today|just now|for me))?';
const BY_CHE = new RegExp(`^(?:(?:that|which)\\s+)?(?:(?:made|started|queued|created|opened|done)\\s+)?(?:by|from)\\s+${WHO}${WHEN}$|^(?:(?:that|which)\\s+)?${WHO}\\s+(?:just\\s+)?(?:made|started|queued|created|accepted|saved|did|opened)${WHEN}$`);
const PICK = new RegExp(`^(?:${VERB}\\s+)?(?:the\\s+)?(?:(?:number|option|choice|job)\\s+)?${NUM}(?:\\s+one)?$`);
// A reason said after the request ("…, it was a question", "I never asked for it") is not a second
// request; it is set aside before the request is read. Anything else after it is kept and read.
const REASON = /^(?:(?:because|since|as)\s+)?(?:i (?:never|didn't|did not|don't|do not) (?:ask|want|need)(?:ed|s)?\b[^,;.!?]*|(?:it|that|this) (?:was|is|'s) (?:just |only )?(?:a |an )?(?:mistake|question|wrong|fake|bogus|accident|not (?:what )?i (?:asked|wanted))\b[^,;.!?]*|i (?:only |just )?asked a question\b[^,;.!?]*|(?:you|che) (?:misunderstood|got it wrong)\b[^,;.!?]*)[.!?]*$/;
const ANOTHER_REQUEST = /\b(?:and|then|also|but|plus|please)\b/;
function withoutReason(t) {
  for (const m of t.matchAll(/(?:\s*[,.;!?]\s*|\s+)(?=(?:because|since|as|i|it|that|this|you|che)\b)/g)) {
    const rest = t.slice(m.index + m[0].length);
    if (REASON.test(rest) && !ANOTHER_REQUEST.test(rest)) return t.slice(0, m.index).replace(/[,.;!?]+$/, '');
  }
  return t;
}

/** The numbered list of coding jobs in CHE's last reply: short ids in order, or []. */
function listedChoices(history) {
  const last = text(lastAssistant(history));
  if (!last.includes(LIST_ASK)) return [];
  return [...last.matchAll(/(?:^|\s)(\d{1,2})\.\s+([0-9a-f]{8}):/g)].sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => m[2]);
}

/** The coding job CHE named in her most recent "I accepted / saved coding job <id>" reply. */
function referencedJobId(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (String(list[i]?.role) !== 'assistant') continue;
    const m = /\bI (?:accepted|saved|started)(?: OpenCode)? coding job ([0-9a-f]{8,})\b/i.exec(text(list[i]));
    if (m) return m[1].toLowerCase();
  }
  return '';
}

/**
 * The owner's spoken or typed request to cancel a coding job, or null. `input` is what the
 * /che-cancel-job command takes: an id, "last", "number 2" or "" (that one).
 * `weak` marks "cancel that" / "cancel it" / "cancel the job": they mean the coding job only
 * right after CHE accepted one, and never while a money, delete or app request is held.
 */
export function codingCancelIntent(message, history = []) {
  const t = withoutReason(spoken(message));
  if (!t || t.length > 200) return null;
  const listed = listedChoices(history);
  if (listed.length) {
    const pick = PICK.exec(t);
    if (pick) return { input: `number ${numberOf(pick[1])}`, kind: 'pick' };
  }
  const bare = new RegExp(`^${VERB}\\s+(.+)$`).exec(t);
  if (bare && idFrom(bare[1])) return { input: idFrom(bare[1]), kind: 'id' };
  const m = REFERENCE.exec(t);
  if (m) {
    const [, , ordinal, adjective, noun, tail = ''] = m;
    const id = idFrom(tail);
    if (id) return { input: id, kind: 'id' };
    if (tail && !BY_CHE.test(tail)) return null;
    const input = ordinal && ordinal !== 'queued' && ordinal !== 'new' ? 'last' : '';
    // A bare "job" or "update" names a coding job only beside CHE's own acceptance reply, unless
    // it is "fake" or said to be CHE's ("the job you just started"; a tail here always names her).
    const strong = Boolean(adjective) || !['job', 'update'].includes(noun) || Boolean(tail);
    if (strong) return { input, kind: 'reference' };
    return lastReplyNamesJob(history) ? { input, kind: 'reference', weak: true } : null;
  }
  if (/^(?:cancel|call off|abort|scrap)(?:\s+(?:that|it|this|that one))?$/.test(t) && lastReplyNamesJob(history)) {
    return { input: '', kind: 'reference', weak: true };
  }
  return null;
}

function lastReplyNamesJob(history) {
  return /\bI (?:accepted|saved|started)(?: OpenCode)? coding job [0-9a-f]{8,}\b/i.test(text(lastAssistant(history)));
}

const plainId = (id) => String(id || '').toLowerCase().replace(/-/g, '');
const newestFirst = (jobs) => jobs.map((job, index) => ({ job, index }))
  .sort((a, b) => String(b.job.created_at || '').localeCompare(String(a.job.created_at || '')) || a.index - b.index)
  .map((x) => x.job);

/**
 * Which coding job the owner means. Returns one of:
 *   { kind: 'job', job }          exactly one job
 *   { kind: 'choose', jobs }      more than one queued job could be meant: CHE asks
 *   { kind: 'none', running }     no queued coding job at all
 *   { kind: 'missing', id }       no coding job with that id
 *   { kind: 'bad_pick', number, jobs }  a number that is not on the list CHE read
 *   { kind: 'no_list', number }   a number with no list read in this conversation
 *   { kind: 'unclear', words }    words that name no job
 */
export function resolveCodingCancel(input, jobs = [], history = []) {
  const coding = (Array.isArray(jobs) ? jobs : []).filter((job) => job && job.kind === CODING_KIND);
  const queued = newestFirst(coding.filter((job) => job.status === 'queued'));
  const t = String(input || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const byPrefix = (id) => coding.filter((job) => plainId(job.id).startsWith(plainId(id)));
  const one = (id) => {
    const found = byPrefix(id);
    if (!found.length) return { kind: 'missing', id: plainId(id).slice(0, 12) };
    if (found.length === 1) return { kind: 'job', job: found[0] };
    // Two records sharing a prefix: the queued one if it is alone, otherwise CHE asks.
    const open = found.filter((job) => job.status === 'queued');
    if (open.length === 1) return { kind: 'job', job: open[0] };
    return { kind: 'choose', jobs: newestFirst(open.length ? open : found), what: 'match that id' };
  };
  const pick = new RegExp(`^(?:number|option|#)?\\s*${NUM}$`).exec(t);
  if (pick) {
    const number = numberOf(pick[1]);
    const listed = listedChoices(history);
    if (!listed.length) return { kind: 'no_list', number };
    if (!listed[number - 1]) return { kind: 'bad_pick', number, jobs: queued };
    return one(listed[number - 1]);
  }
  const id = idFrom(t);
  if (id) return one(id);
  const rest = t.replace(/\b(?:the|that|this|it|one|my|your|coding|code|job|commit|fake|by|che|queued|please)\b/g, ' ').trim();
  const last = /^(?:last|latest|newest|most recent|recent)$/.test(rest);
  if (rest && !last) return { kind: 'unclear', words: String(input).slice(0, 80) };
  const named = referencedJobId(history);
  if (named) return one(named);
  if (queued.length === 1 || (last && queued.length)) return { kind: 'job', job: queued[0] };
  if (queued.length > 1) return { kind: 'choose', jobs: queued };
  return { kind: 'none', running: newestFirst(coding.filter((job) => job.status === 'running')) };
}

const short = (job) => String(job?.id || '').slice(0, 8);
const asked = (job) => String(job?.request || job?.title || job?.prompt || 'no request recorded').replace(/\s+/g, ' ').trim().slice(0, 80);

/** The numbered list CHE reads when more than one queued job could be meant. */
export function speakChoices(jobs, lead = '', what = 'are queued') {
  const shown = jobs.slice(0, 9);
  const more = jobs.length > shown.length ? ` ${jobs.length - shown.length} more are not read here; say a job's id to cancel one of them.` : '';
  return `${lead}${jobs.length} coding jobs ${what}, sir, so I won't guess which one you mean. `
    + `${shown.map((job, i) => `${i + 1}. ${short(job)}: "${asked(job)}"`).join(' ')}${more} ${LIST_ASK} Say its number. Nothing was cancelled yet.`;
}

/** What CHE says when no single job was found. */
export function speakUnresolved(target) {
  if (target.kind === 'choose') return speakChoices(target.jobs, '', target.what);
  if (target.kind === 'bad_pick') {
    return target.jobs.length > 1 ? speakChoices(target.jobs, `There is no number ${target.number} on that list, sir. `)
      : `There is no number ${target.number} on that list, sir. Nothing was cancelled.`;
  }
  if (target.kind === 'no_list') return `I haven't read you a list of coding jobs in this conversation, sir, so I won't guess which one is number ${target.number}. Nothing was cancelled.`;
  if (target.kind === 'missing') return `I can't find coding job ${target.id} in my records, sir. Nothing was cancelled.`;
  if (target.kind === 'unclear') return `I didn't hear which coding job to cancel in "${target.words}", sir. Say "cancel coding job" and its 8-character id, or "cancel the last coding job". Nothing was cancelled.`;
  const running = target.running?.[0];
  return `No coding job is waiting in the queue, sir, so nothing was cancelled.${running ? ` Coding job ${short(running)} is running, and I can't cancel a running job.` : ''}`;
}

/**
 * The reply after the write, from the record read back from the store. `changed` is whether this
 * turn's write set it; a record that does not read "cancelled" is never called cancelled.
 */
export function speakCancelResult(stored, { changed = false, id = '' } = {}) {
  const sid = stored ? short(stored) : String(id).slice(0, 8);
  if (!stored) return `I can't find coding job ${sid} in my records any more, sir, so I can't confirm it was cancelled.`;
  if (changed && stored.status === 'cancelled') {
    const attempts = Number(stored.attempts || 0);
    const what = attempts > 0
      ? `It had already run ${attempts === 1 ? 'once' : `${attempts} times`} and was waiting to retry, so I stopped the retry. Anything those attempts pushed was not removed.`
      : 'It had not started, so nothing was committed.';
    const mission = stored.objective_id ? ' It was one step of a mission, so the mission may plan another attempt; say "mission status" to check.' : '';
    return `I cancelled coding job ${sid}, sir. ${what}${mission}`;
  }
  if (changed) return `I tried to cancel coding job ${sid}, sir, but its record still reads ${stored.status || 'unknown'}, so it is not cancelled.`;
  if (stored.status === 'running') return `Coding job ${sid} is running, sir, so I did not cancel it. I can only cancel a coding job that has not started. Say "coding status" to hear its progress.`;
  if (stored.status === 'cancelled') return `Coding job ${sid} was already cancelled, sir. Nothing changed.`;
  if (stored.status === 'complete') return `Coding job ${sid} already finished, sir, so there was nothing to cancel. Nothing changed.`;
  if (stored.status === 'failed') return `Coding job ${sid} already failed, sir, so there was nothing to cancel. Nothing changed.`;
  return `Coding job ${sid} is ${String(stored.status || 'in an unknown state').replace(/_/g, ' ')}, sir, so I did not cancel it.`;
}
