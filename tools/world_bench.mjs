#!/usr/bin/env node
// CHE World population benchmark (docs/CHE_WORLD_POPULATION.md). Measures, on THIS machine's CPU (not the iPhone):
//   (a) character records: expandRecord() throughput and bytes per stored record vs a generated GLB
//   (b) generated models per day: arithmetic from the measured CPU job time and the orchestrator's worker limits
//   (c) active characters: world_crowd.html in headless Chromium with SwiftShader (software GL, far slower than an
//       iPhone GPU) for 10/50/200/1000 residents with LOD on and off: fps, draw calls, JS heap.
// Usage: node tools/world_bench.mjs [--quick] [--no-crowd] [--json out.json]     (needs the `playwright` package for (c))
// The crew GLBs in assets/characters/crew stand in for bucket models (no bucket model has been generated yet); each
// bucket key still gets its own parse, as on the phone.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { BUCKET_COUNT, DEFAULT_WORLD, expandRecord } from '../server/cloudflare/world_population.js';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const noCrowd = args.includes('--no-crowd');   // (a) and (b) only
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const root = new URL('..', import.meta.url);
const out = { machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version, platform: `${os.platform()} ${os.release()}`, load_avg_at_start: os.loadavg().map((x) => Math.round(x * 10) / 10) },
  note: 'Measured on a cloud dev container CPU, not on the iPhone. Other processes may share the CPU: see load_avg (1-minute load above the core count means contention).' };

// ── (a) records ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const n = quick ? 50_000 : 300_000;
  for (let s = 1; s <= 5000; s += 1) expandRecord(s);   // warm the JIT
  const runs = [];
  for (let k = 0; k < 3; k += 1) {
    const t0 = performance.now();
    let sink = 0;
    for (let s = 1 + k * n; s <= (k + 1) * n; s += 1) sink += expandRecord(s).bucket.index;
    const ms = performance.now() - t0;
    runs.push({ ms, per_sec: Math.round((n / ms) * 1000), sink, load_avg_1m: Math.round(os.loadavg()[0] * 10) / 10 });
  }
  const best = Math.max(...runs.map((r) => r.per_sec)); const median = runs.map((r) => r.per_sec).sort((a, b) => a - b)[1];
  let expandedBytes = 0; for (let s = 1; s <= 2000; s += 1) expandedBytes += JSON.stringify(expandRecord(s)).length;
  out.records = {
    method: `expandRecord(seed) for ${n.toLocaleString('en-US')} consecutive seeds, 3 runs, one Node thread`,
    per_sec_median: median, per_sec_best: best, per_day_one_thread: median * 86400, per_day_all_cores_projected: median * 86400 * os.cpus().length,
    runs: runs.map(({ per_sec, load_avg_1m }) => ({ per_sec, load_avg_1m })),
    stored_bytes_per_record_in_range: 0,
    stored_bytes_whole_population: JSON.stringify({ worlds: { che_world: { id: 'che_world', seed_start: 1, count: 1_000_000_000 } } }).length,
    stored_bytes_per_edited_record: JSON.stringify({ 42: { name: 'Juno', hair: { style: 'afro' } } }).length,
    expanded_json_bytes_avg: Math.round(expandedBytes / 2000),
  };
}

// ── storage: GLBs ───────────────────────────────────────────────────────────────────────────────────────────────
const crewDir = new URL('assets/characters/crew/', root);
const crew = readdirSync(crewDir).filter((f) => f.endsWith('.glb')).sort();
const crewSizes = crew.map((f) => statSync(new URL(f, crewDir)).size);
const PERSON_MODEL_BYTES = 1_959_512;   // run 40153146586: full-body rigged person_model GLB
out.storage = {
  crew_glb_bytes_avg: Math.round(crewSizes.reduce((a, b) => a + b, 0) / crewSizes.length), crew_glb_bytes_min: Math.min(...crewSizes), crew_glb_bytes_max: Math.max(...crewSizes),
  person_model_glb_bytes: PERSON_MODEL_BYTES,
  all_buckets_bytes: PERSON_MODEL_BYTES * BUCKET_COUNT,
  one_glb_per_record_for_default_world_bytes: PERSON_MODEL_BYTES * DEFAULT_WORLD.count,
};

