// The owner's chat routed into the browsing loop and the sub-agents. Fixtures only; nothing reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browseIntent, browseReply, runSearchRoute, subAgentPlan } from './browse_chat.js';
import { parseReaRequest } from './rea_runner.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const routes = (map) => async (url) => {
  for (const [match, make] of Object.entries(map)) if (String(url).includes(match)) return make();
  return text('not found', 404);
};
// The host resolves to a public address, the same way the production DNS-over-HTTPS check reads it.
const DNS = { 'cloudflare-dns.com': () => json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }) };
const wikipedia = routes({
  ...DNS,
  'api.php': () => json({ query: { search: [{ title: 'Pizza', snippet: 'A <span>dish</span> from Naples' }] } }),
  'robots.txt': () => text('User-agent: *\nDisallow: /private'),
  '/wiki/Pizza': () => text('<html><h1>Pizza</h1><p>Pizza is a dish from Naples.</p></html>'),
});
// A model stand-in that returns the next scripted reply each time it is asked to plan.
const scripted = (replies) => {
  const queue = [...replies];
  return async () => queue.shift() ?? '';
};

test('a request to search is routed to the loop; a question about search is not', () => {
  assert.equal(browseIntent('Browse the web for the history of pizza').search, true);
  assert.equal(browseIntent('Use the browser to check the Nile river length').search, true);
  // The ordinary "look it up" and "search the web" questions keep their own research route.
  assert.equal(browseIntent('Look up the history of pizza on the web').search, false);
  assert.equal(browseIntent('Search the web for the Nile river length').search, false);
  assert.equal(browseIntent("Shouldn't searching the web be free?").search, false);
});

test('a search of the owner\'s own memory is not a web search (memory search answers it)', () => {
  const intent = browseIntent('Search my long-term memory for Atlas');
  assert.equal(intent.search, false);
  assert.equal(intent.study, false);
  assert.equal(intent.create, false);
});

test('a study request with a link carries the link; a study request without one asks for it', () => {
  const linked = browseIntent('Study this Instagram page https://www.instagram.com/example/reel/abc123.');
  assert.equal(linked.study, true);
  assert.equal(linked.url, 'https://www.instagram.com/example/reel/abc123');
  const unlinked = browseIntent('Study a certain Instagram page for me');
  assert.equal(unlinked.study, true);
  assert.equal(unlinked.url, '');
});

test('the owner\'s whole Instagram request asks for a study, a style and an original story', () => {
  const intent = browseIntent('Study an Instagram page at https://www.instagram.com/example/ using REA, find how they render an AI video, and recreate the same type of style. Then write an original story for me.');
  assert.equal(intent.study, true);
  assert.equal(intent.style, true);
  assert.equal(intent.create, true);
});

test('the sub-agents: a story goes to Mira; the style study goes to Atlas only when a link is given', () => {
  const withLink = subAgentPlan('Study https://www.instagram.com/example/ and recreate the same style. Then write an original story.', { url: 'https://www.instagram.com/example/' });
  assert.deepEqual(withLink.map((p) => p.agent), ['Atlas', 'Mira']);
  assert.match(withLink[0].task, /instagram\.com\/example\//);
  const withoutLink = subAgentPlan('Study an Instagram page and recreate the same style');
  assert.deepEqual(withoutLink, []);
});

test('an answer is shown with the pages it read and how many steps it took', async () => {
  const complete = scripted([
    '{"type":"search","query":"pizza","why":"look it up"}',
    '{"type":"open","url":"https://en.wikipedia.org/wiki/Pizza","why":"read the article"}',
    '{"type":"finish","answer":"Pizza is a dish from Naples.","cite":["https://en.wikipedia.org/wiki/Pizza"],"why":"it is in the article"}',
  ]);
  const r = await runSearchRoute('Browse the web for pizza', { complete, fetcher: wikipedia });
  assert.equal(r.status, 'answered');
  assert.match(r.text, /^Pizza is a dish from Naples\./);
  assert.match(r.text, /Sources I read:\n1\. https:\/\/en\.wikipedia\.org\/wiki\/Pizza/);
  assert.match(r.text, /\(3 steps, 1 page read\)/);
});

test('a model that gives no plan ends the search honestly, with no invented answer', async () => {
  const r = await runSearchRoute('Search the web for pizza', { complete: scripted(['']), fetcher: wikipedia });
  assert.equal(r.status, 'no_plan');
  assert.match(r.text, /could not decide the next step/);
  assert.doesNotMatch(r.text, /Sources I read/);
});

test('an answer that cites no page it read is refused, not shown', async () => {
  const complete = scripted([
    '{"type":"search","query":"pizza","why":"look it up"}',
    '{"type":"finish","answer":"Pizza is from Rome.","cite":["https://example.com/made-up"],"why":"guess"}',
  ]);
  const r = await runSearchRoute('Browse for pizza', { complete, fetcher: wikipedia });
  assert.equal(r.status, 'not_found');
  assert.match(r.text, /read no page that answers that/);
});

test('a robots.txt block is reported as the reason the page was not read', async () => {
  const complete = scripted([
    '{"type":"open","url":"https://en.wikipedia.org/private/x","why":"read it"}',
    '{"type":"finish","answer":"x","cite":["https://en.wikipedia.org/private/x"],"why":"x"}',
  ]);
  const r = await runSearchRoute('Browse the private page', { complete, fetcher: wikipedia });
  assert.notEqual(r.status, 'answered');
  assert.match(r.text, /robots|read/i);
});

test('browseReply gives the real reason for each status it does not answer', () => {
  assert.match(browseReply({ status: 'budget_exhausted', steps: [{}], observations: [] }), /ran out of steps/);
  assert.match(browseReply({ status: 'needs_owner', reason: 'Please complete the check.', steps: [], observations: [] }), /need you\. Please complete the check\./);
  assert.match(browseReply({ status: 'held', reason: 'Spending money needs your yes first.', steps: [], observations: [] }), /waits for your yes/);
});

test('a study of a link is handed to REA as its inspect request, with the link alone as the target', () => {
  const parsed = parseReaRequest('REA inspect: https://www.instagram.com/example/reel/abc123', { history: [] });
  assert.equal(parsed.command, 'inspect');
  assert.equal(parsed.input, 'https://www.instagram.com/example/reel/abc123');
});
