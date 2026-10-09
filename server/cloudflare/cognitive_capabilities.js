// CHE cognitive capability discovery.
//
// The phone may send hints, but the Worker is authoritative: every turn is
// re-classified here so CHE can discover and use obvious capabilities without
// making the owner know model names, tools, or magic phrases.

import { buildCapabilityRegistry, CAPABILITY_CATALOG } from './che_maturity.js';
import { registryView } from './provider_registry.js';
import { vectorMemoryReadiness } from './vector_memory.js';

function text(value) {
  return String(value || '').toLowerCase();
}

function any(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

export function inferTurnCapabilities(message, attachment = null) {
  const value = text(message);
  const found = new Set();
  const add = (...ids) => ids.forEach((id) => found.add(id));

  if (any(value, [
    /\b(latest|current|recent|news|online)\b/,
    // "Today"/"right now" asks about the world ("who is president right
    // now?") unless the sentence is about the owner or CHE ("how are you
    // doing today?", "what should I eat tonight?").
    ...(/\b(i|i'm|im|me|my|mine|we|we're|us|our|let's|you|you're|your|yourself)\b/.test(value) ? [] : [/\b(today|tonight|this week|right now)\b/]),
    // With a world subject it is a lookup even in a personal sentence.
    /\b(today|tonight|this week|right now)\b[^.?!]{0,60}\b(weather|forecast|news|score|game|price|happen|event|open|closed|traffic|release|announce|election|stock|market|rate|playing|showing)/,
    /\b(weather|forecast|news|score|game|price|happen|event|open|closed|traffic|release|announce|election|stock|market|rate|playing|showing)\w*\b[^.?!]{0,60}\b(today|tonight|this week|right now)\b/,
    /\b(search|look up|find online|research|source|citation|verify|fact[- ]?check)\b/,
    /\bwhat happened\b/,
  ])) add('web_research');

  if (any(value, [
    /\b(verify|fact[- ]?check|cross[- ]?check|compare sources|double[- ]?check|is this true)\b/,
  ])) add('cross_reference', 'web_research');

  if (any(value, [
    /\b(generate|create|make|draw|render|design|visualize)\b[^.]{0,80}\b(image|picture|photo|art|mockup|graphic|diagram)\b/,
    /\b(image|picture|photo)\b[^.]{0,60}\b(generate|generation)\b/,
  ])) add('rendering', 'image_generation');

  if (any(value, [
    /\b(generate|create|make|render|animate)\b[^.]{0,80}\b(video|clip|animation)\b/,
    /\bvideo generation\b/,
  ])) add('video_generation');

  if (attachment || any(value, [
    /\b(this|attached|attachment)\b[^.]{0,40}\b(image|photo|picture|screenshot|video|audio|pdf|file|document)\b/,
    /\b(watch|listen to|read|analyze|understand|describe|summarize|paraphrase|transcribe)\b[^.]{0,60}\b(video|audio|photo|image|screenshot|pdf|file|document|clip)\b/,
  ])) add('multimodal');

  if (any(value, [/\b(screenshot|photo|image|picture)\b/]) && attachment) add('data_recognition');
  if (any(value, [/\b(pdf|document|table|spreadsheet)\b/]) && attachment) add('data_recognition');

  if (any(value, [
    /\b(stock|stocks|nasdaq|s&p|market|markets|trading|futures|\bnq\b|crypto|bitcoin|ethereum|price action)\b/,
  ])) add('market_data', 'web_research');

  if (any(value, [
    /\b(backtest|backtesting|historical test|strategy test|indicator|scanner)\b/,
  ])) add('backtesting');

  if (any(value, [
    /\b(change|redesign|modify|fix|update|refactor|implement|debug)\b[^.]{0,80}\b(che|your app|your code|ui|interface|screen|repo|repository)\b/,
    /\b(write|edit|review|proofread)\b[^.]{0,50}\bcode\b/,
  ])) add('self_development');

  if (any(value, [
    /\b(parallel|in parallel|batch|multitask|at the same time|simultaneously|background work|in the background|keep monitoring|keep watching|watch for|alert me|follow up|follow-up)\b/,
  ])) add('multitasking', 'speed_mode');

  if (any(value, [
    /\b(public records?|court records?|property records?|business filings?)\b/,
  ])) add('public_records', 'web_research');

  if (any(value, [
    /\b(fine[- ]?tun|train (?:a )?model|lora|adapter tuning)\b/,
  ])) add('fine_tuning');

  return [...found];
}

const PAID_PROVIDERS = new Set(['openai', 'xai', 'anthropic']);

function connectedProviders(env, data) {
  const paid = /^(?:1|true|yes)$/i.test(String(env?.CHE_ALLOW_PAID_AI || '').trim());
  return registryView(env, data)
    .filter((provider) => provider.state === 'connected')
    // Free engines only: a stored paid key does not make a capability available.
    .filter((provider) => paid || !PAID_PROVIDERS.has(String(provider.id).split(':')[0]))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      capabilities: provider.capabilities || [],
      health: provider.health || null,
      locality: provider.locality,
    }));
}

