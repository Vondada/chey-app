// Crew Creator (owner, 2026-11-07: "use the reference photos that I sent you as Che's office crew, not made up
// depictions", and "store it somewhere in the Che app so I can go back and edit them kind of like wwe created players
// on the game").
//
// One profile per crew member, kept in CHE's own private storage: the owner's reference pictures (stored once by
// SHA-256 in CHE's media store, never in the repository, read only by CHE and the owner's paired device), the look
// in words, outfit, hair, colours, accessories and voice, with a version history the owner can undo or revert. Films
// draw each member's face from the primary reference picture (film_pipeline.castStep, ownerPortrait below) and use
// the look in words for every prompt (film_cast.officeCast). The starting looks are the owner's CHE OFFICE poster
// (film_cast.CREW_LOOKS).
//
// Rules held in code:
// - Only JPEG or PNG, read from the file's own first bytes, at most 8 MB; at most MAX_REFS pictures per member.
// - Every change is a version; undo and revert make a new version, so nothing is lost. Pictures are never deleted by
//   an edit, because an earlier version may name them.
// - The pictures are fictional or generated art the owner made or chose (REFERENCE_CONSENTS.fictional); the route
//   accepts nothing on anyone else's behalf.

import { mediaStore, sha256Hex } from './che_media_store.js';
import { imageTypeOf } from './creation_studio.js';
import { CREW_BIBLE } from './film_cast.js';
import { listMedia, readBlob } from './media.js';

export const CREW = Object.freeze([
  { id: 'che', name: 'CHE', role: 'Manager / Core AI' },
  { id: 'nova', name: 'Nova', role: 'Innovation & Creation' },
  { id: 'mira', name: 'Mira', role: 'Trading & Analytics' },
  { id: 'lyra', name: 'Lyra', role: 'Music & Media' },
  { id: 'iris', name: 'Iris', role: 'Vision, Research & Insights' },
  { id: 'sage', name: 'Sage', role: 'Data & Memory' },
  { id: 'atlas', name: 'Atlas', role: 'Systems & Infrastructure' },
  { id: 'orion', name: 'Orion', role: 'Network & Navigation' },
  { id: 'knox', name: 'Knox', role: 'Security & Defense' },
  { id: 'vale', name: 'Vale', role: 'Build & Automation' },
]);
export const CREW_IDS = Object.freeze(CREW.map((c) => c.id));
export const MAX_REF_BYTES = 8 * 1024 * 1024;
export const MAX_REFS = 6;
export const MAX_HISTORY = 40;
const FIELDS = { look: 160, signature: 120, personality: 160, voice: 120, catchphrase: 80, tells: 160, hair: 80, outfit: 120 };
// The fields the film writer and the picture prompts read (film_cast.officeCast).
const ACTING = ['look', 'personality', 'tells', 'catchphrase'];
const LISTS = { colours: [6, 24], accessories: [6, 40] };
const key = (id) => `crew:profile:${id}`;
const refKey = (id, sha, type) => `crew/${id}/ref/${sha}.${type === 'image/png' ? 'png' : 'jpg'}`;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const iso = (ms) => new Date(ms).toISOString();

function blank(id) {
  const c = CREW.find((x) => x.id === id);
  const b = CREW_BIBLE[id] || {};
  return { id, name: c.name, role: c.role, look: b.look || '', signature: b.signature || '', personality: b.personality || '', voice: b.voice || '',
    catchphrase: b.catchphrase || '', tells: b.tells || '', hair: '', outfit: '', colours: [...(b.colours || [])], accessories: [], refs: [], primary: '', version: 0, history: [] };
}

const snapshot = (p) => ({ ...Object.fromEntries(Object.keys(FIELDS).map((f) => [f, p[f]])), colours: [...p.colours], accessories: [...p.accessories], refs: p.refs.map((r) => ({ ...r })), primary: p.primary });

export async function loadProfile(storage, id) {
  if (!CREW_IDS.includes(id)) return null;
  const stored = await storage.get(key(id));
  return stored ? { ...blank(id), ...stored } : blank(id);
}

