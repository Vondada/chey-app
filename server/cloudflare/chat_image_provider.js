// Which engine makes a picture asked for in chat, and what the chat says about it. Modal GPU is chosen when it is connected,
// the owner has turned pictures on (CHE_MODAL_TXT2IMG=enabled) and the call cap is not used up. Otherwise the picture is made
// by Cloudflare Workers AI, and the reply says so and says why. CHE never switches engines without saying so.
import { modalCredential } from './modal_gpu.js';
import { MODAL_IMAGE_FLAG, MODAL_IMAGE_KEY, startModalImage } from './media.js';
import { CHAT_IMAGE_SOURCE, chatImageInline, chatImageMedia, chatImageReply, requestedImageCount } from './chat_images.js';
import { COMPOSER, oncePerSentence, refusedPictureText, startedPictureText } from './execution_reply.js';
import { turnReceipt } from './action_receipts.js';

/** The engine for one chat picture request: { provider: 'modal' | 'workers_ai', reason }. */
export async function chatImageProvider(env, storage, { count = 1 } = {}) {
  if (count > 1) return { provider: 'workers_ai', reason: 'Modal makes one picture at a time, and you asked for more than one' };
  if (String(env[MODAL_IMAGE_FLAG] || '') !== 'enabled') return { provider: 'workers_ai', reason: 'Modal GPU pictures are not authorized yet' };
  const cred = await modalCredential(env, storage);
  if (!cred.exists || !cred.cred) return { provider: 'workers_ai', reason: 'Modal is not connected' };
  const records = (await storage.get(MODAL_IMAGE_KEY)) || [];
  const max = Math.max(1, Number(env.CHE_MODAL_TXT2IMG_MAX) || 1);
  if (records.filter((r) => r.call_id).length >= max) return { provider: 'workers_ai', reason: 'the Modal GPU picture cap is used up' };
  return { provider: 'modal', reason: 'Modal is connected, authorized and within its cap' };
}

/**
 * The chat reply for a Modal picture: the job id and what is still to come when it started, or the handler's own facts
 * when it was refused. The sentences come from execution_reply.js; a refusal without recorded facts keeps the plain wording.
 */
export function modalPictureReply(started) {
  if (started?.status === 202 && started.call_id) return startedPictureText(started);
  if (started?.http_status !== undefined) return refusedPictureText({ http_status: started.http_status, modal_reason: started.modal_reason, budget_state: started.budget_state });
  return oncePerSentence(`I did not start a Modal GPU picture, sir: ${refusalReason(started?.detail) || 'Modal did not answer'}. Nothing was generated; no other engine was used.`);
}

/**
 * The reason from a refusal's detail, without the closing sentences ("Nothing was generated", "no other engine was used"),
 * which the chat reply adds once. So the reply never says the same thing twice.
 */
export function refusalReason(detail) {
  return String(detail || '')
    .replace(/[,;]?\s*(?:so\s+)?(?:nothing was (?:generated|started|sent)|no other engine was used)\b[^.]*\.?/gi, '')
    .replace(/[.\s]+$/, '')
    .trim();
}

/** The note that goes in front of a Workers AI picture reply, so the owner knows which engine made it and why. */
export function workersAiNote(reason) {
  return `Made with Cloudflare Workers AI (provider: Workers AI), because ${reason}. `;
}

// An affirmative request to use Modal ("using Modal GPU", "on Modal"). A word that is only part of the picture ("a modal dialog") or an exclusion ("not Modal") is not a request.
const MODAL_PROVIDER_ASK = /\b(?:on|using|via|through|with|by|in)\s+(?:the\s+)?modal\b|\bmodal\s+gpu\b|\bmodal\s+(?:picture|image|render|job)s?\b/i;
const MODAL_EXCLUDED = /\b(?:not|no|never|without|instead\s+of|rather\s+than)\s+(?:use\s+|using\s+|on\s+|the\s+)?modal\b/i;
export function explicitModalAsk(message) {
  const text = String(message || '');
  return MODAL_PROVIDER_ASK.test(text) && !MODAL_EXCLUDED.test(text);
}

