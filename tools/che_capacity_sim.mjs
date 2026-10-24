// Prints CHE's capacity scenarios as Markdown tables from server/cloudflare/capacity_model.js (arithmetic over named
// assumptions; nothing is measured or provisioned).  node tools/che_capacity_sim.mjs [--json]
import { ASSUMPTIONS, estimateVideo, scenarios } from '../server/cloudflare/capacity_model.js';

const s = scenarios();
if (process.argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }
const usd = (n) => (typeof n === 'number' ? `$${Math.round(n).toLocaleString('en-US')}` : String(n));
const num = (n) => (typeof n === 'number' ? Math.round(n).toLocaleString('en-US') : String(n));
const rows = ['one_user', 'users_1k', 'users_100k', 'users_1m'].map((k) => s[k]);
const line = (label, f) => `| ${label} | ${rows.map(f).join(' | ')} |`;
console.log(`| Peak hour (hybrid profile, H100) | ${rows.map((r) => r.name).join(' | ')} |`);
console.log(`|---|${rows.map(() => '---:').join('|')}|`);
for (const [label, f] of [
  ['Worker requests/s', (r) => num(r.chat.worker_rps)],
  ['Durable Objects (one per tenant)', (r) => num(r.chat.durable_objects)],
  ['Video jobs started/hour', (r) => num(r.video.jobs_per_hour)],
  ['Finished video hours/hour', (r) => num(r.video.output_hours_per_hour)],
  ['GPU-hours/hour (H100)', (r) => num(r.video.gpu_hours_per_hour)],
  ['GPUs to keep up (70% busy)', (r) => num(r.video.gpus_needed)],
  ['CPU runners to keep up', (r) => num(r.video.cpu_runners_needed)],
  ['1-min video ready in (min)', (r) => r.video.completion_min['1_min']],
  ['10-min video ready in (min)', (r) => r.video.completion_min['10_min']],
  ['30-min video ready in (min)', (r) => r.video.completion_min['30_min']],
  ['New finished video/month (GB)', (r) => num(r.storage_gb.new_final_per_month)],
  ['Temporary render files, steady (GB)', (r) => num(r.storage_gb.temp_steady)],
  ['Brains (GB)', (r) => num(r.storage_gb.brains)],
  ['Download bandwidth/month (GB)', (r) => num(r.bandwidth_gb_per_month)],
  ['GPU $/month', (r) => usd(r.monthly_cost_usd.gpu)],
  ['LLM $/month', (r) => usd(r.monthly_cost_usd.llm)],
  ['R2 + ops $/month (first month)', (r) => usd(r.monthly_cost_usd.r2_storage_first_month + r.monthly_cost_usd.r2_operations)],
  ['Workers + Durable Objects $/month', (r) => usd(r.monthly_cost_usd.workers + r.monthly_cost_usd.durable_objects)],
  ['Total $/month (paid capacity)', (r) => usd(r.monthly_cost_usd.total)],
]) console.log(line(label, f));
console.log('\n| 1,000,000 thirty-minute videos | hybrid | composited only | high-quality generative only |\n|---|---:|---:|---:|');
const b = s.videos_1m_30min;
for (const [label, k, f] of [
  ['Finished video (hours)', 'output_hours', num], ['GPU-hours (H100)', 'gpu_hours', num], ['CPU-runner hours', 'cpu_runner_hours', num],
  ['Days with 10,000 GPUs + 10,000 CPU runners', 'days_to_finish', (x) => x], ['Storage (TB)', 'storage_tb', (x) => x],
  ['Storage $/month (R2)', 'storage_usd_per_month', usd], ['Compute $ (one time)', 'compute_usd', usd],
]) console.log(`| ${label} | ${f(b.hybrid[k])} | ${f(b.composited[k])} | ${f(b.gen_quality[k])} |`);
console.log('\nPre-job estimate, 30-minute hybrid video on 20 H100s:', JSON.stringify(estimateVideo({ minutes: 30, gpus: 20 })));
console.log('Same video on one free T4:', JSON.stringify(estimateVideo({ minutes: 30, gpu: 't4', gpus: 1 })));
console.log(`\nAssumptions: ${Object.keys(ASSUMPTIONS).length} named values in capacity_model.js ASSUMPTIONS.`);
