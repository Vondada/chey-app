// CHE translation / multilingual helpers.
// Prefer Workers AI m2m100 when available; fall back to chat model prompt.
// Never invent that a translation was published or sent.

const M2M = '@cf/meta/m2m100-1.2b';

export const CHE_LANGUAGES = [
  { code: 'en', name: 'English', tts: 'en-US' },
  { code: 'es', name: 'Spanish', tts: 'es-ES' },
  { code: 'fr', name: 'French', tts: 'fr-FR' },
  { code: 'de', name: 'German', tts: 'de-DE' },
  { code: 'pt', name: 'Portuguese', tts: 'pt-BR' },
  { code: 'it', name: 'Italian', tts: 'it-IT' },
  { code: 'zh', name: 'Chinese', tts: 'zh-CN' },
  { code: 'ja', name: 'Japanese', tts: 'ja-JP' },
  { code: 'ko', name: 'Korean', tts: 'ko-KR' },
  { code: 'ar', name: 'Arabic', tts: 'ar-SA' },
  { code: 'hi', name: 'Hindi', tts: 'hi-IN' },
  { code: 'ru', name: 'Russian', tts: 'ru-RU' },
  { code: 'uk', name: 'Ukrainian', tts: 'uk-UA' },
  { code: 'pl', name: 'Polish', tts: 'pl-PL' },
  { code: 'tr', name: 'Turkish', tts: 'tr-TR' },
  { code: 'vi', name: 'Vietnamese', tts: 'vi-VN' },
  { code: 'th', name: 'Thai', tts: 'th-TH' },
  { code: 'id', name: 'Indonesian', tts: 'id-ID' },
  { code: 'nl', name: 'Dutch', tts: 'nl-NL' },
  { code: 'sv', name: 'Swedish', tts: 'sv-SE' },
];

export function languageName(code) {
  const hit = CHE_LANGUAGES.find((l) => l.code === String(code || '').toLowerCase());
  return hit?.name || String(code || 'unknown');
}

export function normalizeLang(code, fallback = 'en') {
  const c = String(code || '').toLowerCase().trim().slice(0, 12);
  if (!c) return fallback;
  const base = c.split(/[-_]/)[0];
  if (CHE_LANGUAGES.some((l) => l.code === base)) return base;
  return fallback;
}



function tokenizeMt(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function translationTokenF1(hypothesis, reference) {
  const hyp = tokenizeMt(hypothesis);
  const ref = tokenizeMt(reference);
  if (!hyp.length || !ref.length) return { precision: 0, recall: 0, f1: 0 };
  const refCounts = new Map();
  for (const tok of ref) refCounts.set(tok, (refCounts.get(tok) || 0) + 1);
  let overlap = 0;
  const used = new Map();
  for (const tok of hyp) {
    const u = used.get(tok) || 0;
    if (u < (refCounts.get(tok) || 0)) {
      overlap += 1;
      used.set(tok, u + 1);
    }
  }
  const precision = overlap / hyp.length;
  const recall = overlap / ref.length;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision: Math.round(precision * 10000) / 10000,
    recall: Math.round(recall * 10000) / 10000,
    f1: Math.round(f1 * 10000) / 10000,
  };
}

export function evaluateTranslationQuality(hypothesis, reference) {
  if (!String(reference || '').trim()) {
    return { available: false, detail: 'No reference — quality metrics skipped.' };
  }
  const token = translationTokenF1(hypothesis, reference);
  return {
    available: true,
    token_f1: token.f1,
    token_precision: token.precision,
    token_recall: token.recall,
    f1: token.f1,
    accuracy: token.f1,
    summary: `Token F1 ${(token.f1 * 100).toFixed(1)}%`,
  };
}

