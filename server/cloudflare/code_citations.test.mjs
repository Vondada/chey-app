// Owner, 2026-11-06: CHE's screen audit (certification run 42179558904) cited code that is not in CHE's files. A
// finding reaches the owner only when its quoted code, code names and line numbers are in the source she read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { citationsOf, citedAnswer, verifyCitations } from './code_citations.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p) => ({ path: p, excerpt: readFileSync(`${ROOT}${p}`, 'utf8').slice(0, 1600) });
const FILES = ['lib/rooms/che_trading_room.dart', 'lib/rooms/che_trading_chart.dart', 'lib/agents/che_office_conversation_screen.dart'].map(read);

// Three of the six findings, as CHE answered them.
const JAY = `Based on the provided source code, here are the potential issues:

1. **che_trading_room.dart** (Line 142): The \`CheTradingRoom\` widget does not handle the case when the \`che_desk\` object is null.
\`\`\`dart
CheTradingRoom(
  che_desk: _desk,
)
\`\`\`
2. **che_trading_chart.dart** (Line 65): The \`ChartBar\` widget does not handle the case when the \`feed\` object is null.
\`\`\`dart
ChartBar(
  feed: _feed,
)
\`\`\`
3. **che_office_conversation_screen.dart** (Line 96): The widget does not handle a null conversation.
\`\`\`dart
CheOfficeConversationScreen(
  conversation: conversation ?? CheOfficeConversation(),
)
\`\`\`
These are potential issues based on the provided source code.`;

test('a finding is read for its quoted code, code names and file:line', () => {
  const c = citationsOf('2. **che_trading_chart.dart** (Line 65): the `ChartBar` widget ```dart\nChartBar(feed: _feed)\n```');
  assert.deepEqual(c.lines, [{ path: 'che_trading_chart.dart', line: 65 }]);
  assert.ok(c.names.includes('ChartBar') && c.names.includes('_feed'));
});

test("CHE's invented findings are all removed and the owner is told none could be verified", () => {
  const v = verifyCitations(JAY, FILES);
  assert.equal(v.kept, 0);
  assert.equal(v.removed.length, 3);
  assert.ok(v.removed.some((r) => r.why.some((w) => /che_desk/.test(w))), 'the invented field is named as the reason');
  const said = citedAnswer(JAY, FILES);
  assert.match(said, /^I could not verify any finding against the source I read, sir, so I am not giving you one\./);
  assert.match(said, /Nothing was changed and no job was started\./);
  assert.doesNotMatch(said, /che_desk: _desk/);
});

test('a finding that quotes real code at its real line is kept, and only the invented one is removed', () => {
  const lines = FILES[0].excerpt.split('\n');
  const at = lines.findIndex((l) => /^import /.test(l)) + 1;
  const real = `1. che_trading_room.dart (Line ${at}) imports \`${lines[at - 1].trim()}\`.\n2. **che_trading_chart.dart** (Line 65): \`ChartBar(feed: _feed)\` is not null-checked.`;
  const v = verifyCitations(real, FILES);
  assert.equal(v.kept, 1);
  assert.equal(v.removed.length, 1);
  const said = citedAnswer(real, FILES);
  assert.match(said, /^1\. che_trading_room\.dart/);
  assert.match(said, /I removed 1 finding that cited code I did not read/);
  assert.doesNotMatch(said, /ChartBar\(feed/);
});

test('plain prose with no code citation passes untouched', () => {
  const prose = 'The coding runtime waits on a runner that may never claim the job. Repair: record a claim deadline.';
  assert.equal(citedAnswer(prose, FILES), prose);
});

// Codex review of #944: a backticked file name, a proposed repair and a file:line citation.
const EX = [{ path: 'lib/example.dart', excerpt: "import 'x.dart';\nclass ExampleWidget {}\nvoid build() {}" }];

test('a backticked file name is checked against the files read, not searched for inside them', () => {
  assert.equal(verifyCitations('1. In `lib/example.dart`, `ExampleWidget` defines the widget.', EX).kept, 1);
  const v = verifyCitations('1. In `lib/missing.dart`, `ExampleWidget` defines the widget.', EX);
  assert.equal(v.kept, 0);
  assert.match(v.removed[0].why.join(' '), /lib\/missing\.dart, which was not read/);
});

test('code proposed as a repair is not required to exist already; the quoted code before it still is', () => {
  assert.equal(verifyCitations('1. example.dart line 2: `ExampleWidget` has no guard. Repair: add `if (input == null) return;`', EX).kept, 1);
  assert.equal(verifyCitations('1. example.dart line 2: `ExampleWidget` should be `ExampleWidget.safe(input)`.', EX).kept, 1);
  assert.equal(verifyCitations('1. example.dart line 2: `che_desk: _desk` is null. Repair: add `if (input == null) return;`', EX).kept, 0);
});

test('file:line citations are checked, backticked or not', () => {
  for (const t of ['1. example.dart:999: `ExampleWidget` defines the widget.', '1. `example.dart:999`: `ExampleWidget` defines the widget.']) {
    const v = verifyCitations(t, EX);
    assert.equal(v.kept, 0, t);
    assert.match(v.removed[0].why.join(' '), /line 999, past what was read/);
  }
  assert.equal(verifyCitations('1. `lib/example.dart:2`: `ExampleWidget` defines the widget.', EX).kept, 1);
  assert.deepEqual(citationsOf('see `lib/example.dart:2`').lines, [{ path: 'lib/example.dart', line: 2 }]);
});

// Live run 42245819995: "(`lib/agents/che_office_conversation_screen.dart`, line 71)" kept a finding whose line was
// never read, because the comma between the file and "line" hid the line number.
test('a file, a comma and "line N" is a line citation too', () => {
  for (const form of ['(`lib/example.dart`, line 99)', 'lib/example.dart, line 99', 'lib/example.dart at line 99', '**lib/example.dart** — line 99', 'lib/example.dart on line 99']) {
    assert.deepEqual(citationsOf(`1. ${form}: \`ExampleWidget\``).lines.find((l) => l.line != null), { path: 'lib/example.dart', line: 99 }, form);
    assert.equal(verifyCitations(`1. ${form}: \`ExampleWidget\` is not refreshed.`, EX).kept, 0, form);
  }
  assert.equal(verifyCitations('1. The `ExampleWidget` class (`lib/example.dart`, line 2) has no guard.', EX).kept, 1);
});
