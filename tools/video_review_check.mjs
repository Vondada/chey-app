// Checks the Video Review record in docs/CHE_VIDEO_REVIEW.md (owner, 2026-10-28). A row marked verified or done must
// carry receipts and a PR or commit; every row must carry every column and a known status. Run with `node`; exits 1 on
// any problem so CI can gate on it.
import { readFileSync } from 'node:fs';

export const COLUMNS = ['id', 'video', 'timestamp', 'evidence', 'observed', 'expected', 'root_cause', 'files', 'status', 'pr_commit', 'receipts', 'blockers'];
export const STATUSES = ['open', 'in progress', 'built, not verified', 'verified', 'done', 'blocked'];
const EMPTY = new Set(['', '—', '-', 'n/a', 'none']);

/** Parses the record table: the first table whose header starts with `id | video`. Returns { rows, problems }. */
export function checkRecord(markdown) {
  const lines = String(markdown || '').split('\n');
  const header = lines.findIndex((line) => /^\|\s*id\s*\|\s*video\s*\|/.test(line));
  if (header < 0) return { rows: [], problems: ['The Video Review table header is missing.'] };
  const names = lines[header].split('|').slice(1, -1).map((c) => c.trim());
  const problems = [];
  for (const column of COLUMNS) if (!names.includes(column)) problems.push(`The table is missing the "${column}" column.`);
  if (problems.length) return { rows: [], problems };
  const rows = [];
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    const row = Object.fromEntries(names.map((name, j) => [name, cells[j] ?? '']));
    rows.push(row);
    const where = `${row.id || `row ${rows.length}`}`;
    for (const column of COLUMNS) if (cells[names.indexOf(column)] === undefined) problems.push(`${where}: the "${column}" cell is missing.`);
    if (!STATUSES.includes(row.status)) problems.push(`${where}: status "${row.status}" is not one of ${STATUSES.join(', ')}.`);
    if (['verified', 'done'].includes(row.status)) {
      if (EMPTY.has(row.receipts)) problems.push(`${where}: a ${row.status} task needs receipts (test, CI or deploy output).`);
      if (EMPTY.has(row.pr_commit)) problems.push(`${where}: a ${row.status} task needs a PR number or commit.`);
    }
  }
  return { rows, problems };
}

if (process.argv[1] && process.argv[1].endsWith('video_review_check.mjs')) {
  const path = process.argv[2] || 'docs/CHE_VIDEO_REVIEW.md';
  const { rows, problems } = checkRecord(readFileSync(path, 'utf8'));
  for (const problem of problems) console.error(`video review: ${problem}`);
  if (problems.length) process.exit(1);
  console.log(`video review: ${rows.length} task${rows.length === 1 ? '' : 's'}, record valid`);
}
