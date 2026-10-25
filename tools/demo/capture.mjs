// Captures every segment of the Create Room demo as numbered JPEG frames, in headless Chromium (Playwright, SwiftShader
// WebGL), on a virtual clock so every frame is exactly 1/24 s apart however slow the CPU renders.
//
//   node tools/demo/capture.mjs BUILD_DIR MODELS_DIR [segment ids, comma-separated]
//
// BUILD_DIR holds timeline.json (tools/demo/tts.py) and evidence.json (tools/demo/inspect_glbs.py); frames go to
// BUILD_DIR/frames/<segment>/00000.jpg and BUILD_DIR/capture_times.json records frames and seconds per segment.
// 3D segments use CHE's real Live Studio page (assets/characters/app/studio.html), unmodified, inside the demo frame
// (tools/demo/web/shell.html) and driven only through its own commands (window.CHE.view / loadModel), except where the
// segment's label says the demo itself sets a value (shape keys one at a time, the turn, the camera).
// The office segment uses tools/demo/web/office.html (staging: labelled PROTOTYPE).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [BUILD, MODELS, ONLY = ''] = process.argv.slice(2);
if (!BUILD || !MODELS) { console.error('usage: capture.mjs BUILD_DIR MODELS_DIR [ids]'); process.exit(2); }
const FPS = 24, DT = 1000 / FPS;
const TL = JSON.parse(readFileSync(path.join(BUILD, 'timeline.json'), 'utf8'));
const EV = JSON.parse(readFileSync(path.join(BUILD, 'evidence.json'), 'utf8'));
const TIMES = existsSync(path.join(MODELS, 'build_times.json')) ? JSON.parse(readFileSync(path.join(MODELS, 'build_times.json'), 'utf8')) : {};
const CLOSE = existsSync(path.join(MODELS, 'closeup_times.json')) ? JSON.parse(readFileSync(path.join(MODELS, 'closeup_times.json'), 'utf8')) : {};
const glb = (name) => path.join(MODELS, name, 'model.glb');
const fileUrl = (p) => pathToFileURL(p).href;
const b64 = (name) => readFileSync(glb(name)).toString('base64');
const P = EV.photoreal;
const MB = (n) => (n / 1048576).toFixed(2) + ' MB';
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const ramp = (t, a, b) => ease((t - a) / (b - a));
const pulse = (t, a, b, r = 0.35) => Math.min(ramp(t, a, a + r), 1 - ramp(t, b - r, b));

// Virtual clock: performance.now, Date.now and requestAnimationFrame are driven by __step(ms), in every frame.
const CLOCK = `(() => {
  let t = 1000; const q = []; const d0 = 1761350400000;
  performance.now = () => t; Date.now = () => d0 + t;
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.cancelAnimationFrame = () => {};
  window.__step = (ms) => { t += ms; const cbs = q.splice(0); for (const cb of cbs) { try { cb(t); } catch (e) { console.error(e); } } };
  window.__che = []; window.CheBridge = { postMessage: (m) => window.__che.push(JSON.parse(m)) };
  let seed = 7; Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
})();`;

const RIG_INFO = `<h4>From the GLB file itself</h4>${P.bones} bones (skin joints) · ${P.vertices.toLocaleString('en')} vertices<br>` +
  `clips: ${Object.entries(P.clips).map(([k, v]) => `${k} ${v.duration_s}s`).join(', ')}<br>shape keys: ${P.morphs.join(', ')}<br>rig verify (verify_glb.py): ${P.rig_verify_ok ? 'OK' : 'FAILED'}`;
const REAL_STUDIO = ['real', "built by CHE's pipeline (MPFB2 + Blender job), shown in CHE's Live Studio viewer"];

function speechAt(seg, t) {
  const live = seg.lines.filter((l) => t >= l.start - 0.05 && t < l.end + 0.7);
  return live.length ? live[live.length - 1] : null;
}

