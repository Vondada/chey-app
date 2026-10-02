// CHE scouts GitHub for top, legally-reusable public code that matches a need,
// and feeds it to her coding crew as reference. Safety + legality first:
//  - Only permissive licenses (reuse allowed); everything else is skipped.
//  - Results are DATA the crew learns from and adapts, reviewed + owner-approved
//    like any self-update — never blind auto-merge of a stranger's code.

const REUSABLE = new Set(['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc', '0bsd', 'unlicense', 'mpl-2.0', 'cc0-1.0']);

function ghHeaders(env) {
  const token = String(env.CHE_GITHUB_TOKEN || '').trim();
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'CHE-CodeScout',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}


function githubOwner(env) {
  return String(env.CHE_GITHUB_REPO || '').trim().split('/')[0] || '';
}

function starredRepoRecord(r) {
  const license = String(r?.license?.spdx_id || '').toLowerCase();
  return {
    full_name: String(r?.full_name || ''),
    stars: Number(r?.stargazers_count || 0),
    description: String(r?.description || '').slice(0, 240),
    url: String(r?.html_url || ''),
    license,
    license_name: String(r?.license?.name || 'No license detected'),
    language: String(r?.language || ''),
    archived: Boolean(r?.archived),
    pushed_at: String(r?.pushed_at || ''),
    topics: Array.isArray(r?.topics) ? r.topics.map(String).slice(0, 20) : [],
    reusable: REUSABLE.has(license),
  };
}

function starredScore(repo, focus = []) {
  const defaultTerms = [
    'agent', 'agency', 'multi-agent', 'orchestration', 'llm', 'ai', 'rag',
    'memory', 'voice', 'speech', 'browser', 'automation', 'flutter',
    'offline', 'coding', 'assistant',
  ];
  const terms = focus.length ? focus : defaultTerms;
  const haystack = [
    repo.full_name,
    repo.description,
    repo.language,
    ...(repo.topics || []),
  ].join(' ').toLowerCase();
  let score = 0;
  for (const term of terms) {
    const t = String(term || '').toLowerCase().trim();
    if (t && haystack.includes(t)) score += t.includes('-') ? 4 : 2;
  }
  if (repo.reusable) score += 2;
  if (repo.archived) score -= 8;
  score += Math.min(3, Math.log10(Math.max(1, repo.stars)));
  return score;
}

// Repository-library requests must be researched before they are sent to the
// exact source-patch lane. This prevents broad GitHub jobs from being treated
// like "find this on-screen text" edits.
export function starredRepoIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey|shay)[,:]?\s+/i, '');
  const collection = /\b(?:starred(?:\s+github)?\s+(?:repos?|repositories)|github\s+stars?|(?:repos?|repositories)\s+(?:i\s+)?(?:have\s+)?starred|inspirations?(?:\s+(?:list|tab|collection))?)\b/i.test(text);
  const action = /\b(?:inspect|scan|review|research|analy[sz]e|go\s+through|look\s+through|check|find|study|use|integrate|adapt|take\s+code)\b/i.test(text);
  if (!collection || !action) return null;

  const focus = [];
  const focusWords = [
    'agent', 'agency', 'multi-agent', 'orchestration', 'rag', 'memory',
    'voice', 'speech', 'browser', 'automation', 'flutter', 'offline',
    'coding', 'llm', 'ai', 'assistant',
  ];
  for (const word of focusWords) {
    if (text.toLowerCase().includes(word) && !focus.includes(word)) focus.push(word);
  }
  return {
    focus,
    integrate: /\b(?:integrate|adapt|add|bring|put|use)\b[\s\S]{0,80}\b(?:che|your\s+(?:app|code|repo))\b/i.test(text),
  };
}

