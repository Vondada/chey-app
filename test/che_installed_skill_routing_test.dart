import 'dart:io';

import 'package:chey/che_installed_skill_intent.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

String _barText(SnackBar bar) {
  final content = bar.content as Semantics;
  return (content.child as Text).data!;
}

void main() {
  test('the receipt banner reports the actual Worker outcome, never a guess', () {
    expect(_barText(cheInstalledSkillReceiptBar(true)), 'Skill request completed.');
    expect(_barText(cheInstalledSkillReceiptBar(false)), 'Skill request could not be completed.');
  });

  testWidgets('the receipt banner announces through the screen-reader live region', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => ScaffoldMessenger.of(context).showSnackBar(cheInstalledSkillReceiptBar(true)),
            child: const Text('send'),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('send'));
    await tester.pump();
    expect(find.text('Skill request completed.'), findsOneWidget);
    final banner = tester.widget<Semantics>(
      find.ancestor(of: find.text('Skill request completed.'), matching: find.byType(Semantics)).first,
    );
    expect(banner.properties.liveRegion, isTrue);
  });

  test('skill turns reach the Worker chat path and show the receipt banner', () {
    final stream = File('lib/home_state/streaming.dart').readAsStringSync();
    expect(stream, contains("data['source'] == 'che_installed_skills'"));
    expect(stream, contains('cheInstalledSkillReceiptBar(ok)'));
    // Skill commands must not be answered from offline knowledge, cached
    // notes, remembered as reusable knowledge, or diverted into projects.
    expect(stream, contains('if (isInstalledSkillRequest(userMessage) ||'));
    expect(stream, contains('final codeRequest = !installedSkillRequest &&'));
    expect(stream, contains('if (!installedSkillRequest && !terminalChatOnly && !codeRequest'));
    expect(stream, contains('!installedSkillRequest &&'));
    expect(stream, contains('if (!installedSkillRequest && !hadAttachment && _streamMediaUrl == null)'));
  });
}
