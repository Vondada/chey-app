// A local stand-in for the huggingface.co endpoints CHE's onboarding uses, for
// tests and the offline demo only. Shapes follow the real API:
//   GET /api/whoami-v2 → 401 {"error":"Invalid credentials in Authorization header"} without a valid token,
//     else { type:'user', name, auth:{ type:'access_token', accessToken:{ displayName, role, fineGrained? } } }
//   GET /api/models/{id}, GET /api/spaces?author=, GET router.huggingface.co/v1/models
//   GET /settings/tokens/new  → a reconstruction of the token form (tools/fixtures/hf_token_page.html)
//   POST /settings/tokens/new → mints a token for the signed-in session
//   POST /api/credentials/revoke → 202 always (as documented)
// It is NOT a copy of Hugging Face's page; the real DOM is checked only on the owner's iPhone.
import { readFileSync } from 'node:fs';

const PERMS = {
  'Make calls to Inference Providers': 'inference.serverless.write',
  'Read access to contents of all public gated repos you can access': 'repo.content.read',
  'Write access to contents/settings of all repos under your personal namespace': 'repo.write',
};

export function fakeToken(seed = Math.random()) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let x = Math.floor(Number(seed) * 1e9) || 7;
  let out = 'hf_';
  for (let i = 0; i < 34; i++) { x = (x * 1103515245 + 12345) % 2147483648; out += abc[x % abc.length]; }
  return out;
}

export function fakeHuggingFace({ user = 'vondada', signedIn = true, routerDown = false, whoamiStatus = 0, captcha = false } = {}) {
  const tokens = new Map(); // value → { displayName, role, permissions }
  const calls = [];
  const state = { user, signedIn, routerDown, whoamiStatus, captcha, created: [] };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const bearer = (init) => /^Bearer (\S+)$/.exec((init?.headers && (init.headers.Authorization || init.headers.authorization)) || '')?.[1] || '';

  function mint({ name, permissions = [], role = 'fineGrained' }) {
    const value = fakeToken(Math.random());
    tokens.set(value, { displayName: name, role, permissions: permissions.map((l) => PERMS[l] || l) });
    state.created.push({ name, permissions: [...permissions] });
    return value;
  }

  async function handle(input, init = {}) {
    const url = new URL(String(input?.url || input));
    const method = (init.method || 'GET').toUpperCase();
    const token = bearer(init);
    calls.push({ host: url.host, path: url.pathname, method, auth: token ? 'bearer' : 'none' });
    const known = tokens.get(token);
    if (url.host === 'router.huggingface.co' && url.pathname === '/v1/models') {
      if (state.routerDown || !known) return json(401, { error: 'Invalid credentials' });
      return json(200, { object: 'list', data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct' }] });
    }
    if (url.host !== 'huggingface.co') return json(404, { error: 'not found' });
    if (url.pathname === '/api/whoami-v2') {
      if (state.whoamiStatus) return json(state.whoamiStatus, { error: 'Too Many Requests' });
      if (!known) return json(401, { error: 'Invalid credentials in Authorization header' });
      const accessToken = { displayName: known.displayName, role: known.role };
      if (known.role === 'fineGrained') accessToken.fineGrained = { canReadGatedRepos: known.permissions.includes('repo.content.read'), global: [], scoped: [{ entity: { type: 'user', name: state.user }, permissions: known.permissions }] };
      return json(200, { type: 'user', id: '1', name: state.user, fullname: 'Owner', auth: { type: 'access_token', accessToken } });
    }
    if (url.pathname.startsWith('/api/models/')) return known || !token ? json(200, { id: url.pathname.slice(12) }) : json(401, { error: 'Invalid credentials' });
    if (url.pathname === '/api/spaces') return known ? json(200, []) : json(401, { error: 'Invalid credentials' });
    if (url.pathname === '/api/credentials/revoke' && method === 'POST') {
      for (const v of JSON.parse(init.body || '{}').credentials || []) tokens.delete(v);
      return new Response('', { status: 202 });
    }
    if (url.pathname === '/settings/tokens/new' && method === 'GET') {
      const page = !state.signedIn ? '<html><body><h1>Log In</h1><form action="/login"><input name="username" autocomplete="username"><input type="password" name="password"></form></body></html>'
        : state.captcha ? '<html><body><iframe title="hCaptcha challenge" src="about:blank"></iframe></body></html>'
          : readFileSync(new URL('./fixtures/hf_token_page.html', import.meta.url), 'utf8').replaceAll('{{USER}}', state.user);
      return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.pathname === '/settings/tokens/new' && method === 'POST') {
      const form = JSON.parse(init.body || '{}');
      if (!state.signedIn) return json(401, { error: 'login required' });
      return json(200, { token: mint({ name: form.name, permissions: form.permissions || [] }) });
    }
    return json(404, { error: 'not found' });
  }
  return { handle, tokens, calls, state, mint };
}

// Routes only Hugging Face hosts to the fake; everything else to `fallback`.
export function hfFetch(fake, fallback = globalThis.fetch) {
  return (input, init) => {
    const host = new URL(String(input?.url || input)).host;
    return host === 'huggingface.co' || host === 'router.huggingface.co' ? fake.handle(input, init) : fallback(input, init);
  };
}
