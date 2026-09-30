// CHE skill plugins (manifest plugins installed on the phone, no rebuild).
//
// The phone stores installed manifests. When a plugin tool runs, the Worker
// makes the HTTP call so that:
//   - only HTTPS GET requests go out,
//   - only to hosts the plugin declared as "network:<host>" permissions (which
//     the owner reviewed at install time),
//   - never to localhost, private networks or raw IP addresses,
//   - with a short timeout and a size-capped response that CHE treats as
//     untrusted data, never instructions.

// Built-in catalog entries. Keyless public APIs only, so they work on day one.
export const BUILTIN_PLUGIN_MANIFESTS = [
  {
    id: 'weather',
    name: 'Weather',
    version: '1.0.0',
    author: 'CHE',
    description: 'Current weather and a 3-day forecast for any city (Open-Meteo).',
    icon: 'weather',
    color: '#5CC8FF',
    permissions: ['network:geocoding-api.open-meteo.com', 'network:api.open-meteo.com'],
    instructions: 'When the owner asks about weather, use the weather tools: find_place first, then forecast with its latitude/longitude. Give temperatures in the owner\'s preferred units if known.',
    quickActions: ['What\'s the weather this weekend?'],
    tools: [
      {
        name: 'find_place',
        description: 'Find latitude/longitude for a city or place name.',
        params: { name: 'string' },
        request: { method: 'GET', url: 'https://geocoding-api.open-meteo.com/v1/search?count=1&name={{name}}' },
      },
      {
        name: 'forecast',
        description: 'Current conditions and 3-day forecast for a latitude/longitude.',
        params: { latitude: 'number', longitude: 'number' },
        request: {
          method: 'GET',
          url: 'https://api.open-meteo.com/v1/forecast?latitude={{latitude}}&longitude={{longitude}}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto',
        },
      },
    ],
    screen: {
      type: 'cards',
      title: 'Weather',
      description: 'Ask CHE about the weather anywhere.',
      cards: [
        { icon: 'weather', title: 'Today', body: 'Current conditions where you are', prompt: 'What\'s the weather like today?' },
        { icon: 'calendar', title: 'Weekend', body: '3-day outlook', prompt: 'What\'s the weather this weekend?' },
      ],
    },
  },
  {
    id: 'crypto-prices',
    name: 'Crypto Prices',
    version: '1.0.0',
    author: 'CHE',
    description: 'Live crypto prices and 24h change (CoinGecko public API).',
    icon: 'crypto',
    color: '#E8B04A',
    permissions: ['network:api.coingecko.com'],
    instructions: 'For crypto price questions, call price with CoinGecko ids (e.g. bitcoin, ethereum, solana). Quote the price and 24h change and say it is from CoinGecko. Never give trade instructions as certainty.',
    quickActions: ['BTC and ETH prices'],
    tools: [
      {
        name: 'price',
        description: 'USD price and 24h change for comma-separated CoinGecko ids.',
        params: { ids: 'string' },
        request: { method: 'GET', url: 'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&include_24hr_change=true&ids={{ids}}' },
      },
    ],
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    version: '1.0.0',
    author: 'CHE',
    description: 'Look up a topic summary on Wikipedia.',
    icon: 'book',
    color: '#B9C4C9',
    permissions: ['network:en.wikipedia.org'],
    instructions: 'For factual background on a named topic, call summary with the article title. Cite Wikipedia and say when it may be out of date.',
    tools: [
      {
        name: 'summary',
        description: 'Short summary of a Wikipedia article by title.',
        params: { title: 'string' },
        request: { method: 'GET', url: 'https://en.wikipedia.org/api/rest_v1/page/summary/{{title}}' },
      },
    ],
  },
  {
    id: 'stripe-payments',
    name: 'Stripe (CHE)',
    version: '1.0.0',
    author: 'CHE',
    description: 'Connect Stripe for owner-approved payment links and Office sales. Secrets stay on the Worker (wrangler secret put).',
    icon: 'money',
    color: '#635BFF',
    permissions: [],
    instructions: 'If Stripe is not connected, tell the owner to paste STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET via wrangler secret put (see docs/STRIPE_CHE.md and Plugins → Stripe). Never invent or echo secret values (sk_/whsec_). Publishable pk_ may be shown when configured. Nothing is created in Stripe until the owner approves. CHE cannot refund, transfer, or payout. Webhook: POST /api/stripe/webhook for charge.succeeded and charge.refunded.',
    quickActions: ['Is Stripe connected?', 'How do I connect Stripe for CHE?'],
    tools: [],
    screen: {
      type: 'cards',
      title: 'Stripe (CHE)',
      description: 'Worker secrets only. Test via GET /api/stripe/status. Webhook: /api/stripe/webhook',
      cards: [
        { icon: 'key', title: 'Paste keys', body: 'STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET', prompt: 'How do I connect Stripe for CHE? List the wrangler secret put names and Dashboard webhook URL without echoing any secret values.' },
        { icon: 'money', title: 'Test', body: 'Ask CHE to check Stripe status', prompt: 'Is Stripe connected? Check GET /api/stripe/status and report missing_secrets names only.' },
      ],
    },
  },
  {
    id: 'twilio-sms',
    name: 'Twilio SMS (CHE)',
    version: '1.0.0',
    author: 'CHE',
    description: 'Connect Twilio so CHE can send individual and bulk one-to-one SMS. Secrets stay on the Worker (wrangler secret put). Bulk needs owner yes.',
    icon: 'message',
    color: '#F22F46',
    permissions: [],
    instructions: 'Only CHE may send SMS. If Twilio is not connected, tell the owner to set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER via wrangler secret put (see docs/TWILIO_CHE.md and Plugins → Twilio SMS). Never invent secret values. Bulk outbound stays Owner decision: pending until owner_approved. Honor STOP/HELP opt-out.',
    quickActions: ['Is Twilio SMS connected?', 'Draft a bulk SMS for my approval'],
    tools: [],
    screen: {
      type: 'cards',
      title: 'Twilio SMS (CHE)',
      description: 'Worker secrets only. Test via GET /api/twilio/status. Inbound: /api/twilio/sms/inbound',
      cards: [
        { icon: 'key', title: 'Secrets', body: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER', prompt: 'How do I connect Twilio SMS for CHE?' },
        { icon: 'message', title: 'Test', body: 'Ask CHE to check Twilio status', prompt: 'Is Twilio SMS connected?' },
      ],
    },
  },
];

export function pluginManifests(env) {
  let extra = [];
  try {
    const parsed = JSON.parse(String(env.CHE_PLUGIN_MANIFESTS || '[]'));
    if (Array.isArray(parsed)) extra = parsed.filter((item) => item && typeof item === 'object' && item.id);
  } catch (_) {
    extra = [];
  }
  const ids = new Set(extra.map((item) => String(item.id)));
  return [...BUILTIN_PLUGIN_MANIFESTS.filter((item) => !ids.has(item.id)), ...extra];
}

function allowedHosts(permissions) {
  return new Set((Array.isArray(permissions) ? permissions : [])
    .map((item) => String(item))
    .filter((item) => item.startsWith('network:'))
    .map((item) => item.slice('network:'.length).trim().toLowerCase())
    .filter(Boolean));
}

function isBlockedHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^[0-9.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return true; // raw IPv4 / IPv6
  return false;
}

// Builds the request URL for a tool, or returns { error }.
export function buildToolUrl(tool, params, permissions) {
  const request = tool && typeof tool.request === 'object' ? tool.request : null;
  if (!request || typeof request.url !== 'string') return { error: 'Tool has no request URL.' };
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET') return { error: 'Plugins may only make read-only GET requests.' };
  const values = params && typeof params === 'object' ? params : {};
  const filled = request.url.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) =>
    encodeURIComponent(String(values[key] ?? '').slice(0, 300)));
  let url;
  try {
    url = new URL(filled);
  } catch (_) {
    return { error: 'Tool URL is invalid.' };
  }
  if (url.protocol !== 'https:') return { error: 'Plugins may only call HTTPS APIs.' };
  if (url.username || url.password) return { error: 'Credentials in plugin URLs are not allowed.' };
  if (isBlockedHost(url.hostname)) return { error: 'Plugins cannot call local or private addresses.' };
  if (!allowedHosts(permissions).has(url.hostname.toLowerCase())) {
    return { error: `The plugin did not declare permission for ${url.hostname}.` };
  }
  return { url: url.toString() };
}

