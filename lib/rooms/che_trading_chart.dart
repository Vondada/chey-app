// The Trading Room chart (owner, 2026-10-20, Build 1): one interactive chart for Alpaca PAPER
// stocks and CHE's MNQ futures paper research, read from the Worker's /api/trading/chart
// (server/cloudflare/trading_chart.js).
//
// - Symbol search, timeframes, pinch to zoom, drag to scroll, plus buttons for each of these so
//   VoiceOver and voice can do the same.
// - Markers by source, drawn differently and never merged: CHE forward paper, CHE strategy
//   simulation, Alpaca PAPER orders and Alpaca PAPER fills. Tapping one shows its receipt.
// - The owner's drawings (lines, levels, boxes, notes), saved on the Worker per account and symbol.
// - Feed health: provider, status, last bar and its age. New entries are blocked when the Worker
//   says the feed is stale or unavailable.
// - Tapping a price opens a PAPER order ticket. Preview shows cost, buying power after and any
//   limit that blocks it; only the explicit "Yes, place paper order" sends it. Open orders can be
//   cancelled, and every answer is the broker's record.
// The chart is silent on open; "Read chart" reads its summary only when asked.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import '../che_ui/che_hud.dart';
import '../che_ui/che_theme.dart';
import 'che_trading_hud.dart';

const _up = Color(0xFF3DDC97);
const _down = Color(0xFFFF5C7A);
const _gold = CheColors.markets;
final _dim = CheColors.textDim;
final _panel = CheColors.surface;
final _stroke = CheColors.stroke;
const _draw = Color(0xFF7FD3FF);

/// The four marker sources, in the order the legend shows them.
const kMarkerSources = <String, String>{
  'che_forward': 'CHE forward paper',
  'che_sim': 'CHE simulation',
  'alpaca_order': 'Alpaca order',
  'alpaca_fill': 'Alpaca fill',
  'che_signal': 'CHE signal (paper)',
};
const kMarkerColors = <String, Color>{
  'che_forward': _gold,
  'che_sim': Color(0xFFB794F6),
  'alpaca_order': Color(0xFF7FD3FF),
  'alpaca_fill': _up,
  'che_signal': Color(0xFFFFA94D),
};
const kChartAccounts = <String, String>{'alpaca_paper': 'Alpaca PAPER', 'futures_paper': 'MNQ PAPER'};
const kQuickSymbols = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA'];

DateTime? _time(Object? v) {
  if (v is num) return DateTime.fromMillisecondsSinceEpoch(v > 1e12 ? v.toInt() : (v * 1000).toInt(), isUtc: true);
  if (v is String && v.isNotEmpty) return DateTime.tryParse(v)?.toUtc();
  return null;
}

double? _num(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}');

class ChartBar {
  const ChartBar(this.t, this.o, this.h, this.l, this.c);
  final DateTime t;
  final double o, h, l, c;
}

class ChartMarker {
  ChartMarker(this.raw)
      : source = '${raw['source'] ?? ''}',
        kind = '${raw['kind'] ?? ''}',
        time = _time(raw['time']),
        price = _num(raw['price']);
  final Map<String, dynamic> raw;
  final String source, kind;
  final DateTime? time;
  final double? price;
  String get side => '${raw['side'] ?? ''}';
  String get strategy => '${raw['strategy'] ?? ''}';
  String get status => '${raw['status'] ?? ''}';
  bool get isBuy => side == 'buy' || side == 'long';
}

class ChartDrawing {
  ChartDrawing({required this.id, required this.kind, required this.points, this.text});
  final String id, kind;
  final List<(DateTime?, double)> points;
  final String? text;

  static ChartDrawing? fromJson(Object? j) {
    if (j is! Map) return null;
    final pts = [
      for (final p in (j['points'] is List ? j['points'] as List : const []))
        if (p is Map && _num(p['price']) != null) (_time(p['time']), _num(p['price'])!),
    ];
    if (pts.isEmpty) return null;
    return ChartDrawing(id: '${j['id'] ?? ''}', kind: '${j['kind'] ?? ''}', points: pts, text: j['text']?.toString());
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'kind': kind,
        'points': [
          for (final (t, p) in points) {'price': p, if (t != null) 'time': t.toIso8601String()},
        ],
        if (text != null) 'text': text,
      };

  String get spoken => switch (kind) {
        'hline' => 'level at ${_fmt(points.first.$2)}',
        'line' => 'line from ${_fmt(points.first.$2)} to ${_fmt(points.last.$2)}',
        'box' => 'box from ${_fmt(points.first.$2)} to ${_fmt(points.last.$2)}',
        _ => 'note "${text ?? ''}" at ${_fmt(points.first.$2)}',
      };
}

String _fmt(double v) => v >= 1000 ? v.toStringAsFixed(2).replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (m) => ',') : v.toStringAsFixed(2);
String _clock(DateTime t) {
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}';
}

/// Voice and other screens ask the chart for an account, symbol, strategy filter or a level here.
class CheTradingChartController extends ChangeNotifier {
  String? account, symbol, strategy;
  double? level;
  void show({String? account, String? symbol, String? strategy}) {
    this.account = account ?? this.account;
    this.symbol = symbol ?? this.symbol;
    this.strategy = strategy;
    notifyListeners();
  }

  void addLevel(double price) {
    level = price;
    notifyListeners();
  }
}

enum _Tool { none, line, hline, box, text }

class CheTradingChart extends StatefulWidget {
  const CheTradingChart({
    super.key,
    required this.baseUrl,
    required this.headers,
    this.client,
    this.onSpeak,
    this.controller,
    this.initialAccount = 'alpaca_paper',
    this.initialSymbol = '',
    this.initialStrategy,
    this.height = 340,
    this.signalMarkers,
  });

  /// CHE PAPER ACCOUNT signals from the setup desk on this phone (source 'che_signal'), drawn on
  /// the MNQ PAPER chart only.
  final ValueListenable<List<Map<String, dynamic>>>? signalMarkers;

  final String Function() baseUrl;
  final Map<String, String> Function() headers;
  final http.Client? client;

  /// Reads explicit requests and user-initiated action results. Passive loads stay silent.
  final void Function(String text)? onSpeak;
  final CheTradingChartController? controller;
  final String initialAccount, initialSymbol;

  /// "CHE, show EMA trades": only CHE's markers for this strategy (Alpaca markers stay).
  final String? initialStrategy;
  final double height;

  @override
  State<CheTradingChart> createState() => CheTradingChartState();
}

