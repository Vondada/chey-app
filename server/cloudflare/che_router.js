// CHE router: the single path between the owner, CHE and the Office agents.
// The rules live in office_router.js; this module is the entry point the
// Worker uses for chat/voice and every Grok (xAI) call.
import { assertOwnerTalksToCheOnly, grokEnvelope } from './office_router.js';

// Owner → CHE only; agents → CHE only. Throws a 403 error otherwise.
export function assertOwnerToCheOnly(body) {
  return assertOwnerTalksToCheOnly(body);
}

// Every Grok call from the Office is wrapped with router 'che' and the
// calling agent_id plus its office/<agent>/<job> thread.
export function grokRequest({ agentId, jobId, prompt }) {
  return grokEnvelope({ agentId, jobId, prompt });
}
