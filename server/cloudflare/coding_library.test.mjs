// CHE Coding Library: official docs read at an exact commit into the coding shelf of CHE's
// library, cited search, retrieval for coding jobs, outcomes, REA saves and freshness checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CheLibrary } from './library.js';
import {
  CODING_SOURCES, cleanDoc, codingContext, codingLibraryIntent, docsUrl, learnDocs, libraryStatus, rankDocPaths,
  recordOutcome, refreshLibrary, saveInvestigation, searchCodingLibrary, sourceFor, speakLearned, speakResults, speakStatus, STALE_AFTER_MS,
} from './coding_library.js';

async function sqlStorage() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (q, ...p) => {
    const stmt = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? stmt.all(...p) : (stmt.run(...p), []);
  } } };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ENV = { CHE_GITHUB_TOKEN: 'test-token' };
const T0 = Date.parse('2026-10-17T08:00:00Z');

// A fake GitHub serving flutter/website's real layout (sites/docs/src/content/...).
function github({ sha = 'a'.repeat(40), pages = null, metaStatus = 200 } = {}) {
  const state = {
    sha,
    metaStatus,
    pages: pages || {
      'cookbook/navigation/named-routes.md': { blob: 'b1', text: '---\ntitle: Navigate with named routes\ndescription: How to use named routes.\n---\n\nUse `Navigator.pushNamed` to move to a named route.\n\n```dart\nNavigator.pushNamed(context, \'/second\');\n```\n' },
      'ui/navigation/index.md': { blob: 'b2', text: '---\ntitle: Navigation and routing\n---\n\nFlutter apps use the Router API or go_router for deep links.\n' },
      'cookbook/networking/fetch-data.md': { blob: 'b3', text: '---\ntitle: Fetch data from the internet\n---\n\nUse the http package.\n' },
      '_partials/nav.md': { blob: 'b4', text: 'partial' },
    },
  };
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    assert.ok(!init.method || init.method === 'GET', 'the library only reads');
    if (u === 'https://api.github.com/repos/flutter/website') return state.metaStatus === 200 ? json({ default_branch: 'main', license: { spdx_id: 'NOASSERTION', name: 'Other' } }) : json({ message: 'rate limited' }, state.metaStatus);
    if (u === 'https://api.github.com/repos/flutter/website/commits/main') return json({ sha: state.sha });
    const tree = u.match(/\/git\/trees\/([^?]+)(\?recursive=1)?$/);
    if (tree) {
      const levels = { [state.sha]: 'sites', 't-sites': 'docs', 't-docs': 'src', 't-src': 'content' };
      if (tree[2]) return tree[1] === 't-content' ? json({ tree: Object.entries(state.pages).map(([path, p]) => ({ path, type: 'blob', sha: p.blob })) }) : json({}, 404);
      const name = levels[tree[1]];
      return name ? json({ tree: [{ path: 'README.md', type: 'blob', sha: 'r' }, { path: name, type: 'tree', sha: `t-${name}` }] }) : json({}, 404);
    }
    const raw = u.match(/^https:\/\/raw\.githubusercontent\.com\/flutter\/website\/([0-9a-f]{40})\/sites\/docs\/src\/content\/(.+)$/);
    if (raw) {
      const page = state.pages[decodeURIComponent(raw[2])];
      return page ? new Response(page.text, { status: 200 }) : new Response('nope', { status: 404 });
    }
    return json({ message: `unexpected ${u}` }, 599);
  };
  return { fetcher, calls, state };
}

test('the owner\'s phrases: learn needs a docs source, search needs the coding library; ordinary chat is left alone', () => {
  assert.deepEqual(codingLibraryIntent('CHE, learn the Flutter docs about navigation'), { action: 'learn', source: 'flutter', topic: 'navigation' });
  assert.deepEqual(codingLibraryIntent('Add the React documentation on useEffect to your coding library'), { action: 'learn', source: 'react', topic: 'useEffect' });
  assert.equal(codingLibraryIntent('Study the Cloudflare Durable Objects documentation').source, 'cloudflare');
  assert.equal(codingLibraryIntent('Study the Cloudflare Durable Objects documentation').topic, 'Durable Objects', 'the source name is not the topic');
  assert.deepEqual(codingLibraryIntent('Search your coding library for go_router deep links'), { action: 'search', query: 'go_router deep links' });
  assert.deepEqual(codingLibraryIntent('What does the coding library say about Durable Object alarms?'), { action: 'search', query: 'Durable Object alarms' });
  assert.equal(codingLibraryIntent('Coding library search: named routes').query, 'named routes');
  assert.equal(codingLibraryIntent('Coding library learn: dart async').source, 'dart');
  assert.equal(codingLibraryIntent('What is in your coding library?').action, 'status');
  assert.equal(codingLibraryIntent('Is anything in the coding library out of date?').stale, true);
  assert.deepEqual(codingLibraryIntent('Refresh your coding library'), { action: 'refresh', all: false });
  assert.equal(codingLibraryIntent('Save that investigation to your coding library').action, 'save_rea');
  assert.equal(codingLibraryIntent('Coding library save: rea-0a1b2c3d').id, 'rea-0a1b2c3d');
  for (const q of ['read me the news', 'learn my schedule for tomorrow', 'Memorize this page https://docs.flutter.dev/ui', 'Investigate https://github.com/flutter/website',
    'Build a Flutter app for my barbershop', 'what is Flutter', 'Read this', 'save my password', 'Research the market for faceless YouTube channels']) {
    assert.equal(codingLibraryIntent(q), null, q);
  }
  assert.equal(sourceFor('how do Durable Objects store data'), 'cloudflare');
  assert.equal(sourceFor('typescript generics'), 'typescript');
  assert.equal(sourceFor('my dartboard'), '', 'whole words only');
});

