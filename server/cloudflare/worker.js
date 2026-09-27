// CHE cloud Agent. One SQLite-backed Durable Object holds paired devices and
// memories, so deployment does not require creating a separate database.
import { DurableObject } from 'cloudflare:workers';

const FAST_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const STRONG_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function digest(value) {
  const data = new TextEncoder().encode(value);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function bodyOf(request) {
  if (Number(request.headers.get('content-length') || 0) > 8_000_000) throw new Error('too_large');
  const raw = await request.text();
  if (raw.length > 8_000_000) throw new Error('too_large');
  const body = JSON.parse(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_json');
  return body;
}

function ndjsonReply(reply, meta = {}) {
  return new Response(
    JSON.stringify({ type: 'delta', delta: reply }) + '\n' +
      JSON.stringify({ type: 'done', ...meta }) + '\n',
    {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}

function formatClientTime(clientTime) {
  if (!clientTime || typeof clientTime !== 'object') return null;
  const raw = String(clientTime.local_iso || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw);
  if (!match) return null;

  const [, year, month, day, hourRaw, minute] = match;
  const hour = Number(hourRaw);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const displayHour = hour % 12 || 12;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const zone = String(clientTime.timezone_name || '').trim();
  return {
    display: `${displayHour}:${minute} ${ampm} on ${months[Number(month) - 1]} ${Number(day)}, ${year}${zone ? ` (${zone})` : ''}`,
    raw,
    zone,
    offsetMinutes: Number(clientTime.utc_offset_minutes || 0),
  };
}

function safePreferenceFrom(message) {
  const blocked = /password|passcode|security code|social security|credit card|medical|diagnos|religion|politic|party|vote|race|ethnic|sexual|criminal|address/i;
  if (blocked.test(message)) return null;

  let match = /\bmy favorite\s+([a-z][a-z\s]{1,30})\s+is\s+(.{1,100})$/i.exec(message.trim());
  if (match) {
    return `Favorite ${match[1].trim()}: ${match[2].trim().replace(/[.!?]+$/, '')}`;
  }

  match = /\bi prefer\s+(.{2,120})$/i.exec(message.trim());
  if (match) {
    return `Preference: ${match[1].trim().replace(/[.!?]+$/, '')}`;
  }

  return null;
}

async function optionalResearch(env, query) {
  if (!env.CHE_RESEARCH_URL) return null;
  let url;
  try {
    url = new URL(env.CHE_RESEARCH_URL);
  } catch (_) {
    return { error: 'Research connector URL is invalid.' };
  }
  if (url.protocol !== 'https:') {
    return { error: 'Research connector must use HTTPS.' };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (env.CHE_RESEARCH_TOKEN) {
      headers.Authorization = `Bearer ${env.CHE_RESEARCH_TOKEN}`;
    }
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: String(query || '').slice(0, 4000),
        purpose: 'CHE feasibility novelty and current-fact research',
      }),
    });
    if (!response.ok) {
      return { error: `Research connector returned ${response.status}.` };
    }
    const data = await response.json();
    const summary = String(
      data.summary || data.answer || data.text || '',
    ).trim().slice(0, 12000);
    const sources = Array.isArray(data.sources)
      ? data.sources.slice(0, 8).map((item) => String(item).slice(0, 500))
      : [];
    if (!summary) return { error: 'Research connector returned no usable summary.' };
    return { summary, sources };
  } catch (_) {
    return { error: 'Research connector was unavailable.' };
  }
}

