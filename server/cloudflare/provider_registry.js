// CHE Universal AI Provider Registry / Capability Broker.
//
// CHE owns identity, memory, permissions, Office, skills and routing. Outside
// AI providers are interchangeable workers described here by declarative
// manifests: what they can do, how to reach them, how to discover their
// models, what data they may receive. Nothing in this file holds or returns a
// credential value — only whether a credential is configured server-side.
//
// A future provider is added with a manifest (built in below, or installed
// through the reviewed provider-plugin flow). Manifests are data only: CHE
// never downloads or executes provider code.

export const CAPABILITIES = [
  'text', 'fast_chat', 'deep_reasoning', 'coding', 'vision', 'image_generation',
  'video_generation', 'speech_to_text', 'text_to_speech', 'embeddings',
  'web_search', 'file_analysis', 'tool_calling', 'computer_use', 'long_context',
  'batch',
];

export const COST_CLASSES = ['free', 'low', 'medium', 'high'];
export const LATENCY_CLASSES = ['instant', 'fast', 'medium', 'slow'];
export const AUTH_TYPES = ['api_key', 'oauth', 'none', 'binding'];
export const DISCOVERY_METHODS = ['openai_models', 'gemini_models', 'ollama_tags', 'huggingface_models', 'static', 'none'];

// Default data classes a provider may receive before the owner changes it.
// Local engines may see everything; hosted engines only public + personal
// context. Secrets never leave CHE (see privacy_policy.js).
const HOSTED_DATA = ['public', 'personal'];
const LOCAL_DATA = ['public', 'personal', 'private', 'financial', 'device_data', 'messages', 'email', 'photos', 'location'];

