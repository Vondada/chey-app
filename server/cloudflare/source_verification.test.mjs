// Owner mission 2026-10-15: asked for the biggest AI news of the day, CHE
// cited an MIT Technology Review article about a Google model "MedMind"; the
// link returned HTTP 404 and nothing corroborated it. Every Chat scenario here
// goes through the real /api/chat route, against a simulated web (listings
// and article pages), and checks the reply the owner would see and hear.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { replyFromNdjson } from './brain_memory.js';
import { rememberKnowledge, researchHit, researchKey } from './knowledge_cache.js';
import {
  articleMeta, claimTerms, datesIn, DISPROVEN_CLAIMS_KEY, fetchArticle, guardCitations, newsQuestion, titleMatch,
} from './source_verification.js';
import { guardClaimedResearchActions } from './truth_layer.js';

const generated = new URL('./.source_verification.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let mod;
try { mod = await import(generated.href + '?t=' + Date.now()); } finally { try { unlinkSync(generated); } catch (_) {} }
const { default: worker, CheState } = mod;

// ─── A simulated web ───────────────────────────────────────────────────────

const MEDGEMMA_URL = 'https://research.google/blog/medgemma-open-models/';
const VERGE_URL = 'https://www.theverge.com/2026/10/15/medgemma-tested';
const MEDMIND_URL = 'https://www.technologyreview.com/2026/10/15/1123456/google-ai-beats-human-professionals-medical-imaging/';
const MEDGEMMA_TITLE = 'MedGemma: open models for medical text and image comprehension';

function html({ title, site, published, author = '', body }) {
  return `<!doctype html><html><head><title>${title} | ${site}</title>
<meta property="og:title" content="${title}"><meta property="og:site_name" content="${site}">
<meta property="article:published_time" content="${published}"><meta name="author" content="${author}">
<meta name="description" content="${body.slice(0, 160)}"></head>
<body><nav>Menu</nav><article><h1>${title}</h1><p>${body}</p></article><script>var x = 1;</script></body></html>`;
}

const PAGES = {
  [MEDGEMMA_URL]: html({
    title: MEDGEMMA_TITLE, site: 'Google Research', published: '2026-10-15T14:00:00Z', author: 'Google Health AI team',
    body: 'Today we are releasing MedGemma, a collection of open models for medical text and image comprehension. MedGemma 4B scored 92% on the MedQA benchmark. Developers can adapt MedGemma for radiology, pathology and clinical notes.',
  }),
  [VERGE_URL]: html({
    title: 'Google’s MedGemma medical AI models, tested', site: 'The Verge', published: '2026-10-15T18:30:00Z',
    body: 'In our independent testing MedGemma scored 85% on a sample of MedQA questions, below the figure Google reported.',
  }),
};

function listings({ gdelt = [], hn = [] } = {}) {
  return {
    gdelt: () => Response.json({ articles: gdelt }),
    hn: () => Response.json({ hits: hn }),
  };
}

/** Routes every outbound request; returns the list of URLs asked for. */
function useWeb({ list = listings(), pages = PAGES, down = false } = {}) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    calls.push(url);
    if (down) throw new TypeError('fetch failed (network down)');
    if (url.startsWith('https://api.gdeltproject.org/')) return list.gdelt(url);
    if (url.startsWith('https://hn.algolia.com/')) return list.hn(url);
    if (pages[url]) return new Response(pages[url], { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.startsWith('https://www.technologyreview.com/')) return new Response('<html><title>Page not found</title></html>', { status: 404 });
    if (url.startsWith('https://docs.flutter.dev/')) return new Response(html({ title: 'Install Flutter', site: 'Flutter', published: '', body: 'Install Flutter on macOS, Windows or Linux.' }), { status: 200 });
    throw new TypeError(`fetch failed (offline: ${new URL(url).host})`);
  };
  return calls;
}

const MEDGEMMA_LISTING = { url: MEDGEMMA_URL, title: MEDGEMMA_TITLE, seendate: '20261015T140000Z', domain: 'research.google' };
const VERGE_LISTING = { url: VERGE_URL, title: 'Google’s MedGemma medical AI models, tested', seendate: '20261015T183000Z', domain: 'theverge.com' };

// ─── A paired owner phone talking to CHE ───────────────────────────────────

function storageFor(saved) {
  return {
    get: async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : undefined),
    put: async (key, value) => saved.set(key, structuredClone(value)),
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}

