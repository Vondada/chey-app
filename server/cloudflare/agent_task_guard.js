// Office and agent work is not CHE's conversation. A task line ("Review the recent repository inspection report…")
// belongs in the Office view and the mailbox. It must never be replayed as CHE's own words, nor fed back to the model
// as something the owner said or CHE answered (owner, 2026-10-21).
const MIN_TASK_CHARS = 30;

function taskTexts(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((t) => String(t?.task || '').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((t) => t.length >= MIN_TASK_CHARS);
}

/** Chat history without the assistant turns that repeat an Office task. The owner's own turns always stay. */
export function dropAgentTaskTurns(history = [], tasks = []) {
  const texts = taskTexts(tasks);
  if (!texts.length || !Array.isArray(history)) return Array.isArray(history) ? history : [];
  return history.filter((turn) => {
    if (turn?.role !== 'assistant') return true;
    const body = String(turn.content ?? turn.text ?? '').replace(/\s+/g, ' ').toLowerCase();
    return !texts.some((t) => body.includes(t));
  });
}

/** True when a reply would show an Office task as if CHE said it. */
export function replyRepeatsAgentTask(reply = '', tasks = []) {
  const body = String(reply || '').replace(/\s+/g, ' ').toLowerCase();
  return taskTexts(tasks).some((t) => body.includes(t));
}
