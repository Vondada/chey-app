// Character acceptance run on the live Worker (owner, 2026-10-25). Drives CHE's real Create Person flow through the
// deploy's probe routes (creation_probe.js, accept/*): three distinct characters (photoreal, hybrid, stylized), a
// synthetic fictional reference face compared with the same character built without it, chained edits (hair,
// clothing, height, build), and a fresh reopen of every saved character. CHE starts her free cloud worker herself;
// this script only watches, downloads the GLBs the Worker stored, checks each against its receipt and measures it.
//
// Usage: CHE_VOICE_PROBE_TOKEN=... node tools/creation_accept.mjs OUT_DIR [--base URL] [--minutes 70]
// Exit 0 only when every job completed with a GLB whose sha256 matches its receipt and every check passed.
// A queued or running job is never counted as generated.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const args = process.argv.slice(2);
const out = args[0];
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const base = `${opt('--base', 'https://chey-app.henryjavoni.workers.dev')}/api/creations/probe`;
const minutes = Number(opt('--minutes', '70'));
const headers = { 'X-CHE-Memory-Probe': process.env.CHE_VOICE_PROBE_TOKEN || '', 'Content-Type': 'application/json' };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const call = async (path, body) => {
  const r = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => ({ detail: `HTTP ${r.status}, not JSON` }));
  return { status: r.status, ...data };
};

// ---- GLB measurement (pure JSON + binary chunk reading; no Blender needed) ----
export function parseGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2 || dv.getUint32(8, true) !== bytes.length) return null;
  const jsonLen = dv.getUint32(12, true);
  const gltf = JSON.parse(Buffer.from(bytes.subarray(20, 20 + jsonLen)).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  return { gltf, bin: bytes.subarray(binStart) };
}

const bodyMesh = (meshes) => {
  const bySize = [...meshes].sort((a, b) => b.vertices - a.vertices);
  return bySize.find((q) => q.materials.some((x) => /skin|body/i.test(x)) || /body|human/i.test(q.name)) || bySize[0];
};

function positions(glb, accessorIndex) {
  const { gltf, bin } = glb;
  const acc = gltf.accessors[accessorIndex];
  const view = gltf.bufferViews[acc.bufferView];
  const stride = view.byteStride || 12;
  const off = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset + off, view.byteLength - (acc.byteOffset || 0));
  const pts = new Float32Array(acc.count * 3);
  for (let i = 0; i < acc.count; i++) for (let k = 0; k < 3; k++) pts[i * 3 + k] = dv.getFloat32(i * stride + k * 4, true);
  return pts;
}

/** Mesh names, materials, vertex counts, overall height, and body/head widths read from the saved GLB. */
export function measureGlb(bytes) {
  const glb = parseGlb(bytes);
  if (!glb) return null;
  const { gltf } = glb;
  const meshes = (gltf.meshes || []).map((m, i) => {
    const prims = m.primitives || [];
    const verts = prims.reduce((s, p) => s + (gltf.accessors[p.attributes.POSITION]?.count || 0), 0);
    const mats = prims.map((p) => gltf.materials?.[p.material]?.name).filter(Boolean);
    return { i, name: m.name || `mesh${i}`, vertices: verts, materials: [...new Set(mats)] };
  });
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of gltf.meshes || []) for (const p of m.primitives || []) {
    const a = gltf.accessors[p.attributes.POSITION];
    if (!a?.min) continue;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a.min[k]); hi[k] = Math.max(hi[k], a.max[k]); }
  }
  // The body is the largest skin-material mesh (MPFB basemesh), else the largest mesh; glTF is Y-up. Positions are in
  // the mesh's own space (skinned meshes ignore node transforms), which is the same for every build of the pipeline.
  const body = bodyMesh(meshes);
  let bodyStats = null;
  if (body) {
    const pts = positions(glb, gltf.meshes[body.i].primitives[0].attributes.POSITION);
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 1; i < pts.length; i += 3) { ymin = Math.min(ymin, pts[i]); ymax = Math.max(ymax, pts[i]); }
    const h = ymax - ymin;
    const band = (f0, f1) => {
      let xl = Infinity, xh = -Infinity, zl = Infinity, zh = -Infinity, n = 0;
      for (let i = 0; i < pts.length; i += 3) {
        const f = (pts[i + 1] - ymin) / h;
        if (f < f0 || f >= f1) continue;
        n++; xl = Math.min(xl, pts[i]); xh = Math.max(xh, pts[i]); zl = Math.min(zl, pts[i + 2]); zh = Math.max(zh, pts[i + 2]);
      }
      return n ? { width: +(xh - xl).toFixed(4), depth: +(zh - zl).toFixed(4), n } : null;
    };
    // Height fractions of an adult MPFB body (head ~ top 13%, chest ~ 70–75%, waist ~ 60–64%).
    bodyStats = { height_m: +h.toFixed(4), head: band(0.88, 1.01), jaw: band(0.865, 0.9), face_mid: band(0.91, 0.95), chest: band(0.70, 0.75), waist: band(0.60, 0.64), hips: band(0.50, 0.55) };
  }
  return { meshes, bbox_height_m: +(hi[1] - lo[1]).toFixed(4), body: body?.name, body_stats: bodyStats,
    animations: (gltf.animations || []).map((a) => a.name), nodes: (gltf.nodes || []).length, skins: (gltf.skins || []).length };
}

