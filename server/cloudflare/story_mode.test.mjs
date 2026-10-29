// Story mode: CHE tells a scene as dialogue, not as a formal narrator or a report. These tests keep it that way:
// the classifier, the rules every story turn carries, and the Worker's wiring that drops the summary lines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isStoryTurn, storyMode, storyModeBlock } from './story_mode.js';

test('a request for a story is story mode', () => {
  assert.equal(storyMode('tell me a story about my neighbor who got caught cheating'), 'story');
  assert.equal(storyMode('write a short story where two cousins fight over a house'), 'story');
  assert.equal(storyMode('continue the story, what does Dee say next?'), 'story');
});

test('playing a character with the owner is roleplay', () => {
  assert.equal(storyMode("let's roleplay, you're my cousin Dee"), 'roleplay');
  assert.equal(storyMode('pretend you are my ex and I just walked in'), 'roleplay');
  assert.equal(storyMode('be my neighbor, I am knocking on your door'), 'roleplay');
});

test('chatting about drama is drama talk, short and natural', () => {
  assert.equal(storyMode('Did you hear Keisha caught her man with the neighbor on Maple Street? The tea is hot'), 'drama_talk');
  assert.equal(storyMode('my cousin got betrayed by her best friend and now everybody knows the secret'), 'drama_talk');
});

test('factual, technical and action asks keep the ordinary rules, even with drama words', () => {
  assert.equal(storyMode('research the news on the trial of my neighbor'), 'ordinary');
  assert.equal(storyMode('rotate the API token and the secret key'), 'ordinary');
  assert.equal(storyMode('send sarah the report about the budget'), 'ordinary');
  assert.equal(storyMode('what is 2 plus 2'), 'ordinary');
  assert.equal(storyMode(''), 'ordinary');
});

test('only story, roleplay and drama talk are story turns', () => {
  assert.equal(isStoryTurn('story'), true);
  assert.equal(isStoryTurn('roleplay'), true);
  assert.equal(isStoryTurn('drama_talk'), true);
  assert.equal(isStoryTurn('ordinary'), false);
  assert.equal(storyModeBlock('ordinary'), '');
});

test('every story block carries the dialogue, no-lesson and no-report rules', () => {
  for (const mode of ['story', 'roleplay', 'drama_talk']) {
    const block = storyModeBlock(mode);
    assert.match(block, /DIALOGUE FIRST/, mode);
    assert.match(block, /NO SPEECHES, NO LESSONS/, mode);
    assert.match(block, /no moral/, mode);
    assert.match(block, /NO REPORT FORMAT/, mode);
    assert.match(block, /no bullet lists/, mode);
    assert.match(block, /CONTINUITY/, mode);
    assert.match(block, /REAL PEOPLE, NOT TYPES/, mode);
  }
});

test('the block makes the mode specific and guards against caricature and forced slang', () => {
  assert.match(storyModeBlock('story'), /MODE: STORY/);
  assert.match(storyModeBlock('roleplay'), /first person/);
  assert.match(storyModeBlock('drama_talk'), /one to three short sentences/);
  const block = storyModeBlock('story');
  assert.match(block, /No forced slang, no caricature/);
  assert.match(block, /no assumptions about race, class or place from a name/);
  assert.doesNotMatch(block, /use slang|speak in slang/i);
});

test('the Worker adds the story block and drops the summary lines in story turns only', () => {
  const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(worker, /import \{ isStoryTurn, storyMode, storyModeBlock \} from '\.\/story_mode\.js';/);
  assert.match(worker, /const turnMode = storyMode\(rawMessage\);/);
  assert.match(worker, /storyModeBlock\(turnMode\),/);
  assert.match(worker, /const madeAcrossRooms = storyTurn \? ''/);
  assert.match(worker, /const atlasNote = ownerDevice && !memoryRoute && !storyTurn/);
  assert.match(worker, /storyTurn \? '' : 'NEXT STEP:/);
});
