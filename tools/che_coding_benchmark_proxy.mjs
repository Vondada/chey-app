// Counting forwarder for the coding benchmark. Every request a model provider receives
// from OpenCode passes through here, so the count is the provider's real request count:
// title calls and SDK retries included. From the cap onward a POST is refused, not sent.
// The real keys are given to this proxy only. OpenCode carries placeholder keys, so a request
// that bypasses the proxy is rejected by the provider and never billed. A provider without a
// real key is refused here (fail closed). Keys are never logged.
import http from 'node:http';
import https from 'node:https';

export const PROVIDER_UPSTREAMS = Object.freeze({
  openrouter: { protocol: 'https:', host: 'openrouter.ai', port: 443 },
  groq: { protocol: 'https:', host: 'api.groq.com', port: 443 },
  google: { protocol: 'https:', host: 'generativelanguage.googleapis.com', port: 443 },
});

export const PROXY_PORT = 18089;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade', 'host']);

// The header each provider reads its key from. The client's own key is replaced, never forwarded.
const KEY_HEADER = Object.freeze({ groq: 'authorization', openrouter: 'authorization', google: 'x-goog-api-key' });

function injectKey(provider, headers, credentials) {
  const value = credentials?.[provider];
  if (!value) return false;
  delete headers.authorization;
  delete headers['x-goog-api-key'];
  headers[KEY_HEADER[provider]] = KEY_HEADER[provider] === 'authorization' ? `Bearer ${value}` : value;
  return true;
}

function passable(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) if (!HOP_BY_HOP.has(name)) out[name] = value;
  return out;
}

export function createCallProxy({ cap, upstreams = PROVIDER_UPSTREAMS, credentials = {} } = {}) {
  if (!Number.isInteger(cap) || cap < 0 || cap > 60) throw new Error('the model-call cap must be a whole number from 0 to 60');
  const state = { cap, count: 0, refused: 0, forwardedGets: 0, byProvider: {} };
  const server = http.createServer((req, res) => {
    const match = /^\/(openrouter|groq|google)(\/.*)?$/.exec(req.url || '');
    if (!match) {
      req.resume();
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"unknown provider"}}');
      return;
    }
    const provider = match[1];
    const target = upstreams[provider];
    const headers = passable(req.headers);
    if (!injectKey(provider, headers, credentials)) {
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"CHE coding benchmark: no key for this provider; request not sent"}}');
      return;
    }
    if (req.method === 'POST') {
      if (state.count >= state.cap) {
        state.refused += 1;
        req.resume();
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'CHE coding benchmark: model-call cap reached; request not sent', type: 'rate_limit_error' } }));
        return;
      }
      state.count += 1;
      state.byProvider[provider] = (state.byProvider[provider] || 0) + 1;
    } else {
      state.forwardedGets += 1;
    }
    headers.host = target.host;
    const client = target.protocol === 'http:' ? http : https;
    const upstream = client.request({
      protocol: target.protocol,
      hostname: target.host,
      port: target.port,
      path: match[2] || '/',
      method: req.method,
      headers,
    }, (up) => {
      res.writeHead(up.statusCode || 502, passable(up.headers));
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"provider unavailable"}}');
    });
    req.pipe(upstream);
  });
  return {
    state,
    // A fixed port below the ephemeral range: OpenCode's client did not connect to ephemeral
    // loopback ports on the sandbox used to build this, while a fixed port answered.
    listen(port = PROXY_PORT) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