async function saveVersion(storage, p, change, now) {
  p.version += 1;
  p.history = [{ n: p.version, at: iso(now), change: clip(change, 160), state: snapshot(p) }, ...p.history].slice(0, MAX_HISTORY);
  p.updated_at = iso(now);
  await storage.put(key(p.id), p);
  return p;
}

/** What the app shows: no storage keys, pictures by their SHA-256 (fetched from /api/crew/<id>/reference/<sha>). */
export function profileView(p, { history = true } = {}) {
  const primary = p.refs.find((r) => r.sha256 === p.primary) || null;
  return {
    id: p.id, name: p.name, role: p.role, ...Object.fromEntries(Object.keys(FIELDS).map((f) => [f, p[f]])), colours: p.colours, accessories: p.accessories,
    references: p.refs.map((r) => ({ sha256: r.sha256, content_type: r.content_type, bytes: r.bytes, label: r.label, at: r.at, primary: r.sha256 === p.primary })),
    primary: p.primary || null, has_reference: Boolean(primary), version: p.version, updated_at: p.updated_at || null,
    needs: primary ? '' : 'Add the reference picture',
    ...(history ? { history: p.history.map((h) => ({ n: h.n, at: h.at, change: h.change })) } : {}),
  };
}

/** The members a request names ("Nova's look", "use this for Knox"), first one wins. */
export function crewIn(text) {
  const t = String(text || '').toLowerCase();
  return CREW_IDS.find((id) => new RegExp(`\\b${id === 'che' ? '(?:che|chay|chey)' : id}\\b`).test(t)) || null;
}

/**
 * Spoken Crew Creator requests: open it, edit a member, use a library picture for a member. Null for anything else,
 * so "Nova, check the news" or a film request are left to the rest of CHE.
 */
