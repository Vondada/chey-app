// Trade evidence and replay (owner mission, 2026-10-23, Priority 5): one CHE trade on its own chart.
//
// The trade and its bars come from GET /api/trading/visual?view=trade&id=<id> (server/cloudflare/trade_evidence.js):
// a stable trade ID, the evidence label (BACKTEST / SIMULATION / FORWARD PAPER / BROKER-CONFIRMED), entry, exit,
// stop, target, times, outcome, and only bars CHE actually stored. Without stored bars the page says "No recorded
// market data for this trade." and draws no chart.
//
// Replay never shows the future: a bar appears once it has closed (open time + timeframe <= replay clock), the
// signal once its bar has closed, the entry at its fill time, and the exit once its bar has closed. At 1× the
// clock moves one bar per second; "+10s" skips what ten seconds of playback would show. Silent on open: Read
// This speaks only when pressed.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

const _dim = Color(0xFFB8C2CC);
const _panel = Color(0xFF0E1418);
const _stroke = Color(0xFF2A3540);
const _win = Color(0xFF34D399);
const _loss = Color(0xFFF87171);
const _entryColor = Color(0xFF60A5FA);
const _stopColor = Color(0xFFF87171);
const _targetColor = Color(0xFF34D399);

double? _d(Object? v) => v is num ? v.toDouble() : (v is String ? double.tryParse(v) : null);
DateTime? _t(Object? v) => v is String ? DateTime.tryParse(v) : null;

class CheReplayBar {
  const CheReplayBar(this.t, this.o, this.h, this.l, this.c);
  final DateTime t;
  final double o, h, l, c;
  static CheReplayBar? fromJson(Object? j) {
    if (j is! Map) return null;
    final t = _t(j['t']);
    final o = _d(j['o']), h = _d(j['h']), l = _d(j['l']), c = _d(j['c']);
    if (t == null || o == null || h == null || l == null || c == null) return null;
    return CheReplayBar(t, o, h, l, c);
  }
}

/// One trade as the Worker recorded it. Missing values stay null and read "unknown", never 0.
class CheTradeEvidence {
  CheTradeEvidence({
    required this.id,
    required this.label,
    required this.strategy,
    required this.symbol,
    required this.timeframe,
    required this.side,
    required this.bars,
    required this.timeframeMs,
    this.signalTime,
    this.signalWhy = '',
    this.entryTime,
    this.entryPrice,
    this.exitTime,
    this.exitPrice,
    this.exitReason,
    this.stop,
    this.target,
    this.result,
    this.r,
    this.net,
    this.barsSource,
    this.noData,
    this.brainRef,
    this.executionLabel = '',
  });

  final String id, label, strategy, symbol, timeframe, side, signalWhy, executionLabel;
  final List<CheReplayBar> bars;
  final int timeframeMs;
  final DateTime? signalTime, entryTime, exitTime;
  final double? entryPrice, exitPrice, stop, target, r, net;
  final String? exitReason, result, barsSource, noData, brainRef;

  bool get replaySupported => bars.isNotEmpty;
  Duration get tf => Duration(milliseconds: timeframeMs);
  DateTime? get replayStart => bars.isEmpty ? null : bars.first.t;
  DateTime? get replayEnd => bars.isEmpty ? null : bars.last.t.add(tf);

  static CheTradeEvidence? fromJson(Object? j) {
    if (j is! Map || j['ok'] == false || j['id'] is! String) return null;
    Map m(Object? v) => v is Map ? v : const {};
    final bars = (j['bars'] is List ? j['bars'] as List : const []).map(CheReplayBar.fromJson).whereType<CheReplayBar>().toList()
      ..sort((a, b) => a.t.compareTo(b.t));
    final replay = m(j['replay']);
    return CheTradeEvidence(
      id: j['id'] as String,
      label: (j['label'] ?? '').toString(),
      executionLabel: (j['execution_label'] ?? '').toString(),
      strategy: (j['strategy'] ?? 'unknown strategy').toString(),
      symbol: (j['symbol'] ?? '').toString(),
      timeframe: (j['timeframe'] ?? '').toString(),
      side: (j['side'] ?? '').toString(),
      bars: bars,
      timeframeMs: (replay['timeframe_ms'] as num?)?.toInt() ?? 300000,
      signalTime: _t(m(j['signal'])['time']),
      signalWhy: (m(j['signal'])['why'] ?? '').toString(),
      entryTime: _t(m(j['entry'])['time']),
      entryPrice: _d(m(j['entry'])['price']),
      exitTime: _t(m(j['exit'])['time']),
      exitPrice: _d(m(j['exit'])['price']),
      exitReason: m(j['exit'])['reason']?.toString(),
      stop: _d(j['stop']),
      target: _d(j['target']),
      result: m(j['outcome'])['result']?.toString(),
      r: _d(m(j['outcome'])['r']),
      net: _d(m(j['outcome'])['net']),
      barsSource: m(j['bars_source'])['label']?.toString(),
      noData: j['no_data']?.toString(),
      brainRef: m(m(j['links'])['brain'])['ref']?.toString(),
    );
  }
}

