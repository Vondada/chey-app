// Test helper: a DNS-over-HTTPS answer (library.js publicDns) that puts every name on one public
// address, so a fake internet does not need its own DNS. `withPublicDns(fetcher, { private: [...] })`
// points the named hosts at a private address instead.
export const PUBLIC_IP = '93.184.216.34';

export function dnsAnswer(url, { private: inside = [] } = {}) {
  const u = String(url);
  if (!u.startsWith('https://cloudflare-dns.com/dns-query')) return null;
  const params = new URL(u).searchParams;
  const name = params.get('name');
  const v4 = params.get('type') === 'A';
  const Answer = v4 ? [{ name, type: 1, data: inside.includes(name) ? '10.0.0.7' : PUBLIC_IP }] : [];
  return new Response(JSON.stringify({ Status: 0, Answer }), { status: 200, headers: { 'content-type': 'application/dns-json' } });
}

export const withPublicDns = (fetcher, options = {}) => async (url, init) => dnsAnswer(url, options) || fetcher(url, init);
