// The owner's saved video library, answered from the stored records and the stored files themselves.
//
// Read-only: it lists CHE's existing media index (media.js listMedia) and checks each video's file where
// it lives: an R2 object, a base64 blob in storage, or the GitHub artifact the renderer archived. Nothing is
// rendered, uploaded, deleted or changed. A video is "playable" only when its MP4 file was found; a record
// with no file is "missing"; a GitHub artifact that could not be read right now is "unverified", never playable.
// Rendering and failed jobs are not library records, so they are reported as not part of the library.
import { githubVideoFile } from './github_video_renderer.js';
import { verifyMediaFile } from './media.js';

const MAX_CHECKS = 12;
// How many stored files one answer reads back. Each read is a storage read, so the rest are marked not checked.
const INVENTORY_CHECKS = 60;

// "Open my video library", "show my saved videos", "how many videos are playable", "CHE, open Creator Studio and
// show my latest video". Generation ("make a video about…") is not a library request and goes elsewhere.
export function mediaLibraryIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey)[,:]?\s+/i, '');
  if (!text) return false;
  if (/\b(?:make|create|generate|render|produce|build|film|shoot)\b[\s\S]{0,40}\b(?:video|mp4|clip|short|reel)\b/i.test(text)) return false;
  // Render progress, status and the renderer's last verified job belong to the video status route, not the library.
  if (/\bverified\b/i.test(text)) return false;
  if (/\b(?:is|was|are|has|have)\s+(?:(?:it|that|this|my|the|the\s+latest|the\s+new)\s+)*(?:video\s+)?(?:ready|done|finished|complete|rendered|failed|expired)\b|\b(?:status|progress|still\s+(?:rendering|running)|how\s+(?:is|far)|stuck|rendering|render\s+(?:job|status)|in\s+progress)\b/i.test(text)) return false;
  const videoWord = /\b(?:videos?|mp4s?|movies?|clips?|renders?|video\s+library|creator\s+studio)\b/i.test(text);
  if (!videoWord) return false;
  return /\b(?:my\s+(?:saved\s+|finished\s+|latest\s+)?videos?|video\s+library|saved\s+(?:videos?|mp4s?|files?)|mp4s?|latest\s+(?:video|one)|how\s+many\s+videos?|playable|my\s+videos|open\s+(?:my\s+)?(?:video|videos|library)|show\s+(?:me\s+)?(?:my\s+|the\s+|all\s+)?(?:saved\s+|finished\s+)?videos?|list\s+(?:my\s+|the\s+)?videos?|which\s+videos?)\b/i.test(text);
}

export function wantsLatestVideo(message) {
  return /\b(?:latest|newest|most\s+recent|last)\s+(?:video|one|clip)\b/i.test(String(message || ''));
}

function isVideoRecord(item) {
  return item?.kind === 'video' || item?.mode === 'video' || item?.mime_type === 'video/mp4';
}

async function checkFile(env, storage, item, fetcher) {
  if (item.blob === 'r2' && item.blob_key) {
    const object = env.CHE_DATA_BUCKET ? await env.CHE_DATA_BUCKET.head(item.blob_key).catch(() => null) : null;
    if (object && Number(object.size) > 0) return { status: 'playable', storage: 'r2', bytes: Number(object.size) };
    return { status: 'missing', storage: 'r2', reason: 'The R2 file is not there.' };
  }
  if (item.blob === 'do') {
    const data = await storage.get(`media:${item.id}`).catch(() => null);
    return data ? { status: 'playable', storage: 'storage' } : { status: 'missing', storage: 'storage', reason: 'The stored file is not there.' };
  }
  if (item.blob === 'github-artifact' || item.github_artifact_id) {
    const bytes = await githubVideoFile(env, item.github_artifact_id, item.github_filename || 'video.mp4', fetcher).catch(() => null);
    if (!bytes) return { status: 'unverified', storage: 'github-artifact', reason: 'GitHub did not return the file just now (it may have expired after 30 days).' };
    // An MP4 carries the box type "ftyp" at bytes 4 to 8.
    return new TextDecoder().decode(bytes.slice(4, 8)) === 'ftyp'
      ? { status: 'playable', storage: 'github-artifact', bytes: bytes.length }
      : { status: 'missing', storage: 'github-artifact', reason: 'The archived file is not an MP4.' };
  }
  return { status: 'missing', storage: 'unknown', reason: 'The record names no file.' };
}