/// What the replay shows at [clock]: only bars closed by then, and each marker only once it happened.
class CheReplayFrame {
  const CheReplayFrame({required this.bars, required this.signal, required this.entry, required this.exit});
  final List<CheReplayBar> bars;
  final bool signal, entry, exit;
}

CheReplayFrame cheReplayFrame(CheTradeEvidence e, DateTime clock) {
  bool closedBy(DateTime? t) => t != null && !t.add(e.tf).isAfter(clock);
  return CheReplayFrame(
    bars: e.bars.where((b) => closedBy(b.t)).toList(),
    signal: closedBy(e.signalTime),
    entry: e.entryTime != null && !e.entryTime!.isAfter(clock),
    exit: closedBy(e.exitTime),
  );
}

String _price(double? v) => v == null ? 'unknown' : (v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2));
String _money(double? v) => v == null ? 'unknown' : '${v < 0 ? '−' : v > 0 ? '+' : ''}\$${v.abs().toStringAsFixed(2)}';
String _r(double? v) => v == null ? 'unknown' : '${v > 0 ? '+' : ''}${v.toStringAsFixed(2)}R';
String _clock(DateTime? t) {
  if (t == null) return 'unknown';
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}';
}

/// The spoken summary Read This gives; every fact is from the record.
String cheTradeSpoken(CheTradeEvidence e) {
  final out = e.result == 'win' ? 'a win' : e.result == 'loss' ? 'a loss' : e.result == 'flat' ? 'flat' : 'still open';
  final parts = <String>[
    'Trade ${e.id}, ${e.label}. ${e.strategy} ${e.side} on ${e.symbol} ${e.timeframe}.',
    'Entered ${_clock(e.entryTime)} at ${_price(e.entryPrice)}, stop ${_price(e.stop)}, target ${_price(e.target)}.',
    if (e.exitTime != null) 'Exited ${_clock(e.exitTime)} at ${_price(e.exitPrice)}${e.exitReason == null ? '' : ' on the ${e.exitReason}'}.',
    'Result: $out, ${_r(e.r)}${e.net == null ? '' : ', ${_money(e.net)} after costs'}.',
    if (e.noData != null) e.noData!,
  ];
  return parts.join(' ');
}

class CheTradeReplayPage extends StatefulWidget {
  const CheTradeReplayPage({super.key, required this.tradeId, required this.baseUrl, required this.headers, this.onRead, this.client, this.initial});

  final String tradeId;
  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final void Function(String words)? onRead;
  final http.Client? client;
  /// Already-loaded evidence (tests, or a caller that has it); skips the network read.
  final CheTradeEvidence? initial;

  static Route<void> route({required String tradeId, required String Function() baseUrl, required Map<String, String> Function() headers, void Function(String words)? onRead}) =>
      MaterialPageRoute<void>(
        settings: RouteSettings(name: 'trade_replay/$tradeId'),
        builder: (_) => CheTradeReplayPage(tradeId: tradeId, baseUrl: baseUrl, headers: headers, onRead: onRead),
      );

  @override
  State<CheTradeReplayPage> createState() => _CheTradeReplayPageState();
}

const kCheReplaySpeeds = [1.0, 2.0, 4.0, 8.0];

class _CheTradeReplayPageState extends State<CheTradeReplayPage> {
  CheTradeEvidence? _e;
  String? _error;
  bool _loading = true;
  DateTime? _clockAt;
  Timer? _timer;
  double _speed = 1;
  static const _tick = Duration(milliseconds: 100);

