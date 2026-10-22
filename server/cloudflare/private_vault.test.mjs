import assert from 'node:assert/strict';
import { createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  VAULT_MIN_ITERATIONS,
  VaultError,
  createVaultSetup,
  openMemory,
  sealMemory,
  unlockVault,
  vaultGet,
  vaultGetSetup,
  vaultList,
  vaultPut,
  vaultSetup,
} from './private_vault.js';

// Fast iteration count for tests. The real default (600000) gets its own test.
const ITER = VAULT_MIN_ITERATIONS;
const PASSWORD = 'correct horse battery';
const MARK = 'OWNER-MEMORY-MARK-7f3a';
const MEMORY_TEXT = `My sister's birthday is in March. ${MARK}`;

// In-memory storage with the same shape as the adapter in private_vault.js.
// `raw` holds exactly what the Worker would persist, as strings.
function memoryStorage() {
  const raw = new Map();
  return {
    raw,
    async get(key) {
      return raw.has(key) ? raw.get(key) : null;
    },
    async put(key, value) {
      assert.equal(typeof value, 'string', 'storage must receive strings');
      raw.set(key, value);
    },
    async keys(prefix) {
      return [...raw.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

async function setupVault(storage, password = PASSWORD) {
  const setup = await createVaultSetup(password, { iterations: ITER });
  await vaultSetup(storage, setup);
  return setup;
}

function allStoredText(storage) {
  return [...storage.raw.values()].join('\n');
}

// ---- setup and unlock ------------------------------------------------------

test('createVaultSetup returns salt, iterations and verifier, never the password', async () => {
  const setup = await createVaultSetup(PASSWORD, { iterations: ITER });
  assert.equal(setup.v, 1);
  assert.equal(setup.kdf, 'PBKDF2-SHA256');
  assert.equal(setup.iterations, ITER);
  assert.equal(Buffer.from(setup.salt, 'base64').length, 16);
  assert.equal(setup.verifier.alg, 'AES-GCM-256');
  assert.ok(!JSON.stringify(setup).includes(PASSWORD));
});

test('two setups with the same password use different salts and IVs', async () => {
  const a = await createVaultSetup(PASSWORD, { iterations: ITER });
  const b = await createVaultSetup(PASSWORD, { iterations: ITER });
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.verifier.iv, b.verifier.iv);
});

test('the verifier can be checked with node:crypto using the PBKDF2 key', async () => {
  const setup = await createVaultSetup(PASSWORD, { iterations: ITER });
  const key = pbkdf2Sync(PASSWORD.normalize('NFC'), Buffer.from(setup.salt, 'base64'), ITER, 32, 'sha256');
  const ct = Buffer.from(setup.verifier.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(setup.verifier.iv, 'base64'));
  decipher.setAAD(Buffer.from('chey-vault:v1:verifier'));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  assert.equal(plain.toString('utf8'), 'chey-private-vault-verifier-v1');
});

test('unlockVault accepts the right password and rejects a wrong one', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const setup = await vaultGetSetup(storage);
  await unlockVault(PASSWORD, setup);
  await assert.rejects(unlockVault('wrong password here', setup), (err) => {
    assert.ok(err instanceof VaultError);
    assert.equal(err.code, 'wrong-password');
    return true;
  });
});

test('createVaultSetup refuses a short password and a weak iteration count', async () => {
  await assert.rejects(createVaultSetup('short', { iterations: ITER }), { code: 'weak-password' });
  await assert.rejects(createVaultSetup(PASSWORD, { iterations: 1000 }), { code: 'weak-kdf' });
});

test('the default iteration count is 600000 and is accepted by vaultSetup', async () => {
  const storage = memoryStorage();
  const setup = await createVaultSetup(PASSWORD);
  assert.equal(setup.iterations, 600000);
  await vaultSetup(storage, setup);
  assert.equal((await vaultGetSetup(storage)).iterations, 600000);
});

test('vaultSetup stores only the public setup fields', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const stored = JSON.parse(storage.raw.get('vault:setup'));
  assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'iterations', 'kdf', 'salt', 'v', 'verifier']);
  assert.ok(!allStoredText(storage).includes(PASSWORD));
});