async function owner({ saved = new Map(), model = () => 'Understood, sir.' } = {}) {
  const counter = { calls: 0, prompts: [] };
  let answer = model;
  const env = {
    CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1',
    AI: {
      run: async (_model, input) => {
        counter.calls += 1;
        counter.prompts.push(String(input?.messages?.[0]?.content || ''));
        return { response: answer(input) };
      },
    },
  };
  const state = new CheState({ storage: storageFor(saved) }, env);
  env.CHE_STATE = { getByName: () => state };
  const send = (path, body, token = '') => worker.fetch(new Request(`https://che.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), env);
  const token = (await (await send('/api/pair', { code: '123456' })).json()).device_token;
  const history = [];
  const say = async (message, extra = {}) => {
    const before = counter.calls;
    const res = await send('/api/chat', { message, history: extra.history ?? history.slice(), ...extra }, token);
    const raw = await res.text();
    const lines = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = lines.find((item) => item.type === 'done') || {};
    // What the phone shows and speaks: the streamed deltas, joined.
    const reply = replyFromNdjson(raw);
    if (!extra.history) history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return { reply, meta: done, deltas: lines.filter((l) => l.type === 'delta').length, modelCalls: counter.calls - before };
  };
  // The same phone and CHE, with the model now saying something else.
  const setModel = (next) => { answer = next; };
  return { say, saved, history, counter, setModel, state, token, send };
}

const MEDMIND_REPLY = `The biggest AI news story on October 15, 2026 was Google's release of MedMind, a medical AI model. According to MIT Technology Review's article "Google AI Beats Human Professionals in Medical Imaging Diagnosis" (published October 15, 2026), MedMind outperformed radiologists on imaging benchmarks. Source: ${MEDMIND_URL}`;
const NEWS_QUESTION = 'What was the biggest AI news story on October 15, 2026?';

// ─── The owner's failure, end to end ──────────────────────────────────────

test('the fake MedMind article with its 404 link never reaches the owner, and is recorded', async () => {
  const calls = useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }) });
  const che = await owner({ model: () => MEDMIND_REPLY });
  const out = await che.say(NEWS_QUESTION);

  // The correction may name what it could not find; it never states the claim.
  assert.doesNotMatch(out.reply, /release of MedMind|Google AI Beats|outperformed radiologists|medical imaging/);
  assert.match(out.reply, /^I can't verify that, sir:/);
  assert.match(out.reply, /the technologyreview\.com link returns a page that does not exist \(404\)/);
  assert.match(out.reply, /no article I retrieved mentions MedMind/);
  // The real article was retrieved, opened and given to the model as the only news it may state.
  assert.ok(calls.some((u) => u.startsWith('https://api.gdeltproject.org/')), 'news listings were read');
  assert.ok(calls.includes(MEDGEMMA_URL), 'the listed article was opened');
  assert.ok(calls.includes(MEDMIND_URL), 'the cited link was opened');
  const prompt = che.counter.prompts.find((p) => p.includes('SOURCE RULES'));
  assert.match(prompt, /VERIFIED SOURCES/);
  assert.match(prompt, /Google Research \| "MedGemma: open models/);

  const recorded = che.saved.get(DISPROVEN_CLAIMS_KEY);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'broken_citation');
  assert.equal(recorded[0].status, 404);
  assert.ok(recorded[0].terms.includes('MedMind'), 'its claim needs a source before CHE says it again');

  // Later, in an ordinary question, the model repeats the claim: it is caught.
  che.setModel(() => 'MedMind is Google\'s new medical imaging model, and it beat radiologists. Ask me anything else.');
  const again = await che.say('Tell me about MedMind.');
  assert.doesNotMatch(again.reply, /beat radiologists/);
  assert.match(again.reply, /^I can't verify that, sir: I earlier gave this without a working source \(the technologyreview\.com link returns a page that does not exist \(404\)\)/);
});

test('a real MedGemma article is verified and its source receipt is given', async () => {
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }) });
  const che = await owner({
    model: () => `Google Research published "${MEDGEMMA_TITLE}" on October 15, 2026, releasing MedGemma, a collection of open models for medical text and image comprehension. Source: ${MEDGEMMA_URL}`,
  });
  const out = await che.say(NEWS_QUESTION);
  assert.match(out.reply, /releasing MedGemma, a collection of open models/);
  assert.match(out.reply, /Sources I opened: Google Research, "MedGemma: open models for medical text and image comprehension" \(Oct 15, 2026\) https:\/\/research\.google\/blog\/medgemma-open-models\//);
  assert.match(out.reply, /Only one outlet I opened reports this, so it is not independently confirmed\./);
  assert.ok(out.deltas >= 1, 'streamed to the phone as sentence deltas');
  assert.equal(che.saved.get(DISPROVEN_CLAIMS_KEY), undefined);
});

test('two outlets carrying the story are reported as corroboration', async () => {
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING, VERGE_LISTING] }) });
  const che = await owner({ model: () => 'Google released MedGemma, open medical AI models, according to Google Research and The Verge.' });
  const out = await che.say(NEWS_QUESTION);
  assert.match(out.reply, /Google released MedGemma/);
  assert.match(out.reply, /2 independent outlets I opened report it\./);
});

test('an invented headline or publication date is caught against the real page', async () => {
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }) });
  const headline = await (await owner({
    model: () => `Google Research reported "Google AI Beats Doctors At Every Diagnosis" this week: ${MEDGEMMA_URL}. It is a big step for medicine, sir.`,
  })).say('What did Google Research publish about medical AI this week? Any news?');
  assert.doesNotMatch(headline.reply, /Beats Doctors/);
  assert.match(headline.reply, /the research\.google page is titled "MedGemma: open models for medical text and image comprehension", not the headline I gave/);

  const dated = await (await owner({
    model: () => `Google Research published "${MEDGEMMA_TITLE}" on October 12, 2026. Source: ${MEDGEMMA_URL}`,
  })).say(NEWS_QUESTION);
  assert.doesNotMatch(dated.reply, /October 12/);
  assert.match(dated.reply, /Google Research published it on Oct 15, 2026, not Oct 12, 2026/);
});

test('a real source that does not support the claim does not lend it credibility', async () => {
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }) });
  const che = await owner({
    model: () => `According to Google Research, MedGemma beat radiologists by 30% (${MEDGEMMA_URL}). The models are open for developers.`,
  });
  const out = await che.say(NEWS_QUESTION);
  assert.doesNotMatch(out.reply, /beat radiologists by 30%/);
  assert.match(out.reply, /Google Research's page does not mention 30%/);
});

test('conflicting credible sources are reported, not smoothed over', async () => {
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING, VERGE_LISTING] }) });
  const che = await owner({ model: () => 'MedGemma 4B scored 92% on the MedQA benchmark, according to Google Research.' });
  const out = await che.say(NEWS_QUESTION);
  assert.match(out.reply, /MedGemma 4B scored 92%/);
  assert.match(out.reply, /Sources differ: Google Research reports 92%, but The Verge reports 85%\./);
});

test('with research tools unavailable CHE says so and invents nothing', async () => {
  useWeb({ down: true });
  const che = await owner({ model: () => MEDMIND_REPLY });
  const out = await che.say(NEWS_QUESTION);
  assert.doesNotMatch(out.reply, /MedMind|Google AI Beats/);
  assert.match(out.reply, /I could not retrieve news articles just now \(No news article about AI for Oct 15, 2026 could be retrieved and checked/);
  assert.match(out.reply, /so I won't name headlines or stories I can't check/);
  const prompt = che.counter.prompts.find((p) => p.includes('SOURCE RULES'));
  assert.match(prompt, /NO NEWS ARTICLE WAS RETRIEVED THIS TURN/, 'the model is told before it answers');
});

test('fabricated browsing and code reading are corrected', async () => {
  useWeb({ down: true });
  const opened = await (await owner({ model: () => 'I opened the Google Research article and MedGemma is fully open source, sir.' }))
    .say('Is MedGemma open source?');
  assert.match(opened.reply, /^I need to correct that, sir: I do not have execution receipts/);
  const code = await (await owner({ model: () => 'I read through your code and the router is fine.' }))
    .say('Is my router okay?');
  assert.match(code.reply, /I did not read any code for this answer/);
  // Honest phrasing is untouched.
  assert.equal(guardClaimedResearchActions("I haven't opened the article yet. Want me to?").corrected, false);
});

test('incorrect cached research is invalidated when the owner shows it is false, and not repeated', async () => {
  useWeb({ list: listings() });
  const saved = new Map();
  const question = 'What is MedMind?';
  // A research answer cached earlier with a link (the old, unverified path).
  await rememberKnowledge(storageFor(saved), {
    key: researchKey(question), answer: 'MedMind is Google\'s medical imaging model that beats radiologists.',
    sources: [MEDMIND_URL], source: 'research_library', verified: true, confidence: 0.9,
  });
  assert.ok(await researchHit(storageFor(saved), question), 'cached before the correction');
  const che = await owner({ saved, model: () => 'Okay, sir.' });
  await che.say('hello');
  const data = saved.get('che');
  data.learned_knowledge = [...(data.learned_knowledge || []), 'MedMind (Google) beats radiologists on imaging.'];
  data.memory_notes = [{ id: 'n1', title: 'MedMind launch', bullets: ['Google released MedMind on Oct 15.'] }, ...(data.memory_notes || [])];
  saved.set('che', data);

  const history = [
    { role: 'user', content: NEWS_QUESTION },
    { role: 'assistant', content: MEDMIND_REPLY },
  ];
  const out = await che.say("That article doesn't exist, sir. The link gives a 404.", { history });
  assert.equal(out.meta.source, 'che_source_check');
  assert.equal(out.modelCalls, 0, 'checked with no model');
  assert.match(out.reply, /^You're right to question it, sir\. I checked again just now: the technologyreview\.com link returns a page that does not exist \(404\); I found no article that mentions MedMind\./);
  assert.match(out.reply, /My earlier answer presented an unverified claim as fact, and that was wrong\./);

  // Reconciled: nothing deleted, everything downgraded.
  assert.equal(await researchHit(storageFor(saved), question), null, 'the cached answer is no longer reused');
  const entry = saved.get(`kc:${researchKey(question)}`);
  assert.equal(entry.verification_status, 'invalidated');
  assert.match(entry.answer, /MedMind/, 'kept for history');
  const after = saved.get('che');
  assert.ok(!after.learned_knowledge.some((l) => /MedMind/.test(l)));
  assert.ok(after.invalidated_knowledge.some((l) => /MedMind/.test(l.text)));
  assert.equal(after.memory_notes.find((n) => n.id === 'n1').verification_status, 'disproven');

  // Asked again, the model's memory of it is not stated as fact, and its
  // prompt lists the claim as checked and unsupported.
  che.setModel(() => 'MedMind is Google\'s medical imaging model that beats radiologists.');
  const repeat = await che.say(question);
  assert.notEqual(repeat.meta.source, 'che_research_cache', 'the invalidated cache did not answer');
  assert.doesNotMatch(repeat.reply, /beats radiologists/);
  assert.match(repeat.reply, /I earlier gave this without a working source/);
  const prompt = che.counter.prompts.find((p) => p.includes('CLAIMS CHECKED AND NOT SUPPORTED'));
  assert.match(prompt, /MedMind/);
  assert.doesNotMatch(prompt, /MedMind \(Google\) beats radiologists on imaging/, 'the downgraded line is not given as knowledge');
});

test('a real article the owner doubts is checked and kept, with its source', async () => {
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }) });
  const che = await owner({ model: () => 'Okay, sir.' });
  const history = [
    { role: 'user', content: NEWS_QUESTION },
    { role: 'assistant', content: `Google Research released MedGemma, open models for medical text and image comprehension. Source: ${MEDGEMMA_URL}` },
  ];
  const out = await che.say('Is that article real?', { history });
  assert.equal(out.meta.source, 'che_source_check');
  assert.match(out.reply, /^I checked again, sir: the link works: Google Research published "MedGemma: open models for medical text and image comprehension" on Oct 15, 2026, and it does say what I told you\. I'm keeping that answer, with that source\./);
  assert.equal(che.saved.get(DISPROVEN_CLAIMS_KEY), undefined);
});

test('ordinary answers keep working, fast, with no source checks they do not need', async () => {
  const calls = useWeb({ down: false });
  const plain = await (await owner({ model: () => 'Paris is the capital of France, sir.' })).say('What is the capital of France?');
  assert.equal(plain.reply, 'Paris is the capital of France, sir.');
  assert.equal(calls.length, 0, 'no page was opened for established knowledge');

  const link = await (await owner({ model: () => 'Follow the official guide at https://docs.flutter.dev/get-started/install to install Flutter.' }))
    .say('How do I install Flutter?');
  assert.equal(link.reply, 'Follow the official guide at https://docs.flutter.dev/get-started/install to install Flutter.');

  const memory = await (await owner({ model: () => 'Wired reported in 2007 that the iPhone "changed everything about phones". It was a big moment.' }))
    .say('What did people say about the first iPhone?');
  assert.match(memory.reply, /^Wired reported in 2007/);
  assert.match(memory.reply, /I did not open Wired just now, so treat that reference as from memory, not checked\./);

  const story = await (await owner({ model: () => 'BREAKING: Google released MedMind today, according to the Daily Planet.' }))
    .say('Write a fake news story about a robot, for my novel.');
  assert.match(story.reply, /BREAKING: Google released MedMind today/, 'fiction the owner asked for is untouched');
});

// ─── Units ─────────────────────────────────────────────────────────────────

test('articleMeta reads title, publisher, date and author in any attribute order', () => {
  const meta = articleMeta('<html><head><title>Fallback</title><meta content="Real Title &amp; More" property="og:title"><meta name="author" content="Ada"><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-14T09:00:00Z","publisher":{"name":"Example News"}}</script></head><body><p>Hello world</p></body></html>', 'https://www.example.com/a');
  assert.equal(meta.title, 'Real Title & More');
  assert.equal(meta.published, '2026-10-14T09:00:00Z');
  assert.equal(meta.publisher, 'Example News');
  assert.equal(meta.author, 'Ada');
  assert.match(meta.text, /Hello world/);
});

test('fetchArticle tells broken from blocked', async () => {
  const fetcher = async (url) => (url.includes('gone') ? new Response('x', { status: 404 })
    : url.includes('soft') ? new Response('<title>Page Not Found</title>', { status: 200 })
      : url.includes('blocked') ? new Response('no', { status: 403 }) : new Response('<title>Ok page</title>', { status: 200 }));
  assert.equal((await fetchArticle('https://a.example/gone', { fetcher })).broken, true);
  assert.equal((await fetchArticle('https://a.example/soft', { fetcher })).broken, true);
  const blocked = await fetchArticle('https://a.example/blocked', { fetcher });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.broken, false, 'a 403 is not evidence the page is gone');
  assert.equal((await fetchArticle('https://a.example/fine', { fetcher })).ok, true);
});

test('source-check redirects never fetch a private or action destination', async () => {
  const visited = [];
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'manual', 'automatic redirects would execute an unchecked GET');
    visited.push(url);
    if (url === 'https://a.example/private') return Response.redirect('https://docs.google.com/document/d/private/edit', 302);
    if (url === 'https://a.example/action') return Response.redirect('https://news.example.com/unsubscribe?token=abc', 302);
    if (url === 'https://a.example/safe') return Response.redirect('https://b.example/story', 302);
    if (url === 'https://b.example/story') return new Response('<html><title>A real story</title><article>Safe article</article></html>', { status: 200 });
    throw new Error('unsafe redirect destination was opened');
  };
  for (const name of ['private', 'action']) {
    visited.length = 0;
    const result = await fetchArticle(`https://a.example/${name}`, { fetcher });
    assert.equal(result.ok, false);
    assert.match(result.error, /redirect to a private or action link/);
    assert.deepEqual(visited, [`https://a.example/${name}`]);
  }
  visited.length = 0;
  const safe = await fetchArticle('https://a.example/safe', { fetcher });
  assert.equal(safe.ok, true);
  assert.equal(safe.final_url, 'https://b.example/story');
  assert.deepEqual(visited, ['https://a.example/safe', 'https://b.example/story']);
});

