import test from 'node:test';
import assert from 'node:assert/strict';
import { CheLibrary, chunkText, htmlToText, libraryIntent, libraryContext } from './library.js';

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

test('owner phrases to save a page or pasted script', () => {
  assert.equal(libraryIntent('CHE, memorize this page https://example.com/script').url, 'https://example.com/script');
  const pasted = libraryIntent(`Store this script in your memory bank: ${'INT. KITCHEN - NIGHT. Maya drops the key. '.repeat(10)}`);
  assert.ok(pasted.text.startsWith('INT. KITCHEN'));
  assert.equal(libraryIntent('what did we talk about yesterday'), null);
});

test('chunks keep all text and html is readable', () => {
  const text = 'Sentence one. '.repeat(400);
  assert.equal(chunkText(text).join(' ').replace(/\s+/g, ' ').trim(), text.trim());
  assert.equal(htmlToText('<p>Hi <b>there</b></p><script>x()</script>'), 'Hi there');
});

test('library saves a whole script and recalls the right scene offline from its own storage', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const lib = new CheLibrary(storage);
  const script = Array.from({ length: 60 }, (_, i) => `Scene ${i}. The crew argues about the weather and the ship.`).join('\n\n')
    + '\n\nScene 61. Maya finds the silver key under the lighthouse stairs and hides it from Jonah.';
  const saved = lib.add({ title: 'Lighthouse', text: script });
  assert.ok(saved.chunks > 1);
  const hits = lib.search('Where did Maya find the silver key?');
  assert.equal(hits[0].title, 'Lighthouse');
  assert.match(hits[0].text, /silver key under the lighthouse stairs/);
  assert.match(libraryContext(hits), /CHE LIBRARY/);
  assert.equal(lib.list().length, 1);
  lib.remove(saved.id);
  assert.equal(lib.list().length, 0);
});
