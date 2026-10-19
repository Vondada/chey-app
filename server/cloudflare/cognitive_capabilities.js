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

// Measured misfires (2026-10-19, 923 owner sentences): each sent an ordinary turn to live research or an
// Office coworker, and so to the full ~33k-character prompt. Each is removed from the words a rule reads,
// never added to a rule, so a sentence that also asks for research or a coworker keeps it.
// The owner telling his own news: "I have good news: my baby was born", "Big news, sir: we closed".
// "Do you have news about the Fed?" and "any good news today?" still ask for news.
const OWNER_NEWS = /\b(?:i|we)(?:\s+have|\s*['’]ve|\s+got|\s*['’]ve\s+got|\s+have\s+got|\s+just\s+got)\s+(?:some\s+)?(?:(?:good|great|bad|big|exciting|sad|happy|wonderful|terrible|amazing|fantastic|awesome)\s+)?news\b|^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,\s]+)?(?:some\s+)?(?:good|great|bad|big|exciting|sad|happy|wonderful|terrible|amazing|fantastic|awesome)\s+news\s*(?:[:,!—–-]|(?:sir|che)\b)/g;
// An algorithm's name is not a request to search: "why does binary search return the wrong index".
// "search for binary search tutorials" and "look up how binary search works" still search.
const ALGORITHM_SEARCH = /\b(?:binary|linear|sequential|depth[- ]first|breadth[- ]first)\s+search(?:es|ing)?\b/g;

export function inferTurnCapabilities(message, attachment = null) {
  const value = text(message);
  const found = new Set();
  const add = (...ids) => ids.forEach((id) => found.add(id));
  const lookup = value.replace(OWNER_NEWS, ' ').replace(ALGORITHM_SEARCH, ' ');

  if (any(lookup, [
    /\b(latest|current|recent|news|online)\b/,
    // "Today"/"right now" asks about the world ("who is president right
    // now?") unless the sentence is about the owner or CHE ("how are you
    // doing today?", "what should I eat tonight?") or is one of his
    // reminders, alarms or timers ("make a reminder tomorrow at 8, not today").
    ...(/\b(i|i'm|im|me|my|mine|we|we're|us|our|let's|you|you're|your|yourself|remind|reminders?|alarms?|timers?)\b/.test(value) ? [] : [/\b(today|tonight|this week|right now)\b/]),
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
    // A video noun is the object: "make sure the mp4 plays", "my fishing
    // reel" and "a paper clip" are not video requests.
    /\b(generate|create|make(?!\s+sure)|render|animate|produce)\b[^.]{0,80}(?:\b(video|animation|mp4|(?:youtube|yt|faceless|instagram|tiktok)\s+(?:shorts?|reels?))\b|\b(?:a|an|instagram|facebook|youtube|tiktok)\s+reels?\b|(?<!\b(?:paper|hair|binder|money|tie|bulldog|chip|bag)\s)\bclips?\b)/,
    /\bvideo generation\b/,
    // "Use the free GitHub video renderer": the video renderer, never its tests.
    /\b(use|try|start)\b[^.]{0,40}\bvideo\s+renderer\b(?!\s+(?:tests?|code|bug))/,
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

// Story and marketing work for the Office's Story + Script and Marketing + Social partners (worker.js).
const CREATIVE_WORK = /\b(?:book|novel|movie|film|screenplay|script|episode|scene|story|character arc)\b/i;
const WRITING_ASK = /\b(?:write|draft|tell|create|make|compose|outline|imagine|invent|narrate|continue)\b/i;
// A story that is a report being asked about, not writing: "the biggest AI news story on October 15",
// "is the story about the new garage door code accurate?". With a writing verb it stays story work
// ("write a news story for my school paper").
const STORY_AS_REPORT = /\bnews\s+stor(?:y|ies)\b|\b(?:is|was|are|were)\s+(?:the|that|this|these|those)\s+stor(?:y|ies)\b(?=[^.?!]*\b(?:accurate|true|real|correct|right|legit|verified|fake|false)\b)/gi;
const MARKETING_WORK = /\b(?:marketing|social media|instagram|tiktok|facebook|youtube|campaign|content calendar|brand strategy|ad copy)\b/i;
// Opening the YouTube app is an app action, not marketing: "teach me recursion and then open youtube".
// "open YouTube Studio and check my analytics" is still marketing.
const OPEN_YOUTUBE_APP = /\b(?:open|launch|close)\s+(?:the\s+)?youtube(?:\s+app)?(?=\s*(?:$|[,.;!?]|(?:and|then|for\s+me|please|now)\b))/gi;

export function creativeWritingAsk(message) {
  const value = String(message || '');
  return CREATIVE_WORK.test(WRITING_ASK.test(value) ? value : value.replace(STORY_AS_REPORT, ' '));
}

export function marketingAsk(message) {
  return MARKETING_WORK.test(String(message || '').replace(OPEN_YOUTUBE_APP, ' '));
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
    (env.CHE_GITHUB_TOKEN && env.CHE_GITHUB_REPO === 'Vondada/chey-app') ||
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
