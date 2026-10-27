import test from 'node:test';
import assert from 'node:assert/strict';
import { modelStatusIntent } from './model_status.js';

test('model status reads remain reachable while implementation requests keep their own route', () => {
  for (const message of ['AI model status', 'CHE, read the AI model status', 'Which AI models are free?', 'Are the coding providers free?', 'Show my coding model status']) {
    assert.equal(modelStatusIntent(message), true, message);
  }
  for (const message of ['Fix the AI model status card so it excludes paused providers', 'Implement AI model status refresh in the Keys tab', 'Please update the AI model status UI', 'Can you add a button to the model status card?', 'What is the status of my 3D model?', 'Explain how an AI model works']) {
    assert.equal(modelStatusIntent(message), false, message);
  }
});