async function optionalMultimodal(env, attachment, query) {
  if (!attachment || typeof attachment !== 'object') return null;
  if (!env.CHE_MULTIMODAL_URL) {
    return { error: 'Multimodal analyzer is not connected yet.' };
  }

  const name = String(attachment.name || 'attachment').slice(0, 160);
  const mediaType = String(attachment.media_type || 'document').slice(0, 32);
  const base64 = String(attachment.base64 || '');
  if (!base64 || base64.length > 7_200_000) {
    return { error: 'Attachment is empty or too large.' };
  }

  let url;
  try {
    url = new URL(env.CHE_MULTIMODAL_URL);
  } catch (_) {
    return { error: 'Multimodal connector URL is invalid.' };
  }
  if (url.protocol !== 'https:') {
    return { error: 'Multimodal connector must use HTTPS.' };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (env.CHE_MULTIMODAL_TOKEN) {
      headers.Authorization = `Bearer ${env.CHE_MULTIMODAL_TOKEN}`;
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: String(query || '').slice(0, 4000),
        attachment: { name, media_type: mediaType, base64 },
      }),
    });

    if (!response.ok) {
      return { error: `Multimodal connector returned ${response.status}.` };
    }

    const data = await response.json();
    const summary = String(
      data.summary || data.answer || data.text || data.result || '',
    ).trim().slice(0, 16000);

    return summary
      ? { summary, media_type: mediaType, name }
      : { error: 'Multimodal connector returned no usable analysis.' };
  } catch (_) {
    return { error: 'Multimodal connector was unavailable.' };
  }
}

async function optionalMediaGeneration(env, kind, prompt) {
  const isVideo = kind === 'video';
  const urlValue = isVideo ? env.CHE_VIDEO_GEN_URL : env.CHE_IMAGE_GEN_URL;
  const tokenValue = isVideo ? env.CHE_VIDEO_GEN_TOKEN : env.CHE_IMAGE_GEN_TOKEN;
  if (!urlValue) return null;

  let url;
  try {
    url = new URL(urlValue);
  } catch (_) {
    return { error: `${kind} generator URL is invalid.` };
  }
  if (url.protocol !== 'https:') {
    return { error: `${kind} generator must use HTTPS.` };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: String(prompt || '').slice(0, 5000),
        type: kind,
      }),
    });

    if (!response.ok) {
      return { error: `${kind} generator returned ${response.status}.` };
    }

    const data = await response.json();
    const mediaUrl = String(
      data.url || data.output_url || data.image_url || data.video_url || '',
    ).trim();

    const status = String(data.status || '').trim();
    const jobId = String(data.job_id || data.id || '').trim();

    if (mediaUrl) return { url: mediaUrl, kind };
    if (jobId) return { job_id: jobId, status: status || 'submitted', kind };
    return { error: `${kind} generator returned no media URL or job ID.` };
  } catch (_) {
    return { error: `${kind} generator was unavailable.` };
  }
}


async function optionalModelGateway(urlValue, tokenValue, provider, query) {
  if (!urlValue) return null;
  let url;
  try {
    url = new URL(urlValue);
  } catch (_) {
    return { provider, error: 'invalid connector URL' };
  }
  if (url.protocol !== 'https:') {
    return { provider, error: 'connector must use HTTPS' };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: String(query || '').slice(0, 8000),
        mode: 'answer',
      }),
    });

    if (!response.ok) {
      return { provider, error: `connector returned ${response.status}` };
    }

    const data = await response.json();
    const answer = String(
      data.answer || data.response || data.text || data.output || '',
    ).trim().slice(0, 12000);

    return answer
      ? { provider, answer }
      : { provider, error: 'connector returned no answer' };
  } catch (_) {
    return { provider, error: 'connector unavailable' };
  }
}

async function modelPanel(env, query) {
  const connectors = [
    ['OpenAI', env.CHE_OPENAI_MODEL_URL, env.CHE_OPENAI_MODEL_TOKEN],
    ['Anthropic', env.CHE_ANTHROPIC_MODEL_URL, env.CHE_ANTHROPIC_MODEL_TOKEN],
    ['xAI', env.CHE_XAI_MODEL_URL, env.CHE_XAI_MODEL_TOKEN],
    ['DeepSeek', env.CHE_DEEPSEEK_MODEL_URL, env.CHE_DEEPSEEK_MODEL_TOKEN],
    ['GitHub Copilot', env.CHE_COPILOT_MODEL_URL, env.CHE_COPILOT_MODEL_TOKEN],
  ].filter((item) => Boolean(item[1]));

  if (!connectors.length) return [];

  const results = await Promise.all(
    connectors.map(([provider, url, token]) =>
      optionalModelGateway(url, token, provider, query),
    ),
  );

  return results.filter(Boolean);
}

