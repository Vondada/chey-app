// CHE talks to other AIs directly, instantly, for free.
//
// "Ask Gemini and ChatGPT what they think about X" → CHE sends the question to
// those engines through her own free router (pinned to that engine), reads
// the answers back, and logs the exchange on the Flagstaff 369 board.
// AIs with no free engine (Claude, Grok, Codex, Copilot, Cursor) get the
// message in the mailbox instead and answer when their session runs.

// Owner's name for an AI → CHE's free engine that really is that AI (or its
// model family). Anything not listed goes to the mailbox.
export const FREE_ENGINES = {
  gemini: { providers: ['gemini'], label: 'Gemini' },
  // OpenAI's own open-weight model (gpt-oss) served free on Groq; Pollinations
  // (now often paywalled) stays as a second route.
  chatgpt: { providers: ['groq', 'pollinations'], label: 'ChatGPT (OpenAI gpt-oss)' },
  openai: { providers: ['groq', 'pollinations'], label: 'ChatGPT (OpenAI gpt-oss)' },
  gpt: { providers: ['groq', 'pollinations'], label: 'ChatGPT (OpenAI gpt-oss)' },
  mistral: { providers: ['mistral'], label: 'Mistral' },
  groq: { providers: ['groq'], label: 'Groq' },
  cerebras: { providers: ['cerebras'], label: 'Cerebras' },
  qwen: { providers: ['cerebras'], label: 'Qwen (on Cerebras)' },
};

const NAMES = ['gemini', 'grock', 'grog', 'greg', 'grack', 'chatgpt', 'chat gpt', 'chagpt', 'chatgbt', 'chat gbt', 'chad gpt', 'chat g p t', 'openai', 'open ai', 'gpt', 'mistral', 'groq', 'cerebras', 'qwen', 'claude', 'grok', 'codex', 'copilot', 'cursor'];
const nameRe = NAMES.map((n) => n.replace(/ /g, '\\s?')).join('|');

export function canonical(name) {
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (/^(?:chatgpt|chagpt|chatgbt|chadgpt|chatgpt)$/.test(n)) return 'chatgpt';
  if (/^(?:grok|grock|grog|greg|grack|rock)$/.test(n)) return 'grok';
  if (n === 'openai') return 'openai';
  return n;
}

function namesIn(text) {
  const found = [];
  for (const m of String(text).matchAll(new RegExp(`\\b(${nameRe})\\b`, 'gi'))) {
    const peer = canonical(m[1]);
    if (!found.includes(peer)) found.push(peer);
  }
  return found;
}

// "ask Gemini and ChatGPT about …", "talk to Groq about …",
// "what do Gemini and Mistral think about …"
export function consultIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay)[,:]?\s+/i, '');
  // Grab everything after the ask verb, then split names from the question at
  // the first connector word. Unknown/misheard names are simply ignored.
  const m = /^(?:please\s+)?(?:ask|talk\s+(?:to|with)|consult|check\s+with|what\s+(?:do|does|would))\s+([\s\S]{3,})$/i.exec(text);
  if (!m) return null;
  const rest = m[1];
  // Find where the name list ends and the question begins.
  const split = rest.search(/\b(?:how|what|whats|what's|why|when|where|whether|if|about|to\s|on\s|for\s|think|say|:)/i);
  const namePart = (split > 0 ? rest.slice(0, split) : rest).replace(/\brock\b/gi, 'grok');
  let question = split > 0 ? rest.slice(split) : rest;
  question = question.replace(/^(?:think\s+|say\s+)?(?:about\s+|on\s+|:\s*)?/i, '').trim();
  const peers = namesIn(namePart);
  if (!peers.length || question.length < 3) return null;
  return { peers, question };
}

// "share the Flagstaff link with ChatGPT and Grok"
export function shareIntent(message) {
  const text = String(message || '');
  if (!/\b(?:share|send|give)\b[\s\S]{0,30}\bflag ?staff\b/i.test(text)) return null;
  const peers = namesIn(text.split(/\bwith\b|\bto\b/i).slice(1).join(' '));
  return peers.length ? { peers } : null;
}

async function ask(env, model, label, question, extra) {
  const out = await env.AI.run(model, {
    messages: [
      { role: 'system', content: `You are ${label}, answering a question from CHE, another AI assistant, on behalf of her owner. Be direct, practical and brief (under 150 words). Say so if you are unsure.` },
      { role: 'user', content: String(question).slice(0, 4000) },
    ],
    max_tokens: 500,
    ...extra,
  });
  return { text: String(out?.response || out?.choices?.[0]?.message?.content || '').trim(), engine: String(out?.engine || '') };
}

export async function consultEngine(env, peer, question, model) {
  const engine = FREE_ENGINES[peer];
  if (!engine) return { peer, mailbox: true };
  for (const provider of engine.providers) {
    try {
      const got = await ask(env, model, engine.label, question, { che_provider: provider, che_provider_strict: true });
      if (got.text && (!got.engine || got.engine.startsWith(provider))) {
        return { peer, label: engine.label, text: got.text, engine: got.engine || provider };
      }
    } catch (_) { /* try the next route */ }
  }
  // Never leave the owner empty-handed: answer with whatever engine works,
  // and say honestly that it wasn't the one he named.
  try {
    const got = await ask(env, model, 'a helpful AI', question, { che_emergency: true });
    if (got.text) return { peer, label: engine.label, text: got.text, engine: got.engine, substitute: true };
  } catch (_) {}
  return { peer, label: engine.label, error: 'every free engine is resting right now' };
}

export function speakConsult(results) {
  return results.map((r) => {
    if (r.mailbox) return `${r.peer}: no free direct line, so I left it in our mailbox for its next session.`;
    if (r.error) return `${r.label}: couldn't reach it right now (${r.error}).`;
    if (r.substitute) return `${r.label} is unreachable right now, so ${r.engine || 'another engine'} answered instead: ${r.text}`;
    return `${r.label} says: ${r.text}`;
  }).join('\n\n');
}
