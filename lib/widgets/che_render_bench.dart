// Rendering benchmark the owner runs on his own iPhone (Settings → Rendering
// benchmark). Measures the Brain scene three ways on this device:
//
//  1. the native painter the Brain Room uses today (CustomPainter on the
//     Flutter canvas: Impeller on iOS), as the frames really render;
//  2. the bundled Three.js WebGL page (assets/brain3d/bench.html, no CDN);
//  3. raw WebGPU on the same page, when the WebView has it, with the honest
//     fallback to WebGL when it does not or the device is lost.
//
// It is a measurement harness, not the Brain: the orbs are benchmark data,
// labelled so, never memories, and nothing is stored anywhere. Results are
// large text and are read aloud only when the owner asks (owner rule: no
// speech on passive screens). The WebView bridge accepts one validated
// parameter object, never arbitrary JavaScript.

import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../brain/che_brain_space.dart';
import '../che_ui/che_theme.dart';
import '../home/che_memory_brain.dart';

/// Benchmark orbs: real-shaped, labelled as benchmark data, never saved.
List<CheMemoryDot> cheRenderBenchDots(int count) {
  const categories = ['Memory', 'Learning', 'Knowledge', 'Research', 'Conversations', 'Agents', 'About you', 'Suggestion'];
  return [
    for (var i = 0; i < count; i++)
      CheMemoryDot(
        id: 'bench:$i',
        title: 'Benchmark orb $i',
        body: 'Benchmark data, not a memory. Orb $i of $count, topic ${i % 37}, word${i % 53}.',
        category: categories[i % categories.length],
        tokens: ['benchmark', 'topic${i % 37}', 'word${i % 53}'],
        importance: 1 + i % 5,
        at: DateTime.utc(2026, 1, 1).add(Duration(minutes: i)),
      ),
  ];
}

/// Parameters for the bench page, clamped to the ranges its validator accepts.
Map<String, Object> cheRenderBenchParams({int nodes = 2000, int seconds = 4, String backend = 'auto', String label = 'iphone'}) => {
      'nodes': nodes.clamp(100, 20000),
      'edges': (nodes.clamp(100, 20000) * 1.5).round().clamp(0, 60000),
      'seconds': seconds.clamp(1, 20),
      'backend': const {'auto', 'webgl', 'webgpu'}.contains(backend) ? backend : 'auto',
      'label': label.length > 60 ? label.substring(0, 60) : label,
    };

/// One measured backend (or its honest absence).
class CheRenderBenchResult {
  const CheRenderBenchResult({
    required this.backend,
    required this.ok,
    this.fps,
    this.frames,
    this.seconds,
    this.cpuMsAvg,
    this.cpuMsP95,
    this.rasterMsAvg,
    this.rasterMsP95,
    this.overBudget,
    this.cadence,
    this.reason,
    this.pixelRatio,
    this.version,
    this.nodes,
  });

  final String backend;
  final bool ok;
  final double? fps;
  final int? frames;
  final double? seconds;

  /// UI-thread work per frame (the painter's canvas commands, or the page's JS).
  final double? cpuMsAvg;
  final double? cpuMsP95;

  /// Raster thread per frame, from the engine's FrameTiming (native only, device only).
  final double? rasterMsAvg;
  final double? rasterMsP95;

  /// Frames over the 16.7 ms budget.
  final int? overBudget;

  /// 60 or 30: the page drops to a 30 fps cadence when frames run long.
  final int? cadence;
  final String? reason;
  final double? pixelRatio;
  final String? version;
  final int? nodes;

  /// A `result` message from the bench page.
  static CheRenderBenchResult fromPageJson(Map<String, dynamic> j) => CheRenderBenchResult(
        backend: '${j['backend'] ?? 'unknown'}',
        ok: j['ok'] == true,
        fps: (j['fps'] as num?)?.toDouble(),
        frames: (j['frames'] as num?)?.toInt(),
        seconds: (j['seconds'] as num?)?.toDouble(),
        cpuMsAvg: (j['cpuMsAvg'] as num?)?.toDouble(),
        cpuMsP95: (j['cpuMsP95'] as num?)?.toDouble(),
        cadence: (j['cadence'] as num?)?.toInt(),
        reason: j['reason']?.toString() ?? j['lostReason']?.toString(),
        pixelRatio: (j['pixelRatio'] as num?)?.toDouble(),
        version: j['version']?.toString(),
        nodes: (j['nodes'] as num?)?.toInt(),
      );

