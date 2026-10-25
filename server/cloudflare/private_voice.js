// Private voice (owner question, 2026-10-25: "Is there a way I can use live voice and it doesn't go to OpenAI or
// anyone and stays private?").
//
// On the iPhone, Private voice keeps the microphone audio on the phone (Apple's on-device recognizer only, never the
// OpenAI Realtime engine) and speaks replies with the on-device Kokoro voice (never ElevenLabs or Fish). The owner's
// words still reach this Worker as text, because CHE's answer is computed here. A chat request that carries
// `private: true` is answered only by Cloudflare Workers AI through this Worker's own `AI` binding:
//
//   1. For the whole request (and the background work it starts), every outbound fetch to a host that is not CHE's
//      own or the owner's own compute is refused by Security Intelligence's egress guard (holdPrivateEgress).
//   2. The model router answers with the Workers AI binding only (routeText checks privateEgressHeld()); no Groq,
//      Gemini, Cerebras, OpenRouter, OpenAI, xAI, Anthropic or keyless engine is tried.
//   3. Requests that only make sense with an outside service (web search, news, research, other AIs, sub-agents,
//      picture reading, video rendering) are refused up front, saying why and that nothing was sent.
//
// This module holds the request test and the refusal wording; the guard lives in security_intelligence.js.

/** True when the phone sent this turn with Private voice on. */
export function isPrivateRequest(body) {
  if (!body || typeof body !== 'object') return false;
  return body.private === true || body.client?.private_voice === true;
}

const ENGINE = 'Cloudflare Workers AI (CHE\'s own Cloudflare account)';

// Each entry: what the request needs, and who would receive the words. Ordered most specific first.
const BLOCKS = [
  {
    kind: 'other_ai',
    test: /\b(?:ask|consult|check with|run (?:it|this|that) (?:by|past)|get|send (?:it|this|that) to)\s+(?:chat ?gpt|gpt|open ?ai|claude|anthropic|gemini|grok|codex|copilot|cursor|perplexity|deep ?seek|another ai|the other ais?|other ais?)\b|\bsecond opinion\b|\bcompare (?:the )?(?:models?|ais?)\b|\bround ?table\b|\bwar room\b/i,
    what: 'asking another AI',
    who: 'that AI company',
  },
  {
    kind: 'web_research',
    test: /\b(?:research|look (?:it |that |this )?up|search (?:the )?(?:web|internet|online)|search for|google (?:it|that|this)|browse|web ?search|study (?:this|that|the) (?:page|site|link)|latest news|the news|headlines|what(?:'s| is) new (?:in|with))\b|https?:\/\//i,
    what: 'a web search or research',
    who: 'search engines and the websites I would open',
  },
  {
    kind: 'agents',
    test: /\b(?:sub-?agents?|the crew|office agents?|coding job|open a (?:pull request|pr)|update your (?:own )?code|fix your (?:own )?code|change your code)\b/i,
    what: 'sending work to CHE\'s agents or coding crew',
    who: 'the outside AI services they use',
  },
  {
    kind: 'media',
    test: /\b(?:make|render|generate|create|produce)\s+(?:me\s+)?(?:a |an |the )?(?:video|film|movie|short|youtube video)\b|\bupload (?:it |this |that )?to youtube\b/i,
    what: 'making or uploading a video',
    who: 'the outside rendering and upload services',
  },
];

/**
 * The refusal for a private turn that would send the owner's words outside CHE, or null when the turn can be
 * answered by Workers AI alone. Attachments are refused because CHE reads pictures and files with outside vision AI.
 */
export function privateToolBlock(message, body = {}) {
  if (body?.attachment) {
    return {
      kind: 'attachment',
      text: 'Private voice is on, so I did not read that attachment: I read pictures and files with outside AI services, and that would send it to them. Nothing was sent. Say "turn off private voice" if you want me to read it.',
    };
  }
  const text = String(message || '');
  // Capabilities the phone guessed for the turn (web_research and the like) are cleared by privateRequestBody,
  // not refused: only the owner's own words decide that a turn needs an outside service.
  for (const block of BLOCKS) {
    if (block.test.test(text)) {
      return {
        kind: block.kind,
        text: `Private voice is on, so I did not do that: ${block.what} would send your words to ${block.who}. Nothing was sent. Say "turn off private voice" if you want me to go ahead.`,
      };
    }
  }
  return null;
}

/** Fields every private reply's done event carries, so the phone can show who answered. */
export function privateDoneFields() {
  return { private: true, private_engine: 'cloudflare-workers-ai' };
}

/** The honest error when Workers AI itself could not answer a private turn. */
export function privateEngineError(detail = '') {
  const error = new Error(`Private voice is on, so only ${ENGINE} may answer, and it did not${detail ? ` (${String(detail).slice(0, 200)})` : ''}. No outside AI was used.`);
  error.category = 'temporary_cloud_unavailable';
  error.private_only = true;
  error.retryable = true;
  return error;
}

/** Strips a private request's fields that would hand work to outside services before the chat route reads them. */
export function privateRequestBody(body) {
  return {
    ...body,
    requested_capabilities: [],
    plugin_tools: [],
    plugin_instructions: [],
    plugin_recommendations: false,
  };
}
