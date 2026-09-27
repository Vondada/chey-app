// CHE's phone-accessible Agent. Deploy with a Workers AI binding and a D1 DB.
// Secrets remain in Cloudflare; Flutter receives only a paired-device token.

const FAST_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const STRONG_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const MAX_BODY = 96_000;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function line(value) {
  return JSON.stringify(value) + '\n';
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function bodyOf(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw new Error('Request too large.');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('Request too large.');
  const body = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON object.');
  return body;
}

async function owner(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]{40,160})$/.exec(authorization);
  if (!match) return null;
  const hash = await digest(match[1]);
  const device = await env.DB.prepare('SELECT token_hash FROM devices WHERE token_hash = ?')
    .bind(hash).first();
  return device ? hash : null;
}

async function pair(request, env, body) {
  const code = String(body.code || '');
  if (!env.CHE_PAIR_CODE || !/^\d{6,12}$/.test(env.CHE_PAIR_CODE)) {
    return json({ detail: 'Set CHE_PAIR_CODE as a Cloudflare secret first.' }, 503);
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const since = Date.now() - 15 * 60_000;
  const failures = await env.DB.prepare('SELECT COUNT(*) AS count FROM pair_failures WHERE ip = ? AND at_ms > ?')
    .bind(ip, since).first();
  if (Number(failures?.count || 0) >= 5) return json({ detail: 'Too many attempts. Wait 15 minutes.' }, 429);
  // Compare fixed-length digests, so the code itself is never logged or stored.
  if ((await digest(code)) !== (await digest(env.CHE_PAIR_CODE))) {
    await env.DB.prepare('INSERT INTO pair_failures (ip, at_ms) VALUES (?, ?)').bind(ip, Date.now()).run();
    return json({ detail: 'Incorrect pairing code.' }, 403);
  }
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(48)),
    (b) => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await digest(raw);
  const name = String(body.device_name || 'CHE phone').slice(0, 80);
  await env.DB.prepare('INSERT INTO devices (token_hash, name, created_at) VALUES (?, ?, ?)')
    .bind(tokenHash, name, new Date().toISOString()).run();
  return json({ device_token: raw });
}

async function changeRequest(env, body) {
  const description = String(body.request || '').trim();
  if (description.length < 8 || description.length > 2000) {
    return json({ detail: 'Describe one change in 8–2000 characters.' }, 400);
  }
  if (!env.CHE_GITHUB_TOKEN || !env.CHE_CHANGE_MODEL || !env.CHE_GITHUB_REPO) {
    return json({ detail: 'Phone code proposals are not connected to GitHub yet.' }, 503);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.CHE_GITHUB_REPO) ||
      !/^[\w.:-]+$/.test(env.CHE_CHANGE_MODEL)) {
    return json({ detail: 'Invalid GitHub or model configuration.' }, 503);
  }
  const url = `https://api.github.com/repos/${env.CHE_GITHUB_REPO}/actions/workflows/che-propose.yml/dispatches`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CHE-Agent',
    },
    body: JSON.stringify({ ref: 'main', inputs: { request: description, model: env.CHE_CHANGE_MODEL } }),
  });
  if (response.status !== 204) return json({ detail: `GitHub could not start the proposal (${response.status}).` }, 502);
  return json({ message: 'I started a code proposal, sir. Review the draft pull request on your phone. Merging it will start the cloud iPhone build.' });
}

async function chat(env, body) {
  const message = String(body.message || '').trim().slice(0, 5000);
  if (!message) return json({ detail: 'Message required.' }, 400);
  const memories = (await env.DB.prepare('SELECT text FROM memories ORDER BY id DESC LIMIT 40').all())
    .results.map((row) => row.text);
  const profile = [
    'You are CHE, Cognitive Horizon Engine. Address the owner as sir naturally.',
    'Be helpful, warm, direct, concise, and candid about limitations.',
    'The iPhone voice feature works only under iOS permissions; do not claim background access.',
    'Do not claim to have changed code, researched live facts, or controlled a phone unless a real tool confirms it.',
    `Owner memories: ${JSON.stringify(memories).slice(0, 5000)}`,
  ].join('\n');
  const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
  const turns = history.filter((item) => item && ['user', 'assistant'].includes(item.role))
    .map((item) => ({ role: item.role, content: String(item.text || '').slice(0, 2000) }));
  const advanced = /\b(code|reason|plan|explain|compare|research|analy[sz]e)\b/i.test(message);
  const model = advanced
    ? (env.CHE_STRONG_MODEL || STRONG_MODEL)
    : (env.CHE_FAST_MODEL || FAST_MODEL);
  const answer = await env.AI.run(model, {
    messages: [{ role: 'system', content: profile }, ...turns, { role: 'user', content: message }],
    max_tokens: 650,
  });
  const reply = String(answer.response || answer.choices?.[0]?.message?.content || '').trim();
  if (!reply) return json({ detail: 'The model did not return an answer.' }, 502);
  return new Response(line({ type: 'delta', delta: reply }) + line({ type: 'done', model }), {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/health') return json({ ok: true, agent: 'CHE cloud' });
      const body = request.method === 'POST' ? await bodyOf(request) : {};
      if (request.method === 'POST' && path === '/api/pair') return pair(request, env, body);
      const tokenHash = await owner(request, env);
      if (!tokenHash) return json({ detail: 'Pair your phone to CHE.' }, 401);
      if (request.method === 'GET' && path === '/api/state') {
        const rows = await env.DB.prepare('SELECT text FROM memories ORDER BY id ASC LIMIT 100').all();
        return json({ memories: rows.results.map((row) => row.text), personality: [] });
      }
      if (request.method !== 'POST') return json({ detail: 'Not found.' }, 404);
      if (path === '/api/security/revoke_self') {
        await env.DB.prepare('DELETE FROM devices WHERE token_hash = ?').bind(tokenHash).run();
        return json({ ok: true });
      }
      if (path === '/api/memory/add') {
        const value = String(body.memory || '').trim().slice(0, 500);
        if (!value || /password|passcode|security code|social security|credit card/i.test(value)) {
          return json({ detail: 'Choose a non-sensitive memory.' }, 400);
        }
        await env.DB.prepare('INSERT OR IGNORE INTO memories (text) VALUES (?)').bind(value).run();
        return json({ ok: true });
      }
      if (path === '/api/memory/delete') {
        const index = Number(body.index);
        if (!Number.isInteger(index) || index < 0 || index > 99) return json({ detail: 'Invalid memory index.' }, 400);
        const rows = await env.DB.prepare('SELECT id FROM memories ORDER BY id ASC LIMIT 100').all();
        const id = rows.results[index]?.id;
        if (id === undefined) return json({ detail: 'Memory not found.' }, 400);
        await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }
      if (path === '/api/memory/clear') {
        await env.DB.prepare('DELETE FROM memories').run();
        return json({ ok: true });
      }
      if (path === '/api/change/request') return changeRequest(env, body);
      if (path === '/api/chat') return chat(env, body);
      return json({ detail: 'Not found.' }, 404);
    } catch (error) {
      // Keep private request bodies and credentials out of error responses.
      if (error instanceof SyntaxError || error.message === 'Request too large.') {
        return json({ detail: 'Invalid or oversized request.' }, 400);
      }
      return json({ detail: 'CHE cloud Agent is temporarily unavailable.' }, 503);
    }
  },
};
