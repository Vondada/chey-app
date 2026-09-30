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
