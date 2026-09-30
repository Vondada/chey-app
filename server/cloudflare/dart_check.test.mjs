import test from 'node:test';
import assert from 'node:assert/strict';
import { dartStaticCheck, checkDartFiles } from './dart_check.js';

test('passes clean Dart', () => {
  const ok = "import 'package:flutter/material.dart';\nclass A extends StatelessWidget {\n  @override\n  Widget build(BuildContext c) { return const Text('hi {not a brace'); }\n}\n";
  assert.equal(dartStaticCheck('lib/a.dart', ok), null);
});

test('catches unbalanced braces (the class of error that failed the build)', () => {
  const bad = "class A {\n  void go() {\n    print('x');\n  \n}\n"; // missing one }
  assert.match(dartStaticCheck('lib/a.dart', bad), /unclosed|mismatched/);
});

test('catches unused aliased import (unused_import fails analyze)', () => {
  const bad = "import 'dart:math' as math;\nclass A { int x = 1; }\n";
  assert.match(dartStaticCheck('lib/a.dart', bad), /unused/);
  const good = "import 'dart:math' as math;\nclass A { double x = math.pi; }\n";
  assert.equal(dartStaticCheck('lib/a.dart', good), null);
});

test('catches placeholder / rest-unchanged patches', () => {
  assert.match(dartStaticCheck('lib/a.dart', 'class A {}\n// ... rest unchanged\n'), /placeholder|unchanged/i);
});

test('braces inside strings/comments do not false-trip', () => {
  const ok = "class A {\n  final s = 'a { b } c';\n  // } not real\n  void go() {}\n}\n";
  assert.equal(dartStaticCheck('lib/a.dart', ok), null);
});

test('checkDartFiles finds the first bad file', () => {
  assert.match(checkDartFiles([{ path: 'lib/a.dart', content: 'class A {}\n' }, { path: 'lib/b.dart', content: 'class B {' }]), /b\.dart/);
});