  String get name => switch (backend) {
        'native' => 'Native painter (Flutter canvas, the Brain Room today)',
        'webgl' => 'WebGL (bundled Three.js in the WebView)',
        'webgpu' => 'WebGPU (raw, in the WebView)',
        final other => other,
      };

  /// One spoken line, numbers rounded for the ear.
  String summary() {
    if (!ok) return '$name: not available${reason != null && reason!.isNotEmpty ? ': $reason' : ''}.';
    final parts = <String>[
      if (nodes != null) '${_thousands(nodes!)} orbs',
      if (fps != null) '${fps!.toStringAsFixed(fps! >= 50 ? 0 : 1)} frames per second',
      if (frames != null && seconds != null) '$frames frames in ${seconds!.toStringAsFixed(seconds! == seconds!.roundToDouble() ? 0 : 1)} seconds',
      if (cpuMsAvg != null) 'canvas work ${cpuMsAvg!.toStringAsFixed(1)} milliseconds average${cpuMsP95 != null ? ', ${cpuMsP95!.toStringAsFixed(1)} at the 95th' : ''}',
      if (rasterMsAvg != null) 'raster ${rasterMsAvg!.toStringAsFixed(1)} milliseconds average${rasterMsP95 != null ? ', ${rasterMsP95!.toStringAsFixed(1)} at the 95th' : ''}',
      if (overBudget != null) '$overBudget frame${overBudget == 1 ? '' : 's'} over the 60-frame budget',
      if (cadence == 30) 'dropped to a 30 frames per second cadence',
      if (version != null && version!.isNotEmpty) version!,
    ];
    return '$name: ${parts.join(', ')}.';
  }

  static String _thousands(int n) => n.toString().replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+$)'), (m) => '${m[1]},');
}

/// Reads the bench page's messages (capability, fallback, lost device/context, result).
class CheRenderBenchPageLog {
  final List<String> notes = [];
  final List<CheRenderBenchResult> results = [];
  Map<String, dynamic>? capability;

  /// Returns true when a `result` arrived.
  bool take(String raw) {
    Map<String, dynamic> j;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return false;
      j = Map<String, dynamic>.from(decoded);
    } catch (_) {
      return false;
    }
    switch ('${j['type']}') {
      case 'capability':
        capability = j;
        notes.add('WebView: WebGPU ${j['webgpu'] == true ? 'available' : 'not available'}, WebGL2 ${j['webgl2'] == true ? 'yes' : 'no'}, pixel ratio ${j['devicePixelRatio']}${j['reducedMotion'] == true ? ', Reduce Motion on (camera held still)' : ''}.');
        return false;
      case 'fallback':
        notes.add('Fell back from ${j['from']} to ${j['to']}: ${'${j['reason']}'.replaceFirst(RegExp(r'\.$'), '')}.');
        return false;
      case 'devicelost':
        notes.add('WebGPU device lost: ${'${j['reason']}'.replaceFirst(RegExp(r'\.$'), '')}. Reported, not hidden.');
        return false;
      case 'contextlost':
        notes.add('WebGL context lost; the run stopped and said so.');
        return false;
      case 'error':
        notes.add('The page refused the request: ${j['reason']}.');
        return false;
      case 'result':
        results.add(CheRenderBenchResult.fromPageJson(j));
        return true;
      default:
        return false;
    }
  }
}

/// Times the Brain painter's canvas work per frame (UI thread) while the real
/// space renders; FrameTiming adds the raster side on a device.
class _TimedBrainPainter extends CustomPainter {
  _TimedBrainPainter(this.inner, this.samples) : super(repaint: inner.c.frame);
  final CheBrainPainter inner;
  final List<double> samples;

  @override
  void paint(Canvas canvas, Size size) {
    final sw = Stopwatch()..start();
    inner.paint(canvas, size);
    samples.add(sw.elapsedMicroseconds / 1000);
  }

  @override
  bool shouldRepaint(covariant _TimedBrainPainter old) => !identical(old.inner, inner);
}

class CheRenderBenchScreen extends StatefulWidget {
  const CheRenderBenchScreen({super.key, this.onSpeak, this.nodes = 2000, this.seconds = 4, this.webView = true});

  /// CHE's voice, used only when the owner taps "Read results aloud".
  final Future<void> Function(String text)? onSpeak;
  final int nodes;
  final int seconds;

  /// False skips the WebView passes (tests; a device without a WebView).
  final bool webView;

  @override
  State<CheRenderBenchScreen> createState() => _CheRenderBenchScreenState();
}

