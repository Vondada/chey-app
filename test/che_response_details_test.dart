import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chey/che_ui/che_response_details.dart';

Map<String, dynamic> modelReply({bool fallback = false}) => {
      'soul': {
        'version': 3,
        'hash': 'a1b2c3d4',
        'soul_loaded': true,
        'soul_applied': true,
        'route': 'model',
        'reason': '',
      },
      'served_by': {'model': '@cf/meta/llama-test', 'route': fallback ? 'quality' : 'fast', 'fallback': fallback},
    };

void main() {
  test('a model reply lists the Soul version, that it shaped the reply, and the model that answered', () {
    final lines = cheResponseDetailLines(cheResponseDetails({'type': 'done', ...modelReply()})!);
    expect(lines, contains('Soul on record: version 3, fingerprint a1b2c3d4.'));
    expect(lines, contains('The Soul shaped this reply. Its manner came from version 3.'));
    expect(lines, contains('Answered by the model @cf/meta/llama-test.'));
    expect(lines, contains('This was the first engine chosen; no fallback was used.'));
  });

  test('a fallback engine is named as a fallback, not as the first choice', () {
    final lines = cheResponseDetailLines(cheResponseDetails({'type': 'done', ...modelReply(fallback: true)})!);
    expect(lines, contains('This was a fallback engine, used after the first choice did not answer.'));
  });

  test('a handler reply says the Soul did not shape it and that no model answered', () {
    final lines = cheResponseDetailLines(cheResponseDetails({
      'type': 'done',
      'source': 'che_trading_live',
      'soul': {
        'version': 3,
        'hash': 'a1b2c3d4',
        'soul_loaded': true,
        'soul_applied': false,
        'route': 'handler',
        'reason': 'no model call produced this reply',
      },
    })!);
    expect(lines.any((l) => l.startsWith('The Soul did not shape this reply: no model call')), isTrue);
    expect(lines, contains('Answered by the CHE handler che_trading_live, with no model call.'));
    expect(lines.any((l) => l.contains('shaped this reply. Its manner')), isFalse, reason: 'never claims applied for a handler');
  });

  test('a cached reply is marked as bypassing the Soul', () {
    final lines = cheResponseDetailLines(cheResponseDetails({
      'type': 'done',
      'soul': {'version': 3, 'hash': 'a1b2c3d4', 'soul_loaded': true, 'soul_applied': false, 'route': 'cache', 'reason': 'this reply came from the answer cache'},
    })!);
    expect(lines.first, startsWith('Soul on record'));
    expect(lines.any((l) => l.startsWith('The Soul did not shape this reply: it came from the answer cache.')), isTrue);
    expect(lines, contains('Answered from CHE\'s saved answers, with no model call.'));
  });

  test('a done event with no provenance gives no details', () {
    expect(cheResponseDetails({'type': 'done'}), isNull);
    expect(cheResponseDetails('not a map'), isNull);
  });

  test('details survive the message store round trip', () {
    final details = cheResponseDetails({'type': 'done', ...modelReply()})!;
    expect(cheResponseDetailsFromJson(cheResponseDetailsJson(details)), details);
    expect(cheResponseDetailsFromJson('{broken'), isNull);
    expect(cheResponseDetailsFromJson(null), isNull);
  });

  testWidgets('the details sheet opens from a labelled button and shows the lines', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: CheResponseDetailsButton(details: cheResponseDetails({'type': 'done', ...modelReply()})!)),
    ));
    expect(find.bySemanticsLabel('Response details: personality'), findsOneWidget);
    await tester.tap(find.text('Response details'));
    await tester.pumpAndSettle();
    expect(find.text('Personality'), findsOneWidget);
    expect(find.text('Answered by the model @cf/meta/llama-test.'), findsOneWidget);
    expect(find.text('Close'), findsOneWidget);
  });
}
