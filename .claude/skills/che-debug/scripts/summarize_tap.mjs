#!/usr/bin/env node
// Reads node:test TAP output on stdin and prints only what a reviewer needs:
// each failing test with the first lines of its diagnostic, then the totals.
// A passing run of the whole Worker suite becomes one line.
import { readFileSync } from 'node:fs';

export function summarizeTap(raw, { context = 14 } = {}) {
  const lines = String(raw).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*not ok \d+ /.test(lines[i])) continue;
    // A parent test also reports "not ok" for its failing subtest; keep the leaf.
    const block = [];
    for (let j = i + 1; j < lines.length && block.length < context; j += 1) {
      if (/^\s*(?:not )?ok \d+ /.test(lines[j]) || /^\s*# Subtest:/.test(lines[j])) break;
      if (/^\s*(?:---|\.\.\.|duration_ms:|type: 'test'|location:)/.test(lines[j])) continue;
      if (lines[j].trim()) block.push(lines[j].replace(/^\s{2,}/, '    '));
    }
    out.push(lines[i].trim(), ...block);
  }
  const total = (name) => Number((raw.match(new RegExp(`^# ${name} (\\d+)`, 'm')) || [])[1] || 0);
  const pass = total('pass');
  const failed = total('fail');
  const tests = total('tests');
  out.push(`${failed ? 'FAIL' : 'PASS'}: ${pass}/${tests} passed${failed ? `, ${failed} failed` : ''}${total('skipped') ? `, ${total('skipped')} skipped` : ''}${total('todo') ? `, ${total('todo')} todo` : ''}`);
  if (!tests) out.push('No TAP totals found: the test run did not finish (see the raw output).');
  return { text: out.join('\n'), pass, failed, tests };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = summarizeTap(readFileSync(0, 'utf8'));
  console.log(result.text);
  process.exit(result.failed || !result.tests ? 1 : 0);
}
