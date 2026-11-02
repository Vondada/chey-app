// Office and agent work is not CHE's conversation. A task line ("Review the recent repository inspection report…")
// belongs in the Office view and the mailbox. It must never be replayed as CHE's own words, nor fed back to the model
// as something the owner said or CHE answered (owner, 2026-10-21).
import { BRAIN_REGIONS, retrievableOwnerRecord } from './brain_store.js';
import { OFFICE_AGENTS } from './office_router.js';

const MIN_TASK_CHARS = 30;
// Fewer words than this left after the task lines are removed is no answer: the whole reply becomes the notice.
const MIN_KEPT_WORDS = 8;
export const AGENT_TASK_NOTICE = 'That is an internal Office task, sir, so I am not repeating it here. It is in the Office view.';

const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

function taskTexts(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((t) => norm(t?.task))
    .filter((t) => t.length >= MIN_TASK_CHARS);
}

/** Chat history without the assistant turns that repeat an Office task. The owner's own turns always stay. */
export function dropAgentTaskTurns(history = [], tasks = []) {
  const texts = taskTexts(tasks);
  if (!texts.length || !Array.isArray(history)) return Array.isArray(history) ? history : [];
  return history.filter((turn) => {
    if (turn?.role !== 'assistant') return true;
    const body = norm(turn.content ?? turn.text);
    return !texts.some((t) => body.includes(t));
  });
}

/** True when a reply would show an Office task as if CHE said it. */
export function replyRepeatsAgentTask(reply = '', tasks = []) {
  const body = norm(reply);
  return taskTexts(tasks).some((t) => body.includes(t));
}

// A sentence repeats a task when it holds a whole task line or one of its long sentences, or when it is itself a long
// verbatim piece of a task line. A short phrase a task happens to share ("check the transcript") is not a repeat.
function repeatsTask(sentence, texts) {
  const s = norm(sentence).replace(/^[\s\-*•\d.)"'“”‘’]+|["'“”‘’.!?\s]+$/g, '');
  if (!s) return false;
  return texts.some((t) => s.includes(t)
    || (s.length >= MIN_TASK_CHARS && s.split(' ').length >= 5 && t.includes(s))
    || t.split(/(?<=[.!?])\s+/).some((part) => part.length >= MIN_TASK_CHARS && s.includes(part)));
}

const wordCount = (text) => String(text).split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

/**
 * The reply without the sentences that repeat an Office task: { text, removed }. The rest of the answer stays. Only
 * when nothing meaningful is left, or a task line cannot be cut out sentence by sentence, is the whole reply the notice.
 */
export function guardAgentTaskReply(reply = '', tasks = []) {
  const text = String(reply ?? '');
  const texts = taskTexts(tasks);
  if (!texts.length || !text.trim()) return { text, removed: [] };
  const removed = [];
  const lines = text.split('\n').map((line) => {
    const parts = line.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g) || [line];
    const kept = parts.filter((part) => (repeatsTask(part, texts) ? (removed.push({ rule: 'office_task_line', sentence: part.trim() }), false) : true));
    if (kept.length === parts.length) return line;
    const rest = kept.join('').trimEnd();
    return /\p{L}/u.test(rest) ? rest : null;
  }).filter((line) => line !== null);
  const kept = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const whole = { text: AGENT_TASK_NOTICE, removed: [{ rule: 'office_task_reply', sentence: text }] };
  if (!removed.length) return replyRepeatsAgentTask(text, tasks) ? whole : { text, removed: [] };
  if (replyRepeatsAgentTask(kept, tasks) || wordCount(kept) < MIN_KEPT_WORDS) return whole;
  return { text: kept, removed };
}

// Records that hold Office work: a task line, its work log, a handoff, a queued job.
const OFFICE_KINDS = new Set(['task', 'work', 'collaboration', 'job']);
const OFFICE_SOURCES = new Set(['team_task', 'agent_work_log', 'handoff', 'job']);
// Words that name the Office on their own: its rooms, desks, agents and the acts of handing work over.
const OFFICE_TOPIC = new RegExp(`\\b(?:office|agents?|desks?|handoffs?|delegat\\w*|(?:re)?assign\\w*|war\\s*room|${OFFICE_AGENTS.join('|')})\\b`, 'i');
// Generic work nouns ("job", "task", "queue", "worker") name the Office's work only when the sentence points at work in
// progress or the owner's list ("the open tasks", "your jobs", "what jobs are running"), not in a general question such
// as "two job records disagree on whether a charge happened" (certification run 19, eer-30).
const WORK_NOUN = '(?:tasks?|to-?dos?|jobs?|queues?|workers?)';
const OFFICE_WORK = new RegExp(`\\b(?:open|queued|running|pending|active|current|your|my|our|the\\s+(?:open|queued|team|office))\\s+(?:[\\w'-]+\\s+){0,3}${WORK_NOUN}\\b|\\b${WORK_NOUN}\\s+(?:are|is)\\s+(?:running|queued|open|pending|left|waiting|done|in\\s+progress)\\b|\\b${WORK_NOUN}\\s+(?:queue|board|list|backlog|status)\\b|\\b(?:what|which)\\s+${WORK_NOUN}\\b`, 'i');

export function isOfficeWorkRecord(record = {}) {
  return OFFICE_KINDS.has(record.kind) || OFFICE_SOURCES.has(record.source?.kind) || record.region === BRAIN_REGIONS.tasks;
}

/** Whether the owner's message is about the Office, its agents or its tasks. */
export function asksAboutOffice(message = '') {
  const text = String(message || '');
  return OFFICE_TOPIC.test(text) || OFFICE_WORK.test(text);
}

/**
 * The filter for Brain records retrieved as chat grounding. Office work records reach the model only when the owner
 * asks about the Office or its tasks. Otherwise a task line that merely shares words with an unrelated question is put
 * in the model's context, and the model repeats it (certification runs 17 and 18).
 */
export function chatBrainHit(message = '') {
  const office = asksAboutOffice(message);
  return (record) => retrievableOwnerRecord(record) && (office || !isOfficeWorkRecord(record));
}
