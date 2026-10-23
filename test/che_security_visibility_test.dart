// Security Room visibility: every count opens exactly its entries, search filters them, findings open their
// evidence, coverage never reads as all-clear, Knox (the Office Security Chief) has one tappable record, the
// physical page claims no connection, and nothing overflows from a small iPhone to a desktop.
// Fixture: test/fixtures/security_visibility.json, produced by the Worker's own security_visibility.js and
// security_chief.js (regenerate with the same inputs if their shapes change).
import 'dart:convert';
import 'dart:io';

import 'package:chey/agents/che_agent_runtime.dart';
import 'package:chey/che_ui/che_screen_awareness.dart';
import 'package:chey/security/che_security_visibility.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final Map<String, dynamic> fixture = jsonDecode(File('test/fixtures/security_visibility.json').readAsStringSync()) as Map<String, dynamic>;
Map<String, dynamic> get visibility => Map<String, dynamic>.from(fixture['visibility'] as Map);
Map<String, dynamic> get chief => Map<String, dynamic>.from(fixture['chief'] as Map);
List<Map<String, dynamic>> get categories => [for (final c in visibility['categories'] as List) Map<String, dynamic>.from(c as Map)];

Widget host(Widget child) => MaterialApp(theme: ThemeData.dark(), home: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(16), child: child))));