class _CheRenderBenchScreenState extends State<CheRenderBenchScreen> with SingleTickerProviderStateMixin {
  CheBrainSpaceController? _space;
  final List<double> _paintMs = [];
  final List<FrameTiming> _timings = [];
  TimingsCallback? _timingsCallback;
  Ticker? _orbit;
  final List<CheRenderBenchResult> _results = [];
  final List<String> _notes = [];
  String _phase = 'ready';
  bool _running = false;
  WebViewController? _web;

  @override
  void initState() {
    super.initState();
    _notes.add('Device: ${Platform.operatingSystem} ${Platform.operatingSystemVersion}.');
  }

  @override
  void dispose() {
    _stopNative();
    _space?.dispose();
    super.dispose();
  }

  Future<void> run() async {
    if (_running) return;
    setState(() {
      _running = true;
      _results.clear();
      _notes.removeWhere((n) => !n.startsWith('Device:'));
      _phase = 'native';
    });
    await _runNative();
    if (widget.webView) {
      for (final backend in ['webgl', 'webgpu']) {
        if (!mounted) return;
        setState(() => _phase = backend);
        await _runPage(backend);
      }
    } else {
      _notes.add('WebView passes skipped here (no WebView on this device or in this run).');
    }
    if (!mounted) return;
    setState(() {
      _phase = 'done';
      _running = false;
      _web = null;
    });
  }

  Future<void> _runNative() async {
    _paintMs.clear();
    _timings.clear();
    _space?.dispose();
    final c = CheBrainSpaceController(cheRenderBenchDots(widget.nodes));
    for (final cl in c.layout.clusters.values) {
      cl.expanded = true;
    }
    _space = c;
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    _notes.add(reduceMotion ? 'Reduce Motion is on: the camera orbits anyway for the measurement, then stops.' : 'Camera orbiting for the native pass.');
    _timingsCallback = (List<FrameTiming> t) => _timings.addAll(t);
    SchedulerBinding.instance.addTimingsCallback(_timingsCallback!);
    _orbit = createTicker((_) => c.camera.rotate(.012, 0))..start();
    setState(() {});
    await Future<void>.delayed(Duration(seconds: widget.seconds));
    _stopNative();
    final paint = List<double>.of(_paintMs)..sort();
    final frames = paint.length;
    double avg(List<double> v) => v.isEmpty ? 0 : v.reduce((a, b) => a + b) / v.length;
    double p95(List<double> v) => v.isEmpty ? 0 : v[math.min(v.length - 1, (v.length * .95).floor())];
    final raster = [for (final t in _timings) t.rasterDuration.inMicroseconds / 1000]..sort();
    final total = [for (final t in _timings) t.totalSpan.inMicroseconds / 1000];
    _results.add(CheRenderBenchResult(
      backend: 'native',
      ok: frames > 0,
      nodes: widget.nodes,
      frames: frames,
      seconds: widget.seconds.toDouble(),
      fps: frames / widget.seconds,
      cpuMsAvg: avg(paint),
      cpuMsP95: p95(paint),
      rasterMsAvg: raster.isEmpty ? null : avg(raster),
      rasterMsP95: raster.isEmpty ? null : p95(raster),
      overBudget: total.isEmpty ? null : total.where((ms) => ms > 16.7).length,
      reason: frames == 0 ? 'no frame was painted' : null,
    ));
    if (_timings.isEmpty) _notes.add('Raster times: not reported here (the engine reports FrameTiming on a device, not in this run).');
    if (mounted) setState(() {});
  }

  void _stopNative() {
    _orbit?.dispose();
    _orbit = null;
    if (_timingsCallback != null) {
      SchedulerBinding.instance.removeTimingsCallback(_timingsCallback!);
      _timingsCallback = null;
    }
  }

  Future<void> _runPage(String backend) async {
    final log = CheRenderBenchPageLog();
    final done = Completer<void>();
    late final WebViewController controller;
    try {
      controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(const Color(0xFF020506))
        ..addJavaScriptChannel('BrainBench', onMessageReceived: (m) {
          if (log.take(m.message) && !done.isCompleted) done.complete();
        })
        ..setNavigationDelegate(NavigationDelegate(onPageFinished: (_) async {
          final params = jsonEncode(cheRenderBenchParams(nodes: widget.nodes, seconds: widget.seconds, backend: backend));
          // One validated parameter object; the page refuses anything else.
          await controller.runJavaScript('window.brainBenchRun && window.brainBenchRun(JSON.parse(${jsonEncode(params)}));');
        }, onWebResourceError: (e) {
          log.notes.add('WebView could not load the page: ${e.description}.');
          if (!done.isCompleted) done.complete();
        }))
        ..loadFlutterAsset('assets/brain3d/bench.html');
    } catch (e) {
      _results.add(CheRenderBenchResult(backend: backend, ok: false, reason: 'no WebView on this device ($e)'));
      if (mounted) setState(() {});
      return;
    }
    _web = controller;
    if (mounted) setState(() {});
    await done.future.timeout(Duration(seconds: widget.seconds + 20), onTimeout: () {
      log.notes.add('The $backend pass did not report within ${widget.seconds + 20} seconds.');
    });
    _notes.addAll(log.notes);
    if (log.results.isEmpty) {
      _results.add(CheRenderBenchResult(backend: backend, ok: false, reason: log.notes.isEmpty ? 'no result reported' : log.notes.last));
    } else {
      _results.addAll(log.results);
    }
    _web = null;
    if (mounted) setState(() {});
  }

