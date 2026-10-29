// CHE continuity checks (owner, 2026-10-28). Three checks on the project-status documents:
//   1. The snapshot (docs/CHE_PROJECT_STATUS.md) has every section, and each fact row or item says verified, reported or unknown.
//   2. The history (docs/CHE_PROJECT_HISTORY.md) is append-only: every line in the base revision is still present.
//   3. Reconcile: the main commit the snapshot names is compared with the commit given (for example `git rev-parse origin/main`).
// Usage: node tools/continuity_check.mjs [--base <git ref>] [--main-sha <full or short sha>]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const SECTIONS = [
  'Latest verified main', 'Latest deployment', 'Open pull requests', 'Current CI',
  'Active coding jobs', 'Current blockers', 'Owner priorities', 'Next authorised actions',
];
const STATES = /\b(verified|reported|unknown)\b/i;

/** Lines of one "## " section, from its heading to the next one. */
function sectionBody(markdown, name) {
  const lines = String(markdown || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i += 1) out.push(lines[i]);
  return out;
}

/** Table rows (not the header or separator) and list items: the lines that state a fact. */
function factLines(body) {
  return body.filter((line) => {
    const t = line.trim();
    if (/^\|\s*-{3,}/.test(t)) return false;
    if (t.startsWith('|')) return !/^\|\s*(PR|Fact|Action|Entry|Date|Title)\b/i.test(t);
    return /^(\d+\.|-)\s+\S/.test(t);
  });
}

export function checkSnapshot(markdown) {
  const problems = [];
  if (!/Snapshot taken:\s*\*\*\d{4}-\d{2}-\d{2}[^*]*UTC\*\*/.test(markdown)) problems.push('The snapshot has no "Snapshot taken" date and time in UTC.');
  for (const name of SECTIONS) {
    const body = sectionBody(markdown, name);
    if (body === null) { problems.push(`The section "## ${name}" is missing.`); continue; }
    const facts = factLines(body);
    if (name === 'Owner priorities' || name === 'Stop conditions') continue;
    if (!facts.length) problems.push(`The section "## ${name}" states no facts.`);
    for (const line of facts) {
      if (!STATES.test(line)) problems.push(`"## ${name}": a fact has no state (verified, reported or unknown): ${line.trim().slice(0, 90)}`);
    }
  }
  return problems;
}

/** Every line in the base history must still be in the current history (append-only). */
export function checkAppendOnly(current, base) {
  const have = new Set(String(current || '').split('\n'));
  return String(base || '').split('\n').filter((line) => line.trim() && !have.has(line)).map((line) => `Removed or changed history line: ${line.slice(0, 100)}`);
}

/** The short SHA the snapshot names as the latest verified main, and whether the given SHA agrees. */
export function reconcileMain(markdown, mainSha) {
  const body = sectionBody(markdown, 'Latest verified main') || [];
  const claimed = /`([0-9a-f]{7,40})`/.exec(body.join('\n'))?.[1] || '';
  if (!claimed) return { ok: false, claimed: '', detail: 'The snapshot names no main commit.' };
  if (!mainSha) return { ok: null, claimed, detail: 'No main commit given to compare with.' };
  const same = mainSha.startsWith(claimed) || claimed.startsWith(mainSha.slice(0, claimed.length));
  return { ok: same, claimed, detail: same ? `The snapshot matches main (${claimed}).` : `Stale: the snapshot says ${claimed}, main is ${mainSha.slice(0, 8)}. Update the snapshot.` };
}

if (process.argv[1] && process.argv[1].endsWith('continuity_check.mjs')) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ''; };
  const snapshot = readFileSync('docs/CHE_PROJECT_STATUS.md', 'utf8');
  const history = readFileSync('docs/CHE_PROJECT_HISTORY.md', 'utf8');
  let failed = false;
  for (const problem of checkSnapshot(snapshot)) { console.error(`continuity: ${problem}`); failed = true; }
  const base = arg('--base');
  if (base) {
    // A base that does not have the history yet (the first PR that adds it) has nothing to protect.
    let baseHistory = null;
    try { baseHistory = execFileSync('git', ['show', `${base}:docs/CHE_PROJECT_HISTORY.md`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { baseHistory = null; }
    if (baseHistory === null) console.log(`continuity: ${base} has no history file yet; nothing to compare.`);
    else for (const problem of checkAppendOnly(history, baseHistory)) { console.error(`continuity: ${problem}`); failed = true; }
  }
  const sha = arg('--main-sha');
  if (sha) {
    const verdict = reconcileMain(snapshot, sha);
    console.log(`continuity: ${verdict.detail}`);
    if (verdict.ok === false) failed = true;
  }
  if (failed) process.exit(1);
  console.log('continuity: snapshot and history are valid');
}