// Built-in provider manifests. Model names are only defaults/overrides; the
// Model Watcher discovers the live catalog, so CHE is not tied to any single
// model version.
export const BUILTIN_PROVIDER_MANIFESTS = [
  {
    id: 'cloudflare', name: 'Cloudflare Workers AI', family: 'cloudflare',
    auth: { type: 'binding', binding: 'AI' }, api_base: 'binding:AI',
    discovery: { method: 'static' }, locality: 'cloud',
    capabilities: ['text', 'fast_chat', 'coding', 'image_generation', 'embeddings', 'speech_to_text', 'text_to_speech', 'batch'],
    cost_class: 'free', latency_class: 'fast', context_tokens: 32000,
    privacy: { retention: 'provider_policy', trains_on_data: false, default_data_classes: HOSTED_DATA },
    streaming: true, oauth: false,
    connect_hint: 'Built into the CHE Worker (AI binding). No extra credential needed.',
  },
  {
    id: 'openai', name: 'OpenAI', family: 'openai',
    auth: { type: 'api_key', secrets: ['OPENAI_API_KEY', 'CHE_OPENAI_API_KEY'] },
    api_base: 'https://api.openai.com/v1', chat_path: '/chat/completions',
    discovery: { method: 'openai_models', path: '/models' }, locality: 'cloud',
    capabilities: ['text', 'fast_chat', 'deep_reasoning', 'coding', 'vision', 'image_generation', 'speech_to_text', 'text_to_speech', 'embeddings', 'tool_calling', 'file_analysis', 'long_context', 'batch'],
    cost_class: 'medium', latency_class: 'fast', context_tokens: 128000,
    privacy: { retention: 'provider_policy', trains_on_data: false, default_data_classes: HOSTED_DATA },
    streaming: true, oauth: false,
    connect_hint: 'Add OPENAI_API_KEY (or CHE_OPENAI_API_KEY) as a Worker/GitHub secret. A ChatGPT app login is not an API credential.',
  },
  {
    id: 'xai', name: 'xAI Grok', family: 'xai',
    auth: { type: 'api_key', secrets: ['XAI_API_KEY'] },
    api_base: 'https://api.x.ai/v1', chat_path: '/chat/completions',
    discovery: { method: 'openai_models', path: '/models' }, locality: 'cloud',
    capabilities: ['text', 'fast_chat', 'deep_reasoning', 'coding', 'vision', 'image_generation', 'tool_calling', 'long_context', 'web_search'],
    cost_class: 'medium', latency_class: 'fast', context_tokens: 256000,
    privacy: { retention: 'provider_policy', trains_on_data: false, default_data_classes: HOSTED_DATA },
    streaming: true, oauth: false,
    connect_hint: 'Add XAI_API_KEY from console.x.ai as a Worker/GitHub secret. Management API use needs a separate owner-supplied management key.',
  },
  {
    id: 'gemini', name: 'Google Gemini', family: 'google',
    auth: { type: 'api_key', secrets: ['GEMINI_API_KEY'] },
    api_base: 'https://generativelanguage.googleapis.com/v1beta/openai', chat_path: '/chat/completions',
    discovery: { method: 'openai_models', path: '/models' }, locality: 'cloud',
    capabilities: ['text', 'fast_chat', 'deep_reasoning', 'coding', 'vision', 'speech_to_text', 'text_to_speech', 'embeddings', 'tool_calling', 'long_context', 'file_analysis'],
    cost_class: 'free', latency_class: 'fast', context_tokens: 1000000,
    privacy: { retention: 'provider_policy', trains_on_data: true, default_data_classes: ['public'] },
    streaming: true, oauth: true,
    connect_hint: 'Add GEMINI_API_KEY from Google AI Studio. Free-tier data may be used by Google to improve products, so CHE only sends public context by default.',
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', family: 'anthropic',
    auth: { type: 'api_key', secrets: ['ANTHROPIC_API_KEY'] },
    api_base: 'https://api.anthropic.com/v1', chat_path: '/chat/completions',
    discovery: { method: 'openai_models', path: '/models' }, locality: 'cloud',
    capabilities: ['text', 'fast_chat', 'deep_reasoning', 'coding', 'vision', 'tool_calling', 'long_context', 'file_analysis', 'computer_use'],
    cost_class: 'medium', latency_class: 'fast', context_tokens: 200000,
    privacy: { retention: 'provider_policy', trains_on_data: false, default_data_classes: HOSTED_DATA },
    streaming: true, oauth: false,
    connect_hint: 'Add ANTHROPIC_API_KEY from console.anthropic.com as a Worker/GitHub secret.',
  },
  {
    id: 'huggingface', name: 'Hugging Face (Llama & open models)', family: 'huggingface',
    auth: { type: 'api_key', secrets: ['HF_TOKEN'] },
    api_base: 'https://router.huggingface.co/v1', chat_path: '/chat/completions',
    discovery: { method: 'openai_models', path: '/models' }, locality: 'cloud',
    capabilities: ['text', 'fast_chat', 'coding', 'deep_reasoning', 'text_to_speech', 'embeddings', 'long_context'],
    cost_class: 'low', latency_class: 'medium', context_tokens: 128000,
    privacy: { retention: 'provider_policy', trains_on_data: false, default_data_classes: HOSTED_DATA },
    streaming: true, oauth: true,
    connect_hint: 'Add HF_TOKEN (a Hugging Face access token with inference permission).',
  },
  {
    id: 'ollama', name: 'Local / Ollama', family: 'local',
    auth: { type: 'none', url_secret: 'CHE_OLLAMA_URL', optional_secrets: ['CHE_OLLAMA_TOKEN'] },
    api_base: 'env:CHE_OLLAMA_URL', chat_path: '/v1/chat/completions',
    discovery: { method: 'ollama_tags', path: '/api/tags' }, locality: 'local',
    capabilities: ['text', 'fast_chat', 'coding', 'embeddings', 'deep_reasoning'],
    cost_class: 'free', latency_class: 'medium', context_tokens: 32000,
    privacy: { retention: 'owner_hardware', trains_on_data: false, default_data_classes: LOCAL_DATA },
    streaming: true, oauth: false,
    connect_hint: 'Set CHE_OLLAMA_URL to an HTTPS URL for your own Ollama server (for example through a Cloudflare Tunnel). Optional CHE_OLLAMA_TOKEN.',
  },
  {
    id: 'omniroute', name: 'OmniRoute Coding', family: 'omniroute',
    auth: { type: 'none', url_secret: 'CHE_OMNIROUTE_URL', optional_secrets: ['CHE_OMNIROUTE_KEY', 'OMNIROUTE_API_KEY'] },
    api_base: 'env:CHE_OMNIROUTE_URL', chat_path: '/v1/chat/completions',
    discovery: { method: 'none' }, locality: 'cloud',
    // Deliberately advertise coding only so normal CHE chat keeps its existing
    // router. The gateway may still be used as a last-resort fallback.
    capabilities: ['coding'],
    cost_class: 'free', latency_class: 'fast', context_tokens: 128000,
    // OmniRoute can fan out to multiple upstream providers, so personal/private
    // CHE memory is withheld by default. The owner can explicitly relax this.
    privacy: { retention: 'provider_policy', trains_on_data: false, default_data_classes: ['public'] },
    streaming: true, oauth: false,
    connect_hint: 'Set CHE_OMNIROUTE_URL to an HTTPS-reachable OmniRoute server. Optional CHE_OMNIROUTE_KEY. Keep OmniRoute freeAccessPolicy=strict for CHE\'s $0 mode.',
  },
  ...[
    ['groq', 'Groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1', 'instant'],
    ['cerebras', 'Cerebras', 'CEREBRAS_API_KEY', 'https://api.cerebras.ai/v1', 'instant'],
    ['mistral', 'Mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1', 'fast'],
    ['github', 'GitHub Models', 'GITHUB_MODELS_TOKEN', 'https://models.github.ai/inference', 'fast'],
    ['sambanova', 'SambaNova', 'SAMBANOVA_API_KEY', 'https://api.sambanova.ai/v1', 'fast'],
    ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1', 'fast'],
  ].map(([id, name, secret, base, latency]) => ({
    id, name, family: id,
    auth: { type: 'api_key', secrets: [secret] },
    api_base: base, chat_path: '/chat/completions',
    discovery: { method: id === 'github' ? 'static' : 'openai_models', path: '/models' }, locality: 'cloud',
    capabilities: ['text', 'fast_chat', 'coding', 'deep_reasoning'],
    cost_class: 'free', latency_class: latency, context_tokens: 128000,
    privacy: { retention: 'provider_policy', trains_on_data: false, default_data_classes: HOSTED_DATA },
    streaming: true, oauth: false,
    connect_hint: `Add ${secret} as a Worker/GitHub secret.`,
  })),
];