class CheTradingChartState extends State<CheTradingChart> {
  late final http.Client _http = widget.client ?? http.Client();
  late String _account = kChartAccounts.containsKey(widget.initialAccount) ? widget.initialAccount : 'alpaca_paper';
  late String _symbol = widget.initialSymbol.toUpperCase();
  String _tf = '5m';
  List<String> _timeframes = const ['1m', '5m', '15m', '1h', '1d'];
  List<ChartBar> _bars = const [];
  List<ChartMarker> _markers = const [];
  List<ChartDrawing> _drawings = [];
  List<Map<String, dynamic>> _openOrders = const [];
  Map<String, dynamic> _feed = const {};
  String _state = 'loading';
  String? _error;
  bool _entriesAllowed = false, _marketAllowed = false;
  String _blocked = '';
  final Set<String> _hidden = {};
  late String? _strategy = widget.initialStrategy;
  _Tool _tool = _Tool.none;
  (DateTime?, double)? _first;
  int _visible = 80; // bars on screen
  int _endOffset = 0; // bars hidden to the right of the window
  int _scaleStartVisible = 80;
  double _dragCarry = 0;
  int _seq = 0;
  Timer? _timer;
  final _symbolField = TextEditingController();
  String _status = '';

  @override
  void initState() {
    super.initState();
    _symbolField.text = _symbol;
    widget.controller?.addListener(_onController);
    widget.signalMarkers?.addListener(_onSignals);
    unawaited(load());
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => unawaited(load(quiet: true)));
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.controller?.removeListener(_onController);
    widget.signalMarkers?.removeListener(_onSignals);
    _symbolField.dispose();
    super.dispose();
  }

  void _onController() {
    final c = widget.controller!;
    if (c.level != null) {
      final price = c.level!;
      c.level = null;
      _addDrawing(ChartDrawing(id: 'hline-${DateTime.now().millisecondsSinceEpoch}', kind: 'hline', points: [(null, price)]));
      return;
    }
    setState(() {
      if (c.account != null && kChartAccounts.containsKey(c.account)) _account = c.account!;
      if (c.symbol != null && c.symbol!.isNotEmpty) _symbol = c.symbol!.toUpperCase();
      _strategy = c.strategy;
      _symbolField.text = _symbol;
    });
    unawaited(load());
  }

  String get accountLabel => kChartAccounts[_account] ?? _account;

  Future<void> load({bool quiet = false}) async {
    final seq = ++_seq;
    if (!quiet) setState(() => _state = 'loading');
    final q = {'account': _account, 'tf': _tf, if (_account == 'alpaca_paper' && _symbol.isNotEmpty) 'symbol': _symbol};
    try {
      final r = await _http
          .get(Uri.parse('${widget.baseUrl()}/api/trading/chart').replace(queryParameters: q), headers: widget.headers())
          .timeout(const Duration(seconds: 25));
      if (seq != _seq || !mounted) return; // a newer request (another symbol or timeframe) wins
      final j = jsonDecode(r.body);
      if (j is! Map<String, dynamic>) throw const FormatException('The chart answer was not readable.');
      if (r.statusCode != 200 || j['ok'] == false) throw Exception('${j['error'] ?? j['detail'] ?? 'The chart is unavailable.'}');
      setState(() => _apply(j));

    } catch (e) {
      if (seq != _seq || !mounted) return;
      setState(() {
        _state = 'error';
        _error = '$e'.replaceFirst('Exception: ', '');
        _feed = {..._feed, 'status': 'UNAVAILABLE', 'stale': true};
        _entriesAllowed = false;
        _marketAllowed = false;
        _blocked = 'Feed freshness could not be verified: $_error';
      });
    }
  }

  void _apply(Map<String, dynamic> j) {
    _state = '${j['state'] ?? 'verified'}';
    _error = j['error']?.toString();
    final sym = j['symbol']?.toString();
    if (sym != null && sym.isNotEmpty && _account == 'alpaca_paper' && _symbol.isEmpty) {
      _symbol = sym;
      _symbolField.text = sym;
    }
    if (_account == 'futures_paper') _symbol = sym ?? 'MNQ';
    _tf = '${j['timeframe'] ?? _tf}';
    _timeframes = [for (final t in (j['timeframes'] is List ? j['timeframes'] as List : _timeframes)) '$t'];
    _bars = [
      for (final b in (j['bars'] is List ? j['bars'] as List : const []))
        if (b is Map && _time(b['t']) != null && _num(b['o']) != null && _num(b['h']) != null && _num(b['l']) != null && _num(b['c']) != null)
          ChartBar(_time(b['t'])!, _num(b['o'])!, _num(b['h'])!, _num(b['l'])!, _num(b['c'])!),
    ];
    _markers = [
      for (final m in (j['markers'] is List ? j['markers'] as List : const []))
        if (m is Map<String, dynamic>) ChartMarker(m),
    ];
    _drawings = [for (final d in (j['drawings'] is List ? j['drawings'] as List : const [])) ?ChartDrawing.fromJson(d)];
    _openOrders = [for (final o in (j['open_orders'] is List ? j['open_orders'] as List : const [])) if (o is Map<String, dynamic>) o];
    _feed = j['feed'] is Map<String, dynamic> ? j['feed'] as Map<String, dynamic> : const {};
    _entriesAllowed = j['entries_allowed'] == true;
    _marketAllowed = j['market_orders_allowed'] == true;
    _blocked = '${j['entries_blocked_reason'] ?? ''}';
    _endOffset = _endOffset.clamp(0, math.max(0, _bars.length - 10));
  }

  // ─── The visible window ───────────────────────────────────────────────

  int get _count => math.min(_visible, _bars.length);
  int get _end => _bars.length - _endOffset;
  int get _start => math.max(0, _end - _count);
  List<ChartBar> get _window => _bars.isEmpty ? const [] : _bars.sublist(_start, _end);

  void zoom(double factor) => setState(() => _visible = (_visible / factor).round().clamp(15, math.max(15, _bars.length)));
  void scroll(int bars) => setState(() => _endOffset = (_endOffset + bars).clamp(0, math.max(0, _bars.length - 10)));

  void _onSignals() {
    if (mounted) setState(() {});
  }

  List<ChartMarker> get _allMarkers => [
        ..._markers,
        if (_account == 'futures_paper')
          for (final m in widget.signalMarkers?.value ?? const <Map<String, dynamic>>[]) ChartMarker(m),
      ];

  List<ChartMarker> get _shownMarkers => [
        for (final m in _allMarkers)
          if (!_hidden.contains(m.source) &&
              (_strategy == null || !m.source.startsWith('che_') || m.strategy.toLowerCase().contains(_strategy!.toLowerCase())))
            m,
      ];

  // ─── Drawings ─────────────────────────────────────────────────────────

  Future<void> _addDrawing(ChartDrawing d) async {
    setState(() => _drawings = [..._drawings, d]);
    await _saveDrawings('Saved the ${d.spoken}.');
  }

  Future<void> _saveDrawings(String done) async {
    if (_symbol.isEmpty) {
      setState(() => _status = 'Choose a symbol first; drawings are kept per symbol. Nothing was saved.');
      return;
    }
    try {
      final r = await _http
          .put(Uri.parse('${widget.baseUrl()}/api/trading/chart/drawings'),
              headers: {...widget.headers(), 'Content-Type': 'application/json'},
              body: jsonEncode({'account': _account, 'symbol': _symbol, 'drawings': [for (final d in _drawings) d.toJson()]}))
          .timeout(const Duration(seconds: 20));
      final j = jsonDecode(r.body);
      final ok = r.statusCode == 200 && j is Map && j['ok'] == true;
      if (ok) {
        _drawings = [for (final d in (j['drawings'] is List ? j['drawings'] as List : const [])) ?ChartDrawing.fromJson(d)];
      }
      _setStatus(ok ? done : 'The drawing was not saved: ${j is Map ? j['error'] ?? j['detail'] : r.statusCode}.', ok: ok);
    } catch (e) {
      _setStatus('The drawing was not saved: $e', ok: false);
    }
  }

  Future<void> _clearDrawings() async {
    if (_drawings.isEmpty) return;
    // Removing the owner's drawings is a delete: ask first.
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove every drawing?'),
        content: Text('This removes ${_drawings.length} drawing${_drawings.length == 1 ? '' : 's'} from $_symbol on $accountLabel.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep them')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Yes, remove them')),
        ],
      ),
    );
    if (yes != true) return;
    setState(() => _drawings = []);
    await _saveDrawings('Removed the drawings.');
  }

  void _setStatus(String text, {bool ok = true}) {
    if (!mounted) return;
    setState(() => _status = text);
    widget.onSpeak?.call(text);
    unawaited(HapticFeedback.mediumImpact());
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text, style: const TextStyle(fontSize: 16)), backgroundColor: ok ? const Color(0xFF14332A) : const Color(0xFF3A1720)));
  }

  // ─── Taps on the chart ────────────────────────────────────────────────

  _Geometry? _geometry(Size size) => _window.isEmpty ? null : _Geometry(_window, size);

  Future<void> _onTap(Offset at, Size size) async {
    final g = _geometry(size);
    if (g == null) return;
    final price = g.priceAt(at.dy);
    final time = g.timeAt(at.dx);
    if (_tool != _Tool.none) return _drawAt(time, price);
    // A marker near the tap shows its receipt.
    ChartMarker? best;
    var bestD = 22.0;
    for (final m in _shownMarkers) {
      final p = g.markerPoint(m);
      if (p == null) continue;
      final d = (p - at).distance;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (best != null) return _showMarker(best);
    await openTicket(price: double.parse(price.toStringAsFixed(2)));
  }

  Future<void> _drawAt(DateTime time, double price) async {
    final p = double.parse(price.toStringAsFixed(2));
    final id = '${_tool.name}-${DateTime.now().millisecondsSinceEpoch}';
    switch (_tool) {
      case _Tool.hline:
        setState(() => _tool = _Tool.none);
        await _addDrawing(ChartDrawing(id: id, kind: 'hline', points: [(null, p)]));
      case _Tool.text:
        final text = await _askNote();
        setState(() => _tool = _Tool.none);
        if (text == null || text.trim().isEmpty) return;
        await _addDrawing(ChartDrawing(id: id, kind: 'text', points: [(time, p)], text: text.trim()));
      case _Tool.line || _Tool.box:
        if (_first == null) {
          setState(() {
            _first = (time, p);
            _status = 'First point at ${_fmt(p)}. Tap the second point.';
          });
          return;
        }
        final kind = _tool == _Tool.line ? 'line' : 'box';
        final first = _first!;
        setState(() {
          _first = null;
          _tool = _Tool.none;
        });
        await _addDrawing(ChartDrawing(id: id, kind: kind, points: [first, (time, p)]));
      case _Tool.none:
        break;
    }
  }

  Future<String?> _askNote() {
    final c = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Note on the chart'),
        content: TextField(controller: c, autofocus: true, maxLength: 140, decoration: const InputDecoration(labelText: 'Note text')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Save note')),
        ],
      ),
    );
  }

  String _markerText(ChartMarker m) {
    final r = m.raw;
    final parts = <String>[
      '${kMarkerSources[m.source] ?? m.source} · ${m.kind}',
      if (m.side.isNotEmpty) 'Side: ${m.side}',
      if (r['qty'] != null) 'Quantity: ${r['qty']}',
      if (m.price != null) 'Price: ${_fmt(m.price!)}',
      if (m.time != null) 'Time: ${_clock(m.time!)}',
      if (m.status.isNotEmpty) 'Status: ${m.status}',
      if (m.strategy.isNotEmpty) 'Strategy: ${m.strategy}${r['variant'] != null ? ' (${r['variant']})' : ''}',
      if (r['stop'] != null) 'Stop: ${r['stop']}',
      if (r['target'] != null) 'Target: ${r['target']}',
      if (r['reason'] != null) 'Exit reason: ${r['reason']}',
      if (r['net_pnl'] != null) 'Net P&L: \$${r['net_pnl']}',
      if (r['r'] != null) 'R: ${r['r']}',
      if (r['order_id'] != null) 'Alpaca order id: ${r['order_id']}',
      if (r['account'] != null) 'Account: ${r['account']}',
      if (r['timeframe'] != null) 'Timeframe: ${r['timeframe']}',
      if (r['data_source'] != null) 'Data: ${r['data_source']}',
      if (r['evidence'] != null) 'Evidence: ${r['evidence']}',
    ];
    return parts.join('\n');
  }

  Future<void> _showMarker(ChartMarker m) => showModalBottomSheet<void>(
        context: context,
        backgroundColor: _panel,
        builder: (ctx) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Receipt', style: TextStyle(color: kMarkerColors[m.source] ?? Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 8),
              Text(_markerText(m), style: const TextStyle(color: Colors.white, fontSize: 17, height: 1.4)),
              const SizedBox(height: 12),
              Row(children: [
                if (widget.onSpeak != null)
                  TextButton.icon(onPressed: () => widget.onSpeak!(_markerText(m).replaceAll('\n', '. ')), icon: const Icon(Icons.volume_up_rounded), label: const Text('Read receipt')),
                const Spacer(),
                if (m.source == 'alpaca_order' && !['filled', 'canceled', 'cancelled', 'expired', 'rejected'].contains(m.status))
                  FilledButton(
                    onPressed: () {
                      Navigator.pop(ctx);
                      unawaited(cancelOrder('${m.raw['order_id'] ?? m.raw['id']}', what: '${m.side.toUpperCase()} ${m.raw['qty'] ?? ''} ${m.raw['symbol'] ?? ''}'));
                    },
                    child: const Text('Cancel this order'),
                  ),
              ]),
            ]),
          ),
        ),
      );

  // ─── Orders ───────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final r = await _http
        .post(Uri.parse('${widget.baseUrl()}$path'), headers: {...widget.headers(), 'Content-Type': 'application/json'}, body: jsonEncode(body))
        .timeout(const Duration(seconds: 25));
    final j = jsonDecode(r.body);
    if (j is! Map<String, dynamic>) throw const FormatException('The answer was not readable.');
    return {...j, '_status': r.statusCode};
  }

  /// The PAPER ticket for a price on the chart. Nothing is sent until the owner presses "Yes".
  Future<void> openTicket({double? price, String side = 'buy', int qty = 1}) async {
    if (_account != 'alpaca_paper') {
      _setStatus(_blocked.isNotEmpty ? _blocked : 'No futures paper broker is connected, so CHE takes no manual futures orders. Nothing was sent.', ok: false);
      return;
    }
    if (_symbol.isEmpty) {
      _setStatus('Choose a stock symbol first. Nothing was sent.', ok: false);
      return;
    }
    if (!_entriesAllowed) {
      _setStatus('New entries are blocked: ${_blocked.isEmpty ? 'the feed is unavailable' : _blocked} Nothing was sent.', ok: false);
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: _panel,
      builder: (ctx) => _OrderTicket(
        symbol: _symbol,
        price: price ?? (_bars.isEmpty ? null : _bars.last.c),
        side: side,
        qty: qty,
        marketAllowed: _marketAllowed,
        blockedReason: _blocked,
        preview: (order) => _post('/api/trading/alpaca/order/preview', order),
        place: (order) => _post('/api/trading/alpaca/order', order),
        onDone: (text, ok) {
          _setStatus(text, ok: ok);
          unawaited(load(quiet: true));
        },
      ),
    );
  }

  /// Cancelling removes an order, so the owner is asked first; only "Yes, cancel it" sends it.
  Future<void> cancelOrder(String id, {String what = 'this paper order'}) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel this order?'),
        content: Text('Cancel $what on Alpaca PAPER?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Yes, cancel it')),
        ],
      ),
    );
    if (yes != true) {
      _setStatus('Kept the order; nothing was cancelled.');
      return;
    }
    try {
      final j = await _post('/api/trading/alpaca/order/cancel', {'id': id, 'confirm': true});
      final receipt = j['receipt'] is Map ? j['receipt'] as Map : const {};
      final ok = j['ok'] == true;
      _setStatus(ok
          ? 'Alpaca reports the order ${receipt['status'] ?? 'cancel requested'}.'
          : 'Not cancelled: ${j['detail'] ?? 'Alpaca refused'}.', ok: ok);
    } catch (e) {
      _setStatus('Not cancelled: $e', ok: false);
    }
    unawaited(load(quiet: true));
  }

  // ─── Summary for "Read chart" and VoiceOver ───────────────────────────

  String get summary {
    if (_state == 'loading' && _bars.isEmpty) return '$accountLabel chart is loading.';
    if (_bars.isEmpty) return '$accountLabel ${_symbol.isEmpty ? '' : '$_symbol '}chart has no bars. ${_error ?? _blocked}'.trim();
    final last = _bars.last;
    final counts = <String, int>{};
    for (final m in _shownMarkers) {
      counts[m.source] = (counts[m.source] ?? 0) + 1;
    }
    final marks = counts.isEmpty ? 'No markers.' : 'Markers: ${counts.entries.map((e) => '${e.value} ${kMarkerSources[e.key] ?? e.key}').join(', ')}.';
    final feed = '${_feed['provider'] ?? 'Feed'} is ${_feed['status'] ?? 'unknown'}${_feed['age_s'] is num ? ', last bar ${_age(_feed['age_s'] as num)} old' : ''}.';
    return '$accountLabel, $_symbol, $_tf candles. Last close ${_fmt(last.c)} at ${_clock(last.t)}. $marks $feed '
        '${_drawings.isEmpty ? '' : '${_drawings.length} drawing${_drawings.length == 1 ? '' : 's'}: ${_drawings.map((d) => d.spoken).join('; ')}. '}'
        '${_entriesAllowed ? (_marketAllowed ? 'Paper entries allowed.' : 'Limit orders only: $_blocked') : 'New entries blocked: $_blocked'}';
  }

  String _age(num s) => s < 120 ? '${s.round()} seconds' : s < 7200 ? '${(s / 60).round()} minutes' : s < 172800 ? '${(s / 3600).round()} hours' : '${(s / 86400).round()} days';

  // ─── UI ───────────────────────────────────────────────────────────────

  Widget _chip(String label, bool selected, VoidCallback onTap, {String? semantics}) => Semantics(
        button: true,
        selected: selected,
        label: semantics ?? label,
        excludeSemantics: true,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(18),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: selected ? cheTradingSelect.withValues(alpha: 0.22) : Colors.transparent,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: selected ? cheTradingSelect : (cheHudActive ? CheHud.ice.withValues(alpha: 0.28) : _stroke)),
            ),
            child: Text(label, style: TextStyle(color: selected ? cheTradingSelect : Colors.white, fontWeight: FontWeight.w700, fontSize: 14)),
          ),
        ),
      );

  Widget _iconButton(IconData icon, String label, VoidCallback? onTap) => IconButton(
        tooltip: label,
        onPressed: onTap,
        icon: Icon(icon, color: onTap == null ? _dim : Colors.white),
      );

  void _setAccount(String a) {
    if (a == _account) return;
    setState(() {
      _account = a;
      _symbol = a == 'futures_paper' ? 'MNQ' : (_symbolField.text.trim().toUpperCase());
      _bars = const [];
      _markers = const [];
      _endOffset = 0;
    });
    unawaited(load());
  }

  void _setSymbol(String s) {
    final sym = s.trim().toUpperCase();
    if (!RegExp(r'^[A-Z]{1,5}(\.[A-Z])?$').hasMatch(sym)) {
      _setStatus('Type a stock symbol such as AAPL.', ok: false);
      return;
    }
    setState(() {
      _symbol = sym;
      _symbolField.text = sym;
      _bars = const [];
      _endOffset = 0;
    });
    unawaited(load());
  }

  @override
  Widget build(BuildContext context) {
    final stale = _feed['stale'] == true;
    final feedColor = _feed['status'] == 'REALTIME' && !stale ? _up : _feed['status'] == 'UNAVAILABLE' ? _down : _gold;
    return CheTradingPanel(
      color: _panel,
      borderColor: _stroke,
      radius: 16,
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          // The title and PAPER badge wrap on a narrow screen or with large text instead of pushing the buttons off.
          Expanded(
            child: Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text('CHART', style: cheTradingLabel(const TextStyle(color: _gold, fontWeight: FontWeight.w800, letterSpacing: 1.4, fontSize: 13))),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: _gold, borderRadius: BorderRadius.circular(6)),
                child: const Text('PAPER', style: TextStyle(color: Colors.black, fontWeight: FontWeight.w900, fontSize: 12)),
              ),
            ]),
          ),
          if (widget.onSpeak != null) _iconButton(Icons.volume_up_rounded, 'Read chart aloud', () => widget.onSpeak!(summary)),
          _iconButton(Icons.refresh_rounded, 'Refresh chart', () => unawaited(load())),
        ]),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final e in kChartAccounts.entries) _chip(e.value, _account == e.key, () => _setAccount(e.key), semantics: 'Show the ${e.value} chart'),
        ]),
        if (_account == 'alpaca_paper') ...[
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _symbolField,
                textCapitalization: TextCapitalization.characters,
                style: const TextStyle(color: Colors.white, fontSize: 16),
                decoration: const InputDecoration(isDense: true, labelText: 'Symbol search', hintText: 'AAPL', prefixIcon: Icon(Icons.search_rounded)),
                onSubmitted: _setSymbol,
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(onPressed: () => _setSymbol(_symbolField.text), child: const Text('Show')),
          ]),
          const SizedBox(height: 6),
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final s in kQuickSymbols) _chip(s, _symbol == s, () => _setSymbol(s), semantics: 'Chart $s'),
          ]),
        ],
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final t in _timeframes)
            _chip(t, _tf == t, () {
              setState(() => _tf = t);
              unawaited(load());
            }, semantics: 'Timeframe $t'),
        ]),
        const SizedBox(height: 8),
        // Feed health: always visible, never spoken unless asked.
        Semantics(
          liveRegion: false,
          child: Text(
            [
              '${_feed['provider'] ?? 'Feed'}: ${_feed['status'] ?? (_state == 'loading' ? 'checking' : 'UNAVAILABLE')}${stale ? ' · STALE' : ''}',
              if (_feed['last_bar_time'] != null && _time(_feed['last_bar_time']) != null) 'last bar ${_clock(_time(_feed['last_bar_time'])!)}',
              if (_feed['age_s'] is num) '${_age(_feed['age_s'] as num)} old',
            ].join(' · '),
            style: TextStyle(color: feedColor, fontSize: 13, fontWeight: FontWeight.w700),
          ),
        ),
        if (_blocked.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(_entriesAllowed ? 'Limit orders only: $_blocked' : 'New entries blocked: $_blocked', style: const TextStyle(color: _gold, fontSize: 13)),
          ),
        const SizedBox(height: 8),
        SizedBox(height: widget.height, child: _chartArea()),
        const SizedBox(height: 6),
        Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
          _iconButton(Icons.zoom_in_rounded, 'Zoom in', _bars.isEmpty ? null : () => zoom(1.5)),
          _iconButton(Icons.zoom_out_rounded, 'Zoom out', _bars.isEmpty ? null : () => zoom(1 / 1.5)),
          _iconButton(Icons.chevron_left_rounded, 'Scroll to earlier bars', _bars.isEmpty ? null : () => scroll(math.max(5, _count ~/ 3))),
          _iconButton(Icons.chevron_right_rounded, 'Scroll to later bars', _endOffset == 0 ? null : () => scroll(-math.max(5, _count ~/ 3))),
          _iconButton(Icons.last_page_rounded, 'Jump to the latest bar', _endOffset == 0 ? null : () => setState(() => _endOffset = 0)),
          if (_account == 'alpaca_paper')
            FilledButton.icon(
              onPressed: () => unawaited(openTicket()),
              icon: const Icon(Icons.receipt_long_rounded, size: 18),
              label: const Text('Order ticket'),
            ),
        ]),
        // Drawing tools
        Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('Draw:', style: TextStyle(color: _dim, fontSize: 13)),
          _chip('Line', _tool == _Tool.line, () => _pickTool(_Tool.line), semantics: 'Draw a line: tap two points on the chart'),
          _chip('Level', _tool == _Tool.hline, () => _pickTool(_Tool.hline), semantics: 'Draw a horizontal level: tap a price'),
          _chip('Box', _tool == _Tool.box, () => _pickTool(_Tool.box), semantics: 'Draw a box: tap two corners'),
          _chip('Note', _tool == _Tool.text, () => _pickTool(_Tool.text), semantics: 'Add a text note: tap where it goes'),
          if (_drawings.isNotEmpty) _chip('Clear', false, () => unawaited(_clearDrawings()), semantics: 'Remove every drawing on this chart'),
        ]),
        const SizedBox(height: 8),
        // Legend: one toggle per source, with how many markers it has.
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final e in kMarkerSources.entries)
            _legend(e.key, e.value, _allMarkers.where((m) => m.source == e.key).length),
        ]),
        if (_strategy != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Row(children: [
              Expanded(child: Text('Showing CHE trades for ${_strategy!.toUpperCase()} only', style: const TextStyle(color: _gold, fontSize: 13))),
              TextButton(onPressed: () => setState(() => _strategy = null), child: const Text('Show all strategies')),
            ]),
          ),
        if (_openOrders.isNotEmpty) ...[
          const SizedBox(height: 10),
          const Text('OPEN PAPER ORDERS', style: TextStyle(color: _gold, fontWeight: FontWeight.w800, letterSpacing: 1.2, fontSize: 12)),
          for (final o in _openOrders)
            Row(children: [
              Expanded(
                child: Text(
                  '${'${o['side'] ?? ''}'.toUpperCase()} ${o['qty'] ?? ''} ${o['symbol'] ?? ''} · ${o['type'] ?? ''}${o['limit_price'] != null ? ' @ ${o['limit_price']}' : ''} · ${o['status'] ?? ''}',
                  style: const TextStyle(color: Colors.white, fontSize: 14),
                ),
              ),
              TextButton(onPressed: () => unawaited(cancelOrder('${o['id']}', what: '${'${o['side'] ?? ''}'.toUpperCase()} ${o['qty'] ?? ''} ${o['symbol'] ?? ''}')), child: Text('Cancel', semanticsLabel: 'Cancel the ${o['side']} ${o['qty']} ${o['symbol']} order')),
            ]),
        ],
        if (_status.isNotEmpty)
          Padding(padding: const EdgeInsets.only(top: 8), child: Text(_status, style: const TextStyle(color: Colors.white70, fontSize: 14))),
      ]),
    );
  }

  void _pickTool(_Tool t) => setState(() {
        _tool = _tool == t ? _Tool.none : t;
        _first = null;
        _status = _tool == _Tool.none ? '' : 'Tap the chart to place it.';
      });

  Widget _legend(String source, String label, int n) {
    final on = !_hidden.contains(source);
    final color = kMarkerColors[source]!;
    return Semantics(
      button: true,
      toggled: on,
      label: '$label markers, $n, ${on ? 'shown' : 'hidden'}',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => setState(() => on ? _hidden.add(source) : _hidden.remove(source)),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), border: Border.all(color: on ? color : _stroke)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            CustomPaint(size: const Size(12, 12), painter: _MarkerGlyph(source, color, on)),
            const SizedBox(width: 6),
            // Wraps instead of overflowing on a 320-point screen or with large text.
            Flexible(child: Text('$label $n', style: TextStyle(color: on ? Colors.white : _dim, fontSize: 13))),
          ]),
        ),
      ),
    );
  }

  Widget _chartArea() {
    if (_bars.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            _state == 'loading'
                ? 'Loading the $accountLabel chart…'
                : _state == 'not_configured'
                    ? 'Alpaca PAPER is not connected. Add the paper keys in Account.'
                    : (_error ?? (_blocked.isNotEmpty ? _blocked : 'No bars to show yet.')),
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white70, fontSize: 15),
          ),
        ),
      );
    }
    return LayoutBuilder(builder: (context, box) {
      final size = Size(box.maxWidth, box.maxHeight);
      return Semantics(
        label: summary,
        hint: 'Pinch to zoom, drag to scroll, tap a price for an order ticket, tap a marker for its receipt.',
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapUp: (d) => unawaited(_onTap(d.localPosition, size)),
          onScaleStart: (_) {
            _scaleStartVisible = _visible;
            _dragCarry = 0;
          },
          onScaleUpdate: (d) {
            if (d.pointerCount > 1) {
              setState(() => _visible = (_scaleStartVisible / d.horizontalScale).round().clamp(15, math.max(15, _bars.length)));
              return;
            }
            final perBar = size.width / math.max(1, _count);
            _dragCarry += d.focalPointDelta.dx;
            final moved = (_dragCarry / perBar).truncate();
            if (moved != 0) {
              _dragCarry -= moved * perBar;
              scroll(moved);
            }
          },
          child: CustomPaint(
            size: size,
            painter: _ChartPainter(
              bars: _window,
              markers: _shownMarkers,
              drawings: _drawings,
              pending: _first,
            ),
          ),
        ),
      );
    });
  }
}