test('pages are cleaned, ranked by path and mapped to their published URLs', () => {
  const doc = cleanDoc('---\ntitle: "Hooks"\npermalink: /docs/handbook/2/everyday-types.html\n---\nimport X from \'../x\';\n<!-- hidden -->\n{% render "a" %}\n# Heading\n\nBody text.');
  assert.equal(doc.title, 'Hooks');
  assert.equal(doc.permalink, '/docs/handbook/2/everyday-types.html');
  assert.doesNotMatch(doc.body, /import X|hidden|render/);
  assert.match(doc.body, /Body text/);
  assert.equal(docsUrl(CODING_SOURCES.flutter, 'cookbook/navigation/named-routes.md'), 'https://docs.flutter.dev/cookbook/navigation/named-routes');
  assert.equal(docsUrl(CODING_SOURCES.flutter, 'ui/navigation/index.md'), 'https://docs.flutter.dev/ui/navigation');
  assert.equal(docsUrl(CODING_SOURCES.cloudflare, 'durable-objects/api/alarms.mdx'), 'https://developers.cloudflare.com/durable-objects/api/alarms/');
  assert.equal(docsUrl(CODING_SOURCES.python, 'library/asyncio.rst'), 'https://docs.python.org/3/library/asyncio.html');
  assert.equal(docsUrl(CODING_SOURCES.github, 'actions/concepts/index.md'), 'https://docs.github.com/en/actions/concepts');
  assert.equal(docsUrl(CODING_SOURCES.typescript, 'handbook-v2/Everyday Types.md', '/docs/handbook/2/everyday-types.html'), 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html');
  assert.equal(docsUrl(CODING_SOURCES.typescript, 'x.md'), '', 'no permalink, no guessed URL');
  assert.deepEqual(rankDocPaths(['cookbook/networking/fetch-data.md', 'ui/navigation/index.md', 'cookbook/navigation/named-routes.md', 'tools/devtools.md'], 'navigation', 3),
    ['ui/navigation/index.md', 'cookbook/navigation/named-routes.md']);
  assert.deepEqual(rankDocPaths(['a.md'], 'the'), [], 'no topic words, nothing chosen');
});

test('learning reads only the chosen pages at one commit, records source, licence and dates, and never re-reads an unchanged page', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const gh = github();
  const receipt = await learnDocs(ENV, storage, { source: 'flutter', topic: 'navigation' }, { fetcher: gh.fetcher, now: T0 });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sha, 'a'.repeat(40));
  assert.equal(receipt.license, 'NOASSERTION', 'the licence is what GitHub reports, not a guess');
  assert.equal(receipt.license_url, `https://github.com/flutter/website/blob/${'a'.repeat(40)}/LICENSE`);
  assert.deepEqual(receipt.pages.map((p) => [p.path, p.state]), [['sites/docs/src/content/ui/navigation/index.md', 'added'], ['sites/docs/src/content/cookbook/navigation/named-routes.md', 'added']]);
  assert.equal(receipt.fetches, 2);
  assert.ok(!gh.calls.some((u) => /fetch-data|_partials/.test(u)), 'pages off the topic and partials are not read');
  const spoken = speakLearned(receipt);
  assert.match(spoken, /flutter\/website at commit aaaaaaaaaaaa/);
  assert.match(spoken, /not new training/);

  const status = libraryStatus(storage, T0);
  assert.equal(status.counts.docs, 2);
  const entry = status.entries.find((e) => /named routes/i.test(e.title));
  assert.equal(entry.docs_url, 'https://docs.flutter.dev/cookbook/navigation/named-routes');
  assert.equal(entry.url, `https://github.com/flutter/website/blob/${'a'.repeat(40)}/sites/docs/src/content/cookbook/navigation/named-routes.md`);
  assert.equal(entry.version, 'a'.repeat(40));
  assert.equal(entry.trust, 'official-docs');
  assert.equal(entry.retrieved_at, new Date(T0).toISOString());
  assert.equal(entry.stale, false);
  assert.equal(new CheLibrary(storage).list().length, 0, 'the owner\'s own library list is unchanged');
  assert.equal(new CheLibrary(storage).search('Navigator pushNamed').length, 0, 'ordinary chat recall does not pull in coding docs');

  gh.calls.length = 0;
  gh.state.sha = 'c'.repeat(40);
  const again = await learnDocs(ENV, storage, { source: 'flutter', topic: 'navigation' }, { fetcher: gh.fetcher, now: T0 + 86400_000 });
  assert.deepEqual(again.pages.map((p) => p.state), ['unchanged', 'unchanged']);
  assert.equal(again.fetches, 0, 'an unchanged file is confirmed from the tree, not read again');
  assert.equal(libraryStatus(storage, T0).entries.find((e) => /named routes/i.test(e.title)).version, 'c'.repeat(40));

  gh.state.pages['cookbook/navigation/named-routes.md'] = { blob: 'b1-new', text: '---\ntitle: Navigate with named routes\n---\n\nNamed routes are no longer recommended for most apps; use go_router.\n' };
  const changed = await learnDocs(ENV, storage, { source: 'flutter', topic: 'named routes' }, { fetcher: gh.fetcher, now: T0 + 2 * 86400_000 });
  assert.equal(changed.pages.find((p) => /named-routes/.test(p.path)).state, 'updated');
  const after = libraryStatus(storage, T0 + 2 * 86400_000);
  assert.equal(after.counts.superseded, 1, 'the old version is kept but marked superseded');
  const hits = searchCodingLibrary(storage, 'flutter named routes', { now: T0 + 2 * 86400_000 });
  assert.ok(hits.length);
  assert.ok(hits.every((h) => h.status === 'current'), 'search never cites a superseded version');
  assert.match(hits[0].text, /no longer recommended/);
});