test('a bare citation URL on a factual sentence is opened even if the owner supplied it', async () => {
  const url = 'https://a.example/clinical-trial';
  const visited = [];
  const checked = await guardCitations(`MegaCure reduced disease by 95% (${url})`, {
    message: `Can you verify ${url}?`, trusted: [url],
    fetcher: async (target) => { visited.push(target); return new Response('gone', { status: 404 }); },
  });
  assert.deepEqual(visited, [url]);
  assert.equal(checked.removed.length, 1);
  assert.doesNotMatch(checked.text, /MegaCure reduced disease/);
});

test('news questions are recognised; fiction and personal chat are not', () => {
  const now = Date.parse('2026-10-15T20:00:00Z');
  const q = newsQuestion(NEWS_QUESTION, now);
  assert.equal(q.topic, 'ai');
  assert.equal(q.label, 'Oct 15, 2026');
  assert.ok(newsQuestion("What's the latest news in tech?", now));
  assert.ok(newsQuestion('Did Apple announce anything today?', now));
  assert.ok(newsQuestion('CHE, tell me the latest news', now));
  assert.ok(newsQuestion('Please update me on AI news today', now));
  assert.ok(newsQuestion('Could I get AI news today', now));
  assert.ok(newsQuestion('AI news today', now));
  for (const personal of [
    'I have good news: my baby was born.',
    'I got some breaking news from my sister.',
    'My biggest news today is that I got the job.',
  ]) assert.equal(newsQuestion(personal, now), null, personal);
  assert.equal(newsQuestion('Write a news story about a robot uprising', now), null);
  assert.equal(newsQuestion('How are you today?', now), null);
  assert.equal(newsQuestion('What is the capital of France?', now), null);
  assert.deepEqual(datesIn('published Oct. 15, 2026 and 2026-10-14', now), ['2026-10-15', '2026-10-14']);
});