/// Maps bars to pixels: x by bar index, y by the visible price range.
class _Geometry {
  _Geometry(this.bars, this.size) {
    var lo = double.infinity, hi = -double.infinity;
    for (final b in bars) {
      lo = math.min(lo, b.l);
      hi = math.max(hi, b.h);
    }
    final pad = math.max((hi - lo) * 0.08, hi.abs() * 0.0005);
    min = lo - pad;
    max = hi + pad;
  }
  final List<ChartBar> bars;
  final Size size;
  static const axis = 58.0;
  late final double min, max;
  double get plotW => size.width - axis;
  double get barW => plotW / bars.length;
  double y(double price) => (max - price) / (max - min) * size.height;
  double priceAt(double dy) => max - dy / size.height * (max - min);
  double x(int i) => (i + 0.5) * barW;
  DateTime timeAt(double dx) => bars[(dx / barW).floor().clamp(0, bars.length - 1)].t;

  /// The bar a time falls in (the last bar that started at or before it); null when outside.
  double? xOfTime(DateTime? t) {
    if (t == null || bars.isEmpty || t.isBefore(bars.first.t)) return null;
    var lo = 0, hi = bars.length - 1;
    while (lo < hi) {
      final mid = (lo + hi + 1) >> 1;
      if (!bars[mid].t.isAfter(t)) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    if (lo == bars.length - 1 && bars.length > 1) {
      final step = bars.last.t.difference(bars[bars.length - 2].t);
      if (t.isAfter(bars.last.t.add(step * 2))) return null;
    }
    return x(lo);
  }

  Offset? markerPoint(ChartMarker m) {
    final px = xOfTime(m.time);
    if (px == null || m.price == null) return null;
    return Offset(px, y(m.price!));
  }
}

class _ChartPainter extends CustomPainter {
  _ChartPainter({required this.bars, required this.markers, required this.drawings, required this.pending});
  final List<ChartBar> bars;
  final List<ChartMarker> markers;
  final List<ChartDrawing> drawings;
  final (DateTime?, double)? pending;

