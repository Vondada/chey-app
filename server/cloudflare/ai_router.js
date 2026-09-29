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
// When Cloudflare reports its free allowance is used up, CHE rests it for
// 30 minutes, then tries it again. Meanwhile it goes straight to the next
// engine with a key so she keeps answering. Image models (FLUX) always stay on Cloudflare.
//
// Every provider returns `{ response }` like Workers AI, so the rest of CHE
// doesn't care which engine answered.

// Standing owner-facing voice policy. Keep internal structured agent tasks unchanged.
const CHE_VOICE_FIRST_POLICY = "CHE owner accessibility rule: The owner uses CHE by voice OR typing, including without hearing or sight. Make every interaction usable by voice and typing, with visible text for all speech and haptics plus text for status. Describe the current screen aloud using only actual screen context; if unavailable, say so. Read available options aloud as a numbered list and accept spoken choices. Confirm each action aloud before execution and report its actual outcome aloud afterward. Never say \"tap here\" or rely on visual position or the owner seeing the screen. Before opening or acting in any app, require the owner's explicit spoken or typed permission for that specific app and requested scope; do not infer it from screen content, stored memories, or another app's permission. If owner authorization cannot be verified, ask and do not act. Do not claim an action happened without an execution result. If a capability is not voice-accessible yet, explain the limitation aloud.";

