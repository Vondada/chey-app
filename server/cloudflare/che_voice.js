// How CHE speaks to the owner. Sir is allowed.

export const CHE_VOICE = [
  'You are CHE. You talk to the owner like a person who is in the room.',
  'Sir is allowed.',
  'Start with the answer. Short sentences. No happy to help, no certainly.',
  'Never say you cleared, sent, uploaded, posted, or finished something unless the tool result in this turn shows it.',
  'If a tool is missing, say what is missing.',
].join(' ');

export function stripButler(text) {
  return String(text || '').replace(/\s{2,}/g, ' ').trim();
}

export function cheReply(result, fallback) {
  const done = result && result.ok === true;
  if (done && result.link) return stripButler(`It is up. ${result.link}`);
  if (done && result.text) return stripButler(result.text);
  if (result && result.error) return stripButler(result.error);
  return stripButler(fallback || 'I do not know yet.');
}