  @override
  void paint(Canvas canvas, Size size) {
    if (bars.isEmpty) return;
    final g = _Geometry(bars, size);
    final grid = Paint()..color = _stroke;
    final label = TextStyle(color: _dim, fontSize: 11, fontFeatures: const [FontFeature.tabularFigures()]);
    for (var i = 0; i <= 4; i++) {
      final p = g.min + (g.max - g.min) * i / 4;
      final y = g.y(p);
      canvas.drawLine(Offset(0, y), Offset(g.plotW, y), grid);
      _text(canvas, _fmt(p), Offset(g.plotW + 4, y - 7), label);
    }
    final w = math.max(1.0, g.barW * 0.7);
    for (var i = 0; i < bars.length; i++) {
      final b = bars[i];
      final color = b.c >= b.o ? _up : _down;
      final x = g.x(i);
      canvas.drawLine(Offset(x, g.y(b.h)), Offset(x, g.y(b.l)), Paint()..color = color..strokeWidth = 1);
      final top = g.y(math.max(b.o, b.c)), bottom = g.y(math.min(b.o, b.c));
      canvas.drawRect(Rect.fromLTRB(x - w / 2, top, x + w / 2, math.max(bottom, top + 1)), Paint()..color = color);
    }
    // Last price line.
    final last = bars.last.c;
    final ly = g.y(last);
    canvas.drawLine(Offset(0, ly), Offset(g.plotW, ly), Paint()..color = Colors.white24..strokeWidth = 1);
    canvas.drawRect(Rect.fromLTWH(g.plotW, ly - 9, _Geometry.axis, 18), Paint()..color = Colors.white);
    _text(canvas, _fmt(last), Offset(g.plotW + 4, ly - 7), const TextStyle(color: Colors.black, fontSize: 11, fontWeight: FontWeight.w700));

    // The owner's drawings.
    final ink = Paint()
      ..color = _draw
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    for (final d in drawings) {
      // A time outside the window is not the latest candle. Hide drawings until their points are visible.
      if (d.points.any((point) => point.$1 != null && g.xOfTime(point.$1) == null)) continue;
      final pts = [for (final (t, p) in d.points) Offset(g.xOfTime(t) ?? 0, g.y(p))];
      switch (d.kind) {
        case 'hline':
          canvas.drawLine(Offset(0, pts.first.dy), Offset(g.plotW, pts.first.dy), ink);
          _text(canvas, _fmt(d.points.first.$2), Offset(4, pts.first.dy - 16), const TextStyle(color: _draw, fontSize: 11, fontWeight: FontWeight.w700));
        case 'line':
          if (pts.length == 2) canvas.drawLine(pts[0], pts[1], ink);
        case 'box':
          if (pts.length == 2) {
            final r = Rect.fromPoints(pts[0], pts[1]);
            canvas.drawRect(r, Paint()..color = _draw.withValues(alpha: 0.12));
            canvas.drawRect(r, ink);
          }
        case 'text':
          _text(canvas, d.text ?? '', pts.first + const Offset(4, -16), const TextStyle(color: _draw, fontSize: 13, fontWeight: FontWeight.w700));
          canvas.drawCircle(pts.first, 3, Paint()..color = _draw);
      }
    }
    if (pending != null) {
      final px = g.xOfTime(pending!.$1);
      if (px != null) canvas.drawCircle(Offset(px, g.y(pending!.$2)), 5, ink);
    }

    // Markers by source.
    for (final m in markers) {
      final p = g.markerPoint(m);
      if (p == null) continue;
      final color = kMarkerColors[m.source] ?? Colors.white;
      if (m.source == 'alpaca_order') {
        // A working order is a dashed line at its price, with its side.
        final dash = Paint()
          ..color = color
          ..strokeWidth = 1.2;
        for (var x = p.dx; x < g.plotW; x += 8) {
          canvas.drawLine(Offset(x, p.dy), Offset(math.min(x + 4, g.plotW), p.dy), dash);
        }
      }
      canvas.save();
      canvas.translate(p.dx, p.dy);
      _MarkerGlyph.paintGlyph(canvas, m.source, color, true, buy: m.isBuy, exit: m.kind == 'exit', size: 12);
      canvas.restore();
    }
  }