/** The library: every saved video record, its file checked (at most MAX_CHECKS GitHub reads per answer). */
export async function mediaLibraryReport(env, storage, items, { fetcher = fetch } = {}) {
  const videos = (items || []).filter(isVideoRecord).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  let checks = 0;
  const rows = [];
  for (const item of videos) {
    const canCheckGithub = item.blob === 'github-artifact' || item.github_artifact_id;
    let file;
    if (canCheckGithub && checks >= MAX_CHECKS) file = { status: 'unverified', storage: 'github-artifact', reason: 'Not checked in this answer; ask again to check it.' };
    else {
      if (canCheckGithub) checks += 1;
      file = await checkFile(env, storage, item, fetcher);
    }
    rows.push({ id: item.id, title: String(item.title || 'Untitled video').slice(0, 80), created_at: item.created_at || '', ...file });
  }
  const count = (status) => rows.filter((row) => row.status === status).length;
  return { total: rows.length, playable: count('playable'), unverified: count('unverified'), missing: count('missing'), videos: rows };
}

// "Save this picture", "keep this file" with a file attached: CHE keeps it in her media store (media.js saveOwnerFile).
export function mediaSaveIntent(message, hasAttachment) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey)[,:]?\s+/i, '');
  return hasAttachment && /\b(?:save|store|keep|hold|archive)\b/i.test(text);
}

// The longest message that can be a store question. The owner's own media requests are well under this.
const MAX_STORE_REQUEST = 500;
const PICTURE_WORD = /\b(?:pictures?|photos?|images?|pics?|pngs?|jpe?gs?|webps?)\b/i;
const VIDEO_WORD = /\b(?:videos?|mp4s?|movies?|clips?)\b/i;
// Words that make a question about the picture/file store, not about the video library.
const STORE_WORD = /\b(?:pictures?|photos?|images?|pics?|pngs?|jpe?gs?|webps?|files?|uploads?|attachments?|documents?|pdfs?|media)\b/i;
// What turns a store word into a request to list the store: a listing, count, check, or "do you still have".
// Words that make a store question about pictures even when a video is also named.
const OTHER_STORE_WORD = /\b(?:pictures?|photos?|images?|pics?|pngs?|jpe?gs?|webps?)\b/i;
// Google and mail questions are answered by their own routes, never by the store.
const SERVICE_WORD = /\b(?:google|drive|gmail|e-?mails?|calendar|youtube|inbox)\b/i;
// A store question is about what CHE holds for the owner: saved, stored, kept, still there, or "my" pictures and files.
const STORE_OWNER = /\b(?:saved|stored|store|hold|held|keep|kept|have|got|uploaded|uploads?|generated|still|media\s+store|my\s+(?:latest\s+|last\s+|newest\s+|saved\s+|stored\s+)?(?:pictures?|photos?|images?|pngs?|jpe?gs?|webps?|files?|media|uploads?|attachments?|documents?|pdfs?))\b/i;
const INVENTORY_CUE = /\b(?:how\s+many|list|every|all\s+(?:of\s+)?(?:my|the|your)|which|verify|confirm|check|inventory|still\s+(?:saved|stored|there|kept|held)|do\s+you\s+(?:have|hold|keep|store)|have\s+you\s+(?:got|saved|kept|stored)|where\s+(?:do\s+you|are|is)|anywhere|show\s+(?:me\s+)?(?:my|all|every|saved|stored)|what\s+(?:pictures?|photos?|images?|files?|media|uploads?|documents?|pdfs?|items?|creations?|pngs?)|(?:my|the|your)\s+(?:saved|stored|latest|last|newest))\b/i;