  @override
  void initState() {
    super.initState();
    if (widget.initial != null) {
      _set(widget.initial!);
    } else {
      unawaited(_load());
    }
  }

  void _set(CheTradeEvidence e) {
    _e = e;
    _loading = false;
    // Opens on the whole trade (entry to exit); Restart rewinds to the first stored bar.
    _clockAt = e.replayEnd;
  }

  Future<void> _load() async {
    final client = widget.client ?? http.Client();
    try {
      final id = Uri.encodeQueryComponent(widget.tradeId);
      final r = await client.get(Uri.parse('${widget.baseUrl()}/api/trading/visual?view=trade&id=$id'), headers: widget.headers()).timeout(const Duration(seconds: 20));
      final body = jsonDecode(r.body);
      final e = body is Map ? CheTradeEvidence.fromJson(body['trade']) : null;
      if (!mounted) return;
      setState(() {
        if (e == null) {
          _error = body is Map && body['error'] != null ? body['error'].toString() : 'This trade could not be read (HTTP ${r.statusCode}).';
          _loading = false;
        } else {
          _set(e);
        }
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = 'This trade could not be read: $error';
        _loading = false;
      });
    } finally {
      if (widget.client == null) client.close();
    }
  }

  @override
  void didUpdateWidget(CheTradeReplayPage old) {
    super.didUpdateWidget(old);
    if (old.tradeId == widget.tradeId) return;
    _pause();
    setState(() {
      _e = null;
      _error = null;
      _loading = true;
    });
    if (widget.initial != null) {
      _set(widget.initial!);
    } else {
      unawaited(_load());
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  bool get _playing => _timer != null;

  void _advance(Duration by) {
    final e = _e;
    if (e == null || !e.replaySupported) return;
    final next = _clockAt!.add(by);
    setState(() => _clockAt = next.isAfter(e.replayEnd!) ? e.replayEnd : next);
    if (!_clockAt!.isBefore(e.replayEnd!)) _pause();
  }

  Duration _playbackSpan(Duration real) => Duration(milliseconds: (_e!.timeframeMs * _speed * real.inMilliseconds / 1000).round());

  void _play() {
    final e = _e;
    if (e == null || !e.replaySupported) return;
    if (!_clockAt!.isBefore(e.replayEnd!)) setState(() => _clockAt = e.replayStart);
    _timer?.cancel();
    setState(() => _timer = Timer.periodic(_tick, (_) => _advance(_playbackSpan(_tick))));
  }

  void _pause() {
    _timer?.cancel();
    if (mounted) setState(() => _timer = null);
  }

  void _restart() {
    _pause();
    setState(() => _clockAt = _e?.replayStart);
  }

  void _skip10() => _advance(_playbackSpan(const Duration(seconds: 10)));

  void _seek(double fraction) {
    final e = _e!;
    final span = e.replayEnd!.difference(e.replayStart!).inMilliseconds;
    setState(() => _clockAt = e.replayStart!.add(Duration(milliseconds: (span * fraction).round())));
  }

  @override
  Widget build(BuildContext context) {
    final e = _e;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Semantics(header: true, child: Text(e == null ? 'Trade replay' : 'Trade ${e.id}', style: const TextStyle(fontWeight: FontWeight.w800))),
        actions: [
          if (e != null && widget.onRead != null)
            IconButton(
              key: const Key('trade_replay_read'),
              tooltip: 'Read this trade aloud',
              icon: const Icon(Icons.volume_up_rounded),
              onPressed: () => widget.onRead!(cheTradeSpoken(e)),
            ),
        ],
      ),
      body: SafeArea(
        child: _loading
            ? Center(child: Semantics(label: 'Loading the trade', child: const CircularProgressIndicator()))
            : e == null
                ? Padding(padding: const EdgeInsets.all(20), child: Text(_error ?? 'This trade could not be read.', style: const TextStyle(color: Colors.white, fontSize: 16)))
                : ListView(padding: const EdgeInsets.fromLTRB(14, 8, 14, 24), children: [
                    _header(e),
                    const SizedBox(height: 10),
                    if (e.replaySupported) ...[_chart(e), const SizedBox(height: 8), _controls(e)] else _noData(e),
                    const SizedBox(height: 12),
                    _facts(e),
                  ]),
      ),
    );
  }

