// Scores a CHE coding candidate against the coding eval cases.
// Usage: node tools/coding_eval/run.mjs <candidate-dir> [case-id ...]
// Each case imports its module from <candidate-dir> (see the case check file). A case passes when every test passes,
// is partial when some pass, and fails when none pass or the module cannot be loaded.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, 'cases');
const candidateDir = resolve(process.argv[2] || '');
const only = process.argv.slice(3);

if (!process.argv[2] || !existsSync(candidateDir)) {
  console.error('usage: node tools/coding_eval/run.mjs <candidate-dir> [case-id ...]');
  process.exit(2);
}

const ids = readdirSync(casesDir).filter((id) => !only.length || only.includes(id)).sort();
const rows = [];
for (const id of ids) {
  const check = join(casesDir, id, 'check.test.mjs');
  const run = spawnSync(process.execPath, ['--test', check], {
    env: { ...process.env, CHE_CANDIDATE_DIR: candidateDir },
    encoding: 'utf8',
    timeout: 60000,
  });
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  const total = Number((out.match(/^# tests (\d+)/m) || [])[1] || 0);
  const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] || 0);
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  const verdict = total > 0 && pass === total ? 'PASS' : pass > 0 ? 'PARTIAL' : 'FAIL';
  rows.push({ id, verdict, pass, total, failed });
}

for (const r of rows) {
  console.log(`${r.verdict.padEnd(8)} ${r.id.padEnd(16)} ${r.pass}/${r.total}`);
  for (const name of r.failed) console.log(`         - ${name}`);
}
const passed = rows.filter((r) => r.verdict === 'PASS').length;
console.log(`\n${passed}/${rows.length} cases pass completely`);
process.exit(passed === rows.length ? 0 : 1);
