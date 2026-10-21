// CHE Art Studio media: real image generation with versions.
import { moneyPrinterVideo, moneyPrinterStatus, verifyVideoMedia } from './moneyprinter.js';
import { createFacelessVideo } from './faceless_video.js';
import { githubVideoConfigured, startGithubVideo, githubVideoStatus, githubVideoFile } from './github_video_renderer.js';
//   - Owner image connector (CHE_IMAGE_GEN_URL) wins when configured.
//   - Otherwise Workers AI FLUX.1 [schnell] generates the image on the CHE
//     server itself (highest step count unless the owner picks draft).
//   - Variations and refinements are new versions of the same piece.
//   - Upscaling needs an upscaler connector (CHE_UPSCALE_URL); without one
//     CHE says so instead of pretending.
// Image bytes go to R2 (CHE_DATA_BUCKET) when bound, otherwise to their own
// Durable Object keys, and are served only to the paired phone.

export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const INDEX_KEY = 'media_index';
const MAX_ITEMS = 200;

function now() {
  return new Date().toISOString();
}

export async function listMedia(storage) {
  return (await storage.get(INDEX_KEY)) || [];
}

async function saveIndex(storage, items) {
  await storage.put(INDEX_KEY, items.slice(0, MAX_ITEMS));
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// The picture type from its first bytes: PNG, JPEG or WebP. Null for anything else, so a fabricated or broken
// "image" is never stored as one. Only the first 16 bytes are decoded.
export function imageMimeFromBase64(base64) {
  let bytes;
  try { bytes = atob(String(base64 || '').slice(0, 24)); } catch (_) { return null; }
  const at = (i) => bytes.charCodeAt(i);
  if (at(0) === 0x89 && bytes.slice(1, 4) === 'PNG') return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (bytes.slice(0, 4) === 'RIFF' && bytes.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function extensionForMime(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'video/webm') return 'webm';
  if (mimeType === 'video/quicktime') return 'mov';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/plain') return 'txt';
  return 'jpg';
}

async function storeBlob(env, storage, id, base64, mimeType = 'image/jpeg', kind = 'image') {
  if (env.CHE_DATA_BUCKET) {
    const key = `media/${id}.${extensionForMime(mimeType)}`;
    await env.CHE_DATA_BUCKET.put(key, b64ToBytes(base64), { httpMetadata: { contentType: mimeType } });
    return { blob: 'r2', blob_key: key };
  }
  if (kind === 'video') {
    throw new Error('Generated video storage needs CHE_DATA_BUCKET (R2).');
  }
  await storage.put(`media:${id}`, base64);
  return { blob: 'do' };
}

export async function readBlob(env, storage, item) {
  if (item.blob === 'github-artifact') {
    try {
      const bytes = await githubVideoFile(env, item.github_artifact_id, item.github_filename);
      if (!bytes) return null;
      if (item.github_filename === 'video.mp4') {
        if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') return null;
      } else if (item.github_filename === 'thumbnail.png') {
        if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return null;
      }
      return bytes;
    } catch {
      return null; // Expired artifact or unavailable GitHub download.
    }
  }
  if (item.blob === 'r2' && env.CHE_DATA_BUCKET) {
    const key = item.blob_key || `media/${item.id}.jpg`;
    const object = await env.CHE_DATA_BUCKET.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
  const b64 = await storage.get(`media:${item.id}`);
  return b64 ? b64ToBytes(b64) : null;
}

async function connectorImage(env, prompt, fetcher) {
  const url = new URL(env.CHE_IMAGE_GEN_URL);
  if (url.protocol !== 'https:') throw new Error('Image connector must use HTTPS.');
  const response = await fetcher(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.CHE_IMAGE_GEN_TOKEN ? { Authorization: `Bearer ${env.CHE_IMAGE_GEN_TOKEN}` } : {}),
    },
    body: JSON.stringify({ prompt: prompt.slice(0, 5000), type: 'image', quality: 'highest' }),
  });
  if (!response.ok) throw new Error(`Image connector returned ${response.status}.`);
  const data = await response.json();
  const out = String(data.url || data.output_url || data.image_url || '').trim();
  if (!out.startsWith('https://')) throw new Error('Image connector returned no image URL.');
  return out;
}