// ── (b) generated models per day (arithmetic from measured inputs) ─────────────────────────────────────────────
{
  const jobMin = 1.4;   // measured: run 40153146586 built the rigged GLB in 1.4 min (build only, excludes runner start)
  const perWorkerDay = Math.floor((24 * 60) / jobMin);
  out.models = {
    job_minutes_measured: jobMin,
    per_worker_per_day_upper_bound: perWorkerDay,
    default_max_cloud_workers: 3, setting_max: 10, github_free_concurrent_jobs: 20,
    per_day_at_3_workers: perWorkerDay * 3, per_day_at_10_workers: perWorkerDay * 10, per_day_at_20_jobs_ceiling: perWorkerDay * 20,
    all_288_buckets_hours_at_3_workers: Math.round(((BUCKET_COUNT * jobMin) / 3 / 60) * 10) / 10,
    all_288_buckets_hours_at_10_workers: Math.round(((BUCKET_COUNT * jobMin) / 10 / 60) * 10) / 10,
    caveats: 'Upper bounds: they assume back-to-back jobs, no runner start-up (about 1 min per dispatch), no failures, no queue limit (MAX_WAITING 500), and that GitHub keeps the repository on free unlimited public-repo minutes. The orchestrator caps max_cloud_workers at 10, so 20 is a ceiling only if that setting were raised.',
  };
}

// ── (c) world viewer in headless Chromium ───────────────────────────────────────────────────────────────────────
async function crowd() {
  let chromium;
  try { ({ chromium } = createRequire(`${process.cwd()}/`)('playwright')); } catch (_) { return { skipped: 'playwright is not installed' }; }
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info', '--ignore-gpu-blocklist'] });
  const glbs = crew.map((f) => readFileSync(new URL(f, crewDir)).toString('base64'));
  const sizes = quick ? [10, 50] : [10, 50, 200, 1000];
  const rows = [];
  try {
    for (const n of sizes) {
      for (const lod of [true, false]) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 160)));
        await page.exposeFunction('__needBucket', () => {});
        await page.addInitScript(() => { window.__che = []; window.CheBridge = { postMessage: (m) => { const x = JSON.parse(m); window.__che.push(x); } }; });
        await page.goto(new URL('assets/characters/app/world_crowd.html', root).href);
        await page.waitForFunction(() => window.__che.some((m) => m.type === 'page_ready'), null, { timeout: 30000 });
        const recs = [];
        for (let s = 1; s <= n; s += 1) { const r = expandRecord(s); recs.push({ seed: r.seed, bucket: r.bucket.key, variation: r.variation }); }
        await page.evaluate(([r, l]) => { window.CHE.configure({ lod: l, orbit: true }); window.CHE.setPopulation(r); }, [recs, lod]);
        // Answer each bucket request with a crew GLB (index mod 8), like the app answers from its cache.
        const t0 = Date.now(); let served = 0; const deadline = t0 + (lod ? 90_000 : 600_000);
        while (Date.now() < deadline) {
          const need = await page.evaluate(() => { const k = window.__che.filter((m) => m.type === 'need_bucket').map((m) => m.bucket); window.__che = window.__che.filter((m) => m.type !== 'need_bucket'); return k; });
          for (const key of need) {
            const idx = recs.find((r) => r.bucket === key);
            const b64 = glbs[(expandRecord(idx.seed).bucket.index) % glbs.length];
            await page.evaluate(([k, b]) => window.CHE.provideBucket(k, b), [key, b64]); served += 1;
          }
          const pending = await page.evaluate(() => window.CHE.buckets().filter((b) => b.state === 'requested').length);
          if (!need.length && !pending && Date.now() - t0 > 3000) break;
          await page.waitForTimeout(300);
        }
        const loadMs = Date.now() - t0;
        await page.waitForTimeout(2500);
        await page.evaluate(() => { window.__che = window.__che.filter((m) => m.type !== 'status'); });
        await page.waitForTimeout(quick ? 4000 : 6000);
        const st = await page.evaluate(() => window.__che.filter((m) => m.type === 'status'));
        const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
        const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
        const last = st[st.length - 1] || {};
        const avg = (k) => (st.length ? Math.round((st.reduce((a, x) => a + (x[k] || 0), 0) / st.length) * 10) / 10 : null);
        rows.push({ residents: n, lod, fps: avg('fps'), active_animated: avg('active_animated'), near: last.near, mid: last.mid, far: last.far,
          in_view: last.records_in_view, models_loaded: last.models_loaded, buckets_served: served, draw_calls: last.draw_calls, triangles: last.triangles,
          js_heap_mb: Math.round(metrics.JSHeapUsedSize / 1048576), load_seconds: Math.round(loadMs / 100) / 10, samples: st.length, load_avg_1m: Math.round(os.loadavg()[0] * 10) / 10, errors: errors.slice(0, 3) });
        console.error(JSON.stringify(rows[rows.length - 1]));
        await page.close();
      }
    }
  } finally { await browser.close(); }
  return { renderer: 'headless Chromium, SwiftShader software WebGL on the CPU (no GPU); viewport 390x844 at 1x', rows };
}

out.crowd = noCrowd ? { skipped: '--no-crowd' } : await crowd();
const text = JSON.stringify(out, null, 2);
console.log(text);
if (jsonOut) writeFileSync(jsonOut, `${text}\n`);