// Head-vertex displacement between two builds of the same character (same topology): mean and max in millimetres.
export function headDisplacementMm(aBytes, bBytes) {
  const a = parseGlb(aBytes), b = parseGlb(bBytes);
  const bodyIdx = (g) => bodyMesh(measureGlb(g === a ? aBytes : bBytes).meshes).i;
  const pa = positions(a, a.gltf.meshes[bodyIdx(a)].primitives[0].attributes.POSITION);
  const pb = positions(b, b.gltf.meshes[bodyIdx(b)].primitives[0].attributes.POSITION);
  if (pa.length !== pb.length) return { comparable: false, reason: `vertex counts differ (${pa.length / 3} vs ${pb.length / 3})` };
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 1; i < pa.length; i += 3) { ymin = Math.min(ymin, pa[i]); ymax = Math.max(ymax, pa[i]); }
  let n = 0, sum = 0, max = 0, moved = 0;
  for (let i = 0; i < pa.length; i += 3) {
    if ((pa[i + 1] - ymin) / (ymax - ymin) < 0.88) continue;
    const d = Math.hypot(pa[i] - pb[i], pa[i + 1] - pb[i + 1], pa[i + 2] - pb[i + 2]) * 1000;
    n++; sum += d; max = Math.max(max, d); if (d > 1) moved++;
  }
  return { comparable: true, head_vertices: n, mean_mm: +(sum / n).toFixed(2), max_mm: +max.toFixed(2), moved_over_1mm: moved };
}

