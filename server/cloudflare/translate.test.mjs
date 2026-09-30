import assert from 'node:assert/strict';
import { normalizeLang, parseTranslatePhrase, languageName, replyLanguageSystemLine } from './translate.js';

assert.equal(normalizeLang('es-MX'), 'es');
assert.equal(languageName('ja'), 'Japanese');
assert.ok(replyLanguageSystemLine('fr').includes('French'));
assert.equal(replyLanguageSystemLine('en'), '');

const p = parseTranslatePhrase('Translate to Spanish: good morning', 'translate to spanish: good morning');
assert.equal(p?.type, 'translate');
assert.equal(p?.target_lang, 'es');
assert.ok(p?.text.toLowerCase().includes('good morning'));

console.log('translate.test.mjs ok');

import { evaluateTranslationQuality, parseTranslatePhrase as parseTr } from './translate.js';

const set = parseTr('Set my language to French', 'set my language to french');
assert.equal(set?.type, 'setLocale');
assert.equal(set?.locale, 'fr');

const q = evaluateTranslationQuality('hola mundo', 'hola mundo');
assert.equal(q.available, true);
assert.ok(q.token_f1 > 0.9);