function openAiKey(env) {
  return env.OPENAI_API_KEY || env.CHE_OPENAI_API_KEY || '';
}

function missingPaidSwitch(env) {
  if (!/^(?:1|true|yes|on)$/i.test(String(env.CHE_ALLOW_PAID_MEDIA || '').trim())) return 'paid media';
  if (!/^(?:1|true|yes)$/i.test(String(env.CHE_ALLOW_PAID_AI || '').trim())) return 'paid AI';
  return '';
}

function paidMediaEnabled(env) {
  // Paid media also needs the owner's paid-AI switch (free engines only by default).
  return /^(?:1|true|yes|on)$/i.test(String(env.CHE_ALLOW_PAID_MEDIA || '').trim())
    && /^(?:1|true|yes)$/i.test(String(env.CHE_ALLOW_PAID_AI || '').trim());
}

async function openAiImage(env, prompt, draft, fetcher) {
  const key = openAiKey(env);
  if (!key) throw new Error('OpenAI image key is not configured.');
  const model = draft
    ? (env.CHE_OPENAI_IMAGE_FAST_MODEL || 'gpt-image-2.5-flare')
    : (env.CHE_OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst');
  const response = await fetcher('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      prompt: prompt.slice(0, 32000),
      size: 'auto',
      quality: draft ? 'medium' : 'high',
      output_format: 'png',
      n: 1,
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${response.status}: ${data?.error?.message || 'OpenAI image request failed'}`);
  }
  const item = data?.data?.[0];
  if (item?.b64_json) return { base64: item.b64_json, mime_type: 'image/png', model };
  if (String(item?.url || '').startsWith('https://')) return { url: item.url, model };
  throw new Error('OpenAI returned no image.');
}

// MoneyPrinterTurbo is an async /api/v1/videos job, not a generic
// POST {prompt,type} connector. Share its existing adapter and verifier.
async function connectorVideo(env, prompt, fetcher, seconds = 15) {
  const rendered = await moneyPrinterVideo(env, prompt, fetcher, { seconds });
  if (!rendered.ok) throw new Error(rendered.error || 'MoneyPrinter could not render the video.');
  if (rendered.pending) return { pending: true, task_id: rendered.task_id };
  if (!rendered.verified || !rendered.media_url) throw new Error('No verified video file was returned.');
  return { url: rendered.media_url, verified: true };
}

async function geminiVideo(env, prompt, fetcher) {
  if (!env.GEMINI_API_KEY) throw new Error('Gemini video key is not configured.');
  if (!env.CHE_DATA_BUCKET) throw new Error('Gemini video generation needs CHE_DATA_BUCKET (R2) for the MP4.');
  const model = env.CHE_GEMINI_VIDEO_MODEL || 'gemini-omni-1.1-flash';
  const response = await fetcher('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    signal: AbortSignal.timeout(110000),
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      model,
      input: String(prompt || '').slice(0, 8000),
      response_format: { type: 'video', resolution: env.CHE_VIDEO_RESOLUTION || '1080p' },
      generation_config: { video_config: { task: 'text_to_video' } },
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${response.status}: ${data?.error?.message || 'Gemini video request failed'}`);
  }
  const video = data?.output_video || data?.outputVideo || null;
  const base64 = String(video?.data || video?.inline_data?.data || video?.inlineData?.data || '').trim();
  const mime = String(video?.mime_type || video?.mimeType || 'video/mp4').trim();
  if (base64) return { base64, mime_type: mime, model };
  const out = String(video?.uri || data?.video_url || data?.url || '').trim();
  if (out.startsWith('https://')) return { url: out, model };
  throw new Error('Gemini returned no video.');
}

// Pictures, videos, PDFs and text files the owner sends are kept in the media index, so CHE always has somewhere to hold
// them (owner, 2026-10-21). Bytes go to R2 when bound, otherwise to a Durable Object value, which holds about 2 MB:
// a larger file needs the bucket and is refused with that reason. Nothing is shared or published.
const OWNER_BASE64_CHARS = 1_400_000;
const OWNER_TYPES = /^(?:image\/(?:png|jpe?g|gif|webp|heic)|video\/(?:mp4|quicktime|webm)|application\/pdf|text\/plain)$/;

