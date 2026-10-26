import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = join(process.env.CHE_CANDIDATE_DIR, 'arithmetic.mjs');
const { evalArithmetic } = await import(pathToFileURL(file).href);

test('precedence and parentheses', () => {
  assert.equal(evalArithmetic('2+3*(4-1)'), 11);
});

test('power is right-associative', () => {
  assert.equal(evalArithmetic('2^3^2'), 512);
});

test('unary minus', () => {
  assert.equal(evalArithmetic('-3 + 5'), 2);
  assert.equal(evalArithmetic('2*-3'), -6);
});

test('decimals and division', () => {
  assert.equal(evalArithmetic('10/4'), 2.5);
  assert.equal(evalArithmetic('1.5*4'), 6);
});

test('division by zero throws RangeError', () => {
  assert.throws(() => evalArithmetic('1/0'), RangeError);
  assert.throws(() => evalArithmetic('0/0'), RangeError);
});

test('anything that is not arithmetic throws SyntaxError', () => {
  for (const text of ['process.exit(1)', 'require("fs")', 'Math.max(1,2)', '(1)(2)', '1 + alert', '', '(1+2', '1+2)', '1 2']) {
    assert.throws(() => evalArithmetic(text), SyntaxError, JSON.stringify(text));
  }
});

test('a non-string throws TypeError', () => {
  assert.throws(() => evalArithmetic(42), TypeError);
});

test('the module does not use eval or the Function constructor', () => {
  const source = readFileSync(file, 'utf8');
  assert.equal(/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/.test(source), false);
});
