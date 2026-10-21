// CHE may describe a visual, a video, a thumbnail or a scheduled or published post only when a record of this
// request says it was made (owner, 2026-10-21). Concept and copy are not visuals; a draft is not a post.
//
// Every ad request ends with the same three facts, so the owner can tell what exists:
//   "I wrote the ad copy." / "I generated N visuals." / "I did not schedule or publish anything."

const AD_REQUEST = /\b(?:ads?|advert(?:s|isements?)?|ad (?:copy|concepts?|creatives?|visuals?|images?|videos?)|campaign (?:visuals?|images?|videos?))\b/i;
const MAKE_VERB = /\b(?:make|create|write|draft|generate|design|produce|build|give me|come up with)\b/i;
// A sentence that says a visual, video or thumbnail exists or was made by CHE.
const VISUAL_NOUN = '(?:visuals?|images?|pictures?|photos?|thumbnails?|videos?|renders?|mp4|png|jpe?g|ad (?:visuals?|images?|creatives?|videos?)|creatives?)';
const VISUAL_CLAIM = new RegExp(String.raw`\b(?:I|CHE|she|we)(?:'ve| have)?\s+(?:already\s+)?(?:generated|rendered|created|made|produced|designed|exported|uploaded|attached|built)\b[^.!?\n]{0,60}\b${VISUAL_NOUN}\b|\b(?:the\s+|your\s+|these\s+|my\s+)?${VISUAL_NOUN}\s+(?:are|is|were|have been|has been)\s+(?:ready|generated|rendered|created|attached|live|done|finished)\b|\b(?:here (?:are|is)|attached (?:are|is))\s+(?:the\s+|your\s+|my\s+|\d+\s+)?${VISUAL_NOUN}\b`, 'i');
// "Here are your ads" presents ads that exist; with only copy written, it is not true.
const AD_PRESENTED = /\b(?:here (?:are|is)|these are|attached (?:are|is))\s+(?:your|the|my|these)\s+ads?\b/i;
// A sentence that says a post or ad was scheduled, published, posted or launched.
const PUBLISH_CLAIM = /\b(?:I|CHE|she|we)(?:'ve| have)?\s+(?:already\s+)?(?:scheduled|published|posted|launched|uploaded|went live|put (?:it|them|the ads?) live)\b|\b(?:is|are|was|were|has been|have been)\s+(?:now\s+)?(?:scheduled|published|posted|launched)\b/i;

/** True when the owner asked for ad material (copy, concepts or visuals). */
export function adRequest(message) {
  const text = String(message || '');
  return AD_REQUEST.test(text) && MAKE_VERB.test(text);
}

// A sentence that denies the claim ("nothing was scheduled", "I did not publish", "I have no record") is an honest answer.
const NEGATED = /\b(?:not|nothing|never|no\s+(?:record|visuals?|images?|videos?|ads?|posts?)|didn['’]?t|did\s+not|haven['’]?t|have\s+not|hasn['’]?t|wasn['’]?t|weren['’]?t|isn['’]?t|aren['’]?t|cannot|can['’]?t)\b/i;

const sentences = (text) => String(text || '').split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());

/**
 * Removes every sentence that claims a visual or a publish this request did not make. Only prose is touched: code
 * fences and memory-block lines ("- [People] …") keep their line breaks, and a reply with nothing to remove is returned
 * exactly as it was. `made` is how many visuals this request really produced; `published` is how many posts were.
 */
export function assetTruthReply(reply, { made = 0, published = 0 } = {}) {
  const removed = [];
  let fenced = false;
  const lines = String(reply || '').split('\n').map((line) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
    if (fenced || /^\s*-\s*\[[A-Za-z]+\]/.test(line)) return line;
    const kept = sentences(line).filter((sentence) => {
      if (NEGATED.test(sentence)) return true;
      if (made === 0 && (VISUAL_CLAIM.test(sentence) || AD_PRESENTED.test(sentence))) { removed.push(sentence); return false; }
      if (published === 0 && PUBLISH_CLAIM.test(sentence)) { removed.push(sentence); return false; }
      return true;
    });
    return kept.length === sentences(line).length ? line : kept.join(' ').trim();
  });
  if (!removed.length) return { text: String(reply || ''), removed };
  return { text: lines.filter((line, i, all) => line || (i > 0 && all[i - 1])).join('\n').trim(), removed };
}

/** The fixed status for an ad request: copy written, visuals made (with the real count), nothing scheduled or published. */
export function adStatusLines({ copy = true, made = 0, published = 0 } = {}) {
  return [
    copy ? 'I wrote the ad copy.' : 'I did not write the ad copy.',
    made ? `I generated ${made} visual${made === 1 ? '' : 's'}.` : 'I generated 0 visuals, so no ad image or video exists yet.',
    published ? `I published ${published} post${published === 1 ? '' : 's'}.` : 'I did not schedule or publish anything.',
  ].join(' ');
}
