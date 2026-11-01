// "Search the repo for X", "find all TODO comments in the repo and count them": a read-only search of CHE's own
// repository, answered from code_index.js (one tarball of the default branch's head commit, searched on the Worker).
// The reply lists only real hits with their file and count, and names the commit it searched. Nothing is written.

import { loadCodeIndex } from './code_index.js';
import { executeWithReceipt, recordReceipt } from './truth_layer.js';

const PLACE = String.raw`(?:the |our |my |che'?s |your |this )?(?:code ?base|code|repo(?:sitory)?|source(?: code)?|project)`;
const SEARCH_FIRST = new RegExp(String.raw`^(?:please )?(?:search|grep|scan)(?: through)? ${PLACE}(?: for)? (.+)$`, 'i');
const NEEDLE_FIRST = new RegExp(String.raw`^(?:please )?(?:find|search for|look for|grep(?: for)?|count|locate|list|show(?: me)?|how many)(?: all| every| any)?(?: of)?(?: the)? (.+?) (?:are there |do we have |exist )?(?:in|across|throughout) ${PLACE}\b(.*)$`, 'i');
const TRAILING_NOUN = /\s+(?:comments?|occurrences?|mentions?|references?|usages?|uses?|calls?|lines?|instances?|matches|strings?|markers?|notes?|tags?|entries)$/i;
const LEADING = /^(?:all|every|any|the|uses of|mentions of|occurrences of|references to|calls to|instances of)\s+/i;
// A needle that reads as code: one word with an underscore, dot, bracket or inner capital, or ALL CAPS.
const CODE_LIKE = /^\S*(?:[_.()$#/-]|[a-z][A-Z])\S*$|^[A-Z0-9]{2,}$/;
// "... but do not access the codebase": the owner forbade the read, so this is not a search request.
const NO_ACCESS = /\b(?:do not|don['’]?t|never|without) (?:access|read|open|search|touch|look(?:ing)? at|us(?:e|ing)|go(?:ing)? into)(?:ing)?\b/i;

/** { needle, count } for a repository search request, or null. */
export function repoSearchIntent(message) {
  const text = String(message || '').trim().replace(/^(?:hey )?(?:che|chay|chey)[, ]+/i, '').replace(/[.!?]+$/, '').trim();
  if (!text || text.length > 200 || NO_ACCESS.test(text)) return null;
  const counting = /\b(?:count|how many)\b/i.test(text);
  let raw = '';
  let explicit = false;
  const first = SEARCH_FIRST.exec(text);
  if (first) {
    raw = first[1];
    explicit = true;
  } else {
    const later = NEEDLE_FIRST.exec(text);
    if (!later) return null;
    raw = later[1];
    explicit = /^(?:search for|grep|count|how many)\b/i.test(text);
  }
  raw = raw.replace(/\s+and (?:count|list|show|tell) .*$/i, '').trim();
  const quoted = /["'`“‘]([^"'`”’]{2,80})["'`”’]/.exec(raw);
  let needle = quoted ? quoted[1] : raw;
  if (!quoted) {
    const where = /^where (.+?) is (?:used|defined|called|declared|set|read)$/i.exec(needle);
    if (where) needle = where[1];
    for (let i = 0; i < 3; i += 1) needle = needle.replace(LEADING, '').replace(TRAILING_NOUN, '').trim();
  }
  if (needle.length < 2 || needle.length > 80 || needle.split(/\s+/).length > 4) return null;
  // "Find the bug in the code" is a debugging request, not a text search.
  if (!quoted && !explicit && !counting && !CODE_LIKE.test(needle)) return null;
  return { needle, count: counting };
}

function repoOf(env) {
  const repo = String(env?.CHE_GITHUB_REPO || '').trim();
  return env?.CHE_GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
}

/** The head commit of the default branch, or { error, status }. */
async function headSha(env, repo, fetcher) {
  const response = await fetcher(`https://api.github.com/repos/${repo}/commits/HEAD`, {
    headers: { Authorization: `Bearer ${env.CHE_GITHUB_TOKEN}`, Accept: 'application/vnd.github.sha', 'User-Agent': 'CHE-Agent' },
  });
  const text = (await response.text()).trim();
  return response.ok && /^[0-9a-f]{40}$/.test(text) ? { sha: text } : { error: `GitHub did not return the head commit (HTTP ${response.status}).`, status: response.status };
}

function occurrences(text, needle, caseSensitive) {
  const hay = caseSensitive ? text : text.toLowerCase();
  const want = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  for (let at = hay.indexOf(want); at !== -1; at = hay.indexOf(want, at + want.length)) count += 1;
  return count;
}

/**
 * Searches every text file at the default branch's head for the needle. A needle with a capital letter matches its
 * case exactly (like grep); an all-lowercase needle ignores case. Returns { ok, sha, needle, case_sensitive, total,
 * files: [{ path, count }] } or { ok: false, status, error }.
 */
export async function runRepoSearch(env, needle, fetcher = fetch) {
  const repo = repoOf(env);
  if (!repo) return { ok: false, status: 0, error: 'CHE_GITHUB_TOKEN or CHE_GITHUB_REPO is not set on the Worker.' };
  const head = await headSha(env, repo, fetcher);
  if (head.error) return { ok: false, status: head.status, error: head.error };
  const index = await loadCodeIndex(null, env, head.sha, fetcher).catch(() => null);
  if (!index) return { ok: false, status: 503, error: 'The repository download for that commit failed.' };
  const caseSensitive = /[A-Z]/.test(needle);
  const files = [];
  for (const path of index.search(needle, { limit: 100000 })) {
    const count = occurrences(index.text(path) || '', needle, caseSensitive);
    if (count) files.push({ path, count });
  }
  files.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return { ok: true, repo, sha: head.sha, needle, case_sensitive: caseSensitive, files_searched: index.size,
    total: files.reduce((sum, f) => sum + f.count, 0), files };
}

/** One chat turn: runs the search under an execution receipt and returns { reply, meta } for ndjsonReply. */
export async function repoSearchTurn(env, storage, needle, fetcher = fetch) {
  const request_id = crypto.randomUUID();
  const { result, receipt } = await executeWithReceipt({
    tool: 'code_index', operation: 'repo_search', request_id,
    source: `https://api.github.com/repos/${env?.CHE_GITHUB_REPO || 'unconfigured'}/tarball`,
    run: () => runRepoSearch(env, needle, fetcher),
    response: (r) => ({ sha: r.sha, needle: r.needle, total: r.total, files: r.files.length, top: r.files.slice(0, 20) }),
  });
  await recordReceipt(storage, { ...receipt, key: `execution:${receipt.invocation_id}` });
  return {
    reply: speakRepoSearch(result, receipt),
    meta: { source: 'che_repo_search', ok: receipt.status === 'success', model_calls: 0, execution_receipts: [receipt], request_id },
  };
}

export function speakRepoSearch(result, receipt) {
  if (!result?.ok) return `I could not search the repository: ${String(result?.error || receipt?.error || 'the search did not run').replace(/\.$/, '')}. No count was made.`;
  const where = `${result.repo} at commit ${result.sha.slice(0, 7)} (${result.files_searched} text files, ${result.case_sensitive ? 'exact case' : 'any case'})`;
  if (!result.total) return `I searched ${where} for the text "${result.needle}". Count: 0. It does not appear in any file.`;
  const top = result.files.slice(0, 8).map((f) => `${f.path} (${f.count})`).join(', ');
  const more = result.files.length > 8 ? `, and ${result.files.length - 8} more files` : '';
  return `I searched ${where} for the text "${result.needle}". Count: ${result.total} in ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}: ${top}${more}. Receipt ${receipt?.invocation_id || ''}.`.replace(/ Receipt \.$/, '');
}