test('claim terms are the specific things a source must say', () => {
  const t = claimTerms('Google released MedMind, which scored 92% against GPT-5 in October.');
  assert.deepEqual(t.hard.sort(), ['92%', 'GPT-5', 'MedMind'].sort());
  assert.deepEqual(t.soft, []);
  assert.ok(titleMatch('MedGemma open models', MEDGEMMA_TITLE) >= 0.6);
  assert.ok(titleMatch('Google AI Beats Human Professionals', MEDGEMMA_TITLE) < 0.3);
});

test('a reply with no citations is returned as is, with nothing opened', async () => {
  let opened = 0;
  const out = await guardCitations('Sure, sir. I will remind you at 5.', { message: 'remind me at 5', fetcher: async () => { opened += 1; return new Response(''); } });
  assert.equal(out.text, 'Sure, sir. I will remind you at 5.');
  assert.equal(opened, 0);
});

// ─── Review findings (2026-10-15) ──────────────────────────────────────────

test('only links offered as sources are opened: never private, one-click or connector links', async () => {
  const calls = useWeb({ down: false });
  const che = await owner({ model: () => 'Your file Budget Plan is at https://docs.google.com/document/d/abc123/edit. Unsubscribe here: https://news.example.com/unsubscribe?token=xyz. The guide is at https://docs.flutter.dev/get-started/install.' });
  const out = await che.say('Where is my budget plan?');
  assert.match(out.reply, /^Your file Budget Plan is at https:\/\/docs\.google\.com/);
  assert.match(out.reply, /unsubscribe\?token=xyz/);
  assert.deepEqual(calls.filter((u) => /docs\.google|unsubscribe|docs\.flutter/.test(u)), [], 'none of them was fetched');
});