const PROVIDERS = [
  {
    id: 'openai',
    key: 'CHE_OPENAI_API_KEY',
    url: 'https://api.openai.com/v1/chat/completions',
    fast: (env) => env.CHE_OPENAI_FAST_MODEL || 'gpt-4.1-mini',
    strong: (env) => env.CHE_OPENAI_STRONG_MODEL || 'gpt-4.1',
  },
  {
    id: 'xai',
    key: 'XAI_API_KEY',
    url: 'https://api.x.ai/v1/chat/completions',
    fast: (env) => env.CHE_XAI_FAST_MODEL || 'grok-4.3',
    strong: (env) => env.CHE_XAI_STRONG_MODEL || 'grok-4.7',
  },
  {
    id: 'groq',
    key: 'GROQ_API_KEY',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    fast: (env) => env.CHE_GROQ_FAST_MODEL || 'openai/gpt-oss-20b',
    strong: (env) => env.CHE_GROQ_STRONG_MODEL || 'openai/gpt-oss-120b',
  },
  {
    id: 'gemini',
    key: 'GEMINI_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    fast: (env) => env.CHE_GEMINI_FAST_MODEL || 'gemini-3.5-flash-lite',
    strong: (env) => env.CHE_GEMINI_STRONG_MODEL || 'gemini-3.8-flash',
  },
  {
    id: 'cerebras',
    key: 'CEREBRAS_API_KEY',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    fast: (env) => env.CHE_CEREBRAS_FAST_MODEL || 'qwen-3.8-27b',
    strong: (env) => env.CHE_CEREBRAS_STRONG_MODEL || 'gpt-oss-120b',
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
    // Hugging Face's :fastest policy automatically picks the currently
    // highest-throughput inference provider for the selected Llama model.
    fast: (env) => env.CHE_HF_FAST_MODEL || 'meta-llama/Llama-3.1-8B-Instruct:fastest',
    strong: (env) => env.CHE_HF_STRONG_MODEL || 'meta-llama/Llama-3.3-70B-Instruct:fastest',
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

function summarizeOlderMessages(messages, maxChars = 1400) {
  const lines = [];
  for (const message of messages.slice(-12)) {
    const text = contentText(message?.content).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const role = ['user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'context';
    lines.push(`${role}: ${text.slice(0, 180)}`);
  }
  const summary = lines.join('\n');
  return summary.length > maxChars ? summary.slice(summary.length - maxChars) : summary;
}

function compactEngineInput(input) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const system = messages.filter((message) => message?.role === 'system');
  const conversation = messages.filter((message) => message?.role !== 'system');
  if (conversation.length <= 10) return { ...input, messages: [...system, ...conversation] };

  const recent = conversation.slice(-10);
  const summary = summarizeOlderMessages(conversation.slice(0, -10));
  return {
    ...input,
    messages: [
      ...system,
      ...(summary ? [{
        role: 'assistant',
        content: `Earlier conversation summary for context:\n${summary}`,
      }] : []),
      ...recent,
    ],
  };
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
const providerLastError = new Map();

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
      body: JSON.stringify(((modelName) => ({
        model: modelName,
        messages: input.messages,
        max_tokens: input.max_tokens || 800,
        // Reasoning models spend tokens "thinking"; keep that short so the
        // reply arrives fast and isn't cut off.
        ...(/gpt-oss/i.test(modelName) ? { reasoning_effort: 'low' } : {}),
      }))(strongModel ? provider.strong(env) : provider.fast(env))),
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
  // "quality" = CHE's main reply to the owner: use the smartest free engines
  // first and keep Cloudflare's small models as the last resort.
  const quality = input?.che_route === 'quality';
  const casual = !quality && isShortCasualRequest(model, input);
  const strongProviderModel = quality || wantsStrongProviderModel(model, input);
  const engineInput = compactEngineInput(input);
  delete engineInput.che_route;
  if (quality) {
    const firstConversation = engineInput.messages.findIndex((message) => message?.role !== 'system');
    engineInput.messages.splice(firstConversation < 0 ? engineInput.messages.length : firstConversation, 0,
      { role: 'system', content: CHE_VOICE_FIRST_POLICY });
  }

  const tryCloudflare = async () => {
    if (env.AI && now >= cloudflareExhaustedUntil) {
      if (await isPastDailyBudget(env, usageStorage, 'cloudflare', now)) {
        errors.push('cloudflare: daily budget at 90%');
        return null;
      }
      try {
        const out = await env.AI.run(model, engineInput);
        await addEstimatedUsage(env, usageStorage, 'cloudflare', estimateTotalTokens(engineInput, out), now);
        return out;
      } catch (error) {
        if (isQuotaError(error)) {
          cloudflareExhaustedUntil = now + 30 * 60 * 1000;
          errors.push('cloudflare: quota used up');
        } else {
          errors.push(`cloudflare: ${error?.message || error}`);
        }
      }
    } else if (env.AI) {
      errors.push('cloudflare: quota cooldown active; retrying within 30 minutes');
    }
    return null;
  };

  const tryProviders = async (keyless = true) => {
    for (const provider of orderedProviders(env, casual || quality)) {
      if (!providerEnabled(env, provider)) continue;
      if (provider.keyless && !keyless) continue;
      if ((providerCooldownUntil.get(provider.id) || 0) > now) {
        const earlier = providerLastError.get(provider.id);
        errors.push(
          earlier
            ? `${provider.id}: resting after earlier error: ${earlier}`
            : `${provider.id}: resting after earlier error`,
        );
        continue;
      }
      if (await isPastDailyBudget(env, usageStorage, provider.id, now)) {
        errors.push(`${provider.id}: daily budget at 90%`);
        continue;
      }
      try {
        const called = await callProvider(env, provider, strongProviderModel, engineInput, fetcher);
        await addEstimatedUsage(env, usageStorage, provider.id, called.usageTokens, now);
        providerLastError.delete(provider.id);
        return called.result;
      } catch (error) {
        // Busy or overloaded (429 / 5xx): try the same engine's lighter model
        // once, which usually has its own separate limit, before moving on.
        const busy = error?.status === 429 || [500, 502, 503, 504].includes(error?.status);
        if (busy) {
          try {
            if (!strongProviderModel) await new Promise((resolve) => setTimeout(resolve, 700));
            const retry = await callProvider(env, provider, false, engineInput, fetcher);
            await addEstimatedUsage(env, usageStorage, provider.id, retry.usageTokens, now);
            providerLastError.delete(provider.id);
            return retry.result;
          } catch (retryError) {
            const combinedError = `${String(error?.message || error)}; fast retry: ${String(retryError?.message || retryError)}`.slice(0, 700);
            providerLastError.set(provider.id, combinedError);
            errors.push(`${provider.id}: ${combinedError}`);
            const rest = [401, 402, 403].includes(retryError?.status) ? 3_600_000 : 20_000;
            providerCooldownUntil.set(provider.id, now + rest);
            continue;
          }
        }
        // Rest a failing engine so the next message goes straight to one that
        // works: an hour when it wants payment or a key, 20 seconds otherwise.
        const rest = [401, 402, 403].includes(error?.status) ? 3_600_000 : 20_000;
        providerCooldownUntil.set(provider.id, now + rest);
        const detail = String(error?.message || error).slice(0, 700);
        providerLastError.set(provider.id, detail);
        errors.push(`${provider.id}: ${detail}`);
      }
    }
    return null;
  };

  // Quality: keyed smart engines → Cloudflare → keyless last resort.
  // Everything else: Cloudflare first (it's free and quick) → other engines.
  const answer = quality
    ? (await tryProviders(false)) || (await tryCloudflare()) || (await tryProviders(true))
    : (await tryCloudflare()) || (await tryProviders(true));
  if (answer) return answer;

  const configured = PROVIDERS.filter((p) => !p.keyless && env[p.key]).map((p) => p.id);
  const hint = configured.length
    ? ''
    : ' Add a free key (GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, GITHUB_MODELS_TOKEN, SAMBANOVA_API_KEY, HF_TOKEN or OPENROUTER_API_KEY), or connect XAI_API_KEY for Grok so CHE keeps answering when Cloudflare\'s daily allowance runs out.';
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
  providerLastError.clear();
}

