// Visual Studio on the Worker: projects (ordinary CHE projects, type 'visual'), their edit state, templates, brand
// kits, voice edits and renders. Owner only, except the two token routes the render Action uses.

import {
  ADJUSTMENTS, FILTERS, PRESETS, TEMPLATES, TEXT_STYLES, TRANSITIONS, IMPROVEMENTS, PROVIDER_FEATURES,
  newImageDoc, newVideoDoc, editState, edit, undo, redo, saveVersion, restoreVersion, compareDocs, compact,
  smartResize, useTemplate, templateFromDoc, brandKit, applyBrand, improve, suggestions, wordsToOps,
  renderSpec, nextRenderStage, timeline, duration, applyOp, layer,
} from './visual_studio.js';
import { newRenderJob, tokenOpens, startEditRender, editRenderStatus } from './visual_render.js';
import { githubVideoFile } from './github_video_renderer.js';
import { listMedia, readBlob, generateImage, verifyMediaFile, saveOwnerFile } from './media.js';
import { decodeWav } from './music_audio.js';

const KEY = (id) => `visual:${id}`;
const TEMPLATES_KEY = 'visual_templates_v1';
const BRANDS_KEY = 'visual_brands_v1';
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function loadVisual(storage, id) { return (await storage.get(KEY(id))) || null; }
export async function saveVisual(storage, id, state) { await storage.put(KEY(id), compact(state)); }

function summary(project, state) {
  const d = state?.doc;
  return {
    id: project.id, title: project.title, kind: project.kind, preset: d?.preset, status: project.status, workspace_id: project.workspace_id || null,
    template: d?.template || null, updated_at: project.updated_at, render: project.render || null,
    duration: d?.kind === 'video' ? duration(d) : null, versions: state?.versions?.map((v) => ({ id: v.id, label: v.label, at: v.at })) || [],
    can_undo: Boolean(state?.undo?.length), can_redo: Boolean(state?.redo?.length),
  };
}

/// The full view of one project for the editor: document, timeline, suggestions and history state.
export function projectView(project, state) {
  return { project: summary(project, state), doc: state.doc, timeline: state.doc.kind === 'video' ? timeline(state.doc) : [], suggestions: suggestions(state.doc) };
}

export function catalog(personal = [], brands = []) {
  return {
    adjustments: Object.keys(ADJUSTMENTS), filters: Object.keys(FILTERS), presets: PRESETS, text_styles: Object.keys(TEXT_STYLES), transitions: TRANSITIONS,
    improvements: Object.entries(IMPROVEMENTS).map(([id, i]) => ({ id, label: i.label, video_only: Boolean(i.video) })),
    // Templates carry their built document so the app draws a real preview from it.
    templates: [...TEMPLATES.map((t) => ({ id: t.id, name: t.name, category: t.category, kind: t.kind, preset: t.preset, system: true, description: t.description || '', doc: t.build() })), ...personal.map((t) => ({ ...t, system: false }))],
    provider_features: Object.entries(PROVIDER_FEATURES).map(([id, why]) => ({ id, available: false, why })),
    brand_kits: brands,
  };
}

/// Workspace isolation for media: a file made in a client's or managed artist's project (renders are tagged with
/// their workspace) can be used only in that workspace's projects. Untagged files are the owner's own.
async function claimAssets(storage, doc, workspaceId) {
  const items = await listMedia(storage);
  const used = new Set([...(doc.clips || []).map((c) => c.asset), ...(doc.audio || []).map((a) => a.asset), ...(doc.layers || []).map((l) => l.asset), ...(doc.text || []).map((t) => t.layer.asset)].filter(Boolean));
  for (const id of used) {
    const item = items.find((i) => i.id === id);
    if (!item) return { ok: false, why: `Media ${id} is not in your library.` };
    if (item.workspace_id && item.workspace_id !== (workspaceId || null)) return { ok: false, why: 'That file belongs to another client or artist workspace and cannot be used here.' };
  }
  return { ok: true };
}

