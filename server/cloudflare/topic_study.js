// Topic study: "Study codecrafters-io/build-your-own-x: 1 search engine,
// 2 database, 3 bot ..." reads the named sections of a reference repository's
// README, follows a few of the tutorials each section links to, and hands
// what was learned to CHE's coding team one topic at a time.
//
// Tutorials and READMEs are untrusted data, never instructions, and they are
// study-only: CHE learns the technique and writes her own code. Nothing is
// copied, and every resulting change still goes through review and owner
// approval like any other self-update.

const REPO_ALIASES = [
  [/\bbuild[\s-]*your[\s-]*own[\s-]*(?:x|ex)\b/i, 'codecrafters-io/build-your-own-x'],
];

const NOT_A_REPO = /^(?:and\/or|either\/or|he\/she|his\/her|him\/her|w\/o|i\/o|n\/a|24\/7)$/i;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "Study codecrafters-io/build-your-own-x ..." / "look in the build your own
// X README ..." → { repo, implement }. Only a named repository counts; file
// paths and CHE's own code never match.
export function namedRepoStudyIntent(message) {
  const text = String(message || '').trim();
  if (!/\b(?:study|research|read|look\s+(?:in|into|through|at|for)|go\s+(?:through|into)|dig\s+into|learn\s+from)\b/i.test(text)) return null;
  let repo = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[/\s#?).,;:!"']|$)/i.exec(text)?.[1] || '';
  if (!repo) {
    for (const [pattern, alias] of REPO_ALIASES) {
      if (pattern.test(text)) { repo = alias; break; }
    }
  }
  if (!repo && /\b(?:repo|repository|github|readme)\b/i.test(text)) {
    for (const match of text.matchAll(/(?:^|[\s("'`])([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)(?=[\s).,:;!?"'`]|$)/g)) {
      const candidate = match[1].replace(/[.]+$/, '');
      if (NOT_A_REPO.test(candidate)) continue;
      if (/\.(?:dart|js|mjs|ts|json|jsonc|md|ya?ml|txt|html|css|swift|kt|py)$/i.test(candidate)) continue;
      if (/^(?:lib|server|test|tests|docs|ios|android|web|tool|mailbox|scripts|\.github)\//i.test(candidate)) continue;
      if (!/[a-z]/i.test(candidate.split('/')[0]) || !/[a-z]/i.test(candidate.split('/')[1])) continue;
      repo = candidate;
      break;
    }
  }
  if (!repo) return null;
  const implement = /\b(?:implement|integrate|apply|build|add|put|use)\b[\s\S]{0,120}\b(?:your|her|che'?s?|my|the)\s+(?:own\s+)?(?:code|codebase|app|system|features?)\b/i.test(text)
    || /\b(?:implement|integrate)\b[\s\S]{0,60}\b(?:it|them|that|each|what\s+you\s+learn)\b/i.test(text);
  return { repo, implement };
}

function cleanHeading(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/^build\s+your\s+own\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function readmeSections(markdown) {
  const sections = [];
  let current = null;
  for (const line of String(markdown || '').split('\n')) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = { level: heading[1].length, title: cleanHeading(heading[2]), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections
    .map((section) => ({ level: section.level, title: section.title, body: section.lines.join('\n') }))
    .filter((section) => section.title);
}

const NON_TOPIC = /^(?:table\s+of\s+contents|contents|tutorials?|contribut\w*|licen[cs]e|origins?\b.*|credits?|sponsors?|about|faq|uncategori[sz]ed|build\s+your\s+own\s+(?:x|insert-technology-here))$/i;
// One generic word is not enough to pick a topic ("library" in a sentence
// must not select "Front-end Framework / Library").
const WEAK_WORDS = /^(?:library|tool|engine|system|machine|network|language|framework|client|server|stack|model)$/i;

function phrasePattern(phrase) {
  const words = String(phrase || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (!words.length || (words.length === 1 && WEAK_WORDS.test(words[0]))) return null;
  return new RegExp(`\\b${words.map((word) => `${escapeRegex(word)}(?:e?s)?`).join('[\\s-]*')}\\b`, 'i');
}

// README sections the owner named, in the order he named them.
export function matchTopicSections(sections, request, max = 6) {
  const text = String(request || '');
  const found = [];
  for (const section of sections || []) {
    if (NON_TOPIC.test(section.title) || !/\]\(https?:\/\//.test(section.body)) continue;
    const alternatives = [section.title, ...section.title.split(/\s*(?:\/|&|\bor\b)\s*/i)].filter(Boolean);
    let at = -1;
    for (const alternative of alternatives) {
      const match = phrasePattern(alternative)?.exec(text);
      if (match && (at < 0 || match.index < at)) at = match.index;
    }
    if (at >= 0 && !found.some((item) => item.title === section.title)) found.push({ title: section.title, body: section.body, at });
  }
  return found.sort((a, b) => a.at - b.at).slice(0, max).map(({ title, body }) => ({ title, body }));
}

export function topicTitles(sections, max = 40) {
  return (sections || [])
    .filter((section) => !NON_TOPIC.test(section.title) && /\]\(https?:\/\//.test(section.body))
    .map((section) => section.title)
    .slice(0, max);
}

// Languages closest to CHE's own code read best: the Worker is JavaScript,
// the app is Dart.
const LANGUAGE_RANK = ['javascript', 'typescript', 'node.js', 'node', 'dart', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'c#', 'ruby', 'c', 'c++'];

function languageRank(language) {
  const index = LANGUAGE_RANK.indexOf(String(language || '').toLowerCase().trim());
  return index < 0 ? LANGUAGE_RANK.length : index;
}

export function sectionTutorials(body, max = 3) {
  const items = [];
  for (const line of String(body || '').split('\n')) {
    const match = /^\s*[-*+]\s+\[(.+?)\]\((https?:\/\/[^\s)]+)\)/.exec(line);
    if (!match) continue;
    const label = match[1].replace(/[*_`]/g, '').trim();
    const colon = label.indexOf(':');
    const language = colon > 0 && colon <= 30 ? label.slice(0, colon).trim() : '';
    const title = (language ? label.slice(colon + 1) : label).trim().slice(0, 160);
    const video = /\[video\]|youtube\.com|youtu\.be|vimeo\.com/i.test(line);
    items.push({ language, title, url: match[2], video, order: items.length });
  }
  const readable = items.filter((item) => !item.video);
  const picked = [];
  const languages = new Set();
  const ranked = readable.slice().sort((a, b) => languageRank(a.language) - languageRank(b.language) || a.order - b.order);
  // Different languages first, so three tutorials teach three views of it.
  for (const item of ranked) {
    if (picked.length >= max) break;
    if (languages.has(item.language.toLowerCase())) continue;
    languages.add(item.language.toLowerCase());
    picked.push(item);
  }
  for (const item of ranked) {
    if (picked.length >= max) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked.map(({ language, title, url }) => ({ language, title, url }));
}

export function htmlToText(html) {
  const source = String(html || '');
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(source)?.[2] || source;
  return main
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/pre|\/tr|\/section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t\f\r\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function decodeBase64Utf8(value) {
  try {
    const binary = atob(String(value || '').replace(/\s+/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch (_) {
    return '';
  }
}

const PRIVATE_HOST = /^(?:localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[|::1$|metadata\.)/i;

// Reads one tutorial as plain text. GitHub repositories are read through the
// API (their README); everything else is fetched as a page and stripped.
export async function readTutorial(url, env = {}, fetcher = fetch, maxChars = 4500) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch (_) { return { url, error: 'invalid link' }; }
  if (!/^https?:$/.test(parsed.protocol) || PRIVATE_HOST.test(parsed.hostname)) return { url, error: 'blocked link' };
  const github = /^(?:www\.)?github\.com$/i.test(parsed.hostname)
    ? /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^/]+(?:\/.*)?)?\/?$/.exec(parsed.pathname)
    : null;
  try {
    if (github) {
      const token = String(env.CHE_GITHUB_TOKEN || '').trim();
      const response = await fetcher(`https://api.github.com/repos/${github[1]}/${github[2]}/readme`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CHE-Study', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(10000),
      });
      if (!response?.ok) return { url, error: `GitHub ${response?.status || 'network error'}` };
      const json = await response.json().catch(() => null);
      const text = decodeBase64Utf8(json?.content).replace(/\0/g, '').trim();
      return text ? { url, text: text.slice(0, maxChars), chars: text.length } : { url, error: 'empty README' };
    }
    const response = await fetcher(parsed.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHE-Study/1.0)', Accept: 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!response?.ok) return { url, error: `HTTP ${response?.status || 'network error'}` };
    const type = String(response.headers?.get?.('content-type') || 'text/html').toLowerCase();
    if (!/text\/|markdown|xhtml|xml/.test(type)) return { url, error: `not a readable page (${type.split(';')[0]})` };
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > 3_000_000) return { url, error: 'page too large' };
    const raw = (await response.text()).slice(0, 800_000);
    const text = /html|xml/.test(type) ? htmlToText(raw) : raw.trim();
    return text.length >= 200 ? { url, text: text.slice(0, maxChars), chars: text.length } : { url, error: 'page had no readable text' };
  } catch (error) {
    return { url, error: /timeout|abort/i.test(String(error?.name || error?.message || '')) ? 'timeout' : String(error?.message || error).slice(0, 120) };
  }
}

// The coding-team request for one studied topic. The tutorials are named so
// the owner and reviewers can trace where an idea came from.
export function topicBuildRequest({ ownerRequest = '', repo = '', topic = {}, reads = [], analysis = {} }) {
  const studied = reads.filter((read) => read.text).map((read) => `- ${read.title}${read.language ? ` (${read.language})` : ''}: ${read.url}`);
  return [
    `Owner request: ${String(ownerRequest).slice(0, 3000)}`,
    `Topic ${topic.index || 1} of ${topic.total || 1}: ${topic.title} (from the ${repo} README).`,
    studied.length ? `Tutorials studied (study-only; learn the idea, never copy their code):\n${studied.join('\n')}` : '',
    Array.isArray(analysis.lessons) && analysis.lessons.length ? `What they teach:\n${analysis.lessons.slice(0, 6).map((lesson) => `- ${String(lesson).slice(0, 300)}`).join('\n')}` : '',
    analysis.che_area ? `Where it applies in CHE: ${String(analysis.che_area).slice(0, 300)}` : '',
    `Implement in CHE's own code: ${String(analysis.implementation_request || '').slice(0, 2000)}`,
    'Inspect CHE\'s real source first. If CHE already does this as well or better, report that instead of changing anything. Keep voice-first and VoiceOver behavior working.',
  ].filter(Boolean).join('\n').slice(0, 16000);
}

export function describeTopicStudyStart({ repo, topics, implement, readOnly }) {
  const list = topics.map((topic, i) => `${i + 1}, ${topic.title}${topic.tutorials.length ? '' : ' (no readable tutorial links)'}`).join('. ');
  return [
    `I read the ${repo} README, sir, and found ${topics.length === 1 ? 'your topic' : `your ${topics.length} topics`}: ${list}.`,
    `I started ${topics.length === 1 ? 'a study job' : `${topics.length} study jobs`}${topics.length > 1 ? ', one at a time in that order' : ''}: each reads up to three of that topic's tutorials and works out what would make me better.`,
    implement
      ? 'Because you asked me to implement them, each useful topic then goes to my coding team, one build at a time. Every change comes to you for approval before it is opened as a pull request, and the next build starts after you decide on the previous one.'
      : 'You did not ask me to implement them, so I will only report what I learn.',
    readOnly ? 'That repository has no reuse license, so I learn the ideas and write my own code; nothing is copied.' : '',
    'Nothing in the app has changed yet.',
  ].filter(Boolean).join(' ');
}