function clip(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString().replace(/\/+$/, '') : '';
  } catch (_) {
    return '';
  }
}

// ─── Manifest validation (future-provider plugin standard) ─────────────────

const ID_RE = /^[a-z][a-z0-9_-]{1,40}$/;
const SECRET_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

// Validates a declarative provider manifest. Rejects anything that tries to
// ship executable code, non-HTTPS endpoints or inline credentials.
export function validateProviderManifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['Manifest must be a JSON object.'] };
  const text = JSON.stringify(raw);
  if (text.length > 20000) errors.push('Manifest is too large.');
  for (const forbidden of ['code', 'script', 'js', 'wasm', 'binary', 'executable', 'install_command']) {
    if (Object.hasOwn(raw, forbidden)) errors.push(`Executable field "${forbidden}" is not allowed; provider plugins are data only.`);
  }
  if (/\b(?:sk-[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,})/.test(text)) {
    errors.push('Manifest appears to contain a credential. Store credentials as server secrets, never in manifests.');
  }
  const id = clip(raw.id, 41).toLowerCase();
  if (!ID_RE.test(id)) errors.push('Provider id must be lowercase letters, numbers, - or _.');
  const authType = clip(raw.auth?.type, 20);
  if (!AUTH_TYPES.includes(authType)) errors.push(`auth.type must be one of ${AUTH_TYPES.join(', ')}.`);
  const secrets = Array.isArray(raw.auth?.secrets) ? raw.auth.secrets.map((item) => clip(item, 64)) : [];
  if (authType === 'api_key' && (!secrets.length || !secrets.every((item) => SECRET_RE.test(item)))) {
    errors.push('api_key providers must name their server secret(s), e.g. ["NEWAI_API_KEY"].');
  }
  const apiBase = httpsUrl(raw.api_base);
  if (!apiBase) errors.push('api_base must be an https:// URL.');
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter((item) => CAPABILITIES.includes(item)) : [];
  if (!capabilities.length) errors.push(`Declare at least one supported capability: ${CAPABILITIES.join(', ')}.`);
  const discovery = clip(raw.discovery?.method || 'none', 30);
  if (!DISCOVERY_METHODS.includes(discovery)) errors.push(`discovery.method must be one of ${DISCOVERY_METHODS.join(', ')}.`);
  const format = clip(raw.request_format || 'openai_chat', 30);
  if (!['openai_chat'].includes(format)) errors.push('Only the openai_chat request translation is supported without a core-code review.');
  if (errors.length) return { errors };
  const manifest = {
    id,
    name: clip(raw.name || id, 80),
    family: clip(raw.family || id, 40).toLowerCase(),
    auth: {
      type: authType,
      secrets,
      oauth_authorize_url: authType === 'oauth' ? httpsUrl(raw.auth?.oauth_authorize_url) : '',
    },
    api_base: apiBase,
    chat_path: /^\/[A-Za-z0-9/_.-]{1,80}$/.test(String(raw.chat_path || '')) ? raw.chat_path : '/chat/completions',
    discovery: { method: discovery, path: /^\/[A-Za-z0-9/_.-]{1,80}$/.test(String(raw.discovery?.path || '')) ? raw.discovery.path : '/models' },
    request_format: format,
    locality: raw.locality === 'local' ? 'local' : 'cloud',
    capabilities,
    cost_class: COST_CLASSES.includes(raw.cost_class) ? raw.cost_class : 'medium',
    latency_class: LATENCY_CLASSES.includes(raw.latency_class) ? raw.latency_class : 'medium',
    context_tokens: Math.max(1024, Math.min(10_000_000, Number(raw.context_tokens) || 32000)),
    rate_limits: raw.rate_limits && typeof raw.rate_limits === 'object' ? {
      requests_per_minute: Number(raw.rate_limits.requests_per_minute) || null,
      tokens_per_minute: Number(raw.rate_limits.tokens_per_minute) || null,
    } : null,
    errors: {
      rate_limit_status: [429],
      quota_patterns: Array.isArray(raw.errors?.quota_patterns) ? raw.errors.quota_patterns.map((item) => clip(item, 60)).slice(0, 8) : ['quota', 'rate limit'],
    },
    health_check: { method: 'discovery' },
    cost: raw.cost && typeof raw.cost === 'object' ? {
      input_per_mtok_usd: Number(raw.cost.input_per_mtok_usd) || null,
      output_per_mtok_usd: Number(raw.cost.output_per_mtok_usd) || null,
    } : null,
    privacy: {
      retention: clip(raw.privacy?.retention || 'provider_policy', 60),
      trains_on_data: raw.privacy?.trains_on_data === true,
      // A new provider starts with public context only until the owner grants more.
      default_data_classes: ['public'],
    },
    streaming: raw.streaming === true,
    oauth: authType === 'oauth',
    connect_hint: clip(raw.connect_hint, 300) || (secrets.length ? `Add ${secrets.join(' or ')} as a server secret.` : 'Owner authorization required.'),
    plugin: true,
  };
  return { manifest };
}