// "How many pictures do you hold", "list every saved media item by its ID", "verify my latest PNG is still stored":
// the full store is listed from the stored records, each file checked, never answered by the model. A video-only
// question stays with the video library above.
export function mediaHoldIntent(message) {
  const text = cleanText(message);
  if (text.length > MAX_STORE_REQUEST) return false; // a long instruction (a study plan, a document) is never a store question
  if (!STORE_WORD.test(text) || SERVICE_WORD.test(text) || !STORE_OWNER.test(text)) return false;
  if (VIDEO_WORD.test(text) && !OTHER_STORE_WORD.test(text)) return false;
  return INVENTORY_CUE.test(text) || /\b(?:where|anywhere)\b[\s\S]{0,40}\b(?:store|keep|hold|save)\b/i.test(text);
}

// "Show me the last picture": the newest saved picture, returned as an image the chat can display.
export function mediaShowLatestIntent(message) {
  const text = cleanText(message);
  if (text.length > MAX_STORE_REQUEST) return false;
  // A request to open it in the Creation Room is answered by mediaOpenIntent, never by this one-picture reply.
  return /\b(?:show|open|display|send|see|view|pull\s+up|bring\s+up)\b/i.test(text)
    && /\b(?:last|latest|newest|most\s+recent)\b/i.test(text)
    && PICTURE_WORD.test(text) && !VIDEO_WORD.test(text) && !CREATION_ROOM_WORD.test(text);
}