async function generateMedia(env, kind, prompt) {
  const image = kind === 'image';
  const urlValue = image ? env.CHE_IMAGE_GEN_URL : env.CHE_VIDEO_GEN_URL;
  const tokenValue = image ? env.CHE_IMAGE_GEN_TOKEN : env.CHE_VIDEO_GEN_TOKEN;
  if (!urlValue) {
    return { error: `${image ? 'Image' : 'Video'} generation is not connected yet.` };
  }

  let url;
  try {
    url = new URL(urlValue);
  } catch (_) {
    return { error: 'Media connector URL is invalid.' };
  }
  if (url.protocol !== 'https:') {
    return { error: 'Media connector must use HTTPS.' };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: String(prompt || '').slice(0, 5000),
        type: kind,
      }),
    });

    if (!response.ok) {
      return { error: `Media connector returned ${response.status}.` };
    }

    const data = await response.json();
    const assetUrl = String(
      data.asset_url || data.url || data.output_url || '',
    ).trim();

    return assetUrl
      ? { asset_url: assetUrl, kind }
      : { error: 'Media connector returned no asset URL.' };
  } catch (_) {
    return { error: 'Media connector was unavailable.' };
  }
}

function storageReadiness(env) {
  return {
    core_memory: true,
    object_store: Boolean(env.CHE_DATA_BUCKET),
    multimodal_archive: Boolean(env.CHE_DATA_BUCKET),
    generated_media_archive: Boolean(env.CHE_DATA_BUCKET),
    provider_independent: true,
  };
}

