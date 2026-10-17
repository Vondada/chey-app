// REA investigation targets. CHE names what the owner pointed at (a public npm
// package, a public GitHub repository, a public web page, an App Store listing,
// or an app CHE cannot reach) and reads it with the permitted method for that
// kind. Every read here is a plain GET of public data: nothing from the target
// is executed, nothing is signed into, and nothing external is changed.
// Text from a target is untrusted data: it is cleaned and length-capped here,
// and never treated as instructions.
// Pure apart from the injected fetcher.

import { cleanText, NPM_NAME } from './rea_evidence.js';
import { fetchPublicPage, readablePublicUrl } from './library.js';
import { reusableLicense } from './code_scout.js';
import { robotsVerdict } from './rea_web_evidence.js';

const UA = 'CHE-REA';
const MAX_TREE_PATHS = 6000;
const MAX_MANIFESTS = 6;
const MAX_SOURCE_READS = 5;
const MAX_HTML_BYTES = 1_500_000;

const clip = (value, max = 200) => cleanText(value, max);
const link = (label, url) => ({ label: clip(label, 160), url: String(url || '').slice(0, 500) });

// ─── Target identification ───────────────────────────────────────────────

const NOT_A_NAME = /^(?:it|this|that|these|those|them|you|yourself|your|my|me|our|che|chey|the|a|an|how|what|why|which|code|app|apps|website|site|repo|repository|features?)$/i;
const KIND_WORD = '(?:app|application|website|web\\s*site|site|web\\s*app|tool|software|project|repo(?:sitory)?|program)';

function githubFromText(text) {
  const url = text.match(/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/#?\s)]|$)/i);
  if (url) return `${url[1]}/${url[2]}`;
  const named = text.match(/\b(?:github|repo(?:sitory)?)\s*:?\s+([\w.-]+\/[\w.-]+)\b/i)
    || text.match(/\b([\w.-]+\/[\w.-]+)\s+(?:repo(?:sitory)?|on github)\b/i);
  return named ? named[1].replace(/\.git$/i, '') : '';
}

/**
 * What the owner pointed at, or null. Kinds: npm, github, app_store,
 * play_store, website, private_app, app_name.
 */
export function identifyTarget(message) {
  const text = String(message || '').slice(0, 2000);
  const npm = text.match(/\bnpm:\s*((?:@[^\s@/]+\/)?[^\s@/]+)@(\S+)/i)
    || text.match(/\bnpm\s+(?:package\s+)?((?:@[^\s@/]+\/)?[a-z0-9][\w.~@/-]*)\s+(?:version\s+|v)?(\d\S*)/i);
  if (npm) return { kind: 'npm', name: npm[1].toLowerCase(), version: npm[2].replace(/[.,;:!?)]+$/, '') };
  const repo = githubFromText(text);
  if (repo) return { kind: 'github', full_name: repo, url: `https://github.com/${repo}` };
  const appStore = text.match(/https?:\/\/apps\.apple\.com\/[^\s)]*?\/id(\d{5,12})\b[^\s)]*/i);
  if (appStore) return { kind: 'app_store', id: appStore[1], url: appStore[0] };
  const play = text.match(/https?:\/\/play\.google\.com\/store\/apps\/details\?id=([\w.]+)[^\s)]*/i);
  if (play) return { kind: 'play_store', package: play[1], url: play[0] };
  const url = text.match(/https?:\/\/[^\s<>"')]+/i)?.[0]?.replace(/[.,;:!?]+$/, '');
  if (url) return { kind: 'website', url };
  const bareHost = text.match(/\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|so|me|xyz|edu|gov|us|uk|de|fr|ca))\b(?:\/[^\s)]*)?/i);
  if (bareHost && !/@/.test(text.slice(Math.max(0, bareHost.index - 1), bareHost.index))) {
    return { kind: 'website', url: `https://${bareHost[0].replace(/[.,;:!?]+$/, '')}` };
  }
  const name = appNameFrom(text);
  const privateBinary = /\b(?:private|internal|enterprise|company'?s?|in-house|unreleased)\b[\s\S]{0,60}\b(?:ios|iphone|ipad|android)\b|\b(?:ipa|apk|app binary|decrypt\w*|sandbox data|private api)\b|\b(?:ios|iphone|android)\s+app'?s?\s+(?:internals|binary|source code|private)/i.test(text);
  if (privateBinary) return { kind: 'private_app', name, platform: /\bandroid|apk\b/i.test(text) ? 'android' : 'ios' };
  if (name) return { kind: 'app_name', name };
  return null;
}

