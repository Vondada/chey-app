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
  articleMeta, claimTerms, datesIn, DISPROVEN_CLAIMS_KEY, fetchArticle, guardCitations, newsQuestion, newsResearch, reopenArticles, titleMatch,
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
  assert.match(out.reply, /Sources I opened: Google Research, "MedGemma: open models for medical text and image comprehension" \(published Oct 15, 2026\) https:\/\/research\.google\/blog\/medgemma-open-models\//);
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
    if (url === 'https://a.example/encoded') return Response.redirect('https://news.example.com/unsub%73cribe/abc', 302);
    if (url === 'https://a.example/double-encoded') return Response.redirect('https://news.example.com/unsub%2573cribe/abc', 302);
    if (url === 'https://a.example/safe') return Response.redirect('https://b.example/story', 302);
    if (url === 'https://b.example/story') return new Response('<html><title>A real story</title><article>Safe article</article></html>', { status: 200 });
    throw new Error('unsafe redirect destination was opened');
  };
  for (const name of ['private', 'action', 'encoded', 'double-encoded']) {
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

test('bare source pointers cannot hide assertions earlier in the sentence', async () => {
  const url = 'https://a.example/trial';
  const calls = [];
  const result = await guardCitations(`MegaCure reduced disease by 95%; the proof is at ${url}`, {
    message: 'Can you verify this study?', trusted: [url],
    fetcher: async (target) => { calls.push(target); return new Response('gone', { status: 404 }); },
  });
  assert.deepEqual(calls, [url]);
  assert.equal(result.removed.length, 1);
  assert.doesNotMatch(result.text, /MegaCure reduced disease/);
});

test('a pointer followed by a medical claim cannot bypass the source guard', async () => {
  const url = 'https://a.example/trial';
  const calls = [];
  const checked = await guardCitations(`The proof is at ${url}; MegaCure reduced disease by 95%.`, {
    message: 'Verify the evidence', trusted: [url],
    fetcher: async (requested) => { calls.push(requested); return new Response('not found', { status: 404 }); },
  });
  assert.deepEqual(calls, [url]);
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

test('a cited non-news medical claim unsupported by the linked article is removed', async () => {
  useWeb({ down: false });
  const che = await owner({ model: () => 'MedGemma 4B runs on a single GPU; see the source at https://research.google/blog/medgemma-open-models/ for MedGemma details and the H100 setup.' });
  const out = await che.say('Can MedGemma run on one GPU?');
  assert.doesNotMatch(out.reply, /^MedGemma 4B runs on a single GPU/);
  assert.match(out.reply, /does not mention GPU/);
});

test('a fabricated treatment rate cited to a recipe is removed, never stated as fact', async () => {
  const url = 'https://a.example/recipe';
  const result = await guardCitations(`MegaCure reduced disease by 95% (${url})`, {
    message: 'What is MegaCure?', trusted: [url],
    fetcher: async () => new Response('<html><title>Best pasta recipe</title><p>Cook pasta in salted water.</p></html>', { status: 200 }),
  });
  assert.equal(result.removed.length, 1);
  assert.doesNotMatch(result.text, /MegaCure reduced disease by 95%/);
});

test('a factual claim inside a file-style pointer is not exempt from source verification', async () => {
  const url = 'https://a.example/trial';
  const calls = [];
  const result = await guardCitations(`The results showing MegaCure reduced disease by 95% are at ${url}.`, {
    message: 'Tell me about the treatment',
    fetcher: async (requested) => { calls.push(requested); return new Response('missing', { status: 404 }); },
  });
  assert.deepEqual(calls, [url]);
  assert.equal(result.removed.length, 1);
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

test('news descriptions without launch verbs still require the article to say them', async () => {
  for (const claim of ["Apple's thinner phone is today's biggest story.", "A thinner Apple phone dominates today's headlines."]) {
    const missing = await guardCitations(claim, { message: TECH_NEWS, fetcher: offline, now: AT });
    assert.equal(missing.removed.length, 1, claim);
    assert.doesNotMatch(missing.text, /thinner Apple phone|Apple's thinner phone/);
  }
  const verified = await guardCitations("Apple's thinner phone is today's biggest story.", {
    message: TECH_NEWS, research: { engine: 'news', articles: [appleArticle()] }, fetcher: offline, now: AT,
  });
  assert.deepEqual(verified.removed, []);
  assert.match(verified.text, /Sources I opened:/);
});

test('short news must match its subject and cannot use stopwords for support', async () => {
  const unrelated = appleArticle({
    title: 'Markets and stocks surged sharply', description: 'Markets and stocks surged sharply',
    text: 'Markets and stocks surged sharply',
  });
  const out = await guardCitations('AI surged today, and it was the biggest news story of the day.', {
    message: TECH_NEWS, research: { engine: 'news', articles: [unrelated] }, fetcher: offline, now: AT,
  });
  assert.equal(out.removed.length, 1);
  assert.doesNotMatch(out.text, /^AI surged/);
});

test('short unsupported news claims never bypass the opened-source check', async () => {
  for (const claim of ['AI surged.', 'Apple is doomed.']) {
    const result = await guardCitations(claim, { message: TECH_NEWS, fetcher: offline, now: AT });
    assert.equal(result.removed.length, 1, claim);
    assert.doesNotMatch(result.text, /AI surged|Apple is doomed/);
  }
  const report = appleArticle({ text: 'Apple is doomed, according to analysts.', description: 'Analysts say Apple is doomed.' });
  const supported = await guardCitations('Apple is doomed.', { message: TECH_NEWS, research: { engine: 'news', articles: [report] }, fetcher: offline, now: AT });
  assert.deepEqual(supported.removed, []);
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

// ─── Codex review of #315 at 21edef7 ───────────────────────────────────────

/** A fetcher serving only these pages; returns the URLs it was asked for. */
function site(pages) {
  const calls = [];
  const fetcher = async (input) => {
    const url = String(input?.url || input);
    calls.push(url);
    if (pages[url]) return new Response(pages[url], { status: 200, headers: { 'content-type': 'text/html' } });
    throw new TypeError(`fetch failed (offline: ${new URL(url).host})`);
  };
  return { fetcher, calls };
}

test('a reference summary is never an opened article', async () => {
  // Research found only a Wikipedia extract; the model repeats it as news anyway.
  const wiki = 'https://en.wikipedia.org/wiki/IPhone_Air';
  const research = { engine: 'wikipedia', summary: 'Apple launched a thinner phone today, the iPhone Air.', sources: [wiki], news_error: 'GDELT answered 503' };
  const news = await guardCitations('Apple launched a thinner phone today.', { message: TECH_NEWS, research, fetcher: offline, now: AT });
  assert.equal(news.removed.length, 1);
  assert.doesNotMatch(news.text, /Sources I opened|thinner phone/);

  // Outside news a cited Wikipedia link is opened for real before it backs anything.
  const claim = `The iPhone Air is Apple's thinnest phone (${wiki}).`;
  const closed = site({});
  const unopened = await guardCitations(claim, { message: 'Tell me about the iPhone Air', research, fetcher: closed.fetcher, now: AT });
  assert.deepEqual(closed.calls, [wiki]);
  assert.equal(unopened.removed.length, 1);
  assert.match(unopened.text, /the en\.wikipedia\.org link could not be opened/);

  const open = site({ [wiki]: html({ title: 'iPhone Air', site: 'Wikipedia', published: '', body: 'The iPhone Air is the thinnest phone Apple has made, announced in September 2025.' }) });
  const opened = await guardCitations(claim, { message: 'Tell me about the iPhone Air', research, fetcher: open.fetcher, now: AT });
  assert.deepEqual(opened.removed, []);
  assert.match(opened.text, /^The iPhone Air is Apple's thinnest phone/);
});

test('a news article needs a publication date from its own page', async () => {
  const URL_OLD = 'https://www.example-news.com/apple-thin-phone';
  const undated = html({ title: 'Apple launches a thinner phone', site: 'Example News', published: '', body: 'Apple launched a thinner phone, its thinnest yet.' });
  // GDELT first saw this page today, but the page itself shows no date: not today's news.
  useWeb({
    list: listings({ gdelt: [{ url: URL_OLD, title: 'Apple launches a thinner phone', seendate: '20261015T120000Z', domain: 'example-news.com' }] }),
    pages: { [URL_OLD]: undated },
  });
  const research = await newsResearch(TECH_NEWS, { now: AT });
  assert.deepEqual(research.articles, []);
  assert.match(research.failed[0].reason, /its page shows no publication date, so I cannot tell it is from Oct 15, 2026/);

  // A dated page keeps its own date, with the listing time kept apart as when it was found.
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }) });
  const dated = await newsResearch(NEWS_QUESTION, { now: AT });
  assert.equal(dated.articles[0].published, '2026-10-15T14:00:00Z');
  assert.equal(dated.articles[0].date_source, 'page');
  assert.equal(dated.articles[0].listed_at, '2026-10-15T14:00:00Z');
  assert.match(dated.summary, /published Oct 15, 2026 \(date from the article page; GDELT listed it Oct 15, 2026\)/);

  // A saved article without a page-given date is not reused as a receipt.
  const saved = [{ ...appleArticle(), published: '2026-10-15T12:00:00Z' }];
  const noDate = site({ [saved[0].url]: html({ title: saved[0].title, site: 'The Verge', published: '', body: saved[0].text }) });
  assert.equal(await reopenArticles(saved, { fetcher: noDate.fetcher, now: AT }), null);

  // A sentence giving a publication date needs a page that shows one.
  const pageUrl = 'https://www.example-news.com/apple-thin-phone';
  const undatedSite = site({ [pageUrl]: undated });
  const claimed = await guardCitations(`Example News published "Apple launches a thinner phone" on October 15, 2026. Source: ${pageUrl}`,
    { message: 'Did Example News write about Apple?', fetcher: undatedSite.fetcher, now: AT });
  assert.equal(claimed.removed.length, 1);
  assert.match(claimed.text, /Example News's page shows no publication date/);
  const summary = await guardCitations(`Example News published "Apple launches a thinner phone" on October 15, 2026.\nSource: ${pageUrl}`,
    { message: 'Summarize that page for me', fetcher: undatedSite.fetcher, now: AT });
  assert.equal(summary.removed.length, 1);
  assert.match(summary.text, /page shows no publication date, so I cannot confirm Oct 15, 2026/);
});

test('a cited page must say the claim, not only load', async () => {
  const recipe = 'https://a.example/recipe';
  const pasta = site({ [recipe]: html({ title: 'Easy weeknight pasta', site: 'A Example', published: '', body: 'Boil the pasta, add garlic and olive oil, and serve with parmesan.' }) });
  for (const claim of [`Smoking causes cancer (${recipe}).`, `Smoking typically causes cancer, see ${recipe}.`]) {
    const out = await guardCitations(claim, { message: 'Does smoking cause cancer?', fetcher: pasta.fetcher, now: AT });
    assert.equal(out.removed.length, 1, claim);
    assert.doesNotMatch(out.text, /Smoking/, claim);
    assert.match(out.text, /page does not say that/, claim);
  }
  const health = 'https://health.example.org/smoking';
  const real = site({ [health]: html({ title: 'Smoking and cancer', site: 'Example Health', published: '', body: 'Smoking causes lung cancer and many other cancers.' }) });
  const kept = await guardCitations(`Smoking causes cancer (${health}).`, { message: 'Does smoking cause cancer?', fetcher: real.fetcher, now: AT });
  assert.deepEqual(kept.removed, []);
  assert.match(kept.text, /^Smoking causes cancer/);

  // A link line words nothing of its own ("read the full story here") is not judged on its words.
  const pointer = await guardCitations(`Read the full story here: ${health}`, { message: 'Send me that article', fetcher: real.fetcher, now: AT });
  assert.deepEqual(pointer.removed, []);
});

test('"Source: <link>" on its own line cites the claim before it', async () => {
  const study = 'https://health.example.org/study';
  const page = site({ [study]: html({ title: 'Sleep and memory', site: 'Example Health', published: '2026-09-01T10:00:00Z', body: 'Adults who sleep seven hours remember more.' }) });
  const out = await guardCitations(`The study says MegaCure reduced disease by 95%. Source: ${study}`, { message: `Summarize ${study}`, fetcher: page.fetcher, now: AT });
  assert.deepEqual(page.calls, [study]);
  assert.doesNotMatch(out.text, /reduced disease|Source:/);
  assert.equal(out.removed.length, 1, 'the source line goes with its claim, not as a second removal');
  assert.match(out.text, /Example Health's page does not mention MegaCure or 95%/);

  const plain = await guardCitations(`Adults who sleep seven hours remember more.\nSource: ${study}`, { message: `Summarize ${study}`, fetcher: page.fetcher, now: AT });
  assert.deepEqual(plain.removed, []);
  assert.match(plain.text, /^Adults who sleep seven hours remember more\.\nSource: https:\/\/health\.example\.org\/study/);
});

test('the Worker and the iPhone agree on what is a news request', () => {
  // Same file as test/che_self_update_intent_test.dart: offline, the iPhone
  // refuses to guess exactly the requests the Worker researches online.
  const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/news_requests.json', import.meta.url), 'utf8'));
  for (const q of fixture.requests) assert.ok(newsQuestion(q, AT), `request: ${q}`);
  for (const q of fixture.statements) assert.equal(newsQuestion(q, AT), null, `statement: ${q}`);
});

test('a link given for navigation is not checked as a source', async () => {
  // Google Drive, Gmail and similar links need the owner's sign-in; giving one is not a claim.
  const folder = 'https://drive.google.com/drive/folders/abc123';
  for (const reply of [`Here's your Google Drive folder:\n${folder}`, `Your Drive folder: ${folder}`, `Here it is, sir.\n${folder}`]) {
    const web = site({});
    const out = await guardCitations(reply, { message: 'Open my Drive folder', fetcher: web.fetcher, now: AT });
    assert.equal(out.text, reply, reply);
    assert.deepEqual(web.calls, [], reply);
  }
  // A claim resting on a private link still cannot pass as checked.
  const claim = await guardCitations(`Your Q3 report shows revenue up 12%.\n${folder}`, { message: 'Summarize my report', fetcher: offline, now: AT });
  assert.equal(claim.removed.length, 1);
  assert.match(claim.text, /I cannot safely check the drive\.google\.com link as a source/);
});

test('a repeated news question never skips reopening through the early cache answer', async () => {
  // Codex on 21edef7: a pure research turn with no history could return the
  // saved news summary and links directly, without opening any page again.
  const pages = { ...PAGES };
  const calls = useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }), pages });
  const che = await owner({
    model: () => `Google Research published "${MEDGEMMA_TITLE}" on October 15, 2026, releasing MedGemma, a collection of open models for medical text and image comprehension. Source: ${MEDGEMMA_URL}`,
  });
  const ask = { history: [], requested_capabilities: ['web_research'] };
  const first = await che.say(NEWS_QUESTION, ask);
  assert.match(first.reply, /Sources I opened: Google Research/);
  // In production nothing else rides on a plain news turn, so the record is
  // marked pure, which is what lets the early cache answer apply.
  const key = [...che.saved.keys()].find((k) => k.startsWith('kc:research:'));
  assert.equal(che.saved.get(key).articles.length, 1);
  che.saved.set(key, { ...che.saved.get(key), pure: true });

  delete pages[MEDGEMMA_URL];
  calls.length = 0;
  const again = await che.say(NEWS_QUESTION, ask);
  assert.notEqual(again.meta.source, 'che_research_cache');
  assert.doesNotMatch(again.reply, /releasing MedGemma|Sources:? .*research\.google/);
  assert.ok(calls.includes(MEDGEMMA_URL), 'the saved article was tried again before any reuse');
});

// ─── Independent review of #315 at f3b651c ────────────────────────────────

test('a link listed under "Sources:" is still opened and checked against the claim', async () => {
  const gone = 'https://www.technologyreview.com/2026/10/15/medmind-radiology/';
  useWeb();
  const out = await guardCitations(`MedMind beat radiologists on imaging benchmarks.\n\nSources:\n- ${gone}`, { message: 'Tell me about MedMind', now: AT });
  assert.equal(out.removed.length, 1);
  assert.doesNotMatch(out.text, /beat radiologists|- https|Sources:/);
  assert.equal(out.disproven[0]?.kind, 'broken_citation');

  // Every "Source:" line after a claim cites that claim.
  const study = 'https://health.example.org/study';
  const second = 'https://health.example.org/missing';
  const page = site({ [study]: html({ title: 'Sleep and memory', site: 'Example Health', published: '', body: 'Adults who sleep seven hours remember more.' }) });
  const two = await guardCitations(`Adults who sleep seven hours remember more.\nSource: ${study}\nSource: ${second}`, { message: 'Does sleep help memory?', fetcher: page.fetcher, now: AT });
  assert.deepEqual([...page.calls].sort(), [second, study].sort());
  assert.equal(two.removed.length, 1);
});

test('links that present something to the owner are not judged as sources', async () => {
  const urls = ['https://myshop.example/', 'https://music.example.com/track/123', 'https://food.example.com/chili', 'https://tracking.example.com/1Z999', 'https://maps.example.com/dir/restaurant'];
  const web = site(Object.fromEntries(urls.map((u) => [u, html({ title: 'Welcome', site: 'Example', published: '', body: 'Welcome.' })])));
  for (const reply of [`Your website is live at ${urls[0]}`, `Check out this song: ${urls[1]}`, `Try this recipe: ${urls[2]}`,
    `Your order shipped: ${urls[3]}`, `Directions to the restaurant: ${urls[4]}`]) {
    const out = await guardCitations(reply, { message: 'Thanks', fetcher: web.fetcher, now: AT });
    assert.equal(out.text, reply, reply);
  }
  // A claim dressed as a pointer is still checked.
  for (const reply of [`See the study showing smoking cures cancer: ${urls[2]}`, `Use ibuprofen to cure migraines: ${urls[2]}`, `Watch the video that proves vaccines cause autism: ${urls[1]}`]) {
    const claim = await guardCitations(reply, { message: 'Is that true?', fetcher: web.fetcher, now: AT });
    assert.equal(claim.removed.length, 1, reply);
  }
});

test('a name on the page does not prove the rest of a cited claim', async () => {
  const chili = 'https://food.example.com/texas-chili';
  const dose = 'https://health.example.org/tylenol-dosage';
  const web = site({
    [chili]: html({ title: 'Texas chili', site: 'Food Example', published: '', body: 'This Texas chili uses dried chiles, beef and cumin.' }),
    [dose]: html({ title: 'Tylenol dosage', site: 'Example Health', published: '', body: 'Tylenol relieves mild pain and reduces fever. Adults take 325 to 650 mg every 4 to 6 hours.' }),
  });
  for (const reply of [`Smoking causes cancer in Texas (${chili}).`, `Studies show Tylenol causes autism (${dose}).`]) {
    const out = await guardCitations(reply, { message: 'Is that true?', fetcher: web.fetcher, now: AT });
    assert.equal(out.removed.length, 1, reply);
    assert.match(out.text, /page does not say that/, reply);
  }
  const kept = await guardCitations(`Tylenol relieves pain and fever (${dose}).`, { message: 'What is Tylenol for?', fetcher: web.fetcher, now: AT });
  assert.deepEqual(kept.removed, []);
});

test('in a news answer a page the reply links must be from the days asked about', async () => {
  const old = 'https://www.example-news.com/2019/apple-thin-phone';
  const undated = 'https://www.example-news.com/apple-thin-phone';
  const today = 'https://www.example-news.com/2026/apple-thin-phone';
  const page = (published) => html({ title: 'Apple launches a thinner phone', site: 'Example News', published, body: 'Apple launched a thinner phone today, its thinnest yet.' });
  const web = site({ [old]: page('2019-03-01T10:00:00Z'), [undated]: page(''), [today]: page('2026-10-15T15:00:00Z') });
  for (const [url, why] of [[old, /published it Mar 1, 2019, outside Oct 15, 2026/], [undated, /shows no publication date, so I cannot tell it is from Oct 15, 2026/]]) {
    for (const reply of [`Apple launched a thinner phone today (${url}).`, `Apple launched a thinner phone today.\nSource: ${url}`]) {
      const out = await guardCitations(reply, { message: TECH_NEWS, fetcher: web.fetcher, now: AT });
      assert.equal(out.removed.length, 1, reply);
      assert.doesNotMatch(out.text, /Sources I opened|thinner phone today/, reply);
      assert.match(out.text, why, reply);
    }
  }
  const kept = await guardCitations(`Apple launched a thinner phone today (${today}).`, { message: TECH_NEWS, fetcher: web.fetcher, now: AT });
  assert.deepEqual(kept.removed, []);
  assert.match(kept.text, /Sources I opened: Example News/);
  // Labelled background may link an older page; it is still checked for what it says.
  const background = await guardCitations(`For background, Apple launched a thinner phone in 2019 (${old}).`, { message: TECH_NEWS, fetcher: web.fetcher, now: AT });
  assert.deepEqual(background.removed, []);
});

test('a news question answered only from a reference summary is never replayed from the cache', async () => {
  const calls = useWeb({ list: listings() });
  const web = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (!url.startsWith('https://en.wikipedia.org/w/api.php')) return web(input, init);
    calls.push(url);
    return Response.json({ query: { pages: { 1: { title: 'MedGemma', fullurl: 'https://en.wikipedia.org/wiki/MedGemma',
      extract: 'MedGemma was released by Google on October 15, 2026, beating doctors on every benchmark.' } } } });
  };
  const che = await owner({ model: () => 'Google released MedGemma today, beating doctors on every benchmark.' });
  const ask = { history: [], requested_capabilities: ['web_research'] };
  const first = await che.say(NEWS_QUESTION, ask);
  assert.doesNotMatch(first.reply, /beating doctors/);
  // Even a record saved before this fix, marked pure, is not replayed.
  assert.equal([...che.saved.keys()].find((k) => k.startsWith('kc:research:')), undefined, 'a news question with no opened article is not saved as research');
  // A record saved before this fix, marked pure, is not replayed either.
  const topic = 'research:what was the biggest ai news story on october 15 2026';
  che.saved.set(`kc:${topic}`, {
    key: topic, answer: 'MedGemma: MedGemma was released by Google on October 15, 2026, beating doctors on every benchmark.', source: 'research_library',
    sources: ['https://en.wikipedia.org/wiki/MedGemma'], verification_status: 'source_backed', superseded: [], confidence: 0.85,
    verified_at: Date.now(), expires_at: Date.now() + 1_800_000, volatile: true, pure: true,
  });
  const again = await che.say(NEWS_QUESTION, ask);
  assert.notEqual(again.meta.source, 'che_research_cache');
  assert.doesNotMatch(again.reply, /beating doctors/);
});

// ─── Second review of #315 at a8da634 ─────────────────────────────────────

test('a list of links after an intro line is a list, not a claim', async () => {
  const a = 'https://food.example.com/chili';
  const b = 'https://food.example.com/soup';
  const web = site({ [a]: html({ title: 'Chili recipe', site: 'Food Example', published: '', body: 'An easy dinner: beans, beef and cumin. Song of the week: none.' }), [b]: html({ title: 'Soup recipe', site: 'Food Example', published: '', body: 'Carrots and leeks for dinner.' }) });
  for (const intro of ["Here's what I found:", 'Here are a few options, sir:', 'Here are two songs you might like:', 'Here are some easy dinner recipes:', 'References:', 'Further reading:']) {
    const reply = `${intro}\n- ${a}\n- ${b}`;
    const out = await guardCitations(reply, { message: 'Any ideas for dinner?', fetcher: web.fetcher, now: AT });
    assert.equal(out.text, reply, reply);
  }
  // A broken link in such a list is still caught; a claim ending in a colon is still a claim.
  const gone = 'https://www.technologyreview.com/2026/10/15/gone/';
  useWeb();
  const broken = await guardCitations(`Here's what I found:\n- ${gone}`, { message: 'Find me something', now: AT });
  assert.equal(broken.removed.length, 1);
  const claim = await guardCitations(`Smoking cures cancer:\n- ${a}`, { message: 'Is that true?', fetcher: web.fetcher, now: AT });
  assert.equal(claim.removed.length, 1);
});

test('a presented link cannot carry an unchecked claim', async () => {
  const page = 'https://video.example.com/watch/1';
  const web = site({ [page]: html({ title: 'Cooking with herbs', site: 'Video Example', published: '', body: 'A short video about cooking with fresh herbs.' }) });
  for (const reply of [`See the FDA page approving ivermectin for COVID ${page}`, `Watch the video of NASA faking the moon landing: ${page}`,
    `Watch this video ${page} to see how vaccines cause autism.`, `Doctors recommend this product: ${page}`]) {
    const out = await guardCitations(reply, { message: 'Is that true?', fetcher: web.fetcher, now: AT });
    assert.equal(out.removed.length, 1, reply);
  }
  // A name in a presented link is checked against the page, not removed for the imperative.
  const song = 'https://music.example.com/track/9';
  const music = site({ [song]: html({ title: 'Anti-Hero', site: 'Music Example', published: '', body: 'Anti-Hero by Taylor Swift, from the album Midnights.' }) });
  const kept = await guardCitations(`Check out this song by Taylor Swift: ${song}`, { message: 'Play me something', fetcher: music.fetcher, now: AT });
  assert.equal(kept.text, `Check out this song by Taylor Swift: ${song}`);
});

test('one undated page in a news sources list drops only that line', async () => {
  const wiki = 'https://en.wikipedia.org/wiki/MedGemma';
  const pages = { ...PAGES, [wiki]: html({ title: 'MedGemma', site: 'Wikipedia', published: '', body: 'MedGemma is a collection of open medical models from Google.' }) };
  useWeb({ list: listings({ gdelt: [MEDGEMMA_LISTING] }), pages });
  const research = await newsResearch(NEWS_QUESTION, { now: AT });
  const out = await guardCitations(`Google Research released MedGemma, a collection of open models for medical text and image comprehension.\n\nSources:\n- ${MEDGEMMA_URL}\n- ${wiki}`,
    { message: NEWS_QUESTION, research, now: AT });
  assert.match(out.text, /^Google Research released MedGemma/);
  assert.match(out.text, new RegExp(`- ${MEDGEMMA_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(out.text, /- https:\/\/en\.wikipedia/);
  assert.match(out.text, /Wikipedia's page shows no publication date/);
});

// ─── Third review of #315 at e1c8e1d ──────────────────────────────────────

test('a failing link in a sources list goes alone, and is never left on show', async () => {
  const study = 'https://health.example.org/study';
  const ok = html({ title: 'Sleep and memory', site: 'Example Health', published: '', body: 'Adults who sleep seven hours remember more.' });
  const gone = 'https://www.technologyreview.com/2026/10/15/gone/';
  const blocked = 'https://www.nytimes.com/2026/10/15/health/sleep.html';
  const claim = 'Adults who sleep seven hours remember more.';
  const fetcher = async (input) => {
    const url = String(input?.url || input);
    if (url === gone) return new Response('<html><title>Not found</title></html>', { status: 404 });
    if (url === blocked) return new Response('Forbidden', { status: 403 });
    if (url.startsWith('https://health.example.org/')) return new Response(ok, { status: 200, headers: { 'content-type': 'text/html' } });
    throw new TypeError('offline');
  };
  for (const [reply, left] of [
    [`${claim}\nSources: ${study}, ${gone}`, `Sources: ${study}`],
    [`${claim}\nSources: ${study} and ${gone}`, `Sources: ${study}`],
    [`${claim}\n\nSources:\n- ${study}\n- ${blocked}`, `- ${study}`],
  ]) {
    const out = await guardCitations(reply, { message: 'Does sleep help memory?', fetcher, now: AT });
    assert.match(out.text, new RegExp(`^${claim}`), reply);
    assert.ok(out.text.includes(left), reply);
    assert.ok(!out.text.includes(gone) && !out.text.includes(`- ${blocked}`), reply);
    assert.equal(out.removed.length, 1, reply);
  }
  // Four listed links are all opened, not cut off after three.
  const four = [1, 2, 3, 4].map((n) => `https://health.example.org/study-${n}`);
  const all = await guardCitations(`${claim}\n\nSources:\n${four.map((u) => `- ${u}`).join('\n')}`, { message: 'Does sleep help memory?', fetcher, now: AT });
  assert.deepEqual(all.removed, []);
});

test('a claim worded as a list intro is still checked', async () => {
  const pasta = 'https://food.example.com/pasta';
  const web = site({ [pasta]: html({ title: 'Easy pasta', site: 'Food Example', published: '', body: 'Boil the pasta, add garlic and olive oil.' }) });
  for (const intro of ['Here are studies linking vaccines to autism:', 'Here are the reasons smoking is safe:', 'I found that Apple is buying Tesla:']) {
    const out = await guardCitations(`${intro}\n- ${pasta}`, { message: 'Is that true?', fetcher: web.fetcher, now: AT });
    assert.equal(out.removed.length, 1, intro);
  }
});

// ─── Fourth review of #315 at 7ed6f08 ─────────────────────────────────────

test('everyday list intros stay lists; a trimmed link never cuts into another', async () => {
  const a = 'https://help.example.com/restart';
  const b = 'https://help.example.com/restart-2';
  const web = site({ [a]: html({ title: 'Reset your router', site: 'Help Example', published: '', body: 'Hold the button for ten seconds. Our shows and help videos explain more.' }), [b]: html({ title: 'Reset 2', site: 'Help Example', published: '', body: 'Unplug it.' }) });
  for (const intro of ['Here are some videos that might help:', 'Some good options are:', "Here's how to reset it:", 'Here are some useful links:', 'Here are some shows you might like:']) {
    const reply = `${intro}\n- ${a}\n- ${b}`;
    const out = await guardCitations(reply, { message: 'How do I reset it?', fetcher: web.fetcher, now: AT });
    assert.equal(out.text, reply, reply);
  }
  const study = 'https://health.example.org/study';
  const stud = 'https://health.example.org/stud';
  const fetcher = async (input) => {
    const url = String(input?.url || input);
    if (url === stud) return new Response('gone', { status: 404 });
    return new Response(html({ title: 'Sleep and memory', site: 'Example Health', published: '', body: 'Adults who sleep seven hours remember more.' }), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const out = await guardCitations(`Adults who sleep seven hours remember more.\nSources: ${study}, ${stud}`, { message: 'Does sleep help memory?', fetcher, now: AT });
  assert.ok(out.text.includes(`Sources: ${study}\n`) || out.text.includes(`Sources: ${study}\n\n`) || new RegExp(`Sources: ${study.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(out.text), out.text);
  assert.ok(!out.text.includes(`${stud},`) && !/stud(?!y)/.test(out.text.replace(/the health\.example\.org link[^.]*\./g, '')), out.text);
});

test('an intro that states something is checked; one about its links stays', async () => {
  const pasta = 'https://food.example.com/pasta';
  const soup = 'https://food.example.com/soup';
  const web = site({ [pasta]: html({ title: 'Easy pasta', site: 'Food Example', published: '', body: 'Boil the pasta.' }), [soup]: html({ title: 'Soup', site: 'Food Example', published: '', body: 'Carrots and leeks.' }) });
  for (const intro of ['Here are the reasons the moon landing was staged:', 'Here are reports the election was rigged:', 'Here are studies where vaccines triggered autism:']) {
    const out = await guardCitations(`${intro}\n- ${pasta}\n- ${soup}`, { message: 'Is that true?', fetcher: web.fetcher, now: AT });
    assert.equal(out.removed.length, 1, intro);
    assert.ok(!out.text.includes(intro), intro);
  }
});
