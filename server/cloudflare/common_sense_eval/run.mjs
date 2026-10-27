// Runs the common-sense cases against the live Worker. It makes model calls, so it refuses to run unless the owner has set a
// daily spend cap above $0 (owner, 2026-10-26: the cap is $0 for now). Usage:
//   CHE_EVAL_DAILY_CAP_USD=2 CHE_EVAL_WORKER_URL=https://... CHE_EVAL_TOKEN=... node run.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { grade, replyText } from './grade.mjs';

const cap = Number(process.env.CHE_EVAL_DAILY_CAP_USD || 0);
if (!(cap > 0)) {
  console.log('Not run: the daily spend cap is $0, so no model calls are made. Set CHE_EVAL_DAILY_CAP_USD above 0 to run.');
  process.exit(0);
}
const url = process.env.CHE_EVAL_WORKER_URL;
const token = process.env.CHE_EVAL_TOKEN;
if (!url || !token) {
  console.log('Not run: CHE_EVAL_WORKER_URL and CHE_EVAL_TOKEN are required.');
  process.exit(2);
}
const cases = JSON.parse(readFileSync(fileURLToPath(new URL('./cases.json', import.meta.url)), 'utf8'));
let passed = 0;
for (const c of cases) {
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: c.question, eval: true }),
  });
  if (!res.ok) {
    console.log(`ERROR ${c.id} HTTP ${res.status}`);
    continue;
  }
  const raw = await res.text();
  const reply = replyText(raw);
  if (reply == null) {
    console.log(`ERROR ${c.id} could not decode the reply`);
    continue;
  }
  const result = grade(c, reply);
  if (result.pass) passed += 1;
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${c.id}${result.pass ? '' : ` missing=[${result.missing}] forbidden=[${result.forbidden}] empty=${result.empty}`}`);
}
console.log(`${passed}/${cases.length} passed`);
