// The owner's saved video library, answered from the stored records and the stored files themselves.
//
// Read-only: it lists CHE's existing media index (media.js listMedia) and checks each video's file where
// it lives: an R2 object, a base64 blob in storage, or the GitHub artifact the renderer archived. Nothing is
// rendered, uploaded, deleted or changed. A video is "playable" only when its MP4 file was found; a record
// with no file is "missing"; a GitHub artifact that could not be read right now is "unverified", never playable.
// Rendering and failed jobs are not library records, so they are reported as not part of the library.
import { githubVideoFile } from './github_video_renderer.js';

const MAX_CHECKS = 12;

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

// "How many pictures do you hold", "where do you keep my files": counted from the stored index, never by the model.
// Video questions stay with the video library above.
export function mediaHoldIntent(message) {
  const text = String(message || '').trim().replace(/^(?:che|chay|chey)[,:]?\s+/i, '');
  if (/\b(?:videos?|mp4s?|clips?)\b/i.test(text)) return false;
  return /\b(?:how\s+many|what|which|list|show)\b[\s\S]{0,40}\b(?:pictures?|photos?|images?|files?|documents?|pdfs?|media)\b[\s\S]{0,30}\b(?:have|hold|store|stored|saved|keep|kept)\b|\b(?:where|anywhere)\b[\s\S]{0,40}\b(?:store|keep|hold|save)\b[\s\S]{0,30}\b(?:pictures?|photos?|media|files?|documents?)\b/i.test(text);
}

export function mediaSaveReply(result) {
  if (!result.ok) return `I could not keep that file, sir: ${result.reason}. Nothing was saved.`;
  return `Saved "${result.item.title}" to my media store, sir. I now hold ${result.total} ${result.total === 1 ? 'item' : 'items'} there.`;
}

export function mediaHoldReply(items) {
  const files = (items || []).filter((item) => item?.kind === 'upload');
  if (!files.length) return 'I hold no saved pictures or files yet, sir. Send one with "save this picture" and I will keep it in my media store.';
  const shown = files.slice(0, 8).map((item) => `- ${item.title} (${String(item.created_at || '').slice(0, 10) || 'date unknown'})`);
  const more = files.length > 8 ? `${files.length - 8} more are in my media store.` : '';
  return [`I hold ${files.length} saved ${files.length === 1 ? 'file' : 'files'}, sir.`, ...shown, more].filter(Boolean).join('\n');
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