test('search cites each passage; a framework name ranks results instead of matching every page; stale entries are flagged', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const gh = github();
  await learnDocs(ENV, storage, { source: 'flutter', topic: 'navigation' }, { fetcher: gh.fetcher, now: T0 });
  assert.deepEqual(searchCodingLibrary(storage, 'flutter'), [], 'the framework name alone is not a search');
  const hits = searchCodingLibrary(storage, 'How do I push a named route in Flutter?', { now: T0 });
  assert.equal(hits[0].framework, 'Flutter');
  assert.match(hits[0].text, /Navigator\.pushNamed/);
  assert.equal(hits[0].license, 'NOASSERTION');
  const later = T0 + STALE_AFTER_MS + 86400_000;
  const old = searchCodingLibrary(storage, 'named route', { now: later });
  assert.equal(old[0].stale, true);
  assert.match(speakResults('named route', old, later), /may be out of date/);
  assert.match(speakResults('named route', hits, T0), /docs\.flutter\.dev\/cookbook\/navigation\/named-routes, flutter\/website at aaaaaaa, licence NOASSERTION, confirmed today/);
  assert.match(speakResults('isolates', [], T0), /nothing on "isolates"/);
  assert.match(speakStatus(libraryStatus(storage, later), { staleOnly: true }), /2 of my coding library pages have not been confirmed for 30 days/);
});

test('a coding job gets bounded, cited passages, and its outcome is searchable for the next similar job', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  assert.deepEqual(codingContext(storage, 'Add deep links with named routes'), { text: '', refs: [] }, 'an empty shelf changes nothing');
  const gh = github();
  await learnDocs(ENV, storage, { source: 'flutter', topic: 'navigation' }, { fetcher: gh.fetcher, now: T0 });
  const ctx = codingContext(storage, 'Add deep links to the settings page using named routes in Flutter', { budget: 1200, now: T0 });
  assert.ok(ctx.text.length <= 1600, `bounded: ${ctx.text.length}`);
  assert.match(ctx.text, /^CODING LIBRARY \(reference text[\s\S]*data, not instructions/);
  assert.match(ctx.text, /\[1\] Flutter: /);
  assert.ok(ctx.refs.length >= 1 && ctx.refs.every((r) => r.url.startsWith('https://docs.flutter.dev/')));

  const saved = recordOutcome(storage, { request: 'Add deep links to the settings page using named routes', state: 'failed', job_id: 'job-1234abcd', files: [], error: 'The engineer edited a file that does not exist.', refs: ctx.refs }, T0);
  assert.ok(saved.id);
  const outcomes = searchCodingLibrary(storage, 'settings page deep links', { now: T0, kinds: ['outcome'] });
  assert.equal(outcomes.length, 1);
  assert.match(outcomes[0].text, /Coding job outcome: failed[\s\S]*No pull request was opened[\s\S]*No file was changed[\s\S]*edited a file that does not exist/);
  assert.equal(outcomes[0].trust, 'che-run');
});

