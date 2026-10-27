// Encrypted private-memory vault.
//
// The owner's password never reaches the Worker. The client derives an AES-256
// key from the password with PBKDF2-SHA256 and encrypts each memory with AES-GCM
// before upload. The Worker stores only:
//   - the setup record: KDF name, iteration count, salt and a verifier (an
//     AES-GCM ciphertext of a fixed string, so the client can check the password);
//   - one ciphertext record per memory, with server-set created/updated dates.
//
// Storage adapter (the Worker's binding is wired by the caller):
//   storage.get(key)          -> string | null | undefined
//   storage.put(key, value)   -> void (value is a JSON string)
//   storage.keys(prefix)      -> string[] of keys starting with prefix
//
// Client-side helpers (createVaultSetup, unlockVault, sealMemory, openMemory) use
// Web Crypto, which is available in browsers, Workers and Node 22+.

import { sensitiveKinds } from './egress_guard.js';

export const VAULT_VERSION = 1;
export const VAULT_KDF = 'PBKDF2-SHA256';
export const VAULT_ALG = 'AES-GCM-256';
export const VAULT_DEFAULT_ITERATIONS = 600000;
export const VAULT_MIN_ITERATIONS = 100000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_PASSWORD_LENGTH = 8;
const VERIFIER_PLAINTEXT = 'chey-private-vault-verifier-v1';
const SETUP_KEY = 'vault:setup';
const ITEM_PREFIX = 'vault:item:';
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Sorted, because hasExactKeys() compares sorted key lists.
const SETUP_FIELDS = ['iterations', 'kdf', 'salt', 'v', 'verifier'];
const BLOB_FIELDS = ['alg', 'ct', 'iv', 'v'];

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

const subtle = () => globalThis.crypto.subtle;
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64encode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Returns a Uint8Array, or null when the input is not canonical base64.
function b64decode(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hasExactKeys(obj, fields) {
  const keys = Object.keys(obj).sort();
  return keys.length === fields.length && keys.every((k, i) => k === fields[i]);
}

function isValidBlob(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return false;
  if (!hasExactKeys(blob, BLOB_FIELDS)) return false;
  if (blob.v !== VAULT_VERSION || blob.alg !== VAULT_ALG) return false;
  const iv = b64decode(blob.iv);
  const ct = b64decode(blob.ct);
  return Boolean(iv && iv.length === IV_BYTES && ct && ct.length >= TAG_BYTES + 1);
}

function normalizePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new VaultError('weak-password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return password.normalize('NFC');
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new VaultError('bad-id', 'memory id must be 8-64 characters of letters, digits, _ or -');
  }
  if (sensitiveKinds(id).includes('secret')) {
    throw new VaultError('bad-id', 'memory id must not contain a secret-looking token');
  }
}

function aadFor(scope) {
  return encoder.encode(`chey-vault:v${VAULT_VERSION}:${scope}`);
}

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sealWithKey(key, plaintext, scope) {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(scope) },
    key,
    encoder.encode(plaintext),
  );
  return { v: VAULT_VERSION, alg: VAULT_ALG, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

async function openWithKey(key, blob, scope) {
  const iv = b64decode(blob.iv);
  const ct = b64decode(blob.ct);
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: aadFor(scope) },
      key,
      ct,
    );
    return decoder.decode(plain);
  } catch {
    throw new VaultError('decrypt-failed', 'ciphertext could not be opened with this key');
  }
}

// ---- Client side -----------------------------------------------------------

/**
 * Client: create the setup record for a new vault. Send the result to vaultSetup().
 * The password is used only to derive the key; it is not included in the result.
 */
export async function createVaultSetup(password, { iterations = VAULT_DEFAULT_ITERATIONS, salt } = {}) {
  const pw = normalizePassword(password);
  if (!Number.isInteger(iterations) || iterations < VAULT_MIN_ITERATIONS) {
    throw new VaultError('weak-kdf', `iterations must be an integer of at least ${VAULT_MIN_ITERATIONS}`);
  }
  const saltBytes = salt ?? randomBytes(SALT_BYTES);
  const key = await deriveKey(pw, saltBytes, iterations);
  const verifier = await sealWithKey(key, VERIFIER_PLAINTEXT, 'verifier');
  return {
    v: VAULT_VERSION,
    kdf: VAULT_KDF,
    iterations,
    salt: b64encode(saltBytes),
    verifier,
  };
}

/**
 * Client: derive the key from the password and the setup record fetched from the
 * Worker. Throws VaultError('wrong-password') if the verifier does not open.
 */
export async function unlockVault(password, setup) {
  const pw = normalizePassword(password);
  const salt = b64decode(setup?.salt);
  if (!salt || !setup || setup.kdf !== VAULT_KDF) {
    throw new VaultError('bad-setup', 'vault setup record is invalid');
  }
  const key = await deriveKey(pw, salt, setup.iterations);
  let opened;
  try {
    opened = await openWithKey(key, setup.verifier, 'verifier');
  } catch {
    throw new VaultError('wrong-password', 'password does not unlock this vault');
  }
  if (opened !== VERIFIER_PLAINTEXT) throw new VaultError('wrong-password', 'password does not unlock this vault');
  return key;
}