/**
 * The meta the Details panel reads for a Modal picture: the handler that ran, who composed the words (CHE's reply layer, no
 * model), and the handler's recorded facts. `modal_http_status` is Modal's own answer; `status` is the Worker's.
 */
export function pictureMeta(started) {
  const ok = started?.status === 202;
  return {
    source: CHAT_IMAGE_SOURCE, ok, model_calls: 0,
    handler: 'modal_txt2img', responder: COMPOSER,
    provider_requested: 'modal', provider_used: ok ? 'modal' : null,
    call_id: started?.call_id || null, saved: false,
    modal_http_status: started?.http_status ?? null, modal_reason: started?.modal_reason ?? null, budget_state: started?.budget_state ?? null,
    // A started Modal job is queued, not finished: its receipt says so. A refused one gets none.
    ...(ok ? { execution_receipts: [turnReceipt({ tool: 'modal_gpu', operation: 'txt2img', status: 'queued', id: started.call_id })].filter(Boolean) } : {}),
  };
}

/** One success receipt per picture that was really generated and saved, with its media id. Failed pictures get none. */
export function pictureReceipts(results, { provider = 'workers_ai' } = {}) {
  return (results || []).filter((r) => r?.ok).map((r) => turnReceipt({
    tool: 'image_generation', operation: 'generate_and_save', status: 'success', id: r.id, provider, ...(r.engine ? { engine: r.engine } : {}),
  })).filter(Boolean);
}

// A pixel size named in the request: "256 by 256", "512x512", "1024 × 768".
const PIXEL_SIZE = /\b(\d{2,4})\s*(?:x|by|\u00d7)\s*(\d{2,4})\b(?:\s*(?:px|pixels?))?/i;
/**
 * When the owner names a pixel size, the reply says it was not applied: the chat picture path (media.js generateImage)
 * sends no width or height to any engine, so a picture at the engine's own size is never passed off as the size asked for.
 */
export function pictureSizeNote(message) {
  const size = PIXEL_SIZE.exec(String(message || ''));
  if (!size) return '';
  return ` You asked for ${size[1]} by ${size[2]} pixels; I cannot set a picture's size, so it is at the image engine's own size, not ${size[1]} by ${size[2]}.`;
}

/**
 * One picture request in chat: the engine is chosen here, the picture is made by it, and the reply says which engine made it.
 * `makeImages(count)` is the Workers AI path (chat_images.js). Returns { text, meta } for the chat.
 */
export async function chatPictureTurn(env, storage, { message, origin, makeImages }) {
  const count = requestedImageCount(message);
  const choice = await chatImageProvider(env, storage, { count });
  // An explicit Modal request is never answered by another engine: if Modal is not chosen, nothing is made and the reason is said.
  if (choice.provider !== 'modal' && explicitModalAsk(message)) {
    return {
      text: `I did not make the picture, sir: you asked for Modal GPU, and ${choice.reason}. No other engine was used, and nothing was generated.`,
      meta: { source: CHAT_IMAGE_SOURCE, ok: false, model_calls: 0, provider_requested: 'modal', provider_used: null, nothing_generated: true, refusal: choice.reason },
    };
  }
  if (choice.provider === 'modal') {
    const prompt = String(message || '').replace(/^\s*(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?/i, '').trim();
    const started = await startModalImage(env, storage, { prompt, title: prompt.slice(0, 60) });
    return { text: modalPictureReply(started), meta: pictureMeta(started) };
  }
  const results = await makeImages(count);
  const receipts = pictureReceipts(results, { provider: 'workers_ai' });
  const sizeNote = receipts.length ? pictureSizeNote(message) : '';
  return {
    text: workersAiNote(choice.reason) + chatImageReply(results) + sizeNote,
    meta: { source: CHAT_IMAGE_SOURCE, ok: results.some((r) => r.ok), model_calls: 0, provider_used: 'workers_ai', media: chatImageMedia(results), ...chatImageInline(results, origin), ...(receipts.length ? { execution_receipts: receipts } : {}) },
  };
}
