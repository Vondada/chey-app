// Pictures asked for in chat (owner, 2026-10-21, Test 5): "create three advertisements with matching pictures" makes
// the real pictures through the existing media engine (media.js generateImage), one saved record each, and answers
// from those results only. A picture that failed is named by its number and reason, never by a made-up file name.
// Every saved picture is in the media index, so Creation Room and the chat show the same record. Owner only.
import { generateImage } from './media.js';

export const CHAT_IMAGE_SOURCE = 'che_image_generation';
const MAX_IMAGES = 4;
const WAKE = /^\s*(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?/i;
const NUMBERS = { one: 1, two: 2, three: 3, four: 4 };
// Each picture after the first gets a different angle, so a set of "matching" pictures is not three copies.
const ANGLES = ['', ' Alternate composition.', ' Alternate colour palette and lighting.', ' Alternate setting and mood.'];

/** How many pictures the owner asked for: "three", "3", "a"; one when no number is named, never more than MAX_IMAGES. */
export function requestedImageCount(message) {
  const text = String(message || '').replace(WAKE, '').toLowerCase();
  const named = /\b(\d{1,2}|one|two|three|four)\s+(?:[a-z-]+\s+){0,3}?(?:ads?|advertisements?|pictures?|images?|photos?|visuals?|graphics?|posters?|banners?|thumbnails?|logos?|flyers?)\b/.exec(text);
  if (!named) return 1;
  const n = /^\d+$/.test(named[1]) ? Number(named[1]) : NUMBERS[named[1]];
  return Math.max(1, Math.min(MAX_IMAGES, n || 1));
}

/**
 * Makes `count` pictures, one at a time. Each success is saved by generateImage; each failure is kept with its reason.
 * Returns one entry per requested picture, in order: { number, ok, id, mime_type, title, reason, status }.
 */
export async function makeChatImages(env, storage, { message, count = 1, fetcher = fetch } = {}) {
  const prompt = String(message || '').replace(WAKE, '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const title = `${prompt.slice(0, 56)}${count > 1 ? ` (${i + 1} of ${count})` : ''}`;
    const made = await generateImage(env, storage, { prompt: `${prompt}${ANGLES[i] || ''}`, title }, fetcher)
      .catch((error) => ({ status: 500, detail: String(error?.message || error) }));
    if (made.item) {
      results.push({ number: i + 1, ok: true, id: made.item.id, mime_type: made.item.mime_type, title: made.item.title, status: 200 });
    } else {
      results.push({ number: i + 1, ok: false, reason: String(made.detail || 'the image engine did not return a picture').slice(0, 200), status: made.status || 500 });
    }
  }
  return results;
}

/** The reply, built only from the results: how many pictures were made and saved, and each failure with its reason. */
export function chatImageReply(results) {
  const total = results.length;
  const made = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  // No picture engine at all: say so and say what to connect, instead of a generic failure.
  if (!made.length && failed.every((r) => r.status === 503)) {
    return 'I did not make any pictures, sir, because no image engine is connected. Connect one under Connections and ask again. Nothing was generated or saved.';
  }
  const head = !made.length
    ? 'I did not generate any pictures, sir. Nothing was saved.'
    : made.length === total
      ? `I generated ${total === 1 ? 'the picture' : `all ${total} pictures`} and saved ${total === 1 ? 'it' : 'them'} to your Creation Room.`
      : `I generated ${made.length} of ${total} pictures and saved the ${made.length === 1 ? 'one' : 'ones'} that worked.`;
  const lines = failed.map((r) => `Picture ${r.number} failed: ${r.reason}`);
  return [head, ...lines].join(' ');
}

/**
 * The first saved picture as the fields the iPhone chat shows inline (media_type, media_url), with an absolute URL.
 * The chat reads one picture per reply; the rest stay in the Creation Room and in `media`.
 */
export function chatImageInline(results, origin) {
  const first = results.find((r) => r.ok);
  return first ? { media_type: 'image', media_url: `${origin}/api/media/${first.id}/image`, media_id: first.id } : {};
}

/**
 * A model reply that is only a pretend tool call (owner, 2026-10-22: {"action": "dalle.text2im", "action_input": ...}
 * appeared in the chat instead of a picture). Returns { action, prompt, picture } or null for an ordinary reply.
 * Only a reply that is wholly such an object counts, so prose that mentions JSON is never touched.
 */
export function pretendToolCall(text) {
  const body = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  let obj = null;
  try { obj = JSON.parse(body); } catch (_) {
    const action = /"(?:action|tool|name)"\s*:\s*"([^"]{1,80})"/.exec(body)?.[1];
    if (!action) return null;
    obj = { action, action_input: { prompt: /\\?"prompt\\?"\s*:\s*\\?"([^"\\]{1,600})/.exec(body)?.[1] || '' } };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const action = String(obj.action || obj.tool || obj.function || obj.name || '').trim();
  if (!action || !('action_input' in obj || 'input' in obj || 'arguments' in obj || 'parameters' in obj || 'prompt' in obj)) return null;
  let input = obj.action_input ?? obj.input ?? obj.arguments ?? obj.parameters ?? { prompt: obj.prompt };
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) { input = { prompt: input }; } }
  const prompt = String(input?.prompt || input?.description || input?.text || '').trim().slice(0, 600);
  return { action, prompt, picture: /dall|text2im|image|picture|draw|paint|illustrat/i.test(action) };
}

/** The media a reply refers to: stable ids and verified types, for the chat to show. */
export function chatImageMedia(results) {
  return results.filter((r) => r.ok).map((r) => ({ media_id: r.id, mime_type: r.mime_type, title: r.title, url: `/api/media/${r.id}/image` }));
}