function missingPaidSwitch(env) {
  if (!/^(?:1|true|yes|on)$/i.test(String(env.CHE_ALLOW_PAID_MEDIA || '').trim())) return 'CHE_ALLOW_PAID_MEDIA';
  if (!/^(?:1|true|yes)$/i.test(String(env.CHE_ALLOW_PAID_AI || '').trim())) return 'CHE_ALLOW_PAID_AI';
  return '';
}

export function runtimeCapabilityRegistry(env, data = {}) {
  const providers = connectedProviders(env, data);
  const providerCaps = new Set(providers.flatMap((provider) => provider.capabilities));
  const providerIdsFor = (capability) => providers
    .filter((provider) => provider.capabilities.includes(capability))
    .map((provider) => provider.id);

  const hasText = Boolean(env.AI) || providerCaps.has('text');
  const hasVision = Boolean(env.CHE_MULTIMODAL_URL || env.GEMINI_API_KEY) || providerCaps.has('vision');
  const paidMedia = /^(?:1|true|yes|on)$/i.test(String(env.CHE_ALLOW_PAID_MEDIA || '').trim())
    && /^(?:1|true|yes)$/i.test(String(env.CHE_ALLOW_PAID_AI || '').trim());
  const hasImage = Boolean(
    env.CHE_IMAGE_GEN_URL ||
    env.AI ||
    (paidMedia && (
      env.GEMINI_API_KEY ||
      env.OPENAI_API_KEY ||
      env.CHE_OPENAI_API_KEY ||
      providerCaps.has('image_generation')
    ))
  );
  const hasVideo = Boolean(
    env.CHE_VIDEO_GEN_URL ||
    env.CHE_VIDEO_RENDER_URL ||
    (paidMedia && (
      env.GEMINI_API_KEY ||
      providerCaps.has('video_generation')
    ))
  );
  const vectorReady = vectorMemoryReadiness(env);
  const hasEmbedding = vectorReady.configured || providerCaps.has('embeddings');

  const runtime = {
    chat: { available: hasText, tool: 'model_router', providers: providers.filter((p) => p.capabilities.includes('text')).map((p) => p.id) },
    memory: { available: true, tool: 'durable_memory' },
    owner_memory: { available: true, tool: 'durable_memory' },
    semantic_memory: {
      available: hasEmbedding,
      configured: hasEmbedding,
      tool: 'vector_rag',
      limitations: hasEmbedding ? '' : 'Connect CHE_PGVECTOR_REST_URL + CHE_PGVECTOR_TOKEN and a Workers AI embedding engine.',
    },
    knowledge_graph: { available: true, tool: 'brain_graph' },
    files: { available: true, tool: 'che_library' },
    browser: { available: true, tool: 'che_browser' },
    web: { available: true, tool: 'public_research' },
    research: { available: true, tool: 'public_research' },
    live_retrieval: { available: true, tool: 'public_research' },
    vision: { available: hasVision, tool: 'multimodal', providers: providerIdsFor('vision') },
    multimodal: { available: hasVision || Boolean(env.CHE_MULTIMODAL_URL), tool: 'multimodal' },
    audio_understanding: { available: Boolean(env.GEMINI_API_KEY || env.CHE_MULTIMODAL_URL), tool: 'multimodal' },
    video_understanding: { available: Boolean(env.GEMINI_API_KEY || env.CHE_MULTIMODAL_URL), tool: 'multimodal' },
    document_understanding: { available: hasVision || Boolean(env.CHE_MULTIMODAL_URL), tool: 'multimodal' },
    image_generation: {
      available: hasImage,
      tool: 'media_generation',
      providers: providerIdsFor('image_generation'),
      limitations: !hasImage && (env.GEMINI_API_KEY || env.OPENAI_API_KEY || env.CHE_OPENAI_API_KEY)
        ? `Paid HD provider is connected but ${missingPaidSwitch(env)} is not owner-enabled.`
        : '',
    },
    video_generation: {
      available: hasVideo,
      tool: 'media_generation',
      providers: providerIdsFor('video_generation'),
      limitations: !hasVideo && env.GEMINI_API_KEY
        ? `Gemini Omni video is paid-tier only; enable ${missingPaidSwitch(env)} only after owner approval.`
        : '',
    },
    provider_routing: { available: true, tool: 'capability_router' },
    model_discovery: { available: true, tool: 'model_watcher' },
    cross_check: { available: providers.length >= 2, tool: 'model_panel', providers: providers.map((p) => p.id) },
    office: { available: true, tool: 'agent_runtime' },
    war_room: { available: true, tool: 'paired_agents' },
    plugins: { available: true, tool: 'plugin_runtime' },
    flagstaff: { available: true, tool: 'flagstaff' },
    background_jobs: { available: true, tool: 'durable_jobs' },
    self_development: { available: true, tool: 'draft_pr_pipeline', requires_owner_permission: true },
    notifications: { available: true, tool: 'ios_notifications' },
    local_inference: { available: Boolean(env.CHE_LOCAL_MODEL_URL), configured: Boolean(env.CHE_LOCAL_MODEL_URL), tool: 'local_model' },
    sms: { available: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN), configured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN), tool: 'twilio' },
    stripe: { available: Boolean(env.STRIPE_SECRET_KEY || env.CHE_PAYMENTS_URL), configured: Boolean(env.STRIPE_SECRET_KEY || env.CHE_PAYMENTS_URL), tool: 'stripe' },
  };

  const completeRuntime = Object.fromEntries(
    CAPABILITY_CATALOG.map((spec) => [
      spec.id,
      runtime[spec.id] || {
        available: false,
        configured: false,
        limitations: 'No active CHE runtime path is configured for this capability.',
      },
    ]),
  );

  return {
    capabilities: buildCapabilityRegistry(completeRuntime),
    providers,
    automatic_selection: true,
    owner_does_not_need_model_names: true,
    generated_at: new Date().toISOString(),
  };
}

export function capabilityPromptLine(registry) {
  const ready = (registry?.capabilities || [])
    .filter((item) => item.available)
    .map((item) => item.id);
  return [
    'CAPABILITY DISCOVERY: choose the appropriate available capability automatically; do not require the owner to know tool or model names.',
    `Available now: ${ready.join(', ') || 'none'}.`,
    `Connected model providers: ${(registry?.providers || []).map((p) => p.name).join(', ') || 'built-in routes only'}.`,
    'If a needed capability is unavailable, say exactly what dependency is missing rather than pretending it ran.',
  ].join(' ');
}
