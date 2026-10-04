import assert from 'node:assert/strict';
import test from 'node:test';
import { OWNER_PROMPT, README } from './topic_study.fixtures.mjs';
import { htmlToText, matchTopicSections, namedRepoStudyIntent, readTutorial, readmeSections, sectionTutorials, topicBuildRequest, topicTitles } from './topic_study.js';

test('the owner prompt is a named study of build-your-own-x with implementation', () => {
  assert.deepEqual(namedRepoStudyIntent(OWNER_PROMPT), { repo: 'codecrafters-io/build-your-own-x', implement: true });
  assert.deepEqual(namedRepoStudyIntent('Look in the build your own X readme for the search engine topic'), { repo: 'codecrafters-io/build-your-own-x', implement: false });
  assert.equal(namedRepoStudyIntent('Study https://github.com/msitarzewski/agency-agents and report').repo, 'msitarzewski/agency-agents');
  assert.equal(namedRepoStudyIntent('Research the tauri-apps/tauri repo').repo, 'tauri-apps/tauri');
});

test('file paths, and ordinary sentences are never treated as a repository', () => {
  assert.equal(namedRepoStudyIntent('Read lib/main.dart in your repo and fix the banner'), null);
  assert.equal(namedRepoStudyIntent('Read the README and/or the docs in the repo'), null);
  assert.equal(namedRepoStudyIntent('Study 1 and 2'), null);
  assert.equal(namedRepoStudyIntent('Implement the search engine in your code'), null, 'no study verb, no repository');
});

test('the topics the owner named are found in his order, and nothing else', () => {
  const topics = matchTopicSections(readmeSections(README), OWNER_PROMPT);
  assert.deepEqual(topics.map((topic) => topic.title), ['Search Engine', 'Database', 'Bot', 'Neural Network', 'Visual Recognition System', 'Git']);
});

test('generic words and housekeeping sections never pick a topic', () => {
  const sections = readmeSections(README);
  assert.deepEqual(matchTopicSections(sections, 'study the library, the license and how to contribute, uncategorized too').map((t) => t.title), []);
  assert.deepEqual(matchTopicSections(sections, 'study the front-end framework topic').map((t) => t.title), ['Front-end Framework / Library']);
  assert.deepEqual(matchTopicSections(sections, 'tell me about GitHub and robots').map((t) => t.title), [], 'GitHub is not Git, robot is not Bot');
  assert.ok(topicTitles(sections).includes('Web Server'));
  assert.ok(!topicTitles(sections).includes('License'));
});

test('tutorial choice skips videos and prefers CHE languages, one per language first', () => {
  const sections = readmeSections(README);
  const bot = sections.find((section) => section.title === 'Bot');
  assert.deepEqual(sectionTutorials(bot.body).map((t) => t.language), ['Node.js', 'Python', 'Haskell']);
  const search = sections.find((section) => section.title === 'Search Engine');
  const picked = sectionTutorials(search.body);
  assert.deepEqual(picked.map((t) => t.language), ['JavaScript', 'Python', 'CSS']);
  assert.ok(picked.every((t) => /^https?:\/\//.test(t.url) && t.title));
});

test('tutorial pages are read as plain text; GitHub repositories through their README', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes('api.github.com/repos/example/nn-from-scratch/readme')) {
      return new Response(JSON.stringify({ content: Buffer.from('# NN from scratch\n' + 'Backpropagation adjusts weights. '.repeat(20)).toString('base64') }), { status: 200 });
    }
    return new Response(`<html><head><style>.x{}</style><script>alert(1)</script></head><body><nav>menu</nav><article><h1>Inverted index</h1><p>Map each word to the documents &amp; positions where it appears.</p>${'<p>Rank results with TF-IDF scores.</p>'.repeat(20)}</article><footer>footer</footer></body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const page = await readTutorial('https://example.dev/js-search', {}, fetcher);
  assert.match(page.text, /Inverted index\nMap each word to the documents & positions/);
  assert.doesNotMatch(page.text, /alert|menu|footer/);
  const repo = await readTutorial('https://github.com/example/nn-from-scratch', { CHE_GITHUB_TOKEN: 't' }, fetcher);
  assert.match(repo.text, /Backpropagation/);
  assert.ok(calls.includes('https://api.github.com/repos/example/nn-from-scratch/readme'));
  assert.equal((await readTutorial('http://127.0.0.1/admin', {}, fetcher)).error, 'blocked link');
  assert.equal((await readTutorial('file:///etc/passwd', {}, fetcher)).error, 'blocked link');
  assert.equal(calls.length, 2, 'blocked links are never fetched');
  const binary = await readTutorial('https://example.dev/file.zip', {}, async () => new Response('x', { status: 200, headers: { 'content-type': 'application/zip' } }));
  assert.match(binary.error, /not a readable page/);
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\nb');
});

test('the build request names its sources and forbids copying', () => {
  const request = topicBuildRequest({
    ownerRequest: OWNER_PROMPT,
    repo: 'codecrafters-io/build-your-own-x',
    topic: { title: 'Search Engine', index: 1, total: 6 },
    reads: [{ title: 'Search engine in JS', language: 'JavaScript', url: 'https://example.dev/js-search', text: 'x' }, { title: 'Unread', url: 'https://x', error: 'timeout' }],
    analysis: { lessons: ['Inverted index with TF-IDF ranking'], che_area: 'Brain room memory search', implementation_request: 'Add TF-IDF ranking to memory search.' },
  });
  assert.match(request, /Topic 1 of 6: Search Engine/);
  assert.match(request, /never copy/);
  assert.match(request, /https:\/\/example\.dev\/js-search/);
  assert.doesNotMatch(request, /Unread/);
  assert.match(request, /Add TF-IDF ranking to memory search\./);
  assert.match(request, /already does this as well or better, report that/);
});

import { STARRED_LIBRARY, namedRepoStudyIntent as studyIntent, starredLibraryIntent } from './topic_study.js';

test('owner starred repositories are a known study library', () => {
  assert.equal(STARRED_LIBRARY.length, 13);
  assert.ok(starredLibraryIntent('study all my starred repos'));
  assert.ok(starredLibraryIntent('Chay, learn from my starred repositories'));
  assert.ok(!starredLibraryIntent('star this repo for me'));
  assert.equal(studyIntent('study the system design primer')?.repo, 'donnemartin/system-design-primer');
  assert.equal(studyIntent('research openclaw and implement it in your own code')?.repo, 'openclaw/openclaw');
  assert.equal(studyIntent('read free code camp')?.repo, 'freeCodeCamp/freeCodeCamp');
});