  Widget _header(CheTradeEvidence e) {
    final color = e.result == 'win' ? _win : e.result == 'loss' ? _loss : _dim;
    return Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
      Semantics(
        label: 'Evidence type: ${e.label}',
        excludeSemantics: true,
        child: Container(
          key: const Key('trade_replay_label'),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(border: Border.all(color: Colors.white70), borderRadius: BorderRadius.circular(6)),
          child: Text(e.label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, letterSpacing: 1.1, fontSize: 12)),
        ),
      ),
      Text('${e.strategy} · ${e.side.toUpperCase()} · ${e.symbol} ${e.timeframe}', style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
      Text('${e.result ?? 'open'} ${_r(e.r)}', style: TextStyle(color: color, fontSize: 15, fontWeight: FontWeight.w800)),
    ]);
  }

  Widget _noData(CheTradeEvidence e) => Container(
        key: const Key('trade_replay_no_data'),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: _panel, border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(10)),
        child: Text(e.noData ?? 'No recorded market data for this trade.', style: const TextStyle(color: Colors.white, fontSize: 15)),
      );

  Widget _chart(CheTradeEvidence e) {
    final frame = cheReplayFrame(e, _clockAt!);
    final shown = '${frame.bars.length} of ${e.bars.length} bars shown';
    return Semantics(
      label: 'Chart of trade ${e.id} at ${_clock(_clockAt)}: $shown.'
          '${frame.entry ? ' Entry at ${_price(e.entryPrice)}.' : ' Not entered yet.'}'
          '${frame.exit ? ' Exit at ${_price(e.exitPrice)}.' : ''}',
      excludeSemantics: true,
      child: Container(
        key: const Key('trade_replay_chart'),
        height: 300,
        decoration: BoxDecoration(color: _panel, border: Border.all(color: _stroke), borderRadius: BorderRadius.circular(10)),
        child: CustomPaint(painter: _ReplayPainter(e, frame), size: Size.infinite),
      ),
    );
  }

  Widget _controls(CheTradeEvidence e) {
    final span = e.replayEnd!.difference(e.replayStart!).inMilliseconds;
    final pos = span <= 0 ? 1.0 : (_clockAt!.difference(e.replayStart!).inMilliseconds / span).clamp(0.0, 1.0);
    Widget btn(Key key, String label, Widget child, VoidCallback onTap) => Semantics(
          button: true,
          label: label,
          excludeSemantics: true,
          child: SizedBox(height: 48, child: OutlinedButton(key: key, onPressed: onTap, style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: const BorderSide(color: Colors.white54)), child: child)),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Replay clock ${_clock(_clockAt)} · ${cheReplayFrame(e, _clockAt!).bars.length} of ${e.bars.length} bars', key: const Key('trade_replay_clock'), style: const TextStyle(color: _dim, fontSize: 13)),
      Semantics(
        label: 'Replay timeline',
        value: '${(pos * 100).round()} percent',
        child: Slider(key: const Key('trade_replay_scrub'), value: pos, onChanged: (v) {
          _pause();
          _seek(v);
        }),
      ),
      Wrap(spacing: 8, runSpacing: 8, children: [
        btn(const Key('trade_replay_restart'), 'Restart the replay', const Icon(Icons.replay_rounded), _restart),
        _playing
            ? btn(const Key('trade_replay_pause'), 'Pause the replay', const Icon(Icons.pause_rounded), _pause)
            : btn(const Key('trade_replay_play'), 'Play the replay', const Icon(Icons.play_arrow_rounded), _play),
        btn(const Key('trade_replay_skip'), 'Skip ahead 10 seconds of playback', const Text('+10s', style: TextStyle(fontWeight: FontWeight.w800)), _skip10),
        btn(const Key('trade_replay_speed'), 'Playback speed ${_speed.toStringAsFixed(0)} times. Double tap to change.',
            Row(mainAxisSize: MainAxisSize.min, children: [const Icon(Icons.speed_rounded), const SizedBox(width: 4), Text('${_speed.toStringAsFixed(0)}×')]),
            () => setState(() => _speed = kCheReplaySpeeds[(kCheReplaySpeeds.indexOf(_speed) + 1) % kCheReplaySpeeds.length])),
      ]),
    ]);
  }

  Widget _facts(CheTradeEvidence e) {
    final rows = <(String, String)>[
      ('Trade ID', e.id),
      ('Evidence', e.executionLabel.isEmpty ? e.label : '${e.label} · ${e.executionLabel}'),
      ('Signal', '${_clock(e.signalTime)}${e.signalWhy.isEmpty ? '' : ' · ${e.signalWhy}'}'),
      ('Entry', '${_clock(e.entryTime)} at ${_price(e.entryPrice)}'),
      ('Stop', _price(e.stop)),
      ('Target', _price(e.target)),
      ('Exit', e.exitTime == null ? 'still open' : '${_clock(e.exitTime)} at ${_price(e.exitPrice)}${e.exitReason == null ? '' : ' · ${e.exitReason}'}'),
      ('Outcome', '${e.result ?? 'open'} · ${_r(e.r)} · ${_money(e.net)}'),
      ('Market data', e.barsSource ?? 'none recorded'),
      ('Brain evidence', e.brainRef ?? 'trade:${e.id}'),
    ];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final (k, v) in rows)
        Semantics(
          label: '$k: $v',
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 118, child: Text(k, style: const TextStyle(color: _dim, fontSize: 13.5))),
              Expanded(child: Text(v, style: const TextStyle(color: Colors.white, fontSize: 13.5))),
            ]),
          ),
        ),
    ]);
  }
}

