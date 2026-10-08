import test from 'node:test';
import assert from 'node:assert/strict';
import { inferTurnCapabilities } from './cognitive_capabilities.js';

test('personal "today/tonight" chat does not trigger a web lookup; world questions still do', () => {
  for (const said of ['How are you doing today?', 'What should I eat for dinner tonight?', 'I feel tired right now']) {
    assert.equal(inferTurnCapabilities(said).includes('web_research'), false, said);
  }
  for (const said of ['What is the weather today?', 'Who won the game tonight?', 'Any news today?', 'Is Costco open right now?', 'What is the latest on the election?', 'Who is president right now?', 'Who is the CEO of OpenAI today?', 'What is the weather for me today?']) {
    assert.ok(inferTurnCapabilities(said).includes('web_research'), said);
  }
});