export async function listOwnerStarredRepos(
  env,
  fetcher = fetch,
  { limit = 300, focus = [] } = {},
) {
  const owner = githubOwner(env);
  if (!owner) {
    return { error: 'CHE_GITHUB_REPO is missing, so I cannot determine which GitHub stars belong to the owner.', repos: [], candidates: [], checked: 0 };
  }

  const cap = Math.max(1, Math.min(Number(limit) || 300, 300));
  const repos = [];
  let page = 1;
  let truncated = false;

  while (repos.length < cap) {
    const perPage = Math.min(100, cap - repos.length);
    let response;
    try {
      response = await fetcher(
        `https://api.github.com/users/${encodeURIComponent(owner)}/starred?per_page=${perPage}&page=${page}`,
        { headers: ghHeaders(env), signal: AbortSignal.timeout(10000) },
      );
    } catch (error) {
      return { error: `GitHub starred-repository lookup failed: ${String(error?.message || error).slice(0, 140)}`, repos: [], candidates: [], checked: 0 };
    }

    if (!response.ok) {
      const permission = response.status === 401 || response.status === 403
        ? ' Check the GitHub token/rate limit; Starring read access may be required for authenticated access.'
        : '';
      return { error: `GitHub could not read ${owner}'s starred repositories (${response.status}).${permission}`, repos: [], candidates: [], checked: 0 };
    }

    let batch = [];
    try { batch = await response.json(); } catch (_) { batch = []; }
    if (!Array.isArray(batch)) batch = [];
    repos.push(...batch.map(starredRepoRecord).filter((r) => r.full_name));
    if (batch.length < perPage) break;
    if (repos.length >= cap) {
      truncated = true;
      break;
    }
    page += 1;
  }

  const live = repos.filter((r) => !r.archived);
  const ranked = [...live]
    .map((repo) => ({ ...repo, relevance: starredScore(repo, focus) }))
    .sort((a, b) => b.relevance - a.relevance || b.stars - a.stars);
  const positive = ranked.filter((r) => r.relevance > 2.5);
  const candidates = (positive.length ? positive : ranked).slice(0, 16);

  return {
    owner,
    repos: live,
    candidates,
    checked: repos.length,
    reusable_count: live.filter((r) => r.reusable).length,
    truncated,
  };
}

export function speakStarredRepos(intent, result) {
  if (result?.error) return `I couldn't inspect your GitHub stars, sir: ${result.error}`;
  const checked = Number(result?.checked || 0);
  const picks = Array.isArray(result?.candidates) ? result.candidates : [];
  const scope = result?.truncated ? `the first ${checked}` : String(checked);
  if (!picks.length) {
    return `I inspected ${scope} starred GitHub repositories, sir, but I didn't find a strong reusable match yet. GitHub's normal stars feed does not label custom lists such as Inspirations, so I scan the starred library itself instead of pretending I can see a list label that the API did not return.`;
  }
  const lines = picks.slice(0, 8).map((r, i) => {
    const license = r.reusable ? r.license_name : `${r.license_name} — study only until reuse rights are verified`;
    return `${i + 1}. ${r.full_name} — ${license}. ${r.description || 'No description.'}`;
  });
  const focus = intent?.focus?.length ? ` for ${intent.focus.join(', ')}` : '';
  const next = intent?.integrate
    ? 'I treated this as research first, not an exact-text patch. I will not blind-copy repositories; reusable pieces must be studied, adapted to CHE, reviewed, and proposed in a draft PR.'
    : 'Say "study" and a number to inspect one safely before any code change.';
  return `I inspected ${scope} repositories from your GitHub stars${focus}, sir. GitHub's normal stars feed does not label custom lists such as Inspirations, so this covers the starred library itself. Best matches:\n${lines.join('\n')}\n${next}`;
}

// Search public repos by need, best-starred first, permissive-license only.
export async function scoutCode(env, need, fetcher = fetch, { minStars = 200, limit = 6 } = {}) {
  const q = String(need || '').trim().slice(0, 120);
  if (q.length < 3) return { error: 'Say what capability to look for.' , repos: [] };
  const query = `${q} stars:>=${minStars}`;
  const url = `https://api.github.com/search/repositories?per_page=25&sort=stars&order=desc&q=${encodeURIComponent(query)}`;
  let data;
  try {
    const response = await fetcher(url, { headers: ghHeaders(env), signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { error: `GitHub search failed (${response.status}).`, repos: [] };
    data = await response.json();
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 120), repos: [] };
  }
  const repos = (Array.isArray(data?.items) ? data.items : [])
    .map((r) => ({
      full_name: String(r?.full_name || ''),
      stars: Number(r?.stargazers_count || 0),
      description: String(r?.description || '').slice(0, 200),
      url: String(r?.html_url || ''),
      license: String(r?.license?.spdx_id || '').toLowerCase(),
      license_name: String(r?.license?.name || 'No license'),
      language: String(r?.language || ''),
      archived: Boolean(r?.archived),
      pushed_at: String(r?.pushed_at || ''),
    }))
    .filter((r) => r.full_name && !r.archived && REUSABLE.has(r.license))
    .slice(0, limit);
  return { repos, checked: (data?.items || []).length };
}