async function main() {
  if (!out) { console.error('usage: creation_accept.mjs OUT_DIR [--base URL] [--minutes N]'); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const refPath = 'test/fixtures/character/synthetic_face.png';
  const body = existsSync(refPath) ? { reference_b64: readFileSync(refPath).toString('base64') } : {};
  // The compute pool's view before the run: which providers can build characters now, and why the others cannot.
  writeFileSync(join(out, 'pool_before.json'), JSON.stringify(await call('/pool').catch((e) => ({ ok: false, detail: String(e) })), null, 2));
  const start = await call('/accept/start', body);
  writeFileSync(join(out, 'start.json'), JSON.stringify(start, null, 2));
  if (!start.ok) throw new Error(`accept start failed: ${start.detail || start.status}`);
  if (!start.engine?.automatic) throw new Error(`no automatic cloud worker: ${start.engine?.waiting_reason || ''}`);
  const run = start.run_id;
  log('started', run, start.items.map((i) => `${i.key}=${i.job_id}`).join(' '));
  // Chained edits on the photoreal character, each its own saved version and job, so each control is isolated.
  const edits = [['photoreal_hair', 'give her short curly hair'], ['photoreal_clothing', 'put her in a hoodie'],
    ['photoreal_height', 'make her shorter'], ['photoreal_build', 'give her a heavier, broader build']];
  const editResults = [];
  for (const [key, text] of edits) {
    const e = await call('/accept/edit', { run_id: run, key, base_key: 'photoreal', text });
    editResults.push({ key, text, ...e });
    log('edit', key, e.ok ? `job ${e.item?.job_id}, applied: ${(e.item?.applied || []).join('; ')}` : `FAILED ${e.detail}`);
  }
  writeFileSync(join(out, 'edits.json'), JSON.stringify(editResults, null, 2));

  let status = null; let last = '';
  while (Date.now() - t0 < minutes * 60_000) {
    status = await call(`/accept/status?run=${run}`).catch((e) => ({ ok: false, detail: String(e) }));
    const line = (status.items || []).map((i) => `${i.key}:${i.state}`).join(' ');
    if (line !== last) { log(line); last = line; }
    if (status.ok && status.items.every((i) => ['completed', 'failed', 'cancelled'].includes(i.state))) break;
    await new Promise((r) => setTimeout(r, 20000));
  }
  writeFileSync(join(out, 'status.json'), JSON.stringify(status, null, 2));

  const results = []; const glbs = {};
  for (const it of status?.items || []) {
    const r = { key: it.key, project_id: it.project_id, job_id: it.job_id, version: it.version, state: it.state, worker: it.worker_name || 'unknown worker',
      device: it.receipt?.device_summary || it.receipt?.device || null, cores: it.receipt?.cores || null, wall_s: it.receipt?.timing?.total_s ?? it.receipt?.elapsed_s ?? null,
      provider: it.receipt?.provider || it.worker_class || null, attempts: it.receipt?.attempts ?? null,
      reference_fit: it.receipt?.reference_fit || null, error: it.error || '', history: it.history, checks: {} };
    if (it.state === 'completed') {
      const res = await fetch(`${base}/model.glb?job=${it.job_id}`, { headers, signal: AbortSignal.timeout(120000) });
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha = createHash('sha256').update(bytes).digest('hex');
      r.glb = { bytes: bytes.length, sha256: sha, matches_receipt: sha === it.model?.sha256 };
      r.measure = measureGlb(bytes);
      r.checks.generated = Boolean(r.measure && r.glb.matches_receipt);
      if (r.checks.generated) { writeFileSync(join(out, `${it.key}.glb`), bytes); glbs[it.key] = bytes; }
      for (const name of it.previews || []) {
        const p = await fetch(`${base}/preview.png?job=${it.job_id}&name=${encodeURIComponent(name)}`, { headers, signal: AbortSignal.timeout(60000) });
        if (p.ok) writeFileSync(join(out, `${it.key}__${name.replace(/[^a-z0-9_.-]/gi, '_')}${name.endsWith('.png') ? '' : '.png'}`), Buffer.from(await p.arrayBuffer()));
      }
    } else r.checks.generated = false;
    results.push(r);
  }
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  const m = (k) => by[k]?.measure;
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };

  // 1. Three distinct characters.
  const three = ['photoreal', 'hybrid', 'stylized'];
  check('three styles generated', three.every((k) => by[k]?.checks.generated), three.map((k) => `${k}:${by[k]?.state || 'missing'}`).join(', '));
  const shas = new Set(three.map((k) => by[k]?.glb?.sha256).filter(Boolean));
  check('three styles are distinct models', shas.size === 3, `${shas.size} distinct GLBs`);
  // 2. Reference face changes facial geometry, not only colours.
  if (glbs.photoreal && glbs.photoreal_noref) {
    const d = headDisplacementMm(glbs.photoreal_noref, glbs.photoreal);
    const fit = by.photoreal.reference_fit || {};
    const shapeSliders = Object.keys(fit.sliders || {}).filter((s) => !/colou?r|skin|hair|eye_col/i.test(s));
    check('reference changes face geometry', d.comparable && d.mean_mm > 0.5 && shapeSliders.length > 0,
      `${JSON.stringify(d)}; ${shapeSliders.length} shape sliders from the fit (${shapeSliders.slice(0, 8).join(', ')})`);
    by.photoreal.reference_effect = { displacement: d, shape_sliders: shapeSliders, widths_noref: m('photoreal_noref')?.body_stats, widths_ref: m('photoreal')?.body_stats };
  } else check('reference changes face geometry', false, 'reference or no-reference build missing');
  // 3. Each control changes the saved model (chain: base → hair → clothing → height → build).
  const pair = (a, b) => [m(a), m(b)];
  {
    const [a, b] = pair('photoreal', 'photoreal_hair');
    const hairOf = (x) => (x?.meshes || []).filter((q) => /hair/i.test(q.name)).map((q) => `${q.name}:${q.vertices}`).join(',');
    check('hair control', a && b && hairOf(a) !== hairOf(b), `before [${hairOf(a)}] after [${hairOf(b)}]`);
  }
  {
    const [a, b] = pair('photoreal_hair', 'photoreal_clothing');
    const cloth = (x) => (x?.meshes || []).filter((q) => !/hair|body|eye|brow|lash|teeth|tongue/i.test(q.name)).map((q) => `${q.name}:${q.vertices}`).sort().join(',');
    check('clothing control', a && b && cloth(a) !== cloth(b), `before [${cloth(a)}] after [${cloth(b)}]`);
  }
  {
    const [a, b] = pair('photoreal_clothing', 'photoreal_height');
    check('height control', a && b && b.body_stats.height_m < a.body_stats.height_m - 0.02, `${a?.body_stats.height_m} m → ${b?.body_stats.height_m} m`);
  }
  {
    const [a, b] = pair('photoreal_height', 'photoreal_build');
    const w = (x) => x?.body_stats?.waist?.width;
    check('build control', a && b && w(b) > w(a) * 1.03, `waist width ${w(a)} m → ${w(b)} m; chest ${a?.body_stats.chest?.width} → ${b?.body_stats.chest?.width}`);
  }
  // 4/5. Reopen every saved character from storage.
  const reopen = await call(`/accept/reopen?run=${run}`);
  writeFileSync(join(out, 'reopen.json'), JSON.stringify(reopen, null, 2));
  const reopenOk = reopen.ok && (reopen.items || []).length > 0 && reopen.items.every((x) => x.model_sha256 && results.some((r) => r.glb?.sha256 === x.model_sha256));
  check('saved characters reopen from storage with the same GLB', reopenOk, (reopen.items || []).map((x) => `${x.key}: v${x.saved_version} ${String(x.model_sha256 || 'none').slice(0, 12)}`).join(', ') || reopen.detail);

  writeFileSync(join(out, 'pool_after.json'), JSON.stringify(await call('/pool').catch((e) => ({ ok: false, detail: String(e) })), null, 2));
  const summary = { run_id: run, minutes: +((Date.now() - t0) / 60000).toFixed(1), results, checks, passed: checks.every((c) => c.ok) };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((s) => process.exit(s.passed ? 0 : 1)).catch((e) => { console.log(`::error title=Character acceptance::${e.message}`); process.exit(1); });
}
