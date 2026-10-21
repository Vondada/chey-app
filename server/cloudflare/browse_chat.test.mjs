// The owner's chat routed into the browsing loop and the sub-agents. Fixtures only; nothing reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSoul, browseIntent, browseReply, pickOfficeAgent, runBrowseTask, runSearchRoute, subAgentPlan } from './browse_chat.js';
import { queueNextJob } from './agent_runtime.js';
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

test('a study with a link is research first, with the content job after it; a story is content only', () => {
  const study = subAgentPlan('Study https://www.instagram.com/example/ and recreate the same style. Then write an original story.', { url: 'https://www.instagram.com/example/' });
  assert.equal(study.length, 1, 'one research job; the content job travels with it');
  assert.match(study[0].task, /instagram\.com\/example\//);
  assert.ok(study[0].needs.includes('research'));
  assert.ok(study[0].next.needs.includes('video') || study[0].next.needs.includes('content'));
  const story = subAgentPlan('Write an original story about a lighthouse keeper');
  assert.equal(story.length, 1);
  assert.ok(story[0].needs.includes('story'));
  assert.equal(story[0].next, undefined);
  assert.deepEqual(subAgentPlan('Study an Instagram page and recreate the same style'), [], 'no link, no job: the owner is asked for it');
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

test('a job goes to the team member whose job description fits it, never by name, and nobody is hired', () => {
  const team = [
    { name: 'Nova', role: 'Product / listings', specialty: 'Product offers', retired: false },
    { name: 'Atlas', role: 'Research / scout', specialty: 'Research, sourcing, competitive checks', retired: false },
    { name: 'Lyra', role: 'Content / social', specialty: 'Content, social copy and campaign drafts', retired: false },
    { name: 'Vale', role: 'Writing', specialty: 'Original stories', retired: true },
  ];
  assert.equal(pickOfficeAgent(team, { needs: ['research', 'study'] }).name, 'Atlas');
  assert.equal(pickOfficeAgent(team, { needs: ['content', 'video', 'story'] }).name, 'Lyra');
  assert.equal(pickOfficeAgent(team, { needs: ['trade'] }), null, 'no trader on the team: nobody is hired');
  assert.equal(pickOfficeAgent(team, { needs: ['story'] }), null, 'a retired agent is never used');
  assert.equal(pickOfficeAgent([], { needs: ['research'] }), null);
});

test('an agent\'s loop uses its own personality and its job at CHE', () => {
  const soul = agentSoul({ personality: 'Dry and precise.', role: 'Research / scout', specialty: 'Sourcing' });
  assert.match(soul, /Dry and precise\./);
  assert.match(soul, /Your job at CHE: Research \/ scout \(Sourcing\)/);
});

test('a finished research job hands its result to the content job, to the agent whose job fits it', () => {
  const data = { team: [
    { id: 'a', name: 'Atlas', role: 'Research / scout', specialty: 'Research, sourcing', retired: false },
    { id: 'l', name: 'Lyra', role: 'Content / social', specialty: 'Video content and campaign drafts', retired: false },
  ], team_tasks: [] };
  const research = { id: 't1', task: 'Study the page', result: 'Pacing is fast; captions on every shot.', next: { needs: ['content', 'video'], label: 'make a video in the same style', task: 'Make the video plan.' } };
  const queued = queueNextJob(data, research, data.team[0]);
  assert.equal(queued.partner_name, 'Lyra');
  assert.match(queued.task, /RESEARCH FROM Atlas:\nPacing is fast; captions on every shot\./);
  assert.equal(research.next, null);
  assert.equal(research.next_queued_to, 'Lyra');
});

test('with no content agent on the team, the hand-off is recorded as blocked and nobody is hired', () => {
  const data = { team: [{ id: 'a', name: 'Atlas', role: 'Research / scout', specialty: 'Research', retired: false }], team_tasks: [] };
  const research = { id: 't2', task: 'Study', result: 'Done.', next: { needs: ['content', 'video'], label: 'make a video', task: 'Make it.' } };
  assert.equal(queueNextJob(data, research, data.team[0]), null);
  assert.match(research.next_blocked, /Nobody was hired/);
  assert.equal(data.team.length, 1);
});

test('a browsing task runs the loop with the agent\'s own planner and keeps the pages it reads', async () => {
  const fetcher = routes({
    ...DNS,
    'api.php': () => json({ query: { search: [{ title: 'Pizza', snippet: 'A dish' }] } }),
    'robots.txt': () => text('User-agent: *\nDisallow: /private'),
    '/wiki/Pizza': () => text('<h1>Pizza</h1><p>Pizza is a dish from Naples.</p>'),
  });
  const kept = [];
  const replies = [
    '{"type":"search","query":"pizza","why":"look it up"}',
    '{"type":"open","url":"https://en.wikipedia.org/wiki/Pizza","why":"read it"}',
    '{"type":"finish","answer":"Pizza is a dish from Naples.","cite":["https://en.wikipedia.org/wiki/Pizza"],"why":"read"}',
  ];
  const run = await runBrowseTask({
    question: 'Study pizza', soul: 'Warm and brief.', fetcher,
    complete: async ({ system }) => { assert.match(system, /Warm and brief\./); return replies.shift(); },
    keepReads: (question, observations) => { kept.push(...observations.filter((o) => o.read).map((o) => o.url)); return kept.length; },
  });
  assert.equal(run.status, 'answered');
  assert.match(run.text, /Pizza is a dish from Naples\./);
  assert.deepEqual(kept, ['https://en.wikipedia.org/wiki/Pizza']);
});