// "Open this same picture in my Creation Room", "open media cb442323-… in Creation Room". The picture is the one the
// message names by ID, or else the one the chat showed last (the client sends its media ID as last_media_id). Null when
// the message is not that request, so the existing store and library routes still see it.
const OPEN_WORD = /\b(?:open|show|view|display|bring\s+up|pull\s+up|put)\b/i;
const CREATION_ROOM_WORD = /\b(?:creation\s+room|create\s+room|creations?|creative\s+room)\b/i;
const MEDIA_ID_WORD = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const OPENABLE_NOUN = /\b(?:pictures?|photos?|images?|pics?|videos?|clips?|media|creations?|files?|one)\b/i;
const DEICTIC_WORD = /\b(?:this|that|same|it|it's)\b/i;
export function mediaOpenIntent(message) {
  const text = cleanText(message);
  if (text.length > MAX_STORE_REQUEST || !OPEN_WORD.test(text) || !CREATION_ROOM_WORD.test(text)) return null;
  const id = (MEDIA_ID_WORD.exec(text) || [])[0]?.toLowerCase() || '';
  const latest = /\b(?:latest|last|newest|most\s+recent)\b/i.test(text);
  if (!id && !(OPENABLE_NOUN.test(text) && (DEICTIC_WORD.test(text) || latest))) return null;
  return { id, latest: !id && latest };
}

function openable(row) {
  return Boolean(row) && (row.kind === 'video' || /^image\//.test(String(row.mime_type || '')));
}

/** The saved picture or video with this ID, from the stored records, or null. An owner upload that is a picture opens too. */
export function mediaOpenRow(items, id) {
  const row = (items || []).find((item) => String(item?.id || '').toLowerCase() === id);
  return openable(row) ? row : null;
}

/** The newest saved picture or video, for "open my latest picture in my Creation Room". */
export function mediaLatestOpenRow(items) {
  return [...(items || [])]
    .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')))
    .find(openable) || null;
}

export function mediaOpenReply(row, { origin = '' } = {}) {
  const kind = row.kind === 'video' ? 'video' : 'image';
  const title = String(row.title || (kind === 'video' ? 'Video' : 'Picture')).slice(0, 80);
  return {
    text: `Opening "${title}" (ID ${row.id}) in your Creation Room, sir.`,
    media_id: row.id,
    media_type: kind,
    media_url: `${origin}/api/media/${row.id}/${kind === 'video' ? 'video' : 'image'}`,
  };
}

export function mediaOpenMissingReply(id) {
  return id
    ? `I hold no saved picture or video with ID ${id}, sir, so there is nothing to open in your Creation Room.`
    : 'I don\'t know which picture you mean, sir. Give me its media ID, or ask me about the picture first.';
}

export function wantsLatestMedia(message) {
  return /\b(?:latest|last|newest|most\s+recent)\b/i.test(cleanText(message));
}

export function wantsPng(message) {
  return /\bpngs?\b/i.test(cleanText(message));
}

function cleanText(message) {
  return String(message || '').trim().replace(/^(?:che|chay|chey)[,:]?\s+/i, '');
}

export function mediaSaveReply(result) {
  if (!result.ok) return `I could not keep that file, sir: ${result.reason}. Nothing was saved.`;
  return `Saved "${result.item.title}" to my media store, sir. I now hold ${result.total} ${result.total === 1 ? 'item' : 'items'} there.`;
}

// Every record of the store, newest first. `keep` narrows the list (for example to PNG files) before any file is read.
export function mediaRows(items, keep = () => true) {
  return [...(items || [])]
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .filter(keep)
    .map((item) => ({
      id: String(item.id || ''),
      title: String(item.title || 'Untitled').slice(0, 80),
      mime_type: String(item.mime_type || ''),
      created_at: String(item.created_at || ''),
      category: item.kind === 'upload' ? 'upload' : 'generated',
      item,
    }));
}

// Reads each file back (at most `limit`); the rest are marked not checked, so nothing unverified is called retrievable.
export async function verifyMediaRows(env, storage, rows, limit = INVENTORY_CHECKS) {
  let checked = 0;
  for (const row of rows) {
    if (checked >= limit) {
      row.verify = { ok: false, status: 'not_checked', reason: 'not checked in this answer, because of the limit' };
      continue;
    }
    checked += 1;
    row.verify = await verifyMediaFile(env, storage, row.item);
  }
  return rows;
}

function stateOf(row) {
  const verify = row.verify || { status: 'not_checked', reason: 'not checked' };
  if (verify.ok) return 'stored, bytes verified';
  if (verify.status === 'not_checked') return 'not checked in this answer';
  if (verify.status === 'unverified') return `could not be verified just now: ${verify.reason}`;
  return `not retrievable: ${verify.reason}`;
}

function dateOf(row) {
  return row.created_at.slice(0, 10) || 'date not recorded';
}

// The full store: total records, owner uploads apart from generated ones, and every record with its real ID,
// filename, type, creation date and whether its stored bytes were verified.
export function mediaInventoryReply(rows, { png = false } = {}) {
  if (!rows.length) return 'I hold no saved media records, sir. My media store is empty. Send a picture with "save this picture" and I will keep it there.';
  const uploads = rows.filter((row) => row.category === 'upload').length;
  const generated = rows.length - uploads;
  const verified = rows.filter((row) => row.verify?.ok).length;
  const shown = png ? rows.filter((row) => row.mime_type === 'image/png') : rows;
  const head = png
    ? `I hold ${shown.length} saved PNG ${shown.length === 1 ? 'file' : 'files'}, sir. ${shown.filter((row) => row.verify?.ok).length} of them ${shown.filter((row) => row.verify?.ok).length === 1 ? 'is' : 'are'} retrievable.`
    : `I hold ${rows.length} saved media ${rows.length === 1 ? 'record' : 'records'}, sir: ${uploads} owner ${uploads === 1 ? 'upload' : 'uploads'} and ${generated} generated. ${verified} of ${rows.length} can be retrieved: the stored bytes were read back and checked.`;
  if (!shown.length) return head;
  const lines = shown.map((row) => `- "${row.title}" · ID ${row.id} · ${row.mime_type || 'type not recorded'} · created ${dateOf(row)} · ${row.category} · ${stateOf(row)}`);
  return [head, ...lines].join('\n');
}

// Which saved records a question is about: PNG files, pictures, or (when neither is named) any record.
export function mediaKeepFor(message) {
  if (wantsPng(message)) return (item) => item.mime_type === 'image/png';
  if (PICTURE_WORD.test(cleanText(message))) return (item) => /^image\//.test(String(item.mime_type || ''));
  return () => true;
}

// "Show me the last picture" and "verify my latest PNG": one record, with its verified state.
export function mediaLatestReply(row, { png = false } = {}) {
  const label = png ? 'PNG' : row?.mime_type?.startsWith('image/') ? 'picture' : 'record';
  if (!row) return `I hold no saved ${png ? 'PNG files' : 'pictures or files'}, sir, so there is nothing to show.`;
  if (row.verify?.ok) return `Your latest ${label} is "${row.title}", sir: ID ${row.id}, ${row.mime_type}, created ${dateOf(row)}, ${row.category}. Its stored bytes are present and verified.`;
  return `Your latest ${label} is "${row.title}" (ID ${row.id}), sir, and it is not retrievable: ${row.verify?.reason || 'the bytes were not checked'}.`;
}

// The owner's store question, answered from the stored records. A list request gets every record; a "latest" part
// gets that record with its bytes read back. A latest-only question gets just that record, never a list.
export async function mediaHoldAnswer(env, storage, items, message) {
  const text = cleanText(message);
  const png = wantsPng(message);
  const latest = wantsLatestMedia(message);
  const listAsked = /\b(?:list|every|all|which|how\s+many|inventory|what\s+(?:do|have)\s+you)\b/i.test(text);
  const rows = mediaRows(items);
  const keep = mediaKeepFor(message);
  const latestRow = latest ? rows.find((row) => keep(row.item)) || null : null;
  if (latest && !listAsked) {
    if (latestRow) latestRow.verify = await verifyMediaFile(env, storage, latestRow.item);
    return { text: mediaLatestReply(latestRow, { png }), total: rows.length, uploads: rows.filter((row) => row.category === 'upload').length, verified: latestRow?.verify?.ok ? 1 : 0 };
  }
  await verifyMediaRows(env, storage, rows);
  if (latestRow && !latestRow.verify) latestRow.verify = await verifyMediaFile(env, storage, latestRow.item);
  const answer = mediaInventoryReply(rows);
  return {
    text: latest ? `${answer}\n${mediaLatestReply(latestRow, { png })}` : answer,
    total: rows.length,
    uploads: rows.filter((row) => row.category === 'upload').length,
    verified: rows.filter((row) => row.verify?.ok).length,
  };
}

export function mediaShowReply(row) {
  if (row.verify?.ok) return `Here is your latest picture, sir: "${row.title}" (ID ${row.id}, ${row.mime_type}, created ${dateOf(row)}). I read its stored bytes back before showing it.`;
  return `I could not show your latest picture, sir: "${row.title}" (ID ${row.id}) is not retrievable: ${row.verify?.reason || 'its bytes were not checked'}.`;
}

export function mediaLibraryReply(report, { latest = false } = {}) {
  if (!report.total) {
    return 'You have no saved videos, sir. None is playable, because none has been rendered and saved yet. Rendering and failed jobs are not library records; ask for the video status to see them.';
  }
  const lines = [];
  lines.push(`You have ${report.total} saved ${report.total === 1 ? 'video' : 'videos'}, sir. ${report.playable} ${report.playable === 1 ? 'is' : 'are'} playable: ${report.playable === 1 ? 'its' : 'their'} MP4 file was found.`);
  if (report.unverified) lines.push(`${report.unverified} could not be checked right now, so I cannot say they are playable.`);
  if (report.missing) lines.push(`${report.missing} ${report.missing === 1 ? 'record has' : 'records have'} no file: ${report.missing === 1 ? 'it cannot' : 'they cannot'} be played.`);
  const shown = latest ? report.videos.slice(0, 1) : report.videos.slice(0, 8);
  for (const row of shown) {
    const state = row.status === 'playable' ? 'playable' : row.status === 'unverified' ? 'not checked' : 'missing file';
    lines.push(`- ${row.title} (${row.created_at.slice(0, 10) || 'date unknown'}): ${state}${row.status === 'missing' || row.status === 'unverified' ? `: ${row.reason}` : ''}`);
  }
  if (!latest && report.videos.length > shown.length) lines.push(`${report.videos.length - shown.length} more are in My Videos.`);
  if (latest && report.videos[0]?.status !== 'playable') lines.push('The latest one is not playable, so I did not pick it as playable.');
  return lines.join('\n');
}
