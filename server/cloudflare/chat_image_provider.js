// Which engine makes a picture asked for in chat, and what the chat says about it. Modal GPU is chosen when it is connected,
// the owner has turned pictures on (CHE_MODAL_TXT2IMG=enabled) and the call cap is not used up. Otherwise the picture is made
// by Cloudflare Workers AI, and the reply says so and says why. CHE never switches engines without saying so.
import { modalCredential } from './modal_gpu.js';
import { MODAL_IMAGE_FLAG, MODAL_IMAGE_KEY, startModalImage } from './media.js';
import { CHAT_IMAGE_SOURCE, chatImageInline, chatImageMedia, chatImageReply, requestedImageCount } from './chat_images.js';

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

/** The chat reply for a Modal picture that was started: the job id and what is still to come, never a claim of an image. */
export function modalPictureReply(started) {
  if (started?.status === 202 && started.call_id) {
    return `I started the picture on Modal's GPU, sir (provider: Modal, job ${started.call_id}). It is not in your Gallery yet. Nothing is saved until Modal's result passes its checks.`;
  }
  return `I did not start a Modal GPU picture, sir: ${started?.detail || 'Modal did not answer'}. Nothing was generated; no other engine was used.`;
}

/** The note that goes in front of a Workers AI picture reply, so the owner knows which engine made it and why. */
export function workersAiNote(reason) {
  return `Made with Cloudflare Workers AI (provider: Workers AI), because ${reason}. `;
}

/**
 * One picture request in chat: the engine is chosen here, the picture is made by it, and the reply says which engine made it.
 * `makeImages(count)` is the Workers AI path (chat_images.js). Returns { text, meta } for the chat.
 */
export async function chatPictureTurn(env, storage, { message, origin, makeImages }) {
  const count = requestedImageCount(message);
  const choice = await chatImageProvider(env, storage, { count });
  // An explicit Modal request is never answered by another engine: if Modal is not chosen, nothing is made and the reason is said.
  if (choice.provider !== 'modal' && /\bmodal\b/i.test(String(message || ''))) {
    return {
      text: `I did not make the picture, sir: you asked for Modal GPU, and ${choice.reason}. No other engine was used, and nothing was generated.`,
      meta: { source: CHAT_IMAGE_SOURCE, ok: false, model_calls: 0, provider_requested: 'modal', provider_used: null, nothing_generated: true, refusal: choice.reason },
    };
  }
  if (choice.provider === 'modal') {
    const prompt = String(message || '').replace(/^\s*(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?/i, '').trim();
    const started = await startModalImage(env, storage, { prompt, title: prompt.slice(0, 60) });
    return { text: modalPictureReply(started), meta: { source: CHAT_IMAGE_SOURCE, ok: started.status === 202, model_calls: 0, provider_requested: 'modal', provider_used: started.status === 202 ? 'modal' : null, call_id: started.call_id || null, saved: false } };
  }
  const results = await makeImages(count);
  return { text: workersAiNote(choice.reason) + chatImageReply(results), meta: { source: CHAT_IMAGE_SOURCE, ok: results.some((r) => r.ok), model_calls: 0, provider_used: 'workers_ai', media: chatImageMedia(results), ...chatImageInline(results, origin) } };
}
