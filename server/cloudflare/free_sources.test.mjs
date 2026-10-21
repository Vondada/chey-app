// Free sources: every provider parses its real response shape; a limit or outage is a failed search, never an
// empty answer; the server-side reader respects robots.txt. Fixtures only; nothing reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_PROVIDERS, registerFreeSources, serverExecutor, pageText } from './free_sources.js';
import { createSearchRegistry, runBrowseLoop } from './agent_browse_loop.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const routes = (map) => async (url) => {
  for (const [match, make] of Object.entries(map)) if (String(url).includes(match)) return make();
  return text('not found', 404);
};

test('Wikipedia returns titled, linked results from its search API', async () => {
  const fetcher = routes({ 'wikipedia.org': () => json({ query: { search: [{ title: 'Pizza', snippet: 'A <span>dish</span> from Naples' }] } }) });
  const rows = await FREE_PROVIDERS.wikipedia.search('pizza', fetcher);
  assert.deepEqual(rows[0], { title: 'Pizza', url: 'https://en.wikipedia.org/wiki/Pizza', snippet: 'A dish from Naples' });
});

test('OpenAlex returns papers with a link, and drops any without one', async () => {
  const fetcher = routes({ 'openalex.org': () => json({ results: [
    { display_name: 'Attention is all you need', doi: 'https://doi.org/10.5555/x', publication_year: 2017, authorships: [{ author: { display_name: 'A. Vaswani' } }] },
    { display_name: 'No link paper' },
  ] }) });
  const rows = await FREE_PROVIDERS.openalex.search('attention', fetcher);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://doi.org/10.5555/x');
  assert.match(rows[0].snippet, /2017 A\. Vaswani/);
});

test('arXiv parses its Atom entries', async () => {
  const xml = '<feed><entry><title>Diffusion models</title><id>http://arxiv.org/abs/2006.11239</id><summary>We present denoising models.</summary></entry></feed>';
  const rows = await FREE_PROVIDERS.arxiv.search('diffusion', routes({ 'arxiv.org': () => text(xml) }));
  assert.deepEqual(rows, [{ title: 'Diffusion models', url: 'http://arxiv.org/abs/2006.11239', snippet: 'We present denoising models.' }]);
});

test('GDELT returns news articles with their links', async () => {
  const rows = await FREE_PROVIDERS.gdelt.search('election', routes({ 'gdeltproject.org': () => json({ articles: [{ title: 'Vote counted', url: 'https://news.example/a', domain: 'news.example', seendate: '20261021T010000Z' }] }) }));
  assert.equal(rows[0].url, 'https://news.example/a');
});

test('a limit or outage is an error the loop reports, never an empty answer', async () => {
  const registry = createSearchRegistry();
  registerFreeSources(registry, { wikipedia: { ...FREE_PROVIDERS.wikipedia, search: (q) => FREE_PROVIDERS.wikipedia.search(q, routes({ 'wikipedia.org': () => text('slow down', 429) })) } });
  const r = await runBrowseLoop({
    question: 'pizza?', search: registry,
    planner: async ({ observations }) => (observations.length === 0 ? { type: 'search', query: 'pizza' } : { type: 'finish', answer: 'x', cite: [] }),
    executor: async () => ({ ok: true }),
  });
  assert.equal(r.status, 'not_found');
});

test('all four free sources register with the loop\'s search registry', () => {
  const registry = createSearchRegistry();
  const ids = registerFreeSources(registry);
  assert.deepEqual(ids.sort(), ['arxiv', 'gdelt', 'openalex', 'wikipedia']);
  assert.equal(registry.list().length, 4);
});

// Test resolver: the host resolves to a public address, the same way the production DNS-over-HTTPS check reads it.
const DNS = { 'cloudflare-dns.com': () => json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }) };

test('the server reader reads a page as text when robots.txt allows it', async () => {
  const fetcher = routes({
    ...DNS,
    'robots.txt': () => text('User-agent: *\nDisallow: /private'),
    'example.org/pizza': () => text('<html><script>x()</script><h1>Pizza</h1><p>From Naples &amp; loved.</p></html>'),
  });
  const r = await serverExecutor({ fetcher })({ type: 'read', url: 'https://example.org/pizza' });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Pizza From Naples & loved.');
});

test('the server reader refuses a page that robots.txt disallows', async () => {
  const fetcher = routes({ ...DNS, 'robots.txt': () => text('User-agent: *\nDisallow: /private') });
  const r = await serverExecutor({ fetcher })({ type: 'open', url: 'https://example.org/private/x' });
  assert.equal(r.ok, false);
});

test('clicks and typing are left to the iPhone, and say so', async () => {
  const r = await serverExecutor({ fetcher: routes({}) })({ type: 'click', label: 'Like' });
  assert.equal(r.ok, false);
  assert.match(r.error, /needs the iPhone/);
});

test('pageText keeps the words and drops markup and scripts', () => {
  assert.equal(pageText('<script>bad()</script><b>Hi</b> there&nbsp;you'), 'Hi there you');
});

test('end to end: a free search, a server-side read, an answer that cites the page, and the page kept for later', async (t) => {
  const { storeLoopReads } = await import('./agent_research_memory.js');
  const { BRAIN_REGIONS, CheBrainStore } = await import('./brain_store.js');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return t.skip('node:sqlite unavailable'); }
  const db = new DatabaseSync(':memory:');
  const saved = new Map();
  const store = new CheBrainStore({ get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, v), delete: async () => {}, list: async () => new Map(), setAlarm: async () => {}, deleteAlarm: async () => {}, sql: { exec: (q, ...p) => { const s = db.prepare(q); return /^\s*SELECT/i.test(q) ? s.all(...p) : (s.run(...p), []); } } });

  const fetcher = routes({
    ...DNS,
    'robots.txt': () => text('User-agent: *\nAllow: /'),
    'wikipedia.org/w/api.php': () => json({ query: { search: [{ title: 'Pizza', snippet: 'Pizza is a dish' }] } }),
    'wikipedia.org/wiki/Pizza': () => text('<h1>Pizza</h1><p>Pizza began in Naples.</p>'),
  });
  const registry = createSearchRegistry();
  registerFreeSources(registry, { wikipedia: { ...FREE_PROVIDERS.wikipedia, search: (q) => FREE_PROVIDERS.wikipedia.search(q, fetcher) } });
  const planner = async ({ observations }) => {
    if (observations.length === 0) return { type: 'search', query: 'pizza origin' };
    if (observations.length === 1) return { type: 'open', url: 'https://en.wikipedia.org/wiki/Pizza' };
    return { type: 'finish', answer: 'Pizza began in Naples.', cite: ['https://en.wikipedia.org/wiki/Pizza'] };
  };
  const r = await runBrowseLoop({ question: 'where did pizza begin?', planner, search: registry, executor: serverExecutor({ fetcher }), app: 'Web', grants: ['Web'] });
  assert.equal(r.status, 'answered');
  assert.deepEqual(r.sources, ['https://en.wikipedia.org/wiki/Pizza']);
  // Every page read in the loop is kept as a research lead, whether or not it was the answer.
  const { kept } = storeLoopReads(store, { question: 'where did pizza begin?', observations: [{ ok: true, read: true, url: 'https://en.wikipedia.org/wiki/Pizza', text: 'Pizza began in Naples.' }] });
  assert.equal(kept.length, 1);
  assert.equal(store.get(kept[0].id).region, BRAIN_REGIONS.learned);
});
