// Lossless prompt/log compaction for CHE storage.
// This is storage compression, not semantic summarization: decompression returns
// the exact original UTF-8 text. If compression is not worthwhile or unavailable,
// CHE stores the original value instead.

const enc = new TextEncoder();
const dec = new TextDecoder();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Text(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
}

async function gzip(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('gzip decompression unavailable');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function packText(text, { minBytes = 768 } = {}) {
  const original = String(text ?? '');
  const raw = enc.encode(original);
  const digest = await sha256Text(original);
  if (raw.byteLength < minBytes) {
    return { codec: 'plain-v1', text: original, original_bytes: raw.byteLength, stored_bytes: raw.byteLength, sha256: digest };
  }
  const zipped = await gzip(raw);
  if (!zipped || zipped.byteLength >= raw.byteLength) {
    return { codec: 'plain-v1', text: original, original_bytes: raw.byteLength, stored_bytes: raw.byteLength, sha256: digest };
  }
  return { codec: 'gzip-v1', bytes: zipped, original_bytes: raw.byteLength, stored_bytes: zipped.byteLength, sha256: digest };
}

export async function unpackText(record) {
  if (record == null) return null;
  if (typeof record === 'string') return record;
  if (record.codec === 'plain-v1') return String(record.text ?? '');
  if (record.codec !== 'gzip-v1') throw new Error('Unknown prompt compression codec.');
  const raw = await gunzip(record.bytes);
  const text = dec.decode(raw);
  const digest = await sha256Text(text);
  if (record.sha256 && digest !== record.sha256) throw new Error('Compressed prompt integrity check failed.');
  return text;
}

export async function savePackedJson(storage, key, value) {
  const packed = await packText(JSON.stringify(value));
  if (packed.codec === 'gzip-v1') {
    await storage.put(`${key}:gz`, packed);
    await storage.delete(key);
  } else {
    await storage.put(key, value);
    await storage.delete(`${key}:gz`);
  }
  return {
    codec: packed.codec,
    original_bytes: packed.original_bytes,
    stored_bytes: packed.stored_bytes,
    ratio: packed.original_bytes ? packed.stored_bytes / packed.original_bytes : 1,
  };
}

export async function loadPackedJson(storage, key) {
  const plain = await storage.get(key);
  if (plain != null) return plain;
  const packed = await storage.get(`${key}:gz`);
  if (packed == null) return null;
  return JSON.parse(await unpackText(packed));
}