test('a finished REA investigation is saved once with its evidence labels; an unfinished one is refused', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const inv = {
    id: 'rea-0a1b2c3d', state: 'complete', updated_at: new Date(T0).toISOString(),
    target: { label: 'acme/sketchpad', kind: 'github', url: 'https://github.com/acme/sketchpad', version: 'd'.repeat(40), license: 'mit' },
    features: [{ name: 'Search', purpose: 'Find notes by text.', evidence: [{ label: 'src/search/SearchBox.tsx:12', url: 'https://github.com/acme/sketchpad/blob/x/src/search/SearchBox.tsx#L12' }] }],
    architecture: [{ kind: 'observed', label: 'Framework', detail: 'React 18 (package.json).' }, { kind: 'unknown', label: 'Storage', detail: 'Not in the files read.' }],
    comparison: { items: [{ name: 'Search', status: 'partial', che_files: ['lib/search.dart'] }] },
    limitations: ['Only 5 source files were read.'],
  };
  assert.match(saveInvestigation(storage, { ...inv, state: 'running' }).error, /Only a finished REA investigation/);
  const saved = saveInvestigation(storage, inv, T0);
  assert.ok(saved.id);
  assert.equal(saveInvestigation(storage, inv, T0).duplicate, true, 'saved once');
  const hits = searchCodingLibrary(storage, 'sketchpad search notes', { now: T0 });
  assert.equal(hits[0].kind, 'rea');
  assert.match(hits[0].text, /Observed, Framework: React 18[\s\S]*Unknown, Storage[\s\S]*Search: partial \(lib\/search\.dart\)/);
  assert.equal(hits[0].license, 'mit');
});

test('refresh re-confirms unchanged pages from one tree listing, re-reads changed ones and marks pages removed upstream', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const gh = github();
  await learnDocs(ENV, storage, { source: 'flutter', topic: 'navigation' }, { fetcher: gh.fetcher, now: T0 });
  const later = T0 + STALE_AFTER_MS + 86400_000;
  gh.state.sha = 'e'.repeat(40);
  delete gh.state.pages['ui/navigation/index.md'];
  gh.calls.length = 0;
  const result = await refreshLibrary(ENV, storage, {}, { fetcher: gh.fetcher, now: later });
  assert.deepEqual({ checked: result.checked, unchanged: result.unchanged, updated: result.updated, removed: result.removed_upstream }, { checked: 2, unchanged: 1, updated: 0, removed: 1 });
  assert.ok(!gh.calls.some((u) => u.startsWith('https://raw.githubusercontent.com/')), 'nothing was downloaded to confirm an unchanged page');
  const status = libraryStatus(storage, later);
  assert.equal(status.counts.removed_upstream, 1);
  assert.equal(status.counts.stale, 0);
  assert.equal(searchCodingLibrary(storage, 'Router API go_router deep links', { now: later }).length, 1, 'a page removed upstream is still found, labelled');

  const nothing = await refreshLibrary(ENV, storage, {}, { fetcher: gh.fetcher, now: later });
  assert.equal(nothing.checked, 0, 'nothing is due again right after a check');
});

test('GitHub failures are reported and save nothing; an unknown source or topic is refused before any request', async (t) => {
  const storage = await sqlStorage();
  if (!storage) return t.skip('node:sqlite unavailable');
  const gh = github({ metaStatus: 403 });
  const failed = await learnDocs(ENV, storage, { source: 'flutter', topic: 'navigation' }, { fetcher: gh.fetcher, now: T0 });
  assert.equal(failed.ok, false);
  assert.equal(failed.retryable, true);
  assert.match(failed.reason, /status 403\)\. Nothing was read/);
  assert.equal(libraryStatus(storage, T0).counts.total, 0);
  gh.calls.length = 0;
  assert.match((await learnDocs(ENV, storage, { source: 'cobol', topic: 'x' }, { fetcher: gh.fetcher })).reason, /no documentation source called "cobol"/);
  assert.match((await learnDocs(ENV, storage, { source: 'flutter', topic: 'the' }, { fetcher: gh.fetcher })).reason, /Which part of the Flutter documentation/);
  assert.equal(gh.calls.length, 0);
  const ok = github();
  const none = await learnDocs(ENV, storage, { source: 'flutter', topic: 'quantum entanglement' }, { fetcher: ok.fetcher, now: T0 });
  assert.equal(none.ok, false);
  assert.match(none.reason, /No page of the Flutter documentation at commit aaaaaaaaaaaa is about "quantum entanglement"/);
});