async function studioFrames(ctx, rects) {
  const { page } = ctx;
  await page.evaluate((r) => window.SH.frames(r), rects);
  const frames = {};
  for (const r of rects) {
    const h = await page.waitForSelector(`#${r.id}`); const f = await h.contentFrame();
    await f.waitForFunction(() => window.__che && window.__che.find((m) => m.type === 'page_ready'), null, { timeout: 60000 });
    frames[r.id] = f;
  }
  ctx.frames = frames;
  return frames;
}
async function loadInto(f, name, label) {
  const n0 = await f.evaluate(() => window.__che.length);
  await f.evaluate(([b, l]) => window.CHE.loadModel(b, { label: l }), [b64(name), label]);
  await f.waitForFunction((n) => window.__che.slice(n).find((m) => m.type === 'model' || m.type === 'error'), n0, { timeout: 120000 });
  return f.evaluate((n) => window.__che.slice(n).find((m) => m.type === 'model' || m.type === 'error'), n0);
}
const cmd = (f, c) => f.evaluate((x) => window.CHE.view(x), c);

const S = {};

S.s01_title = {
  async setup({ page }) {
    await page.evaluate(() => {
      SH.view(`<div class="card"><div class="muted" style="font-size:18px;letter-spacing:3px">CHE · CREATE ROOM</div>
        <h1>Make a character, then use it</h1>
        <h2>Demonstration video, 25 October 2026 · fictional character "Ava" (invented for this demo, not a real person)</h2>
        <div class="legend">
          <div class="lab real"><b>REAL</b><span>built by CHE's pipeline: actual MPFB2 + Blender output from the real job scripts</span></div>
          <div class="lab proto"><b>PROTOTYPE</b><span>planned: staged or approximated for this video, not yet in the app</span></div>
          <div class="lab nzero"><b>NOT AT $0</b><span>would need paid services or new API keys, which the owner ruled out</span></div>
        </div>
        <p class="muted" style="margin-top:30px;font-size:16px">Voices: Kokoro (open model, the same one CHE's iPhone app uses), run on this computer. The owner's words are re-enacted by a synthetic voice.</p></div>`);
    });
  },
};