export function parseTranslatePhrase(original, normalized) {
  const o = String(original || '').trim();
  const t = String(normalized || '').toLowerCase();

  // set preferred reply locale (not a translate job)
  const setLoc = t.match(/\b(?:set|prefer|use)\s+(?:my\s+)?(?:locale|language|reply language)\s+(?:to\s+)?([a-z]{2,20})\b/)
    || t.match(/\b(?:speak|reply|answer)\s+(?:to me\s+)?in\s+([a-z]{2,20})\b/);
  if (setLoc && !/\btranslat/.test(t)) {
    let loc = setLoc[1];
    const byName = CHE_LANGUAGES.find((l) => l.name.toLowerCase() === loc || l.code === loc);
    if (byName) loc = byName.code;
    loc = normalizeLang(loc, '');
    if (loc) return { type: 'setLocale', locale: loc };
  }

  // translate X to Spanish / translate this to ja
  const m = t.match(/\btranslat(?:e|ion)\b[\s\S]{0,40}?\bto\s+([a-z]{2,12})\b/)
    || o.match(/\btranslat(?:e|ion)\b[\s\S]{0,40}?\bto\s+([A-Za-z]{2,20})\b/i);
  if (!m && !/\btranslat(?:e|ion)\b/.test(t)) return null;
  let target = m ? m[1] : 'en';
  const byName = CHE_LANGUAGES.find((l) => l.name.toLowerCase() === String(target).toLowerCase());
  if (byName) target = byName.code;
  target = normalizeLang(target, 'en');
  let text = o;
  const strip = o.replace(/^.*?\btranslat(?:e|ion)\b/i, '').replace(/\bto\s+[A-Za-z]{2,20}\s*:?/i, '').trim();
  if (strip.length > 1) text = strip.replace(/^[:\-\s]+/, '');
  // "translate to Spanish: hello" pattern
  const colon = o.match(/\btranslat(?:e|ion)\b[\s\S]*?:\s*([\s\S]+)$/i);
  if (colon) text = colon[1].trim();
  // strip trailing reference: …
  let reference = '';
  const refMatch = text.match(/\breference\s*:\s*([\s\S]+)$/i);
  if (refMatch) {
    reference = refMatch[1].trim().slice(0, 4000);
    text = text.slice(0, refMatch.index).trim();
  }
  return {
    type: 'translate',
    target_lang: target,
    text: text.slice(0, 4000),
    reference: reference || undefined,
  };
}

export function replyLanguageSystemLine(langCode) {
  const code = normalizeLang(langCode, 'en');
  if (code === 'en') return '';
  const name = languageName(code);
  return `REPLY LANGUAGE: Reply to the owner in ${name} (${code}). Keep voice-first brevity. Technical identifiers may stay in English when clearer.`;
}

async function translateWithM2m(env, text, target) {
  if (!env?.AI) return null;
  try {
    const out = await env.AI.run(M2M, {
      text,
      source_lang: 'auto',
      target_lang: target === 'zh' ? 'zh' : target,
    });
    const translated = String(out?.translated_text || out?.translation || out?.result || '').trim();
    return translated || null;
  } catch (_) {
    return null;
  }
}

async function translateWithChat(env, text, target, ask) {
  const name = languageName(target);
  const prompt = [
    `Translate the following text into ${name} (${target}).`,
    'Return ONLY the translation, no quotes or commentary.',
    '',
    text,
  ].join('\n');
  if (typeof ask === 'function') {
    const reply = await ask(prompt);
    return String(reply || '').trim() || null;
  }
  if (!env?.AI) return null;
  try {
    const out = await env.AI.run(env.CHE_FAST_MODEL || '@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: 'You are a precise translator. Output only the translation.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1200,
    });
    return String(out?.response || out?.choices?.[0]?.message?.content || '').trim() || null;
  } catch (_) {
    return null;
  }
}

export async function translateText(env, { text, target_lang: targetLang, source_lang: sourceLang, reference = '', ask } = {}) {
  const input = String(text || '').trim().slice(0, 4000);
  const target = normalizeLang(targetLang, 'en');
  if (!input) return { ok: false, status: 400, detail: 'Nothing to translate.' };
  const viaM2m = await translateWithM2m(env, input, target);
  if (viaM2m) {
    const translation = viaM2m.slice(0, 8000);
    return {
      ok: true,
      engine: 'workers_ai_m2m100',
      source_lang: sourceLang || 'auto',
      target_lang: target,
      target_name: languageName(target),
      text: input,
      translation,
      quality: evaluateTranslationQuality(translation, reference),
    };
  }
  const viaChat = await translateWithChat(env, input, target, ask);
  if (viaChat) {
    const translation = viaChat.slice(0, 8000);
    return {
      ok: true,
      engine: 'chat_model',
      source_lang: sourceLang || 'auto',
      target_lang: target,
      target_name: languageName(target),
      text: input,
      translation,
      quality: evaluateTranslationQuality(translation, reference),
    };
  }
  return {
    ok: false,
    status: 503,
    detail: 'Translation engine unavailable. Try again when Workers AI or a chat model is healthy.',
  };
}

export function speakTranslation(result) {
  if (!result?.ok) return `CHE here. Translation failed: ${result?.detail || 'unknown error'}.`;
  const q = result.quality?.available ? ` ${result.quality.summary}.` : '';
  return `CHE here. ${result.target_name}: ${result.translation}.${q}`;
}
