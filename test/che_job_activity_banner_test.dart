import 'package:chey/che_job_activity_banner.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('job status updates stay silent until the owner presses Read This', (tester) async {
    final spoken = <String>[];
    var polls = 0;
    cheWatchedJobId.value = null;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: CheJobActivityBanner(
          fetch: (path, body) async {
            polls++;
            return {
              'status': 'running',
              'activity': [{'text': 'Knox is reviewing the code.'}],
            };
          },
          speak: (text) async => spoken.add(text),
        ),
      ),
    ));
    await tester.pump();
    cheWatchedJobId.value = 'job-test-read';
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump();
    expect(polls, greaterThan(0));
    expect(find.text('Knox is reviewing the code.'), findsOneWidget);
    expect(spoken, isEmpty, reason: 'polled activity cannot trigger TTS automatically');
    await tester.tap(find.byTooltip('Read this job status aloud'));
    await tester.pump();
    expect(spoken, ['Knox is reviewing the code.']);
    cheWatchedJobId.value = null;
    await tester.pumpWidget(const SizedBox());
  });
}
