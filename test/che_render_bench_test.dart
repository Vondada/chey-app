// The rendering benchmark the owner runs on his iPhone: benchmark orbs that
// are never memories, a validated bridge, honest results, speech only on
// request. VM numbers here are CPU canvas work, not a phone's GPU.

import 'dart:convert';
import 'dart:ui' show PictureRecorder;

import 'package:chey/brain/che_brain_space.dart';
import 'package:chey/home/screen_command.dart';
import 'package:chey/widgets/che_render_bench.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('benchmark orbs are labelled benchmark data and never look like memories', () {
    final dots = cheRenderBenchDots(2000);
    expect(dots.length, 2000);
    expect(dots.every((d) => d.id.startsWith('bench:') && d.title.startsWith('Benchmark orb') && d.body.startsWith('Benchmark data, not a memory.')), isTrue);
    expect(dots.map((d) => d.category).toSet().length, 8);
  });

  test('page parameters are clamped to what the page validates; nothing else goes through', () {
    expect(cheRenderBenchParams(nodes: 50, seconds: 0, backend: 'metal'), {'nodes': 100, 'edges': 150, 'seconds': 1, 'backend': 'auto', 'label': 'iphone'});
    expect(cheRenderBenchParams(nodes: 50000, seconds: 99, backend: 'webgpu', label: 'x' * 80)['nodes'], 20000);
    expect(cheRenderBenchParams(nodes: 50000, seconds: 99)['edges'], 30000);
    expect(cheRenderBenchParams(nodes: 50000, seconds: 99)['seconds'], 20);
    expect((cheRenderBenchParams(label: 'x' * 80)['label'] as String).length, 60);
    expect(cheRenderBenchParams().keys.toSet(), {'nodes', 'edges', 'seconds', 'backend', 'label'});
  });

  test('the page log reads capability, fallback, lost device and result messages exactly as the VM run produced them', () {
    final log = CheRenderBenchPageLog();
    expect(log.take(jsonEncode({'type': 'capability', 'webgpu': true, 'webgl2': true, 'webgl': true, 'reducedMotion': false, 'devicePixelRatio': 1})), isFalse);
    expect(log.take(jsonEncode({'type': 'devicelost', 'backend': 'webgpu', 'reason': 'A valid external Instance reference no longer exists.'})), isFalse);
    expect(log.take(jsonEncode({'type': 'fallback', 'from': 'webgpu', 'to': 'webgl', 'reason': 'A valid external Instance reference no longer exists.'})), isFalse);
    expect(log.take('not json'), isFalse);
    expect(log.take(jsonEncode({'type': 'error', 'reason': 'unknown parameter: evil'})), isFalse);
    expect(log.take(jsonEncode({'type': 'result', 'label': 'vm', 'ok': true, 'backend': 'webgl', 'version': 'WebGL 2.0 (OpenGL ES 3.0 Chromium)', 'pixelRatio': 1, 'nodes': 2000, 'edges': 3000, 'contextLost': false, 'frames': 50, 'seconds': 3, 'fps': 16.6, 'cadence': 30, 'cpuMsAvg': 4.82, 'cpuMsP95': 1.3, 'reducedMotion': false})), isTrue);
    expect(log.notes, [
      'WebView: WebGPU available, WebGL2 yes, pixel ratio 1.',
      'WebGPU device lost: A valid external Instance reference no longer exists. Reported, not hidden.',
      'Fell back from webgpu to webgl: A valid external Instance reference no longer exists.',
      'The page refused the request: unknown parameter: evil.',
    ]);
    final r = log.results.single;
    expect(r.backend, 'webgl');
    expect(r.summary(), 'WebGL (bundled Three.js in the WebView): 2,000 orbs, 16.6 frames per second, 50 frames in 3 seconds, canvas work 4.8 milliseconds average, 1.3 at the 95th, dropped to a 30 frames per second cadence, WebGL 2.0 (OpenGL ES 3.0 Chromium).');
    expect(const CheRenderBenchResult(backend: 'webgpu', ok: false, reason: 'navigator.gpu is not available in this WebView').summary(), 'WebGPU (raw, in the WebView): not available: navigator.gpu is not available in this WebView.');
  });

  testWidgets('the screen measures the native painter here, skips the WebView passes honestly, and speaks only when asked', (tester) async {
    tester.view.physicalSize = const Size(1320, 2868);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(home: CheRenderBenchScreen(onSpeak: (t) async => spoken.add(t), nodes: 600, seconds: 1, webView: false)));
    await tester.pump();
    expect(find.text('Press Run to measure.'), findsOneWidget);
    await tester.tap(find.text('Run'));
    await tester.pump();
    for (var i = 0; i < 70; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Done. Results below.'), findsOneWidget);
    expect(find.textContaining('Native painter (Flutter canvas'), findsOneWidget);
    expect(find.textContaining('600 orbs'), findsOneWidget);
    // The notes sit below the result cards: scroll them into view first.
    await tester.drag(find.byType(ListView), const Offset(0, -600));
    await tester.pump();
    expect(find.textContaining('Raster times: not reported here'), findsOneWidget);
    expect(find.textContaining('WebView passes skipped here'), findsOneWidget);
    await tester.drag(find.byType(ListView), const Offset(0, 600));
    await tester.pump();
    expect(spoken, isEmpty, reason: 'results are shown, never spoken on their own');
    await tester.tap(find.text('Read results aloud'));
    await tester.pump();
    expect(spoken.single, startsWith('Rendering benchmark on this device, 600 benchmark orbs, 1 seconds each. Native painter'));
    await tester.pumpWidget(const SizedBox());
  });

  test('VM baseline: the native painter\'s canvas work per frame at 2 000, 5 000 and 10 000 orbs (CPU, not a phone)', () {
    for (final n in [2000, 5000, 10000]) {
      final c = CheBrainSpaceController(cheRenderBenchDots(n));
      for (final cl in c.layout.clusters.values) {
        cl.expanded = true;
      }
      final painter = CheBrainPainter(c);
      const size = Size(440, 956);
      void frame() {
        final recorder = PictureRecorder();
        painter.paint(Canvas(recorder), size);
        recorder.endRecording().dispose();
      }
      frame();
      final times = <double>[];
      for (var i = 0; i < 30; i++) {
        c.camera.rotate(.02, 0);
        c.tick(1 / 60);
        final sw = Stopwatch()..start();
        frame();
        times.add(sw.elapsedMicroseconds / 1000);
      }
      times.sort();
      final avg = times.reduce((a, b) => a + b) / times.length;
      // ignore: avoid_print
      print('BRAIN_NATIVE_VM n=$n avg_ms=${avg.toStringAsFixed(2)} p95_ms=${times[(times.length * .95).floor()].toStringAsFixed(2)} edges=${c.layout.edges.length}');
      expect(avg, lessThan(200));
      c.dispose();
    }
  });

  test('the rendering benchmark has spoken routes: opening only opens, and only "run" starts a measurement', () {
    expect(parseScreenCommand('open the rendering benchmark')?.op, ScreenOp.openRenderBench);
    expect(parseScreenCommand('open the rendering benchmark')?.text, '');
    expect(parseScreenCommand('Run the graphics benchmark.')?.op, ScreenOp.openRenderBench);
    expect(parseScreenCommand('Run the graphics benchmark.')?.text, 'run');
    expect(parseScreenCommand('open the commands page')?.op, ScreenOp.openCommands);
  });

  testWidgets('Read results aloud stays enabled before a run and says so; spoken run/read words are answered only while the screen is open', (tester) async {
    tester.view.physicalSize = const Size(1320, 2868);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final spoken = <String>[];
    await tester.pumpWidget(MaterialApp(home: CheRenderBenchScreen(onSpeak: (t) async => spoken.add(t), nodes: 600, seconds: 1, webView: false)));
    await tester.pump();
    await tester.tap(find.text('Read results aloud'));
    await tester.pump();
    expect(spoken.single, 'No results yet. Press Run first.');
    expect(find.text('No results yet. Press Run first.'), findsOneWidget, reason: 'the Read reply is shown as large text too');
    final handler = CheRenderBenchScreen.voiceHandler;
    expect(handler, isNotNull, reason: 'the open screen takes its spoken controls');
    expect(await handler!('read the results'), 'No results yet, sir. Say run the benchmark first.');
    await tester.pump();
    expect(find.text('No results yet, sir. Say run the benchmark first.'), findsOneWidget, reason: 'a spoken reply is also shown as large text');
    expect(await handler('what is the weather'), isNull, reason: 'anything else goes on to Chat');
    await tester.pumpWidget(const SizedBox());
    expect(CheRenderBenchScreen.voiceHandler, isNull, reason: 'a closed screen takes no spoken control');
  });
}
