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
  gemini: { provider: 'gemini', label: 'Gemini' },
  chatgpt: { provider: 'pollinations', label: 'ChatGPT (OpenAI model via Pollinations)' },
  openai: { provider: 'pollinations', label: 'ChatGPT (OpenAI model via Pollinations)' },
  gpt: { provider: 'pollinations', label: 'ChatGPT (OpenAI model via Pollinations)' },
  mistral: { provider: 'mistral', label: 'Mistral' },
  groq: { provider: 'groq', label: 'Groq' },
  cerebras: { provider: 'cerebras', label: 'Cerebras' },
  qwen: { provider: 'cerebras', label: 'Qwen (on Cerebras)' },
};

const NAMES = ['gemini', 'chatgpt', 'chat gpt', 'chagpt', 'chatgbt', 'chat gbt', 'chad gpt', 'chat g p t', 'openai', 'open ai', 'gpt', 'mistral', 'groq', 'cerebras', 'qwen', 'claude', 'grok', 'codex', 'copilot', 'cursor'];
const nameRe = NAMES.map((n) => n.replace(/ /g, '\\s?')).join('|');

export function canonical(name) {
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (/^(?:chatgpt|chagpt|chatgbt|chadgpt|chatgpt)$/.test(n)) return 'chatgpt';
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
  const list = `(?:${nameRe})(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)(?:${nameRe}))*`;
  const m = new RegExp(`^(?:please\\s+)?(?:ask|talk\\s+(?:to|with)|consult|check\\s+with|what\\s+(?:do|does|would))\\s+(${list})\\s*[:,]?\\s*(?:think\\s+|say\\s+)?(?:about\\s+|on\\s+|:\\s*)?([\\s\\S]{3,})$`, 'i').exec(text);
  if (!m) return null;
  const peers = namesIn(m[1]);
  if (!peers.length) return null;
  return { peers, question: m[2].trim() };
}

// "share the Flagstaff link with ChatGPT and Grok"
export function shareIntent(message) {
  const text = String(message || '');
  if (!/\b(?:share|send|give)\b[\s\S]{0,30}\bflag ?staff\b/i.test(text)) return null;
  const peers = namesIn(text.split(/\bwith\b|\bto\b/i).slice(1).join(' '));
  return peers.length ? { peers } : null;
}

export async function consultEngine(env, peer, question, model) {
  const engine = FREE_ENGINES[peer];
  if (!engine) return { peer, mailbox: true };
  try {
    const out = await env.AI.run(model, {
      messages: [
        { role: 'system', content: `You are ${engine.label}, answering a question from CHE, another AI assistant, on behalf of her owner. Be direct, practical and brief (under 150 words). Say so if you are unsure.` },
        { role: 'user', content: String(question).slice(0, 4000) },
      ],
      max_tokens: 500,
      che_provider: engine.provider,
      che_provider_strict: true,
    });
    const text = String(out?.response || out?.choices?.[0]?.message?.content || '').trim();
    if (!text) return { peer, label: engine.label, error: 'no answer' };
    if (out?.engine && !String(out.engine).startsWith(engine.provider)) {
      return { peer, label: engine.label, error: `${engine.label} is resting or not connected` };
    }
    return { peer, label: engine.label, text, engine: out?.engine || engine.provider };
  } catch (error) {
    return { peer, label: engine.label, error: String(error?.message || error).slice(0, 200) };
  }
}

export function speakConsult(results) {
  return results.map((r) => {
    if (r.mailbox) return `${r.peer}: no free direct line, so I left it in our mailbox for its next session.`;
    if (r.error) return `${r.label}: couldn't reach it right now (${r.error}).`;
    return `${r.label} says: ${r.text}`;
  }).join('\n\n');
}