test('a URL provided by the owner is input, not a verified article', async () => {
  const calls = useWeb();
  const che = await owner({ model: () => MEDMIND_REPLY });
  const out = await che.say(`Summarize this article: ${MEDMIND_URL}`);
  assert.ok(calls.includes(MEDMIND_URL), 'the public citation is opened despite appearing in the owner prompt');
  assert.doesNotMatch(out.reply, /outperformed radiologists|release of MedMind/);
  assert.match(out.reply, /technologyreview\.com link returns a page that does not exist/);
});

test('private or one-click source links are never fetched or counted as evidence', async () => {
  const source = 'https://docs.google.com/document/d/abc123/edit';
  let fetched = 0;
  const out = await guardCitations(`According to a study at ${source}, MegaCure reduced disease by 95%.`, {
    message: 'Summarize this study', trusted: [source],
    fetcher: async () => { fetched += 1; throw new Error('unsafe fetch'); },
  });
  assert.equal(fetched, 0, 'no request is sent to a private document');
  assert.equal(out.removed.length, 1);
  assert.doesNotMatch(out.text, /MegaCure reduced disease/);
  assert.match(out.text, /cannot safely check/);
});

test('personal good news stays a conversation, never a current-news search', async () => {
  const calls = useWeb({ down: true });
  const che = await owner({ model: () => 'Congratulations, sir. That is wonderful news!' });
  const out = await che.say('I have good news: my baby was born.');
  assert.match(out.reply, /Congratulations/);
  assert.equal(calls.filter((u) => /api\.gdeltproject|hn\.algolia/.test(u)).length, 0);
});

