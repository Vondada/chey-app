// CHE Art Studio media: real image generation with versions.
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

async function storeBlob(env, storage, id, base64) {
  if (env.CHE_DATA_BUCKET) {
    await env.CHE_DATA_BUCKET.put(`media/${id}.jpg`, b64ToBytes(base64), { httpMetadata: { contentType: 'image/jpeg' } });
    return 'r2';
  }
  await storage.put(`media:${id}`, base64);
  return 'do';
}

export async function readBlob(env, storage, item) {
  if (item.blob === 'r2' && env.CHE_DATA_BUCKET) {
    const object = await env.CHE_DATA_BUCKET.get(`media/${item.id}.jpg`);
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
  try {
    if (env.CHE_IMAGE_GEN_URL) {
      record.url = await connectorImage(env, finalPrompt, fetcher);
      record.engine = 'Your image connector';
    } else if (env.AI) {
      const result = await env.AI.run(IMAGE_MODEL, {
        prompt: finalPrompt.slice(0, 2048),
        steps: draft ? 4 : 8, // 8 is FLUX schnell's maximum quality setting
        seed: Math.floor(Math.random() * 2 ** 31),
      });
      const b64 = String(result?.image || '');
      if (!b64) return { status: 502, detail: 'The image model returned no image.' };
      record.blob = await storeBlob(env, storage, id, b64);
      record.engine = draft ? 'CHE image engine (draft)' : 'CHE image engine';
    } else {
      return { status: 503, detail: 'Image generation is not connected.' };
    }
  } catch (error) {
    return { status: 502, detail: String(error?.message || 'Image generation failed.') };
  }
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
  if (item.blob === 'r2' && env.CHE_DATA_BUCKET) await env.CHE_DATA_BUCKET.delete(`media/${id}.jpg`);
  if (item.blob === 'do') await storage.delete(`media:${id}`);
  await saveIndex(storage, items.filter((entry) => entry.id !== id));
  return { status: 200, ok: true };
}
