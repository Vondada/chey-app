import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capabilityPromptLine,
  inferTurnCapabilities,
  runtimeCapabilityRegistry,
} from './cognitive_capabilities.js';

test('server infers obvious capabilities without phone magic phrases', () => {
  assert.deepEqual(
    new Set(inferTurnCapabilities('Please fact check the latest information about this company.')),
    new Set(['web_research', 'cross_reference']),
  );
  const image = inferTurnCapabilities('Make me a vivid picture of a futuristic office.');
  assert.ok(image.includes('image_generation'));
  assert.ok(image.includes('rendering'));
  const video = inferTurnCapabilities('Create a video clip from this idea.');
  assert.ok(video.includes('video_generation'));
  const media = inferTurnCapabilities('Tell me what happens in this.', { media_type: 'video' });
  assert.ok(media.includes('multimodal'));
});

test('runtime registry reports only capabilities with a real configured path', () => {
  const registry = runtimeCapabilityRegistry(
    {
      AI: { run: async () => ({}) },
      GEMINI_API_KEY: 'gemini-test',
      CHE_PGVECTOR_REST_URL: 'https://example.supabase.co/rest/v1',
      CHE_PGVECTOR_TOKEN: 'pg-test',
      CHE_ALLOW_PAID_MEDIA: '1',
    },
    {},
  );
  const byId = Object.fromEntries(registry.capabilities.map((item) => [item.id, item]));
  assert.equal(registry.automatic_selection, true);
  assert.equal(byId.image_generation.available, true);
  assert.equal(byId.video_generation.available, true);
  assert.equal(byId.video_understanding.available, true);
  assert.equal(byId.semantic_memory.available, true);
  assert.equal(byId.sms.available, false);
  assert.equal(byId.stripe.available, false);
  assert.equal(byId.provider_routing.available, true);
  assert.equal(byId.model_discovery.available, true);
});

test('paid media providers stay unavailable until the owner opts in', () => {
  const registry = runtimeCapabilityRegistry({ GEMINI_API_KEY: 'gemini-test' }, {});
  const byId = Object.fromEntries(registry.capabilities.map((item) => [item.id, item]));
  assert.equal(byId.video_generation.available, false);
  assert.match(byId.video_generation.limitations, /owner approval|owner-enabled|paid/i);
});

test('capability prompt tells CHE to choose tools automatically', () => {
  const registry = runtimeCapabilityRegistry({ AI: { run: async () => ({}) } }, {});
  const line = capabilityPromptLine(registry);
  assert.match(line, /choose the appropriate available capability automatically/i);
  assert.match(line, /do not require the owner to know tool or model names/i);
});