test('a real name in a made-up story is never recorded as suspect', async () => {
  useWeb({ list: listings() });
  const che = await owner({ model: () => 'OpenAI announced its new model in an article at https://www.technologyreview.com/2026/10/15/openai-model/.' });
  await che.say('Tell me about the new OpenAI model.');
  const recorded = che.saved.get(DISPROVEN_CLAIMS_KEY) || [];
  assert.equal(recorded.length, 1, 'the broken link is recorded');
  assert.deepEqual(recorded[0].terms, [], 'OpenAI itself is not');
});

test('an ordinary correction is not taken for a disputed source', async () => {
  useWeb({ down: true });
  const che = await owner({ model: () => 'Got it, sir: your other video, "Morning Routine", has 52% retention.' });
  const out = await che.say("That's wrong, I meant my other video", {
    history: [{ role: 'user', content: 'How is my video doing?' }, { role: 'assistant', content: 'Your YouTube video has 40% retention this week.' }],
  });
  assert.notEqual(out.meta.source, 'che_source_check');
  assert.match(out.reply, /other video/);
  assert.equal(che.saved.get(DISPROVEN_CLAIMS_KEY), undefined);
});

test('an answer with no link of its own, which real articles do mention, is not called false', async () => {
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }) });
  const che = await owner({ model: () => 'Okay, sir.' });
  const out = await che.say("MedGemma isn't real", {
    history: [{ role: 'user', content: 'What did Google release?' }, { role: 'assistant', content: 'Google released MedGemma, open medical AI models.' }],
  });
  assert.equal(out.meta.source, 'che_source_check');
  assert.match(out.reply, /^I checked again, sir\. My earlier answer gave no source, but I found an article that mention MedGemma: Google Research, "MedGemma: open models/);
  assert.equal(che.saved.get(DISPROVEN_CLAIMS_KEY), undefined, 'nothing is recorded as false');
});

