// CHE's text-model router: one `AI.run` for all of CHE, many free engines
// behind it. Order:
//   1. Cloudflare Workers AI (the AI binding; 10k free neurons/day)
//   2. Groq           (GROQ_API_KEY,       free tier)
//   3. Google Gemini  (GEMINI_API_KEY,     free tier)
//   4. OpenRouter     (OPENROUTER_API_KEY, free ":free" models)
// When Cloudflare reports its daily allowance is used up, CHE skips it until
// the next UTC midnight and goes straight to the next engine with a key, so
// she keeps answering. Image models (FLUX) always stay on Cloudflare.
//
// Every provider returns `{ response }` like Workers AI, so the rest of CHE
// doesn't care which engine answered.

const PROVIDERS = [
  {
    id: 'groq',
    key: 'GROQ_API_KEY',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    fast: (env) => env.CHE_GROQ_FAST_MODEL || 'llama-3.1-8b-instant',
    strong: (env) => env.CHE_GROQ_STRONG_MODEL || 'llama-3.3-70b-versatile',
  },
  {
    id: 'gemini',
    key: 'GEMINI_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    fast: (env) => env.CHE_GEMINI_FAST_MODEL || 'gemini-2.5-flash-lite',
    strong: (env) => env.CHE_GEMINI_STRONG_MODEL || 'gemini-2.5-flash',
  },
  {
    id: 'openrouter',
    key: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    fast: (env) => env.CHE_OPENROUTER_FAST_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    strong: (env) => env.CHE_OPENROUTER_STRONG_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  },
];

// Per-isolate memory of "Cloudflare's free allowance is gone until…".
let cloudflareExhaustedUntil = 0;
const providerCooldownUntil = new Map();

function nextUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function isQuotaError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('4006') || text.includes('daily free allocation') || text.includes('neurons');
}

function isStrongModel(model) {
  return /8b|70b|strong/i.test(String(model)) && !/3b/i.test(String(model));
}

async function callProvider(env, provider, model, input, fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetcher(provider.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env[provider.key]}`,
        'Content-Type': 'application/json',
        ...(provider.id === 'openrouter' ? { 'HTTP-Referer': 'https://che.app', 'X-Title': 'CHE' } : {}),
      },
      body: JSON.stringify({
        model: isStrongModel(model) ? provider.strong(env) : provider.fast(env),
        messages: input.messages,
        max_tokens: input.max_tokens || 800,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`${provider.id} ${response.status}: ${String(data?.error?.message || data?.error || '').slice(0, 160)}`);
      error.status = response.status;
      throw error;
    }
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error(`${provider.id} returned no text`);
    return { response: text, engine: provider.id };
  } finally {
    clearTimeout(timer);
  }
}

// Runs a text model through the first engine that can answer.
export async function routeText(env, model, input, fetcher = fetch) {
  const errors = [];
  const now = Date.now();
  if (env.AI && now >= cloudflareExhaustedUntil) {
    try {
      const out = await env.AI.run(model, input);
      return out;
    } catch (error) {
      if (isQuotaError(error)) cloudflareExhaustedUntil = nextUtcMidnight(now);
      errors.push(`cloudflare: ${error?.message || error}`);
    }
  } else if (env.AI) {
    errors.push('cloudflare: daily free allowance used up');
  }
  for (const provider of PROVIDERS) {
    if (!env[provider.key]) continue;
    if ((providerCooldownUntil.get(provider.id) || 0) > now) continue;
    try {
      return await callProvider(env, provider, model, input, fetcher);
    } catch (error) {
      // Rate-limited: rest this engine for a minute; others keep answering.
      if (error?.status === 429) providerCooldownUntil.set(provider.id, now + 60_000);
      errors.push(String(error?.message || error));
    }
  }
  const configured = PROVIDERS.filter((p) => env[p.key]).map((p) => p.id);
  const hint = configured.length
    ? ''
    : ' Add a free GROQ_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY so CHE keeps answering when Cloudflare\'s daily allowance runs out.';
  const error = new Error(`All AI engines failed (${errors.join(' | ').slice(0, 300)}).${hint}`);
  error.quota = errors.some((e) => /allowance|4006|neurons|429/.test(e));
  throw error;
}

// Wraps the Worker env so every `env.AI.run` for text goes through the router.
export function routedEnv(env, fetcher = fetch) {
  const wrapped = Object.create(env);
  Object.defineProperty(wrapped, 'AI', {
    value: {
      run: (model, input, options) => (
        /flux|stable-diffusion|image/i.test(String(model)) || !Array.isArray(input?.messages)
          ? env.AI.run(model, input, options)
          : routeText(env, model, input, fetcher)
      ),
    },
    enumerable: true,
  });
  return wrapped;
}

export function resetRouterForTests() {
  cloudflareExhaustedUntil = 0;
  providerCooldownUntil.clear();
}
