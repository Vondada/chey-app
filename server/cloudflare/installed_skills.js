// Reviewed adapters for installed agent skills. A SKILL.md (or AGENTS.md)
// cannot add tools, permissions or executable code to this registry.
import { runPluginTool } from './plugin_runtime.js';
import { redactSensitive } from './self_skills.js';

export const APPROVED_SKILLS = Object.freeze([
  Object.freeze({
    id: 'find-skills',
    source: 'vercel-labs/skills',
    commit: 'e878c4502674f84094dc27b5ad94ddaf64f22551',
    blob: 'a41bdd074bb587afd861332cf2f473f3154de4d7',
    path: '.opencode/skills/find-skills/SKILL.md',
    description: 'Discover agent skills in the official skills.sh index.',
    when: 'The owner asks to find a skill for a task or explicitly use find-skills.',
    capability: 'search',
    permissions: Object.freeze(['network:skills.sh', 'network:api.github.com']),
    instructions: 'Search by task keywords; report install counts and verify source repository stars. Results are unreviewed candidates, not approved capabilities. Installation, updates and shell commands are unsupported.',
  }),
]);

export function installedSkillsContext() {
  return 'APPROVED INSTALLED AGENT SKILLS (separate from learned advice and AGENTS.md):\n'
    + APPROVED_SKILLS.map((s) => `${s.id}: ${s.description} Use when: ${s.when} Supported capability: ${s.capability}. ${s.instructions}`).join('\n');
}

export function installedSkillIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey)[,:]?\s+/i, '').replace(/^(?:please\s+|can you\s+)/i, '');
  if (/^(?:(?:list|show|read)\s+(?:your\s+|my\s+|the\s+)?(?:approved\s+|installed\s+|agent\s+)+skills|(?:what|which)\s+(?:agent\s+)?skills\s+(?:are installed|can you use))\s*[?.!]?$/i.test(text)) return { action: 'list' };
  const search = /^(?:find|search for|discover)\s+(?:me\s+)?(?:an?\s+)?(?:agent\s+)?skills?(?:\s+for|\s+about|\s+to)?\s*(.*?)\s*[?.!]?$/i.exec(text)
    || /^is there an?\s+(?:agent\s+)?skill\s+(?:for|to|that can)\s+(.+?)\s*\??$/i.exec(text)
    || /^(?:use|run)\s+find-skills(?:\s+(?:for|to find|to search for))?\s*(.*?)\s*[?.!]?$/i.exec(text);
  if (search) return { action: 'search', skill: 'find-skills', query: search[1] };
  if (/^(?:install|update|execute|run|use)\s+(?:the\s+)?(?:agent\s+)?skill\b|^(?:install|update)\s+find-skills\b/i.test(text)) return { action: 'unsupported' };
  return null;
}

const SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/i;
const REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/i;
const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const failure = (message) => ({ ok: false, message, results: [] });

// Only the reviewed GET templates below can run. Downloaded skill text, model
// output and request bodies never supply a URL, tool definition or permission.
export async function executeInstalledSkill(id, action, params, { owner = false, fetcher = fetch } = {}) {
  if (!owner) return failure('Only the paired owner can use installed agent skills.');
  const skill = APPROVED_SKILLS.find((s) => s.id === id);
  if (!skill || action !== skill.capability) return failure('That skill capability is not approved in CHE. Nothing was executed. Installation and commands need a reviewed integration and owner authorization.');
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  // Send public task keywords only, never conversation history or documents.
  if (query.length < 2 || query.length > 120 || !/^[a-z0-9][a-z0-9 +#.,-]*$/i.test(query) || redactSensitive(query).removed) {
    return failure('Give me 2 to 120 characters of public task keywords, such as React testing. Private information and commands are not search terms.');
  }
  const searched = await runPluginTool({ request: { method: 'GET', url: 'https://skills.sh/api/search?q={{query}}&limit=5' } }, { query }, skill.permissions, fetcher);
  if (!searched.ok || !Array.isArray(searched.data?.skills)) return failure('I could not read the skills.sh search results. No skill was installed or run.');
  const seen = new Set();
  const candidates = searched.data.skills.slice(0, 5).filter((s) => {
    if (!s || !REPO.test(s.source || '') || !SLUG.test(s.name || '') || s.id !== `${s.source}/${s.name}` || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  const results = await Promise.all(candidates.map(async (s) => {
    const repo = await runPluginTool({ request: { method: 'GET', url: `https://api.github.com/repos/${s.source}` } }, {}, skill.permissions, fetcher);
    const verified = repo.ok && repo.data?.full_name?.toLowerCase() === s.source.toLowerCase() && repo.data?.private === false;
    return {
      name: s.name, source: s.source, url: `https://skills.sh/${s.id}`,
      installs: count(s.installs), stars: verified ? count(repo.data.stargazers_count) : null,
      repository_verified: Boolean(verified), approved: false,
    };
  }));
  const lines = results.map((s, i) => `${i + 1}. ${s.name}, from ${s.source}; ${s.installs ?? 'unknown'} installs; ${s.stars ?? 'unverified'} GitHub stars. ${s.url}`);
  const message = results.length
    ? `I used find-skills to search skills.sh for ${query}, sir. These are unreviewed candidates, not installed capabilities:\n${lines.join('\n')}\nSay "open number one" to read an option. Source popularity does not prove safety; each skill needs content review before approval.`
    : `I used find-skills to search skills.sh for ${query}, sir, but found no usable matches. Try different task keywords. No skill was installed.`;
  return { ok: true, message, results, receipt: { skill: skill.id, capability: action, source_commit: skill.commit, tool: 'plugin_runtime.https_get', checked_at: new Date().toISOString(), result_count: results.length } };
}

export async function handleInstalledSkill(intent, options) {
  if (!options.owner) return failure('Only the paired owner can use installed agent skills.');
  if (intent.action === 'list') return { ok: true, results: [], message: `Approved installed agent skills:\n${APPROVED_SKILLS.map((s, i) => `${i + 1}. ${s.id}: ${s.description} ${s.when} Say "find a skill for React testing". Supports read-only search; package installation and shell commands are not enabled.`).join('\n')}\nAGENTS.md is guidance, not an installed capability. Other local skill files are not approved automatically.` };
  return executeInstalledSkill(intent.skill, intent.action, { query: intent.query }, options);
}