// "investigate the Excalidraw app", "study Obsidian and see…", "how does Notion's editor work".
export function appNameFrom(text) {
  const value = String(text || '');
  const patterns = [
    /\b(?:app|application|website|site)\s+(?:called\s+|named\s+)?["“]?([A-Z][\w.+&'-]*(?:\s+[A-Z][\w.+&'-]*){0,2})/,
    new RegExp(`\\b(?:the\\s+)?([A-Za-z0-9][\\w.+&'-]*(?:\\s+[A-Za-z0-9][\\w.+&'-]*){0,2})\\s+(?:ios\\s+|iphone\\s+|android\\s+|mobile\\s+|web\\s+)?${KIND_WORD}\\b`, 'i'),
    /\b(?:investigate|study|analy[sz]e|inspect|reverse[- ]engineer|examine|look into|discover|research)\s+(?:how\s+)?(?:the\s+)?([A-Z][\w.+&'-]*(?:\s+[A-Z][\w.+&'-]*){0,2})/,
  ];
  for (const pattern of patterns) {
    const found = value.match(pattern);
    if (!found) continue;
    // "your current repository", "my app": CHE's or the owner's own, never a target to investigate.
    if (/\b(?:your|my|our|che'?s|chey'?s)\b/i.test(found[1])) continue;
    const words = found[1].split(/\s+/).filter((w) => !NOT_A_NAME.test(w) && !/^(?:investigate|study|analy[sz]e|inspect|examine|discover|research|private|internal|public|open|source|their|its|his|her|works?|and|to|see|for|of)$/i.test(w));
    const name = words.join(' ').replace(/'s$/i, '').trim();
    if (name && name.length >= 2 && !NOT_A_NAME.test(name)) return clip(name, 60);
  }
  return '';
}

// ─── GitHub (public repositories, read-only) ─────────────────────────────

function ghHeaders(env, token = true) {
  const value = token ? String(env?.CHE_GITHUB_TOKEN || '').trim() : '';
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
    ...(value ? { Authorization: `Bearer ${value}` } : {}),
  };
}

async function getJson(fetcher, url, headers) {
  try {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(12000) });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (_) {
    return { ok: false, status: 0, data: null };
  }
}

