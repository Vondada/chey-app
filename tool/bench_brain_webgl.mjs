#!/usr/bin/env node
// Runs assets/brain3d/bench.html in headless Chromium (Playwright) and prints the measured
// frame rates as JSON lines. On this VM Chromium draws with SwiftShader (software), so the
// numbers describe the harness and the fallback path, never a phone's GPU; the same page runs
// inside the app's WebView on the owner's iPhone for the real measurement.
//
//   node tool/bench_brain_webgl.mjs [--nodes 2000] [--seconds 3] [--backend auto|webgl|webgpu]
//
// Exit code 0 when the page reported a result (ok or an honest "unavailable"), 1 on a harness error.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Playwright comes from the project when installed there, else from the machine's tool set
// (the CI runner and this VM keep it under /opt/node-tools).
const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const spec of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { return require(spec); } catch (_) { /* next */ }
  }
  throw new Error('playwright is not installed (npm i -D playwright, or /opt/node-tools)');
})();

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null)).filter(Boolean));
const nodes = Number(args.nodes || 2000), seconds = Number(args.seconds || 3), backend = args.backend || 'auto';
const page_ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'brain3d', 'bench.html');

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'] });
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 956 } });
  const messages = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('BRAIN_BENCH ')) messages.push(JSON.parse(t.slice('BRAIN_BENCH '.length))); });
  await page.goto('file://' + page_);
  await page.waitForFunction(() => typeof window.brainBenchRun === 'function');
  // The bridge refuses anything but the validated shape: prove it before measuring.
  const refused = await page.evaluate(() => { window.brainBenchRun({ nodes: 2000, evil: 'alert(1)' }); return window.__brainBenchResults.filter((r) => r.type === 'error').map((r) => r.reason); });
  console.log(JSON.stringify({ type: 'bridge', refused }));
  const accepted = await page.evaluate(({ nodes, seconds, backend }) => window.brainBenchRun({ nodes, edges: Math.round(nodes * 1.5), seconds, backend, label: 'vm' }), { nodes, seconds, backend });
  if (!accepted) throw new Error('parameters refused');
  await page.waitForFunction(() => window.__brainBenchResults.some((r) => r.type === 'result'), null, { timeout: (seconds + 15) * 1000 });
  for (const m of await page.evaluate(() => window.__brainBenchResults)) {
    if (['capability', 'fallback', 'result', 'contextlost', 'devicelost'].includes(m.type)) console.log(JSON.stringify({ ...m, renderer: 'headless Chromium, SwiftShader software GL on this VM' }));
  }
} finally {
  await browser.close();
}