// ─── Registry state (lives in the owner's Durable Object data) ─────────────

export function ensureAiState(data) {
  const ai = data.ai_layer && typeof data.ai_layer === 'object' ? data.ai_layer : {};
  ai.provider_plugins = Array.isArray(ai.provider_plugins) ? ai.provider_plugins : [];
  ai.pending_provider_plugins = Array.isArray(ai.pending_provider_plugins) ? ai.pending_provider_plugins : [];
  ai.authorized_providers = ai.authorized_providers && typeof ai.authorized_providers === 'object' ? ai.authorized_providers : {};
  ai.catalog = ai.catalog && typeof ai.catalog === 'object' ? ai.catalog : {};
  ai.candidates = Array.isArray(ai.candidates) ? ai.candidates : [];
  ai.evaluations = Array.isArray(ai.evaluations) ? ai.evaluations : [];
  ai.health = ai.health && typeof ai.health === 'object' ? ai.health : {};
  ai.privacy = ai.privacy && typeof ai.privacy === 'object' ? ai.privacy : {};
  ai.policy = {
    auto_promote_models: true,
    max_cost_class: 'high',
    cross_check: 'auto',
    local_only: false,
    preferred_provider: '',
    preferred_model: '',
    ...(ai.policy && typeof ai.policy === 'object' ? ai.policy : {}),
  };
  ai.pending_confirmation = ai.pending_confirmation && typeof ai.pending_confirmation === 'object' ? ai.pending_confirmation : null;
  ai.watcher = ai.watcher && typeof ai.watcher === 'object' ? ai.watcher : { last_run_at: 0, runs: 0 };
  ai.notices = Array.isArray(ai.notices) ? ai.notices.slice(0, 30) : [];
  data.ai_layer = ai;
  return ai;
}

export function allManifests(data) {
  const ai = data ? ensureAiState(data) : null;
  const installed = ai ? ai.provider_plugins : [];
  const builtinIds = new Set(BUILTIN_PROVIDER_MANIFESTS.map((item) => item.id));
  return [...BUILTIN_PROVIDER_MANIFESTS, ...installed.filter((item) => !builtinIds.has(item.id))];
}

export function manifestById(data, id) {
  return allManifests(data).find((item) => item.id === String(id || '').toLowerCase()) || null;
}

// Server-side: the real secret value for a provider (never leaves the Worker).
export function providerCredential(env, manifest) {
  for (const name of manifest?.auth?.secrets || []) {
    if (env?.[name]) return String(env[name]);
  }
  return '';
}

