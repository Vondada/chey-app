// Open a GLB in CHE's own Live Studio viewport (assets/characters/app/studio.html) in headless Chromium, the page the
// app shows, and report what the page itself says it loaded; then play a clip and save a screenshot.
// Usage: node tools/creation_open_in_studio.mjs model.glb out.png [clip]   (needs the `playwright` package)
// Exit 0 only when the page reported a model with meshes; prints one JSON line with the page's own messages.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const [glbPath, outPng, clip = 'walk'] = process.argv.slice(2);
if (!glbPath || !outPng) { console.error('usage: creation_open_in_studio.mjs model.glb out.png [clip]'); process.exit(2); }
const require = createRequire(`${process.cwd()}/`);
const { chromium } = require('playwright');
const page_url = new URL('../assets/characters/app/studio.html', import.meta.url);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const out = { ok: false, page_ready: null, model: null, animate: null, errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 640 } });
  page.on('pageerror', (e) => out.errors.push(String(e.message || e).slice(0, 200)));
  await page.addInitScript(() => { window.__che = []; window.CheBridge = { postMessage: (m) => window.__che.push(JSON.parse(m)) }; });
  await page.goto(page_url.href);
  const wait = async (type, ms = 60000) => page.waitForFunction((t) => window.__che.find((m) => m.type === t || m.type === 'error'), type, { timeout: ms })
    .then(() => page.evaluate((t) => window.__che.find((m) => m.type === t) || window.__che.find((m) => m.type === 'error'), type));
  out.page_ready = await wait('page_ready', 30000);
  const b64 = readFileSync(glbPath).toString('base64');
  await page.evaluate((b) => window.CHE.loadModel(b, { label: 'Creation Engine check' }), b64);
  out.model = await wait('model', 120000);
  if (out.model?.type === 'model') {
    // The same command the app sends for "play the walk" (che_live_studio.dart command → window.CHE.view).
    await page.evaluate((c) => window.CHE.view({ action: 'animate', clip: c }), clip);
    out.animate = await wait('done', 15000).catch(() => null);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: outPng });
    // Passing needs the model AND the requested clip really playing (the page's own answer), never a missing reply.
    out.ok = out.model.meshes > 0 && out.animate?.type === 'done' && out.animate.ok === true && out.animate.playing === clip && !out.errors.length;
  }
} catch (e) {
  out.errors.push(String(e.message || e).slice(0, 300));
} finally {
  await browser.close();
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
