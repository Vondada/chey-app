// What CHE needs to read a Flagstaff message correctly: the conversation with that peer, what kind of
// message it is (a status report, a question or a request), and a check that a reply does not claim work
// is under way. CHE cannot run tools from a Flagstaff reply, so she must not say she is doing something.

const TEXT_LIMIT = 500;
const INTERROGATIVE = /^(?:what|why|how|when|where|which|who|whose|is|are|was|were|do|does|did|can|could|would|should|will|have|has|any)\b/i;
const REQUEST = /^(?:please\s+)?(?:merge|deploy|review|check|tell|send|open|run|build|fix|publish|make|find|look|write|update|change|start|give|show|list|inspect|test|cancel|delete|remove|add|create|confirm|approve|ship|verify)\b|\b(?:please|can you|could you|will you|would you)\b/i;
const REQUEST_INSIDE = /\b(?:do all|do this|merge it|deploy it|fix it|review it|check it|run it|build it|publish it|make it|send it)\b|\bdo not (?:stop|wait)\b/i;
const STATUS =/\b(?:merged|not merged|open|still open|done|not done|finished|deployed|passed|failed|fixed|pushed|verified|not verified|blocked|blocker|remaining|still needed|still missing|summary|shipped|waiting|on main|PR\s*#?\d+)\b/i;

// The sender's conversation: its messages and CHE's replies to it, oldest first, without the current message.
export function threadFor(messages, sender, currentId, { limit = 8 } = {}) {
  const peer = String(sender || '').toLowerCase();
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.id && m.id !== currentId && m.at)
    .filter((m) => {
      const from = String(m.from || '').toLowerCase();
      const to = String(m.to || '').toLowerCase();
      return (from === peer && to === 'che') || (from === 'che' && to === peer);
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-limit)
    .map((m) => ({ from: String(m.from || ''), at: String(m.at || ''), text: String(m.text || '').slice(0, TEXT_LIMIT) }));
}

// "status" reports what was done or what is still open; "question" asks something; "request" asks CHE or
// the owner to do something. A question mark or a leading question word makes it a question, a request verb
// or "please" makes it a request, and a status word makes it a status report.
export function messageKind(text) {
  const t = String(text || '').trim();
  if (!t) return 'statement';
  if (/\?\s*$/.test(t) || INTERROGATIVE.test(t)) return 'question';
  if (REQUEST.test(t) || REQUEST_INSIDE.test(t)) return 'request';
  if (STATUS.test(t)) return 'status';
  return 'statement';
}

// The guidance the reply model gets for each kind. A status report is information, not an ask.
export function kindGuidance(kind) {
  if (kind === 'status') {
    return 'THIS MESSAGE IS A STATUS REPORT. The sender is telling you what it did or what is still open. Acknowledge the specific facts it states and say which you agree with or need checked. Answer any question inside it. Do not ask whether to do the work, and do not offer to merge, deploy, fix or review it unless the sender asked you to. Do not answer as if you were accused of something it did not say.';
  }
  if (kind === 'question') return 'THIS MESSAGE IS A QUESTION. Answer it first, from the thread, REPOSITORY GROUNDING or SOURCE. If none of them shows the answer, say so and say what you checked.';
  if (kind === 'request') return 'THIS MESSAGE IS A REQUEST. Answer what was asked. Say what you can do from this reply and what needs the owner\'s yes. Do not promise a result or a time.';
  return 'THIS MESSAGE IS A STATEMENT. Acknowledge it in one or two sentences and say whether you agree. Do not invent a request in it.';
}

// Replies that claim work is under way or ask a peer whether to act on its status report. Each is flagged once.
const IN_PROGRESS = /\bI(?:'m| am)\s+(?:now\s+)?(?:merging|deploying|running|starting|working on|auditing|reviewing|setting up|building|fixing|finishing|wiring|creating|checking|testing)\b/i;
const CLAIMED_DONE = /\bI\s+(?:have\s+)?(?:started|merged|deployed|finished|completed|fixed|pushed)\s+(?:it|that|this|them|the|those|these|PRs?|pull requests?|branch|work)\b/i;
const ASKS_TO_ACT = /\b(?:let me know|just say)\b[^.]*\b(?:if you (?:want|would like) me to)\b|\bif you (?:want|would like) me to\b|\bshould I (?:merge|deploy|fix|review|do)\b|\bdo you want me to (?:merge|deploy|fix|review|do)\b/i;
const PROBLEM = {
  in_progress: 'the reply says CHE is doing work now; it cannot run tools from a Flagstaff reply',
  claimed_done: 'the reply says CHE finished work that no verified state shows',
  asks_to_act: 'the sender only reported status, so the reply must not ask whether to act on it',
};

export function progressClaimProblems(text, { kind = '' } = {}) {
  const problems = new Set();
  const body = String(text || '');
  if (IN_PROGRESS.test(body)) problems.add(PROBLEM.in_progress);
  if (CLAIMED_DONE.test(body)) problems.add(PROBLEM.claimed_done);
  if (kind === 'status' && ASKS_TO_ACT.test(body)) problems.add(PROBLEM.asks_to_act);
  return [...problems];
}