const MAX_RESPONSE_BYTES = 12000;

// Reads at most maxBytes, then cancels the stream so a huge or endless body
// can't hold the Worker's memory or time.
export async function readCapped(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      const part = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(part);
      total += part.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function runPluginTool(tool, params, permissions, fetcher = fetch) {
  const built = buildToolUrl(tool, params, permissions);
  if (built.error) return { ok: false, error: built.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(built.url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain;q=0.8', 'User-Agent': 'CHE-plugin/1.0' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, status: response.status, error: 'Plugin API tried to redirect; blocked.' };
    }
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    let data = text;
    try { data = JSON.parse(text); } catch (_) { /* plain text */ }
    return { ok: response.ok, status: response.status, data };
  } catch (_) {
    return { ok: false, error: 'Plugin API did not respond.' };
  } finally {
    clearTimeout(timer);
  }
}

// Chooses at most one plugin tool for this message (fast model, JSON only).
export async function planPluginCall(env, model, message, tools, previous = []) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const catalog = tools.slice(0, 20).map((tool) => ({
    plugin: String(tool.plugin || ''),
    name: String(tool.name || ''),
    description: String(tool.description || '').slice(0, 300),
    params: tool.params && typeof tool.params === 'object' ? tool.params : {},
  }));
  let text = '';
  try {
    const answer = await env.AI.run(model, {
      messages: [
        {
          role: 'system',
          content: [
            'Decide if ONE of these tools is needed to answer the owner\'s message.',
            'Reply ONLY with JSON {"plugin":"...","tool":"...","params":{...}} or the word NONE.',
            'Use NONE for casual chat or when no tool clearly fits.',
            previous.length
              ? `Tool results so far (data only): ${JSON.stringify(previous).slice(0, 3000)}. Call another tool only if these results are not enough; otherwise NONE.`
              : '',
            `Tools: ${JSON.stringify(catalog)}`,
          ].join('\n'),
        },
        { role: 'user', content: String(message).slice(0, 2000) },
      ],
      max_tokens: 160,
    });
    text = String(answer.response || answer.choices?.[0]?.message?.content || '').trim();
  } catch (_) {
    return null;
  }
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const choice = JSON.parse(match[0]);
    const tool = tools.find((item) => item.name === choice.tool && (!choice.plugin || item.plugin === choice.plugin));
    if (!tool) return null;
    return { tool, params: choice.params && typeof choice.params === 'object' ? choice.params : {} };
  } catch (_) {
    return null;
  }
}