  void _text(Canvas canvas, String s, Offset at, TextStyle style) {
    final tp = TextPainter(text: TextSpan(text: s, style: style), textDirection: TextDirection.ltr)..layout(maxWidth: 160);
    tp.paint(canvas, at);
  }

  @override
  bool shouldRepaint(covariant _ChartPainter old) =>
      old.bars != bars || old.markers != markers || old.drawings != drawings || old.pending != pending;
}

/// One glyph per source so they never look alike: CHE forward a triangle, CHE simulation a hollow
/// circle, an Alpaca order a hollow square, an Alpaca fill a solid diamond.
class _MarkerGlyph extends CustomPainter {
  _MarkerGlyph(this.source, this.color, this.on);
  final String source;
  final Color color;
  final bool on;

  static void paintGlyph(Canvas canvas, String source, Color color, bool on, {bool buy = true, bool exit = false, double size = 12}) {
    final c = on ? color : _dim;
    final h = size / 2;
    final fill = Paint()..color = c;
    final line = Paint()
      ..color = c
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    switch (source) {
      case 'che_forward':
        final path = buy != exit
            ? (Path()..moveTo(0, -h)..lineTo(h, h)..lineTo(-h, h)..close())
            : (Path()..moveTo(0, h)..lineTo(h, -h)..lineTo(-h, -h)..close());
        canvas.drawPath(path, exit ? line : fill);
      case 'che_sim':
        canvas.drawCircle(Offset.zero, h * 0.85, line);
      case 'alpaca_order':
        canvas.drawRect(Rect.fromCenter(center: Offset.zero, width: size * 0.8, height: size * 0.8), line);
      case 'che_signal':
        // A crosshair in a ring: a planned paper entry, not a fill.
        canvas.drawCircle(Offset.zero, h * 0.9, line);
        canvas.drawLine(Offset(-h, 0), Offset(h, 0), line);
        canvas.drawLine(Offset(0, -h), Offset(0, h), line);
      default:
        canvas.drawPath(Path()..moveTo(0, -h)..lineTo(h, 0)..lineTo(0, h)..lineTo(-h, 0)..close(), fill);
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.translate(size.width / 2, size.height / 2);
    paintGlyph(canvas, source, color, on, size: size.width);
  }

  @override
  bool shouldRepaint(covariant _MarkerGlyph old) => old.on != on;
}

/// The PAPER order ticket: buy or sell, market or limit, quantity, then a preview from the Worker
/// (cost, buying power after, risk limits). Only "Yes, place paper order" sends it.
class _OrderTicket extends StatefulWidget {
  const _OrderTicket({
    required this.symbol,
    required this.price,
    required this.side,
    required this.qty,
    required this.marketAllowed,
    required this.blockedReason,
    required this.preview,
    required this.place,
    required this.onDone,
  });
  final String symbol;
  final double? price;
  final String side;
  final int qty;
  final bool marketAllowed;
  final String blockedReason;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic>) preview, place;
  final void Function(String text, bool ok) onDone;