export function reusableLicense(spdx) {
  return REUSABLE.has(String(spdx || '').toLowerCase());
}

// Pull one source file from a repo (for the crew to study), only if the repo's
// license is reusable. Returns text, never executes anything.
export async function fetchRepoFile(env, fullName, path, fetcher = fetch) {
  const meta = await fetcher(`https://api.github.com/repos/${fullName}`, { headers: ghHeaders(env), signal: AbortSignal.timeout(8000) }).then((r) => r.ok ? r.json() : null).catch(() => null);
  const spdx = String(meta?.license?.spdx_id || '').toLowerCase();
  if (!reusableLicense(spdx)) return { error: `${fullName} is not under a reusable license (${meta?.license?.spdx_id || 'none'}).` };
  const branch = String(meta?.default_branch || 'main');
  const raw = await fetcher(`https://raw.githubusercontent.com/${fullName}/${branch}/${path}`, { headers: { 'User-Agent': 'CHE-CodeScout' }, signal: AbortSignal.timeout(8000) }).then((r) => r.ok ? r.text() : '').catch(() => '');
  if (!raw) return { error: `Could not read ${path} from ${fullName}.` };
  return { license: spdx, license_name: String(meta?.license?.name || ''), path, content: raw.slice(0, 40000) };
}

export function speakScout(need, result) {
  if (result.error) return `I couldn't search GitHub, sir: ${result.error}`;
  if (!result.repos.length) return `No top, freely-reusable repos matched "${need}", sir. Most matches had no reuse license, so I left them out.`;
  const lines = result.repos.map((r, i) => `${i + 1}. ${r.full_name} — ${r.stars.toLocaleString('en-US')} stars, ${r.license_name}${r.language ? `, ${r.language}` : ''}. ${r.description}`);
  return `Top reusable repos for "${need}", sir:\n${lines.join('\n')}\nSay "study" and a number and my crew will read it and propose a change for your approval. I only use permissively-licensed code, with credit.`;
}

// "find code for offline speech", "scout github for a flutter audio player"
export function codeScoutIntent(message) {
  const t = String(message || '').trim().replace(/^(?:che|chay)[,:]?\s+/i, '');
  const m = /^(?:find|scout|search|look\s+for|get)\s+(?:me\s+)?(?:some\s+)?(?:github\s+)?code\s+(?:for|to|that)\s+([\s\S]{3,120})$/i.exec(t)
    || /^(?:scout|search)\s+github\s+for\s+([\s\S]{3,120})$/i.exec(t);
  if (!m) return null;
  return { need: m[1].trim().replace(/[.?!]+$/, '') };
}

// CHE's vision areas — what "the whole CHE app" is trying to be. Her scout
// watches these for better, reusable open-source approaches.
export const CHE_VISION_AREAS = [
  'flutter voice assistant on-device speech',
  'flutter smooth list scrolling performance',
  'on-device llm inference iphone',
  'natural text to speech flutter free',
  'flutter isometric game characters animation',
  'openai compatible llm router fallback',
];

// Runs weekly (or on "scout the app"): scans each vision area for top reusable
// repos and files any new ones as Tech letters for the owner to review. Never
// buys, never auto-merges — reference only.
export async function autoImproveScan(env, storage, fileLetter, fileTech, fetcher = fetch) {
  const seenRaw = (await storage.get('code_scout_seen')) || [];
  const seen = new Set(Array.isArray(seenRaw) ? seenRaw : []);
  const found = [];
  for (const area of CHE_VISION_AREAS) {
    const { repos } = await scoutCode(env, area, fetcher, { minStars: 400, limit: 3 });
    for (const r of (repos || [])) {
      if (seen.has(r.full_name)) continue;
      seen.add(r.full_name);
      found.push({ area, ...r });
      await fileTech(storage, { name: r.full_name, improves: `${area} (${r.stars} stars)`, url: r.url, cost: 'free', cost_note: r.license_name, tags: ['code'], readiness: 'ready-to-try' }).catch(() => null);
    }
  }
  await storage.put('code_scout_seen', [...seen].slice(-400));
  await storage.put('code_scout_at', Date.now());
  if (found.length) {
    await fileLetter(storage, { tray: 'tech-scout', subject: `${found.length} reusable code upgrades found`, body: found.slice(0, 6).map((f) => `${f.full_name} — ${f.area}`).join('; ') + '. Say "what\'s in free tech" to review, then "update your code" to use one.', tag: 'free', severity: 'info' }).catch(() => null);
  }
  return found;
}
