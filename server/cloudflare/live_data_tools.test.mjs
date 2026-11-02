// Real tools that ran but returned nothing usable: the weather tools, today's news and daily crypto history. Every
// network call here is mocked. Wording is deliberately not the certification bank's.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { capabilityGap } from './capability_gap.js';
import { forecastPlace, runChatPlugins, serverPluginTools, weatherPlace, withForecastPlace } from './plugin_runtime.js';
import { newsQuestion, newsResearch } from './source_verification.js';
import { loadCandles } from './trading_lab.js';
import { guardLocationWeatherReply } from './truth_layer.js';

const generated = new URL('./.live_data_tools.test.generated.mjs', import.meta.url);
writeFileSync(generated, readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
), 'utf8');
let worker;
let CheState;
try {
  ({ default: worker, CheState } = await import(`${generated.href}?test=${Date.now()}`));
} finally {
  try { unlinkSync(generated); } catch (_) {}
}

const realFetch = globalThis.fetch;

async function che(model) {
  const saved = new Map();
  const env = { CHE_PAIR_CODE: '123456', CHE_DISABLE_KEYLESS_AI: '1', AI: { run: async (_m, input) => ({ response: model(input) }) } };
  const state = new CheState({ storage: {
    get: async (key) => (saved.has(key) ? JSON.parse(saved.get(key)) : undefined),
    put: async (key, value) => { if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) saved.set(k, JSON.stringify(v)); } else saved.set(key, JSON.stringify(value)); },
    delete: async (key) => saved.delete(key),
    list: async ({ prefix = '' } = {}) => new Map([...saved.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, JSON.parse(v)])),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } }, env);
  env.CHE_STATE = { getByName: () => state };
  const raw = (path, init) => worker.fetch(new Request(`https://che.example${path}`, init), env);
  const token = (await (await raw('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123456' }),
  })).json()).device_token;
  return async (message, extra = {}) => {
    const text = await (await raw('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, ...extra }),
    })).text();
    const frames = text.trim().split('\n').map((line) => JSON.parse(line));
    return { reply: frames.filter((f) => f.type === 'delta').map((f) => f.delta).join(''), done: frames.find((f) => f.type === 'done') || {} };
  };
}

const LISBON = { results: [{ name: 'Lisbon', latitude: 38.72, longitude: -9.14 }] };
const WET = { daily: { time: ['2026-11-02', '2026-11-03', '2026-11-04'], precipitation_probability_max: [20, 85, 40] } };
function weatherWeb() {
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) return Response.json(LISBON);
    if (String(url).startsWith('https://api.open-meteo.com/')) return Response.json(WET);
    throw new TypeError('offline');
  };
  return fetched;
}

test('the place in a weather question, in any wording; no place when none is named', () => {
  assert.equal(weatherPlace('Should I pack a raincoat for Lisbon on Tuesday? What does the forecast say?'), 'Lisbon');
  assert.equal(weatherPlace('Is it going to snow in Salt Lake City tonight?'), 'Salt Lake City');
  assert.equal(weatherPlace("What's the weekend forecast in Rio de Janeiro?"), 'Rio de Janeiro');
  assert.equal(weatherPlace('any rain in cape town tomorrow'), 'cape town');
  for (const text of ['Is the weather nice for hiking this week?', 'What is the forecast for tomorrow?', 'Do I need an umbrella today?',
    'What is the temperature in Celsius?', 'Will it rain at the stadium?', 'Book a table in Paris for two']) {
    assert.equal(weatherPlace(text), '', text);
  }
  // "Umbrella" asks for the weather without the word, so the Worker offers its weather tools.
  assert.deepEqual(serverPluginTools({}, 'Umbrella needed in Lisbon on Friday?').map((t) => t.name), ['find_place', 'forecast']);
});

