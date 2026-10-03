// Real skill import for the Office: reads an owner-selected, license-checked
// reference repository (e.g. msitarzewski/agency-agents, MIT), picks the
// persona/workflow files that fit each Office agent's role, condenses them
// into Office skills, and assigns them to that agent. Everything is recorded
// with its source path so CHE can later say exactly which agent got which
// skill and where it came from.

// Which reference divisions fit which Office agent.
export const AGENT_DIVISIONS = {
  Knox: ['engineering', 'testing', 'security', 'game-development'],
  Atlas: ['research', 'strategy', 'academic'],
  Nova: ['product', 'sales'],
  Mira: ['support'],
  Sage: ['finance'],
  Lyra: ['marketing'],
  Iris: ['paid-media', 'design'],
};

const REUSABLE = /^(?:mit|apache-2\.0|bsd-2-clause|bsd-3-clause|isc|mpl-2\.0|unlicense|cc0-1\.0|0bsd)$/i;

export function reusableLicense(spdx) {
  return REUSABLE.test(String(spdx || '').trim());
}

// Deterministic file choice: files in the agent's divisions, ranked by how
// many words of the agent's role/specialty appear in the file name.
export function selectFilesForAgent(paths, agentName, spec = {}, perAgent = 2) {
  const divisions = AGENT_DIVISIONS[agentName] || [];
  const words = `${spec.role || ''} ${spec.specialty || ''}`.toLowerCase().match(/[a-z]{4,}/g) || [];
  return paths
    .filter((path) => /\.md$/i.test(path) && divisions.some((division) => path.toLowerCase().startsWith(`${division}/`)))
    .filter((path) => !/readme|contributing|license|changelog/i.test(path))
    .map((path) => {
      const name = path.toLowerCase();
      const score = words.reduce((sum, word) => sum + (name.includes(word.slice(0, 6)) ? 2 : 0), 0)
        + divisions.findIndex((division) => name.startsWith(`${division}/`)) * -1;
      return { path, score };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, perAgent)
    .map((item) => item.path);
}

// Fallback skill when the AI condenser is unavailable: title + the first
// list items under a process/workflow heading. Never invents content.
export function skillFromMarkdown(path, markdown) {
  const text = String(markdown || '');
  const title = (/^#\s+(.+)$/m.exec(text)?.[1] || path.split('/').pop().replace(/\.md$/i, '').replace(/[-_]/g, ' ')).replace(/[*_`#]/g, '').trim();
  const section = /^#{2,3}\s+[^\n]*(?:process|workflow|methodolog|approach|how i work)[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im.exec(text)?.[1] || text;
  const steps = [...section.matchAll(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/gm)].map((m) => m[1].replace(/[*_`]/g, '').trim()).filter((s) => s.length > 8).slice(0, 8);
  const when = /^#{2,3}\s+[^\n]*(?:when to|use cases?|activate)[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im.exec(text)?.[1] || '';
  const trigger = (when.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/m)?.[1] || title).replace(/[*_`]/g, '').trim().slice(0, 200);
  return steps.length ? { name: title.slice(0, 80), trigger, steps } : null;
}

// "What skills did you give your agents?", "how did you implement the
// agency-agents repo?" → answered from stored data only.
export function skillsReportIntent(message) {
  const text = String(message || '');
  return /\b(?:what|which)\b[^?.!]{0,40}\bskills?\b|\bdid\s+(?:you|she|che)\s+(?:give|teach|assign|learn)\b[^?.!]{0,50}\bskills?\b|\bhow\s+did\s+(?:you|she|che)\s+(?:implement|integrate|use|add|put)\b[^?.!]{0,80}\b(?:repo|repository|agency|agents?)\b/i.test(text);
}

// "Give your Office agents skills from agency-agents" → a real import job.
export function skillImportIntent(message) {
  const text = String(message || '');
  if (!/\b(?:give|teach|assign|add|load|install|equip|train)\b[^.?!]{0,60}\bskills?\b[^.?!]{0,80}\b(?:agents?|office|delegates?|sub-?agents?|team|staff|workers?|nova|atlas|mira|knox|sage|lyra|iris)\b|\b(?:give|teach|equip|train)\s+(?:your|the|her)\s+(?:office\s+)?(?:agents?|delegates?|sub-?agents?|team|staff)\b[^.?!]{0,60}\bskills?\b/i.test(text)) return null;
  const repo = /\b([\w.-]+\/[\w.-]+)\b/.exec(text)?.[1] || (/\bagency[- ]?agents?\b/i.test(text) ? 'msitarzewski/agency-agents' : '');
  return { repo };
}

export function describeSkillsReport(report, { referenceRepo = '', studied = false } = {}) {
  const lines = [];
  const fromRepo = referenceRepo
    ? report.rows.flatMap((row) => row.assigned.filter((skill) => skill.source?.repo === referenceRepo).map((skill) => `${row.agent}: ${skill.name}`))
    : [];
  if (referenceRepo) {
    lines.push(fromRepo.length
      ? `From ${referenceRepo} I gave my Office these skills: ${fromRepo.join('; ')}. I did not change my app code for it.`
      : `I have not implemented ${referenceRepo}, sir. ${studied ? 'I studied it, but' : 'There is'} no code change, no pull request and no Office skill from it.`);
  }
  const withSkills = report.rows.filter((row) => row.assigned.length || row.picked_up.length);
  const without = report.rows.filter((row) => !row.assigned.length && !row.picked_up.length).map((row) => row.agent);
  for (const row of withSkills) {
    const parts = [
      row.assigned.length ? `assigned ${row.assigned.map((s) => s.name).join(', ')}` : '',
      row.picked_up.length ? `picked up while working ${row.picked_up.map((s) => s.name).join(', ')}` : '',
    ].filter(Boolean);
    lines.push(`${row.agent} (${row.role || 'Office'}): ${parts.join('; ')}.`);
  }
  if (without.length) lines.push(`${without.join(', ')} ${without.length === 1 ? 'has' : 'have'} no skills yet.`);
  if (!report.rows.length) lines.push('My Office has no agents staffed yet.');
  if (!report.total_skills) lines.push('I have not given any Office agent a skill yet.');
  return lines.join(' ');
}
