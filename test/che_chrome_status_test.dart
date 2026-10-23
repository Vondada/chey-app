// Chrome status (owner, 2026-10-23): status colours and motion follow real state only. Queued, paused, blocked and
// finished never animate; Reduce Motion is honoured; an idle indicator schedules no frames; a success never turns red
// over time. The goldens show every tone at normal and large text in the HUD look.
import 'dart:io';

import 'package:chey/che_ui/che_chrome_status.dart';
import 'package:chey/che_ui/che_hud.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _font(String family, String path) async {
  final file = File(path);
  if (!file.existsSync()) return;
  final bytes = file.readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

Widget _host(Widget child, {bool reduceMotion = false, double textScale = 1.0}) => MaterialApp(
      debugShowCheckedModeBanner: false,
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: reduceMotion, textScaler: TextScaler.linear(textScale)),
        child: Scaffold(backgroundColor: CheHud.navyTop, body: Center(child: Padding(padding: const EdgeInsets.all(16), child: child))),
      ),
    );

void main() {
  setUpAll(() async {
    final fonts = '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts';
    await _font('Roboto', '$fonts/Roboto-Regular.ttf');
    await _font('Roboto', '$fonts/Roboto-Bold.ttf');
    await _font('Menlo', '$fonts/Roboto-Regular.ttf');
    await _font('MaterialIcons', '$fonts/MaterialIcons-Regular.otf');
  });

  group('real state maps to tone and activity', () {
    test('coding jobs: queued and waiting are not running; outcomes keep their own tone', () {
      expect(cheCodingStatus('running'), (CheStatusTone.active, CheActivity.running));
      expect(cheCodingStatus('queued').$2, CheActivity.queued);
      expect(cheCodingStatus('waiting_capacity').$2, CheActivity.queued);
      expect(cheCodingStatus('blocked'), (CheStatusTone.failure, CheActivity.blocked));
      expect(cheCodingStatus('interrupted').$2, CheActivity.paused);
      expect(cheCodingStatus('merged'), (CheStatusTone.success, CheActivity.done));
      expect(cheCodingStatus('tests_failed'), (CheStatusTone.failure, CheActivity.failed));
      expect(cheCodingStatus('something new').$2, CheActivity.idle, reason: 'unknown states never animate');
    });
    test('renders and Office tasks', () {
      expect(cheRenderStatus('rendering').$2, CheActivity.running);
      expect(cheRenderStatus('ready'), (CheStatusTone.success, CheActivity.done));
      expect(cheRenderStatus('failed').$1, CheStatusTone.failure);
      expect(cheTaskStatus('complete', verified: true).$1, CheStatusTone.success);
      expect(cheTaskStatus('complete', verified: false).$1, CheStatusTone.warning, reason: 'unverified work is never green');
      expect(cheTaskStatus('queued', verified: false).$2, CheActivity.queued);
    });
    test('severity runs green → amber → red', () {
      expect(cheSeverityColor(0), CheStatusPalette.success.base);
      expect(cheSeverityColor(0.5), CheStatusPalette.warning.base);
      expect(cheSeverityColor(1), CheStatusPalette.failure.base);
    });
  });

  group('motion follows real state', () {
    testWidgets('a running pill animates; every non-running activity schedules no frames', (tester) async {
      await tester.pumpWidget(_host(const CheStatusPill(label: 'Working', tone: CheStatusTone.active, activity: CheActivity.running)));
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);
      for (final a in CheActivity.values.where((a) => a != CheActivity.running)) {
        await tester.pumpWidget(_host(CheStatusPill(label: a.name, tone: CheStatusTone.active, activity: a)));
        await tester.pump();
        expect(tester.binding.hasScheduledFrame, isFalse, reason: '$a must stay still');
      }
    });

    testWidgets('a success stays green while time passes', (tester) async {
      await tester.pumpWidget(_host(const CheStatusPill(label: 'Verified', tone: CheStatusTone.success, activity: CheActivity.done)));
      await tester.pump(const Duration(minutes: 10));
      final icon = tester.widget<Icon>(find.byType(Icon));
      expect(icon.color, CheStatusPalette.success.base);
      expect(icon.icon, Icons.check_circle_rounded);
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('Reduce Motion: running indicators are steady', (tester) async {
      await tester.pumpWidget(_host(
        const Column(mainAxisSize: MainAxisSize.min, children: [
          CheStatusPill(label: 'Working', tone: CheStatusTone.active, activity: CheActivity.running),
          CheThinkingIndicator(label: 'Thinking… 1.2s'),
          SizedBox(width: 200, child: CheChromeProgress()),
        ]),
        reduceMotion: true,
      ));
      await tester.pump();
      expect(tester.binding.hasScheduledFrame, isFalse);
      expect(find.text('Thinking… 1.2s'), findsOneWidget);
    });

    testWidgets('thinking stops when the work stops', (tester) async {
      await tester.pumpWidget(_host(const CheThinkingIndicator(label: 'Thinking…')));
      await tester.pump(const Duration(milliseconds: 200));
      expect(tester.binding.hasScheduledFrame, isTrue);
      await tester.pumpWidget(_host(const CheThinkingIndicator(label: 'Thinking…', active: false)));
      await tester.pump();
      expect(tester.binding.hasScheduledFrame, isFalse);
    });
  });

  group('honest progress', () {
    testWidgets('a percentage only when measured', (tester) async {
      await tester.pumpWidget(_host(const SizedBox(width: 240, child: CheChromeProgress(value: 0.42, label: 'Render'))));
      await tester.pump();
      expect(find.text('42%'), findsOneWidget);
      expect(tester.getSemantics(find.byType(CheChromeProgress)).label, contains('42%'));
      expect(tester.binding.hasScheduledFrame, isFalse, reason: 'measured progress does not loop');
      await tester.pumpWidget(_host(const SizedBox(width: 240, child: CheChromeProgress(label: 'Render'))));
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.textContaining('%'), findsNothing);
      expect(tester.getSemantics(find.byType(CheChromeProgress)).label, contains('no measured percentage'));
    });

    testWidgets('the stage tracker states the real stage', (tester) async {
      await tester.pumpWidget(_host(const CheStageTracker(current: 2)));
      expect(tester.getSemantics(find.byType(CheStageTracker)).label, 'Progress: Working, stage 3 of 5');
      await tester.pumpWidget(_host(const CheStageTracker(current: 3, failed: true, activity: CheActivity.failed)));
      expect(tester.getSemantics(find.byType(CheStageTracker)).label, 'Progress: failed at Verifying');
      await tester.pumpWidget(_host(const CheStageTracker(current: 4, activity: CheActivity.done)));
      expect(tester.getSemantics(find.byType(CheStageTracker)).label, 'Progress: complete');
    });

    testWidgets('the severity meter says its level in words', (tester) async {
      await tester.pumpWidget(_host(const SizedBox(width: 240, child: CheSeverityMeter(severity: 0.8, label: 'Daily loss limit'))));
      await tester.pumpAndSettle();
      expect(tester.getSemantics(find.byType(CheSeverityMeter)).label, 'Daily loss limit: high, 80 percent');
      expect(find.text('HIGH'), findsOneWidget);
    });
  });

  for (final scale in [1.0, 1.3]) {
    testWidgets('golden: every tone at text scale $scale', (tester) async {
      tester.view.physicalSize = const Size(440 * 3, 520 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(_host(
        const Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Wrap(spacing: 8, runSpacing: 8, children: [
            CheStatusPill(label: 'Verified', tone: CheStatusTone.success, activity: CheActivity.done),
            CheStatusPill(label: 'Failed', tone: CheStatusTone.failure, activity: CheActivity.failed),
            CheStatusPill(label: 'Approaching limit', tone: CheStatusTone.warning),
            CheStatusPill(label: 'Queued', tone: CheStatusTone.neutral, activity: CheActivity.queued),
            CheStatusPill(label: 'Disconnected', tone: CheStatusTone.failure, activity: CheActivity.disconnected),
            CheStatusPill(label: 'Unverified', tone: CheStatusTone.neutral),
          ]),
          SizedBox(height: 14),
          CheStageTracker(current: 2, activity: CheActivity.paused),
          SizedBox(height: 14),
          CheChromeProgress(value: 0.64, label: 'Render', active: false),
          SizedBox(height: 14),
          CheSeverityMeter(severity: 0.55, label: 'Risk'),
          SizedBox(height: 14),
          CheThinkingIndicator(label: 'Thinking… 2.4s', active: false),
        ]),
        textScale: scale,
      ));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chrome_status_${scale == 1.0 ? 'normal' : 'large'}.png'));
    });
  }
}
