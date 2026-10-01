import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captionsFromJson3, mergeCaptionLines, normalizeCaptionLines,
  playerResponseFromHtml, youtubeVideoId,
} from './youtube_learning.js';

test('YouTube IDs are accepted from normal, short and Shorts URLs', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=4'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), '');
});

test('player response parser survives braces inside quoted strings', () => {
  const html = '<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"a } brace","author":"x"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[]}}};</script>';
  assert.equal(playerResponseFromHtml(html).videoDetails.title, 'a } brace');
});

test('JSON3 captions become timed clean lines', () => {
  const rows = captionsFromJson3({events:[
    {tStartMs:1500,segs:[{utf8:' hello '},{utf8:'world'}]},
    {tStartMs:5000,segs:[{utf8:'next\nline'}]},
  ]});
  assert.deepEqual(rows,[{t:2,text:'hello world'},{t:5,text:'next line'}]);
});

test('live and public captions merge without duplicate lines', () => {
  const rows=mergeCaptionLines([{t:1,text:'one'}],[{t:1,text:'one'},{t:3,text:'two'}]);
  assert.deepEqual(rows,[{t:1,text:'one'},{t:3,text:'two'}]);
  assert.deepEqual(normalizeCaptionLines([{t:-2,text:'  hi   there '}]),[{t:0,text:'hi there'}]);
});