void main() {
  testWidgets('each count opens a list with exactly that many entries', (tester) async {
    // Tall enough that the lazy list builds every entry.
    tester.view.physicalSize = const Size(800, 6000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    for (final c in categories) {
      expect((c['items'] as List).length, c['count'], reason: '${c['id']}: the count is the list length');
      await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheSecurityCategoryScreen(key: ValueKey(c['id']), visibility: visibility, initial: '${c['id']}')));
      await tester.pumpAndSettle();
      expect(find.text('${c['title']} (${c['count']})'), findsOneWidget);
      expect(find.byType(CheSecurityItemTile, skipOffstage: false), findsNWidgets(c['count'] as int), reason: '${c['id']}');
    }
  });

  testWidgets('tapping a count calls back with its category', (tester) async {
    String? opened;
    await tester.pumpWidget(host(CheSecurityCounts(visibility: visibility, onOpen: (id) => opened = id)));
    final agents = categories.firstWhere((c) => c['id'] == 'agents');
    await tester.tap(find.bySemanticsLabel('Agents, ${agents['count']}. Opens the list.'));
    expect(opened, 'agents');
  });

  testWidgets('search narrows the list and category chips switch it', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheSecurityCategoryScreen(visibility: visibility, initial: 'agents')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Knox');
    await tester.pumpAndSettle();
    expect(find.byType(CheSecurityItemTile), findsOneWidget);
    expect(find.textContaining('Showing 1 of'), findsOneWidget);
    final threats = categories.firstWhere((c) => c['id'] == 'threats');
    await tester.enterText(find.byType(TextField), '');
    await tester.tap(find.widgetWithText(ChoiceChip, 'Threats ${threats['count']}'));
    await tester.pumpAndSettle();
    expect(find.text('Threats (${threats['count']})'), findsOneWidget);
  });

  testWidgets('a finding opens its evidence, severity and recommended action', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheSecurityCategoryScreen(visibility: visibility, initial: 'threats')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Unknown token used'));
    await tester.pumpAndSettle();
    expect(find.text('Evidence'), findsOneWidget);
    expect(find.textContaining('affected resource: api'), findsOneWidget);
    expect(find.textContaining('Recommended:'), findsOneWidget);
    expect(find.text('HIGH'), findsWidgets);
  });

  testWidgets('coverage names what was not checked and is never an all-clear', (tester) async {
    await tester.pumpWidget(host(CheSecurityCoverageCard(coverage: Map<String, dynamic>.from(visibility['coverage'] as Map))));
    expect(find.textContaining('not checked or not visible'), findsOneWidget);
    expect(find.textContaining('Password vault'), findsOneWidget);
    expect(find.text('NOT CHECKED'), findsWidgets);
    expect(find.text('UNKNOWN'), findsWidgets);
  });

  testWidgets('Knox: one identity, the chain of command, configured apart from verified, and a tap opens the same desk', (tester) async {
    String? opened;
    await tester.pumpWidget(host(CheSecurityChiefCard(chief: chief, onOpenAgent: (n) => opened = n)));
    expect(find.text('Knox'), findsOneWidget);
    expect(find.textContaining('Office Security Chief · reports to CHE'), findsOneWidget);
    expect(find.text('Owner  →  CHE  →  Knox  →  Specialists'), findsOneWidget);
    expect(find.textContaining('configured'), findsOneWidget);
    expect(find.textContaining('verified working'), findsOneWidget);
    await tester.tap(find.text('Knox'));
    expect(opened, 'Knox');
  });

  testWidgets('physical security claims no connection and labels every platform Unsupported', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheSecurityPhysicalScreen(physical: Map<String, dynamic>.from(visibility['physical'] as Map))));
    await tester.pumpAndSettle();
    expect(find.text('No supported integrations yet'), findsOneWidget);
    expect(find.text('Verified connected'), findsNothing);
    expect(find.text('Unsupported'), findsWidgets);
  });

  for (final size in const [Size(375, 667), Size(393, 852), Size(430, 932), Size(852, 393), Size(820, 1180), Size(1440, 900)]) {
    testWidgets('no overflow at ${size.width.toInt()}×${size.height.toInt()}', (tester) async {
      tester.view.physicalSize = size * 3;
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(host(Column(children: [
        CheSecurityChiefCard(chief: chief, onOpenAgent: (_) {}),
        CheSecurityCounts(visibility: visibility, onOpen: (_) {}),
        CheSecurityCoverageCard(coverage: Map<String, dynamic>.from(visibility['coverage'] as Map)),
      ])));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheSecurityCategoryScreen(visibility: visibility, initial: 'permissions')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }

  test('Office desk and Security Room carry the same Knox identity from the shared roster', () {
    final profile = CheAgentProfile.fromJson({'id': 'a-knox', 'name': 'Knox', 'role': 'Engineering / Codex jobs', 'department': {'id': 'security', 'title': 'Office Security Chief'}});
    expect(profile.agent.name, chief['name']);
    expect(profile.departmentTitle, chief['title']);
    expect(chief['agent_id'], 'a-knox');
  });

  testWidgets('review fix: every category, search and entry is reachable by voice, and the page is described', (tester) async {
    tester.view.physicalSize = const Size(800, 6000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(theme: ThemeData.dark(), home: CheSecurityCategoryScreen(visibility: visibility, initial: 'agents')));
    await tester.pumpAndSettle();
    final voice = CheSecurityRoomVoice.handler!;
    for (final c in categories) {
      for (final said in ['show ${'${c['title']}'.toLowerCase()}', 'CHE, open the ${c['id']} list.']) {
        final reply = await voice(said);
        await tester.pumpAndSettle();
        expect(reply, startsWith('${c['title']}'), reason: said);
        expect(find.text('${c['title']} (${c['count']})'), findsOneWidget, reason: said);
        expect(find.byType(CheSecurityItemTile), findsNWidgets(c['count'] as int), reason: said);
      }
    }
    expect(CheScreenAwareness.describe(), contains('You are on Security'));
    await voice('show agents');
    await tester.pumpAndSettle();
    final found = await voice('search for knox');
    await tester.pumpAndSettle();
    expect(found, contains('Agents, 1 matching knox: 1. Knox'));
    expect(find.byType(CheSecurityItemTile), findsOneWidget);
    expect(await voice('read number 1'), startsWith('Knox, AI agent.'));
    expect(await voice('read number 9'), contains('There is no number 9'));
    await voice('clear search');
    expect(await voice('tell me a joke'), isNull, reason: 'ordinary chat is not caught');
    await tester.pumpWidget(const SizedBox());
    expect(CheSecurityRoomVoice.handler, isNull, reason: 'the handler leaves with the page');
  });
}
