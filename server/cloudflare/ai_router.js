// CHE's text-model router: one `AI.run` for all of CHE, many free engines
// behind it. Order:
//   1. Cloudflare Workers AI (the AI binding; 10k free neurons/day)
//   2. OpenAI         (CHE_OPENAI_API_KEY, paid)
//   3. Free tiers, each with its own daily allowance, used in turn:
//      Groq (GROQ_API_KEY), Gemini (GEMINI_API_KEY), Cerebras
//      (CEREBRAS_API_KEY), Mistral (MISTRAL_API_KEY), GitHub Models
//      (GITHUB_MODELS_TOKEN), SambaNova (SAMBANOVA_API_KEY), Hugging Face
//      (HF_TOKEN), OpenRouter (OPENROUTER_API_KEY, ":free" models)
//   4. Keyless Pollinations models (no account)
// When Cloudflare reports its daily allowance is used up, CHE skips it until
// the next UTC midnight and goes straight to the next engine with a key, so
// she keeps answering. Image models (FLUX) always stay on Cloudflare.
//
// Every provider returns `{ response }` like Workers AI, so the rest of CHE
// doesn't care which engine answered.

const PROVIDERS = [
  {
    id: 'openai',
    key: 'CHE_OPENAI_API_KEY',
    url: 'https://api.openai.com/v1/chat/completions',
    fast: (env) => env.CHE_OPENAI_FAST_MODEL || 'gpt-4.1-mini',
    strong: (env) => env.CHE_OPENAI_STRONG_MODEL || 'gpt-4.1',
  },
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
    id: 'cerebras',
    key: 'CEREBRAS_API_KEY',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    fast: (env) => env.CHE_CEREBRAS_FAST_MODEL || 'llama3.1-8b',
    strong: (env) => env.CHE_CEREBRAS_STRONG_MODEL || 'llama-3.3-70b',
  },
  {
    id: 'mistral',
    key: 'MISTRAL_API_KEY',
    url: 'https://api.mistral.ai/v1/chat/completions',
    fast: (env) => env.CHE_MISTRAL_FAST_MODEL || 'mistral-small-latest',
    strong: (env) => env.CHE_MISTRAL_STRONG_MODEL || 'mistral-medium-latest',
  },
  {
    id: 'github',
    key: 'GITHUB_MODELS_TOKEN',
    url: 'https://models.github.ai/inference/chat/completions',
    fast: (env) => env.CHE_GITHUB_FAST_MODEL || 'openai/gpt-4.1-mini',
    strong: (env) => env.CHE_GITHUB_STRONG_MODEL || 'openai/gpt-4.1',
  },
  {
    id: 'sambanova',
    key: 'SAMBANOVA_API_KEY',
    url: 'https://api.sambanova.ai/v1/chat/completions',
    fast: (env) => env.CHE_SAMBANOVA_FAST_MODEL || 'Meta-Llama-3.1-8B-Instruct',
    strong: (env) => env.CHE_SAMBANOVA_STRONG_MODEL || 'Meta-Llama-3.3-70B-Instruct',
  },
  {
    id: 'huggingface',
    key: 'HF_TOKEN',
    url: 'https://router.huggingface.co/v1/chat/completions',
    fast: (env) => env.CHE_HF_FAST_MODEL || 'meta-llama/Llama-3.1-8B-Instruct',
    strong: (env) => env.CHE_HF_STRONG_MODEL || 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'openrouter',
    key: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    fast: (env) => env.CHE_OPENROUTER_FAST_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    strong: (env) => env.CHE_OPENROUTER_STRONG_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  },
  // Keyless last resort: Pollinations' free OpenAI-compatible endpoint,
  // rotated across several models so one busy model never stops CHE. No
  // account or key. CHE_POLLINATIONS_MODELS overrides the list;
  // CHE_DISABLE_KEYLESS_AI=1 turns keyless engines off.
  ...['openai', 'mistral', 'openai-large'].map((model) => ({
    id: `pollinations:${model}`,
    keyless: true,
    url: 'https://text.pollinations.ai/openai',
    modelName: model,
    fast: () => model,
    strong: () => model,
  })),
];

function keylessModels(env) {
  const raw = String(env.CHE_POLLINATIONS_MODELS || '').trim();
  return raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : null;
}

function providerEnabled(env, provider) {
  if (provider.keyless) {
    const only = keylessModels(env);
    if (only && !only.includes(provider.modelName)) return false;
  }
  if (provider.keyless) return !['1', 'true', 'yes'].includes(String(env.CHE_DISABLE_KEYLESS_AI || '').toLowerCase());
  return Boolean(env[provider.key]);
}

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
        ...(provider.keyless ? {} : { Authorization: `Bearer ${env[provider.key]}` }),
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
    if (!providerEnabled(env, provider)) continue;
    if ((providerCooldownUntil.get(provider.id) || 0) > now) continue;
    try {
      return await callProvider(env, provider, model, input, fetcher);
    } catch (error) {
      // Rest a failing engine so the next message goes straight to one that
      // works: an hour when it wants payment or a key (401/402/403), a
      // minute when rate-limited, 20 seconds for other errors.
      const rest = [401, 402, 403].includes(error?.status) ? 3_600_000 : error?.status === 429 ? 60_000 : 20_000;
      providerCooldownUntil.set(provider.id, now + rest);
      errors.push(String(error?.message || error));
    }
  }
  const configured = PROVIDERS.filter((p) => !p.keyless && env[p.key]).map((p) => p.id);
  const hint = configured.length
    ? ''
    : ' Add a free key (GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, GITHUB_MODELS_TOKEN, SAMBANOVA_API_KEY, HF_TOKEN or OPENROUTER_API_KEY) so CHE keeps answering when Cloudflare\'s daily allowance runs out.';
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
