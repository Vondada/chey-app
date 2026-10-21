// A visual, a video, a thumbnail or a post is described only when a record of the request made or published it
// (owner, 2026-10-21). Concept and copy are not visuals.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adRequest, adStatusLines, assetTruthReply } from './asset_truth.js';

test('an ad request is recognised; a question about ads is not a request to make them', () => {
  assert.equal(adRequest('Make 3 ads for my bakery with visuals and schedule them.'), true);
  assert.equal(adRequest('Create ad concepts and captions for the spring menu.'), true);
  assert.equal(adRequest('What was the bakery ad about?'), false);
});

test('a reply that claims visuals were generated is cut when none were made', () => {
  const out = assetTruthReply('I generated 3 visuals for the campaign. The ad copy is ready.', { made: 0 });
  assert.doesNotMatch(out.text, /visuals/);
  assert.equal(out.text, 'The ad copy is ready.');
  assert.equal(out.removed.length, 1);
});

test('"here are your ads" presents ads that do not exist as visuals, so it is cut too', () => {
  const out = assetTruthReply('Here are your ads. The captions are below.', { made: 0 });
  assert.equal(out.text, 'The captions are below.');
});

test('a claim of a scheduled or published post is cut when nothing was published', () => {
  const out = assetTruthReply('The posts are scheduled for Monday. Captions are below.', { made: 0, published: 0 });
  assert.equal(out.text, 'Captions are below.');
});

test('when a record shows the visuals were made, the sentence stays', () => {
  const text = 'I generated 3 visuals for the campaign.';
  assert.equal(assetTruthReply(text, { made: 3 }).text, text);
});

test('the status an ad request ends with says each fact in its own short sentence', () => {
  assert.equal(adStatusLines({ copy: true, made: 0, published: 0 }),
    'I wrote the ad copy. I generated 0 visuals, so no ad image or video exists yet. I did not schedule or publish anything.');
  assert.equal(adStatusLines({ copy: true, made: 3, published: 0 }),
    'I wrote the ad copy. I generated 3 visuals. I did not schedule or publish anything.');
});

test('an honest denial is kept: "Nothing was scheduled" and "I did not publish" are not claims', () => {
  const text = 'Nothing was scheduled, sir: I have no record of doing that. I did not publish anything.';
  assert.equal(assetTruthReply(text, { made: 0, published: 0 }).text, text);
});
