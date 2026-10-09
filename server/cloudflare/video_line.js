// One Office pass: Atlas fills a topic, the desk writes the package, the line
// renders, upload returns a link. The board row is the return value. A missing
// tool stops the pass. Nothing is marked uploaded without a link.
//
// Duplicates: a topic is reserved before anything is rendered. A finished
// topic returns its earlier link; a topic still in progress is refused until
// the reservation is stale. A failed pass releases the reservation, so it can
// be retried.

import { scoutTopics } from './topic_scout.js';
import { createFacelessVideo } from './faceless_video.js';
import { moneyPrinterStatus } from './moneyprinter.js';
import { uploadYouTube } from './youtube_upload.js';

const RESERVATION_MS = 30 * 60 * 1000;

export function topicKey(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

// `youtube.accessToken` may be a string or an async getter. A getter is called
// right before the upload, so a long render cannot outlive the token.
export async function runVideoLine(env = {}, fetcher = fetch, youtube = {}) {
  const scout = await scoutTopics(env, fetcher);
  if (!scout.ok) return { ok: false, stage: 'scout', error: scout.error, board: [] };
  const topic = scout.topics[0];
  const uploads = youtube.uploads || {};
  const key = topicKey(topic.title);
  const earlier = uploads[key];
  if (earlier?.link) {
    return {
      ok: true,
      stage: 'uploaded',
      duplicate: true,
      board: [{ title: topic.title, source: topic.source, status: 'uploaded', link: earlier.link }],
    };
  }
  if (earlier?.status === 'rendering' && earlier.task_id) {
    // The existing MoneyPrinter render is resumable. Never start a second render
    // simply because its first status query returned pending.
    const state = await moneyPrinterStatus(env, earlier.task_id, fetcher);
    if (state.pending) return {
      ok: true, pending: true, stage: 'render', task_id: earlier.task_id,
      board: [{ title: topic.title, source: topic.source, status: 'rendering', task_id: earlier.task_id }],
    };
    if (!state.ok || !state.verified) {
      delete uploads[key];
      return { ok: false, stage: 'render', error: state.error || 'The saved render did not finish.', board: [] };
    }
    uploads[key] = { ...earlier, status: 'uploading', at: new Date().toISOString() };
    const completed = await renderAndUpload(env, fetcher, youtube, topic, state);
    if (completed.ok && !completed.pending) uploads[key] = { status: 'uploaded', link: completed.board[0].link, at: new Date().toISOString() };
    else if (!completed.pending) delete uploads[key];
    return completed;
  }
  if (earlier?.status === 'rendering' && Date.now() - Date.parse(earlier.at) < RESERVATION_MS) {
    return { ok: false, stage: 'busy', error: 'This topic is already being produced.', board: [] };
  }
  // Reservation and status transitions are persisted by the owner state.
  uploads[key] = { status: 'rendering', at: new Date().toISOString() };
  const result = await renderAndUpload(env, fetcher, youtube, topic);
  if (result.pending && result.task_id) {
    uploads[key] = { status: 'rendering', task_id: result.task_id, at: new Date().toISOString() };
  } else if (result.ok) {
    uploads[key] = { status: 'uploaded', link: result.board[0].link, at: new Date().toISOString() };
  } else {
    delete uploads[key];
  }
  return result;
}

async function renderAndUpload(env, fetcher, youtube, topic, resumed = null) {
  const rendered = resumed || await createFacelessVideo(env, { topic: topic.title, minutes: 8 }, fetcher);
  if (rendered.pending && rendered.task_id) {
    return {
      ok: true, pending: true, stage: 'render', task_id: rendered.task_id,
      board: [{ title: topic.title, source: topic.source, status: 'rendering', task_id: rendered.task_id }],
    };
  }
  if (!rendered.ok || !rendered.media_url) {
    return {
      ok: false,
      stage: 'render',
      error: rendered.error || 'No video file URL.',
      board: [{ title: topic.title, source: topic.source, status: 'script_only' }],
    };
  }
  const token = typeof youtube.accessToken === 'function' ? await youtube.accessToken() : youtube.accessToken;
  const uploaded = await uploadYouTube(
    { media_url: rendered.media_url, title: topic.title, description: topic.why },
    token || '',
    fetcher,
  );
  if (!uploaded.ok) {
    return {
      ok: false,
      stage: 'upload',
      error: uploaded.error,
      board: [{ title: topic.title, source: topic.source, status: 'rendered', media_url: rendered.media_url }],
    };
  }
  return {
    ok: true,
    stage: 'uploaded',
    board: [{
      title: topic.title,
      source: topic.source,
      status: 'uploaded',
      media_url: rendered.media_url,
      link: uploaded.link,
    }],
  };
}
