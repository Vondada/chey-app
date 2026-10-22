// When the owner asks for something CHE cannot do yet, she does not refuse. The ability is queued for her as a
// self-development job (the path the owner already has for code changes), and she says so. That job only opens a
// pull request: nothing is merged or deployed by it (AGENTS.md). Money, deletion and secrets are never queued.

// A reply that refuses an ability: "I don't have anywhere to store that", "I cannot make videos".
const REFUSAL = /\b(?:I|CHE)\s+(?:do\s+not|don['’]t|cannot|can['’]t|can\s+not|am\s+unable\s+to|am\s+not\s+able\s+to)\s+(?:have|store|hold|keep|save|add|create|make|build|do|reach|access|open|find|send|book|render)\b/i;
// An answer about a stored record or memory is a memory answer, never a missing ability. ("notes" is left out: a
// refusal often repeats the owner's own word for the file, and that is not a memory answer.)
const RECORD = /\b(?:records?|memor(?:y|ies)|confirm(?:ed|ation)?)\b/i;
// Never queued: money (paying, buying, ordering, booking, subscribing, transferring), deletion and secrets.
const NEVER = /\b(?:passwords?|passcodes?|secrets?|tokens?|api\s*keys?|credentials?|keychain|pay|paying|payments?|purchases?|buy|buying|orders?|ordering|book|booking|subscribe|subscription|transfers?|transferring|money|bank|delete|deleting|remove|removing|erase|wipe)\b/i;
// Actions CHE already has: Projects, Office tasks and the named agents. A refusal that comes back for one of these is a
// routing miss, not a missing ability, so it is never queued as a self-development job (2026-10-22: "create a project
// called Behavior Test and assign Atlas one task" was queued as "adding that ability to myself").
const EXISTING_ACTION = /\b(?:projects?|tasks?|assign(?:s|ed|ing|ment)?|office|team|agents?|nova|atlas|mira|knox|sage|lyra|iris|workshop)\b/i;
// An actionable request from the owner, not a question about what CHE already knows.
const ASKS = /\b(?:can\s+you|could\s+you|would\s+you|please|make|create|build|add|store|save|keep|hold|set\s+up|learn|track|give\s+me|i\s+want|i\s+need)\b/i;

/** The ability to queue for CHE herself, or null when the reply is not a missing-ability refusal. */
export function capabilityGap(message, reply) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  const answer = String(reply || '');
  if (!text || text.length > 1200 || !REFUSAL.test(answer) || RECORD.test(answer)) return null;
  if (NEVER.test(text) || !ASKS.test(text) || EXISTING_ACTION.test(text)) return null;
  const ask = text.slice(0, 300);
  const key = `capability:${ask.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120)}`;
  return {
    key,
    fields: {
      kind: 'self_development',
      title: `Add ability: ${ask}`.slice(0, 100),
      prompt: `The owner asked CHE: "${ask}". CHE cannot do this yet. Add the smallest working ability to CHE herself in the Worker, with a regression test through /api/chat, and open a pull request only. Do not merge, deploy, spend money, delete anything, or read or store any password or secret.`,
      idempotency_key: key,
    },
  };
}

export function capabilityReply(jobId) {
  return `I am adding that ability to myself now, sir. Job ${jobId} is queued, and I will tell you what it does when it is ready. This message merges and deploys nothing.`;
}