class _ReplayPainter extends CustomPainter {
  _ReplayPainter(this.e, this.frame);
  final CheTradeEvidence e;
  final CheReplayFrame frame;

  @override
  void paint(Canvas canvas, Size size) {
    const pad = 10.0;
    // Price scale from every stored bar and level, so it does not jump while playing; time scale fixed too.
    final prices = <double>[for (final b in e.bars) ...[b.h, b.l], ...[e.stop, e.target, e.entryPrice, e.exitPrice].whereType<double>()];
    var lo = prices.reduce(math.min), hi = prices.reduce(math.max);
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    final n = e.bars.length;
    final w = (size.width - pad * 2) / math.max(1, n);
    double y(double p) => pad + (hi - p) / (hi - lo) * (size.height - pad * 2);
    double xAt(DateTime t) {
      final i = e.bars.indexWhere((b) => !b.t.isBefore(t));
      final idx = i < 0 ? n - 1 : i;
      return pad + w * idx + w / 2;
    }
    void level(double? p, Color c) {
      if (p == null) return;
      final paint = Paint()..color = c.withValues(alpha: 0.8)..strokeWidth = 1.2;
      for (var x = pad; x < size.width - pad; x += 8) {
        canvas.drawLine(Offset(x, y(p)), Offset(math.min(x + 4, size.width - pad), y(p)), paint);
      }
    }
    if (frame.entry) {
      level(e.entryPrice, _entryColor);
      level(e.stop, _stopColor);
      level(e.target, _targetColor);
    }
    for (var i = 0; i < frame.bars.length; i++) {
      final b = frame.bars[i];
      final idx = e.bars.indexOf(b);
      final x = pad + w * idx + w / 2;
      final up = b.c >= b.o;
      final p = Paint()..color = up ? const Color(0xFFE5E7EB) : const Color(0xFF6B7280);
      canvas.drawLine(Offset(x, y(b.h)), Offset(x, y(b.l)), p..strokeWidth = 1);
      final top = y(math.max(b.o, b.c)), bottom = y(math.min(b.o, b.c));
      canvas.drawRect(Rect.fromLTRB(x - w * 0.35, top, x + w * 0.35, math.max(bottom, top + 1)), p);
    }
    void dot(DateTime? t, double? p, Color c) {
      if (t == null || p == null) return;
      canvas.drawCircle(Offset(xAt(t), y(p)), 5, Paint()..color = c);
    }
    if (frame.entry) dot(e.entryTime, e.entryPrice, _entryColor);
    if (frame.exit) dot(e.exitTime, e.exitPrice, e.result == 'loss' ? _loss : _win);
  }

  @override
  bool shouldRepaint(_ReplayPainter old) => old.frame.bars.length != frame.bars.length || old.frame.entry != frame.entry || old.frame.exit != frame.exit;
}