test('code the owner pasted counts as read; two verified links both back a claim', async () => {
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING, VERGE_LISTING] }) });
  const pasted = await (await owner({ model: () => "I've reviewed your code: the loop stops one item early." }))
    .say('What is wrong with this?\n```js\nfor (let i = 0; i < items.length - 1; i++) total += items[i];\n```');
  assert.match(pasted.reply, /^I've reviewed your code: the loop stops one item early\./);

  const both = await (await owner({ model: () => `Google released MedGemma, as reported at ${MEDGEMMA_URL} and ${VERGE_URL}.` })).say(NEWS_QUESTION);
  assert.match(both.reply, /^Google released MedGemma, as reported at/);
  assert.match(both.reply, /2 independent outlets I opened report it\./);
});

test('outside news, a link that does not back an unattributed sentence is said plainly, not deleted', async () => {
  useWeb({ down: false });
  const che = await owner({ model: () => 'MedGemma 4B runs on a single GPU; see the source at https://research.google/blog/medgemma-open-models/ for MedGemma details and the H100 setup.' });
  const out = await che.say('Can MedGemma run on one GPU?');
  assert.match(out.reply, /^MedGemma 4B runs on a single GPU/);
  assert.match(out.reply, /\n\nThe research\.google page does not mention GPU, so it does not back what I said there\./);
});

// ─── Codex review of #315 ──────────────────────────────────────────────────

const TECH_NEWS = 'What is the biggest tech news today?';
const AT = Date.parse('2026-10-15T20:00:00Z');
const appleArticle = (overrides = {}) => ({
  ok: true, url: 'https://www.theverge.com/2026/10/15/apple-iphone-air', final_url: 'https://www.theverge.com/2026/10/15/apple-iphone-air',
  title: 'Apple launches the iPhone Air, its thinnest phone yet', publisher: 'The Verge', host: 'theverge.com', published: '2026-10-15T15:00:00Z',
  description: 'Apple on Wednesday launched the iPhone Air.', text: 'Apple launched the iPhone Air today, its thinnest phone ever at 5.6 millimetres.', ...overrides,
});
const offline = async () => { throw new TypeError('fetch failed (offline)'); };

