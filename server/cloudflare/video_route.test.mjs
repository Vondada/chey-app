import assert from 'node:assert/strict';
import test from 'node:test';
import { handleVideoLine } from './video_route.js';

test('Office YouTube uploads require a separate explicit approval and never start by default', async () => {
  const request = new Request('https://che.example/api/video/line', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ office: true, topic: 'Three facts about space' }),
  });
  const response = await handleVideoLine(request, {}, { office: true, topic: 'Three facts about space' });
  const result = await response.json();
  assert.equal(response.status, 428);
  assert.equal(result.stage, 'approval');
  assert.equal(result.requires_owner_confirmation, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /approval/i);
});