async function getText(fetcher, url, max = 120_000) {
  try {
    const response = await fetcher(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return '';
    return (await response.text()).replace(/\0/g, '').slice(0, max);
  } catch (_) {
    return '';
  }
}

const rawUrl = (full, sha, path) => `https://raw.githubusercontent.com/${full}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
export const blobUrl = (full, sha, path, line) => `https://github.com/${full}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`;

// Repository search by name, for "investigate Excalidraw". Public results only.
export async function searchPublicRepos(env, name, fetcher = fetch, { limit = 5 } = {}) {
  const q = `${String(name || '').replace(/[^\w .+-]/g, ' ').trim()} in:name`;
  const found = await getJson(fetcher, `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${limit}`, ghHeaders(env));
  if (!found.ok) return { ok: false, status: found.status, repos: [] };
  const wanted = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const repos = (found.data?.items || []).filter((r) => !r.private).map((r) => ({
    full_name: String(r.full_name || ''),
    name: String(r.name || ''),
    stars: Number(r.stargazers_count || 0),
    description: clip(r.description, 200),
    homepage: readablePublicUrl(String(r.homepage || '')) ? String(r.homepage) : '',
    license: String(r.license?.spdx_id || '').toLowerCase(),
    exact: String(r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === wanted,
  }));
  repos.sort((a, b) => Number(b.exact) - Number(a.exact) || b.stars - a.stars);
  return { ok: true, repos };
}

const MANIFESTS = [
  /^package\.json$/, /^pubspec\.yaml$/, /^(?:app\/)?build\.gradle(?:\.kts)?$/, /^android\/app\/src\/main\/AndroidManifest\.xml$/,
  /^ios\/Runner\/Info\.plist$/, /^Package\.swift$/, /^Cargo\.toml$/, /^go\.mod$/, /^pyproject\.toml$/, /^requirements\.txt$/,
  /^Gemfile$/, /^composer\.json$/, /^(?:apps|packages)\/[\w.-]+\/package\.json$/, /^app\/src\/main\/AndroidManifest\.xml$/,
];
const ROUTE_FILE = /(?:^|\/)(?:router|routes?|routing|navigation|navigator|app_router|app\.(?:tsx?|jsx?|dart|vue)|main\.dart|App\.(?:tsx?|jsx?|vue|svelte))(?:\.[\w]+)?$|(?:^|\/)(?:router|routes|navigation)\//i;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|integration_test)\/|[._-](?:test|spec)\.[a-z]+$/i;
const SKIP = /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|coverage|\.git|generated)\//i;
const SOURCE = /\.(?:dart|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|go|rs|swift|kt|java|rb)$/i;

// File-based routes the tree itself proves (no file read needed).
export function fileRoutes(paths) {
  const routes = [];
  for (const path of paths) {
    let m = path.match(/^(?:src\/)?pages\/(.+?)\.(?:jsx?|tsx?|mdx?|vue)$/);
    if (m && !/^(?:_app|_document|_error|api\/)/.test(m[1])) {
      routes.push({ route: `/${m[1].replace(/(?:^|\/)index$/, '')}`, path, framework: /\.vue$/.test(path) ? 'Nuxt pages' : 'Next.js pages' });
      continue;
    }
    m = path.match(/^(?:src\/)?app\/(?:(.*)\/)?page\.(?:jsx?|tsx?|mdx)$/);
    if (m) { routes.push({ route: `/${(m[1] || '').replace(/\([^)]*\)\/?/g, '')}`, path, framework: 'Next.js app router' }); continue; }
    m = path.match(/^src\/routes\/(?:(.*)\/)?\+page\.svelte$/);
    if (m) { routes.push({ route: `/${m[1] || ''}`, path, framework: 'SvelteKit routes' }); continue; }
    m = path.match(/^app\/routes\/(.+)\.(?:jsx?|tsx?)$/);
    if (m) routes.push({ route: `/${m[1].replace(/\./g, '/').replace(/(?:^|\/)_index$/, '')}`, path, framework: 'Remix routes' });
  }
  return routes.slice(0, 40);
}

// Routes declared in code: React Router, Vue Router, GoRouter, Flutter named routes, Express.
export function codeRoutes(path, text) {
  const found = [];
  const lines = String(text || '').split('\n');
  const patterns = [
    [/<Route\b[^>]*\bpath=["'`]([^"'`]+)["'`]/, 'React Router'],
    [/\bGoRoute\s*\(\s*(?:[\w]+:\s*[^,]+,\s*)*path:\s*['"]([^'"]+)['"]/, 'GoRouter'],
    [/^\s*['"](\/[\w\-/:.]*)['"]\s*:\s*\(\s*(?:context|_|ctx)\b/, 'Flutter named routes'],
    [/\{\s*path:\s*['"`](\/[^'"`]*)['"`]/, 'route table'],
    [/\b(?:app|router)\.(?:get|post|put|delete|patch|use)\(\s*['"`](\/[^'"`]*)['"`]/, 'HTTP routes'],
  ];
  lines.forEach((line, index) => {
    for (const [pattern, framework] of patterns) {
      const m = line.match(pattern);
      if (m && m[1].length <= 80) { found.push({ route: clip(m[1], 80), path, line: index + 1, framework }); break; }
    }
  });
  return found.slice(0, 30);
}

function lineOf(text, needle) {
  const lines = String(text || '').split('\n');
  const lower = String(needle || '').toLowerCase();
  const i = lines.findIndex((l) => l.toLowerCase().includes(lower));
  return i >= 0 ? i + 1 : 0;
}

// Dependencies by manifest, as { name: line }.
export function manifestDependencies(path, text) {
  const deps = {};
  if (/package\.json$/.test(path)) {
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(data?.[field] || {})) if (NPM_NAME.test(name)) deps[name] = lineOf(text, `"${name}"`);
    }
    return { deps, meta: { name: clip(data?.name, 80), main: clip(data?.main || data?.module, 120), bin: data?.bin ? clip(typeof data.bin === 'string' ? data.bin : Object.values(data.bin)[0], 120) : '', scripts: Object.keys(data?.scripts || {}).slice(0, 12).map((s) => clip(s, 40)) } };
  }
  if (/pubspec\.yaml$/.test(path)) {
    let section = '';
    String(text).split('\n').forEach((line, i) => {
      const top = line.match(/^([\w]+):\s*$/);
      if (top) { section = top[1]; return; }
      const dep = line.match(/^ {2}([a-z][\w]*):/);
      if (dep && /dependencies$/.test(section)) deps[dep[1]] = i + 1;
    });
    return { deps, meta: { name: clip(String(text).match(/^name:\s*(\S+)/m)?.[1], 80) } };
  }
  if (/AndroidManifest\.xml$/.test(path)) {
    const activities = [...String(text).matchAll(/<activity\b[^>]*android:name="([^"]+)"/g)].map((m) => clip(m[1], 120)).slice(0, 20);
    const permissions = [...String(text).matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map((m) => clip(m[1].replace(/^android\.permission\./, ''), 80)).slice(0, 20);
    return { deps, meta: { activities, permissions } };
  }
  if (/Info\.plist$/.test(path)) {
    const usage = [...String(text).matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)].map((m) => clip(m[1], 80)).slice(0, 20);
    return { deps, meta: { usage_descriptions: usage } };
  }
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s*([A-Za-z][\w.-]*)\s*(?:[=<>~!]=?|==|\s+v?\d)/) || line.match(/^\s*(?:require|gem|implementation)\s*\(?\s*["']([\w.:/-]+)["']/);
    if (m && !/^(?:name|version|edition|module|go|description|authors?|license|python|requires-python)$/i.test(m[1])) deps[m[1].toLowerCase()] = i + 1;
  });
  return { deps, meta: {} };
}

/**
 * Reads one public repository at its current commit: metadata, licence,
 * languages, tree, manifests, README and the files that declare navigation.
 * `feature` (optional) is searched for in the code and cited by file and line.
 */
export async function inspectGithubRepo(env, fullName, { feature = '' } = {}, fetcher = fetch) {
  const full = String(fullName || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return { ok: false, reason: 'That is not a GitHub repository name (owner/name).' };
  const meta = await getJson(fetcher, `https://api.github.com/repos/${full}`, ghHeaders(env));
  if (!meta.ok) {
    return { ok: false, status: meta.status, reason: meta.status === 404 ? `GitHub has no public repository ${full}. Private repositories are not read.` : `GitHub did not answer for ${full} (status ${meta.status || 'none'}). Nothing was read.` };
  }
  if (meta.data?.private) return { ok: false, reason: `${full} is private. REA reads public repositories only.` };
  const branch = String(meta.data?.default_branch || 'main');
  const head = await getJson(fetcher, `https://api.github.com/repos/${full}/commits/${encodeURIComponent(branch)}`, ghHeaders(env));
  const sha = /^[0-9a-f]{40}$/.test(String(head.data?.sha || '')) ? head.data.sha : '';
  if (!sha) return { ok: false, reason: `GitHub did not give the current commit of ${full}, so nothing was read.` };
  const [tree, languages] = await Promise.all([
    getJson(fetcher, `https://api.github.com/repos/${full}/git/trees/${sha}?recursive=1`, ghHeaders(env)),
    getJson(fetcher, `https://api.github.com/repos/${full}/languages`, ghHeaders(env)),
  ]);
  // No file list means nothing was read: a retryable failure, never an empty repository.
  if (!tree.ok || !Array.isArray(tree.data?.tree)) {
    return { ok: false, status: tree.status, reason: `GitHub did not list the files of ${full} at ${sha.slice(0, 12)} (status ${tree.status || 'none'}). Nothing was mapped.` };
  }
  const entries = (Array.isArray(tree.data?.tree) ? tree.data.tree : []).filter((e) => e?.type === 'blob').slice(0, MAX_TREE_PATHS);
  const paths = entries.map((e) => String(e.path || '')).filter(Boolean);
  const license = String(meta.data?.license?.spdx_id || '').toLowerCase();
  const facts = {
    ok: true,
    kind: 'github',
    full_name: full,
    url: `https://github.com/${full}`,
    sha,
    branch,
    description: clip(meta.data?.description, 300),
    homepage: readablePublicUrl(String(meta.data?.homepage || '')) ? String(meta.data.homepage) : '',
    topics: (meta.data?.topics || []).slice(0, 12).map((t) => clip(t, 40)),
    stars: Number(meta.data?.stargazers_count || 0),
    archived: Boolean(meta.data?.archived),
    pushed_at: clip(meta.data?.pushed_at, 40),
    license: license || 'none',
    license_name: clip(meta.data?.license?.name || 'No licence detected', 80),
    reusable: reusableLicense(license),
    languages: Object.entries(languages.data || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, bytes]) => ({ name: clip(name, 40), bytes: Number(bytes) || 0 })),
    tree_truncated: Boolean(tree.data?.truncated) || entries.length >= MAX_TREE_PATHS,
    file_count: paths.length,
    top_dirs: topDirectories(paths),
    tests: paths.filter((p) => TEST_FILE.test(p) && !SKIP.test(p)).length,
    test_sample: paths.filter((p) => TEST_FILE.test(p) && !SKIP.test(p)).slice(0, 5),
    workflows: paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).slice(0, 10),
    docs: paths.filter((p) => /^(?:docs?\/|README|CONTRIBUTING|ARCHITECTURE)/i.test(p)).slice(0, 10),
    manifests: [],
    routes: fileRoutes(paths),
    readme: { path: '', features: [] },
    feature_hits: [],
    entry_points: entryPoints(paths),
    reads: 0,
  };
  // Manifests and the README come from raw.githubusercontent.com at the exact commit.
  const manifestPaths = pickManifests(paths);
  const readmePath = paths.find((p) => /^readme(?:\.md|\.markdown|\.rst|\.txt)?$/i.test(p)) || '';
  const routeFiles = paths.filter((p) => SOURCE.test(p) && ROUTE_FILE.test(p) && !SKIP.test(p) && !TEST_FILE.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length).slice(0, MAX_SOURCE_READS);
  const texts = await Promise.all([...manifestPaths, ...(readmePath ? [readmePath] : []), ...routeFiles].map(async (path) => [path, await getText(fetcher, rawUrl(full, sha, path))]));
  facts.reads = texts.filter(([, text]) => text).length;
  facts.unread = texts.filter(([, text]) => !text).map(([path]) => path).slice(0, 10);
  for (const [path, text] of texts) {
    if (!text) continue;
    if (manifestPaths.includes(path)) {
      const parsed = manifestDependencies(path, text);
      facts.manifests.push({ path, deps: Object.fromEntries(Object.entries(parsed.deps).slice(0, 120)), meta: parsed.meta });
    } else if (path === readmePath) {
      facts.readme = { path, features: readmeFeatures(text) };
    } else {
      facts.routes.push(...codeRoutes(path, text));
    }
  }
  facts.routes = facts.routes.slice(0, 40);
  if (feature) facts.feature_hits = await findFeatureInRepo(env, full, sha, paths, feature, fetcher);
  return facts;
}

// The root manifest first, then app folders, then packages; never examples, docs or tests.
export function pickManifests(paths) {
  const score = (p) => (p.includes('/') ? 0 : 10) + (/(?:^|[/-])app(?:s)?(?:[/-]|$)/i.test(p) ? 5 : 0) + (/^packages\//.test(p) ? 2 : 0) - p.split('/').length;
  const nested = /^[\w.-]+\/(?:[\w.-]+\/)?(?:package\.json|pubspec\.yaml)$/;
  return paths.filter((p) => (MANIFESTS.some((m) => m.test(p)) || nested.test(p)) && !SKIP.test(p) && !TEST_FILE.test(p) && !/(?:^|\/)(?:examples?|docs?|dev-docs|demo|samples?|fixtures?|benchmarks?)\//i.test(p))
    .sort((a, b) => score(b) - score(a) || a.localeCompare(b)).slice(0, MAX_MANIFESTS);
}

function topDirectories(paths) {
  const counts = new Map();
  for (const p of paths) {
    if (SKIP.test(p)) continue;
    const top = p.includes('/') ? `${p.split('/')[0]}/` : '(root files)';
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([dir, files]) => ({ dir: clip(dir, 80), files }));
}

function entryPoints(paths) {
  const wanted = [/^lib\/main\.dart$/, /^src\/main\.(?:tsx?|jsx?|vue)$/, /^src\/index\.(?:tsx?|jsx?)$/, /^(?:src\/)?app\/layout\.(?:tsx?|jsx?)$/, /^pages\/_app\.(?:tsx?|jsx?)$/,
    /^index\.(?:m?js|ts)$/, /^main\.(?:py|go)$/, /^cmd\/[\w-]+\/main\.go$/, /^src\/main\.rs$/, /^app\/src\/main\/java\/.+\/MainActivity\.(?:kt|java)$/, /^src\/App\.(?:tsx?|jsx?|vue|svelte)$/];
  return paths.filter((p) => wanted.some((w) => w.test(p))).slice(0, 8);
}

// Bullets under a "Features" heading, with their README line.
export function readmeFeatures(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let inFeatures = false;
  lines.forEach((line, index) => {
    const heading = line.match(/^#{1,4}\s+(.+?)\s*#*\s*$/) || (/^[=-]{3,}\s*$/.test(lines[index + 1] || '') ? [line, line] : null);
    if (heading) { inFeatures = /\b(?:features?|what (?:it|you can) do|highlights|capabilities)\b/i.test(heading[1]); return; }
    if (!inFeatures) return;
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.{3,})/);
    if (bullet) {
      const textOnly = bullet[1].replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '').trim();
      if (textOnly.length >= 3) out.push({ text: clip(textOnly, 160), line: index + 1 });
    }
  });
  return out.slice(0, 20);
}

// Where a named feature lives in the code: code search when GitHub allows it,
// then the file tree; each hit is cited by file and line at the exact commit.
async function findFeatureInRepo(env, full, sha, paths, feature, fetcher) {
  const terms = featureTerms(feature);
  if (!terms.length) return [];
  const candidates = new Set();
  if (String(env?.CHE_GITHUB_TOKEN || '').trim()) {
    const search = await getJson(fetcher, `https://api.github.com/search/code?q=${encodeURIComponent(`${terms.slice(0, 2).join(' ')} repo:${full}`)}&per_page=8`, ghHeaders(env));
    for (const item of search.data?.items || []) if (!SKIP.test(item.path) && SOURCE.test(item.path)) candidates.add(String(item.path));
  }
  for (const p of paths) {
    if (candidates.size >= 8) break;
    if (SOURCE.test(p) && !SKIP.test(p) && terms.some((t) => p.toLowerCase().includes(t))) candidates.add(p);
  }
  const hits = [];
  for (const path of [...candidates].slice(0, 4)) {
    const text = await getText(fetcher, rawUrl(full, sha, path), 200_000);
    const lines = text.split('\n');
    const index = lines.findIndex((l) => terms.some((t) => l.toLowerCase().includes(t)));
    if (index >= 0) hits.push({ path, line: index + 1, excerpt: clip(lines[index], 160), url: blobUrl(full, sha, path, index + 1), test: TEST_FILE.test(path) });
  }
  return hits;
}

export function featureTerms(feature) {
  const stop = new Set(['the', 'and', 'feature', 'features', 'how', 'its', 'their', 'with', 'for', 'that', 'this', 'works', 'work', 'does', 'app', 'one', 'functional']);
  return [...new Set(String(feature || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w)))].slice(0, 4);
}

// ─── Public web pages (static read) ──────────────────────────────────────

// robots.txt for the generic agent. Unreachable or missing robots.txt means allowed.
export async function robotsAllows(url, fetcher = fetch) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return { allowed: false, reason: 'That link is not valid.' }; }
  const page = await fetchPublicPage(`${parsed.origin}/robots.txt`, fetcher, { maxBytes: 200_000, userAgent: UA }).catch(() => ({ error: 'unreachable' }));
  if (page.error || !page.raw) return { allowed: true, checked: false };
  const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
  const verdict = robotsVerdict(page.raw, path);
  return verdict.allowed ? { allowed: true, checked: true } : { allowed: false, checked: true, rule: verdict.rule, reason: `The site's robots.txt asks automated readers not to read ${parsed.pathname || '/'} (${verdict.rule}). CHE respects that.` };
}

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((v) => v !== undefined) || '';
const strip = (html) => String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** Structure of one page's HTML, as observed facts. Pure. */
export function analyzeHtml(html, pageUrl) {
  const raw = String(html || '');
  const base = (() => { try { return new URL(pageUrl); } catch (_) { return null; } })();
  const abs = (href) => { try { return new URL(href, base || undefined).toString(); } catch (_) { return ''; } };
  const tags = (name) => [...raw.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
  const meta = (name) => attr(tags('meta').find((t) => new RegExp(`(?:name|property)\\s*=\\s*["']${name}["']`, 'i').test(t)) || '', 'content');
  const labels = new Map(tags('label').map((t) => [attr(t, 'for'), t]));
  const labelText = new Map([...raw.matchAll(/<label\b[^>]*for\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/label>/gi)].map((m) => [m[1], clip(strip(m[2]), 60)]));
  const navBlocks = [...raw.matchAll(/<(nav|header)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]).join('\n');
  const navLinks = [...navBlocks.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ text: clip(strip(m[2]) || attr(m[1], 'aria-label'), 60), href: abs(attr(m[1], 'href')) }))
    .filter((l) => l.text && l.href && !/^javascript:/i.test(l.href));
  const forms = [...raw.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].slice(0, 10).map((m) => {
    const fields = [...m[2].matchAll(/<(input|textarea|select)\b([^>]*)>/gi)].map((f) => {
      const type = f[1].toLowerCase() === 'input' ? (attr(f[2], 'type') || 'text').toLowerCase() : f[1].toLowerCase();
      const id = attr(f[2], 'id');
      return { type: clip(type, 20), name: clip(attr(f[2], 'name'), 40), label: labelText.get(id) || clip(attr(f[2], 'aria-label') || attr(f[2], 'placeholder'), 60), required: /\brequired\b/i.test(f[2]) };
    }).filter((f) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(f.type)).slice(0, 12);
    return { method: clip((attr(m[1], 'method') || 'get').toLowerCase(), 10), role: clip(attr(m[1], 'role'), 20), action_host: (() => { try { return new URL(abs(attr(m[1], 'action')) || pageUrl).host; } catch (_) { return ''; } })(), fields };
  });
  const looseInputs = tags('input').filter((t) => /type\s*=\s*["']?(?:search|email|password)/i.test(t) || /\bname\s*=\s*["']?(?:q|query|search|s)\b/i.test(t));
  const buttons = [...raw.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((m) => clip(strip(m[2]) || attr(m[1], 'aria-label') || attr(m[1], 'title'), 50));
  const scripts = tags('script').map((t) => attr(t, 'src')).filter(Boolean).map(abs);
  const host = base?.host || '';
  const thirdParty = [...new Set(scripts.map((s) => { try { return new URL(s).host; } catch (_) { return ''; } }).filter((h) => h && h !== host))].slice(0, 15);
  const images = tags('img');
  const hints = [];
  if (/__NEXT_DATA__|\/_next\/static\//.test(raw)) hints.push('Next.js');
  if (/data-reactroot|react-dom|__REACT_DEVTOOLS/.test(raw)) hints.push('React');
  if (/__NUXT__|\/_nuxt\//.test(raw)) hints.push('Nuxt');
  if (/\bng-version=/.test(raw)) hints.push('Angular');
  if (/data-svelte|__sveltekit|\/_app\/immutable\//.test(raw)) hints.push('Svelte/SvelteKit');
  if (/wp-content\/|wp-includes\//.test(raw)) hints.push('WordPress');
  if (/cdn\.shopify\.com|Shopify\.theme/.test(raw)) hints.push('Shopify');
  if (/static\.wixstatic\.com|wix\.com/.test(raw)) hints.push('Wix');
  if (/squarespace\.com|static1\.squarespace/.test(raw)) hints.push('Squarespace');
  if (/webflow\.(?:com|io)/.test(raw)) hints.push('Webflow');
  if (/gatsby-/.test(raw)) hints.push('Gatsby');
  if (/\bdata-turbo|turbolinks/i.test(raw)) hints.push('Rails/Hotwire');
  const generator = clip(meta('generator'), 80);
  if (generator) hints.push(`generator: ${generator}`);
  const jsonLd = [...raw.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => clip(m[1].match(/"@type"\s*:\s*"([^"]+)"/)?.[1], 40)).filter(Boolean).slice(0, 6);
  const challenge = /<title>\s*(?:just a moment|attention required|access denied|verify you are human)/i.test(raw) || /cf-chl-|challenge-platform|g-recaptcha|hcaptcha\.com/i.test(raw);
  return {
    title: clip(strip(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), 160),
    description: clip(meta('description') || meta('og:description'), 300),
    site_name: clip(meta('og:site_name'), 80),
    lang: clip(attr(tags('html')[0] || '', 'lang'), 20),
    viewport: Boolean(meta('viewport')),
    manifest: tags('link').some((t) => /rel\s*=\s*["']?manifest/i.test(t)),
    service_worker: /serviceWorker\.register/.test(raw),
    alternates: tags('link').filter((t) => /hreflang/i.test(t)).length,
    landmarks: {
      header: tags('header').length, nav: tags('nav').length, main: tags('main').length + tags('[^>]*role\\s*=\\s*["\']main').length,
      footer: tags('footer').length, aside: tags('aside').length, search: (raw.match(/role\s*=\s*["']search["']/gi) || []).length + tags('search').length,
    },
    headings: [...raw.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: clip(strip(m[2]), 100) })).filter((h) => h.text).slice(0, 25),
    nav_links: navLinks.slice(0, 40),
    forms,
    loose_inputs: looseInputs.map((t) => ({ type: clip((attr(t, 'type') || 'text').toLowerCase(), 20), name: clip(attr(t, 'name'), 40) })).slice(0, 10),
    buttons: buttons.filter(Boolean).slice(0, 30),
    buttons_without_name: buttons.filter((b) => !b).length,
    images: images.length,
    images_missing_alt: images.filter((t) => !/\balt\s*=/i.test(t)).length,
    skip_link: /href\s*=\s*["']#(?:main|content|maincontent)["'][^>]*>\s*skip/i.test(raw) || /skip to (?:main )?content/i.test(raw),
    videos: tags('video').length + tags('iframe').filter((t) => /youtube|vimeo/i.test(t)).length,
    iframes: tags('iframe').length,
    scripts: scripts.length,
    stylesheets: tags('link').filter((t) => /rel\s*=\s*["']?stylesheet/i.test(t)).length,
    third_party_hosts: thirdParty,
    framework_hints: hints,
    json_ld: jsonLd,
    cookie_notice: /cookie(?:s)? (?:consent|preferences|settings|policy)|we use cookies/i.test(strip(raw).slice(0, 20000)),
    challenge,
    text_chars: strip(raw).length,
  };
}

/** One public page, read once as HTML. Robots and bot challenges are respected. */
export async function inspectWebsite(url, fetcher = fetch) {
  if (!readablePublicUrl(url)) return { ok: false, reason: 'Only public web pages can be investigated: no sign-in links, local addresses, raw IP addresses or odd ports.' };
  const robots = await robotsAllows(url, fetcher);
  if (!robots.allowed) return { ok: false, refused: true, reason: robots.reason };
  // A redirect to another site is read only if that site's robots.txt allows it too.
  // Robots rules apply to paths, not only origins. A redirect within the
  // same origin can land on a disallowed path, so cache decisions by URL.
  const checkedUrls = new Map([[new URL(url).href, robots]]);
  const beforeFetch = async (next) => {
    const href = new URL(next).href;
    if (!checkedUrls.has(href)) checkedUrls.set(href, await robotsAllows(href, fetcher));
    return checkedUrls.get(href);
  };
  const page = await fetchPublicPage(url, fetcher, { maxBytes: MAX_HTML_BYTES, userAgent: 'Mozilla/5.0 (compatible; CHE-REA)', beforeFetch }).catch((error) => ({ error: String(error?.message || error).slice(0, 120) }));
  if (page.refused) return { ok: false, refused: true, reason: page.error };
  if (page.error) {
    const walled = [401, 403, 429, 503].includes(page.status);
    return { ok: false, refused: walled, reason: walled ? `The site answered ${page.status}: it needs a sign-in or blocks automated readers. CHE does not get around sign-ins or bot protection.` : `The page could not be read: ${page.error}` };
  }
  if (!/html/i.test(page.type) && !/<html|<body/i.test(page.raw)) return { ok: false, reason: `That link is not a web page (${clip(page.type, 60) || 'unknown type'}).` };
  const facts = analyzeHtml(page.raw, page.final_url);
  if (facts.challenge) return { ok: false, refused: true, reason: 'The site showed a bot check instead of its page. CHE does not get around bot protection. Screenshots or a recording from you would let me study it.' };
  const digest = await sha256Hex(page.raw);
  return { ok: true, kind: 'website', url, final_url: page.final_url, host: new URL(page.final_url).host, content_sha256: digest, robots_checked: robots.checked, bytes: page.raw.length, ...facts };
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── App Store listing (public metadata only) ────────────────────────────

function listingFrom(item) {
  if (!item?.trackId) return null;
  const description = String(item.description || '');
  const bullets = description.split('\n').map((l) => l.trim()).filter((l) => /^(?:[•\-*●▪◦–]|\d+[.)])\s*\S/.test(l)).map((l) => clip(l.replace(/^(?:[•\-*●▪◦–]|\d+[.)])\s*/, ''), 160)).slice(0, 15);
  return {
    kind: 'app_store',
    id: String(item.trackId),
    name: clip(item.trackName, 100),
    seller: clip(item.sellerName || item.artistName, 100),
    bundle_id: clip(item.bundleId, 120),
    version: clip(item.version, 40),
    released: clip(item.currentVersionReleaseDate || item.releaseDate, 40),
    genre: clip(item.primaryGenreName, 60),
    price: clip(item.formattedPrice || (item.price === 0 ? 'Free' : item.price), 30),
    rating: Number.isFinite(item.averageUserRating) ? Math.round(item.averageUserRating * 10) / 10 : null,
    ratings: Number(item.userRatingCount || 0),
    minimum_os: clip(item.minimumOsVersion, 20),
    size_mb: item.fileSizeBytes ? Math.round(Number(item.fileSizeBytes) / 1048576) : null,
    languages: (item.languageCodesISO2A || []).length,
    advisory: clip(item.contentAdvisoryRating, 20),
    url: String(item.trackViewUrl || '').split('?')[0].slice(0, 300),
    seller_url: readablePublicUrl(String(item.sellerUrl || '')) ? String(item.sellerUrl) : '',
    release_notes: clip(item.releaseNotes, 400),
    description: clip(description, 700),
    bullets,
    screenshot_count: (item.screenshotUrls || []).length + (item.ipadScreenshotUrls || []).length,
  };
}

/** The public App Store listing by id, or the best match for a name. */
export async function lookupAppStore({ id = '', name = '' } = {}, fetcher = fetch) {
  const url = id
    ? `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=us`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(String(name).slice(0, 80))}&entity=software&limit=3&country=us`;
  const found = await getJson(fetcher, url, { Accept: 'application/json', 'User-Agent': UA });
  if (!found.ok) return { ok: false, reason: `The App Store did not answer (status ${found.status || 'none'}).` };
  const results = (found.data?.results || []).map(listingFrom).filter(Boolean);
  if (!results.length) return { ok: false, reason: id ? 'The App Store has no app with that id.' : `The App Store search found no app called "${clip(name, 60)}".` };
  const wanted = String(name || '').toLowerCase();
  const best = results.find((r) => r.name.toLowerCase() === wanted) || results.find((r) => r.name.toLowerCase().includes(wanted)) || results[0];
  return { ok: true, listing: best, others: results.filter((r) => r !== best).map((r) => ({ name: r.name, seller: r.seller, url: r.url })) };
}

// What CHE cannot reach in someone else's installed app, said once, plainly.
export const PRIVATE_APP_LIMITS = Object.freeze([
  'The app\'s binary: App Store apps are encrypted for each device, and CHE does not decrypt or extract them.',
  'Its source code and private APIs: they are not public, and CHE does not intercept an app\'s network traffic.',
  'Data inside the app on your iPhone: iOS keeps every app\'s data in its own sandbox, which CHE cannot read.',
  'Running it under a debugger or an emulator: that needs a macOS build host or an Android emulator, and neither is set up for CHE.',
]);

export const PRIVATE_APP_ALTERNATIVES = Object.freeze([
  'Its public App Store listing: description, version, features it advertises (I checked it below when I could find it).',
  'Its public website and help pages, if you give me the link.',
  'Screenshots or a screen recording you send me: I can map the screens and buttons you show.',
  'An open-source app that does the same job: I can read its real source and cite files.',
]);

export function linkFor(label, url) { return link(label, url); }