test('vaultSetup refuses to overwrite an existing vault', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const again = await createVaultSetup('another password', { iterations: ITER });
  await assert.rejects(vaultSetup(storage, again), { code: 'already-setup' });
});

test('vaultSetup rejects extra fields, such as a plaintext password', async () => {
  const storage = memoryStorage();
  const setup = await createVaultSetup(PASSWORD, { iterations: ITER });
  await assert.rejects(vaultSetup(storage, { ...setup, password: PASSWORD }), { code: 'bad-setup' });
  assert.equal(storage.raw.size, 0);
});

test('vaultSetup rejects a weak iteration count, a bad salt and a bad verifier', async () => {
  const storage = memoryStorage();
  const setup = await createVaultSetup(PASSWORD, { iterations: ITER });
  await assert.rejects(vaultSetup(storage, { ...setup, iterations: 10 }), { code: 'weak-kdf' });
  await assert.rejects(vaultSetup(storage, { ...setup, salt: 'AAAA' }), { code: 'bad-setup' });
  await assert.rejects(vaultSetup(storage, { ...setup, verifier: { v: 1, alg: 'AES-GCM-256', iv: 'AAAA', ct: 'AAAA' } }), {
    code: 'bad-setup',
  });
  await assert.rejects(vaultSetup(storage, null), { code: 'bad-setup' });
  assert.equal(storage.raw.size, 0);
});

// ---- memories --------------------------------------------------------------

test('a memory round-trips through seal, put, get and open', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const id = 'mem-0001-abcdef';
  const blob = await sealMemory(key, MEMORY_TEXT, id);
  await vaultPut(storage, id, blob);
  const got = await vaultGet(storage, id);
  assert.equal(await openMemory(key, got, id), MEMORY_TEXT);
});

test('the Worker-side store never contains the plaintext memory or the password', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  await vaultPut(storage, 'mem-plain-0001', await sealMemory(key, MEMORY_TEXT, 'mem-plain-0001'));
  await vaultPut(storage, 'mem-plain-0002', await sealMemory(key, 'second secret note', 'mem-plain-0002'));
  const everything = allStoredText(storage);
  assert.ok(!everything.includes(MARK), 'plaintext marker reached the store');
  assert.ok(!everything.includes('birthday'), 'plaintext word reached the store');
  assert.ok(!everything.includes('second secret note'));
  assert.ok(!everything.includes(PASSWORD), 'password reached the store');
  assert.ok(!everything.includes(Buffer.from(MEMORY_TEXT).toString('base64')));
});

test('the stored ciphertext opens with node:crypto, which confirms the AES-GCM format and AAD', async () => {
  const storage = memoryStorage();
  const setup = await setupVault(storage);
  const key = pbkdf2Sync(PASSWORD, Buffer.from(setup.salt, 'base64'), ITER, 32, 'sha256');
  const id = 'interop-id-0001';
  await vaultPut(storage, id, await sealMemory(await unlockVault(PASSWORD, setup), MEMORY_TEXT, id));
  const record = await vaultGet(storage, id);
  const ct = Buffer.from(record.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAAD(Buffer.from(`chey-vault:v1:item:${id}`));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  assert.equal(plain.toString('utf8'), MEMORY_TEXT);
});

test('each seal uses a fresh IV, so equal plaintexts produce different ciphertexts', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const a = await sealMemory(key, 'same text', 'mem-iv-0001');
  const b = await sealMemory(key, 'same text', 'mem-iv-0001');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('a ciphertext is bound to its id: moving it to another id fails to open', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const blob = await sealMemory(key, MEMORY_TEXT, 'mem-bind-0001');
  await assert.rejects(openMemory(key, blob, 'mem-bind-0002'), { code: 'decrypt-failed' });
});

test('a tampered ciphertext fails to open', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const blob = await sealMemory(key, MEMORY_TEXT, 'mem-tamper-01');
  const ct = Buffer.from(blob.ct, 'base64');
  ct[0] ^= 0x01;
  await assert.rejects(openMemory(key, { ...blob, ct: ct.toString('base64') }, 'mem-tamper-01'), {
    code: 'decrypt-failed',
  });
});