async function newProject(storage, data, { kind, preset, asset = null, template_id = null, fill = {}, title, workspace_id = null }, personal) {
  let doc;
  if (template_id) {
    const t = TEMPLATES.find((x) => x.id === template_id) || personal.find((x) => x.id === template_id);
    if (!t) return { ok: false, why: 'No such template.' };
    doc = useTemplate(t, fill);
  } else doc = kind === 'video' ? newVideoDoc({ preset: preset || 'tiktok' }) : newImageDoc({ preset: preset || 'square', asset });
  if (kind === 'video' && asset && !template_id) {
    const r = applyOp(doc, { op: 'add_clip', clip: { asset, name: 'Clip 1', duration: Number(fill.duration) || 5, kind: fill.asset_kind === 'image' ? 'image' : 'video' } });
    doc = r.doc;
  }
  if (workspace_id && !(data.music_workspaces || []).some((w) => w.id === workspace_id)) return { ok: false, why: 'No such client or artist workspace.' };
  const claim = await claimAssets(storage, doc, workspace_id);
  if (!claim.ok) return claim;
  const project = { id: `vis_${crypto.randomUUID()}`, type: 'visual', kind: doc.kind, title: clip(title, 120) || (doc.kind === 'video' ? 'New video' : 'New image'), status: 'editing', workspace_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  data.projects.unshift(project);
  const state = editState(doc);
  await saveVisual(storage, project.id, state);
  return { ok: true, project, state };
}

/// Runs a list of operations as one owner request; "undo"/"redo"/"improve"/"brand_logo"/"template_look" and
/// auto captions are handled here because they need state beyond one document.
async function runOps(ctx, project, state, ops, { brands }) {
  const said = [];
  for (const op of ops) {
    if (op.op === 'undo') { said.push(undo(state).said); continue; }
    if (op.op === 'redo') { said.push(redo(state).said); continue; }
    if (op.op === 'improve') { said.push(improve(state, op.id).said); continue; }
    if (op.op === 'brand_logo') {
      const kit = brands.find((b) => (b.workspace_id || null) === (project.workspace_id || null) && b.logo);
      if (!kit) { said.push(`There is no logo in ${project.workspace_id ? 'this client\'s' : 'your'} brand kit yet. Add one with "save my logo".`); continue; }
      const r = edit(state, { op: 'add_layer', layer: { type: 'logo', name: 'Logo', asset: kit.logo, x: op.corner === 'left' ? 0.04 : 0.83, y: op.top ? 0.04 : 0.83, w: 0.13, h: 0.13 } });
      said.push(r.ok ? 'Logo placed in the corner.' : r.error);
      continue;
    }
    if (op.op === 'template_look') {
      const t = TEMPLATES.find((x) => x.id === op.template);
      const target = t.preset;
      let doc = smartResize(state.doc, target);
      const base = t.build();
      doc.adjust = { ...doc.adjust, ...base.adjust };
      doc.filter = base.filter;
      if (doc.kind === 'image') for (const l of base.layers.filter((x) => x.type === 'text')) if (!doc.layers.some((x) => x.placeholder === l.placeholder)) doc.layers.push(l);
      state.undo.push(state.doc); state.redo = []; state.doc = doc;
      said.push(`${t.name} look: ${PRESETS[target].label}, its colour and title layout. Everything stays editable.`);
      continue;
    }
    if (op.op === 'auto_captions') { said.push((await autoCaptions(ctx, state)).said); continue; }
    const r = edit(state, op);
    said.push(r.ok ? r.said : r.error);
  }
  return said;
}

/// Auto captions from real speech recognition (Workers AI Whisper) on the voice track. If there is no voice track,
/// no recognition engine, or it fails, the reply says so and no captions are invented.
export async function autoCaptions(ctx, state) {
  const voice = state.doc.audio?.find((a) => a.role === 'voice');
  if (!voice) return { ok: false, said: 'Auto captions need a voice track. Add the voice-over or spoken audio first.' };
  if (!ctx.env?.AI || ctx.env.CHE_AI_BOUND === false) return { ok: false, said: 'Speech recognition is not connected, so I did not add captions. You can type them in Captions.' };
  const item = (await listMedia(ctx.storage)).find((i) => i.id === voice.asset);
  const bytes = item ? await readBlob(ctx.env, ctx.storage, item) : null;
  if (!bytes) return { ok: false, said: 'I could not read the voice file, so no captions were added.' };
  let result;
  try { result = await ctx.env.AI.run('@cf/openai/whisper', { audio: [...bytes] }); } catch (err) { return { ok: false, said: `Speech recognition failed (${clip(err?.message || err, 80)}). No captions were added.` }; }
  const words = Array.isArray(result?.words) ? result.words : [];
  if (!words.length) return { ok: false, said: 'Speech recognition returned no timed words, so no captions were added.' };
  const cues = [];
  for (let i = 0; i < words.length; i += 6) {
    const group = words.slice(i, i + 6);
    cues.push({ start: (voice.start || 0) + group[0].start - (voice.in || 0), end: (voice.start || 0) + group.at(-1).end - (voice.in || 0), text: group.map((w) => w.word).join(' ') });
  }
  const r = edit(state, { op: 'captions', cues, source: 'transcription' });
  return { ok: r.ok, said: r.ok ? `Added ${cues.length} captions from the voice track. Edit any of them in Captions.` : r.error };
}

/// The render state machine: start (spec + token + dispatch), and status (poll, verify, store the file).
async function startRender(ctx, project, state) {
  const spec = renderSpec(state.doc, { title: project.title });
  if (!spec.ok) return { ok: false, why: spec.why };
  const { job, token } = await newRenderJob(spec.spec);
  state.render = { ...job, spec: spec.spec };
  const started = await startEditRender(ctx.env, job, { base: ctx.origin, token }, ctx.fetcher);
  if (!started.ok) {
    state.render = { ...state.render, stage: 'failed', error: started.error, retryable: started.retryable !== false };
    project.render = { stage: 'failed', error: started.error };
    return { ok: false, why: started.error, render: project.render };
  }
  project.render = { id: job.id, stage: 'preparing', progress: 0.05 };
  return { ok: true, render: project.render };
}

const REMOVE_OPS = new Set(['delete_clip', 'delete_layer']);
export const YES_WORDS = /^(?:yes|yeah|yep|do it|go ahead|confirm|remove it|delete it)\b/i;
export const NO_WORDS = /^(?:no|nope|cancel|keep it|don't)\b/i;

async function pollRender(ctx, project, state) {
  const job = state.render;
  if (!job || ['ready', 'failed'].includes(job.stage)) return job;
  const status = await editRenderStatus(ctx.env, job, ctx.fetcher);
  let next = nextRenderStage(job, status);
  if (status.ok && status.verified) {
    // Store the verified file as an ordinary media item, then read it back before calling it ready.
    const id = crypto.randomUUID();
    const item = job.kind === 'video'
      ? { id, root_id: id, kind: 'video', mode: 'edit', title: `${project.title} (edit)`, mime_type: 'video/mp4', blob: 'github-artifact', github_artifact_id: status.artifact_id, github_filename: 'video.mp4', verified: true, width: status.verification.width, height: status.verification.height, duration_seconds: status.verification.seconds, created_at: new Date().toISOString(), visual_project: project.id, workspace_id: project.workspace_id || null }
      : { id, root_id: id, kind: 'image', mode: 'edit', title: `${project.title} (edit)`, mime_type: 'image/png', blob: 'github-artifact', github_artifact_id: status.artifact_id, github_filename: 'edited.png', verified: true, width: status.verification.width, height: status.verification.height, created_at: new Date().toISOString(), visual_project: project.id, workspace_id: project.workspace_id || null };
    // GitHub keeps artifacts for 30 days: with the R2 bucket bound, the bytes are archived there first, so a
    // finished export does not disappear. A failed archive records no finished file.
    let archived = true;
    if (ctx.env.CHE_DATA_BUCKET) {
      try {
        const bytes = await githubVideoFile(ctx.env, status.artifact_id, item.github_filename, ctx.fetcher || fetch);
        if (!bytes) throw new Error('missing');
        const key = `media/${id}.${job.kind === 'video' ? 'mp4' : 'png'}`;
        await ctx.env.CHE_DATA_BUCKET.put(key, bytes, { httpMetadata: { contentType: item.mime_type } });
        item.blob = 'r2'; item.blob_key = key;
      } catch (_) { archived = false; }
    }
    const check = archived ? await verifyMediaFile(ctx.env, ctx.storage, item) : { ok: false, reason: 'it could not be archived to the R2 bucket' };
    if (!check.ok) next = { ...job, stage: 'failed', error: `The rendered file could not be read back (${check.reason}).`, retryable: true };
    else {
      const items = await listMedia(ctx.storage);
      await ctx.storage.put('media_index', [item, ...items].slice(0, 200));
      next = { ...next, media_id: id };
    }
  }
  state.render = next;
  project.render = { id: next.id, stage: next.stage, progress: next.progress, error: next.error || null, media_id: next.media_id || null };
  return next;
}

/// Token routes for the render Action: the edit document and one source file. Nothing else is reachable with it.
export async function renderTokenRoute(ctx, path, request) {
  const m = path.match(/^\/api\/visual\/render\/(gha_[a-f0-9]{32})(?:\/asset\/([A-Za-z0-9_-]{1,80}))?$/);
  if (!m) return null;
  const token = request.headers.get('x-che-render-token') || '';
  const data = (await ctx.storage.get('che')) || {};
  for (const p of (data.projects || []).filter((x) => x.type === 'visual' && x.render?.id === m[1])) {
    const state = await loadVisual(ctx.storage, p.id);
    if (!(await tokenOpens(state?.render, token))) break;
    if (!m[2]) return new Response(JSON.stringify(state.render.spec), { headers: { 'content-type': 'application/json' } });
    if (!state.render.assets.includes(m[2])) break;
    const item = (await listMedia(ctx.storage)).find((i) => i.id === m[2]);
    const bytes = item ? await readBlob(ctx.env, ctx.storage, item) : null;
    if (!bytes) return new Response('missing', { status: 404 });
    return new Response(bytes, { headers: { 'content-type': item.mime_type || 'application/octet-stream' } });
  }
  return new Response('Not found.', { status: 404 });
}

/// GET/POST /api/visual. Returns { status, body }.
export async function visualApi(ctx, { method, body, query }) {
  const { storage, data } = ctx;
  const personal = (await storage.get(TEMPLATES_KEY)) || [];
  const brands = (await storage.get(BRANDS_KEY)) || [];
  const projects = (data.projects || []).filter((p) => p.type === 'visual');
  const byId = (id) => projects.find((p) => p.id === id) || null;
  if (method === 'GET') {
    const id = query.get('project_id');
    if (!id) {
      const list = [];
      for (const p of projects.slice(0, 50)) list.push(summary(p, await loadVisual(storage, p.id)));
      return { status: 200, body: { projects: list, ...catalog(personal, brands) } };
    }
    const p = byId(id);
    if (!p) return { status: 404, body: { detail: 'No such project.' } };
    const state = await loadVisual(storage, id);
    if (state.render && !['ready', 'failed'].includes(state.render.stage)) { await pollRender(ctx, p, state); await saveVisual(storage, id, state); ctx.dirty = true; }
    return { status: 200, body: projectView(p, state) };
  }
  const a = String(body.action || '');
  if (a === 'create') {
    const r = await newProject(storage, data, body, personal);
    if (!r.ok) return { status: 400, body: { detail: r.why } };
    ctx.dirty = true;
    return { status: 200, body: projectView(r.project, r.state) };
  }
  // A photo, video or audio file from the phone, kept in the existing media store.
  if (a === 'upload') {
    const saved = await saveOwnerFile(ctx.env, storage, { name: body.name, media_type: body.media_type, base64: body.base64 });
    return saved.ok ? { status: 200, body: { ok: true, item: saved.item } } : { status: 400, body: { detail: saved.reason } };
  }
  // Waveform peaks for the timeline, measured from the audio itself. WAV only; anything else says so.
  if (a === 'waveform') {
    const item = (await listMedia(storage)).find((i) => i.id === body.asset);
    const bytes = item ? await readBlob(ctx.env, storage, item) : null;
    if (!bytes) return { status: 404, body: { detail: 'That audio file is not in your library.' } };
    let wav = null;
    try { wav = decodeWav(bytes); } catch { wav = null; }
    if (!wav?.channels?.length) return { status: 200, body: { peaks: null, why: 'Waveforms are measured from WAV files; this file is not one.' } };
    const ch = wav.channels[0];
    const n = Math.min(240, ch.length);
    const step = Math.floor(ch.length / n);
    const peaks = Array.from({ length: n }, (_, i) => { let m = 0; for (let k = i * step; k < (i + 1) * step; k++) m = Math.max(m, Math.abs(ch[k])); return Math.round(m * 1000) / 1000; });
    return { status: 200, body: { peaks, seconds: ch.length / wav.sampleRate } };
  }
  if (a === 'brand_kit') {
    const kit = brandKit(body.kit || {});
    if (kit.workspace_id && !(data.music_workspaces || []).some((w) => w.id === kit.workspace_id)) return { status: 400, body: { detail: 'No such workspace.' } };
    const i = brands.findIndex((b) => b.id === kit.id);
    if (i >= 0) brands[i] = kit; else brands.push(kit);
    await storage.put(BRANDS_KEY, brands.slice(-30));
    return { status: 200, body: { ok: true, kit } };
  }
  const p = byId(body.project_id);
  if (!p) return { status: 404, body: { detail: 'No such project.' } };
  const state = await loadVisual(storage, p.id);
  let said = [];
  let extra = {};
  if (a === 'op' || a === 'ops') said = await runOps(ctx, p, state, a === 'op' ? [body.op] : body.ops || [], { brands });
  else if (a === 'undo') said = [undo(state).said];
  else if (a === 'redo') said = [redo(state).said];
  else if (a === 'save_version') said = [`Saved ${saveVersion(state, body.label).label}.`];
  else if (a === 'restore') said = [restoreVersion(state, body.version).said];
  else if (a === 'duplicate_version') { const v = state.versions.find((x) => x.id === body.version); if (!v) return { status: 404, body: { detail: 'No such version.' } }; const r = await newProject(storage, data, { kind: v.doc.kind, title: `${p.title} (copy)`, workspace_id: p.workspace_id }, personal); const s2 = await loadVisual(storage, r.project.id); s2.doc = JSON.parse(JSON.stringify(v.doc)); s2.versions[0].doc = s2.doc; await saveVisual(storage, r.project.id, s2); extra.project_id = r.project.id; said = ['Duplicated as a new project.']; }
  else if (a === 'compare') { const va = state.versions.find((x) => x.id === (body.a || 'v0')); const vb = body.b ? state.versions.find((x) => x.id === body.b) : { doc: state.doc }; if (!va || !vb) return { status: 404, body: { detail: 'No such version.' } }; extra = { a: va.doc, b: vb.doc, differences: compareDocs(va.doc, vb.doc) }; said = [extra.differences.length ? extra.differences.join('; ') : 'No differences.']; }
  else if (a === 'improve') said = [improve(state, body.id).said];
  else if (a === 'words' && state.pending && YES_WORDS.test(String(body.text || '').trim())) return visualApi(ctx, { method, body: { ...body, action: 'confirm_pending' }, query });
  else if (a === 'words' && state.pending && NO_WORDS.test(String(body.text || '').trim())) return visualApi(ctx, { method, body: { ...body, action: 'cancel_pending' }, query });
  else if (a === 'words') {
    const w = wordsToOps(body.text, state.doc, { selection: body.selection || null, playhead: Number(body.playhead) || 0 });
    // Removing a clip or layer by voice waits for the owner's yes (AGENTS.md: ask before deleting anything).
    // The edits before it in the same sentence run now; the removal and anything after it wait with it.
    const at = body.confirmed === true ? -1 : w.ops.findIndex((o) => REMOVE_OPS.has(o.op));
    said = await runOps(ctx, p, state, at < 0 ? w.ops : w.ops.slice(0, at), { brands });
    if (at >= 0) {
      const held = w.ops.slice(at);
      state.pending = { ops: held, understood: w.understood.slice(at), at: Date.now() };
      said.push(`${w.understood.slice(at).join(', ').replace(/^\w/, (c) => c.toUpperCase())}? Say yes to remove it. Nothing was removed yet.`);
      extra.needs_confirmation = true;
    }
    said.push(...w.unsupported);
    extra.understood = w.understood;
  } else if (a === 'confirm_pending') {
    const pending = state.pending;
    state.pending = null;
    if (!pending || Date.now() - pending.at > 10 * 60 * 1000) said = ['There is no removal waiting for your yes. Nothing was removed.'];
    else { said = await runOps(ctx, p, state, pending.ops, { brands }); extra.understood = pending.understood; }
  } else if (a === 'cancel_pending') {
    said = [state.pending ? 'Cancelled. Nothing was removed.' : 'Nothing was waiting.'];
    state.pending = null;
  } else if (a === 'variants') {
    const made = [];
    for (const preset of (body.presets || []).filter((x) => PRESETS[x])) {
      const r = await newProject(storage, data, { kind: state.doc.kind, title: `${p.title} · ${PRESETS[preset].label}`, workspace_id: p.workspace_id }, personal);
      const s2 = await loadVisual(storage, r.project.id);
      s2.doc = smartResize(state.doc, preset);
      s2.versions[0].doc = s2.doc;
      r.project.parent_id = p.id;
      await saveVisual(storage, r.project.id, s2);
      made.push({ id: r.project.id, preset, title: r.project.title });
    }
    extra.variants = made;
    said = [made.length ? `Made ${made.map((m) => PRESETS[m.preset].label).join(', ')}: text, logos and subjects were repositioned for each size, not stretched.` : 'No known sizes were named.'];
  } else if (a === 'save_template') {
    const t = templateFromDoc(state.doc, { name: body.name || p.title, category: body.category });
    personal.push(t);
    await storage.put(TEMPLATES_KEY, personal.slice(-30));
    extra.template = { id: t.id, name: t.name };
    said = [`Saved "${t.name}" as a template.`];
  } else if (a === 'apply_brand') {
    const kit = brands.find((b) => b.id === body.kit_id) || brands.find((b) => (b.workspace_id || null) === (p.workspace_id || null));
    if (!kit) return { status: 400, body: { detail: 'No brand kit for this workspace yet.' } };
    if ((kit.workspace_id || null) !== (p.workspace_id || null)) return { status: 400, body: { detail: 'That brand kit belongs to a different workspace.' } };
    state.undo.push(state.doc); state.redo = []; state.doc = applyBrand(state.doc, kit);
    said = [`Applied ${kit.name}.`];
  } else if (a === 'render') {
    const r = await startRender(ctx, p, state);
    said = [r.ok ? 'Rendering started: preparing.' : `Render did not start: ${r.why}`];
    extra.render = r.render;
  } else if (a === 'retry_render') {
    const r = await startRender(ctx, p, state);
    said = [r.ok ? 'Render restarted.' : `Render did not start: ${r.why}`];
  } else return { status: 400, body: { detail: 'Unknown action.' } };
  const claim = await claimAssets(storage, state.doc, p.workspace_id || null);
  if (!claim.ok) return { status: 400, body: { detail: claim.why } };
  p.updated_at = new Date().toISOString();
  await saveVisual(storage, p.id, state);
  ctx.dirty = true;
  return { status: 200, body: { ok: true, said: said.filter(Boolean).join(' '), ...extra, ...projectView(p, state) } };
}

/// Creates the project behind "make me a promo video for this song": the song's own audio file (never copied),
/// its artwork or a newly generated cover, the music-promo template, and the platform's size.
export async function songPromo(ctx, { title, platform = 'tiktok', kind = 'promo' }) {
  const songs = (ctx.data.projects || []).filter((p) => p.type === 'music');
  const song = title ? songs.find((s) => s.title.toLowerCase() === String(title).toLowerCase()) || songs.find((s) => s.title.toLowerCase().includes(String(title).toLowerCase())) : songs[0];
  if (!song) return { ok: false, said: 'There is no song in Music yet. Add one first.' };
  const items = await listMedia(ctx.storage);
  const audio = [...(song.music?.versions || [])].reverse().find((v) => v.media_id && items.some((i) => i.id === v.media_id));
  if (!audio) return { ok: false, said: `${song.title} has no uploaded audio file yet, so I can't put it in a video. Upload the master to the song first.` };
  let artwork = items.find((i) => i.id === song.music?.artwork_media_id) || null;
  if (!artwork) {
    const gen = await generateImage(ctx.env, ctx.storage, { prompt: `Album cover art for a song called "${song.title}", no text`, title: `${song.title} cover` }, ctx.fetcher);
    artwork = gen?.item || null;
    if (!artwork) return { ok: false, said: `${song.title} has no artwork and I could not generate a cover (${gen?.detail || 'no image engine'}). Add artwork to continue.` };
  }
  const template = kind === 'visualizer' ? 'visualizer-wave' : kind === 'beat' ? 'beat-preview' : 'music-promo';
  const label = kind === 'visualizer' ? 'visualizer' : kind === 'beat' ? 'beat preview' : 'promo';
  // A beat preview keeps its template's square size unless a platform was named.
  const preset = { tiktok: 'tiktok', reel: 'reels', short: 'shorts', youtube: 'youtube' }[platform] || (kind === 'beat' ? TEMPLATES.find((t) => t.id === template).preset : 'tiktok');
  const r = await newProject(ctx.storage, ctx.data, { kind: 'video', template_id: template, title: `${song.title} ${label}`, workspace_id: song.music?.workspace_id || null, fill: { artwork: artwork.id, title: song.title, artist: song.music?.metadata?.artist || '', song: { media_id: audio.media_id, project_id: song.id, title: song.title } } }, []);
  if (!r.ok) return { ok: false, said: r.why };
  if (preset !== TEMPLATES.find((t) => t.id === template).preset) { r.state.doc = smartResize(r.state.doc, preset); r.state.versions[0].doc = r.state.doc; await saveVisual(ctx.storage, r.project.id, r.state); }
  ctx.dirty = true;
  return { ok: true, project: r.project, said: `Made "${r.project.title}": ${PRESETS[preset].label}, ${artwork.mode === 'thumbnail' ? 'artwork' : 'cover art'}, the title, and ${song.title} as the audio. Say "edit" to open the timeline, or "render it" to make the MP4.` };
}

/// "Use my Album Drop template but make it blue": a new project from a system or saved template, then the tweak
/// as ordinary edits. The template's placeholders stay empty until the owner fills them.
export async function projectFromTemplateName(ctx, { name, tweak = null }) {
  const personal = (await ctx.storage.get(TEMPLATES_KEY)) || [];
  const want = String(name || '').toLowerCase().trim();
  const all = [...personal, ...TEMPLATES];
  const t = all.find((x) => x.name.toLowerCase() === want) || all.find((x) => x.name.toLowerCase().includes(want) || want.includes(x.name.toLowerCase()));
  if (!t) return { ok: false, said: `I found no template called ${name}. Say "open templates" to hear the list.` };
  const r = await newProject(ctx.storage, ctx.data, { template_id: t.id, title: t.name }, personal);
  if (!r.ok) return { ok: false, said: r.why };
  ctx.dirty = true;
  let said = [`Made a new project from ${t.name}.`];
  if (tweak) {
    const w = wordsToOps(tweak, r.state.doc, {});
    const safe = w.ops.filter((o) => !REMOVE_OPS.has(o.op));
    said = said.concat(await runOps(ctx, r.project, r.state, safe, { brands: [] }), w.unsupported);
    await saveVisual(ctx.storage, r.project.id, r.state);
  }
  return { ok: true, project: r.project, said: said.join(' ') };
}

/// Text layer from words, for the "add text" quick action.
export const textLayer = (value, style = 'social') => layer({ type: 'text', name: 'Text', value, style, x: 0.08, y: 0.4, w: 0.84, h: 0.1 });
