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

const FREE_PROVIDER_IDS = ['groq', 'cerebras', 'gemini', 'mistral', 'github', 'sambanova', 'huggingface', 'openrouter'];
const USAGE_KEY_PREFIX = 'ai_usage:';

function usageLimitName(providerId) {
  return `CHE_${String(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_DAILY_TOKEN_LIMIT`;
}

function dailyTokenLimit(env, providerId) {
  const value = Number(env[usageLimitName(providerId)] || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : String(part?.text || '')).join(' ');
  }
  return String(content || '');
}

function estimateInputTokens(input) {
  const chars = (Array.isArray(input?.messages) ? input.messages : [])
    .reduce((sum, message) => sum + String(message?.role || '').length + contentText(message?.content).length + 4, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function responseText(output) {
  return String(output?.response || output?.choices?.[0]?.message?.content || '');
}

function estimateTotalTokens(input, output) {
  return estimateInputTokens(input) + Math.max(1, Math.ceil(responseText(output).length / 4));
}

function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function nextZonedMidnight(now, timeZone) {
  const current = zonedParts(now, timeZone);
  const targetLocal = Date.UTC(current.year, current.month - 1, current.day + 1, 0, 0, 0);
  let guess = targetLocal + 12 * 60 * 60 * 1000;
  for (let i = 0; i < 4; i += 1) {
    const rendered = zonedParts(guess, timeZone);
    const renderedLocal = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
    );
    const delta = targetLocal - renderedLocal;
    guess += delta;
    if (Math.abs(delta) < 1000) break;
  }
  return guess;
}

function nextUsageReset(providerId, now) {
  return providerId === 'gemini'
    ? nextZonedMidnight(now, 'America/Los_Angeles')
    : nextUtcMidnight(now);
}

async function usageRecord(storage, providerId, now) {
  const key = `${USAGE_KEY_PREFIX}${providerId}`;
  const stored = storage ? await storage.get(key) : null;
  if (!stored || now >= Number(stored.reset_at || 0)) {
    return { estimated_tokens: 0, reset_at: nextUsageReset(providerId, now) };
  }
  return {
    estimated_tokens: Math.max(0, Number(stored.estimated_tokens || 0)),
    reset_at: Number(stored.reset_at),
  };
}

async function isPastDailyBudget(env, storage, providerId, now) {
  const limit = dailyTokenLimit(env, providerId);
  if (!storage || !limit) return false;
  const usage = await usageRecord(storage, providerId, now);
  return usage.estimated_tokens >= limit * 0.9;
}

async function addEstimatedUsage(env, storage, providerId, tokens, now = Date.now()) {
  if (!storage || !Number.isFinite(tokens) || tokens <= 0) return;
  const update = async (target) => {
    const usage = await usageRecord(target, providerId, now);
    await target.put(`${USAGE_KEY_PREFIX}${providerId}`, {
      estimated_tokens: usage.estimated_tokens + Math.ceil(tokens),
      reset_at: usage.reset_at,
      limit: dailyTokenLimit(env, providerId) || null,
      updated_at: new Date(now).toISOString(),
    });
  };
  if (typeof storage.transaction === 'function') {
    await storage.transaction(update);
  } else {
    await update(storage);
  }
}

function isShortCasualRequest(model, input) {
  if (isStrongModel(model)) return false;
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const latestUser = [...messages].reverse().find((item) => item?.role === 'user');
  const text = contentText(latestUser?.content).trim();
  const totalChars = messages.reduce((sum, item) => sum + contentText(item?.content).length, 0);
  if (!text || text.length > 240 || totalChars > 1600 || Number(input?.max_tokens || 0) > 500) return false;
  return !/\b(debug|code|implement|architect|research|analy[sz]e|analysis|report|backtest|legal|financial|medical|compare|plan|design|build|fix|investigate)\b/i.test(text);
}

function wantsStrongProviderModel(model, input) {
  if (isShortCasualRequest(model, input)) return false;
  const chars = (Array.isArray(input?.messages) ? input.messages : [])
    .reduce((sum, item) => sum + contentText(item?.content).length, 0);
  return isStrongModel(model) || chars > 5000 || Number(input?.max_tokens || 0) > 700;
}

function orderedProviders(env, casual) {
  if (!casual) return PROVIDERS;
  const requested = String(env.CHE_FAST_FREE_PROVIDER || 'groq').trim().toLowerCase();
  const candidates = [requested, ...FREE_PROVIDER_IDS.filter((id) => id !== requested)];
  const id = candidates.find((candidate) => {
    const provider = PROVIDERS.find((item) => item.id === candidate);
    return provider && providerEnabled(env, provider);
  });
  if (!id) return PROVIDERS;
  const preferred = PROVIDERS.find((provider) => provider.id === id);
  return [preferred, ...PROVIDERS.filter((provider) => provider !== preferred)];
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

async function callProvider(env, provider, strongModel, input, fetcher) {
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
        model: strongModel ? provider.strong(env) : provider.fast(env),
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
    const reportedTokens = Number(data?.usage?.total_tokens || data?.usage?.totalTokens || 0);
    return {
      result: { response: text, engine: provider.id },
      usageTokens: Number.isFinite(reportedTokens) && reportedTokens > 0
        ? reportedTokens
        : estimateInputTokens(input) + Math.max(1, Math.ceil(text.length / 4)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Runs a text model through the first engine that can answer.
export async function routeText(env, model, input, fetcher = fetch, usageStorage = null) {
  const errors = [];
  const now = Date.now();
  const casual = isShortCasualRequest(model, input);
  const strongProviderModel = wantsStrongProviderModel(model, input);

  if (env.AI && now >= cloudflareExhaustedUntil) {
    if (await isPastDailyBudget(env, usageStorage, 'cloudflare', now)) {
      errors.push('cloudflare: daily budget at 90%');
    } else {
      try {
        const out = await env.AI.run(model, input);
        await addEstimatedUsage(env, usageStorage, 'cloudflare', estimateTotalTokens(input, out), now);
        return out;
      } catch (error) {
        if (isQuotaError(error)) {
          cloudflareExhaustedUntil = nextUtcMidnight(now);
          errors.push('cloudflare: quota used up');
        } else {
          errors.push(`cloudflare: ${error?.message || error}`);
        }
      }
    }
  } else if (env.AI) {
    errors.push('cloudflare: daily free allowance used up');
  }

  for (const provider of orderedProviders(env, casual)) {
    if (!providerEnabled(env, provider)) continue;
    if ((providerCooldownUntil.get(provider.id) || 0) > now) {
      errors.push(`${provider.id}: resting`);
      continue;
    }
    if (await isPastDailyBudget(env, usageStorage, provider.id, now)) {
      errors.push(`${provider.id}: daily budget at 90%`);
      continue;
    }
    try {
      const called = await callProvider(env, provider, strongProviderModel, input, fetcher);
      await addEstimatedUsage(env, usageStorage, provider.id, called.usageTokens, now);
      return called.result;
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
  const error = new Error(`All AI engines failed (${errors.join(' | ').slice(0, 1500)}).${hint}`);
  error.quota = errors.some((e) => /quota|allowance|4006|neurons|429|budget/.test(e));
  console.log("CHE engine errors:", errors);
  throw error;
}

// Wraps the Worker env so every `env.AI.run` for text goes through the router.
export function routedEnv(env, fetcher = fetch, usageStorage = null) {
  const wrapped = Object.create(env);
  Object.defineProperty(wrapped, 'AI', {
    value: {
      run: (model, input, options) => (
        /flux|stable-diffusion|image/i.test(String(model)) || !Array.isArray(input?.messages)
          ? env.AI.run(model, input, options)
          : routeText(env, model, input, fetcher, usageStorage)
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