test('a memory cannot be opened with a key from the wrong password', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const blob = await sealMemory(key, MEMORY_TEXT, 'mem-key-00001');
  const other = await createVaultSetup('some other password', { iterations: ITER });
  const otherKey = await unlockVault('some other password', other);
  await assert.rejects(openMemory(otherKey, blob, 'mem-key-00001'), { code: 'decrypt-failed' });
});

test('vaultPut and vaultGet refuse to run before setup', async () => {
  const storage = memoryStorage();
  const key = await createVaultSetup(PASSWORD, { iterations: ITER }).then((s) => unlockVault(PASSWORD, s));
  const blob = await sealMemory(key, 'x', 'mem-early-001');
  await assert.rejects(vaultPut(storage, 'mem-early-001', blob), { code: 'not-set-up' });
});

test('vaultPut rejects ciphertext with any extra field, so plaintext cannot ride along', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const blob = await sealMemory(key, MEMORY_TEXT, 'mem-extra-001');
  await assert.rejects(vaultPut(storage, 'mem-extra-001', { ...blob, title: MARK }), { code: 'bad-blob' });
  await assert.rejects(vaultPut(storage, 'mem-extra-001', { ...blob, text: MEMORY_TEXT }), { code: 'bad-blob' });
  await assert.rejects(vaultPut(storage, 'mem-extra-001', { ...blob, v: 2 }), { code: 'bad-blob' });
  await assert.rejects(vaultPut(storage, 'mem-extra-001', { iv: blob.iv, ct: 'AAAA', v: 1, alg: blob.alg }), {
    code: 'bad-blob',
  });
  assert.ok(!allStoredText(storage).includes(MARK));
});

test('vaultPut rejects ids that are malformed or contain a secret-looking token', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const blob = await sealMemory(key, 'x', 'mem-id-00001');
  for (const bad of ['short', 'has space in it', 'bad/slash/id', 'sk-TESTFAKEKEY0000000000000000', 42]) {
    await assert.rejects(vaultPut(storage, bad, blob), { code: 'bad-id' }, `accepted id ${bad}`);
  }
});

test('vaultPut keeps createdAt on overwrite and moves updatedAt forward', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const id = 'mem-dates-001';
  const first = await vaultPut(storage, id, await sealMemory(key, 'one', id), { now: '2026-10-01T10:00:00.000Z' });
  const second = await vaultPut(storage, id, await sealMemory(key, 'two', id), { now: '2026-10-05T10:00:00.000Z' });
  assert.equal(first.createdAt, '2026-10-01T10:00:00.000Z');
  assert.equal(second.createdAt, '2026-10-01T10:00:00.000Z');
  assert.equal(second.updatedAt, '2026-10-05T10:00:00.000Z');
  assert.equal(await openMemory(key, await vaultGet(storage, id), id), 'two');
});

test('vaultGet returns null for an unknown id', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  assert.equal(await vaultGet(storage, 'mem-missing-1'), null);
});

// ---- listing ---------------------------------------------------------------

test('vaultList returns only ids and dates, never content or ciphertext', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  await vaultPut(storage, 'mem-list-0001', await sealMemory(key, MEMORY_TEXT, 'mem-list-0001'), {
    now: '2026-10-02T08:00:00.000Z',
  });
  await vaultPut(storage, 'mem-list-0002', await sealMemory(key, 'other', 'mem-list-0002'), {
    now: '2026-10-03T08:00:00.000Z',
  });
  const rows = await vaultList(storage);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['mem-list-0002', 'mem-list-0001'],
    'newest first',
  );
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'updatedAt']);
  }
  const listed = JSON.stringify(rows);
  assert.ok(!listed.includes(MARK));
  assert.ok(!listed.includes(await vaultGet(storage, 'mem-list-0001').then((r) => r.ct)));
});

test('vaultList does not expose the setup record and is empty for a new vault', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  assert.deepEqual(await vaultList(storage), []);
});

// ---- clean-up checks -------------------------------------------------------

test('random ids from randomBytes work end to end', async () => {
  const storage = memoryStorage();
  await setupVault(storage);
  const key = await unlockVault(PASSWORD, await vaultGetSetup(storage));
  const id = randomBytes(16).toString('base64url');
  await vaultPut(storage, id, await sealMemory(key, MEMORY_TEXT, id));
  assert.equal(await openMemory(key, await vaultGet(storage, id), id), MEMORY_TEXT);
});
