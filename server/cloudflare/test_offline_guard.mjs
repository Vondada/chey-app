// The Worker tests run offline by design. A request to a real host is refused with a clear error, so a test cannot pass
// or fail with whatever network the runner happens to have (CI's network differs from a laptop's, and the staging gate
// found tests that reached Wikipedia, DuckDuckGo, market-data hosts and the GitHub API). Local hosts stay open for
// local fixtures. A test that needs a network answer stubs fetch itself, as the rest of the suite does.
// Loaded for the whole run with NODE_OPTIONS=--import ./server/cloudflare/test_offline_guard.mjs (see
// .github/workflows/che-worker-staging.yml).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  let host = '';
  try { host = new URL(String(input?.url || input)).hostname; } catch (_) { return realFetch(input, init); }
  if (!LOCAL_HOSTS.has(host)) throw new TypeError(`offline in tests: ${host} (a test must stub fetch for an outside host)`);
  return realFetch(input, init);
};