S.s02_create = {
  async setup({ page, seg }) {
    const owner = seg.lines[0];
    const r = JSON.parse(readFileSync(path.join(MODELS, 'photoreal', 'receipt.json'), 'utf8'));
    const st = r.stage_seconds, v = r.views;
    const log = [
      `JOB ${r.job_id}  (scripts/che_gpu_face_preview.py --model)`, `CPU: ${r.cores} threads, no GPU (nvidia-smi absent)`, `${r.blender_version}`,
      `STAGE model    ${st.model}s   MPFB2 body + face targets`, `STAGE rig      ${st.rig}s   53-bone game_engine skeleton, skin weights`,
      `STAGE animate  ${st.animate}s   idle walk run wave talk`, `STAGE verify   ${st.verify}s   re-import: RIG OK`,
      `MODEL READY model.glb ${MB(r.model.bytes)}, ${r.model.vertices.toLocaleString('en')} vertices`,
      ...['0', '45', '90'].map((k) => `VIEW ${k.padEnd(3)} Cycles CPU ${r.samples} spp ${v[k].render_seconds}s`),
      `photoreal  EXIT 0  ${TIMES.photoreal?.seconds}s wall`, `hybrid     EXIT 0  ${TIMES.hybrid?.seconds}s wall`, `stylized   EXIT 0  ${TIMES.stylized?.seconds}s wall`,
      '(wall times on 4 CPU cores shared with another render)',
    ];
    await page.evaluate(([log, txt]) => {
      SH.view(`<div class="phone"><div class="muted" style="font-size:13px;letter-spacing:2px">CREATE PERSON</div><h3>Describe who to make</h3>
        <div class="field" id="typed"></div><div class="muted" style="font-size:13px">Style</div>
        <div class="chips"><span class="chip on">1 Photoreal</span><span class="chip on">2 Game-like</span><span class="chip on">3 Stylized</span></div>
        <div class="btn" id="go">Create</div><div class="muted" id="st" style="margin-top:12px;font-size:15px"></div></div>
        <div class="log" id="log"></div>`);
      window.__log = log; window.__txt = txt;
    }, [log, owner.text.replace(/^Create Ava: /, '')]);
    this.owner = owner;
  },
  async frame({ page, seg }, t) {
    const o = this.owner, typed = Math.round(ramp(t, o.start, o.end - 0.3) * 1000);
    const che = seg.lines[1];
    const n = t < o.end ? 0 : Math.min(15, Math.floor((t - o.end) * 4) + 1);
    await page.evaluate(([typed, pressed, n]) => {
      const s = window.__txt; document.getElementById('typed').textContent = s.slice(0, Math.round(s.length * typed / 1000)) + (typed < 1000 ? '▍' : '');
      document.getElementById('go').className = 'btn' + (pressed ? ' pressed' : '');
      document.getElementById('st').textContent = pressed ? 'Queued on the free CPU worker. Building…' : '';
      document.getElementById('log').innerHTML = window.__log.slice(0, n).map((l) => `<div>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join('');
    }, [typed, t > o.end, n]);
  },
  labels: [['proto', 'mock of the Create input (free-text Create is lane B work in progress)'], ['real', 'job log and times: the real person_model job on this CPU']],
};

S.s03_styles = {
  async setup({ page }) {
    const items = ['photoreal', 'hybrid', 'stylized'].map((k, i) => ({
      n: i + 1, name: ['Photoreal', 'Game-like (hybrid)', 'Stylized'][i],
      body: fileUrl(path.join(MODELS, k, 'view_45.png')), face: fileUrl(path.join(MODELS, k, 'closeup', 'body_20.png')),
      s: `job ${EV[k].job_id} · views ${Object.values(EV[k].view_seconds).join('/')} s · close-up ${CLOSE[k]?.render_seconds ?? '?'} s`,
    }));
    await page.evaluate((items) => {
      SH.view(`<div class="styles">${items.map((it) => `<div class="sty" id="sty${it.n}"><div class="imgs"><img src="${it.body}" style="width:178px;height:267px;object-fit:cover">
        <img src="${it.face}" style="width:178px;height:267px;object-fit:cover"></div><div class="n">${it.n} · ${it.name}</div><div class="s">${it.s}</div></div>`).join('')}</div>`);
    }, items);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 });
  },
  async frame({ page, seg }, t) {
    const l = seg.lines[0], f = (t - l.start) / (l.end - l.start);
    const hl = t < l.start ? 0 : f < 0.33 ? 1 : f < 0.5 ? 1 : f < 0.66 ? 2 : f < 0.82 ? 3 : 0;
    await page.evaluate((hl) => { for (const i of [1, 2, 3]) document.getElementById('sty' + i).className = 'sty' + (i === hl ? ' hl' : ''); }, hl);
  },
  labels: [['real', 'Cycles CPU renders of the three job builds (48 spp, 720 px; close-ups 32 spp via render_glb.py)'],
    ['proto', 'planned: true hyperrealism. These builds have no brows, lashes or strand hair, and the looks differ only slightly']],
};

S.s04_rig = {
  async setup(ctx) {
    const fr = await studioFrames(ctx, [{ id: 'a', x: 0, y: 0, w: 1280, h: 720 }]);
    ctx.model = await loadInto(fr.a, 'photoreal', 'Ava (photoreal)');
    await cmd(fr.a, { action: 'animate', clip: 'idle' });
    await fr.a.evaluate(() => { orbit.dist = 1.3; target.y -= 0.12; place(); });
    this.shown = false;
  },
  async frame({ frames, seg }, t) {
    if (!this.shown && t >= seg.lines[1].start) { this.shown = true; await cmd(frames.a, { action: 'skeleton', on: true }); await cmd(frames.a, { action: 'spin', on: true }); }
  },
  labels: [REAL_STUDIO, ['real', "skeleton overlay: the GLB's own 53 bones (Live Studio skeleton command)"]],
  info: RIG_INFO,
};

S.s05_face = {
  async setup(ctx) {
    const fr = await studioFrames(ctx, [{ id: 'a', x: 0, y: 0, w: 1280, h: 720 }]);
    await loadInto(fr.a, 'photoreal', 'Ava (photoreal)');
    await cmd(fr.a, { action: 'stop' });
    await fr.a.evaluate(() => { const b = new THREE.Box3().setFromObject(model, true); target.set(0, b.max.y - 0.15, 0); orbit.yaw = 0.25; orbit.pitch = 0.02; orbit.dist = 0.23; place(); dirty = true; });
  },
  async frame({ frames }, t) {
    const v = { blink_l: pulse(t, 0.6, 1.7, 0.15), blink_r: pulse(t, 0.6, 1.7, 0.15), smile: pulse(t, 1.9, 3.3), brows_up: pulse(t, 3.4, 4.8), mouth_open: pulse(t, 5.0, 6.6) };
    const name = t < 1.8 ? 'blink_l + blink_r' : t < 3.35 ? 'smile' : t < 4.9 ? 'brows_up' : 'mouth_open';
    await frames.a.evaluate((v) => { for (const [k, x] of Object.entries(v)) setMorph(k, x); dirty = true; }, v);
    this.info = `<h4>Shape key now</h4>${name}<br><span style="color:#9aa4aa">all five: ${P.morphs.join(', ')}</span>`;
  },
  labels: [REAL_STUDIO, ['real', "the GLB's own face shape keys (MakeHuman expression units); the demo sets one at a time"]],
};

S.s06_move = {
  async setup(ctx) {
    const fr = await studioFrames(ctx, [{ id: 'a', x: 0, y: 0, w: 1280, h: 720 }]);
    await loadInto(fr.a, 'photoreal', 'Ava (photoreal)');
    await cmd(fr.a, { action: 'animate', clip: 'idle' });
    await fr.a.evaluate(() => { orbit.yaw = 0.9; orbit.dist = 1.3; target.y -= 0.12; place(); });
    this.state = 'idle';
  },
  async frame({ frames }, t) {
    const want = t < 3.0 ? 'idle' : t < 7.5 ? 'walk' : t < 9.9 ? 'run' : 'wave';
    if (want !== this.state) { this.state = want; await cmd(frames.a, { action: 'animate', clip: want }); }
    const yaw = 2 * Math.PI * ramp(t, 5.1, 7.4);   // the turn: the demo rotates the root while the walk clip plays
    await frames.a.evaluate((y) => { model.rotation.y = y; dirty = true; }, yaw);
    this.labels = t >= 5.0 && t < 7.4
      ? [['real', 'walk clip from the GLB'], ['proto', 'turning: the demo rotates the root over the walk clip; no turn clip is built yet']]
      : [REAL_STUDIO, ['real', want === 'idle' ? 'idle clip' : want === 'walk' ? 'walk clip (in place; GLB declares ground speed 1.0 m/s)' : want === 'run' ? 'run clip (in place; 2.96 m/s)' : 'wave clip']];
  },
};

function speakSeg(model, voiceNote, protoNote) {
  return {
    async setup(ctx) {
      const fr = await studioFrames(ctx, [{ id: 'a', x: 0, y: 0, w: 1280, h: 720 }]);
      await loadInto(fr.a, model, 'Ava');
      await cmd(fr.a, { action: 'animate', clip: 'idle' });
      await cmd(fr.a, { action: 'blink', on: true });
      await fr.a.evaluate(() => { const b = new THREE.Box3().setFromObject(model, true); target.set(0, b.max.y - 0.12, 0); orbit.yaw = 0.3; orbit.pitch = 0.05; orbit.dist = 0.3; place(); dirty = true; });
      this.started = false;
    },
    async frame({ frames, seg }, t) {
      const l = seg.lines.find((x) => x.envelope);
      if (!this.started && t >= l.start) {
        this.started = true;
        await cmd(frames.a, { action: 'animate', clip: 'talk' });
        const r = await cmd(frames.a, { action: 'lipsync', envelope: l.envelope });
        this.note = await frames.a.evaluate(() => window.__che.filter((m) => m.action === 'lipsync').pop()?.note);
      }
      if (this.started && t > l.end + 0.3 && !this.back) { this.back = true; await cmd(frames.a, { action: 'animate', clip: 'idle' }); }
      this.info = `<h4>Live Studio says</h4>${this.note || 'waiting for speech'}<br><span style="color:#9aa4aa">${voiceNote}</span>`;
    },
    labels: [['real', 'speech: Kokoro TTS on this CPU (same model as the iPhone app), no API key'],
      ['real', 'lip-sync: Live Studio drives mouth_open from the audio loudness'], ['proto', protoNote]],
  };
}
S.s07_speak = speakSeg('photoreal', 'voice 3 af_sarah · talk clip + amplitude envelope', 'jaw-only: no phoneme visemes (no viseme shape keys yet)');
S.s08b_voice = speakSeg('hybrid', 'voice 7 bf_emma (CHE local voice list) · hybrid style build', 'saving a voice per character in the app: lane B, in progress');

S.s08_custom = {
  async setup(ctx) {
    const R = [['a', 'photoreal', 'Before'], ['b', 'hair_copper', 'Hair colour: copper'], ['c', 'outfit_navy', 'Outfit: blue top, sand trousers, brown shoes'], ['d', 'body_tall_strong', 'Body: taller, more muscle and weight']];
    const fr = await studioFrames(ctx, R.map(([id], i) => ({ id, x: i * 320, y: 0, w: 320, h: 720 })));
    this.R = R;
    for (const [id, name] of R) { (this.H = this.H || {})[name] = (await loadInto(fr[id], name, name)).height_m; await cmd(fr[id], { action: 'animate', clip: 'idle' }); await fr[id].evaluate(() => { orbit.yaw = 0.5; orbit.dist = 1.8; target.y += 0.3; place(); }); }
    const tags = R.map(([id, name, txt], i) => {
      const e = EV[name];
      return `<div style="position:absolute;left:${i * 320 + 8}px;top:126px;width:304px;padding:6px 10px;border-radius:8px;background:rgba(5,6,8,.8);font-size:14px;line-height:1.35">
        <b>${txt}</b><br><span style="color:#9aa4aa">checked by inspect_glbs.py: ${e.bones} bones ${e.same_rig_as_photoreal ? '· same names and order ✓' : '✗'}<br>${Object.keys(e.clips).length} clips ${e.same_clips_as_photoreal ? '· same channels ✓' : '✗'}${e.max_joint_offset_m ? ` · joints moved ${e.max_joint_offset_m} m` : ''}<br>height ${this.H[name]} m (each view frames its own model)</span></div>`;
    }).join('');
    await ctx.page.evaluate((html) => document.getElementById('view').insertAdjacentHTML('beforeend', html), tags);
    this.state = 'idle';
  },
  async frame({ frames, seg }, t) {
    const want = t < seg.lines[1].start ? 'idle' : t < seg.lines[1].start + 4.5 ? 'walk' : 'wave';
    if (want !== this.state) { this.state = want; for (const [id] of this.R) await cmd(frames[id], { action: 'animate', clip: want }); }
  },
  labels: [['real', 'four separate job builds, each in its own Live Studio view, same clip at once'], ['proto', 'hair STYLE geometry (only a scalp cap today) and app body sliders: lane A/B in progress']],
  info: '',
};

S.s09_office = {
  async setup(ctx) {
    await ctx.page.evaluate(() => SH.view('<iframe id="o" src="office.html" style="left:0;top:0;width:1280px;height:720px"></iframe>'));
    const f = await (await ctx.page.waitForSelector('#o')).contentFrame();
    await f.waitForFunction(() => window.OFFICE && window.OFFICE.ready, null, { timeout: 60000 });
    await f.evaluate((b) => window.OFFICE.load(b), b64('photoreal'));
    await f.waitForFunction(() => window.OFFICE.loaded, null, { timeout: 120000 });
    ctx.frames = { o: f };
  },
  async frame({ frames }, t) {
    const st = await frames.o.evaluate((t) => window.OFFICE.at(t), t);
    this.info = `<h4>Now</h4>${st}`;
  },
  labels: [['real', "Ava's GLB and its own walk, idle and wave clips"], ['proto', 'office staging by the demo: room geometry from assets/office3d, walk path, turn, sit pose (no sit clip yet)']],
};

S.s10_save = {
  async setup(ctx) {
    const thumb = fileUrl(path.join(MODELS, 'photoreal', 'view_00.png'));
    const thumb2 = fileUrl(path.join(MODELS, 'hybrid', 'view_00.png'));
    await ctx.page.evaluate(([t1, t2]) => {
      SH.view(`<div id="sheet" class="sheet"><div class="muted" style="font-size:13px;letter-spacing:2px">MY CREATIONS</div>
        <h3 style="margin:4px 0 0;font-size:24px">My Creations: 2. Say a number to open one.</h3>
        <div class="row hl" id="r1"><img src="${t1}"><div><b style="font-size:20px">1. Ava</b><br><span class="muted">Person · photoreal · saved just now · 1 version</span></div></div>
        <div class="row"><img src="${t2}"><div><b style="font-size:20px">2. Ava (game-like)</b><br><span class="muted">Person · hybrid · saved just now</span></div></div></div>
        <iframe id="a" src="../../../assets/characters/app/studio.html" style="left:0;top:0;width:1280px;height:720px;visibility:hidden"></iframe>`);
    }, [thumb, thumb2]);
    const f = await (await ctx.page.waitForSelector('#a', { state: 'attached' })).contentFrame();
    await f.waitForFunction(() => window.__che && window.__che.find((m) => m.type === 'page_ready'), null, { timeout: 60000 });
    ctx.frames = { a: f }; this.opened = false;
  },
  async frame(ctx, t) {
    const { page, frames, seg } = ctx;
    const openAt = seg.lines[1].start + 1.6;
    if (!this.opened && t >= openAt) {
      this.opened = true;
      this.model = await loadInto(frames.a, 'photoreal', 'Ava (from My Creations)');
      await cmd(frames.a, { action: 'animate', clip: 'wave' });
      await frames.a.evaluate(() => { orbit.dist = 1.45; target.y += 0.15; place(); dirty = true; });
      await page.evaluate(() => { document.getElementById('sheet').style.display = 'none'; document.getElementById('a').style.visibility = 'visible'; });
    }
    if (this.opened) {
      const m = this.model;
      this.labels = [['real', "the saved model.glb reopened in CHE's Live Studio page; numbers below are the page's own report"],
        ['real', 'exports: GLB (this file) and Roblox R15 FBX (tools/avatar_body/roblox_export.py)'], ['proto', 'My Creations list above was a mock card; reopen in the app: lane B, in progress']];
      const rb = ctx.roblox;
      this.info = `<h4>Live Studio reported</h4>meshes ${m.meshes} · vertices ${m.vertices.toLocaleString('en')} · triangles ${m.triangles.toLocaleString('en')}<br>clips ${m.clips.join(', ')}<br>mouth ${m.mouth_morph} · blink ${m.blink} · height ${m.height_m} m` +
        `<h4 style="margin-top:8px">Exports</h4>GLB ${MB(P.bytes)} sha256 ${P.sha256.slice(0, 12)}…<br>${rb ? `Roblox: ${rb}` : 'Roblox: not run'}`;
    } else {
      this.labels = [['proto', 'mock of the My Creations sheet (wording from lib/create/che_creative_studio.dart)']];
      this.info = '';
    }
  },
};

S.s11_end = {
  async setup({ page }) {
    const rows = [
      ['Describe + Create (input screen)', 'proto', 'mock card; free-text Create is lane B work'],
      ['Three styles from one description', 'real', '3 job builds, Cycles renders'],
      ['Skeleton, skin weights, 5 clips, 5 face keys', 'real', 'read from the GLB; rig verify OK'],
      ['Walk, run, wave, idle, talk', 'real', 'clips in the GLB, played by Live Studio'],
      ['Turning, sitting, office interaction', 'proto', 'staged by the demo; no turn/sit clips yet'],
      ['Speech (Kokoro TTS)', 'real', 'local, open model, no key'],
      ['Lip-sync', 'real', 'amplitude on mouth_open; phoneme visemes: planned'],
      ['Hair colour, outfit, body change keep rig + clips', 'real', 'same 53 bone names, same clip channels'],
      ['Hair style geometry, app body sliders, voice per character', 'proto', 'lanes A/B in progress'],
      ['Save, reopen in Live Studio, GLB + Roblox FBX export', 'real', 'reopen screen in app: lane B'],
      ['GPU-speed renders on demand; neural photo-to-3D or voice-clone services', 'nzero', 'need paid GPU or API keys: CPU worker used'],
    ];
    await page.evaluate((rows) => {
      const K = { real: 'REAL', proto: 'PROTOTYPE', nzero: 'NOT AT $0' };
      SH.view(`<div class="card" style="padding-top:40px"><h2 style="color:#f4f6f7;font-weight:700;margin-bottom:10px">What is real today</h2>
        <table>${rows.map(([a, k, b]) => `<tr><td>${a}</td><td><span class="k ${k}">${K[k]}</span></td><td class="muted">${b}</td></tr>`).join('')}</table></div>`);
    }, rows);
  },
};

async function main() {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('pageerror', String(e.message || e).slice(0, 200)));
  await page.addInitScript(CLOCK);
  const timesPath = path.join(BUILD, 'capture_times.json');
  const times = existsSync(timesPath) ? JSON.parse(readFileSync(timesPath, 'utf8')) : {};
  const rb = existsSync(path.join(BUILD, 'roblox.json')) ? JSON.parse(readFileSync(path.join(BUILD, 'roblox.json'), 'utf8')) : null;
  const only = ONLY ? ONLY.split(',') : null;
  for (const [i, seg] of TL.segments.entries()) {
    if (only && !only.includes(seg.id)) continue;
    const def = S[seg.id]; if (!def) { console.error('no segment', seg.id); continue; }
    await page.goto(pathToFileURL(path.join(HERE, 'web', 'shell.html')).href);
    const ctx = { page, seg, frames: {}, roblox: rb ? `${rb.studio_import_ready ? 'R15 FBX, Studio import ready' : 'R15 FBX built, a rule failed'} (${rb.summary || ''})` : null };
    const t0 = Date.now();
    await def.setup.call(def, ctx);
    const dir = path.join(BUILD, 'frames', seg.id); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const n = Math.min(Math.round(seg.duration * FPS), Number(process.env.MAXF || 1e9));
    for (let k = 0; k < n; k++) {
      const t = k / FPS;
      if (def.frame) await def.frame.call(def, ctx, t);
      for (const f of Object.values(ctx.frames)) await f.evaluate((ms) => window.__step(ms), DT);
      const sp = speechAt(seg, t);
      await page.evaluate(([labels, info, who, text, s]) => { SH.labels(labels); SH.info(info); SH.caption(who, text); SH.seg(s); },
        [def.labels || [], def.info || '', sp?.who || '', sp?.caption || sp?.text || '', `${i + 1}/${TL.segments.length} · ${seg.id}`]);
      await page.screenshot({ path: path.join(dir, String(k).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 90 });
    }
    times[seg.id] = { frames: n, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    console.log(seg.id, JSON.stringify(times[seg.id]));
    writeFileSync(timesPath, JSON.stringify(times, null, 1));
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
