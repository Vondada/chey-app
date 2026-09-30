// CHE learns how the owner's voice gets misheard, and always reads words in
// context. Always on — not a switch.
//
// 1. Every reply model is told transcripts can contain mishearings and to pick
//    the meaning that fits the context (policy line in ai_router).
// 2. When the owner corrects her ("I meant Grok", "Grok, not rock", "when I
//    say rock I mean Grok"), she saves heard→meant with the words around it.
// 3. Saved corrections are applied only when the same kind of context comes
//    back (e.g. "rock" next to other AI names), and are always shown to the
//    model so it can judge the rest like a person would.

const KEY = 'speech_corrections';

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9']+/g) || [];
}

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

// Finds a correction in the owner's message. `previous` is his last message,
// used when he only says what he meant ("I meant Grok").
export function detectCorrection(message, previous = '') {
  const text = String(message || '').trim();
  let m = /\bwhen i say\s+["“]?([a-z0-9' ]{2,30}?)["”]?\s*,?\s*i mean\s+["“]?([a-z0-9' ]{2,30}?)["”]?[.!?]*$/i.exec(text);
  if (m) return { heard: m[1].trim().toLowerCase(), meant: m[2].trim() };
  m = /^(?:no[,.!]?\s+)?(?:i\s+(?:meant|mean|said)\s+)?["“]?([a-z0-9' ]{2,30}?)["”]?\s*,?\s+not\s+["“]?([a-z0-9' ]{2,30}?)["”]?[.!?]*$/i.exec(text);
  if (m) return { heard: m[2].trim().toLowerCase(), meant: m[1].trim() };
  m = /^(?:no[,.!]?\s+)?not\s+["“]?([a-z0-9' ]{2,30}?)["”]?\s*,\s*["“]?([a-z0-9' ]{2,30}?)["”]?[.!?]*$/i.exec(text);
  if (m) return { heard: m[1].trim().toLowerCase(), meant: m[2].trim() };
  m = /^(?:no[,.!]?\s+)?i\s+(?:meant|mean|said)\s+["“]?([a-z0-9' ]{2,30}?)["”]?[.!?]*$/i.exec(text);
  if (m && previous) {
    const meant = m[1].trim();
    const target = meant.toLowerCase().replace(/\s+/g, '');
    let best = null;
    for (const w of words(previous)) {
      if (w === target || w.length < 2) continue;
      const score = distance(w, target);
      if (score <= Math.max(2, Math.floor(target.length / 2)) && (!best || score < best.score)) best = { w, score };
    }
    if (best) return { heard: best.w, meant };
  }
  return null;
}

export async function loadCorrections(storage) {
  const saved = storage?.get ? await storage.get(KEY) : null;
  return Array.isArray(saved) ? saved : [];
}

export async function learnCorrection(storage, correction, previous = '') {
  if (!storage?.put || !correction?.heard || !correction?.meant) return null;
  const list = await loadCorrections(storage);
  const context = words(previous).filter((w) => w !== correction.heard && w.length > 3).slice(0, 12);
  const existing = list.find((c) => c.heard === correction.heard && c.meant.toLowerCase() === correction.meant.toLowerCase());
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.context = [...new Set([...(existing.context || []), ...context])].slice(-30);
  } else {
    list.push({ heard: correction.heard, meant: correction.meant, context, count: 1, at: new Date().toISOString() });
  }
  await storage.put(KEY, list.slice(-200));
  return correction;
}

// Rewrites a message using learned corrections, but only where the context
// matches what it looked like when he corrected her.
export function applyCorrections(message, corrections) {
  let text = String(message || '');
  const present = new Set(words(text));
  for (const c of corrections) {
    const ctx = (c.context || []).filter((w) => present.has(w));
    const confident = (c.count || 1) >= 3 || ctx.length >= 1;
    if (!confident) continue;
    const re = new RegExp(`\\b${c.heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    text = text.replace(re, c.meant);
  }
  return text;
}

export function correctionsContext(corrections) {
  if (!corrections.length) return '';
  return `OWNER'S KNOWN VOICE MISHEARINGS (learned from his corrections; use context to decide, like a person would): ${corrections
    .slice(-40)
    .map((c) => `"${c.heard}" usually means "${c.meant}"${c.context?.length ? ` when talking about ${c.context.slice(0, 4).join(', ')}` : ''}`)
    .join('; ')}.`;
}
