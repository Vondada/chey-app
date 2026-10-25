// Measures the CPU cost of CHE's invention scene edits and GLB build on this machine (Node). It does not measure
// rendering, frame rate or iPhone performance; those need a device run. Usage: node tools/bench/invention_scene_bench.mjs
import { sceneFor, explode, setPartSize, visibleBoxParts } from '../../server/cloudflare/invention_scene.js';
import { buildGlb, paletteFor } from '../../server/cloudflare/invention_visuals.js';

const time = (fn, n = 200) => { fn(); const t0 = performance.now(); let r; for (let i = 0; i < n; i++) r = fn(); return { ms: (performance.now() - t0) / n, r }; };
const base = sceneFor('jet_engine');
const pal = paletteFor('jet_engine', 'silver');
const result = {
  parts: base.parts.length,
  sceneBuildMs: +time(() => sceneFor('jet_engine')).ms.toFixed(4),
  explodeMs: +time(() => explode(base, 0.2)).ms.toFixed(4),
  resizeMs: +time(() => setPartSize(base, 'front fan blades', { x: 0.5 })).ms.toFixed(4),
  glbBuildMs: +time(() => buildGlb(visibleBoxParts(base), pal), 50).ms.toFixed(3),
  glbBytes: time(() => buildGlb(visibleBoxParts(base), pal), 1).r.byteLength,
  note: 'CPU in Node only. Not rendering, frame rate or iPhone time.',
};
console.log(JSON.stringify(result, null, 1));