  String _spokenReport() => [
        'Rendering benchmark on this device, ${widget.nodes} benchmark orbs, ${widget.seconds} seconds each.',
        ..._results.map((r) => r.summary()),
        ..._notes,
      ].join(' ');

  @override
  Widget build(BuildContext context) {
    final space = _space;
    return Scaffold(
      appBar: AppBar(title: const Text('Rendering benchmark')),
      body: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // The scene under measurement, as it really renders.
        SizedBox(
          height: 300,
          child: _phase == 'native' && space != null
              ? Semantics(
                  label: 'Benchmark scene: ${widget.nodes} benchmark orbs, not memories, rendering natively.',
                  excludeSemantics: true,
                  child: RepaintBoundary(
                    child: CustomPaint(painter: _TimedBrainPainter(CheBrainPainter(space), _paintMs), size: Size.infinite),
                  ),
                )
              : (_phase == 'webgl' || _phase == 'webgpu') && _web != null
                  ? Semantics(label: 'Benchmark scene rendering in the WebView, ${_phase == 'webgpu' ? 'WebGPU' : 'WebGL'} pass.', excludeSemantics: true, child: WebViewWidget(controller: _web!))
                  : Container(
                      color: CheColors.bg,
                      alignment: Alignment.center,
                      child: Text(_phase == 'done' ? 'Done. Results below.' : 'Press Run to measure.', style: CheType.body),
                    ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(
                'Measures the Brain scene on this device: the native painter, then WebGL, then WebGPU when the WebView has it. Benchmark orbs only; nothing is stored. Results are read aloud only when you ask.',
                style: CheType.bodyDim,
              ),
              const SizedBox(height: 12),
              Wrap(spacing: 8, runSpacing: 8, children: [
                FilledButton.icon(onPressed: _running ? null : run, icon: const Icon(Icons.speed_rounded), label: Text(_running ? 'Measuring ${_phase == 'native' ? 'the native painter' : _phase}…' : _results.isEmpty ? 'Run' : 'Run again')),
                OutlinedButton.icon(
                  onPressed: _results.isEmpty || widget.onSpeak == null ? null : () => widget.onSpeak!(_spokenReport()),
                  icon: const Icon(Icons.volume_up_rounded),
                  label: const Text('Read results aloud'),
                ),
                OutlinedButton.icon(
                  onPressed: _results.isEmpty
                      ? null
                      : () async {
                          await Clipboard.setData(ClipboardData(text: _spokenReport()));
                          HapticFeedback.selectionClick();
                        },
                  icon: const Icon(Icons.copy_rounded),
                  label: const Text('Copy results'),
                ),
              ]),
              const SizedBox(height: 16),
              for (final r in _results)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Semantics(
                    container: true,
                    label: r.summary(),
                    excludeSemantics: true,
                    child: DecoratedBox(
                      decoration: BoxDecoration(color: CheColors.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: r.ok ? CheColors.accent.withValues(alpha: .5) : CheColors.stroke)),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Row(children: [
                            Icon(r.ok ? Icons.check_circle_outline_rounded : Icons.block_rounded, size: 18, color: r.ok ? CheColors.accent : CheColors.textDim),
                            const SizedBox(width: 6),
                            Expanded(child: Text(r.name, style: CheType.label.copyWith(color: Colors.white))),
                          ]),
                          const SizedBox(height: 6),
                          Text(r.summary().replaceFirst('${r.name}: ', ''), style: CheType.body.copyWith(fontSize: 18, height: 1.3)),
                        ]),
                      ),
                    ),
                  ),
                ),
              if (_notes.isNotEmpty) ...[
                Text('NOTES', style: CheType.overline),
                const SizedBox(height: 6),
                for (final n in _notes) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(n, style: CheType.bodyDim)),
              ],
            ],
          ),
        ),
      ]),
    );
  }
}