export function providerBaseUrl(env, manifest) {
  if (!manifest) return '';
  if (manifest.api_base.startsWith('env:')) return httpsUrl(env?.[manifest.api_base.slice(4)]);
  return manifest.api_base;
}

// Whether CHE may call this provider now. Built-in providers are authorized
// by the owner adding their server secret; plugin providers additionally need
// explicit owner authorization in CHE.
export function providerConnection(env, data, manifest) {
  const ai = data ? ensureAiState(data) : null;
  let credential = false;
  if (manifest.auth.type === 'binding') credential = Boolean(env?.[manifest.auth.binding]);
  else if (manifest.auth.type === 'none') credential = Boolean(providerBaseUrl(env, manifest));
  else credential = Boolean(providerCredential(env, manifest));
  const ownerAuthorized = !manifest.plugin || Boolean(ai?.authorized_providers?.[manifest.id]);
  const state = credential && ownerAuthorized
    ? 'connected'
    : credential && !ownerAuthorized
      ? 'awaiting_owner_authorization'
      : 'available_to_connect';
  return { credential_configured: credential, owner_authorized: ownerAuthorized, state };
}

export function isProviderUsable(env, data, providerId) {
  const manifest = manifestById(data, providerId);
  return Boolean(manifest && providerConnection(env, data, manifest).state === 'connected');
}

// Normalized model record: one shape for every provider and model.
export function normalizeModelRecord(manifest, raw = {}) {
  const id = clip(raw.id || raw.name || raw.model, 160);
  const lower = id.toLowerCase();
  const inferred = new Set(['text']);
  if (/mini|flash|lite|haiku|small|8b|fast|instant|nano/.test(lower)) inferred.add('fast_chat');
  if (/reason|think|o[1-9]|r1|pro|opus|large|70b|120b|405b|grok-[4-9]|sonnet|strong/.test(lower)) inferred.add('deep_reasoning');
  if (/code|coder|codestral|devstral|grok-code/.test(lower)) inferred.add('coding');
  if (/vision|vl\b|-vl|image|4o|gemini|grok-[2-9].*vision|pixtral/.test(lower)) inferred.add('vision');
  if (/embed/.test(lower)) { inferred.clear(); inferred.add('embeddings'); }
  if (/whisper|transcribe|stt/.test(lower)) { inferred.clear(); inferred.add('speech_to_text'); }
  if (/tts|speech|voice/.test(lower) && !/transcribe/.test(lower)) { inferred.clear(); inferred.add('text_to_speech'); }
  if (/dall-e|imagen|flux|image-gen|grok-2-image|gpt-image|stable-diffusion/.test(lower)) { inferred.clear(); inferred.add('image_generation'); }
  if (/video|sora|veo/.test(lower)) { inferred.clear(); inferred.add('video_generation'); }
  const declared = Array.isArray(raw.capabilities) ? raw.capabilities.filter((item) => CAPABILITIES.includes(item)) : [];
  const allowed = new Set(manifest.capabilities);
  const capabilities = [...new Set([...declared, ...inferred])].filter((item) => allowed.has(item) || item === 'text');
  const context = Number(raw.context_window || raw.context_length || raw.input_token_limit || 0) || manifest.context_tokens;
  if (context >= 128000 && allowed.has('long_context') && capabilities.includes('text')) capabilities.push('long_context');
  if (allowed.has('tool_calling') && capabilities.includes('text') && !/embed|whisper|tts|image|video/.test(lower)) capabilities.push('tool_calling');
  return {
    key: `${manifest.id}:${id}`,
    provider: manifest.id,
    family: manifest.family,
    model: id,
    capabilities: [...new Set(capabilities)],
    cost_class: raw.cost_class && COST_CLASSES.includes(raw.cost_class) ? raw.cost_class : manifest.cost_class,
    latency_class: /mini|flash|lite|haiku|8b|instant|nano|fast/.test(lower) ? 'fast' : manifest.latency_class,
    context_tokens: context,
    locality: manifest.locality,
    rate_limits: manifest.rate_limits || null,
    privacy: { trains_on_data: manifest.privacy.trains_on_data, retention: manifest.privacy.retention },
    created: Number(raw.created) || null,
    status: raw.status || 'active',
  };
}