/** Client: encrypt one memory for upload. `id` is bound into the ciphertext. */
export async function sealMemory(key, plaintext, id) {
  assertId(id);
  if (typeof plaintext !== 'string') throw new VaultError('bad-plaintext', 'memory must be a string');
  return sealWithKey(key, plaintext, `item:${id}`);
}

/** Client: decrypt one memory fetched with vaultGet(). */
export async function openMemory(key, record, id) {
  assertId(id);
  // vaultGet() returns the blob plus server dates; only the crypto fields are used.
  const blob = record && { v: record.v, alg: record.alg, iv: record.iv, ct: record.ct };
  if (!isValidBlob(blob)) throw new VaultError('bad-blob', 'ciphertext record is malformed');
  return openWithKey(key, blob, `item:${id}`);
}

// ---- Worker side (stores ciphertext only) ----------------------------------

function isValidVerifier(verifier) {
  return isValidBlob(verifier);
}

async function readJson(storage, key) {
  const raw = await storage.get(key);
  if (raw === null || raw === undefined) return null;
  return JSON.parse(raw);
}

/**
 * Worker: store the setup record once. `verifierBlob` is the object produced by
 * createVaultSetup(). Refuses to overwrite an existing vault, because that would
 * orphan every stored memory.
 */
export async function vaultSetup(storage, verifierBlob) {
  if (!verifierBlob || typeof verifierBlob !== 'object' || Array.isArray(verifierBlob)) {
    throw new VaultError('bad-setup', 'setup record must be an object');
  }
  if (!hasExactKeys(verifierBlob, SETUP_FIELDS)) {
    throw new VaultError('bad-setup', 'setup record has unexpected fields');
  }
  if (verifierBlob.v !== VAULT_VERSION || verifierBlob.kdf !== VAULT_KDF) {
    throw new VaultError('bad-setup', 'unsupported vault version or KDF');
  }
  if (!Number.isInteger(verifierBlob.iterations) || verifierBlob.iterations < VAULT_MIN_ITERATIONS) {
    throw new VaultError('weak-kdf', `iterations must be an integer of at least ${VAULT_MIN_ITERATIONS}`);
  }
  const salt = b64decode(verifierBlob.salt);
  if (!salt || salt.length < SALT_BYTES || salt.length > 64) {
    throw new VaultError('bad-setup', 'salt must be 16-64 bytes of base64');
  }
  if (!isValidVerifier(verifierBlob.verifier)) {
    throw new VaultError('bad-setup', 'verifier must be an AES-GCM ciphertext record');
  }
  if (await storage.get(SETUP_KEY)) {
    throw new VaultError('already-setup', 'vault is already set up');
  }
  const record = {
    v: VAULT_VERSION,
    kdf: VAULT_KDF,
    iterations: verifierBlob.iterations,
    salt: verifierBlob.salt,
    verifier: {
      v: VAULT_VERSION,
      alg: VAULT_ALG,
      iv: verifierBlob.verifier.iv,
      ct: verifierBlob.verifier.ct,
    },
    createdAt: new Date().toISOString(),
  };
  await storage.put(SETUP_KEY, JSON.stringify(record));
  return { createdAt: record.createdAt };
}

/** Worker: the public setup record (salt, iterations, verifier) or null. */
export async function vaultGetSetup(storage) {
  const record = await readJson(storage, SETUP_KEY);
  if (!record) return null;
  return {
    v: record.v,
    kdf: record.kdf,
    iterations: record.iterations,
    salt: record.salt,
    verifier: record.verifier,
    createdAt: record.createdAt,
  };
}

/**
 * Worker: store one ciphertext record. The Worker sets the dates and keeps
 * createdAt on overwrite. Any extra field in `ciphertext` is rejected, so
 * plaintext cannot be smuggled in beside the ciphertext.
 */
export async function vaultPut(storage, id, ciphertext, { now } = {}) {
  assertId(id);
  if (!(await storage.get(SETUP_KEY))) {
    throw new VaultError('not-set-up', 'vault is not set up');
  }
  if (!isValidBlob(ciphertext)) {
    throw new VaultError('bad-blob', 'ciphertext must be exactly {v, alg, iv, ct} of AES-GCM output');
  }
  const stamp = now ?? new Date().toISOString();
  const existing = await readJson(storage, ITEM_PREFIX + id);
  const record = {
    v: VAULT_VERSION,
    alg: VAULT_ALG,
    iv: ciphertext.iv,
    ct: ciphertext.ct,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  await storage.put(ITEM_PREFIX + id, JSON.stringify(record));
  return { id, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

/** Worker: the stored ciphertext record for one id, or null. */
export async function vaultGet(storage, id) {
  assertId(id);
  const record = await readJson(storage, ITEM_PREFIX + id);
  if (!record) return null;
  return {
    v: record.v,
    alg: record.alg,
    iv: record.iv,
    ct: record.ct,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Worker: ids and dates only. Never returns ciphertext or content. */
export async function vaultList(storage) {
  const keys = await storage.keys(ITEM_PREFIX);
  const rows = [];
  for (const key of keys) {
    const record = await readJson(storage, key);
    if (!record) continue;
    rows.push({
      id: key.slice(ITEM_PREFIX.length),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return rows;
}
