// "What is my coding team discussing for coding job 6407f0b8? Show the crew's latest messages." (R-16). The question
// went to repository inspection and came back as HTTP 500 (status probes 41787795973, 41790544924). A crew's
// discussion is a stored record (conversations.js recordCrewThread, saved when a coding run ends), so it is read from
// there: the named job's latest messages, or plainly that no crew record exists yet. Read-only; no model call.
import { CREW_THREADS_KEY } from './conversations.js';
import { ndjsonReply } from './ndjson_reply.js';

const ASK = /\b(?:coding\s+)?(?:team|crew|engineers?|agents?)(?:'s)?\b[\s\S]{0,60}\b(?:discuss(?:ing|ed)?|saying|said|talk(?:ing|ed)?|messages?|thread|conversation|chat)\b|\b(?:discussion|messages?|thread|conversation|chat)\b[\s\S]{0,40}\b(?:coding\s+)?(?:team|crew)\b/i;
const JOB = /\b(?:coding\s+)?job\s+([0-9a-f]{6,36})\b/i;

/** The job id a crew-discussion question names, or null when the message is not one. */
export function crewThreadRequest(message) {
  const text = String(message || '');
  if (text.length > 400 || !ASK.test(text)) return null;
  const id = text.match(JOB)?.[1]?.toLowerCase();
  return id ? { jobId: id } : null;
}

const clip = (v, n) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** The reply, from the stored job and crew records only. */
export function crewThreadReply({ jobId }, { jobs = [], threads = [] } = {}) {
  const job = jobs.find((j) => String(j?.id || '').toLowerCase().startsWith(jobId));
  const short = job ? String(job.id).slice(0, 8) : jobId.slice(0, 8);
  // A thread names its job (job_id); older threads only carry the request as their title.
  // The title as recordCrewThread wrote it: the first 90 characters, verbatim (Codex on #932).
  const title = job ? String(job.request || job.prompt || 'Coding job').replace(/^\s*(?:update|change) your code\s*:?\s*/i, '').slice(0, 90) : '';
  // A thread linked by job id wins; the title only finds an unlinked one when none is linked (Codex on #932: a
  // foreground run of the same request is saved without a job id and must not stand in for the job's own thread).
  const all = Array.isArray(threads) ? threads : [];
  const linked = all.filter((t) => t?.job_id && String(t.job_id).toLowerCase().startsWith(jobId));
  const thread = (linked.length ? linked : all.filter((t) => !t?.job_id && title && String(t?.title || '') === title)).at(-1);
  if (!job && !thread) return `I have no coding job ${short} in my records, sir, so there is no crew discussion to show.`;
  if (!thread) {
    const status = String(job.status || 'unknown');
    return status === 'running' || status === 'queued'
      ? `Coding job ${short} is ${status}, sir. My crew's discussion is saved when a run ends, so there is no crew record for it yet.`
      : `Coding job ${short} is ${status}, sir, but no crew discussion was saved for it.`;
  }
  const messages = (thread.messages || []).slice(-6).map((m, i) => `${i + 1}. ${clip(m.from || 'Crew', 40)}: ${clip(m.text, 320)}`);
  const outcome = thread.outcome ? ` Outcome: ${clip(thread.outcome, 200)}.` : '';
  return `Here are the last ${messages.length} messages from my crew on coding job ${short}, sir (saved ${String(thread.at || '').slice(0, 16).replace('T', ' ')} UTC).${outcome}\n${messages.join('\n')}`;
}

/** The whole turn for /api/chat, or null when the message is not a crew-discussion question. */
export async function crewThreadTurn(message, storage, data) {
  const ask = crewThreadRequest(message);
  if (!ask) return null;
  const threads = (await Promise.resolve().then(() => storage.get(CREW_THREADS_KEY)).catch(() => null)) || [];
  return ndjsonReply(crewThreadReply(ask, { jobs: data?.jobs || [], threads }), { source: 'che_crew_thread', model_calls: 0 });
}
