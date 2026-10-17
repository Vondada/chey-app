// Test server for the website observer. The observer refuses local addresses, so the fixture
// is served under public-looking names (che-fixture.example, cdn.fixture-cdn.example) by acting
// as the browser's plain-HTTP proxy (http_proxy). Every request is logged. A request that
// arrives directly, rather than through the proxy, is a probe of a loopback address that
// should never have left the browser.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const APP = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
export const FIXTURE_HOST = 'che-fixture.example';
export const FIXTURE_CDN = 'cdn.fixture-cdn.example';

export function startWebFixture({ robots = 'User-agent: *\nDisallow: /private/\n' } = {}) {
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'direct.invalid'}`);
    log.push({ method: req.method, host: url.hostname, path: url.pathname });
    const send = (status, type, body) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    if (url.hostname === FIXTURE_CDN && url.pathname === '/lib.js') return send(200, 'text/javascript', 'window.fixtureLib = true;\n');
    if (url.hostname !== FIXTURE_HOST) return send(404, 'text/plain', 'not found');
    const port = server.address().port;
    switch (url.pathname) {
      case '/':
      case '/private/page':
        return send(200, 'text/html; charset=utf-8', PAGE);
      case '/challenge':
        return send(403, 'text/html', '<!doctype html><title>Just a moment...</title><p>Checking your browser.</p><script src="/cdn-cgi/challenge-platform/cf-chl.js"></script>');
      case '/members':
        return send(401, 'text/html', '<!doctype html><title>Members</title><form><input type="password"></form>');
      case '/robots.txt':
        return send(200, 'text/plain', robots);
      // A permitted address that redirects into a disallowed one.
      case '/moved':
        return res.writeHead(302, { location: '/private/page', 'cache-control': 'no-store' }).end();
      // A page whose first script tries to write before the page has loaded.
      case '/early-post':
        return send(200, 'text/html; charset=utf-8', '<!doctype html><title>Early</title><script>fetch("/early-beacon", { method: "POST", body: "x" }).catch(() => {}); navigator.sendBeacon && navigator.sendBeacon("/early-beacon2", "y");</script><h1>Early</h1>');
      case '/app.js':
        return send(200, 'text/javascript', APP.replaceAll('__PORT__', String(port)));
      case '/logo.png':
      case '/photo.png':
        return send(200, 'image/png', PNG);
      case '/wp-content/themes/fixture/style.css':
        return send(200, 'text/css', 'p { margin: 0 0 12px; }\n');
      default:
        return send(404, 'text/plain', 'not found');
    }
  });
  server.on('upgrade', (req, socket) => {
    log.push({ method: 'UPGRADE', host: String(req.headers.host || '').replace(/:\d+$/, ''), path: req.url });
    socket.destroy();
  });
  // Node's fetch tunnels even plain-HTTP requests through the proxy, so a tunnel to a fixture
  // name is looped back to this server.
  server.on('connect', (req, client) => {
    const host = String(req.url).replace(/:\d+$/, '');
    log.push({ method: 'CONNECT', host, path: '' });
    if (![FIXTURE_HOST, FIXTURE_CDN].includes(host)) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const upstream = connect(server.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, log, proxy: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// Requests that reached the network although the observer should have stopped them.
export function leaks(log) {
  return log.filter((entry) => ![FIXTURE_HOST, FIXTURE_CDN].includes(entry.host) || entry.path.startsWith('/leak'));
}
