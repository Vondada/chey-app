// The repository's Roblox game (roblox/che-blade-arena) passes the structural check, and the check catches broken
// Luau. The real compile and place build run in .github/workflows/che-roblox-build.yml (luau-compile and Rojo).
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRojoProject, luauBlockProblems } from '../../tools/roblox_check.mjs';

test('CHE Blade Arena: project file, paths, JSON and every script\'s blocks check out', () => {
  const out = checkRojoProject(fileURLToPath(new URL('../../roblox/che-blade-arena', import.meta.url)));
  assert.deepEqual(out.problems, []);
  assert.equal(out.scripts, 3);
});

test('the block check catches what would not compile, and ignores keywords in strings and comments', () => {
  assert.deepEqual(luauBlockProblems('local function f()\n  if x then\n    print("end")\n  end\nend\n'), []);
  assert.deepEqual(luauBlockProblems('-- function if do\n--[[ end end ]]\nlocal s = [[ repeat ]]\nrepeat x += 1 until x > 3\n'), []);
  assert.deepEqual(luauBlockProblems('for i = 1, 3 do\n  print(i)\nend\nwhile true do break end\n'), []);
  assert.deepEqual(luauBlockProblems('local t = {}\nt.end_ = 1\nobj:Do()\n'), []);
  assert.match(luauBlockProblems('function f()\n  if x then\n  end\n').join(), /line 1: 'function' is never closed/);
  assert.match(luauBlockProblems('print(1)\nend\n').join(), /line 2: 'end' without an open block/);
  assert.match(luauBlockProblems('local s = "abc\n').join(), /unterminated string/);
});