async function dispatchChange(env, body) {
  const request = String(body.request || '').trim();
  if (request.length < 8 || request.length > 2000) return json({ detail: 'Describe one change in 8–2000 characters.' }, 400);
  if (!env.CHE_GITHUB_TOKEN || !env.CHE_GITHUB_REPO || !env.CHE_CHANGE_MODEL) {
    return json({ detail: 'Phone code proposals are not connected to GitHub yet.' }, 503);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.CHE_GITHUB_REPO) || !/^[\w.:-]+$/.test(env.CHE_CHANGE_MODEL)) {
    return json({ detail: 'Invalid GitHub or model configuration.' }, 503);
  }
  const response = await fetch(
    `https://api.github.com/repos/${env.CHE_GITHUB_REPO}/actions/workflows/che-propose.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CHE-Agent',
      },
      body: JSON.stringify({ ref: 'main', inputs: { request, model: env.CHE_CHANGE_MODEL } }),
    },
  );
  if (response.status !== 204) return json({ detail: `GitHub could not start the proposal (${response.status}).` }, 502);
  return json({ message: 'I started a code proposal, sir. Review its draft pull request on your phone. Merging it will start the cloud iPhone build.' });
}

export class CheState extends DurableObject {
  constructor(state, env) {
    super(state, env);
  }

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      const data = (await this.ctx.storage.get('che')) || {
        devices: {}, memories: [], failures: {},
      };
      const body = request.method === 'POST' ? await bodyOf(request) : {};
      if (request.method === 'POST' && path === '/api/pair') {
        const secret = this.env.CHE_PAIR_CODE;
        if (!secret || !/^\d{6,12}$/.test(secret)) return json({ detail: 'Set CHE_PAIR_CODE as a server secret.' }, 503);
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const recent = (data.failures[ip] || []).filter((at) => at > Date.now() - 900_000);
        if (recent.length >= 5) return json({ detail: 'Too many attempts. Wait 15 minutes.' }, 429);
        const code = String(body.code || '');
        if ((await digest(code)) !== (await digest(secret))) {
          data.failures[ip] = [...recent, Date.now()];
          await this.ctx.storage.put('che', data);
          return json({ detail: 'Incorrect pairing code.' }, 403);
        }
        const raw = Array.from(crypto.getRandomValues(new Uint8Array(48)),
          (b) => b.toString(16).padStart(2, '0')).join('');
        data.devices[await digest(raw)] = String(body.device_name || 'CHE phone').slice(0, 80);
        delete data.failures[ip];
        await this.ctx.storage.put('che', data);
        return json({ device_token: raw });
      }

      const authorization = request.headers.get('Authorization') || '';
      const match = /^Bearer ([A-Za-z0-9_-]{40,160})$/.exec(authorization);
      const tokenHash = match ? await digest(match[1]) : '';
      if (!Object.hasOwn(data.devices, tokenHash)) return json({ detail: 'Pair your phone to CHE.' }, 401);

      if (request.method === 'GET' && path === '/api/state') {
        return json({
          memories: data.memories,
          personality: data.personality || [],
          learned_knowledge: data.learned_knowledge || [],
          suggestions: data.suggestions || [],
          storage: storageReadiness(this.env),
          integrations: {
            storage_vault: Boolean(this.env.CHE_DATA_BUCKET),
            web_research: Boolean(this.env.CHE_RESEARCH_URL),
            public_records: Boolean(this.env.CHE_PUBLIC_RECORDS_URL),
            music: Boolean(this.env.CHE_MUSIC_URL),
            windows: Boolean(this.env.CHE_WINDOWS_URL),
            car: Boolean(this.env.CHE_CAR_URL),
            smart_home: Boolean(this.env.CHE_SMART_HOME_URL),
            rendering: Boolean(this.env.CHE_RENDER_URL),
            image_generation: Boolean(this.env.CHE_IMAGE_GEN_URL),
            video_generation: Boolean(this.env.CHE_VIDEO_GEN_URL),
            model_panel: Boolean(
              this.env.CHE_OPENAI_MODEL_URL ||
              this.env.CHE_ANTHROPIC_MODEL_URL ||
              this.env.CHE_XAI_MODEL_URL ||
              this.env.CHE_DEEPSEEK_MODEL_URL ||
              this.env.CHE_COPILOT_MODEL_URL
            ),
            screen_capture: Boolean(this.env.CHE_SCREEN_URL),
            face_verify: Boolean(this.env.CHE_FACE_VERIFY_URL),
            data_recognition: Boolean(this.env.CHE_DATA_RECOGNITION_URL),
            multimodal: Boolean(this.env.CHE_MULTIMODAL_URL),
            market_data: Boolean(this.env.CHE_MARKET_DATA_URL),
            backtesting: Boolean(this.env.CHE_BACKTEST_URL),
            broker: Boolean(this.env.CHE_BROKER_URL),
            prop_firm: Boolean(this.env.CHE_PROP_FIRM_URL),
            business: Boolean(this.env.CHE_BUSINESS_URL),
            payments: Boolean(this.env.CHE_PAYMENTS_URL),
            leads: Boolean(this.env.CHE_LEADS_URL),
          },
        });
      }
      if (request.method === 'GET' && path === '/api/storage/status') {
        return json(storageReadiness(this.env));
      }
      if (request.method !== 'POST') return json({ detail: 'Not found.' }, 404);
      if (path === '/api/security/revoke_self') {
        delete data.devices[tokenHash];
        await this.ctx.storage.put('che', data);
        return json({ ok: true });
      }
      if (path === '/api/memory/add') {
        const memory = String(body.memory || '').trim().slice(0, 500);
        if (!memory || /password|passcode|security code|social security|credit card/i.test(memory)) {
          return json({ detail: 'Choose a non-sensitive memory.' }, 400);
        }
        if (!data.memories.some((item) => item.toLowerCase() === memory.toLowerCase())) {
          data.memories.push(memory);
          data.memories = data.memories.slice(-100);
          await this.ctx.storage.put('che', data);
        }
        return json({ ok: true });
      }
      if (path === '/api/memory/delete') {
        const index = Number(body.index);
        if (!Number.isInteger(index) || index < 0 || index >= data.memories.length) {
          return json({ detail: 'Memory not found.' }, 400);
        }
        data.memories.splice(index, 1);
        await this.ctx.storage.put('che', data);
        return json({ ok: true });
      }
      if (path === '/api/memory/clear') {
        data.memories = [];
        await this.ctx.storage.put('che', data);
        return json({ ok: true });
      }
      if (path === '/api/proactive/check') {
        const clientClock = formatClientTime(body.client_time);
        const memories = Array.isArray(data.memories) ? data.memories.slice(-20) : [];
        const knowledge = Array.isArray(data.learned_knowledge) ? data.learned_knowledge.slice(-10) : [];
        const priorSuggestions = Array.isArray(data.suggestions) ? data.suggestions.slice(-10) : [];

        const answer = await this.env.AI.run(this.env.CHE_FAST_MODEL || FAST_MODEL, {
          messages: [
            {
              role: 'system',
              content: [
                'You are Chay, the owner’s proactive personal assistant.',
                'Return ONE short, genuinely useful proactive suggestion based only on supplied context.',
                'Do not nag. Do not invent deadlines, appointments, market conditions, messages, or facts.',
                'If there is no clearly useful suggestion, return exactly NONE.',
                'Prefer unfinished projects, obvious follow-ups, organization, preparation, or low-risk next actions.',
                'For trading or financial topics, suggest preparation/review rather than telling the owner what trade to take.',
                'Keep it under 180 characters.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify({
                local_time: clientClock?.display || null,
                memories,
                learned_knowledge: knowledge,
                recent_suggestions: priorSuggestions,
              }),
            },
          ],
          max_tokens: 120,
        });

        const suggestion = String(
          answer.response || answer.choices?.[0]?.message?.content || '',
        ).trim();

        if (!suggestion || suggestion.toUpperCase() === 'NONE') {
          return json({ suggestion: '' });
        }

        data.suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
        if (!data.suggestions.includes(suggestion)) {
          data.suggestions.push(suggestion.slice(0, 240));
          data.suggestions = data.suggestions.slice(-30);
          await this.ctx.storage.put('che', data);
        }

        return json({ suggestion: suggestion.slice(0, 240) });
      }

      if (path === '/api/change/request') return dispatchChange(this.env, body);
      if (path === '/api/chat') {
        const message = String(body.message || '').trim().slice(0, 5000);
        if (!message) return json({ detail: 'Message required.' }, 400);

        const clientClock = formatClientTime(body.client_time);
        const lowerMessage = message.toLowerCase();

        if (clientClock && /\b(?:what time is it|what(?:'s| is) the time|current time|what day is it|what(?:'s| is) today(?:'s)? date|what date is it|today(?:'s)? date)\b/i.test(message)) {
          return ndjsonReply(`It’s ${clientClock.display}, sir.`, { source: 'device_clock' });
        }

        const learnedPreference = safePreferenceFrom(message);
        if (learnedPreference &&
            !data.memories.some((item) => item.toLowerCase() === learnedPreference.toLowerCase())) {
          data.memories.push(learnedPreference);
          data.memories = data.memories.slice(-100);
          await this.ctx.storage.put('che', data);
        }

        const requestedCapabilities = Array.isArray(body.requested_capabilities)
          ? body.requested_capabilities.map((item) => String(item))
          : [];
        const multimodal = body.attachment
          ? await optionalMultimodal(this.env, body.attachment, message)
          : null;

        const imageGeneration = requestedCapabilities.includes('image_generation')
          ? await optionalMediaGeneration(this.env, 'image', message)
          : null;
        const videoGeneration = requestedCapabilities.includes('video_generation')
          ? await optionalMediaGeneration(this.env, 'video', message)
          : null;

        if (imageGeneration?.url) {
          return ndjsonReply(
            `Image generated, sir. ${imageGeneration.url}`,
            { media_type: 'image', media_url: imageGeneration.url },
          );
        }
        if (videoGeneration?.url) {
          return ndjsonReply(
            `Video generated, sir. ${videoGeneration.url}`,
            { media_type: 'video', media_url: videoGeneration.url },
          );
        }

        const shouldResearch = requestedCapabilities.includes('web_research') ||
          requestedCapabilities.includes('innovation_mode') ||
          /\b(research|latest|current|novel|prior art|feasib|humanly possible|artistically possible)\b/i.test(message);
        const useModelPanel =
          /\b(reason|analy[sz]e|compare|research|plan|design|code|invent|innovate|trade|trading|market|business|strategy|explain|debug|build)\b/i.test(message);

        const [research, panel] = await Promise.all([
          shouldResearch
            ? optionalResearch(this.env, message)
            : Promise.resolve(null),
          useModelPanel
            ? modelPanel(this.env, message)
            : Promise.resolve([]),
        ]);

        if (research?.summary) {
          data.learned_knowledge = Array.isArray(data.learned_knowledge)
            ? data.learned_knowledge
            : [];
          const learned = research.summary.replace(/\s+/g, ' ').slice(0, 700);
          if (learned && !data.learned_knowledge.includes(learned)) {
            data.learned_knowledge.push(learned);
            data.learned_knowledge = data.learned_knowledge.slice(-30);
            await this.ctx.storage.put('che', data);
          }
        }

        const remember = /^(?:(?:chay|chey|shay|che)[, ]+)?remember(?: that)?\s+(.+)/i.exec(message);
        if (remember) {
          const memory = remember[1].trim().slice(0, 500);
          const reply = /password|passcode|security code|social security|credit card/i.test(memory)
            ? 'I should not save that kind of secret, sir.'
            : 'I’ll remember that, sir.';
          if (reply.startsWith('I’ll')) {
            if (!data.memories.some((item) => item.toLowerCase() === memory.toLowerCase())) {
              data.memories.push(memory);
              data.memories = data.memories.slice(-100);
              await this.ctx.storage.put('che', data);
            }
          }
          return new Response(JSON.stringify({ type: 'delta', delta: reply }) + '\n', {
            headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
          });
        }
        const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
        const turns = history.filter((item) => item && ['user', 'assistant'].includes(item.role))
          .map((item) => ({ role: item.role, content: String(item.text || '').slice(0, 2000) }));
        const model = /\b(code|reason|plan|explain|compare|research|analy[sz]e|invent|innovate|design|prototype|feasib|possible|render|engineer|create|trade|trading|market|futures|crypto|backtest|indicator|business|cash flow|public records)\b/i.test(message)
          ? (this.env.CHE_STRONG_MODEL || STRONG_MODEL)
          : (this.env.CHE_FAST_MODEL || FAST_MODEL);
        const answer = await this.env.AI.run(model, {
          messages: [
            { role: 'system', content: [
              'You are CHE, Cognitive Horizon Engine. Your name is written C.H.E. but pronounced "Chay" (rhymes with "say"). Address the owner as sir naturally.',
              'CHE is the user-facing product. Never present yourself as Gemini, Cloudflare, or another provider. Models and services are replaceable internal engines behind CHE.',
              'DATA + COMPUTE: core owner state is persisted in CHE storage. Large media, datasets, model artifacts and generated files should use CHE object storage when connected. If storage is not connected, say the item is temporary instead of pretending it was archived.',
              'Use a local-first and owner-controlled architecture: built-in CHE behavior first, CHE-hosted services second, optional provider infrastructure only when required for compute or data.',
              'Keep your established personality: warm, direct, concise, clever, calm, useful, and lightly funny when the moment fits. Use practical common sense and do not sound stiff or childish.',
              'Learn from stable, useful, non-sensitive owner preferences. Never invent memories and never infer sensitive traits.',
              clientClock
                ? `Current owner-device local date/time: ${clientClock.display}. Use this for time/date questions unless the owner names another location.`
                : 'If current local time/date is unavailable, say so instead of guessing.',
              'When a task has a grounded or tool-provided duration, give a clearly labeled estimated wait time. If no reliable duration exists, give a rough range only when useful and label it as an estimate.',
              'INNOVATION MODE: when the owner asks to invent, innovate, design, prototype, render, or explore something new, combine imagination with disciplined feasibility thinking. Do not limit ideas to products that already exist.',
              'For novel concepts, separate: desired outcome, known constraints, physical/engineering feasibility, artistic/creative feasibility, unknowns, risks, required research, and the smallest useful prototype or experiment.',
              'Treat “humanly possible” as an evidence question. Distinguish what is established, plausible but unproven, currently impractical, and inconsistent with known physical constraints. Never present speculation as verified fact.',
              'For artistic possibility, explore unconventional forms, aesthetics, storytelling, interfaces, materials, workflows, and combinations while respecting the owner’s intent.',
              'PROACTIVE MODE: notice useful next steps, unfinished threads, preparation needs, and low-risk opportunities to help without waiting to be asked. Be selective, not noisy. Never invent urgency or facts, and never take consequential actions without authorization.',
              'MULTITASKING MODE: when the owner gives several goals at once, split them into clear subtasks, identify dependencies, and work on independent subtasks in parallel whenever real connected tools support safe parallel execution.',
              'Keep a concise task ledger in your reasoning: pending, active, blocked, and complete. Do not lose earlier parts of a multi-part request while working on later parts.',
              'For dependent tasks, sequence them correctly. For independent tasks, batch or parallelize them when possible, then combine the results into one coherent answer.',
              'When multitasking, report only useful progress and estimated timing. Never claim simultaneous execution unless the underlying tools actually ran concurrently or independently.',
              'If one subtask is blocked, continue making progress on the others when safe instead of stopping the entire job.',
              'When live research is available through a connected tool, use multiple credible sources for novelty and feasibility checks. When live research is not connected, clearly label the research gap and give a concrete research plan instead of pretending the check happened.',
              'MULTI-MODEL PANEL: connected model providers are advisory sources, not a copied knowledge base. Compare their answers, notice disagreements, prefer evidence and consistency, and synthesize a faster, more accurate final answer. Do not claim access to proprietary training data or internal reasoning from another model.',
              'Rendering requests should produce a real render only through a connected rendering/image tool. Without one, provide a precise render brief, scene/specification, dimensions, materials, camera/view, and prototype instructions.',
              'IMAGE GENERATION: when a connected image generator is available and the owner explicitly asks for an image, create the real image rather than only describing it. Preserve the owner’s requested subject, style, composition and constraints.',
              'VIDEO GENERATION: when a connected video generator is available and the owner explicitly asks for a generated video, create the real video or clip. If unavailable, provide a concise shot list, motion plan, duration, aspect ratio and generation brief instead of pretending it rendered.',
              'SCREEN + IDENTITY: only use owner-shared screen content or an explicitly authorized screen session. Facial features may be used for enrolled-owner verification or face-presence detection, not to identify unknown real people.',
              'PUBLIC INFORMATION: research only material that is lawfully public and available through authorized sources. Do not bypass access controls or reconstruct private records.',
              'MARKETS: when real market/backtest connectors are available, combine live stocks, futures and crypto data, historical tests, volatility, liquidity, technical structure, macroeconomic releases and current news. Never invent prices, fills, backtest statistics or prop-firm rules.',
              'For trading setups, explain evidence, entry conditions, invalidation, risk, assumptions and alternatives. No setup is guaranteed. Current political or economic events may be treated as sourced market inputs without political advocacy.',
              'COPY TRADING: live or prop-firm mirroring requires a real authorized broker/prop connection plus account rules, position-size limits, max-loss limits and an enabled execution policy. Never claim an order was copied or placed unless the connector confirms it.',
              'BUSINESS MODE: help with plans, budgets, cash flow, forecasts, CRM, scheduling, fulfillment and invoicing. Prospecting should use lawful professional/public business information. Payments require an authorized processor and owner-approved pricing and terms.',
              'Never claim to have changed code, researched live facts, controlled a phone, computer, car, music service, Bluetooth device, screen, smart-home device, trading account, or payment unless a real connected tool confirms it.',
              `Requested capabilities: ${JSON.stringify(requestedCapabilities).slice(0, 1200)}`,
              `Integration readiness: ${JSON.stringify({
                web_research: Boolean(this.env.CHE_RESEARCH_URL),
                public_records: Boolean(this.env.CHE_PUBLIC_RECORDS_URL),
                rendering: Boolean(this.env.CHE_RENDER_URL),
                image_generation: Boolean(this.env.CHE_IMAGE_GEN_URL),
                video_generation: Boolean(this.env.CHE_VIDEO_GEN_URL),
                model_panel: Boolean(
                  this.env.CHE_OPENAI_MODEL_URL ||
                  this.env.CHE_ANTHROPIC_MODEL_URL ||
                  this.env.CHE_XAI_MODEL_URL ||
                  this.env.CHE_DEEPSEEK_MODEL_URL ||
                  this.env.CHE_COPILOT_MODEL_URL
                ),
                screen_capture: Boolean(this.env.CHE_SCREEN_URL),
                face_verify: Boolean(this.env.CHE_FACE_VERIFY_URL),
                data_recognition: Boolean(this.env.CHE_DATA_RECOGNITION_URL),
                multimodal: Boolean(this.env.CHE_MULTIMODAL_URL),
                market_data: Boolean(this.env.CHE_MARKET_DATA_URL),
                backtesting: Boolean(this.env.CHE_BACKTEST_URL),
                broker: Boolean(this.env.CHE_BROKER_URL),
                prop_firm: Boolean(this.env.CHE_PROP_FIRM_URL),
                business: Boolean(this.env.CHE_BUSINESS_URL),
                payments: Boolean(this.env.CHE_PAYMENTS_URL),
                leads: Boolean(this.env.CHE_LEADS_URL),
                music: Boolean(this.env.CHE_MUSIC_URL),
                windows: Boolean(this.env.CHE_WINDOWS_URL),
                car: Boolean(this.env.CHE_CAR_URL),
                smart_home: Boolean(this.env.CHE_SMART_HOME_URL),
              })}`,
              multimodal?.summary
                ? `Connected multimodal analysis for ${multimodal.name}: ${multimodal.summary}`
                : multimodal?.error
                  ? `Multimodal status: ${multimodal.error} Do not pretend the attachment was analyzed.`
                  : 'No multimodal attachment analysis is available for this turn.',
              panel.length
                ? `Connected multi-model advisory panel: ${JSON.stringify(panel).slice(0, 24000)}`
                : 'No external model-panel answers were available for this turn.',
              imageGeneration?.error
                ? `Image generation status: ${imageGeneration.error}`
                : imageGeneration?.job_id
                  ? `Image generation job submitted: ${imageGeneration.job_id} (${imageGeneration.status}).`
                  : '',
              videoGeneration?.error
                ? `Video generation status: ${videoGeneration.error}`
                : videoGeneration?.job_id
                  ? `Video generation job submitted: ${videoGeneration.job_id} (${videoGeneration.status}).`
                  : '',
              research?.summary
                ? `Connected live research summary: ${research.summary}${research.sources?.length ? `\nResearch sources: ${JSON.stringify(research.sources)}` : ''}`
                : research?.error
                  ? `Live research status: ${research.error} Do not pretend live research succeeded.`
                  : 'No connected live research result is available for this turn.',
              body.screen_context
                ? `Owner-shared screen/text context: ${String(body.screen_context).slice(0, 8000)}`
                : 'No owner-shared screen context is active for this turn.',
              body.client_identity_profile
                ? `Client identity/personality guidance: ${String(body.client_identity_profile).slice(0, 7000)}`
                : '',
              `Owner memories: ${JSON.stringify(data.memories).slice(0, 5000)}`,
            ].filter(Boolean).join('\n') },
            ...turns,
            { role: 'user', content: message },
          ],
          max_tokens: 1000,
        });
        const reply = String(answer.response || answer.choices?.[0]?.message?.content || '').trim();
        if (!reply) return json({ detail: 'The model did not return an answer.' }, 502);
        return new Response(JSON.stringify({ type: 'delta', delta: reply }) + '\n' +
          JSON.stringify({ type: 'done', model }) + '\n', {
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      return json({ detail: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof SyntaxError || ['too_large', 'invalid_json'].includes(error.message)) {
        return json({ detail: 'Invalid or oversized request.' }, 400);
      }
      return json({ detail: 'CHE cloud Agent is temporarily unavailable.' }, 503);
    }
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/health') return json({ ok: true, agent: 'CHE cloud' });
    return env.CHE_STATE.getByName('owner').fetch(request);
  },
};