// Owner-facing registry view. Never includes credential values.
export function registryView(env, data) {
  const ai = ensureAiState(data);
  return allManifests(data).map((manifest) => {
    const connection = providerConnection(env, data, manifest);
    const catalog = ai.catalog[manifest.id]?.models || [];
    return {
      id: manifest.id,
      name: manifest.name,
      family: manifest.family,
      locality: manifest.locality,
      auth_type: manifest.auth.type,
      oauth_supported: manifest.oauth,
      capabilities: manifest.capabilities,
      cost_class: manifest.cost_class,
      latency_class: manifest.latency_class,
      context_tokens: manifest.context_tokens,
      privacy: {
        trains_on_data: manifest.privacy.trains_on_data,
        retention: manifest.privacy.retention,
        allowed_data_classes: ai.privacy[manifest.id]?.allowed || manifest.privacy.default_data_classes,
      },
      ...connection,
      required_secrets: manifest.auth.secrets || (manifest.auth.url_secret ? [manifest.auth.url_secret] : []),
      connect_hint: manifest.connect_hint,
      health: ai.health[manifest.id] ? healthSummary(ai.health[manifest.id]) : null,
      models: catalog.filter((item) => item.status === 'active').length,
      plugin: Boolean(manifest.plugin),
    };
  });
}

// Provider Accounts view for the app. Honest states only: CHE never creates
// accounts or claims a connection it cannot see.
export function accountsView(env, data) {
  return registryView(env, data).map((item) => ({
    id: item.id,
    name: item.name,
    state: item.state,
    connected: item.state === 'connected',
    auth_type: item.auth_type,
    oauth_supported: item.oauth_supported,
    how_to_connect: item.state === 'connected' ? '' : item.connect_hint,
    required_secrets: item.required_secrets,
  }));
}

export function healthSummary(record) {
  const calls = Number(record.success || 0) + Number(record.failure || 0);
  return {
    score: Number(record.score ?? 1),
    success_rate: calls ? Number((record.success / calls).toFixed(3)) : null,
    avg_latency_ms: record.latency_count ? Math.round(record.latency_total / record.latency_count) : null,
    rate_limited: Number(record.rate_limited || 0),
    timeouts: Number(record.timeouts || 0),
    quota_exhausted: Boolean(record.quota_until && record.quota_until > Date.now()),
    recent_failures: Array.isArray(record.recent_errors) ? record.recent_errors.length : 0,
    last_ok_at: record.last_ok_at || null,
    last_error_at: record.last_error_at || null,
  };
}

// ─── Provider plugin install (reviewed, owner-approved) ────────────────────

export function proposeProviderPlugin(data, raw) {
  const { manifest, errors } = validateProviderManifest(raw);
  if (errors) return { error: errors.join(' ') };
  if (BUILTIN_PROVIDER_MANIFESTS.some((item) => item.id === manifest.id)) {
    return { error: `${manifest.id} is a built-in provider; connect it with its server secret instead.` };
  }
  const ai = ensureAiState(data);
  const pending = {
    id: crypto.randomUUID(),
    manifest,
    status: 'pending_owner_review',
    review: [
      'Data-only manifest validated: no executable code, HTTPS only, no inline credentials.',
      `Will request ${manifest.capabilities.join(', ')}.`,
      `Starts with public data only; credential ${manifest.auth.secrets.join(' / ') || '(none)'} must be added server-side.`,
    ],
    created_at: new Date().toISOString(),
  };
  ai.pending_provider_plugins = [pending, ...ai.pending_provider_plugins.filter((item) => item.manifest.id !== manifest.id)].slice(0, 20);
  return { pending };
}

export function approveProviderPlugin(data, pendingId, ownerApproved) {
  if (ownerApproved !== true) return { error: 'Owner approval is required to install a provider adapter.' };
  const ai = ensureAiState(data);
  const pending = ai.pending_provider_plugins.find((item) => item.id === pendingId);
  if (!pending) return { error: 'Provider adapter proposal not found.' };
  ai.provider_plugins = [pending.manifest, ...ai.provider_plugins.filter((item) => item.id !== pending.manifest.id)].slice(0, 40);
  ai.pending_provider_plugins = ai.pending_provider_plugins.filter((item) => item.id !== pendingId);
  return { installed: pending.manifest };
}

export function authorizeProvider(data, providerId, ownerApproved) {
  if (ownerApproved !== true) return { error: 'The owner must authorize this provider.' };
  const ai = ensureAiState(data);
  if (!manifestById(data, providerId)) return { error: 'Unknown provider.' };
  ai.authorized_providers[providerId] = { at: new Date().toISOString() };
  return { authorized: providerId };
}