test('a weather question naming a place runs find_place then forecast even when the planner model answers NONE', async () => {
  const fetched = weatherWeb();
  let plannerCalls = 0;
  const env = { AI: { run: async () => { plannerCalls += 1; return { response: 'NONE' }; } } };
  const saved = new Map();
  const storage = { get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, v), delete: async (k) => saved.delete(k), list: async () => new Map() };
  try {
    const { skillResults } = await runChatPlugins(env, storage, {}, 'Should I pack a raincoat for Lisbon on Tuesday?', 'fast');
    assert.equal(plannerCalls, 0);
    assert.deepEqual(skillResults.map((r) => `${r.tool}:${r.ok}`), ['find_place:true', 'forecast:true']);
    assert.ok(fetched[0].includes('name=Lisbon'));
    assert.ok(fetched[1].includes('latitude=38.72') && fetched[1].includes('longitude=-9.14'));
    assert.ok(skillResults.every((r) => r.execution_receipt?.status === 'success'));

    // The phone's own list is respected: with every plugin off, nothing is fetched.
    fetched.length = 0;
    const off = await runChatPlugins(env, storage, { plugin_tools: [] }, 'Should I pack a raincoat for Lisbon on Tuesday?', 'fast');
    assert.deepEqual(off.skillResults, []);
    assert.equal(fetched.length, 0);

    // A place the geocoder does not know: one lookup, no forecast for made-up coordinates.
    globalThis.fetch = async () => Response.json({});
    const unknown = await runChatPlugins(env, storage, {}, 'Weather in Atlantisville this weekend?', 'fast');
    assert.deepEqual(unknown.skillResults.map((r) => r.tool), ['find_place']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('through /api/chat: a forecast backed by the forecast tool is kept, with its receipts', async () => {
  weatherWeb();
  try {
    const say = await che((input) => {
      const system = String(input?.messages?.[0]?.content || '');
      if (system.startsWith('Decide if ONE of these tools')) return 'NONE';
      return 'Lisbon tomorrow will be rainy, with a high of 17 degrees and an 85% chance of rain, so yes, take an umbrella.';
    });
    const { reply, done } = await say('Is an umbrella a good idea in Lisbon tomorrow?');
    assert.match(reply, /85% chance of rain/);
    assert.doesNotMatch(reply, /verified live weather forecast/);
    const receipts = done.execution_receipts || [];
    assert.ok(receipts.some((r) => r.tool === 'forecast' && r.status === 'success'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Codex review on #878: "Paris, Texas" was cut to "Paris" and "St. Louis" to "St", and the first geocoder hit was
// given as the verified forecast. The place keeps its abbreviation and qualifier; a qualifier the geocoder's result
// does not match goes to the planner instead of a guess; the reply says which place the forecast was for.
const GEO = {
  Paris: { results: [{ name: 'Paris', admin1: 'Île-de-France', country: 'France', country_code: 'FR', latitude: 48.85, longitude: 2.35 }] },
  'St. Louis': { results: [{ name: 'St. Louis', admin1: 'Missouri', country: 'United States', country_code: 'US', latitude: 38.63, longitude: -90.2 }] },
  Berlin: { results: [{ name: 'Berlin', admin1: 'Land Berlin', country: 'Germany', country_code: 'DE', latitude: 52.52, longitude: 13.41 }] },
};
function geoWeb() {
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(decodeURIComponent(String(url)));
    if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) return Response.json(GEO[new URL(url).searchParams.get('name')] || {});
    if (String(url).startsWith('https://api.open-meteo.com/')) return Response.json(WET);
    throw new TypeError('offline');
  };
  return fetched;
}
const plannerNone = { AI: { run: async () => ({ response: 'NONE' }) } };
const memory = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k), list: async () => new Map() }; };

test('a place keeps its abbreviation and its comma qualifier', () => {
  assert.equal(weatherPlace('Is it going to rain in Paris, Texas over the weekend?'), 'Paris, Texas');
  assert.equal(weatherPlace('Umbrella needed in St. Louis tomorrow?'), 'St. Louis');
  assert.equal(weatherPlace('Snow near Mt. Hood, Oregon on Friday?'), 'Mt. Hood, Oregon');
  assert.equal(weatherPlace('Weather in Cambridge, UK?'), 'Cambridge, UK');
  assert.equal(weatherPlace("What's the weather in Berlin, and do I need a coat?"), 'Berlin');
  assert.equal(weatherPlace('Any rain in Berlin. Also, how are you?'), 'Berlin');
});

test('"Paris, Texas" never gets the forecast for Paris, France; St. Louis and Berlin run directly', async () => {
  const fetched = geoWeb();
  try {
    // The geocoder's only Paris is in France: no forecast is run for it, and the planner (NONE here) decides.
    const texas = await runChatPlugins(plannerNone, memory(), {}, 'Is it going to rain in Paris, Texas over the weekend?', 'fast');
    assert.deepEqual(texas.skillResults.map((r) => r.tool), ['find_place']);
    assert.ok(fetched.some((u) => u.includes('name=Paris')) && !fetched.some((u) => u.startsWith('https://api.open-meteo.com/')));
    assert.equal(forecastPlace(texas.skillResults), '');

    fetched.length = 0;
    const louis = await runChatPlugins(plannerNone, memory(), {}, 'Umbrella needed in St. Louis tomorrow?', 'fast');
    assert.ok(fetched[0].includes('name=St. Louis'));
    assert.deepEqual(louis.skillResults.map((r) => `${r.tool}:${r.ok}`), ['find_place:true', 'forecast:true']);
    assert.equal(forecastPlace(louis.skillResults), 'St. Louis, Missouri, United States');

    const berlin = await runChatPlugins(plannerNone, memory(), {}, 'Should I take a brolly? Forecast for Berlin tomorrow, please.', 'fast');
    assert.equal(forecastPlace(berlin.skillResults), 'Berlin, Land Berlin, Germany');
    // The reply names the place used when the model left it out, and is unchanged when it already did.
    assert.match(withForecastPlace('Light rain is likely, take an umbrella.', berlin.skillResults), /Forecast used: Berlin, Land Berlin, Germany \(Open-Meteo\)\.$/);
    assert.equal(withForecastPlace('Berlin, Land Berlin, Germany: light rain.', berlin.skillResults), 'Berlin, Land Berlin, Germany: light rain.');

    // A qualifier the result does match runs directly.
    GEO.Paris.results.unshift({ name: 'Paris', admin1: 'Texas', country: 'United States', country_code: 'US', latitude: 33.66, longitude: -95.56 });
    const matched = await runChatPlugins(plannerNone, memory(), {}, 'Is it going to rain in Paris, Texas over the weekend?', 'fast');
    assert.equal(forecastPlace(matched.skillResults), 'Paris, Texas, United States');
    GEO.Paris.results.shift();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the weather guard: the phone and server name the plugin "Weather"; an unbacked umbrella forecast is still refused', () => {
  const asserted = 'Tomorrow will be rainy, with a high of 14 degrees.';
  assert.equal(guardLocationWeatherReply('Umbrella tomorrow in Lisbon?', asserted, { forecastVerified: false }).startsWith('I do not have a verified live weather forecast'), true);
  assert.equal(guardLocationWeatherReply('Umbrella tomorrow in Lisbon?', asserted, { forecastVerified: true }), asserted);
  // That refusal is a missing result, not a missing ability: no self-development job for it.
  assert.equal(capabilityGap('Can you check if I need an umbrella?', 'I do not have a verified live weather forecast for that request, sir.'), null);
  assert.ok(capabilityGap('Can you make me a spreadsheet?', "I don't have a way to make spreadsheets."));
});

test("today's news just after midnight UTC looks at the last day, not a window that has not started", () => {
  const now = Date.parse('2026-11-02T02:30:00Z');
  const q = newsQuestion('Look up the top news stories today', now);
  assert.ok(q.to <= now, 'the window never ends in the future');
  assert.ok(q.from <= now - 23 * 3600_000, 'it covers the last day');
  // A named past day keeps its own window.
  const past = newsQuestion('What was the biggest news on October 15, 2026?', now);
  assert.ok(past.to < Date.parse('2026-10-17T00:00:00Z'));
});

test('news research that opened an article carries an execution receipt', async () => {
  const now = Date.parse('2026-11-02T02:30:00Z');
  const url = 'https://www.example-news.com/storm';
  const page = `<!doctype html><html><head><title>Storm reaches coast | Example News</title>
<meta property="og:title" content="Storm reaches coast"><meta property="og:site_name" content="Example News">
<meta property="article:published_time" content="2026-11-01T22:00:00Z"><meta name="description" content="A storm reached the coast overnight."></head>
<body><article><h1>Storm reaches coast</h1><p>A storm reached the coast overnight, officials said.</p></article></body></html>`;
  const seen = [];
  const fetcher = async (input) => {
    const u = String(input?.url || input);
    seen.push(u);
    if (u.startsWith('https://hn.algolia.com/')) return Response.json({ hits: [{ url, title: 'Storm reaches coast', created_at: '2026-11-01T22:10:00Z', points: 300 }] });
    if (u.startsWith('https://api.gdeltproject.org/')) return Response.json({ articles: [] });
    if (u === url) return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
    throw new TypeError('offline');
  };
  const research = await newsResearch('Look up the top news stories today', { fetcher, now });
  assert.equal(research.articles.length, 1, research.error);
  assert.equal(research.execution_receipt.tool, 'news_research');
  assert.equal(research.execution_receipt.status, 'success');
  assert.deepEqual(research.execution_receipt.verified_response.sources, [url]);
});

test('daily crypto history falls back to Yahoo Finance when Coinbase and Binance refuse; only closed days', async () => {
  const day = 86_400;
  const today = Math.floor(Date.now() / 1000 / day) * day;
  const stamps = Array.from({ length: 400 }, (_, i) => today - (399 - i) * day); // the last one is today, still open
  const yahoo = { chart: { result: [{ timestamp: stamps, indicators: { quote: [{
    open: stamps.map((_, i) => 100 + i), high: stamps.map((_, i) => 102 + i), low: stamps.map((_, i) => 99 + i), close: stamps.map((_, i) => 101 + i), volume: stamps.map(() => 5),
  }] } }] } };
  const asked = [];
  const fetcher = async (url) => {
    asked.push(String(url));
    if (/coinbase/.test(url)) return new Response('slow down', { status: 503 });
    if (/binance/.test(url)) return new Response('unavailable for legal reasons', { status: 451 });
    if (/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AVAX-USD/.test(url)) return Response.json(yahoo);
    return new Response('x', { status: 404 });
  };
  const data = await loadCandles('AVAXUSDT', { fetcher });
  assert.equal(data.error, undefined);
  assert.equal(data.data, 'Yahoo Finance daily history (delayed)');
  assert.equal(data.candles.length, 399);
  assert.ok(asked.some((u) => u.includes('/chart/AVAX-USD?interval=1d')));
});
