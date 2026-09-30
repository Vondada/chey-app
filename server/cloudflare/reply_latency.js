// Reply-latency helpers: keep ordinary owner chat on the fast path.
// Heavy quality routing + huge prompts are reserved for turns that need them.

const HEAVY_TURN = /\b(debug|code|implement|architect|research|analy[sz]e|analysis|report|backtest|legal|financial|medical|compare|plan|design|build|fix|investigate|write|create|generate|image|video|delegate|screenplay|novel|campaign|latest|current|prior art|feasib)\b/i;

/**
 * True when the owner turn is short, has no requested specialist caps, and
 * does not look like a deep/tool-heavy job. Used to skip slow pre-work and
 * prefer the compact/fast model route.
 */
export function isLikelyCasualChat(message, requestedCapabilities = []) {
  const text = String(message || '').trim();
  if (!text || text.length > 240) return false;
  if (Array.isArray(requestedCapabilities) && requestedCapabilities.length > 0) return false;
  return !HEAVY_TURN.test(text);
}

/**
 * Build the ordered model attempts for an owner chat turn.
 * preferFast: compact prompt + fast route first (ordinary replies).
 * Otherwise: full quality prompt first (complex/tool-backed turns).
 */
export function chatModelAttempts({
  preferFast,
  model,
  strongModel,
  systemPrompt,
  compactPrompt,
  turns,
}) {
  const history = Array.isArray(turns) ? turns : [];
  if (preferFast) {
    return [
      { model, system: compactPrompt, turns: history.slice(-6), route: 'fast' },
      { model, system: systemPrompt, turns: history, route: 'quality' },
      { model: strongModel, system: compactPrompt, turns: history.slice(-2), route: 'quality' },
    ];
  }
  return [
    { model, system: systemPrompt, turns: history, route: 'quality' },
    { model, system: compactPrompt, turns: history.slice(-4), route: 'quality' },
    { model: strongModel, system: compactPrompt, turns: history.slice(-2), route: 'quality' },
  ];
}

/**
 * Split a completed reply into sentence-sized NDJSON deltas so the client can
 * paint/speak the first sentence without waiting for the whole payload on the
 * wire. Keeps trailing text that has no terminator as a final chunk.
 */
export function splitReplyDeltas(reply) {
  const text = String(reply || '');
  if (!text) return [];
  const chunks = [];
  const re = /(.+?[.!?](?:\s+|$))/gs;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    const chunk = match[1];
    if (chunk) chunks.push(chunk);
    lastIndex = re.lastIndex;
  }
  const tail = text.slice(lastIndex);
  if (tail) chunks.push(tail);
  return chunks.length ? chunks : [text];
}