  @override
  State<_OrderTicket> createState() => _OrderTicketState();
}

class _OrderTicketState extends State<_OrderTicket> {
  late String _side = widget.side;
  // A price tapped on the chart is a limit price; market is one tap away when the feed allows it.
  String _type = 'limit';
  late int _qty = widget.qty;
  late final _limit = TextEditingController(text: widget.price?.toStringAsFixed(2) ?? '');
  Map<String, dynamic>? _preview;
  String? _error;
  bool _busy = false;
  // One request id per ticket, so a repeated press can never send it twice.
  final _clientId = 'che-${DateTime.now().microsecondsSinceEpoch}';

  Map<String, dynamic> get _order => {
        'symbol': widget.symbol,
        'qty': _qty,
        'side': _side,
        'type': _type,
        if (_type == 'limit') 'limit_price': double.tryParse(_limit.text.replaceAll(',', '')),
      };

  void _changed() => setState(() {
        _preview = null;
        _error = null;
      });

  Future<void> _doPreview() async {
    setState(() => _busy = true);
    try {
      final p = await widget.preview(_order);
      if (!mounted) return;
      setState(() {
        if (p['ok'] == true) {
          _preview = p;
          _error = null;
        } else {
          _error = '${p['detail'] ?? 'The preview failed.'}';
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'The preview failed: $e');
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _doPlace() async {
    setState(() => _busy = true);
    try {
      final r = await widget.place({..._order, 'client_order_id': _clientId});
      final receipt = r['receipt'] is Map ? r['receipt'] as Map : const {};
      final ok = r['ok'] == true;
      final text = ok
          ? 'Alpaca PAPER ${r['repeated'] == true ? 'already has' : 'accepted'} ${_side.toUpperCase()} $_qty ${widget.symbol}${_type == 'limit' ? ' limit ${_limit.text}' : ' at market'}. Status: ${receipt['status'] ?? 'not reported'}. Order ${receipt['id'] ?? ''}.'
          : 'Nothing was sent: ${r['detail'] ?? 'Alpaca refused it'}.';
      if (mounted) Navigator.of(context).pop();
      widget.onDone(text, ok);
    } catch (e) {
      if (mounted) setState(() => _error = 'Nothing was confirmed: $e');
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final p = _preview;
    final blocked = '${p?['blocked'] ?? ''}';
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text('${widget.symbol} order ticket', style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: _gold, borderRadius: BorderRadius.circular(6)),
                child: const Text('PAPER · no real money', style: TextStyle(color: Colors.black, fontWeight: FontWeight.w900, fontSize: 12)),
              ),
            ]),
            const SizedBox(height: 12),
            SegmentedButton<String>(
              segments: const [ButtonSegment(value: 'buy', label: Text('Buy')), ButtonSegment(value: 'sell', label: Text('Sell'))],
              selected: {_side},
              onSelectionChanged: (s) => setState(() {
                _side = s.first;
                _changed();
              }),
            ),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: [
                ButtonSegment(value: 'market', label: const Text('Market'), enabled: widget.marketAllowed),
                const ButtonSegment(value: 'limit', label: Text('Limit')),
              ],
              selected: {_type},
              onSelectionChanged: (s) => setState(() {
                _type = s.first;
                _changed();
              }),
            ),
            if (!widget.marketAllowed && widget.blockedReason.isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 4), child: Text(widget.blockedReason, style: const TextStyle(color: _gold, fontSize: 13))),
            const SizedBox(height: 8),
            Row(children: [
              const Text('Shares', style: TextStyle(color: Colors.white, fontSize: 16)),
              const Spacer(),
              IconButton(tooltip: 'Fewer shares', onPressed: _qty > 1 ? () => setState(() { _qty--; _changed(); }) : null, icon: const Icon(Icons.remove_circle_outline, color: Colors.white)),
              Semantics(label: '$_qty shares', excludeSemantics: true, child: Text('$_qty', style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w800))),
              IconButton(tooltip: 'More shares', onPressed: _qty < 1000 ? () => setState(() { _qty++; _changed(); }) : null, icon: const Icon(Icons.add_circle_outline, color: Colors.white)),
            ]),
            if (_type == 'limit')
              TextField(
                controller: _limit,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                style: const TextStyle(color: Colors.white, fontSize: 16),
                decoration: const InputDecoration(labelText: 'Limit price'),
                onChanged: (_) => _changed(),
              ),
            const SizedBox(height: 12),
            if (p != null) ...[
              Text(
                [
                  'Estimated ${_side == 'buy' ? 'cost' : 'proceeds'}: ${p['estimated_cost'] == null ? 'unknown (no latest trade)' : '\$${_fmt(_num(p['estimated_cost'])!)}'}',
                  'Buying power: ${p['buying_power'] == null ? 'not reported' : '\$${_fmt(_num(p['buying_power'])!)}'}',
                  if (_side == 'buy' && p['buying_power_after'] != null) 'Buying power after: \$${_fmt(_num(p['buying_power_after'])!)}',
                  if (p['last_trade'] != null) 'Last trade: \$${_fmt(_num(p['last_trade'])!)}${_time(p['last_trade_time']) != null ? ' at ${_clock(_time(p['last_trade_time'])!)}' : ''}',
                  'Risk: paper account, no real money.',
                ].join('\n'),
                style: const TextStyle(color: Colors.white, fontSize: 16, height: 1.4),
              ),
              if (blocked.isNotEmpty)
                Padding(padding: const EdgeInsets.only(top: 6), child: Text('Blocked by your limits: $blocked', style: const TextStyle(color: _down, fontSize: 15, fontWeight: FontWeight.w700))),
              const SizedBox(height: 12),
            ],
            if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: const TextStyle(color: _down, fontSize: 15))),
            if (p == null)
              FilledButton(onPressed: _busy ? null : () => unawaited(_doPreview()), child: Text(_busy ? 'Checking…' : 'Preview order'))
            else
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: _side == 'buy' ? _up : _down, foregroundColor: Colors.black, minimumSize: const Size.fromHeight(52)),
                onPressed: _busy || blocked.isNotEmpty ? null : () => unawaited(_doPlace()),
                child: Text('Yes, place paper order: ${_side.toUpperCase()} $_qty ${widget.symbol}${_type == 'limit' ? ' @ ${_limit.text}' : ''}',
                    style: const TextStyle(fontWeight: FontWeight.w800)),
              ),
            TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('No, cancel. Nothing is sent.')),
          ]),
        ),
      ),
    );
  }
}
