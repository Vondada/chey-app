import assert from 'node:assert/strict';
import {
  classifyRobloxCatalog,
  parseRobloxPhrase,
  robloxProjectTypeFor,
  looksLikeRobloxWork,
} from './roblox_studio.js';

assert.equal(classifyRobloxCatalog('laser blaster weapon'), 'weapon');
assert.equal(classifyRobloxCatalog('UGC hoodie clothing'), 'clothing');
assert.equal(classifyRobloxCatalog('VIP game pass'), 'pass');
assert.equal(classifyRobloxCatalog('obby experience'), 'game');
assert.equal(classifyRobloxCatalog('roblox game with a sword shop'), 'game');
assert.equal(robloxProjectTypeFor('sword weapon'), 'roblox_weapon');
assert.ok(looksLikeRobloxWork('build a roblox game'));

const phrase = parseRobloxPhrase(
  'Build a Roblox game for an obby with a sword shop',
  'build a roblox game for an obby with a sword shop',
);
assert.equal(phrase?.type, 'robloxJob');
assert.equal(phrase?.catalog, 'game');
assert.equal(phrase?.owner_confirm_required, true);

const hire = parseRobloxPhrase(
  'Hire Knox for Roblox Luau combat system',
  'hire knox for roblox luau combat system',
);
assert.equal(hire?.type, 'robloxJob');

const clothes = parseRobloxPhrase(
  'Create Roblox clothing UGC hoodie pack',
  'create roblox clothing ugc hoodie pack',
);
assert.equal(clothes?.type, 'robloxJob');
assert.equal(clothes?.catalog, 'clothing');

console.log('roblox_studio.test.mjs ok');
