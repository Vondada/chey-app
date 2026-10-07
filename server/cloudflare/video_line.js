// One Office pass: Atlas fills a topic, the desk writes the package, the line
// renders, upload returns a link. The board row is the return value. A missing
// tool stops the pass. Nothing is marked uploaded without a link.

import { scoutTopics } from './topic_scout.js';
import { createFacelessVideo } from './faceless_video.js';
import { uploadYouTube } from './youtube_upload.js';

export async function runVideoLine(env = {}, fetcher = fetch) {
  const scout = await scoutTopics(env, fetcher);
  if (!scout.ok) return { ok: false, stage: 'scout', error: scout.error, board: [] };
  const topic = scout.topics[0];
  const rendered = await createFacelessVideo(env, { topic: topic.title, minutes: 8 }, fetcher);
  if (!rendered.ok || !rendered.media_url) {
    return {
      ok: false,
      stage: 'render',
      error: rendered.error || 'No video file URL.',
      board: [{ title: topic.title, source: topic.source, status: 'script_only' }],
    };
  }
  const uploaded = await uploadYouTube(
    env,
    { media_url: rendered.media_url, title: topic.title, description: topic.why },
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
