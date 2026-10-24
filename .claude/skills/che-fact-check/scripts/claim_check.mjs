#!/usr/bin/env node
// Runs CHE's own production truth guards on a drafted reply, or shows which
// memory/evidence route an owner message takes. No model, no network: the
// verdict is what server/cloudflare does before the owner sees the text.
//
//   claim_check.mjs --reply "text" [--owner "owner's own words"]… [--records records.json]
//                   [--tool plugin/tool]… [--source https://…]… [--document-read] [--message "owner message"] [--json]
//   claim_check.mjs --route "owner message" [--records records.json]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Worker of the checkout this runs in (a worktree included), else the
// one next to this script.
function workerDirectory() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top && existsSync(resolve(top, 'server/cloudflare/worker.js'))) return resolve(top, 'server/cloudflare');
  } catch (_) { /* not in a git checkout */ }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../server/cloudflare');
}
const workerDir = workerDirectory();
const lib = (file) => import(pathToFileURL(resolve(workerDir, file)).href);

const argv = process.argv.slice(2);
const many = (name) => argv.flatMap((a, i) => (a === name && i + 1 < argv.length ? [argv[i + 1]] : []));
const one = (name) => many(name).at(-1);
const usage = () => {
  console.error('usage: claim_check.mjs --reply "text" [--owner "…"]… [--records f.json] [--tool p/t]… [--source url]… [--document-read] [--message "…"] [--json]\n       claim_check.mjs --route "owner message" [--records f.json]');
  process.exit(2);
};

let records = [];
if (one('--records')) {
  try {
    records = JSON.parse(readFileSync(one('--records'), 'utf8'));
    if (!Array.isArray(records)) throw new Error('expected a JSON array of memory records');
  } catch (error) {
    console.error(`claim_check: --records: ${error.message}`);
    process.exit(2);
  }
}

const mp = await lib('memory_provenance.js');
const truth = await lib('truth_layer.js');

/** The memory/evidence route worker.js gives an owner message (later routes are not modelled). */
export function routeOf(message) {
  if (mp.evidenceQuestion(message, [])) return { route: 'che_evidence_receipt', model: false };
  const split = mp.evidenceRequestSplit(message);
  if (split) return { route: 'che_evidence_receipt + rest', model: null, rest: split.rest, rest_route: routeOf(split.rest) };
  const memory = mp.ownerMemoryQuestion(message);
  if (memory) return { route: 'che_memory_provenance', model: false, topic: memory.topic || '', recent: Boolean(memory.recent) };
  if (mp.ownerFactCorrection(message, records)) return { route: 'che_memory (owner correction)', model: false };
  if (truth.vagueResearchRequest(message)) return { route: 'che_clarify (which fact?)', model: false };
  return { route: 'general pipeline (may call a model; final guards apply)', model: null };
}

const routeMessage = one('--route');
if (routeMessage !== undefined) {
  const result = routeOf(routeMessage);
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`ROUTE: ${result.route}${result.rest ? `\nREST: "${result.rest}" → ${result.rest_route.route}` : ''}${result.topic ? `\nTOPIC: ${result.topic}` : ''}`);
  process.exit(0);
}

let reply = one('--reply');
if (one('--reply-file')) reply = readFileSync(one('--reply-file'), 'utf8');
if (!reply || !reply.trim()) usage();
const ownerTurns = many('--owner');
const message = one('--message') || '';
const tools = many('--tool').map((t) => ({ ok: true, plugin: t.split('/')[0], tool: t.split('/')[1] || t }));
const sources = many('--source');
const research = sources.length ? { summary: 'research receipt', sources, cached: false } : null;

// Same order as the final boundary in worker.js.
const research_check = truth.guardClaimedResearchActions(reply, { research, tools, documentRead: argv.includes('--document-read'), message });
const attribution = mp.guardOwnerAttributions(research_check.text, { records, ownerTurns, message });
const remember = mp.guardRememberBlock(attribution.text, { ownerTurns, retracted: [] });
// The chat pipeline's execution_claims stage: invented record ids, storage reads, tool runs and repository claims.
const execution = truth.guardExecutionClaims(remember.text, { message, receipts: [], documentRead: argv.includes('--document-read') });
const result = {
  verdict: research_check.corrected || attribution.removed.length || remember.dropped.length || execution.removed.length ? 'BLOCKED' : 'PASS',
  research_claim_corrected: research_check.corrected,
  attributions_removed: attribution.removed,
  remember_lines_dropped: remember.dropped,
  execution_claims_removed: execution.removed,
  owner_sees: execution.text,
};
if (argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const lines = [`VERDICT: ${result.verdict}`];
  if (result.research_claim_corrected) lines.push('- research/tool claim with no execution receipt: whole reply replaced');
  for (const s of result.attributions_removed) lines.push(`- unsupported owner attribution removed: "${String(s).trim().slice(0, 200)}"`);
  for (const s of result.execution_claims_removed) lines.push(`- record, storage or execution claim with no receipt removed: "${String(s).trim().slice(0, 200)}"`);
  for (const s of result.remember_lines_dropped) lines.push(`- che-remember line dropped (not in the owner's words): "${String(s).slice(0, 160)}"`);
  lines.push(`OWNER SEES: ${result.owner_sees.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
  console.log(lines.join('\n'));
}
process.exit(result.verdict === 'PASS' ? 0 : 1);
