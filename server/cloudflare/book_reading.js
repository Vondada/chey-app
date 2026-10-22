// CHE book reading: a short reflection on a book the owner's library supplied.
//
// Only runs when the owner asks. The caller must supply the book text; this module
// never fetches a book itself. Model calls use CHE's Cloudflare binding (env.AI) only,
// and the text goes through guardOutbound first.

import { guardOutbound } from './egress_guard.js';
import { REFLECTION_MODEL, modelText } from './reflections.js';

export const BOOK_TEXT_CHARS = 12000;
const MAX_SUMMARY_CHARS = 800;

const SYSTEM_PROMPT = [
  'You write a short reflection for CHE\'s owner on the book text supplied below.',
  'Use only what the text says. Do not add facts, quotes, authors or claims that are not in it.',
  'Reply with 2 to 4 plain sentences and nothing else.',
].join(' ');

export async function readBookSummary({ bookId, text, title } = {}, env, { model = REFLECTION_MODEL } = {}) {
  const id = String(bookId ?? '').trim();
  if (!id) return { status: 'refused', detail: 'A book id is required.', items: [] };
  // Refuse anything the caller did not supply: no text, no reading.
  if (typeof text !== 'string' || !text.trim()) {
    return { status: 'refused', bookId: id, detail: 'The book text was not supplied, so CHE will not read it.', items: [] };
  }
  const name = String(title ?? '').trim() || id;
  if (!env?.AI || typeof env.AI.run !== 'function') {
    return { status: 'model_unavailable', bookId: id, title: name, items: [] };
  }

  const guarded = guardOutbound({ destination: 'cloudflare-model', payload: text.slice(0, BOOK_TEXT_CHARS) });
  if (!guarded.allowed) return { status: 'withheld', bookId: id, title: name, items: [] };

  let out;
  try {
    out = await env.AI.run(model, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Book: ${name}\n\nText:\n${guarded.redacted}` },
      ],
      max_tokens: 300,
    });
  } catch {
    return { status: 'model_error', bookId: id, title: name, items: [] };
  }
  const summary = modelText(out).replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS);
  if (!summary) return { status: 'no_items', bookId: id, title: name, items: [] };
  return {
    status: 'ok',
    id: `book-${id}`,
    bookId: id,
    title: name,
    items: [{ category: 'book', title: name, text: summary, reply: 'open', reply_text: '' }],
  };
}