export function crewIntent(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '').replace(/^(?:hey\s+)?(?:che|chay|chey)\s*[,:!]\s*/, '');
  if (/\b(?:open|show|go to)\s+(?:the\s+)?crew\s+creator\b/.test(t) || /^crew\s+creator$/.test(t)) return { kind: 'open', member: crewIn(t.replace(/crew\s+creator/, '')) };
  let m = /\b(?:edit|change|update|customi[sz]e|create)\s+(\w+)(?:'s|s)?\s+(?:look|appearance|character|player|profile|outfit|hair|picture|reference)\b/.exec(t);
  if (m && crewIn(m[1])) return { kind: 'edit', member: crewIn(m[1]) };
  m = /\b(?:use|make|set)\s+(?:this|that|the (?:last|latest) (?:picture|photo|image))(?:\s+(?:picture|photo|image))?\s+(?:as|for)\s+(\w+)(?:'s)?(?:\s+(?:reference|picture|face|look))?\b/.exec(t);
  if (m && crewIn(m[1])) return { kind: 'use_latest', member: crewIn(m[1]) };
  if (/\bwho (?:still )?(?:needs|has no) (?:a )?reference\b|\bcrew (?:reference )?pictures?\b/.test(t)) return { kind: 'status', member: null };
  // Numbered, the same as the screen's lists (Codex #968, voice parity). A member must be named here; while the Crew
  // Creator is open the app takes these words for the member on screen.
  const who = crewIn(t);
  if (!who) return null;
  const n = (s) => Number(NUMBERS[s] ?? s);
  m = /\b(?:use|make|set)\s+(?:\w+'s\s+)?picture\s+(\w+)\s+(?:as|for)\s+(?:the\s+)?(?:\w+'s\s+)?face\b/.exec(t);
  if (m && n(m[1]) > 0) return { kind: 'primary', member: who, n: n(m[1]) };
  m = /\b(?:remove|delete)\s+(?:\w+'s\s+)?picture\s+(\w+)\b/.exec(t);
  if (m && n(m[1]) > 0) return { kind: 'remove', member: who, n: n(m[1]) };
  m = /\b(?:go back|revert|return)\s+(?:\w+\s+)?to\s+version\s+(\w+)\b/.exec(t);
  if (m && n(m[1]) > 0) return { kind: 'revert', member: who, n: n(m[1]) };
  m = /\bread\s+(?:\w+'s\s+|the\s+)?(pictures|versions|history)\b/.exec(t);
  if (m) return { kind: m[1] === 'pictures' ? 'list_pictures' : 'list_versions', member: who };
  return null;
}

const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };

/** "Nova's pictures: 1. poster (her face). 2. Picture." */
export function speakPictures(p) {
  if (!p.refs.length) return `${p.name} has no reference pictures yet.`;
  return `${p.name}'s pictures: ${p.refs.map((r, i) => `${i + 1}. ${r.label || 'Picture'}${r.sha256 === p.primary ? ' (the face in films)' : ''}`).join('. ')}.`;
}

/** "Nova's versions, newest first: 3. Changed outfit. 2. …" (the last ten). */
export function speakVersions(p) {
  if (!p.history.length) return `${p.name} has no saved versions yet; this is the starting design.`;
  return `${p.name}'s versions, newest first: ${p.history.slice(0, 10).map((h) => `${h.n}. ${h.change}`).join(' ')}`;
}

/** "3 of 10 crew have their reference picture: CHE, Nova and Knox. Still to add: …" */
export function speakCrew(profiles) {
  const have = profiles.filter((p) => p.refs.some((r) => r.sha256 === p.primary));
  const names = (list) => list.map((p) => p.name).join(', ');
  const missing = profiles.filter((p) => !have.includes(p));
  return `${have.length} of ${profiles.length} crew have their reference picture${have.length ? `: ${names(have)}` : ''}.${missing.length ? ` Still to add: ${names(missing)}. Open the Crew Creator and tap Add the reference picture.` : ' Every film draws their faces from your pictures.'}`;
}

export async function allProfiles(storage) { return Promise.all(CREW_IDS.map((id) => loadProfile(storage, id))); }

/**
 * The owner's edits for the film cast (film_cast.officeCast): { id: { look, personality, tells, catchphrase, voice } },
 * only for members the owner has changed, so an unedited member follows the design in film_cast.CREW_BIBLE.
 */
export async function crewProfiles(storage) {
  const out = {};
  for (const p of await allProfiles(storage)) {
    if (p.version === 0) continue;
    out[p.id] = { ...Object.fromEntries([...ACTING, 'voice', 'hair', 'outfit', 'signature'].map((f) => [f, p[f]]).filter(([, v]) => v)), ...(p.colours.length ? { colours: [...p.colours] } : {}) };
  }
  return out;
}

export async function updateProfile(storage, id, body = {}, now = Date.now()) {
  const p = await loadProfile(storage, id);
  if (!p) return { ok: false, status: 404, detail: 'No such crew member.' };
  const changed = [];
  for (const [f, n] of Object.entries(FIELDS)) if (typeof body[f] === 'string' && clip(body[f], n) !== p[f]) { p[f] = clip(body[f], n); changed.push(f); }
  for (const [f, [max, n]] of Object.entries(LISTS)) {
    if (!Array.isArray(body[f])) continue;
    const list = body[f].map((x) => clip(x, n)).filter(Boolean).slice(0, max);
    if (JSON.stringify(list) !== JSON.stringify(p[f])) { p[f] = list; changed.push(f); }
  }
  if (!changed.length) return { ok: true, changed: false, profile: profileView(p), said: `Nothing changed for ${p.name}.` };
  await saveVersion(storage, p, `Changed ${changed.join(', ')}.`, now);
  return { ok: true, changed: true, profile: profileView(p), said: `Saved ${p.name}'s ${changed.join(', ')} as version ${p.version}. Every new film uses it.` };
}

function decode(text) {
  const s = String(text || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!s || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Stores one picture as a member's reference (primary by default when it is the first, or when asked). */
export async function addReference(env, storage, id, { bytes = null, image_base64 = '', label = '', primary = null } = {}, now = Date.now()) {
  const p = await loadProfile(storage, id);
  if (!p) return { ok: false, status: 404, detail: 'No such crew member.' };
  if (!bytes) {
    if (String(image_base64).length > Math.ceil(MAX_REF_BYTES / 3) * 4 + 64) return { ok: false, status: 413, detail: 'Not added: the picture is larger than 8 MB.' };
    bytes = decode(image_base64);
  }
  if (!bytes?.length) return { ok: false, status: 400, detail: 'Not added: no picture was sent, or it could not be read.' };
  if (bytes.length > MAX_REF_BYTES) return { ok: false, status: 413, detail: 'Not added: the picture is larger than 8 MB.' };
  const type = imageTypeOf(bytes);
  if (type === 'image/heic') return { ok: false, status: 415, detail: 'Not added: this picture is HEIC. The CHE app sends JPEG; send a JPEG or PNG.' };
  if (type !== 'image/jpeg' && type !== 'image/png') return { ok: false, status: 415, detail: 'Not added: only JPEG or PNG pictures are accepted.' };
  const sha = await sha256Hex(bytes);
  const known = p.refs.find((r) => r.sha256 === sha);
  if (!known && p.refs.length >= MAX_REFS) return { ok: false, status: 409, detail: `${p.name} already has ${MAX_REFS} pictures. Remove one first.` };
  if (!known) {
    const saved = await mediaStore(env, storage).put(refKey(id, sha, type), bytes, { contentType: type });
    if (!saved.ok) return { ok: false, status: 507, detail: `Not added: the picture could not be stored. ${saved.error || ''}`.trim() };
    p.refs.push({ sha256: sha, content_type: type, bytes: bytes.length, label: clip(label, 60), at: iso(now) });
  }
  const makePrimary = primary === true || (primary !== false && !p.primary);
  if (known && !(makePrimary && p.primary !== sha)) return { ok: true, changed: false, profile: profileView(p), said: `${p.name} already has that picture.` };
  if (makePrimary) p.primary = sha;
  await saveVersion(storage, p, `${known ? 'Chose' : 'Added'} a reference picture${makePrimary ? ' as the face' : ''}.`, now);
  return { ok: true, changed: true, profile: profileView(p),
    said: `${known ? 'Chose' : 'Added'} ${p.name}'s reference picture${makePrimary ? '. Every new film draws her face from it'.replace('her', ['sage', 'atlas', 'orion', 'knox', 'vale'].includes(id) ? 'his' : 'her') : ''}. Saved as version ${p.version}.` };
}

/** Uses a picture already in the media library ("use this picture for Nova": the newest picture when no id). */
export async function referenceFromMedia(env, storage, id, mediaId = '', now = Date.now()) {
  const items = await listMedia(storage);
  const item = mediaId ? items.find((x) => x.id === mediaId) : items.find((x) => /^image\/(?:jpeg|png)$/.test(x.mime_type || '') || x.type === 'image');
  if (!item) return { ok: false, status: 404, detail: mediaId ? 'That picture is not in your media library.' : 'There is no picture in your media library to use.' };
  const bytes = await readBlob(env, storage, item);
  if (!bytes?.length) return { ok: false, status: 404, detail: 'That picture\'s file is no longer stored.' };
  return addReference(env, storage, id, { bytes, label: clip(item.title || item.name || 'From the media library', 60), primary: true }, now);
}

export async function setPrimary(storage, id, sha, now = Date.now()) {
  const p = await loadProfile(storage, id);
  if (!p) return { ok: false, status: 404, detail: 'No such crew member.' };
  if (!p.refs.some((r) => r.sha256 === sha)) return { ok: false, status: 404, detail: `${p.name} has no such picture.` };
  if (p.primary === sha) return { ok: true, changed: false, profile: profileView(p), said: 'That is already the face.' };
  p.primary = sha;
  await saveVersion(storage, p, 'Chose a different reference picture as the face.', now);
  return { ok: true, changed: true, profile: profileView(p), said: `${p.name}'s face now comes from that picture. Version ${p.version}.` };
}

export async function removeReference(storage, id, sha, now = Date.now()) {
  const p = await loadProfile(storage, id);
  if (!p) return { ok: false, status: 404, detail: 'No such crew member.' };
  if (!p.refs.some((r) => r.sha256 === sha)) return { ok: false, status: 404, detail: `${p.name} has no such picture.` };
  p.refs = p.refs.filter((r) => r.sha256 !== sha);
  if (p.primary === sha) p.primary = p.refs[0]?.sha256 || '';
  await saveVersion(storage, p, 'Removed a reference picture (undo brings it back).', now);
  return { ok: true, changed: true, profile: profileView(p), said: `Removed that picture from ${p.name}. Say undo to bring it back.` };
}

/** Back to an earlier version's state, as a new version (undo = the version before the current one). */
export async function revertProfile(storage, id, version = null, now = Date.now()) {
  const p = await loadProfile(storage, id);
  if (!p) return { ok: false, status: 404, detail: 'No such crew member.' };
  const target = version == null ? p.history[1] : p.history.find((h) => h.n === Number(version));
  if (version == null && !target && p.version === 1) {
    Object.assign(p, snapshot(blank(id)));
    await saveVersion(storage, p, 'Undid the first change: back to the poster look.', now);
    return { ok: true, changed: true, profile: profileView(p), said: `${p.name} is back to the poster look. Version ${p.version}.` };
  }
  if (!target) return { ok: false, status: 404, detail: version == null ? `There is nothing to undo for ${p.name}.` : `${p.name} has no version ${version}.` };
  Object.assign(p, JSON.parse(JSON.stringify(target.state)));
  await saveVersion(storage, p, `Went back to version ${target.n}.`, now);
  return { ok: true, changed: true, profile: profileView(p), said: `${p.name} is back to version ${target.n}, saved as version ${p.version}.` };
}

/** The bytes of one stored reference (owner's device only, through the route). */
export async function referenceBytes(env, storage, id, sha) {
  const p = await loadProfile(storage, id);
  const r = p?.refs.find((x) => x.sha256 === sha) || p?.history.flatMap((h) => h.state.refs).find((x) => x.sha256 === sha);
  if (!r) return null;
  const obj = await mediaStore(env, storage).get(refKey(id, sha, r.content_type));
  return obj?.body?.length ? { body: obj.body, contentType: r.content_type } : null;
}

/**
 * A film's portrait for one character from the owner's primary reference picture, copied into the film's own files
 * (the farm and the runners may fetch only those). Null when the member has none, so the film makes one from words.
 */
export async function ownerPortrait(env, storage, media, filmId, characterId) {
  const p = await loadProfile(storage, String(characterId || '').toLowerCase());
  const r = p?.refs.find((x) => x.sha256 === p.primary);
  if (!r) return null;
  const obj = await mediaStore(env, storage).get(refKey(p.id, r.sha256, r.content_type));
  if (!obj?.body?.length) return null;
  const k = `film/${filmId}/cast/${p.id}.${r.content_type === 'image/png' ? 'png' : 'jpg'}`;
  const saved = await media.put(k, obj.body, { contentType: r.content_type });
  return saved.ok ? { done: true, key: k, content_type: r.content_type, owner_ref: true, sha256: r.sha256 } : null;
}

/**
 * The owner's routes (paired owner device only; the Worker checks that before calling):
 *   GET  /api/crew                         every member
 *   GET  /api/crew/<id>                    one member with history
 *   POST /api/crew/<id>                    { look, hair, outfit, colours, accessories, voice }
 *   POST /api/crew/<id>/reference          { image_base64, label?, primary? }
 *   POST /api/crew/<id>/reference/media    { media_id? }  (newest library picture when none)
 *   POST /api/crew/<id>/primary            { sha256 }
 *   POST /api/crew/<id>/remove-reference   { sha256 }
 *   POST /api/crew/<id>/undo               {}
 *   POST /api/crew/<id>/revert             { version }
 *   GET  /api/crew/<id>/reference/<sha256> the picture's bytes
 * Returns { status, body } or, for the picture, { status, bytes, contentType }; null for another path.
 */
/**
 * A spoken Crew Creator request (crewIntent) answered with no model call: { said, ok, meta }, where meta tells the app
 * to open the Crew Creator on the member named.
 */
export async function crewTurn(env, storage, ask) {
  const meta = { film_action: `crew_${ask.kind}`, open_screen: 'crew_creator', ...(ask.member ? { crew_member: ask.member } : {}) };
  if (ask.kind === 'use_latest') {
    const out = await referenceFromMedia(env, storage, ask.member);
    return { ok: out.ok, said: out.ok ? out.said : `${out.detail} Nothing was changed.`, meta };
  }
  if (['primary', 'remove', 'revert', 'list_pictures', 'list_versions'].includes(ask.kind)) {
    const p = await loadProfile(storage, ask.member);
    if (ask.kind === 'list_pictures') return { ok: true, meta, said: speakPictures(p) };
    if (ask.kind === 'list_versions') return { ok: true, meta, said: speakVersions(p) };
    if (ask.kind === 'revert') {
      const out = await revertProfile(storage, p.id, ask.n);
      return { ok: out.ok, meta, said: out.ok ? out.said : `${out.detail} Nothing was changed.` };
    }
    const r = p.refs[ask.n - 1];
    if (!r) return { ok: false, meta, said: `${p.name} has no picture ${ask.n}. ${speakPictures(p)}` };
    if (ask.kind === 'primary') {
      const out = await setPrimary(storage, p.id, r.sha256);
      return { ok: out.ok, meta, said: out.said };
    }
    // Removing asks first (the owner's rule): nothing is removed here; the Crew Creator opens and asks yes or no.
    const face = r.sha256 === p.primary ? ` It is ${['sage', 'atlas', 'orion', 'knox', 'vale'].includes(p.id) ? 'his' : 'her'} face in films.` : '';
    return { ok: true, meta: { ...meta, crew_confirm: { action: 'remove', n: ask.n } }, said: `Remove ${p.name}'s picture ${ask.n}?${face} Say yes to remove it, or no to keep it. Nothing is removed until you say yes.` };
  }
  if (ask.kind === 'edit') {
    const p = profileView(await loadProfile(storage, ask.member));
    return { ok: true, meta, said: `Opening ${p.name} in the Crew Creator.${p.has_reference ? '' : ` ${p.name} has no reference picture yet: tap Add the reference picture.`} You can change the look, outfit, colours, personality, voice and catchphrase, and say undo to go back.` };
  }
  const said = speakCrew(await allProfiles(storage));
  return { ok: true, meta, said: ask.kind === 'status' ? said : `Opening the Crew Creator. ${said}` };
}

/** The HTTP answer for /api/crew… (the Worker has already checked it is the owner's paired device); null when not ours. */
export async function crewResponse(env, storage, path, method, body) {
  const out = await crewRoute(env, storage, path, method, body);
  if (!out) return null;
  if (out.bytes) return new Response(out.bytes, { status: 200, headers: { 'Content-Type': out.contentType, 'Cache-Control': 'private, max-age=3600' } });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
}

export async function crewRoute(env, storage, path, method, body = {}, now = Date.now()) {
  if (path === '/api/crew' && method === 'GET') {
    const all = await allProfiles(storage);
    return { status: 200, body: { crew: all.map((p) => profileView(p, { history: false })), said: speakCrew(all) } };
  }
  const m = /^\/api\/crew\/([a-z]{2,12})(?:\/(reference(?:\/media|\/[a-f0-9]{64})?|primary|remove-reference|undo|revert))?$/.exec(path);
  if (!m) return null;
  const [, id, action = ''] = m;
  if (!CREW_IDS.includes(id)) return { status: 404, body: { detail: 'No such crew member.' } };
  const done = (out) => ({ status: out.ok ? 200 : out.status || 400, body: out });
  if (!action && method === 'GET') return { status: 200, body: { profile: profileView(await loadProfile(storage, id), { history: true }) } };
  if (action.startsWith('reference/') && action !== 'reference/media' && method === 'GET') {
    const got = await referenceBytes(env, storage, id, action.slice('reference/'.length));
    return got ? { status: 200, bytes: got.body, contentType: got.contentType } : { status: 404, body: { detail: 'No such picture.' } };
  }
  if (method !== 'POST') return { status: 405, body: { detail: 'Method not allowed.' } };
  if (!action) return done(await updateProfile(storage, id, body, now));
  if (action === 'reference') return done(await addReference(env, storage, id, { image_base64: body.image_base64, label: body.label, primary: typeof body.primary === 'boolean' ? body.primary : null }, now));
  if (action === 'reference/media') return done(await referenceFromMedia(env, storage, id, String(body.media_id || ''), now));
  if (action === 'primary') return done(await setPrimary(storage, id, String(body.sha256 || ''), now));
  if (action === 'remove-reference') return done(await removeReference(storage, id, String(body.sha256 || ''), now));
  if (action === 'undo') return done(await revertProfile(storage, id, null, now));
  if (action === 'revert') return done(await revertProfile(storage, id, body.version, now));
  return { status: 404, body: { detail: 'Not found.' } };
}
