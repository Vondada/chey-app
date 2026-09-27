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
  if (Number(request.headers.get('content-length') || 0) > 96_000) throw new Error('too_large');
  const raw = await request.text();
  if (raw.length > 96_000) throw new Error('too_large');
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
        });
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
        const remember = /^(?:che[, ]+)?remember(?: that)?\s+(.+)/i.exec(message);
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
        const model = /\b(code|reason|plan|explain|compare|research|analy[sz]e|invent|innovate|design|prototype|feasib|possible|render|engineer|create)\b/i.test(message)
          ? (this.env.CHE_STRONG_MODEL || STRONG_MODEL)
          : (this.env.CHE_FAST_MODEL || FAST_MODEL);
        const answer = await this.env.AI.run(model, {
          messages: [
            { role: 'system', content: [
              'You are CHE, Cognitive Horizon Engine. Your name is written C.H.E. but pronounced "Chay" (rhymes with "say"). Address the owner as sir naturally.',
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
              'When live research is available through a connected tool, use multiple credible sources for novelty and feasibility checks. When live research is not connected, clearly label the research gap and give a concrete research plan instead of pretending the check happened.',
              'Rendering requests should produce a real render only through a connected rendering/image tool. Without one, provide a precise render brief, scene/specification, dimensions, materials, camera/view, and prototype instructions.',
              'Never claim to have changed code, researched live facts, controlled a phone, computer, car, music service, Bluetooth device, screen, or smart-home device unless a real connected tool confirms it.',
              `Requested capabilities: ${JSON.stringify(body.requested_capabilities || []).slice(0, 1200)}`,
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
          max_tokens: 650,
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