test('a plain news event with no coined name still needs an article that says it', async () => {
  // Codex's example: nothing retrieved, and no CamelCase name, version or figure.
  const none = await guardCitations('Apple launched a thinner phone today.', { message: TECH_NEWS, fetcher: offline, now: AT });
  assert.equal(none.removed.length, 1);
  assert.doesNotMatch(none.text, /thinner phone/);
  assert.match(none.text, /^I can't verify that, sir: no article I retrieved says this about Apple\. I did not retrieve any news article/);

  // An article that says it backs it, with its receipt.
  const backed = await guardCitations('Apple launched a thinner phone today.', { message: TECH_NEWS, research: { engine: 'news', articles: [appleArticle()] }, fetcher: offline, now: AT });
  assert.deepEqual(backed.removed, []);
  assert.match(backed.text, /^Apple launched a thinner phone today\.\n\nSources I opened: The Verge, "Apple launches the iPhone Air/);

  // Another company's story does not back it.
  const samsung = appleArticle({ title: 'Samsung launches its thinnest phone yet', description: 'Samsung on Wednesday launched a thin phone.', text: 'Samsung launched its thinnest phone ever.' });
  const other = await guardCitations('Apple launched a thinner phone today.', { message: TECH_NEWS, research: { engine: 'news', articles: [samsung] }, fetcher: offline, now: AT });
  assert.equal(other.removed.length, 1);

  // Talk about the conversation, questions and labelled background are not news events.
  for (const line of ["I'll report back when I can open the articles.", 'Would you like me to try again?', 'As general background, phone makers usually announce new models in September.']) {
    const kept = await guardCitations(line, { message: TECH_NEWS, fetcher: offline, now: AT });
    assert.deepEqual(kept.removed, [], line);
  }
});

test('a news request finished in the background opens articles and is checked like a chat reply', async () => {
  const calls = useWeb({ down: true });
  const che = await owner({ model: () => 'Apple launched a thinner phone today.' });
  const res = await che.send('/api/job/create', { title: 'Tech news', prompt: TECH_NEWS }, che.token);
  assert.equal(res.status, 200);
  const job = (await res.json()).job;
  await che.state.alarm();
  const done = che.saved.get('che').jobs.find((j) => j.id === job.id);
  assert.equal(done.status, 'complete');
  assert.doesNotMatch(done.result, /thinner phone/);
  assert.match(done.result, /no article I retrieved says this about Apple/);
  assert.match(done.result, /I could not retrieve news articles just now/);
  assert.ok(calls.some((u) => u.startsWith('https://api.gdeltproject.org/')), 'news research ran for the job');
  const prompt = che.counter.prompts.find((text) => text.startsWith('You are CHE background work.'));
  assert.match(prompt, /NO NEWS ARTICLE WAS RETRIEVED \(No news article about tech for .+ could be retrieved and checked/);
  assert.match(prompt, /SOURCE RULES/);
});

test('saved news articles are reopened before they back a reply again', async () => {
  const pages = { ...PAGES };
  const calls = useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }), pages });
  const che = await owner({
    model: () => `Google Research published "${MEDGEMMA_TITLE}" on October 15, 2026, releasing MedGemma, a collection of open models for medical text and image comprehension. Source: ${MEDGEMMA_URL}`,
  });
  const first = await che.say(NEWS_QUESTION);
  assert.match(first.reply, /Sources I opened: Google Research/);

  // Asked again within the cache's 30 minutes: the saved article is opened again.
  calls.length = 0;
  const again = await che.say(NEWS_QUESTION, { history: [] });
  assert.match(again.reply, /Sources I opened: Google Research/);
  assert.ok(calls.includes(MEDGEMMA_URL), 'the saved article was reopened');
  assert.ok(!calls.some((u) => u.startsWith('https://api.gdeltproject.org/')), 'no new search was needed');

  // The page can no longer be opened: the saved copy is not a receipt.
  delete pages[MEDGEMMA_URL];
  calls.length = 0;
  const gone = await che.say(NEWS_QUESTION, { history: [] });
  assert.doesNotMatch(gone.reply, /Sources I opened|releasing MedGemma/);
  assert.ok(calls.some((u) => u.startsWith('https://api.gdeltproject.org/')), 'news was researched afresh');
});

test('two outlets reporting two different stories confirm neither', async () => {
  const tesla = appleArticle({
    url: 'https://www.reuters.com/business/tesla-robotaxi-2026-10-15/', final_url: 'https://www.reuters.com/business/tesla-robotaxi-2026-10-15/',
    title: 'Tesla expands its robotaxi service to Austin', publisher: 'Reuters', host: 'reuters.com',
    description: 'Tesla on Wednesday expanded its robotaxi service.', text: 'Tesla expanded its robotaxi service to Austin today.',
  });
  const research = { engine: 'news', articles: [appleArticle(), tesla] };
  const two = await guardCitations('Apple launched a thinner phone today. Tesla expanded its robotaxi service to Austin.', { message: TECH_NEWS, research, fetcher: offline, now: AT });
  assert.deepEqual(two.removed, []);
  assert.match(two.text, /Each of these 2 stories comes from one outlet I opened, so none is independently confirmed\.$/);
  assert.doesNotMatch(two.text, /independent outlets I opened report it/);

  // Two outlets on the same story do confirm it; a second, single-outlet story does not.
  const engadget = appleArticle({ url: 'https://www.engadget.com/apple-iphone-air.html', final_url: 'https://www.engadget.com/apple-iphone-air.html', publisher: 'Engadget', host: 'engadget.com' });
  const mixed = await guardCitations('Apple launched a thinner phone today. Tesla expanded its robotaxi service to Austin.', { message: TECH_NEWS, research: { engine: 'news', articles: [appleArticle(), engadget, tesla] }, fetcher: offline, now: AT });
  assert.match(mixed.text, /1 of these 2 stories is reported by two or more outlets I opened; the others come from one outlet and are not independently confirmed\.$/);
});