// The app's label is not trusted: the iPhone build sends "image", "video" or "document" for any file, and a name can lie.
// The type is read from the bytes. Generic or specific labels are both checked against the bytes; unknown bytes are refused.
const TEXT_LABELS = ['text/plain', 'document', 'file', 'text'];

function looksLikeText(base64) {
  let bytes;
  try { bytes = Uint8Array.from(atob(String(base64)), (c) => c.charCodeAt(0)); } catch (_) { return false; }
  if (!bytes.length || bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch (_) { return false; }
}

/** The owner file's real type from its signature, or null when the bytes are not a kind CHE keeps. */
export function ownerTypeFromBytes(declared, base64) {
  let head;
  try { head = atob(String(base64 || '').slice(0, 24)); } catch (_) { return null; }
  const picture = imageMimeFromBase64(base64);
  if (picture) return picture;
  if (head.slice(0, 4) === 'GIF8') return 'image/gif';
  if (head.slice(0, 4) === '%PDF') return 'application/pdf';
  if (head.slice(0, 4) === '\x1aE\xdf\xa3') return 'video/webm';
  if (head.slice(4, 8) === 'ftyp') {
    const brand = head.slice(8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^(?:isom|iso[2-9]|mp4[12]|M4V |avc1|dash)/.test(brand)) return 'video/mp4';
    return null;
  }
  if (TEXT_LABELS.includes(String(declared || '').toLowerCase()) && looksLikeText(base64)) return 'text/plain';
  return null;
}

export async function saveOwnerFile(env, storage, { name = '', media_type = '', base64 = '' } = {}) {
  const declared = String(media_type || '').toLowerCase();
  if (!base64) return { ok: false, reason: 'no file arrived with that message' };
  const type = ownerTypeFromBytes(declared, base64);
  if (!type || !OWNER_TYPES.test(type)) return { ok: false, reason: `the file is not a picture, video, PDF or text file I can read (sent as ${declared || 'no type'}), so nothing was saved` };
  if (base64.length > OWNER_BASE64_CHARS && !env.CHE_DATA_BUCKET) {
    return { ok: false, reason: 'the file is larger than 1.4 MB, and larger files need the R2 bucket (CHE_DATA_BUCKET), which is not connected' };
  }
  const id = crypto.randomUUID();
  try {
    const stored = await storeBlob(env, storage, id, base64, type, 'upload');
    const item = { id, kind: 'upload', mime_type: type, title: String(name || 'Untitled file').replace(/[`<>]/g, '').slice(0, 120), created_at: now(), source: 'owner', ...stored };
    const items = [item, ...(await listMedia(storage))];
    await saveIndex(storage, items);
    return { ok: true, item, total: Math.min(items.length, MAX_ITEMS) };
  } catch (error) {
    return { ok: false, reason: `the file could not be read (${String(error?.message || error).slice(0, 120)})` };
  }
}

// mode: new | variation | refine. parent_id links versions of one piece.
export async function generateImage(env, storage, body, fetcher = fetch) {
  const prompt = String(body.prompt || '').trim().slice(0, 2000);
  const mode = ['variation', 'refine'].includes(body.mode) ? body.mode : 'new';
  const items = await listMedia(storage);
  const parent = body.parent_id ? items.find((item) => item.id === body.parent_id) : null;
  if (mode !== 'new' && !parent) return { status: 404, detail: 'Piece not found.' };
  const finalPrompt = mode === 'variation'
    ? `${parent.prompt}\n(Fresh variation: same subject and intent, different composition and details.)`
    : mode === 'refine'
      ? `${parent.prompt}\nRefinement: ${prompt}`
      : prompt;
  if (!finalPrompt.trim()) return { status: 400, detail: 'Describe the image.' };
  const draft = body.draft === true;
  const id = crypto.randomUUID();
  const record = {
    id,
    root_id: parent ? (parent.root_id || parent.id) : id,
    parent_id: parent ? parent.id : null,
    title: String(body.title || (parent ? parent.title : prompt.slice(0, 60)) || 'Untitled').slice(0, 80),
    prompt: finalPrompt.slice(0, 2400),
    mode,
    draft,
    version: parent ? items.filter((item) => (item.root_id || item.id) === (parent.root_id || parent.id)).length + 1 : 1,
    created_at: now(),
  };
  const engines = [];
  if (env.CHE_IMAGE_GEN_URL) engines.push({ id: 'Your image connector', run: async () => ({ url: await connectorImage(env, finalPrompt, fetcher) }) });
  if (paidMediaEnabled(env) && openAiKey(env)) engines.push({ id: draft ? 'openai-gpt-image-fast' : 'openai-gpt-image-hd', run: async () => openAiImage(env, finalPrompt, draft, fetcher) });
  // CHE_AI_BOUND is false when the Worker has no AI binding (routedEnv always exposes an AI member).
  if (env.AI && env.CHE_AI_BOUND !== false) engines.push({ id: draft ? 'CHE image engine (draft)' : 'CHE image engine', run: async () => {
    const result = await env.AI.run(IMAGE_MODEL, { prompt: finalPrompt.slice(0, 2048), steps: draft ? 4 : 8, seed: Math.floor(Math.random() * 2 ** 31) });
    if (!result?.image) throw new Error('The image model returned no image.');
    return { base64: result.image, mime_type: 'image/jpeg' };
  } });
  if (paidMediaEnabled(env) && env.GEMINI_API_KEY) engines.push({ id: 'gemini-image', run: async () => {
    const model = env.CHE_GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
    const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: finalPrompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${data?.error?.message || 'image request failed'}`);
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const image = parts.map(p => p.inlineData || p.inline_data).find(p => p?.data);
    if (!image) throw new Error('Gemini returned no image.');
    const mime = image.mimeType || image.mime_type;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Unsupported image format.');
    return { base64: image.data, mime_type: mime };
  } });
  const errors = [];
  let generated;
  for (const engine of engines) {
    try { generated = await engine.run(); record.engine = engine.id; break; }
    catch (error) { errors.push(`${engine.id}: ${error.message}`); console.log('CHE image error:', engine.id, error.message); }
  }
  if (!generated) {
    const paidReady = Boolean(openAiKey(env) || env.GEMINI_API_KEY) && !paidMediaEnabled(env);
    return {
      status: engines.length ? 502 : paidReady ? 402 : 503,
      detail: paidReady
        ? `HD image generation is connected but disabled until the owner explicitly enables ${missingPaidSwitch(env)}.`
        : `All image engines failed (${errors.join(' | ') || 'none configured'}).`,
      requires_owner_confirmation: paidReady,
    };
  }
  if (generated.url) record.url = generated.url;
  else {
    // The type comes from the bytes, not from what the engine said. Bytes that are not a picture are never saved.
    const sniffed = imageMimeFromBase64(generated.base64);
    if (!sniffed) return { status: 502, detail: 'The image engine returned data that is not a PNG, JPEG or WebP picture, so nothing was saved.' };
    record.mime_type = sniffed;
    // Storage failures must not invoke another billable generator.
    try { Object.assign(record, await storeBlob(env, storage, id, generated.base64, record.mime_type, 'image')); }
    catch (error) { return { status: 502, detail: `Image generated but could not be saved: ${error.message}` }; }
  }
  await saveIndex(storage, [record, ...items]);
  return { status: 200, item: record };
}

const DISPATCH_KEY = 'che_video_dispatch:';
const DISPATCHED_KEY = 'che_video_dispatched:';
const DISPATCH_REUSE_MS = 30 * 60_000;

async function requestKey(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The free renderer's topic: the subject only, at most 500 characters.
function videoTopicText(text) {
  const clean = String(text || '').split('\nCHE RETRIEVAL CONTEXT')[0].replace(/\s+/g, ' ').trim();
  return clean.length > 500 ? clean.slice(0, 497).replace(/\s+\S*$/, '') : clean;
}

export async function generateVideo(env, storage, body, fetcher = fetch) {
  const prompt = String(body.prompt || '').trim().slice(0, 8000);
  const renderTaskId = String(body.task_id || '').trim();
  if (!prompt && !renderTaskId) return { status: 400, detail: 'Describe the video or supply the existing renderer task ID.' };
  if (renderTaskId && !/^[a-zA-Z0-9_-]{1,128}$/.test(renderTaskId)) {
    return { status: 400, detail: 'Invalid video render task ID.' };
  }
  if (renderTaskId) {
    const earlier = (await listMedia(storage)).find((item) => item.render_task_id === renderTaskId && item.verified);
    if (earlier) return { status: 200, item: earlier, duplicate: true };
    if (renderTaskId.startsWith('gha_')) {
      const dispatched = await storage.get?.(DISPATCHED_KEY + renderTaskId).catch?.(() => null) ?? null;
      const result = await githubVideoStatus(env, renderTaskId, fetcher, { dispatchedAt: Number(body.dispatched_at || dispatched?.at || 0) });
      if (result.pending) {
        return { status: 202, pending: true, job_id: renderTaskId, stage: result.stage || 'queued', run_id: result.run_id || null,
          detail: `The free GitHub render is ${result.stage === 'running' ? 'running' : 'queued'}. No finished MP4 exists yet.${result.detail ? ` ${result.detail}` : ''}` };
      }
      if (!result.ok || !result.verified) {
        // Asking for the same video again must start a new render, not
        // return this failed one.
        if (dispatched) await storage.put?.(DISPATCHED_KEY + renderTaskId, { ...dispatched, failed: true });
        return { status: 502, stage: result.stage || 'failed', code: result.code || 'failed', run_id: result.run_id || null,
          detail: result.error || 'GitHub video was not verified.' };
      }
      const vidId = crypto.randomUUID(), thumbId = crypto.randomUUID();
      const base = {
        engine: 'github-actions-offline', github_artifact_id: result.artifact_id,
        render_task_id: renderTaskId, verified: true,
        duration_verified: result.duration_verified, duration_seconds: result.duration_seconds,
        paid_media: false, youtube_uploaded: false, created_at: now(),
        durability: env.CHE_DATA_BUCKET ? 'r2' : 'github-artifact-30-days',
      };
      const videoItem = {
        ...base, id: vidId, root_id: vidId, kind: 'video', mode: 'video', github_run_id: result.run_id,
        video_bytes: result.video_bytes, video_codec: result.video_codec, audio_codec: result.audio_codec,
        voice_provider: result.voice_provider || '',
        title: result.title || String(body.title || prompt).slice(0, 80),
        prompt: prompt.slice(0, 8000), description: result.description,
        mime_type: 'video/mp4', thumbnail_media_id: thumbId,
        width: result.video_width, height: result.video_height,
        ...(result.format ? { format: result.format } : {}), ...(result.episode ? { episode: result.episode } : {}),
        frame_size_verified: result.frame_size_verified === true,
        blob: 'github-artifact', github_filename: 'video.mp4',
      };
      const thumbnailItem = {
        ...base, id: thumbId, root_id: thumbId, parent_id: vidId,
        kind: 'image', mode: 'thumbnail', title: 'Thumbnail for ' + videoItem.title,
        prompt: videoItem.prompt, mime_type: 'image/png',
        width: result.thumbnail_width, height: result.thumbnail_height,
        blob: 'github-artifact', github_filename: 'thumbnail.png',
      };
      if (env.CHE_DATA_BUCKET) {
        try {
          const [videoBytes, imageBytes] = await Promise.all([
            githubVideoFile(env, result.artifact_id, 'video.mp4', fetcher),
            githubVideoFile(env, result.artifact_id, 'thumbnail.png', fetcher),
          ]);
          if (!videoBytes || !imageBytes) throw new Error('Artifact files missing.');
          await Promise.all([
            env.CHE_DATA_BUCKET.put('media/' + vidId + '.mp4', videoBytes, { httpMetadata: { contentType: 'video/mp4' } }),
            env.CHE_DATA_BUCKET.put('media/' + thumbId + '.png', imageBytes, { httpMetadata: { contentType: 'image/png' } }),
          ]);
          videoItem.blob = 'r2'; videoItem.blob_key = 'media/' + vidId + '.mp4';
          thumbnailItem.blob = 'r2'; thumbnailItem.blob_key = 'media/' + thumbId + '.png';
        } catch {
          return { status: 502, detail: 'Video rendered but could not be archived. No finished video was recorded.' };
        }
      }
      await saveIndex(storage, [videoItem, thumbnailItem, ...await listMedia(storage)]);
      return { status: 200, item: videoItem, thumbnail: thumbnailItem };
    }
  }
  const id = crypto.randomUUID();
  const record = {
    id,
    root_id: id,
    parent_id: null,
    title: String(body.title || prompt.slice(0, 60) || 'Untitled video').slice(0, 80),
    prompt,
    mode: 'video',
    kind: 'video',
    ...(renderTaskId ? { render_task_id: renderTaskId } : {}),
    created_at: now(),
  };
  const engines = [];
  // A Creator Studio storyboard is drawn only by CHE's own GitHub renderer;
  // the other engines would ignore it and make a different video.
  const storyboard = body.spec && typeof body.spec === 'object' ? JSON.stringify(body.spec) : '';
  if (storyboard && !renderTaskId) {
    if (!githubVideoConfigured(env)) return { status: 503, code: 'not_configured', detail: 'A storyboard renders only on the free GitHub renderer, which needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker.' };
  } else if (renderTaskId) {
    // Finish the exact existing renderer task; never start a second video.
    if (!env.CHE_VIDEO_GEN_URL) return { status: 503, detail: 'Renderer is not configured. The saved task cannot be checked.' };
    engines.push({ id: 'moneyprinter-turbo', run: async () => {
      const checked = await moneyPrinterStatus(env, renderTaskId, fetcher);
      if (!checked.ok) throw new Error(checked.error || 'Render task status failed.');
      return checked.pending ? { pending: true, task_id: renderTaskId } :
        { url: checked.media_url, verified: checked.verified };
    } });
  } else if (env.CHE_VIDEO_GEN_URL) {
    engines.push({ id: 'moneyprinter-turbo', run: async () =>
      connectorVideo(env, prompt, fetcher, Number(body.seconds || body.duration_seconds) || 15) });
  } else if (env.CHE_VIDEO_RENDER_URL) {
    // Existing synchronous faceless renderer remains supported.
    engines.push({ id: 'faceless-renderer', run: async () => {
      const result = await createFacelessVideo(env, {
        topic: prompt, seconds: Number(body.seconds || body.duration_seconds) || 15,
      }, fetcher);
      if (!result.ok || !result.verified) throw new Error(result.error || 'No verified MP4.');
      return { url: result.media_url, verified: true };
    } });
  }
  const free = [];
  if (githubVideoConfigured(env) && !renderTaskId) {
    // The free renderer takes the subject, not the whole chat turn with its
    // memory context (which ran past its 500-character limit).
    const topic = videoTopicText(body.topic || prompt);
    const seconds = Number(body.seconds || body.duration_seconds) || 15;
    free.push('github-actions-offline');
    engines.push({ id: 'github-actions-offline', run: async () => {
      // One request is one video: the same subject and length asked again
      // within half an hour returns the job already queued.
      const key = DISPATCH_KEY + await requestKey(`${topic.toLowerCase()}|${seconds}${storyboard ? `|${storyboard}` : ''}`);
      const earlier = await storage.get?.(key).catch?.(() => null) ?? null;
      const failed = earlier?.task_id ? (await storage.get?.(DISPATCHED_KEY + earlier.task_id).catch?.(() => null))?.failed : false;
      const recent = earlier?.task_id && Date.now() - Number(earlier.at || 0) < DISPATCH_REUSE_MS && !body.new_job && !failed;
      if (recent && !earlier.retry) return { pending: true, task_id: earlier.task_id, reused: true };
      // The earlier attempt never got an answer from GitHub. If it arrived
      // anyway its run carries the task ID and that run is the video;
      // otherwise the same ID is sent again, so it is still one video.
      const retryId = recent && earlier.retry ? earlier.task_id : '';
      if (retryId && (await githubVideoStatus(env, retryId, fetcher)).run_id) {
        await storage.put?.(key, { task_id: retryId, at: Date.now(), topic });
        return { pending: true, task_id: retryId, reused: true };
      }
      const result = await startGithubVideo(env, topic, seconds, fetcher, { taskId: retryId, spec: storyboard });
      if (!result.ok) {
        // An unreachable GitHub may still have queued it: keep the task ID so
        // a retry checks that run instead of starting a second video.
        if (result.code === 'unreachable' && result.task_id) await storage.put?.(key, { task_id: result.task_id, at: Date.now(), retry: true });
        const failure = new Error(result.error || 'GitHub offline renderer unavailable.');
        failure.code = result.code;
        if (result.github) failure.github = result.github;
        throw failure;
      }
      await storage.put?.(key, { task_id: result.task_id, at: Date.now(), topic });
      await storage.put?.(DISPATCHED_KEY + result.task_id, { at: Date.now(), topic, seconds, method: result.dispatch_method || '' });
      return { pending: true, task_id: result.task_id, topic };
    } });
  }
  if (paidMediaEnabled(env) && env.GEMINI_API_KEY && !storyboard) {
    engines.push({ id: 'gemini-omni-video', run: async () => geminiVideo(env, prompt, fetcher) });
  }
  const errors = [];
  const failureCodes = [];
  let githubDetail = null;
  let generated;
  for (const engine of engines) {
    try {
      generated = await engine.run();
      record.engine = engine.id;
      record.model = generated.model || '';
      break;
    } catch (error) {
      errors.push(`${engine.id}: ${error.message}`);
      if (error.code) failureCodes.push(error.code);
      if (error.github && !githubDetail) githubDetail = error.github;
      console.log('CHE video error:', engine.id, error.message);
    }
  }
  if (!generated) {
    const paidReady = Boolean(env.GEMINI_API_KEY) && !paidMediaEnabled(env);
    // A free engine that was tried and failed is the answer; the paid switch
    // is only the reason when no free renderer exists at all.
    if (engines.length) {
      const paidNote = paidReady ? ` Paid HD video stays off until you enable ${missingPaidSwitch(env)}.` : '';
      return { status: 502, code: failureCodes[0] || 'failed', free_engines: free, ...(githubDetail ? { github: githubDetail } : {}),
        detail: `${errors.map((e) => e.replace(/^[a-z-]+: /, '')).join(' ')}${paidNote}`.trim() };
    }
    return {
      status: paidReady ? 402 : 503,
      code: 'not_configured',
      detail: paidReady
        ? `No free video renderer is set up (it needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker), and HD video generation is connected but disabled until the owner explicitly enables ${missingPaidSwitch(env)}.`
        : 'No video renderer is set up. The free GitHub renderer needs CHE_GITHUB_TOKEN and CHE_GITHUB_REPO on the Worker.',
      requires_owner_confirmation: paidReady,
    };
  }
  if (generated.pending) {
    return { status: 202, pending: true, job_id: generated.task_id, engine: record.engine, reused: generated.reused === true,
      topic: generated.topic || '',
      detail: 'Renderer accepted the job. No MP4 or thumbnail exists yet; poll /api/video/line?task_id=' + encodeURIComponent(generated.task_id) + '.' };
  }
  record.mime_type = 'video/mp4';
  record.duration_verified = false; // Actual seconds require a media probe/ffprobe, not a request parameter.
  if (generated.url) {
    if (!generated.verified) {
      const result = await verifyVideoMedia(generated.url, fetcher);
      if (!result.ok) return { status: 502, detail: result.error };
    }
    record.verified = true;
    if (env.CHE_DATA_BUCKET) {
      // Archive the verified MP4 under CHE control rather than relying on an
      // external provider's temporary URL. Never return a made-up preview.
      const key = `media/${id}.mp4`;
      try {
        const response = await fetcher(generated.url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok || !response.body) throw new Error('MP4 download failed.');
        await env.CHE_DATA_BUCKET.put(key, response.body, {
          httpMetadata: { contentType: 'video/mp4' },
        });
        record.blob = 'r2';
        record.blob_key = key;
        record.durable = true;
      } catch (_) {
        return { status: 502, detail: 'MP4 rendered but could not be archived to CHE R2. No finished file was recorded.' };
      }
    } else {
      record.url = generated.url;
      record.durable = false;
      record.storage_warning = 'External preview only; configure CHE_DATA_BUCKET (R2) for a durable CHE-hosted file.';
    }
  } else {
    const bytes = b64ToBytes(generated.base64 || '');
    const isMp4 = bytes.length >= 12 && bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112;
    if (!isMp4) return { status: 502, detail: 'Video provider returned no valid MP4 bytes. Nothing was saved.' };
    try { Object.assign(record, await storeBlob(env, storage, id, generated.base64, 'video/mp4', 'video')); }
    catch (error) { return { status: 502, detail: `Video generated but could not be saved: ${error.message}` }; }
    record.verified = true;
    record.durable = true;
  }
  if (body.thumbnail === true) {
    const thumbnail = await generateImage(env, storage, {
      prompt: `Premium attention-grabbing 16:9 YouTube thumbnail for: ${prompt.slice(0, 600)}. Cinematic professional original artwork, expressive composition, clear focal point, no copyrighted characters.`,
      title: `Thumbnail for ${record.title}`,
    }, fetcher);
    if (thumbnail.item) {
      record.thumbnail_media_id = thumbnail.item.id;
      record.thumbnail_dimensions_verified = false;
    } else {
      record.thumbnail_error = thumbnail.detail || 'Thumbnail engine did not produce an image.';
    }
  }
  const items = await listMedia(storage);
  await saveIndex(storage, [record, ...items]);
  return { status: 200, item: record };
}

export async function upscaleImage(env, storage, id, origin, fetcher = fetch) {
  const items = await listMedia(storage);
  const source = items.find((item) => item.id === id);
  if (!source) return { status: 404, detail: 'Piece not found.' };
  if (!env.CHE_UPSCALE_URL) {
    return { status: 409, detail: 'Upscaling needs an upscaler connector (CHE_UPSCALE_URL) on the CHE server.' };
  }
  let imageField;
  if (source.url) {
    imageField = { image_url: source.url };
  } else {
    const bytes = await readBlob(env, storage, source);
    if (!bytes) return { status: 404, detail: 'Image data missing.' };
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    imageField = { image_base64: btoa(binary) };
  }
  try {
    const response = await fetcher(env.CHE_UPSCALE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.CHE_UPSCALE_TOKEN ? { Authorization: `Bearer ${env.CHE_UPSCALE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ ...imageField, scale: 4 }),
    });
    if (!response.ok) return { status: 502, detail: `Upscaler returned ${response.status}.` };
    const data = await response.json();
    const out = String(data.url || data.output_url || '').trim();
    if (!out.startsWith('https://')) return { status: 502, detail: 'Upscaler returned no image URL.' };
    const record = {
      ...source,
      id: crypto.randomUUID(),
      parent_id: source.id,
      root_id: source.root_id || source.id,
      mode: 'upscale',
      url: out,
      blob: undefined,
      engine: 'Upscaler connector',
      version: items.filter((item) => (item.root_id || item.id) === (source.root_id || source.id)).length + 1,
      created_at: now(),
    };
    await saveIndex(storage, [record, ...items]);
    return { status: 200, item: record };
  } catch (_) {
    return { status: 502, detail: 'Upscaler was unavailable.' };
  }
}

export async function deleteMedia(env, storage, id) {
  const items = await listMedia(storage);
  const item = items.find((entry) => entry.id === id);
  if (!item) return { status: 404, detail: 'Piece not found.' };
  if (item.blob === 'r2' && env.CHE_DATA_BUCKET) await env.CHE_DATA_BUCKET.delete(item.blob_key || `media/${id}.jpg`);
  if (item.blob === 'do') await storage.delete(`media:${id}`);
  await saveIndex(storage, items.filter((entry) => entry.id !== id));
  return { status: 200, ok: true };
}

